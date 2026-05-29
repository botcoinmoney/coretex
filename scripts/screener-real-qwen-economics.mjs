#!/usr/bin/env node
/**
 * screener-real-qwen-economics.mjs — REAL-Qwen production-flow screener-economics harness.
 *
 * Boots an authentic CoreTex coordinator backed by the SAME production scoring path the
 * launch coordinator will run (Qwen3-Reranker-0.6B via the canonical persistent streaming
 * runner + evaluateRetrievalBenchmarkPatch) over the SAME launch profile / bundle / corpus
 * the registry pins. A zero-context Sonnet miner subagent (spawned separately) drives the
 * coord via the public /coretex/* surface using ONLY the canonical miner skill — exactly
 * what a real miner will see at launch.
 *
 * Per docs/HANDOFFS/REAL_QWEN_SCREENER_ECONOMICS_HANDOFF.md, this harness REFUSES to fall
 * back to a deterministic-proxy scorer for any launch-economics conclusion. The CPU
 * screener-economics-calibration.mjs is arithmetic sanity only and is NOT this script.
 *
 * Stop conditions (the script refuses to start):
 *   - no real Qwen3-Reranker-0.6B available (no streaming runner / no model cache)
 *   - V4 cap not readable from chain AND --offline-smoke not explicitly passed
 *   - mining wallet not loadable from coretex_miner_testing/.env
 *   - launch profile/bundle/corpus not pinned in env or on disk
 *   - any code path would supply a synthetic deltaPpm instead of deriving it from real-Qwen
 *
 * Modes:
 *   --cpu-smoke           run real Qwen on CPU against a tiny pack — wires the loop,
 *                         does NOT bless launch economics; useful to prove plumbing before
 *                         provisioning an A100 (CORETEX_RERANKER_ALLOW_CUDA not set).
 *   --gpu                 require CORETEX_RERANKER_ALLOW_CUDA=1 + CUDA-visible host;
 *                         this is the launch-authoritative mode (run on A100 only).
 *
 * Operator envs:
 *   COORDINATOR_PORT              default 7790
 *   BASE_RPC_URL                  Base mainnet/fork RPC (read V4 cap live + emit receipts)
 *   V4_ADDRESS                    BotcoinMiningV4 address (where the on-chain cap lives)
 *   CORETEX_LAUNCH_PROFILE        path to the signed candidate profile JSON
 *   CORETEX_LAUNCH_BUNDLE         path to the candidate bundle manifest JSON
 *   CORETEX_LAUNCH_CORPUS         path to dgen1-r5-synth corpus JSON
 *   CORETEX_LAUNCH_EMBEDDINGS     path to dgen1-r5-synth embeddings JSON
 *   CORETEX_RERANKER_ALLOW_CUDA   "1" for --gpu mode
 *   HF_HUB_CACHE                  Qwen model cache
 *   HF_HUB_OFFLINE                "1" if cache is fully pre-populated
 *   ECONOMICS_RUN_ID              optional; auto-derived if absent
 *
 * Mining wallet env (read from coretex_miner_testing/.env at startup):
 *   NOOKPLOT_AGENT_PRIVATE_KEY   secret — never logged
 *   NOOKPLOT_AGENT_ADDRESS       miner EOA
 *   NOOKPLOT_GATEWAY_URL         Bankr Path-A gateway (optional; Path-B uses BASE_RPC_URL)
 *   NOOKPLOT_API_KEY             Bankr Path-A key (optional)
 *
 * Outputs:
 *   release/calibration/SCREENER_REAL_QWEN_ECONOMICS_FINDINGS.md  (rewritten at shutdown)
 *   release/calibration/runs/<runId>/submissions.jsonl            (every submit + outcome)
 *   release/calibration/runs/<runId>/transitions.jsonl            (every state transition)
 *   release/calibration/runs/<runId>/run.json                     (run metadata + hashes)
 *   release/calibration/CALIBRATION_LEDGER.jsonl                  (appends 1 line)
 *
 * Driver (separate process, spawned by the parent orchestrator):
 *   scripts/screener-real-qwen-miner-driver.mjs — wraps a Claude Sonnet subagent that gets
 *   ONLY the skill file + COORDINATOR_URL + wallet env. The subagent has no read access to
 *   this script, the launch profile, or any internal cortex source.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import process, { argv, env, exit } from 'node:process';
import { URL } from 'node:url';

import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';

const cortex = await import(distIndex);
const {
  // state + patches
  decodePatch, applyPatch, applyPatchOntoCurrent, merkleizeState, computePatchHash,
  loadPackedState, decodeCortexState, keccak256,
  // scoring (production path)
  evaluateRetrievalBenchmarkPatch, evaluateRetrievalBenchmarkState,
  scoringOptionsFromProfile, deriveQueryPack,
  // work + screener
  computeCoreTexScreenerThresholdPpm, evaluateCoreTexWorkQualification,
  computeCoreTexWorkUnitsBps, DEFAULT_CORETEX_WORK_POLICY,
  OUTCOME_CORETEX_SCREENER_PASS, OUTCOME_CORETEX_STATE_ADVANCE,
  // baseline
  evaluateBaseline, isMajorDelta,
  // reranker
  createStreamingQwen3Reranker, qwen3Reranker06BManifest,
  // bundle
  verifyBundleManifest,
} = cortex;

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const MODE = has('gpu') ? 'gpu' : (has('cpu-smoke') ? 'cpu-smoke' : null);
if (!MODE) {
  fail(
    'Mode required: --cpu-smoke (real Qwen on CPU; plumbing only) or --gpu (launch-authoritative; requires CORETEX_RERANKER_ALLOW_CUDA=1).\n' +
    'See docs/HANDOFFS/REAL_QWEN_SCREENER_ECONOMICS_HANDOFF.md for the full gate set.'
  );
}
const OFFLINE_SMOKE = has('offline-smoke');     // refuse on-chain reads; warn loud
const PORT = Number(flag('port', env.COORDINATOR_PORT || '7790'));
const RUN_ID = flag('run-id', env.ECONOMICS_RUN_ID || defaultRunId());
const PACK_SIZE = Number(flag('pack-size', MODE === 'cpu-smoke' ? '12' : '64'));
const MINER_SUBMITS_BUDGET = Number(flag('submits-budget', MODE === 'cpu-smoke' ? '40' : '2000'));
const SEEDS = Number(flag('seeds', MODE === 'cpu-smoke' ? '1' : '3'));
const SHUTDOWN_AFTER_BUDGET = has('shutdown-after-budget') || MODE === 'cpu-smoke';

const RUN_DIR = `${repoRoot}/release/calibration/runs/${RUN_ID}`;
mkdirSync(RUN_DIR, { recursive: true });
const SUBMISSIONS_LOG = `${RUN_DIR}/submissions.jsonl`;
const TRANSITIONS_LOG = `${RUN_DIR}/transitions.jsonl`;
const RUN_META = `${RUN_DIR}/run.json`;

// ─────────────────────────────────────────────────────────────────────────────
// Preflight (no fallbacks; refusing to start on any stop condition)
// ─────────────────────────────────────────────────────────────────────────────
function fail(msg) { process.stderr.write(`\n[screener-real-qwen-economics] ABORT: ${msg}\n\n`); exit(2); }
function warn(msg) { process.stderr.write(`[screener-real-qwen-economics] WARN: ${msg}\n`); }
function info(msg) { process.stdout.write(`[screener-real-qwen-economics] ${msg}\n`); }

// 1. Launch profile + bundle + corpus must be pinned.
const PROFILE_PATH = env.CORETEX_LAUNCH_PROFILE;
const BUNDLE_PATH = env.CORETEX_LAUNCH_BUNDLE;
const CORPUS_PATH = env.CORETEX_LAUNCH_CORPUS;
const EMBEDDINGS_PATH = env.CORETEX_LAUNCH_EMBEDDINGS;
for (const [k, v] of Object.entries({ CORETEX_LAUNCH_PROFILE: PROFILE_PATH, CORETEX_LAUNCH_BUNDLE: BUNDLE_PATH, CORETEX_LAUNCH_CORPUS: CORPUS_PATH, CORETEX_LAUNCH_EMBEDDINGS: EMBEDDINGS_PATH })) {
  if (!v) fail(`${k} env var missing — point it at the candidate launch artifact (see release/calibration/FINAL_LAUNCH_COMPOSITION.md).`);
  if (!existsSync(v)) fail(`${k}=${v} does not exist.`);
}

// 2. Mining wallet from coretex_miner_testing/.env
const minerEnvPath = `${repoRoot}/coretex_miner_testing/.env`;
if (!existsSync(minerEnvPath)) fail(`coretex_miner_testing/.env missing — expected NOOKPLOT_AGENT_* keys for the mining wallet.`);
const minerEnv = parseDotEnv(readFileSync(minerEnvPath, 'utf8'));
const MINER_ADDRESS = minerEnv.NOOKPLOT_AGENT_ADDRESS;
const MINER_PK = minerEnv.NOOKPLOT_AGENT_PRIVATE_KEY;
const BANKR_GATEWAY = minerEnv.NOOKPLOT_GATEWAY_URL || null;
const BANKR_KEY = minerEnv.NOOKPLOT_API_KEY || null;
if (!MINER_ADDRESS || !/^0x[0-9a-fA-F]{40}$/.test(MINER_ADDRESS)) fail(`NOOKPLOT_AGENT_ADDRESS not a valid 0x EOA in .env.`);
if (!MINER_PK) fail(`NOOKPLOT_AGENT_PRIVATE_KEY missing in .env.`);

// 3. V4 on-chain cap read — must succeed unless --offline-smoke explicitly passed.
const BASE_RPC_URL = env.BASE_RPC_URL || null;
const V4_ADDRESS = env.V4_ADDRESS || null;
let onChainScreenerCap = null;
if (BASE_RPC_URL && V4_ADDRESS) {
  try {
    onChainScreenerCap = await readScreenerCapFromV4(BASE_RPC_URL, V4_ADDRESS);
    info(`On-chain V4 coreTexScreenerCapPerMinerPerEpoch = ${onChainScreenerCap}`);
  } catch (e) {
    if (!OFFLINE_SMOKE) fail(`V4 cap read failed (${e.message}). Pass --offline-smoke to override (NOT launch-authoritative).`);
    warn(`V4 cap read failed (${e.message}); proceeding with --offline-smoke fallback.`);
  }
} else if (!OFFLINE_SMOKE) {
  fail(`BASE_RPC_URL + V4_ADDRESS not set — coordinator must read coreTexScreenerCapPerMinerPerEpoch live from V4. Pass --offline-smoke to override (NOT launch-authoritative).`);
}
if (onChainScreenerCap === null) {
  // Last-resort offline smoke: default to 50 (current on-chain default) but mark non-authoritative.
  onChainScreenerCap = Number(flag('offline-cap', '50'));
  warn(`Using --offline-cap=${onChainScreenerCap} (NOT chain-read; run report will be marked non-launch-authoritative).`);
}

// 4. Qwen3-Reranker-0.6B preflight.
const qwenManifest = qwen3Reranker06BManifest();
const QWEN_MODEL = qwenManifest.modelId;                    // "Qwen/Qwen3-Reranker-0.6B"
const QWEN_REVISION = qwenManifest.revision;
if (MODE === 'gpu' && env.CORETEX_RERANKER_ALLOW_CUDA !== '1') {
  fail(`--gpu requires CORETEX_RERANKER_ALLOW_CUDA=1 (and a CUDA-visible host). Set it explicitly to acknowledge the calibration-only path.`);
}
const HF_CACHE = env.HF_HUB_CACHE || env.HF_HOME || `${env.HOME}/.cache/huggingface`;
if (!existsSync(HF_CACHE)) warn(`HF cache ${HF_CACHE} does not exist; first run will download Qwen on demand.`);

// ─────────────────────────────────────────────────────────────────────────────
// Load launch context
// ─────────────────────────────────────────────────────────────────────────────
info(`Loading launch profile: ${PROFILE_PATH}`);
const profile = JSON.parse(readFileSync(PROFILE_PATH, 'utf8'));
info(`Loading bundle manifest: ${BUNDLE_PATH}`);
const bundle = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'));
// Verify bundle hash (refuses to start if drifted). Returns array of error strings ([] = OK).
const bundleErrors = verifyBundleManifest(bundle, repoRoot);
if (bundleErrors.length) {
  if (MODE === 'gpu' || !has('allow-bundle-drift')) {
    fail(
      `Bundle manifest verification failed:\n  - ${bundleErrors.join('\n  - ')}\n\n` +
      `Re-pin the bundle before running launch-authoritative economics. For CPU-smoke wiring iteration\n` +
      `only, pass --allow-bundle-drift (the run will be marked NON-AUTHORITATIVE in the findings).`
    );
  }
  warn(`Bundle drift detected (NON-AUTHORITATIVE; --allow-bundle-drift):\n  - ${bundleErrors.join('\n  - ')}`);
}
info(`Bundle hash: ${bundle.bundleHash}`);
info(`Loading corpus: ${CORPUS_PATH} (+ ${EMBEDDINGS_PATH})`);
const { corpus, LAYOUT, BE, biEncoderHash } = buildV2ProductionCorpus({ corpusPath: CORPUS_PATH, embPath: EMBEDDINGS_PATH });
info(`Corpus root: ${corpus.corpusRoot} | biEncoderHash=${biEncoderHash}`);

// ─────────────────────────────────────────────────────────────────────────────
// Persistent Qwen reranker (the only allowed scorer path)
// ─────────────────────────────────────────────────────────────────────────────
info(`Spawning persistent Qwen reranker (${QWEN_MODEL}@${QWEN_REVISION}) — model load can take 30-60s on first run.`);
const reranker = createStreamingQwen3Reranker({
  model: QWEN_MODEL,
  revision: QWEN_REVISION,
  cacheDir: HF_CACHE,
  localOnly: env.HF_HUB_OFFLINE === '1',
});
// Wait for ready by issuing a tiny warm-up score.
await reranker.score([{ query: 'warmup', document: 'warmup' }]);
info(`Reranker ready.`);

// Scoring options derived from the SIGNED profile + live runtime (biEncoder + reranker +
// biEncoderHash + retrievalKeyLayout) — matches production wiring exactly.
const scoringOptsBase = scoringOptionsFromProfile(profile, {
  biEncoder: inertBiEncoder(BE, LAYOUT),
  reranker, biEncoderHash, retrievalKeyLayout: LAYOUT,
});

// ─────────────────────────────────────────────────────────────────────────────
// Live state (mirrors what V4 + CoreTexRegistry would see)
// ─────────────────────────────────────────────────────────────────────────────
const liveState = createGenesisState();
let liveRoot = bytesToHex(merkleizeState(liveState));
let epochId = 1;
let activeFrontierRoot = profile.activeFrontierRoot ?? null;
let corpusRoot = corpus.corpusRoot;
let profileHash = computeProfileHash(profile);
let rerankerHash = bundle.rerankerHash || profileHash;
let bundleHash = bundle.bundleHash;
let baseline = await evaluateBaseline(liveState, corpus, deriveHiddenPackFor(epochId, profile, corpus), scoringOptsBase);
let baselineScorePpm = baseline.parentScorePpm;
let recentNoiseFloorPpm = baseline.variancePpm;
let screenerThresholdPpm = Number(computeCoreTexScreenerThresholdPpm({
  baselineScorePpm, recentNoiseFloorPpm, policy: DEFAULT_CORETEX_WORK_POLICY,
}));

// Per-miner + global counters (mirror V4 + registry semantics).
const perMinerScreeners = new Map();    // address(lower) -> count this epoch
let qualifiedScreenerPassesSinceLastStateAdvance = 0;
let transitionCount = 0;
const dedup = new Set();                // `${parentRoot}|${patchHash}|${outcomeId}` once credited

// Submissions JSONL — every patch outcome lands here (full deltaPpm, gate/confirm scores, reason).
function logSubmission(rec) { appendFileSync(SUBMISSIONS_LOG, JSON.stringify(rec) + '\n'); }
function logTransition(rec) { appendFileSync(TRANSITIONS_LOG, JSON.stringify(rec) + '\n'); }

// ─────────────────────────────────────────────────────────────────────────────
// Real per-patch scorer (closure over Qwen + corpus + profile)
// ─────────────────────────────────────────────────────────────────────────────
async function scoreRealQwen(patchBytesU8, parentRoot) {
  if (parentRoot.toLowerCase() !== liveRoot.toLowerCase()) {
    return { kind: 'W02_STALE_PARENT', currentStateRoot: liveRoot };
  }
  let decoded;
  try { decoded = decodePatch(patchBytesU8); } catch (e) { return { kind: 'DECODE', message: String(e?.message ?? e) }; }
  const applied = applyPatch(liveState, decoded, scoringOptsBase.policyAtomsMode === true);
  if (!applied.ok) return { kind: applied.code, message: applied.reason ?? '' };

  // Evaluate via REAL retrieval-benchmark + the persistent Qwen reranker.
  const pack = deriveHiddenPackFor(epochId, profile, corpus);
  const result = await evaluateRetrievalBenchmarkPatch(
    liveState, decoded, corpus, pack,
    scoringOptsBase,
    {
      minImprovementPpm: Number(profile.stateAdvance?.minImprovementPpm ?? 2500),
      structuralFloor: Number(profile.stateAdvance?.structuralFloor ?? 0.4),
      protectedRegressionFloor: Number(profile.stateAdvance?.protectedRegressionFloor ?? 0.1),
      familyCatastrophicFloor: Number(profile.stateAdvance?.familyCatastrophicFloor ?? 0.5),
      acceptanceThresholdPpm: Number(profile.stateAdvance?.acceptanceThresholdPpm ?? 2500),
    },
  );
  return { kind: 'SCORED', deltaPpm: result.deltaPpm, accepted: result.accepted, reason: result.reason, after: applied.state };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP coord (real /coretex/* surface — same shape the production coord exposes)
// ─────────────────────────────────────────────────────────────────────────────
function challengePayload(miner) {
  const minerL = miner ? miner.toLowerCase() : null;
  const remaining = minerL ? Math.max(0, onChainScreenerCap - (perMinerScreeners.get(minerL) || 0)) : onChainScreenerCap;
  return {
    epochId, parentStateRoot: liveRoot, currentStateRoot: liveRoot,
    bundleHash, coreVersionHash: bundleHash,
    profileName: profile.name ?? 'coretex-retrieval-v2-policy-r5',
    pipelineVersion: profile.pipelineVersion ?? 'r4',
    corpusRoot, corpusMeta: { biEncoderModel: profile.encoders?.biEncoder?.modelId ?? 'BAAI/bge-m3', biEncoderRevision: profile.encoders?.biEncoder?.revision ?? 'main' },
    activeFrontierRoot,
    substrateAccess: { byRoot: `/coretex/substrate/${liveRoot}`, wordCount: 1024, packedBytes: 32768 },
    allowedPatchTypes: profile.allowedPatchTypes ?? defaultAllowedPatchTypes(),
    patchWordBudget: 4,
    minImprovementPpm: Number(profile.stateAdvance?.minImprovementPpm ?? 2500),
    replayTolerancePpm: Number(profile.stateAdvance?.replayTolerancePpm ?? 200),
    screenerThresholdPpm,
    perMinerScreenerCap: onChainScreenerCap,
    perMinerScreenerRemaining: remaining,
    workMultiplierBps: { schedule: [30000, 40000, 60000, 90000, 120000], thresholds: [0, 25, 100, 250, 500], hardCapBps: 300000 },
    memoryIRSchemaVersion: profile.memoryIRSchemaVersion ?? '1.0.0',
    activeSubstrateSurfaces: profile.activeSubstrateSurfaces ?? ['temporal', 'relation_typed_routing', 'evidence_bundle', 'guarded_abstention'],
    exampleValidPatch: structuralOnlyTemplate(liveRoot),
    hiddenEvalWarning: 'hidden qrels / eval pack contents / answer IDs / epochSecret are NOT public; do not attempt to derive them.',
  };
}

function statusPayload(miner) {
  const minerL = miner ? miner.toLowerCase() : null;
  return {
    epochId, currentStateRoot: liveRoot,
    transitionCount, qualifiedScreenerPassesSinceLastStateAdvance,
    nextStateAdvanceWorkBps: Number(computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      policy: DEFAULT_CORETEX_WORK_POLICY,
      qualifiedScreenerPassesSinceLastStateAdvance,
    })),
    perMiner: minerL ? {
      address: minerL, cap: onChainScreenerCap,
      screenersThisEpoch: perMinerScreeners.get(minerL) || 0,
      remaining: Math.max(0, onChainScreenerCap - (perMinerScreeners.get(minerL) || 0)),
    } : { cap: onChainScreenerCap, remaining: onChainScreenerCap, screenersThisEpoch: 0, note: 'pass ?miner=0x… for your specific counter' },
    screenerThresholdPpm, baselineScorePpm, recentNoiseFloorPpm,
  };
}

let submissionsSeen = 0;
async function handleSubmit(body) {
  submissionsSeen += 1;
  if (!body || typeof body !== 'object') return { status: 'rejected', reason: 'malformed-body', code: 'BODY' };
  const { patchBytesHex, parentStateRoot, minerAddress, outcome: outcomeHint } = body;
  if (typeof patchBytesHex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(patchBytesHex)) return { status: 'rejected', reason: 'patchBytesHex-malformed', code: 'BODY' };
  if (typeof parentStateRoot !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(parentStateRoot)) return { status: 'rejected', reason: 'parentStateRoot-malformed', code: 'BODY' };
  if (typeof minerAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(minerAddress)) return { status: 'rejected', reason: 'minerAddress-malformed', code: 'BODY' };
  if (parentStateRoot.toLowerCase() !== liveRoot.toLowerCase()) {
    return { status: 'rejected', reason: 'parentStateRoot ≠ current live root', code: 'E01', currentStateRoot: liveRoot };
  }
  const patchBytesU8 = hexToBytes(patchBytesHex);
  const scored = await scoreRealQwen(patchBytesU8, parentStateRoot);
  if (scored.kind !== 'SCORED') {
    const out = { status: 'rejected', reason: scored.message || scored.kind, code: scored.kind, ...(scored.currentStateRoot ? { currentStateRoot: scored.currentStateRoot } : {}) };
    logSubmission({ t: new Date().toISOString(), minerAddress, parentStateRoot, patchBytesHex, outcomeHint, result: out, ctx: snapshotCtx() });
    return out;
  }
  const { deltaPpm, after } = scored;
  const patchHash = computePatchHash(patchBytesU8);
  const minerL = minerAddress.toLowerCase();
  const minImprovement = Number(profile.stateAdvance?.minImprovementPpm ?? 2500);
  const replayTol = Number(profile.stateAdvance?.replayTolerancePpm ?? 200);

  // STATE_ADVANCE attempt (auto when delta crosses floor, or explicit outcomeHint)
  const wantsAdvance = outcomeHint === 'STATE_ADVANCE' || deltaPpm >= (minImprovement + recentNoiseFloorPpm + replayTol);
  if (wantsAdvance) {
    const q = evaluateCoreTexWorkQualification({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE, parentMatchesLiveRoot: true,
      baselineScorePpm, deterministicDeltaPpm: deltaPpm, liveStateAdvanced: true,
      policy: DEFAULT_CORETEX_WORK_POLICY,
      qualifiedScreenerPassesSinceLastStateAdvance,
    });
    if (!q.qualified) {
      const out = { status: 'rejected', reason: q.reason, code: q.reason, deterministicDeltaPpm: deltaPpm, requiredDeltaPpm: Number(q.requiredDeterministicDeltaPpm) };
      logSubmission({ t: new Date().toISOString(), minerAddress, parentStateRoot, patchBytesHex, outcomeHint, result: out, ctx: snapshotCtx() });
      return out;
    }
    const dedupKey = `${liveRoot}|${patchHash}|2`;
    if (dedup.has(dedupKey)) {
      const out = { status: 'rejected', reason: 'DuplicateCoreTexPatch', code: 'DuplicateCoreTexPatch' };
      logSubmission({ t: new Date().toISOString(), minerAddress, parentStateRoot, patchBytesHex, outcomeHint, result: out, ctx: snapshotCtx() });
      return out;
    }
    dedup.add(dedupKey);
    const bps = Number(computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE, policy: DEFAULT_CORETEX_WORK_POLICY,
      qualifiedScreenerPassesSinceLastStateAdvance,
    }));
    // Advance live state.
    const beforeRoot = liveRoot;
    overwriteState(liveState, after);
    liveRoot = bytesToHex(merkleizeState(liveState));
    transitionCount += 1;
    qualifiedScreenerPassesSinceLastStateAdvance = 0;
    // Recompute baseline against the new parent — positional signature, ppm fields direct
    // (evaluateBaseline already returns parentScorePpm/variancePpm in ppm; do NOT re-scale).
    const newBaseline = await evaluateBaseline(liveState, corpus, deriveHiddenPackFor(epochId, profile, corpus), scoringOptsBase);
    baselineScorePpm = newBaseline.parentScorePpm;
    recentNoiseFloorPpm = newBaseline.variancePpm;
    screenerThresholdPpm = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm, recentNoiseFloorPpm, policy: DEFAULT_CORETEX_WORK_POLICY }));
    logTransition({ t: new Date().toISOString(), kind: 'STATE_ADVANCE', beforeRoot, afterRoot: liveRoot, deltaPpm, miner: minerL, baselineScorePpm, screenerThresholdPpm });
    const out = {
      status: 'accepted', outcome: 'STATE_ADVANCE', patchHash,
      evalReportHash: '0x' + createHash('sha256').update(`eval-${patchHash}`).digest('hex'),
      deterministicDeltaPpm: deltaPpm, workUnitsBps: bps, newStateRoot: liveRoot,
      receipt: buildReceiptStub({ miner: minerAddress, parentStateRoot: beforeRoot, newStateRoot: liveRoot, patchHash, bps }),
      // No `transaction` field: the on-chain broadcast (ABI-encoded submitCoreTexReceipt
      // calldata + chainId + to-address) is the miner driver's job, built from the receipt
      // struct + V4 ABI. Emitting a 0xSTUB calldata here would be a copy-paste footgun.
    };
    logSubmission({ t: new Date().toISOString(), minerAddress, parentStateRoot, patchBytesHex, outcomeHint, result: out, ctx: snapshotCtx() });
    return out;
  }

  // SCREENER_PASS attempt.
  // CRITICAL: per-miner cap is read from on-chain V4 (or --offline-cap with explicit warn).
  if ((perMinerScreeners.get(minerL) || 0) >= onChainScreenerCap) {
    const out = { status: 'rejected', reason: 'CoreTexScreenerCapExceeded (per-miner per-epoch)', code: 'CoreTexScreenerCapExceeded', perMinerCap: onChainScreenerCap, current: perMinerScreeners.get(minerL) || 0 };
    logSubmission({ t: new Date().toISOString(), minerAddress, parentStateRoot, patchBytesHex, outcomeHint, result: out, ctx: snapshotCtx() });
    return out;
  }
  const q = evaluateCoreTexWorkQualification({
    outcome: OUTCOME_CORETEX_SCREENER_PASS, parentMatchesLiveRoot: true,
    baselineScorePpm, deterministicDeltaPpm: deltaPpm,
    policy: DEFAULT_CORETEX_WORK_POLICY,
  });
  if (!q.qualified) {
    const out = { status: 'rejected', reason: q.reason, code: q.reason, deterministicDeltaPpm: deltaPpm, requiredDeltaPpm: Number(q.requiredDeterministicDeltaPpm) };
    logSubmission({ t: new Date().toISOString(), minerAddress, parentStateRoot, patchBytesHex, outcomeHint, result: out, ctx: snapshotCtx() });
    return out;
  }
  const dedupKey = `${liveRoot}|${patchHash}|1`;
  if (dedup.has(dedupKey)) {
    const out = { status: 'rejected', reason: 'DuplicateCoreTexPatch', code: 'DuplicateCoreTexPatch' };
    logSubmission({ t: new Date().toISOString(), minerAddress, parentStateRoot, patchBytesHex, outcomeHint, result: out, ctx: snapshotCtx() });
    return out;
  }
  dedup.add(dedupKey);
  perMinerScreeners.set(minerL, (perMinerScreeners.get(minerL) || 0) + 1);
  qualifiedScreenerPassesSinceLastStateAdvance += 1;
  const out = {
    status: 'accepted', outcome: 'SCREENER_PASS', patchHash,
    evalReportHash: '0x' + createHash('sha256').update(`eval-${patchHash}`).digest('hex'),
    deterministicDeltaPpm: deltaPpm,
    workUnitsBps: Number(DEFAULT_CORETEX_WORK_POLICY.screenerPass.workUnitsBps),
    perMinerScreenerCount: perMinerScreeners.get(minerL),
    perMinerScreenerRemaining: Math.max(0, onChainScreenerCap - perMinerScreeners.get(minerL)),
  };
  logSubmission({ t: new Date().toISOString(), minerAddress, parentStateRoot, patchBytesHex, outcomeHint, result: out, ctx: snapshotCtx() });
  return out;
}

// Admin endpoints — drive state transitions the handoff requires us to exercise.
// IMPORTANT: these bump pin hashes synthetically (random sha256). They model the on-chain
// CONSEQUENCE (baseline recompute + stale-context rejection of receipts built against the
// old pin) but they do NOT exercise the upstream MACHINERY (real EpochFrontier rotate,
// applyCorpusDelta, profile/bundle re-pin, reranker checkpoint swap). Sufficient to bless
// CONTEXT-pin enforcement; NOT sufficient to bless the dynamics of churn/corpus growth.
// The launch-authoritative pass must call the real EpochFrontier + corpus-delta machinery
// (see scripts/churn-launch-e2e.mjs + scripts/baseline-recalibration-e2e.mjs).
async function adminRotateChurn() {
  const before = activeFrontierRoot;
  activeFrontierRoot = '0x' + createHash('sha256').update(`frontier-${epochId}-${Date.now()}`).digest('hex');
  await recomputeBaseline('churn-rotate');
  logTransition({ t: new Date().toISOString(), kind: 'CHURN_ROTATE', beforeActiveFrontierRoot: before, afterActiveFrontierRoot: activeFrontierRoot, baselineScorePpm, screenerThresholdPpm });
  return { ok: true, activeFrontierRoot };
}
async function adminCorpusDelta() {
  // Simulate a corpus growth delta by bumping corpusRoot. In a real run this would apply a
  // CorpusDelta via applyCorpusDelta() against the loaded corpus.
  const before = corpusRoot;
  corpusRoot = '0x' + createHash('sha256').update(`corpus-${corpusRoot}-${Date.now()}`).digest('hex');
  await recomputeBaseline('corpus-delta');
  logTransition({ t: new Date().toISOString(), kind: 'CORPUS_DELTA', beforeCorpusRoot: before, afterCorpusRoot: corpusRoot, baselineScorePpm, screenerThresholdPpm });
  return { ok: true, corpusRoot };
}
async function adminBumpHash(field) {
  const map = { profileHash: () => { profileHash = '0x' + createHash('sha256').update(`profile-${Date.now()}`).digest('hex'); return profileHash; },
                rerankerHash: () => { rerankerHash = '0x' + createHash('sha256').update(`reranker-${Date.now()}`).digest('hex'); return rerankerHash; },
                bundleHash: () => { /* refuse — bundleHash is signed */ return null; } };
  if (!map[field]) return { ok: false, reason: 'unknown field' };
  if (field === 'bundleHash') return { ok: false, reason: 'bundleHash is signed; cannot be hot-rotated' };
  const after = map[field]();
  await recomputeBaseline(`${field}-bump`);
  logTransition({ t: new Date().toISOString(), kind: `${field.toUpperCase()}_BUMP`, after, baselineScorePpm, screenerThresholdPpm });
  return { ok: true, [field]: after };
}
async function adminNextEpoch() {
  const before = epochId;
  epochId += 1;
  perMinerScreeners.clear();           // per-miner cap resets on epoch boundary
  qualifiedScreenerPassesSinceLastStateAdvance = 0;
  await recomputeBaseline('next-epoch');
  logTransition({ t: new Date().toISOString(), kind: 'EPOCH_BOUNDARY', beforeEpochId: before, afterEpochId: epochId, baselineScorePpm });
  return { ok: true, epochId };
}
async function recomputeBaseline(cause) {
  const b = await evaluateBaseline(liveState, corpus, deriveHiddenPackFor(epochId, profile, corpus), scoringOptsBase);
  baselineScorePpm = b.parentScorePpm;
  recentNoiseFloorPpm = b.variancePpm;
  screenerThresholdPpm = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm, recentNoiseFloorPpm, policy: DEFAULT_CORETEX_WORK_POLICY }));
  info(`Baseline recomputed (${cause}): ${baselineScorePpm}ppm  threshold=${screenerThresholdPpm}ppm`);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP server
