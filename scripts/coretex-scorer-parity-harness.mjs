#!/usr/bin/env node
/**
 * CoreTex scorer parity harness.
 *
 * Runs the REAL CoreTex eval path (deriveQueryPack -> evaluateRetrievalBenchmark{State,Patch}
 * + runPerPatchEvaluation) for a chosen reranker backend (qwen-cpu / gpu / deterministic) over
 * the launch materialized corpus, with FIXED deterministic seed inputs, and emits everything a
 * compare step needs to prove the RTX 4090 fp32 scorer produces the SAME eval RESULT as the CPU
 * fp32 validator path — at the composite / ranking level, not just raw scores.
 *
 * It does NOT mutate the signed bundle/profile and does NOT touch the chain: the per-patch
 * blockhash binding is supplied by a FIXED in-memory BaseRpcClient so the gate/confirm seeds are
 * byte-identical across the CPU and GPU runs. Two runs of this harness against the same corpus +
 * same fixed seeds therefore differ ONLY in the reranker backend; the compare step gates the
 * difference.
 *
 * Five scenarios (all seeded deterministically):
 *   1. baseline       — evaluateRetrievalBenchmarkState over the blank launch substrate.
 *   2. gate-only       — a patch the gate REJECTS (evaluateRetrievalBenchmarkPatch on the gate
 *                        pack). Short-circuits: no confirm pack scored.
 *   3. dual-pack       — a patch that passes the gate and runs confirm (gate + confirm packs).
 *   4. accepted-patch  — runPerPatchEvaluation with a fixed honest patch that ACCEPTS, plus the
 *                        canonical post-reveal eval-report artifact + artifactHash.
 *   5. rejected-patch  — runPerPatchEvaluation with a fixed garbage patch that REJECTS.
 *
 * Usage:
 *   node scripts/coretex-scorer-parity-harness.mjs \
 *     --reranker deterministic --inner-batch 8 --out parity-cpu.json
 *
 * For the SMOKE only (no GPU): add --max-queries N to subset the hidden pack so the harness runs
 * fast under the deterministic reranker. --max-queries MUST be unset for a real CPU/GPU parity run.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { createHash } from 'node:crypto';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { relationUnits, makePatch } from './lib/v2-patch-families.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { makeInstrumentedReranker } from './lib/instrumented-reranker.mjs';
import { calibrationProvenance } from './lib/calibration-provenance.mjs';

const C = await import(distIndex);
const {
  RANGES,
  DEFAULT_CORETEX_WORK_POLICY,
  biEncoderModelIdHash,
  computeCoreTexScreenerThresholdPpm,
  createDeterministicReranker,
  deriveQueryPack,
  deriveGateEvalSeed,
  deriveConfirmEvalSeed,
  computePatchHash,
  encodePatch,
  decodePatch,
  encodeMemoryIndexSlot,
  stableRecordIdFor,
  evaluateRetrievalBenchmarkState,
  evaluateRetrievalBenchmarkPatch,
  runPerPatchEvaluation,
  buildPostRevealEvalReportArtifact,
  hashPostRevealEvalReportArtifact,
  hiddenPackProfileFromEvaluatorProfile,
  scoringOptionsFromProfile,
  keccak256,
  bytesToHex,
} = C;

// ─── Flags ──────────────────────────────────────────────────────────────────
function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}
const has = (name) => argv.includes(`--${name}`);

const rerankerMode = flag('reranker', 'deterministic');
const innerBatch = flag('inner-batch', env.RERANKER_INNER_BATCH ?? '8');
const reportPath = flag('out', null);
const maxQueries = flag('max-queries', null);
const ALL_SCENARIOS = ['baseline', 'gate-only', 'dual-pack', 'accepted-patch', 'rejected-patch'];
const scenarioFilter = (flag('scenarios', null) ?? ALL_SCENARIOS.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);

const DEFAULT_ARTIFACT_MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
const artifactManifestPath = flag('manifest', DEFAULT_ARTIFACT_MANIFEST);

if (!['gpu', 'qwen-cpu', 'deterministic'].includes(rerankerMode)) {
  console.error('--reranker must be one of: gpu, qwen-cpu, deterministic');
  exit(2);
}
if (!reportPath) {
  console.error('--out <result.json> is required');
  exit(2);
}
for (const s of scenarioFilter) {
  if (!ALL_SCENARIOS.includes(s)) { console.error(`unknown scenario: ${s} (allowed: ${ALL_SCENARIOS.join(', ')})`); exit(2); }
}
// --inner-batch sets RERANKER_INNER_BATCH for the instrumented backend AND the stream backend.
env.RERANKER_INNER_BATCH = String(innerBatch);

// ─── FIXED deterministic inputs (byte-identical across cpu / gpu runs) ───────
// These are the only knobs that, together with the corpus + profile pins, fully determine the
// gate/confirm packs. They MUST be the same for both runs being compared.
const FIXED = Object.freeze({
  epochId: 0,
  // Eval seed used for the baseline pack + the gate/confirm pack derivation context.
  evalSeedHex: '0x' + 'a5'.repeat(32),
  // Fixed receipt material so runPerPatchEvaluation's gate/confirm seeds are deterministic.
  receipt: Object.freeze({
    receivedAtBlock: 30_000_000,
    targetBlockOffset: 30,
    targetBlock: 30_000_030,
    blockhash: '0x' + 'b1'.repeat(32),
    minerAddress: '0x000000000000000000000000000000000000c0de',
  }),
  // Garbage patch: a MemoryIndex slot anchored to a NON-EXISTENT record id (fixed slot + id).
  // Structurally valid (applies cleanly, gets scored) but points at nothing in the corpus, so it
  // cannot improve retrieval -> rejects on the score floor / threshold rather than apply-fail.
  garbageMemorySlot: 300,
  garbageRecordSeed: 'coretex-parity-garbage-nonexistent-record',
});

// ─── Hashing helpers (match recalibrate-baseline canonicalization) ───────────
const shaFile = (path) => '0x' + createHash('sha256').update(readFileSync(resolve(repoRoot, path))).digest('hex');
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}
const queryPackRoot = (pack) => '0x' + createHash('sha256').update(pack.events.map((e) => e.id).sort().join('\n')).digest('hex');
const u8ToHex = (u8) => '0x' + Buffer.from(u8).toString('hex');

// ─── Load bundle + profile + materialized corpus (same resolution path as recalibrate-baseline) ─
const artifactManifest = JSON.parse(readFileSync(resolve(repoRoot, artifactManifestPath), 'utf8'));
const payloadPath = (role) => artifactManifest.payloads?.find((p) => p.role === role)?.path;
const profilePath = flag('profile', artifactManifest.profilePath);
const bundlePath = flag('bundle', artifactManifest.bundlePath);
const corpusPath = flag('corpus', payloadPath('corpus'));
const embPath = flag('emb', payloadPath('embeddings'));

if (!profilePath || !bundlePath || !corpusPath || !embPath) {
  console.error('artifact manifest must resolve profile/bundle/corpus/embeddings paths');
  exit(2);
}

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
if (!profile.hiddenPack) {
  console.error('[parity-harness] profile.hiddenPack missing; refusing to run a non-production pack');
  exit(1);
}
const profileFileHash = shaFile(profilePath);
const profileHash = '0x' + createHash('sha256').update(canonicalJson(profile)).digest('hex');

console.log(`[parity-harness] reranker=${rerankerMode} innerBatch=${innerBatch}${maxQueries ? ` maxQueries=${maxQueries} (SMOKE)` : ''}`);
// The materialized artifact lives alongside the bundle's calibration dir, NOT the loader default
// (release/calibration/2026-05-21-...). Resolve it from the bundle path's directory, matching
// recalibrate-baseline's `<base>/materialized` convention. Override with --materialized-root or
// CORETEX_MATERIALIZED_ROOT.
const materializedRoot = flag('materialized-root', env.CORETEX_MATERIALIZED_ROOT
  ?? `${dirname(bundlePath)}/materialized`);
console.log(`[parity-harness] loading materialized launch corpus (NO rebuild) from ${materializedRoot} ...`);
const loaded = loadMaterializedCorpus(bundlePath, {
  sourceCorpusPath: corpusPath,
  sourceEmbPath: embPath,
  materializedRoot,
});
const { corpus, BE, RR, LAYOUT, manifest: matManifest } = loaded;
console.log(`[parity-harness] corpusRoot=${corpus.corpusRoot} events=${corpus.events.length} bundleHash=${matManifest.bundleHash}`);

// ─── Reranker (instrumented; --inner-batch governs backend batch size) ───────
const rawReranker = (rerankerMode === 'gpu' || rerankerMode === 'qwen-cpu')
  ? makeStreamReranker({
    model: RR.modelId,
    revision: RR.revision,
    python: env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3',
    allowCuda: rerankerMode === 'gpu',
  })
  : await createDeterministicReranker();

const reranker = makeInstrumentedReranker({
  reranker: rawReranker,
  modelId: RR.modelId,
  revision: RR.revision,
  profileHash,
  substrateMode: profile.pipelineVersion ?? 'unknown',
  memoryIRVersion: profile.memoryIRSchemaVersion ?? 'raw',
  cachePath: null,
  mode: rerankerMode,
  batchSize: Number(innerBatch),
});

const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
// exposeFullRanking is left OFF — finalRankingTop20 (always present) carries the top-N ordering
// the compare step gates on; the full list would bloat the artifact at 300k scale.
const opts = scoringOptionsFromProfile(profile, {
  biEncoder: inertBiEncoder(BE, LAYOUT),
  reranker,
  biEncoderHash,
  retrievalKeyLayout: LAYOUT,
});

// ─── Threshold + acceptance floors (production-faithful) ─────────────────────
const screenerThresholdPpm = Number(computeCoreTexScreenerThresholdPpm({
  baselineScorePpm: profile.baselineParentScorePpm,
  policy: DEFAULT_CORETEX_WORK_POLICY,
}));
const acceptanceFloors = {
  ...profile.patchAcceptanceFloors,
  acceptanceThresholdPpm: screenerThresholdPpm,
};
const replayTolerancePpm = Number(profile.replayTolerancePpm ?? 0);

// ─── Pack derivation ─────────────────────────────────────────────────────────
// The hidden-pack quota profile (production), optionally subset for the smoke ONLY.
function packProfile() {
  const base = hiddenPackProfileFromEvaluatorProfile(profile);
  if (maxQueries) {
    // SMOKE ONLY: clear quotas + shrink packSize so the deterministic reranker finishes fast.
    return { packSize: Math.min(Number(maxQueries), base.packSize), quotas: [] };
  }
  return base;
}

const EMPTY_STATE = { words: new Array(RANGES.WORD_COUNT ?? 1024).fill(0n) };
const PARENT_ROOT = bytesToHex(C.merkleizeState(EMPTY_STATE)).toLowerCase();

// The production gate/confirm seeds are derived from the FIXED receipt (anti-pre-testing).
// We mirror that derivation here so scenarios 2/3 score the SAME packs runPerPatchEvaluation
// scores in scenarios 4/5 — making the dual-pack path and the direct path consistent.
function seedInputForPatch(patchBytes) {
  return {
    epochSecret: '0x' + '5e'.repeat(32),  // FIXED epoch secret (not revealed on-chain in this harness)
    blockhash: FIXED.receipt.blockhash,
    epochId: FIXED.epochId,
    patchHash: computePatchHash(patchBytes),
    parentRoot: PARENT_ROOT,
    corpusRoot: corpus.corpusRoot,
    bundleHash: matManifest.bundleHash,
  };
}

// Per-query ranking + metric extraction for a CompositeScore.
const TOP_K = Number(flag('top-k', '16'));
function perQueryView(composite) {
  return composite.perQuery.map((q) => ({
    recordId: q.recordId,
    family: q.family,
    nDCG10: q.nDCG10,
    mrr10: q.mrr10,
    recall10: q.recall10,
    top1Score: q.top1Score,
    // top-K reranked candidate ordering (doc ids + scores) — the ranking-level parity signal.
    top: (q.finalRankingTop20 ?? []).slice(0, TOP_K).map((r) => ({
      docId: r.docId,
      rank: r.rank,
      rerankerScore: r.rerankerScore,
      finalReorderingScore: r.finalReorderingScore,
      relevance: r.relevance,
    })),
  }));
}

function compositeSummary(composite) {
  return {
    composite: composite.composite,
    compositePpm: Math.round(composite.composite * 1_000_000),
    nDCG10: composite.nDCG10,
    mrr10: composite.mrr10,
    recall10: composite.recall10,
    temporal: composite.temporal,
    multiHopRecall10: composite.multiHopRecall10,
    abstention: composite.abstention,
    structuralValidity: composite.structuralValidity,
    queryCount: composite.perQuery.length,
  };
}

// ─── Fixed in-memory BaseRpcClient (no chain; byte-identical seeds across runs) ─
const fixedRpcClient = {
  async getLatestBlockNumber() { return FIXED.receipt.receivedAtBlock; },
  async getBlockHash() { return FIXED.receipt.blockhash; },
  async waitForBlock(blockNumber) {
    return { number: blockNumber, blockhash: FIXED.receipt.blockhash, timestamp: 1_700_000_000 };
  },
};

// ─── Patch construction (FIXED bytes; identical across cpu/gpu) ──────────────
// Honest relation patch: 4 canonical category-lens edges. Public, query-conditioned-free, and
// fully deterministic — the same bytes every run. (relationUnits is the launch-validated lever.)
function honestRelationPatch() {
  return makePatch(EMPTY_STATE, relationUnits(4));
}
// Garbage patch: a single MemoryIndex slot anchored to a record id that does not exist in the
// corpus. Structurally valid (applies + gets scored) but useless — does not improve retrieval,
// so it rejects on the acceptance floor / threshold. Fixed bytes every run.
function garbagePatch() {
  const word = encodeMemoryIndexSlot({
    slotIndex: FIXED.garbageMemorySlot,
    recordId: stableRecordIdFor(FIXED.garbageRecordSeed),
    family: 'temporal', domainBits: 1n,
    valid: true, revoked: false, protected: false, policyAnchor: true,
    retrievalSlot: 0, expiryEpoch: 0n,
  })[0];
  return makePatch(EMPTY_STATE, { indices: [RANGES.MEMORY_INDEX_START + FIXED.garbageMemorySlot], newWords: [word] });
}

// ─── Scenario runners ────────────────────────────────────────────────────────
const scenarios = {};

async function runBaseline() {
  reranker.resetTrace();
  const pack = deriveQueryPack(FIXED.epochId, FIXED.evalSeedHex, corpus, packProfile());
  const t0 = Date.now();
  const score = await evaluateRetrievalBenchmarkState(EMPTY_STATE, corpus, pack, opts);
  return {
    name: 'baseline',
    packs: { baseline: { queryPackRoot: queryPackRoot(pack), packSize: pack.events.length } },
    composite: compositeSummary(score),
    deltaPpm: null,
    accepted: null,
    rejectionReason: null,
    perQuery: perQueryView(score),
    ...reranker.traceSnapshot(),
    elapsedSec: (Date.now() - t0) / 1000,
  };
}

// Score a patch on a single pack via evaluateRetrievalBenchmarkPatch (gate or confirm).
async function scorePatchOnPack(patch, evalSeed) {
  const pack = deriveQueryPack(FIXED.epochId, evalSeed, corpus, packProfile());
  const result = await evaluateRetrievalBenchmarkPatch(EMPTY_STATE, patch, corpus, pack, opts, acceptanceFloors);
  return { pack, result };
}

async function runGateOnly() {
  reranker.resetTrace();
  // The garbage patch fails the gate -> short-circuit (no confirm pack scored).
  const patch = garbagePatch();
  const patchBytes = encodePatch(patch);
  const seed = seedInputForPatch(patchBytes);
  const gateSeed = deriveGateEvalSeed(seed);
  const t0 = Date.now();
  const { pack, result } = await scorePatchOnPack(patch, gateSeed);
  const accepted = result.accepted && result.deltaPpm >= screenerThresholdPpm;
  return {
    name: 'gate-only',
    patch: { kind: 'garbage_nonexistent_memindex', patchBytesHex: u8ToHex(patchBytes), patchHash: computePatchHash(patchBytes).toLowerCase(), wordCount: patch.wordCount },
    packs: { gate: { queryPackRoot: queryPackRoot(pack), packSize: pack.events.length, evalSeed: gateSeed } },
    composite: compositeSummary(result.after),
    deltaPpm: result.deltaPpm,
    accepted,
    rejectionReason: accepted ? null : (result.reason ?? (result.deltaPpm < screenerThresholdPpm ? 'gate-below-threshold' : 'gate-acceptance-floor')),
    thresholdPpm: screenerThresholdPpm,
    perFamilyDelta: result.perFamilyDelta,
    perQuery: perQueryView(result.after),
    ...reranker.traceSnapshot(),
    elapsedSec: (Date.now() - t0) / 1000,
  };
}

async function runDualPack() {
  reranker.resetTrace();
  // The honest relation patch passes the gate and runs confirm -> both packs scored.
  const patch = honestRelationPatch();
  const patchBytes = encodePatch(patch);
  const seed = seedInputForPatch(patchBytes);
  const gateSeed = deriveGateEvalSeed(seed);
  const confirmSeed = deriveConfirmEvalSeed(seed);
  const t0 = Date.now();
  const gate = await scorePatchOnPack(patch, gateSeed);
  const confirm = await scorePatchOnPack(patch, confirmSeed);
  const gatePass = gate.result.accepted && gate.result.deltaPpm >= screenerThresholdPpm;
  const confirmPass = confirm.result.accepted && confirm.result.deltaPpm >= screenerThresholdPpm;
  const accepted = gatePass && confirmPass;
  return {
    name: 'dual-pack',
    patch: { kind: 'honest_relation_lens_4edge', patchBytesHex: u8ToHex(patchBytes), patchHash: computePatchHash(patchBytes).toLowerCase(), wordCount: patch.wordCount },
    packs: {
      gate: { queryPackRoot: queryPackRoot(gate.pack), packSize: gate.pack.events.length, evalSeed: gateSeed },
      confirm: { queryPackRoot: queryPackRoot(confirm.pack), packSize: confirm.pack.events.length, evalSeed: confirmSeed },
    },
    composite: { gate: compositeSummary(gate.result.after), confirm: compositeSummary(confirm.result.after) },
    deltaPpm: { gate: gate.result.deltaPpm, confirm: confirm.result.deltaPpm, min: Math.min(gate.result.deltaPpm, confirm.result.deltaPpm) },
    accepted,
    rejectionReason: accepted ? null : (!gatePass ? (gate.result.reason ?? 'gate-below-threshold') : (confirm.result.reason ?? 'confirm-below-threshold')),
    thresholdPpm: screenerThresholdPpm,
    perFamilyDelta: { gate: gate.result.perFamilyDelta, confirm: confirm.result.perFamilyDelta },
    perQuery: { gate: perQueryView(gate.result.after), confirm: perQueryView(confirm.result.after) },
    ...reranker.traceSnapshot(),
    elapsedSec: (Date.now() - t0) / 1000,
  };
}

// Build the scorer runPerPatchEvaluation injects — binds the real benchmark over the fixed packs.
function makePerPatchScorer(perSeedSink) {
  return async ({ normalizedPatchBytes, evalSeed }) => {
    const patch = decodePatch(normalizedPatchBytes);
    const pack = deriveQueryPack(FIXED.epochId, evalSeed, corpus, packProfile());
    const result = await evaluateRetrievalBenchmarkPatch(EMPTY_STATE, patch, corpus, pack, opts, acceptanceFloors);
    perSeedSink.set(evalSeed.toLowerCase(), { pack, result });
    const score = { scorePpm: result.deltaPpm, accepted: result.accepted };
    return result.reason ? { ...score, rejectionReason: result.reason } : score;
  };
}

const FIXED_EPOCH_SECRET = '0x' + '5e'.repeat(32);
const hiddenSeedCommit = bytesToHex(keccak256(Buffer.from(FIXED_EPOCH_SECRET.slice(2), 'hex'))).toLowerCase();

async function runPerPatch(name, patch, patchKind) {
  reranker.resetTrace();
  const patchBytes = encodePatch(patch);
  const patchHash = computePatchHash(patchBytes).toLowerCase();
  const perSeed = new Map();
  const t0 = Date.now();
  const receipt = await runPerPatchEvaluation({
    normalizedPatchBytes: patchBytes,
    parentRoot: PARENT_ROOT,
    minerAddress: FIXED.receipt.minerAddress,
    epochId: FIXED.epochId,
    structurallyValid: true,
  }, {
    rpcClient: fixedRpcClient,
    scorer: makePerPatchScorer(perSeed),
    targetBlockOffset: FIXED.receipt.targetBlockOffset,
    thresholdPpm: screenerThresholdPpm,
    perMinerCap: 1024,
    epochSecret: FIXED_EPOCH_SECRET,
    corpusRoot: corpus.corpusRoot,
    bundleHash: matManifest.bundleHash,
    dedupCache: new Map(),
    minerAdmissions: new Map(),
  });

  // Build the canonical post-reveal eval-report artifact for an ACCEPTED receipt (scenario 4);
  // for a rejected receipt (scenario 5) the canonical artifact is not built (the production path
  // only commits an artifact on accept), so we report artifactHash=null + the reject reason.
  let artifact = null, artifactHash = null;
  if (receipt.accepted) {
    artifact = buildPostRevealEvalReportArtifact({
      version: 'coretex-post-reveal-eval-report-v1',
      epochId: FIXED.epochId,
      minerAddress: FIXED.receipt.minerAddress,
      outcome: 'SCREENER_PASS',
      compactPatchBytesHex: u8ToHex(patchBytes).toLowerCase(),
      thresholdPpm: screenerThresholdPpm,
      seedDerivation: {
        mode: 'future_blockhash_dual_pack',
        epochId: FIXED.epochId,
        receivedAtBlock: receipt.receivedAtBlock,
        targetBlock: receipt.targetBlock,
        targetBlockOffset: FIXED.receipt.targetBlockOffset,
        blockhash: receipt.blockhash.toLowerCase(),
        patchHash,
        parentStateRoot: PARENT_ROOT,
        corpusRoot: corpus.corpusRoot.toLowerCase(),
        bundleHash: matManifest.bundleHash.toLowerCase(),
      },
      receipt,
      context: {
        parentStateRoot: PARENT_ROOT,
        corpusRoot: corpus.corpusRoot.toLowerCase(),
        coreVersionHash: matManifest.bundleHash.toLowerCase(),
        hiddenSeedCommit,
        replayTolerancePpm,
      },
    });
    artifactHash = artifact.artifactHash;
    // Cross-check the builder hash against the recompute (the compare step also recomputes).
    const recomputed = hashPostRevealEvalReportArtifact(artifact);
    if (recomputed !== artifactHash) throw new Error(`[parity-harness] artifact hash self-check failed: ${recomputed} != ${artifactHash}`);
  }

  const gateScored = perSeed.get(receipt.gateSeed.toLowerCase());
  const confirmScored = perSeed.get(receipt.confirmSeed.toLowerCase());
  return {
    name,
    patch: { kind: patchKind, patchBytesHex: u8ToHex(patchBytes), patchHash, wordCount: patch.wordCount },
    receipt: {
      patchHash: receipt.patchHash,
      dedupKey: receipt.dedupKey,
      parentRoot: receipt.parentRoot,
      minerAddress: receipt.minerAddress,
      epochId: receipt.epochId,
      receivedAtBlock: receipt.receivedAtBlock,
      targetBlock: receipt.targetBlock,
      blockhash: receipt.blockhash,
      gateSeed: receipt.gateSeed,
      confirmSeed: receipt.confirmSeed,
      gateScorePpm: receipt.gateScorePpm,
      confirmScorePpm: receipt.confirmScorePpm,
      accepted: receipt.accepted,
      rejectionReason: receipt.rejectionReason ?? null,
    },
    packs: {
      ...(gateScored ? { gate: { queryPackRoot: queryPackRoot(gateScored.pack), packSize: gateScored.pack.events.length, evalSeed: receipt.gateSeed } } : {}),
      ...(confirmScored ? { confirm: { queryPackRoot: queryPackRoot(confirmScored.pack), packSize: confirmScored.pack.events.length, evalSeed: receipt.confirmSeed } } : {}),
    },
    deltaPpm: { gate: receipt.gateScorePpm, confirm: receipt.confirmScorePpm, min: Math.min(receipt.gateScorePpm, receipt.confirmScorePpm) },
    accepted: receipt.accepted,
    rejectionReason: receipt.rejectionReason ?? null,
    thresholdPpm: screenerThresholdPpm,
    artifactHash,
    artifact,
    composite: {
      ...(gateScored ? { gate: compositeSummary(gateScored.result.after) } : {}),
      ...(confirmScored ? { confirm: compositeSummary(confirmScored.result.after) } : {}),
    },
    perQuery: {
      ...(gateScored ? { gate: perQueryView(gateScored.result.after) } : {}),
      ...(confirmScored ? { confirm: perQueryView(confirmScored.result.after) } : {}),
    },
    ...reranker.traceSnapshot(),
    elapsedSec: (Date.now() - t0) / 1000,
  };
}

// ─── Run selected scenarios ──────────────────────────────────────────────────
const started = Date.now();
if (scenarioFilter.includes('baseline')) { console.log('[parity-harness] scenario: baseline'); scenarios.baseline = await runBaseline(); }
if (scenarioFilter.includes('gate-only')) { console.log('[parity-harness] scenario: gate-only'); scenarios['gate-only'] = await runGateOnly(); }
if (scenarioFilter.includes('dual-pack')) { console.log('[parity-harness] scenario: dual-pack'); scenarios['dual-pack'] = await runDualPack(); }
if (scenarioFilter.includes('accepted-patch')) { console.log('[parity-harness] scenario: accepted-patch'); scenarios['accepted-patch'] = await runPerPatch('accepted-patch', honestRelationPatch(), 'honest_relation_lens_4edge'); }
if (scenarioFilter.includes('rejected-patch')) { console.log('[parity-harness] scenario: rejected-patch'); scenarios['rejected-patch'] = await runPerPatch('rejected-patch', garbagePatch(), 'garbage_nonexistent_memindex'); }

// ─── Run context (compare step asserts these match across runs) ──────────────
const runContext = {
  // rerankerMode (qwen-cpu|gpu|deterministic) — the compare step hard-fails 'deterministic' so a
  // real parity run cannot be a smoke. maxQueriesUsed is true iff --max-queries was passed (the
  // hidden-pack quotas were cleared + the pack subset), which the compare step also hard-fails.
  rerankerMode,
  maxQueriesUsed: Boolean(maxQueries),
  bundleHash: matManifest.bundleHash,
  profileHash,
  profileFileHash,
  corpusRoot: corpus.corpusRoot,
  eventCount: corpus.events.length,
  modelRevision: RR.revision,
  modelId: RR.modelId,
  biEncoderModelId: BE.modelId,
  biEncoderRevision: BE.revision,
  // Prompt-template hash if available (instrumented reranker / profile expose it where present).
  promptTemplateHash: profile.rerankerPromptTemplateHash ?? null,
  maxSeqLen: profile.rerankerMaxSeqLen ?? profile.maxSeqLen ?? null,
  topK: TOP_K,
  rerankerInputTopK: profile.rerankerInputTopK ?? null,
  packSize: packProfile().packSize,
  hiddenPackQuotasCleared: Boolean(maxQueries),
  screenerThresholdPpm,
  replayTolerancePpm,
  fixedSeedInputs: {
    epochId: FIXED.epochId,
    evalSeedHex: FIXED.evalSeedHex,
    epochSecretCommit: hiddenSeedCommit,
    receipt: FIXED.receipt,
    garbageMemorySlot: FIXED.garbageMemorySlot,
    garbageRecordSeed: FIXED.garbageRecordSeed,
  },
};

const report = {
  schemaVersion: 'coretex.scorer-parity.v1',
  generatedAt: new Date().toISOString(),
  fidelity: rerankerMode === 'gpu' ? 'PRODUCTION_RERANKER_GPU'
    : rerankerMode === 'qwen-cpu' ? 'PRODUCTION_RERANKER_CPU'
      : 'DETERMINISTIC_RERANKER_SMOKE',
  rerankerMode,
  smoke: Boolean(maxQueries),
  maxQueries: maxQueries ? Number(maxQueries) : null,
  provenance: calibrationProvenance({ bundlePath, corpusPath, embPath, profilePath, manifest: matManifest }),
  artifactManifest: { path: artifactManifestPath, hash: shaFile(artifactManifestPath) },
  runContext,
  scenarios,
  rerankerTelemetry: reranker.telemetrySnapshot(),
  modelStartupMs: reranker.modelStartupMs?.() ?? null,
  totalElapsedSec: (Date.now() - started) / 1000,
};

mkdirSync(dirname(resolve(repoRoot, reportPath)), { recursive: true });
writeFileSync(resolve(repoRoot, reportPath), JSON.stringify(report, null, 2) + '\n');
console.log(`[parity-harness] wrote ${reportPath}`);
console.log(`[parity-harness] scenarios=${Object.keys(scenarios).join(',')} elapsed=${report.totalElapsedSec.toFixed(1)}s telemetry.backendPairs=${report.rerankerTelemetry.backendPairs}`);
await reranker.close?.();
exit(0);