// ─────────────────────────────────────────────────────────────────────────────
function sendJson(res, status, body) { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body, null, 2)); }
async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); if (!chunks.length) return null; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; } }

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    const path = u.pathname;
    if (req.method === 'GET' && path === '/coretex/health') return sendJson(res, 200, { ok: true, port: PORT, mode: MODE });
    if (req.method === 'GET' && path === '/coretex/challenge') return sendJson(res, 200, challengePayload(u.searchParams.get('miner')));
    if (req.method === 'GET' && path === '/coretex/status') return sendJson(res, 200, statusPayload(u.searchParams.get('miner')));
    if (req.method === 'POST' && path === '/coretex/submit') {
      const body = await readBody(req);
      const out = await handleSubmit(body);
      const status = out.status === 'accepted' ? 200 : 400;
      sendJson(res, status, out);
      if (SHUTDOWN_AFTER_BUDGET && submissionsSeen >= MINER_SUBMITS_BUDGET) {
        info(`Submissions budget ${MINER_SUBMITS_BUDGET} reached; shutting down.`);
        setImmediate(() => shutdown(0));
      }
      return;
    }
    // Admin endpoints — these are LOCALHOST-ONLY and gated for the orchestrator driver.
    if (req.method === 'POST' && path === '/admin/rotate-churn') return sendJson(res, 200, await adminRotateChurn());
    if (req.method === 'POST' && path === '/admin/corpus-delta') return sendJson(res, 200, await adminCorpusDelta());
    if (req.method === 'POST' && path === '/admin/bump-profile-hash') return sendJson(res, 200, await adminBumpHash('profileHash'));
    if (req.method === 'POST' && path === '/admin/bump-reranker-hash') return sendJson(res, 200, await adminBumpHash('rerankerHash'));
    if (req.method === 'POST' && path === '/admin/next-epoch') return sendJson(res, 200, await adminNextEpoch());
    if (req.method === 'GET' && path === '/admin/snapshot') return sendJson(res, 200, snapshotCtx());
    return sendJson(res, 404, { error: 'not found', path });
  } catch (e) {
    sendJson(res, 500, { error: 'server error', message: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  info(`Coordinator up on http://127.0.0.1:${PORT}  (mode=${MODE} runId=${RUN_ID})`);
  info(`Mining wallet: ${MINER_ADDRESS}`);
  info(`On-chain V4 cap: ${onChainScreenerCap} (${BASE_RPC_URL && V4_ADDRESS ? 'chain-read' : 'offline-fallback NOT launch-authoritative'})`);
  info(`Live root=${liveRoot}  threshold=${screenerThresholdPpm}ppm  baseline=${baselineScorePpm}ppm`);
  writeFileSync(RUN_META, JSON.stringify({
    runId: RUN_ID, mode: MODE, startedAt: new Date().toISOString(),
    profilePath: PROFILE_PATH, bundlePath: BUNDLE_PATH, corpusPath: CORPUS_PATH,
    bundleHash, corpusRoot, profileHash, rerankerHash,
    onChainScreenerCap, chainCapSource: BASE_RPC_URL && V4_ADDRESS ? 'v4' : 'offline-fallback',
    minerAddress: MINER_ADDRESS,
  }, null, 2));
});

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown + findings
// ─────────────────────────────────────────────────────────────────────────────
async function shutdown(exitCode) {
  info(`Shutting down (submissions seen=${submissionsSeen}).`);
  try { await reranker.close(); } catch {}
  try { server.close(); } catch {}
  // Write findings stub with whatever the run produced. The full report is generated by
  // a follow-up analysis step (analyze-real-qwen-economics.mjs) reading the JSONL logs.
  const findings = renderFindingsStub();
  writeFileSync(`${repoRoot}/release/calibration/SCREENER_REAL_QWEN_ECONOMICS_FINDINGS.md`, findings);
  // Ledger entry.
  appendFileSync(`${repoRoot}/release/calibration/CALIBRATION_LEDGER.jsonl`, JSON.stringify({
    t: new Date().toISOString(), kind: 'screener-real-qwen-economics', runId: RUN_ID, mode: MODE,
    bundleHash, corpusRoot, profileHash, rerankerHash, submissionsSeen,
    chainCapSource: BASE_RPC_URL && V4_ADDRESS ? 'v4' : 'offline-fallback', onChainScreenerCap,
    artifactPaths: { run: RUN_DIR, submissions: SUBMISSIONS_LOG, transitions: TRANSITIONS_LOG, meta: RUN_META, findings: `${repoRoot}/release/calibration/SCREENER_REAL_QWEN_ECONOMICS_FINDINGS.md` },
  }) + '\n');
  exit(exitCode);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function defaultRunId() {
  const d = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `screener-real-qwen-${d}-${randomBytes(2).toString('hex')}`;
}
function parseDotEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
function hexToBytes(hex) {
  const s = hex.replace(/^0x/, '');
  const o = new Uint8Array(s.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return o;
}
function bytesToHex(u8) { return '0x' + Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(''); }
function createGenesisState() {
  // CortexState.words is an array-like of BigInt[1024]; genesis = all zeros.
  return { words: new Array(1024).fill(0n) };
}
function overwriteState(dst, src) {
  for (let i = 0; i < 1024; i++) dst.words[i] = src.words[i];
}
function snapshotCtx() {
  return {
    epochId, liveRoot, activeFrontierRoot, corpusRoot, profileHash, rerankerHash, bundleHash,
    baselineScorePpm, recentNoiseFloorPpm, screenerThresholdPpm,
    transitionCount, qualifiedScreenerPassesSinceLastStateAdvance,
    onChainScreenerCap, perMinerScreeners: Object.fromEntries(perMinerScreeners),
  };
}
function computeProfileHash(p) {
  return '0x' + createHash('sha256').update(JSON.stringify(canonicalize(p))).digest('hex');
}
function canonicalize(v) {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalize(v[k])]));
  return v;
}
function deriveHiddenPackFor(epochId_, profile_, corpus_) {
  // Production wires deriveQueryPack(epochId, evalSeedHex, corpus, profile) — pinned to the
  // SIGNED profile to match production exactly. We pin to bundleHash for cross-epoch determinism
  // so a single run sees consistent pack composition unless we explicitly bump the eval seed.
  const evalSeed = profile_.evalSeedHex ?? ('0x' + createHash('sha256').update(`pack-${epochId_}-${bundleHash}`).digest('hex'));
  return deriveQueryPack(epochId_, evalSeed, corpus_, profile_);
}
function defaultAllowedPatchTypes() {
  return [
    { name: 'KEY_UPDATE', byte: 1, wordIndexRange: [384, 671] },
    { name: 'RELATION_UPDATE', byte: 2, wordIndexRange: [32, 383] },
    { name: 'TEMPORAL_UPDATE', byte: 3, wordIndexRange: [800, 895] },
    { name: 'BRIDGE_UPDATE', byte: 4, wordIndexRange: [672, 799] },
    { name: 'CONFLICT_UPDATE', byte: 5, wordIndexRange: [896, 991] },
    { name: 'CORE_UPDATE', byte: 6, wordIndexRange: [0, 31] },
    { name: 'MIXED', byte: 255, wordIndexRange: [0, 991] },
  ];
}
function structuralOnlyTemplate(parentRoot) {
  // Deliberate no-op template: zero-words at non-target indices ⇒ verbatim submit returns E05.
  return {
    patchType: 0xff, patchTypeName: 'MIXED', wordCount: 2,
    indices: [400, 500],
    newWords: ['0x' + '00'.repeat(32), '0x' + '00'.repeat(32)],
    scoreDeltaInPatch: 0, parentInPatchMustEqual: parentRoot,
    note: 'Structural template only. Submitting verbatim returns E05 NOOP. Replace newWords with content that genuinely improves the substrate (your responsibility — there is no scoring oracle).',
  };
}
function buildReceiptStub({ miner, parentStateRoot, newStateRoot, patchHash, bps }) {
  // The harness emits the receipt FIELDS so a downstream driver (anvil fork or live Base)
  // can wrap them with a real coordinator EIP-712 signature and broadcast via
  // submitCoreTexReceipt(<tuple>). Generating a real coordinator signature requires the
  // coordinator's private key + EIP-712 domain — explicitly out of scope for this scaffold
  // (the production coord owns the signer; the harness is a local-eval shim). The stub
  // signature below is INVALID-BY-CONSTRUCTION (65×0xee + non-hex suffix) so any code path
  // that tries to verify it on-chain MUST fail — preventing accidental "looks signed".
  return {
    outcome: 2, miner, epochId, parentStateRoot, newStateRoot, patchHash, workUnitsBps: bps,
    coordinatorSignature: '0x' + 'ee'.repeat(65),
    signatureKind: 'STUB_UNSIGNED_HARNESS_ONLY',
    note: 'For an end-to-end on-chain receipt-verify drill, wire the production coordinator signer (env CORETEX_COORDINATOR_PK or HSM) and re-emit signatureKind="EIP712".',
  };
}

async function readScreenerCapFromV4(rpcUrl, v4Address) {
  // Solidity getter selector = keccak256('coreTexScreenerCapPerMinerPerEpoch()').slice(0,4).
  const sigBytes = keccak256(new TextEncoder().encode('coreTexScreenerCapPerMinerPerEpoch()'));
  const selector = bytesToHex(sigBytes).slice(0, 10);     // '0x' + 8 hex chars
  const payload = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: v4Address, data: selector }, 'latest'] };
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`RPC eth_call HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC error: ${j.error.message}`);
  const hex = j.result;
  if (!hex || hex === '0x' || hex.length < 4) throw new Error(`empty eth_call result`);
  return Number(BigInt(hex));
}

function renderFindingsStub() {
  const launchAuth = (BASE_RPC_URL && V4_ADDRESS) ? 'YES' : 'NO (offline-fallback; not launch-authoritative)';
  return `# Screener Real-Qwen Economics — Findings (DRAFT)

Run ID: \`${RUN_ID}\`
Mode: \`${MODE}\`
Launch-authoritative: ${launchAuth}
Generated: ${new Date().toISOString()}

Profile: \`${PROFILE_PATH}\`
Bundle:  \`${BUNDLE_PATH}\` (\`bundleHash ${bundleHash}\`)
Corpus:  \`${CORPUS_PATH}\` (\`corpusRoot ${corpusRoot}\`)
Reranker: ${QWEN_MODEL}@${QWEN_REVISION}
On-chain V4 \`coreTexScreenerCapPerMinerPerEpoch\`: ${onChainScreenerCap} (${BASE_RPC_URL && V4_ADDRESS ? 'chain-read' : 'offline-fallback'})

Mining wallet (subagent miner EOA): \`${MINER_ADDRESS}\`

Submissions seen: ${submissionsSeen}
State transitions: ${transitionCount}

Raw artifacts:
- \`${SUBMISSIONS_LOG}\` — every patch outcome (full deltaPpm, reason, ctx snapshot)
- \`${TRANSITIONS_LOG}\` — every baseline/parent/churn/corpus/profile/reranker transition
- \`${RUN_META}\` — run metadata + hashes

## Status

This is the FIRST scaffold of the real-Qwen production-flow screener-economics harness per
\`docs/HANDOFFS/REAL_QWEN_SCREENER_ECONOMICS_HANDOFF.md\`. It runs the SAME production
scoring path the launch coordinator will use (Qwen3-Reranker-0.6B + retrieval-benchmark)
and refuses to fall back to a deterministic-proxy scorer.

The launch verdict (cap, multipliers, withheld-advance profitability, false-screener rate,
state-advances/epoch) is decided AFTER a multi-seed \`--gpu\` run on an A100 with the real
mining wallet exercising the full class set through a zero-context Sonnet subagent miner.
This stub records what the current run actually produced; it does NOT bless any launch
parameter on its own.

## Class outcomes

(populated by analyze-real-qwen-economics.mjs from the JSONL log; not yet computed here)

## Dynamic context transitions exercised

(populated by analyze; see transitions.jsonl)

## Gates (handoff §Gates)

| gate | status |
|---|---|
| junk/random/invalid false-screener rate ≈ 0 | TBD (post-analysis) |
| exact duplicates never increment counter twice | TBD |
| stale parent/context submissions never earn credit | TBD |
| weak positives below threshold do not earn credit | TBD |
| viable non-advancing candidates pass sometimes | TBD |
| true advances accepted as advances (never downgraded to screener) | TBD |
| withhold strategy profitable only with genuine real-Qwen-qualified attempts | TBD |
| per-miner cap blocks spam without blocking honest attempts | TBD |
| replay parity (registry events → same state root) | TBD |
| production role separation | N/A (offline coord; address-only audit) |

## Next

Run the analyze step:

\`\`\`bash
node scripts/analyze-real-qwen-economics.mjs --run-id ${RUN_ID}
\`\`\`
`;
}
