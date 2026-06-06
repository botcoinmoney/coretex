#!/usr/bin/env node
/**
 * CANONICAL LIVE-EVOLVE LONG-HORIZON CHURN HARNESS (v2).
 *
 * Per epoch:
 *   1. evolveCorpusDelta(currentLogical, epoch, seed, churnFraction)
 *   2. embed addedDocs + addedQueries with pinned BGE-M3 (CPU)
 *   3. convert to production additions via same bridge as buildV2ProductionCorpus
 *      (mem_* train_visible + query events; splits via splitForRecord)
 *   4. delta = buildCorpusDelta({previousCorpus: currentProd, additions, removals: [], epoch, labelingProvenance})
 *   5. newProd = applyCorpusDelta(currentProd, delta);
 *      assert newProd.corpusRoot === delta.nextRoot
 *   6. frontier = makeLaunchFrontier(profile, newProd).stepEpoch(epoch, prevHonestAccepts, prevQualityAttempts)
 *      — CANONICAL: stepEpoch takes NUMERIC honest-accepts + quality-attempts (aggregate counters),
 *        NOT roots. The activeRoot + activeIds come from the snapshot.
 *   7. activePack  = events in pack ∩ frontier.activeIds (with hard assertion of subset)
 *      heldoutPack = events in pack \ frontier.activeIds (the reserve slice)
 *      idShuffledPack = activePack with truth-doc IDs permuted within pack (control)
 *   8. baseline recompute on corpusRootChanged OR activeRootChanged via real-Qwen
 *      evaluateRetrievalBenchmarkState(GENESIS, newProd, activePack, opts) — 4-arg canonical.
 *   9. honest mining: K patches per epoch, scored via evaluateRetrievalBenchmarkPatch.
 *      Each accepted honest patch contributes a structural fingerprint to operationReuseSet;
 *      operation_reuse_rate = #accepted-this-epoch-with-fingerprint-seen-prior / #accepted-this-epoch.
 *      prevHonestAccepts + prevQualityAttempts fed into NEXT epoch's stepEpoch.
 *  10. cross_frontier_lift = activeScoreThisEpoch - activeScorePrevEpoch (ppm)
 *      heldout_frontier_lift = heldoutScoreThisEpoch - heldoutScorePrevEpoch (ppm)
 *      doc_id_dependence = (activeScore - idShuffledActiveScore) / max(1, activeScore)
 *                          — high (~1) ⇒ scoring is real semantic match; low (~0) ⇒ ID-bound or broken eval
 *
 * Usage:
 *   node scripts/simulate-v2-live-evolve-long-horizon.mjs --reranker gpu
 *     --profile <p> --bundle <b> --corpus <c> --emb <e> --out <outdir> --tag <tag>
 *     [--epochs 12] [--churn-fraction 0.05] [--seed <s>] [--honest-per-epoch 3]
 *     [--random-probes 4] [--hillclimb-probes 2] [--pack-size 64] [--clear-pack-quotas]
 *     [--materialized-root release/calibration/.../materialized]
 *     [--mock-embeddings]   # CPU mechanics/report smoke only; A100 minis use real embeddings.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { createHash } from 'node:crypto';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { evolveCorpusDelta } from './lib/evolve-corpus.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { embedTexts } from './_embed-v2.mjs';
import { hseed, mulberry32, randomPatch, relationUnits, relationUnitsForEdges, temporalUnits, conflictUnits, abstentionUnits, atomAnchorUnits, evidenceBundleUnits, noiseSuppressionUnits, buildMemoryEventByDocId } from './lib/v2-patch-families.mjs';
import { baselineAtomHardness } from './lib/atom-hardness.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { makeInstrumentedReranker } from './lib/instrumented-reranker.mjs';
import { calibrationProvenance } from './lib/calibration-provenance.mjs';

const C = await import(distIndex);
const {
  RANGES, PATCH_TYPE,
  buildCorpusDelta, applyCorpusDelta, makeLaunchFrontier,
  splitForRecord, biEncoderModelIdHash,
  scoringOptionsFromProfile, deriveQueryPack,
  evaluateRetrievalBenchmarkState, evaluateRetrievalBenchmarkPatch,
  applyPatch,
  createDeterministicReranker,
  encodePolicyAtom, POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE,
  merkleizeState, decodeSubstrate, stableRecordIdFor,
  // CANONICAL: live-update logical-delta → production additions bridge. The harness used to
  // inline this 50-line mapping; it now lives in packages/cortex/src/corpus/logical-delta-bridge.ts.
  bridgeLogicalDeltaToProductionEvents,
} = C;

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const RERANKER = flag('reranker', 'gpu');
const PROFILE_PATH = flag('profile');
const BUNDLE_PATH = flag('bundle');
const CORPUS_PATH = flag('corpus');
const EMB_PATH = flag('emb');
const OUTDIR = flag('out');
const TAG = flag('tag', 'live-evolve');
const EPOCHS = Number(flag('epochs', '12'));
const CHURN_FRACTION = Number(flag('churn-fraction', '0.05'));
const SEED_OVERRIDE = flag('seed', null);
const HONEST_PER_EPOCH = Number(flag('honest-per-epoch', '3'));
const RANDOM_PROBES = Number(flag('random-probes', '4'));
const HILLCLIMB_PROBES = Number(flag('hillclimb-probes', '2'));
const PACK_SIZE = Number(flag('pack-size', '64'));
const LIVE_EVAL_PACK_LIMIT = Number(flag('live-eval-pack-limit', '32'));
const CLEAR_PACK_QUOTAS = has('clear-pack-quotas');
const MOCK_EMBEDDINGS = has('mock-embeddings');
const TRACE_DIAGNOSTICS = has('trace-diagnostics');
const ATOM_TRACE = has('atom-trace') || TRACE_DIAGNOSTICS;
const TRACE_LIMIT = Number(flag('trace-limit', '5'));
const ATOM_TRACE_LIMIT_PER_FAMILY = Number(flag('atom-trace-limit-per-family', '1'));
const DISABLE_QWEN_CACHE = has('disable-qwen-cache');
const MATERIALIZED_ROOT = flag('materialized-root', env.CORETEX_MATERIALIZED_ROOT ?? undefined);

if (!PROFILE_PATH || !BUNDLE_PATH || !CORPUS_PATH || !EMB_PATH || !OUTDIR) {
  console.error('HARD FAIL: --profile, --bundle, --corpus, --emb, --out required');
  exit(1);
}

mkdirSync(resolve(repoRoot, OUTDIR), { recursive: true });

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
const OLD_CORPUS_DAMAGE_TOLERANCE_PPM = Number(flag('old-corpus-damage-tolerance-ppm', String(profile.replayTolerancePpm ?? 250)));
const frontierSeed = SEED_OVERRIDE ?? profile.epochFrontier?.seed ?? 'coretex-launch-frontier';
console.log(`[live-evolve] profile=${PROFILE_PATH} bundle=${BUNDLE_PATH}`);
console.log(`[live-evolve] corpus=${CORPUS_PATH} epochs=${EPOCHS} churn=${CHURN_FRACTION} seed=${frontierSeed}`);
console.log(`[live-evolve] old-corpus damage tolerance=${OLD_CORPUS_DAMAGE_TOLERANCE_PPM}ppm`);

console.log('[live-evolve] loading materialized base production corpus (NO rebuild) ...');
const baseBundle = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH, ...(MATERIALIZED_ROOT ? { materializedRoot: MATERIALIZED_ROOT } : {}) });
let currentProd = baseBundle.corpus;
const { BE, RR, LAYOUT } = baseBundle;
const provenance = calibrationProvenance({
  bundlePath: BUNDLE_PATH,
  corpusPath: CORPUS_PATH,
  embPath: EMB_PATH,
  profilePath: PROFILE_PATH,
  manifest: baseBundle.manifest,
});
console.log(`[live-evolve] materialized manifest bundleHash=${baseBundle.manifest.bundleHash} corpusRoot=${baseBundle.manifest.corpusRoot.slice(0, 18)}…`);
const labelingProvenance = { modelId: RR.modelId, revision: RR.revision, runtime: 'coretex-retrieval-v2-policy-r5', batchHash: '0x' + '00'.repeat(32) };
console.log(`[live-evolve] base events=${currentProd.events.length} root=${currentProd.corpusRoot.slice(0, 18)}…`);
console.log(`[live-evolve] root leaf cache=${currentProd.corpusRootCache ? `present (${currentProd.corpusRootCache.eventCount} leaves)` : 'missing (full root recompute fallback)'}`);

let currentLogical = JSON.parse(readFileSync(resolve(repoRoot, CORPUS_PATH), 'utf8'));
const docTextById = new Map(currentLogical.docs.map((d) => [d.id, d]));

const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const memId = (id) => `mem_${id}`;
const bucket = (f) => f === 'temporal_update' ? 'temporal' : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance') ? 'multi_hop_relation' : f === 'conflict_lifecycle' ? 'conflict_lifecycle' : f === 'aspect_constraint' ? 'aspect_constraint' : f === 'coreference_resolution' ? 'coreference' : 'near_collision';

function int8Bytes(vec) {
  let m = 0; for (const v of vec) m = Math.max(m, Math.abs(v));
  const s = m > 0 ? m / 127 : 1;
  const o = new Uint8Array(4 + LAYOUT.dim);
  new DataView(o.buffer).setFloat32(0, s, false);
  for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / s); c = Math.max(-127, Math.min(127, c)); o[4 + i] = c & 0xff; }
  return o;
}
function mockVec(seed = 0) {
  const v = new Float32Array(LAYOUT.dim);
  for (let i = 0; i < LAYOUT.dim; i++) v[i] = Math.sin(i + seed * 131 + 7);
  return v;
}

const rawReranker = RERANKER === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const profileHash = '0x' + createHash('sha256').update(readFileSync(resolve(repoRoot, PROFILE_PATH))).digest('hex');
const qwenCachePath = DISABLE_QWEN_CACHE ? null : flag('qwen-cache', `${OUTDIR}/qwen-score-cache.jsonl`);
const reranker = makeInstrumentedReranker({
  reranker: rawReranker,
  modelId: RR.modelId,
  revision: RR.revision,
  profileHash,
  substrateMode: profile.pipelineVersion ?? 'unknown',
  memoryIRVersion: profile.memoryIRSchemaVersion ?? 'raw',
  cachePath: qwenCachePath,
  mode: RERANKER,
  batchSize: Number(env.RERANKER_INNER_BATCH ?? '8'),
});
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');

const evalSeedHex = profile.baselineEvalSeedHex ?? '0x' + 'a5'.repeat(32);
const hiddenPackProfile = CLEAR_PACK_QUOTAS ? { packSize: PACK_SIZE, quotas: [] } : { ...(profile.hiddenPack ?? { packSize: PACK_SIZE, quotas: [] }), packSize: PACK_SIZE };

function makeGenesisState() { return { words: new Array(1024).fill(0n) }; }
function rt() { return { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT }; }
function makeScoringTelemetry(label) {
  return { label, queryCount: 0, candidateCounts: [], rerankerInputTopK: [], totalQwenPairs: 0, candidateRenderingMs: 0, qwenScoringMs: 0, queryTotalMs: 0 };
}
function recordScoringTelemetry(t, e) {
  if (!t) return;
  t.queryCount++;
  t.candidateCounts.push(e.candidatePoolSize);
  t.rerankerInputTopK.push(e.rerankerInputTopK);
  t.totalQwenPairs += e.rerankerPairs;
  t.candidateRenderingMs += e.candidateRenderingMs;
  t.qwenScoringMs += e.rerankerScoringMs;
  t.queryTotalMs += e.queryTotalMs;
}
function quantile(xs, q) {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1))];
}
function summarizeScoringTelemetry(t) {
  if (!t) return null;
  return {
    label: t.label,
    queryCount: t.queryCount,
    candidateCount: {
      p50: quantile(t.candidateCounts, 0.5),
      p90: quantile(t.candidateCounts, 0.9),
      max: t.candidateCounts.length ? Math.max(...t.candidateCounts) : null,
    },
    rerankerInputTopK: {
      p50: quantile(t.rerankerInputTopK, 0.5),
      p90: quantile(t.rerankerInputTopK, 0.9),
      max: t.rerankerInputTopK.length ? Math.max(...t.rerankerInputTopK) : null,
    },
    totalQwenPairs: t.totalQwenPairs,
    candidateRenderingMs: t.candidateRenderingMs,
    qwenScoringMs: t.qwenScoringMs,
    queryTotalMs: t.queryTotalMs,
  };
}
// Build the policy entity registry from the logical corpus once; the launch profile
// signs the substrate grammar but does NOT carry the runtime registry (canonical:
// probe-conflict-state-malleability, probe-r5-relation-typed). Without this, the
// query-conditioned admission block at retrieval-benchmark.ts:927 is skipped and
// conflict / abstention PolicyAtoms only fire when their anchored doc happens to
// already be in first-stage candidates (the eventsInStage1 fallback), which fails
// reliably under mixed endurance — see CONFLICT_MIXED_ROOT_CAUSE.md.
function buildPolicyEntityRegistry(logical) {
  return (logical.entities ?? []).map((e) => ({
    id: e.id,
    names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()),
    roleAliases: (e.roleAliases ?? []).filter(Boolean).map((n) => String(n).toLowerCase()),
  }));
}
let policyEntityRegistryCached = buildPolicyEntityRegistry(currentLogical);
function optsForProd(telemetry = null, trace = false) {
  return {
    ...scoringOptionsFromProfile(profile, rt()),
    policyEntityRegistry: policyEntityRegistryCached,
    policyGenericEntityIds: ['e_universe'],
    ...(trace ? { exposeFullRanking: true, policyEmitTraces: true, exposeRenderedCandidates: true } : {}),
    ...(telemetry ? { scoringTelemetry: (e) => recordScoringTelemetry(telemetry, e) } : {}),
  };
}

async function evaluatePack(prod, pack, telemetry = null, trace = false) {
  const opts = optsForProd(telemetry, trace);
  const res = await evaluateRetrievalBenchmarkState(makeGenesisState(), prod, pack, opts);
  return { scorePpm: Math.round((res.compositeScore ?? res.composite ?? 0) * 1_000_000), score: res };
}
async function evaluateStateOnPack(state, prod, pack, telemetry = null, trace = false) {
  const opts = optsForProd(telemetry, trace);
  const res = await evaluateRetrievalBenchmarkState(state, prod, pack, opts);
  return { scorePpm: Math.round((res.compositeScore ?? res.composite ?? 0) * 1_000_000), score: res };
}
async function scoreOnPack(prod, pack, telemetry = null) {
  return (await evaluatePack(prod, pack, telemetry, false)).scorePpm;
}

function queryMap(score) {
  return new Map((score?.perQuery ?? []).map((q) => [q.recordId, q]));
}
function compareQueries(before, after) {
  const b = queryMap(before);
  const out = [];
  for (const q of after?.perQuery ?? []) {
    const prev = b.get(q.recordId);
    if (!prev) continue;
    out.push({ recordId: q.recordId, family: q.family, before: prev, after: q, deltaNdcg: q.nDCG10 - prev.nDCG10 });
  }
  return out;
}
function meanByFamily(score) {
  const buckets = new Map();
  for (const q of score?.perQuery ?? []) {
    const arr = buckets.get(q.family) ?? [];
    arr.push(q.nDCG10 ?? 0);
    buckets.set(q.family, arr);
  }
  return Object.fromEntries([...buckets.entries()].map(([family, vals]) => [family, vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)]));
}
function oldFamilyRegression(before, after, familyCatastrophicFloor) {
  const beforeByFamily = meanByFamily(before);
  const afterByFamily = meanByFamily(after);
  const regressions = [];
  for (const family of Object.keys(beforeByFamily)) {
    if (family === 'validity_atom' || family === 'scope_atom' || family === 'entity_resolution_atom') continue;
    const beforeVal = beforeByFamily[family] ?? 0;
    const afterVal = afterByFamily[family] ?? 0;
    if (beforeVal > 0 && afterVal < familyCatastrophicFloor * beforeVal) {
      regressions.push({ family, before: beforeVal, after: afterVal, floor: familyCatastrophicFloor });
    }
  }
  return regressions;
}
function worstQueryDelta(before, after) {
  const deltas = compareQueries(before, after).map((c) => c.deltaNdcg);
  return deltas.length ? Math.min(...deltas) : 0;
}
function stablePackForOldCorpusPair(pack, oldCorpus, newCorpus) {
  const excluded = [];
  const events = [];
  for (const ev of pack.events ?? []) {
    if (!oldCorpus.byId.has(ev.id) || !newCorpus.byId.has(ev.id)) {
      excluded.push(ev.id);
      continue;
    }
    events.push(oldCorpus.byId.get(ev.id) ?? ev);
  }
  return { pack: { ...pack, events }, excluded };
}
async function buildAcceptanceDecomposition({ parentState, candidateState, oldCorpus, newCorpus, oldPack, newPack, newBefore, newAfter, telemetry, oldBeforeEval = null }) {
  const oldBefore = oldBeforeEval ?? await evaluateStateOnPack(parentState, oldCorpus, oldPack, telemetry, false);
  const oldAfter = await evaluateStateOnPack(candidateState, oldCorpus, oldPack, telemetry, false);
  const oldCorpusOldStatePpm = oldBefore.scorePpm;
  const oldCorpusNewStatePpm = oldAfter.scorePpm;
  const newCorpusOldStatePpm = Math.round((newBefore.compositeScore ?? newBefore.composite ?? 0) * 1_000_000);
  const newCorpusNewStatePpm = Math.round((newAfter.compositeScore ?? newAfter.composite ?? 0) * 1_000_000);
  const oldCorpusDamagePpm = oldCorpusNewStatePpm - oldCorpusOldStatePpm;
  const corpusDriftPpm = newCorpusOldStatePpm - oldCorpusOldStatePpm;
  const patchRecoveryPpm = newCorpusNewStatePpm - newCorpusOldStatePpm;
  const netAfterRecoveryPpm = newCorpusNewStatePpm - oldCorpusOldStatePpm;
  const oldFamilyRegressions = oldFamilyRegression(
    oldBefore.score,
    oldAfter.score,
    profile.patchAcceptanceFloors?.familyCatastrophicFloor ?? 0.85,
  );
  const worstOldQueryDeltaNdcg = worstQueryDelta(oldBefore.score, oldAfter.score);
  const passesRecovery = patchRecoveryPpm > (baselineFloors.acceptanceThresholdPpm ?? baselineFloors.minImprovementPpm ?? 2500);
  const passesOldCorpusDamage = oldCorpusDamagePpm >= -OLD_CORPUS_DAMAGE_TOLERANCE_PPM;
  const passesOldFamilyRegression = oldFamilyRegressions.length === 0;
  const passesGoldDamage = worstOldQueryDeltaNdcg >= -(profile.patchAcceptanceFloors?.protectedRegressionFloor ?? 0.05);
  return {
    oldCorpusOldStatePpm,
    oldCorpusNewStatePpm,
    newCorpusOldStatePpm,
    newCorpusNewStatePpm,
    oldCorpusDamagePpm,
    corpusDriftPpm,
    patchRecoveryPpm,
    netAfterRecoveryPpm,
    oldCorpusPairQueryCount: oldPack.events.length,
    newCorpusPairQueryCount: newPack.events.length,
    worstOldQueryDeltaNdcg,
    oldFamilyRegressions,
    acceptanceComponents: {
      passesRecovery,
      passesOldCorpusDamage,
      passesOldFamilyRegression,
      passesGoldDamage,
    },
  };
}

async function cachedStateEval(cache, key, state, prod, pack, telemetry, trace = false) {
  const cacheKey = `${key}:${trace ? 'trace' : 'plain'}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const score = await evaluateStateOnPack(state, prod, pack, telemetry, trace);
  cache.set(cacheKey, score);
  return score;
}
function stableSample(items, n, seed) {
  const a = [...items];
  const rand = mulberry32(hseed(seed));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.max(0, n));
}
function docSnapshots(corpus, docIds) {
  const need = new Set([...docIds].filter(Boolean));
  const out = [];
  for (const ev of corpus.events) {
    const docs = [...(ev.truthDocuments ?? []), ...(ev.hardNegatives ?? []), ...(ev.negativeDocuments ?? [])];
    for (const d of docs) {
      if (!need.has(d.id)) continue;
      out.push({
        docId: d.id,
        eventId: ev.id,
        text: d.text,
        logicalFamily: ev.logicalFamily ?? ev.family ?? null,
        entityIds: ev.entityIds ?? [],
        isCurrent: d.isCurrent ?? null,
        isHardNegative: (ev.hardNegatives ?? []).some((x) => x.id === d.id),
        isTruthDocument: (ev.truthDocuments ?? []).some((x) => x.id === d.id),
      });
    }
  }
  return out;
}
function topK(q, k = 10) {
  return (q?.finalRankingTop20 ?? []).slice(0, k).map((r) => ({
    docId: r.docId,
    rank: r.rank,
    relevance: r.relevance,
    rerankerScore: r.rerankerScore,
    finalReorderingScore: r.finalReorderingScore,
    sources: r.sources,
    biCosine: r.biCosine,
    lensBonus: r.lensBonus,
    anchorBonus: r.anchorBonus,
    categoryLensBonus: r.categoryLensBonus,
    temporalBonus: r.temporalBonus,
  }));
}
function rankOfDoc(q, docId) {
  if (!q || !docId) return null;
  const hit = (q.finalRankingTop20 ?? []).find((r) => r.docId === docId);
  return hit?.rank ?? null;
}
const ATOM_CHURN_FAMILIES = new Set(['validity_atom', 'scope_atom', 'entity_resolution_atom']);
function targetDocDiagnostics({ targetDocId, before, after, pack, patch }) {
  if (!targetDocId) return null;
  const beforeById = queryMap(before);
  const afterById = queryMap(after);
  const truthMatches = [];
  const hardNegativeMatches = [];
  for (const ev of pack.events ?? []) {
    const isTruth = (ev.truthDocuments ?? []).some((d) => d.id === targetDocId)
      || (ev.qrels ?? []).some((q) => q.documentId === targetDocId && (q.relevance ?? 0) > 0);
    const isHardNegative = (ev.hardNegatives ?? []).some((d) => d.id === targetDocId);
    if (isTruth) truthMatches.push(ev);
    if (isHardNegative) hardNegativeMatches.push(ev);
  }
  const rows = truthMatches.slice(0, 8).map((ev) => {
    const beforeQ = beforeById.get(ev.id);
    const afterQ = afterById.get(ev.id);
    return {
      recordId: ev.id,
      family: ev.logicalFamily ?? ev.family ?? null,
      queryText: ev.queryText,
      beforeNdcg: beforeQ?.nDCG10 ?? null,
      afterNdcg: afterQ?.nDCG10 ?? null,
      deltaNdcg: beforeQ && afterQ ? afterQ.nDCG10 - beforeQ.nDCG10 : null,
      beforeTargetRankTop20: rankOfDoc(beforeQ, targetDocId),
      afterTargetRankTop20: rankOfDoc(afterQ, targetDocId),
      beforeTemporalRecordDriven: beforeQ?.temporalRecordDriven ?? false,
      afterTemporalRecordDriven: afterQ?.temporalRecordDriven ?? false,
      beforeMemoryIRDriven: beforeQ?.memoryIRDriven ?? false,
      afterMemoryIRDriven: afterQ?.memoryIRDriven ?? false,
      beforePolicyTraceDriven: beforeQ?.policyTraceDriven ?? false,
      afterPolicyTraceDriven: afterQ?.policyTraceDriven ?? false,
      beforeTopK: topK(beforeQ, 5),
      afterTopK: topK(afterQ, 5),
    };
  });
  return {
    targetDocId,
    patchType: patch?.patchType ?? null,
    patchWordCount: patch?.wordCount ?? null,
    patchIndices: (patch?.indices ?? []).slice(0, 16),
    patchNewWordsHex: (patch?.newWords ?? []).slice(0, 16).map((w) => `0x${w.toString(16)}`),
    activeTruthQueryCount: truthMatches.length,
    activeHardNegativeQueryCount: hardNegativeMatches.length,
    activeTruthQueryIds: truthMatches.slice(0, 16).map((ev) => ev.id),
    activeHardNegativeQueryIds: hardNegativeMatches.slice(0, 16).map((ev) => ev.id),
    targetTruthQueries: rows,
  };
}
function applyHonestCursorUpdate(slotCursor, update) {
  if (!update) return null;
  if (update.temporalRecordDelta) slotCursor.temporalRecord += update.temporalRecordDelta;
  if (update.conflictSlotDelta) slotCursor.conflictSlot += update.conflictSlotDelta;
  if (update.abstentionSlotDelta) slotCursor.abstentionSlot += update.abstentionSlotDelta;
  if (update.scopeSlotDelta) slotCursor.scopeSlot += update.scopeSlotDelta;
  if (update.entitySlotDelta) slotCursor.entitySlot += update.entitySlotDelta;
  if (update.evidenceSlotDelta) slotCursor.evidenceSlot += update.evidenceSlotDelta;
  if (update.noiseSlotDelta) slotCursor.noiseSlot += update.noiseSlotDelta;
  if (update.relationCausalOffsetDelta) slotCursor.relationCausalOffset += update.relationCausalOffsetDelta;
  if (update.relationCausalAttemptDelta) slotCursor.relationCausalAttempt += update.relationCausalAttemptDelta;
  if (update.relationLifecycleOffsetDelta) slotCursor.relationLifecycleOffset += update.relationLifecycleOffsetDelta;
  if (update.relationLifecycleAttemptDelta) slotCursor.relationLifecycleAttempt += update.relationLifecycleAttemptDelta;
  if (update.coreferenceOffsetDelta) slotCursor.coreferenceOffset += update.coreferenceOffsetDelta;
  if (update.coreferenceAttemptDelta) slotCursor.coreferenceAttempt += update.coreferenceAttemptDelta;
  for (const id of update.addTemporalSkipDocs ?? []) if (id) slotCursor.temporalSkipDocs.add(id);
  for (const id of update.addValiditySkipDocs ?? []) if (id) slotCursor.validitySkipDocs.add(id);
  for (const id of update.addConflictSkipDocs ?? []) if (id) slotCursor.conflictSkipDocs.add(id);
  for (const id of update.addScopeSkipDocs ?? []) if (id) slotCursor.scopeSkipDocs.add(id);
  for (const id of update.addEntitySkipDocs ?? []) if (id) slotCursor.entitySkipDocs.add(id);
  for (const id of update.addEvidenceSkipDocs ?? []) if (id) slotCursor.evidenceSkipDocs.add(id);
  for (const id of update.addNoiseSkipDocs ?? []) if (id) slotCursor.noiseSkipDocs.add(id);
  return update;
}
function qrelDocId(q) {
  return q?.docId ?? q?.documentId ?? q?.id ?? null;
}
function relevantDocIds(ev) {
  const ids = new Set((ev.truthDocuments ?? []).map((d) => d.id).filter(Boolean));
  for (const q of ev.qrels ?? []) {
    const id = qrelDocId(q);
    if (id && (q.relevance ?? 0) > 0) ids.add(id);
  }
  return ids;
}
function hardNegativeDocIds(ev) {
  const ids = new Set((ev.hardNegatives ?? []).map((d) => qrelDocId(d)).filter(Boolean));
  for (const q of ev.qrels ?? []) {
    const id = qrelDocId(q);
    if (id && (q.relevance ?? 0) <= 0) ids.add(id);
  }
  return ids;
}
function rankRows(q, docIds) {
  return [...new Set([...docIds].filter(Boolean))].map((docId) => ({ docId, rank: rankOfDoc(q, docId) }));
}
function recordIdIndex(corpus) {
  const out = new Map();
  for (const ev of corpus.events ?? []) out.set(stableRecordIdFor(ev.id), ev);
  return out;
}
function decodedMemorySlotTrace(decoded, slot, byRecordId) {
  const mem = slot !== null && slot !== undefined ? decoded?.memoryIndex?.[slot] : null;
  if (!mem) return null;
  const ev = byRecordId.get(mem.recordId) ?? null;
  return {
    slot,
    recordId: mem.recordId,
    resolvedEventId: ev?.id ?? null,
    resolvedDocIds: (ev?.truthDocuments ?? []).map((d) => d.id),
    family: mem.family,
    revoked: mem.revoked,
    policyAnchor: mem.policyAnchor,
    retrievalSlot: mem.retrievalSlot,
  };
}
function buildDecodedAtomTrace({ hp, fpFamily, appliedState, corpus }) {
  if (!appliedState) return null;
  const decoded = decodeSubstrate(appliedState, { policyAtomsMode: true, biEncoderModelIdHash: biEncoderHash, retrievalKeyHeaderBytes: LAYOUT.headerBytes });
  const byRecordId = recordIdIndex(corpus);
  if (fpFamily === 'validity_atom' || hp.temporalRecordSlot !== undefined) {
    const rec = decoded.temporal.find((r) => r.recordIndex === hp.temporalRecordSlot) ?? null;
    return {
      decodeAttempts: decoded.decodeAttempts,
      decodeFailures: decoded.decodeFailures,
      temporalRecord: rec,
      staleMemoryIndex: rec ? decodedMemorySlotTrace(decoded, rec.memorySlot, byRecordId) : null,
      currentMemoryIndex: rec ? decodedMemorySlotTrace(decoded, rec.supersededBy, byRecordId) : null,
    };
  }
  const slots = fpFamily === 'entity_resolution_atom'
    ? (hp.entityResolutionAtomSlots ?? (hp.entityResolutionAtomSlot !== undefined ? [hp.entityResolutionAtomSlot] : []))
    : fpFamily === 'scope_atom'
      ? (hp.scopeAtomSlots ?? (hp.scopeAtomSlot !== undefined ? [hp.scopeAtomSlot] : []))
      : [];
  return {
    decodeAttempts: decoded.decodeAttempts,
    decodeFailures: decoded.decodeFailures,
    memoryIndex: slots.map((slot) => decodedMemorySlotTrace(decoded, slot, byRecordId)).filter(Boolean),
  };
}
function buildDecodedPatchTrace({ hp, appliedState, corpus }) {
  if (!appliedState) return null;
  const decoded = decodeSubstrate(appliedState, { policyAtomsMode: true, biEncoderModelIdHash: biEncoderHash, retrievalKeyHeaderBytes: LAYOUT.headerBytes });
  const byRecordId = recordIdIndex(corpus);
  const memorySlots = [
    hp.evidenceMemorySlot,
    hp.noiseMemorySlot,
    hp.temporalRecordSlot !== undefined ? hp.temporalRecordSlot * 2 : null,
    hp.temporalRecordSlot !== undefined ? hp.temporalRecordSlot * 2 + 1 : null,
    hp.conflictAtomSlot,
    hp.scopeAtomSlot,
    hp.entityResolutionAtomSlot,
    ...(hp.scopeAtomSlots ?? []),
    ...(hp.entityResolutionAtomSlots ?? []),
  ].filter((slot) => slot !== null && slot !== undefined);
  const atomSlots = [hp.evidenceAtomSlot, hp.noiseAtomSlot].filter((slot) => slot !== null && slot !== undefined);
  const lensOffsets = [];
  if (hp.relationLensOffset !== null && hp.relationLensOffset !== undefined) {
    for (let i = 0; i < (hp.relationLensEdges?.length ?? 1); i++) lensOffsets.push(127 - (hp.relationLensOffset + i));
  }
  return {
    decodeAttempts: decoded.decodeAttempts,
    decodeFailures: decoded.decodeFailures,
    memoryIndex: memorySlots.map((slot) => decodedMemorySlotTrace(decoded, slot, byRecordId)).filter(Boolean),
    evidenceBundleAtoms: decoded.evidenceBundleAtoms
      .filter((atom) => atomSlots.includes(atom.atomIndex))
      .map((atom) => ({ atomIndex: atom.atomIndex, selector: atom.selector, evidenceFeature: atom.evidenceFeature, action: atom.action, scope: atom.scope, targetSlot: atom.targetSlot, budget: atom.budget })),
    categoryLenses: decoded.categoryLenses
      .filter((lens) => lensOffsets.includes(lens.entryIndex))
      .map((lens) => ({ entryIndex: lens.entryIndex, edgeType: lens.edgeType, weight: lens.weight })),
  };
}
function atomTracePolicyReceipt(afterQ, fpFamily) {
  const traces = (afterQ?.policyTraces ?? []).filter((t) => t.atomFamily === fpFamily);
  return {
    policyTraceDriven: afterQ?.policyTraceDriven ?? false,
    policyTraces: traces,
    selectorPredicatesUsed: [...new Set(traces.flatMap((t) => t.selectorPredicatesUsed ?? t.scopePredicatesUsed ?? []))].sort(),
    admittedDocIds: [...new Set(traces.flatMap((t) => t.admittedDocIds ?? []))].sort(),
    admittedEventIds: [...new Set(traces.flatMap((t) => t.admittedEventIds ?? []))].sort(),
  };
}
function buildAtomTraceDiagnostics({ epoch, h, hp, fpFamily, pack, activeIds, corpus, appliedState, before, after }) {
  const targets = [...new Set((hp.atomMinedDocIds ?? [hp.targetDocId]).filter(Boolean))];
  const beforeById = queryMap(before);
  const afterById = queryMap(after);
  const rows = [];
  for (const ev of pack.events ?? []) {
    const positives = relevantDocIds(ev);
    const hardNegs = hardNegativeDocIds(ev);
    const selectedTargets = targets.filter((id) => positives.has(id));
    const selectedHardNegs = [...hardNegs];
    if (!selectedTargets.length && !selectedHardNegs.some((id) => targets.includes(id))) continue;
    const bq = beforeById.get(ev.id);
    const aq = afterById.get(ev.id);
    rows.push({
      queryId: ev.id,
      split: ev.split,
      family: ev.family,
      logicalFamily: ev.logicalFamily ?? ev.family ?? null,
      activeFrontierMember: activeIds.has(ev.id),
      activePackMember: true,
      queryText: ev.queryText,
      subjectEntityId: ev.subjectEntityId ?? null,
      publicIntent: ev.publicIntent ?? null,
      scope: ev.scope ?? null,
      selectedQrels: (ev.qrels ?? []).filter((q) => selectedTargets.includes(qrelDocId(q)) || selectedHardNegs.includes(qrelDocId(q))),
      selectedHardNegatives: (ev.hardNegatives ?? []).filter((n) => selectedHardNegs.includes(qrelDocId(n))),
      baselineTargetRanks: rankRows(bq, selectedTargets),
      baselineHardNegativeRanks: rankRows(bq, selectedHardNegs),
      afterTargetRanks: rankRows(aq, selectedTargets),
      afterHardNegativeRanks: rankRows(aq, selectedHardNegs),
      beforeTemporalRecordDriven: bq?.temporalRecordDriven ?? false,
      afterTemporalRecordDriven: aq?.temporalRecordDriven ?? false,
      beforePolicyTraceDriven: bq?.policyTraceDriven ?? false,
      afterPolicyTraceDriven: aq?.policyTraceDriven ?? false,
      beforeTop10: topK(bq, 10),
      afterTop10: topK(aq, 10),
      policyReceipt: atomTracePolicyReceipt(aq, fpFamily),
    });
  }
  return {
    epoch,
    patchIndex: h,
    atomFamily: fpFamily,
    generatedDocIds: targets,
    generatedQueryIds: rows.map((r) => r.queryId),
    activeFrontierMembershipAll: rows.every((r) => r.activeFrontierMember),
    activePackMembershipAll: rows.every((r) => r.activePackMember),
    patch: {
      indices: hp.patch?.indices ?? [],
      newWordsHex: (hp.patch?.newWords ?? []).map((w) => `0x${w.toString(16)}`),
      wordCount: hp.patch?.wordCount ?? null,
      patchType: hp.patch?.patchType ?? null,
    },
    decoded: buildDecodedAtomTrace({ hp, fpFamily, appliedState, corpus }),
    queryTraces: rows,
  };
}
function renderedTop(q, k = 10) {
  return (q?.renderedCandidatesTop20 ?? []).slice(0, k).map((r) => ({
    docId: r.docId,
    eventId: r.eventId,
    rank: r.rank,
    sources: r.sources,
    rawText: r.rawText,
    renderedText: r.renderedText,
  }));
}
function classifyTrace({ query, beforeQ, afterQ, activeImprovement }) {
  const deltaNdcg = (afterQ?.nDCG10 ?? 0) - (beforeQ?.nDCG10 ?? 0);
  const beforeTop = topK(beforeQ, 10);
  const afterTop = topK(afterQ, 10);
  const staleIds = new Set((query.truthDocuments ?? []).filter((d) => d.isCurrent === false).map((d) => d.id));
  const staleDropped = beforeTop.some((r) => staleIds.has(r.docId) && !afterTop.some((a) => a.docId === r.docId && a.rank <= r.rank));
  const junkTop = afterTop.filter((r) => r.relevance === 0);
  const routedJunk = junkTop.filter((r) => r.sources?.some((s) => s === 'categoryLensBFS' || s === 'anchorBFS' || s === 'policyAdmitted'));
  if (deltaNdcg === 0) return 'no_metric_change';
  if (deltaNdcg > 0) return 'metric_improvement';
  if ((query.logicalFamily ?? query.family) === 'temporal_update' || query.family === 'temporal') {
    if (staleDropped) return 'expected_stale_suppression';
  }
  if ((query.logicalFamily ?? query.family) === 'conflict_lifecycle' && (afterQ.policyTraces ?? []).some((t) => t.atomFamily === 'conflict_lifecycle')) {
    return 'expected_conflict_resolution';
  }
  if (routedJunk.length >= 3) return 'route_flooding';
  if (activeImprovement && activeImprovement.family !== afterQ.family) return 'off_family_damage';
  if (junkTop.length > 0) return 'pack_noise';
  if (activeImprovement) return 'active_focus_tradeoff';
  return 'unknown';
}
function buildTraceEntry({ epoch, h, patchProvenance, comparison, query, corpus, activeImprovement, kind }) {
  const beforeQ = comparison.before;
  const afterQ = comparison.after;
  const beforeIds = new Set(topK(beforeQ, 20).map((r) => r.docId));
  const afterIds = new Set(topK(afterQ, 20).map((r) => r.docId));
  const movedIds = new Set([
    ...beforeIds,
    ...afterIds,
    ...(query.qrels ?? []).map((q) => q.documentId),
    ...(query.truthDocuments ?? []).map((d) => d.id),
    patchProvenance?.targetDocId,
  ].filter(Boolean));
  return {
    kind,
    epoch,
    patchIndex: h,
    patchProvenance,
    activeQueryThatImproved: activeImprovement ? {
      recordId: activeImprovement.recordId,
      family: activeImprovement.family,
      deltaNdcg: activeImprovement.deltaNdcg,
      queryText: corpus.byId.get(activeImprovement.recordId)?.queryText ?? null,
    } : null,
    query: {
      recordId: query.id,
      queryText: query.queryText,
      logicalFamily: query.logicalFamily ?? query.family ?? null,
      family: query.family,
      subjectEntityId: query.subjectEntityId ?? null,
      ownerEntityId: query.ownerEntityId ?? null,
      qrels: query.qrels ?? [],
      truthDocuments: (query.truthDocuments ?? []).map((d) => ({ id: d.id, text: d.text, isCurrent: d.isCurrent ?? null })),
    },
    metricDelta: {
      nDCG10Before: beforeQ.nDCG10,
      nDCG10After: afterQ.nDCG10,
      deltaNdcg: comparison.deltaNdcg,
    },
    topKBefore: topK(beforeQ, 10),
    topKAfter: topK(afterQ, 10),
    renderedCandidatesBefore: renderedTop(beforeQ, 10),
    renderedCandidatesAfter: renderedTop(afterQ, 10),
    rerankerInputBefore: (beforeQ.rerankerInputCandidates ?? []).slice(0, 20).map((r) => ({ docId: r.docId, eventId: r.eventId, rank: r.rank, sources: r.sources, renderedText: r.renderedText })),
    rerankerInputAfter: (afterQ.rerankerInputCandidates ?? []).slice(0, 20).map((r) => ({ docId: r.docId, eventId: r.eventId, rank: r.rank, sources: r.sources, renderedText: r.renderedText })),
    substrateTraceLines: {
      beforePolicyTraces: beforeQ.policyTraces ?? [],
      afterPolicyTraces: afterQ.policyTraces ?? [],
    },
    documentSnapshots: docSnapshots(corpus, movedIds),
    explanationClassification: classifyTrace({ query, beforeQ, afterQ, activeImprovement }),
  };
}
function patchTraceProvenance(hp) {
  if (!hp) return null;
  return {
    fingerprint: hp.fingerprint ?? null,
    operationFingerprint: hp.operationFingerprint ?? null,
    selectorFingerprint: hp.selectorFingerprint ?? null,
    targetDocId: hp.targetDocId ?? null,
    targetDocIdRecordedOnly: hp.targetDocIdRecordedOnly ?? true,
  };
}

function filterPackToActive(pack, activeIds) {
  const events = pack.events.filter((e) => activeIds.has(e.id));
  return { ...pack, events };
}
function filterPackToHeldout(pack, activeIds) {
  const events = pack.events.filter((e) => !activeIds.has(e.id));
  return { ...pack, events };
}
function forceActiveLiveEvalEvents(pack, corpus, activeIds, limit = 32) {
  if (!limit || limit <= 0) return { pack, added: 0, liveEvalInPack: 0, familyCounts: {} };
  const existing = new Set(pack.events.map((e) => e.id));
  const alreadyLive = pack.events.filter((e) => activeIds.has(e.id)
    && e.split === 'eval_hidden'
    && e.id.startsWith('zz_e')
    && !e.id.includes('_mem_')).length;
  const familyPriority = new Map(HONEST_FAMILIES.map((f, i) => [f, i]));
  const familyOf = (e) => e.logicalFamily ?? e.family ?? 'unknown';
  const live = corpus.events
    .filter((e) => activeIds.has(e.id)
      && e.split === 'eval_hidden'
      && e.id.startsWith('zz_e')
      && !e.id.includes('_mem_')
      && !existing.has(e.id))
    .sort((a, b) => {
      const pa = familyPriority.get(familyOf(a)) ?? 999;
      const pb = familyPriority.get(familyOf(b)) ?? 999;
      if (pa !== pb) return pa - pb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .slice(0, limit);
  const finalEvents = live.length ? [...live, ...pack.events] : pack.events;
  const familyCounts = {};
  for (const e of finalEvents) {
    if (!(activeIds.has(e.id) && e.split === 'eval_hidden' && e.id.startsWith('zz_e') && !e.id.includes('_mem_'))) continue;
    const fam = familyOf(e);
    familyCounts[fam] = (familyCounts[fam] ?? 0) + 1;
  }
  if (!live.length) return { pack, added: 0, liveEvalInPack: alreadyLive, familyCounts };
  return { pack: { ...pack, events: finalEvents }, added: live.length, liveEvalInPack: alreadyLive + live.length, familyCounts };
}
function eventFamilyCounts(events) {
  const out = {};
  for (const e of events ?? []) {
    const fam = e.logicalFamily ?? e.family ?? 'unknown';
    out[fam] = (out[fam] ?? 0) + 1;
  }
  return out;
}
// Permuted-qrels control. Renamed/clarified: this probe MEASURES whether the evaluator
// uses qrels to compute nDCG (it does — that's by design). It DOES NOT measure whether
// the scorer depends on doc IDs vs text — the scorer's reranker is text-based, so a real
// ID-dependence probe would need to rename all mem_* event IDs and rewire references.
// Reported as `qrel_shuffle_collapse_ratio` going forward; the legacy `doc_id_dependence`
// field is kept for backward-compat with the v2 schema but marked DEPRECATED.
function buildIdShuffledPack(pack) {
  const ids = pack.events.flatMap((e) => (e.truthDocuments ?? []).map((t) => t.id));
  if (!ids.length) return pack;
  const shifted = ids.map((_, i) => ids[(i + Math.max(1, Math.floor(ids.length / 2))) % ids.length]);
  const map = new Map(ids.map((src, i) => [src, shifted[i]]));
  const events = pack.events.map((e) => ({
    ...e,
    truthDocuments: (e.truthDocuments ?? []).map((t) => ({ ...t, id: map.get(t.id) ?? t.id })),
    qrels: (e.qrels ?? []).map((q) => ({ ...q, documentId: map.get(q.documentId) ?? q.documentId })),
  }));
  return { ...pack, events };
}

// Honest patch generator: canonical category-lens relation patch (2 edges) — the SAME shape
// `honestPatch({family: 'relation', edgeCount: 2})` emits in v2-patch-families, the SAME shape
// the screener's true_state_advance class proved produces real retrieval lift on a representative
// pack without tripping cross-family floors. The earlier bare-1-word policy atom (no MemoryIndex
// anchor, no category-lens edges) had no substrate engaged and uniformly returned
// no_retrieval_improvement on every CPU smoke — the same root cause the screener fixed.
//
// 2 edges (not 4): 4 trips family_catastrophic:temporal on small/mixed packs at small scale.
// 2 edges gives a measurable lift on relation-family queries with low cross-family interference,
// matching the screener's verified pattern.
//
// Pack-derived target docId is recorded for provenance only. The patch body itself is
// anchor-free and doc-id-free: it encodes a reusable public relation category lens.
const GENESIS_PARENT_ROOT = merkleizeState({ words: new Array(1024).fill(0n) });

// ─── Honest mining: per-epoch patch generator across canonical promoted surfaces ───
// HONEST_FAMILIES is the cycle of operation fingerprints the endurance harness rotates
// per epoch. Each slot rolls a deterministic per-family cursor (see honestSlotCursor) so
// that successive patches occupy disjoint substrate slots and never collide. Surfaces:
//   - 'relation_causal'       : category-lens(supports, causes) — the original endurance fp.
//   - 'temporal_update'       : current/stale TemporalRecord + paired memory slots, mined from
//                               the pack via temporalUnits(...) (3 words).
//   - 'conflict_lifecycle'    : conflict_lifecycle PolicyAtom anchored at the resolved doc of
//                               the next conflict-pack query (2 words).
//   - 'relation_lifecycle'    : category-lens(supersedes, coreference_of) — disjoint from
//                               the causal fp so they coexist as separate operations.
//   - 'evidence_bundle'       : evidence_bundle PolicyAtom anchored to a relation evidence doc.
//   - 'coreference'           : category-lens(coreference_of), disjoint from lifecycle fp.
//   - 'noise_suppression'     : evidence_bundle suppress atom on a pack distractor / hard negative.
//   - 'abstention_top1'       : MISSING_EVIDENCE PolicyAtom (1 word; pack must contain at
//                               least one abstention_missing query).
//   - 'validity_atom'         : TemporalRecord over a validity_atom current/stale pair.
//   - 'scope_atom'            : policy-anchor MemoryIndex slot selected by public scope metadata.
//   - 'entity_resolution_atom': policy-anchor MemoryIndex slot selected by duplicate-name role metadata.
//
// Add fingerprints here by name; the loop below dispatches by switch. Each family records a
// distinct operationFingerprint and selectorFingerprint so per-fp accept/reject is auditable.
const HONEST_FAMILIES = (flag('honest-families', 'temporal_update,conflict_lifecycle,relation_causal,evidence_bundle,coreference,relation_lifecycle,noise_suppression,validity_atom,scope_atom,entity_resolution_atom,abstention_top1').split(',').map((s) => s.trim()).filter(Boolean));
function makeHonestSlotCursor() {
  return {
    temporalRecord: 0,          // TemporalRecord slot index (cap 96)
    temporalSkipDocs: new Set(), // mined temporal-current doc IDs
    validitySkipDocs: new Set(), // mined validity-current doc IDs
    conflictSlot: 96,           // POLICY_CONFLICT atom slot index (cap 128); disjoint from temporal memory slots
    conflictSkipDocs: new Set(), // anchored conflict doc IDs
    abstentionSlot: 0,          // POLICY_ABSTENTION slot index (cap 32)
    scopeSlot: 192,             // MemoryIndex policy-anchor slot for scope_atom
    scopeSkipDocs: new Set(),
    entitySlot: 128,            // MemoryIndex policy-anchor slot for entity_resolution_atom
    entitySkipDocs: new Set(),
    evidenceSlot: 224,          // MemoryIndex anchors 224..239, evidence atoms 0..15
    evidenceSkipDocs: new Set(),
    noiseSlot: 240,             // MemoryIndex anchors 240..255, evidence atoms 16..31
    noiseSkipDocs: new Set(),
    relationCausalOffset: 0,    // relation lens offsets 0..47
    relationCausalAttempt: 0,
    relationLifecycleOffset: 48,// relation lens offsets 48..79
    relationLifecycleAttempt: 0,
    coreferenceOffset: 80,      // relation lens offsets 80..95
    coreferenceAttempt: 0,
  };
}
function honestPatchForEpoch(epoch, honestIdx, family, ctx) {
  const { pack, logicalQById, eventByDocId, addedDocs, slotCursor } = ctx;
  const baseFingerprint = (op) => ({
    operationFingerprint: op,
    selectorFingerprint: ({
      'honest:relation_causal:supports,causes':                    'public-edge-category-lens:supports,causes',
      'honest:relation_causal:supports':                           'public-edge-category-lens:supports',
      'honest:relation_causal:causes':                             'public-edge-category-lens:causes',
      'honest:relation_lifecycle:supersedes,coreference_of':       'public-edge-category-lens:supersedes,coreference_of',
      'honest:relation_lifecycle:supersedes':                      'public-edge-category-lens:supersedes',
      'honest:relation_lifecycle:coreference_of':                  'public-edge-category-lens:coreference_of',
      'honest:coreference:coreference_of':                         'public-edge-category-lens:coreference_of',
      'honest:temporal:current_stale':                             'public-temporal-currentStale-pack-mined',
      'honest:conflict:CONFLICT_SET_MEMBER:boost':                 'public-policy-CONFLICT_SET_MEMBER:CONTRADICTS_EDGE:boost',
      'honest:evidence_bundle:RELATION_PATH_PRESENT:bundle':       'public-policy-RELATION_PATH_PRESENT:SUPPORT_IN_DEGREE:bundle',
      'honest:noise_suppression:ANSWER_DENSITY:suppress':          'public-policy-ANSWER_DENSITY:SUPPORT_IN_DEGREE:suppress',
      'honest:abstention:MISSING_EVIDENCE:NO_PUBLIC_EVIDENCE_PATH':'public-policy-MISSING_EVIDENCE:NO_PUBLIC_EVIDENCE_PATH:abstain',
      'honest:validity_atom:temporal_record':                     'public-validity-subject-attribute-currentStale-pack-mined',
      'honest:scope_atom:constrain':                               'public-scope-project-session-topic-task-selector',
      'honest:entity_resolution_atom:prefer':                      'public-entity-duplicate-name-role-alias-selector',
    })[op.replace(/:off\d+$/, '')] ?? op,
  });
  const target = addedDocs[honestIdx % Math.max(1, addedDocs.length)] ?? null;
  const makePatchFrom = (units, op, targetDocId, extra) => {
    // Pure PolicyAtom writes (abstention) MUST use POLICY_UPDATE per
    // policyWriteIsCanonicalForState: MIXED requires a MemoryIndex/Relation/Temporal
    // companion word, which a stand-alone abstention atom does not have.
    const allPolicyAbstention = units.indices.length > 0
      && units.indices.every((i) => i >= RANGES.POLICY_EVIDENCE_START && i <= RANGES.POLICY_ABSTENTION_END);
    const patchType = allPolicyAbstention ? PATCH_TYPE.POLICY_UPDATE : PATCH_TYPE.MIXED;
    return {
      patch: { patchType, wordCount: units.indices.length, scoreDelta: 0, parentStateRoot: GENESIS_PARENT_ROOT, indices: units.indices, newWords: units.newWords },
      fingerprint: `${op}:e${epoch}:h${honestIdx}`,
      ...baseFingerprint(op),
      targetDocId, family,
      ...(extra ?? {}),
    };
  };
  if (family === 'relation_causal') {
    const variants = [
      { edges: ['supports', 'causes'], name: 'supports,causes' },
      { edges: ['supports'], name: 'supports' },
      { edges: ['causes'], name: 'causes' },
    ];
    const v = variants[slotCursor.relationCausalAttempt % variants.length];
    const offset = slotCursor.relationCausalOffset;
    if (offset + v.edges.length > 48) {
      return { skipped: true, family, reason: 'relation_causal_entries_exhausted', fingerprint: `honest:relation_causal:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:relation_causal:entries_exhausted', selectorFingerprint: 'public-edge-category-lens:exhausted' };
    }
    const u = relationUnitsForEdges(v.edges, offset);
    return makePatchFrom(u, `honest:relation_causal:${v.name}:off${offset}`, target?.id ?? null, {
      relationLensOffset: offset,
      relationLensEdges: v.edges,
      cursorUpdate: { relationCausalOffsetDelta: v.edges.length, relationCausalAttemptDelta: 1 },
    });
  }
  if (family === 'relation_lifecycle') {
    const variants = [
      { edges: ['supersedes', 'coreference_of'], name: 'supersedes,coreference_of' },
      { edges: ['supersedes'], name: 'supersedes' },
      { edges: ['coreference_of'], name: 'coreference_of' },
    ];
    const v = variants[slotCursor.relationLifecycleAttempt % variants.length];
    const offset = slotCursor.relationLifecycleOffset;
    if (offset + v.edges.length > 80) {
      return { skipped: true, family, reason: 'relation_lifecycle_entries_exhausted', fingerprint: `honest:relation_lifecycle:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:relation_lifecycle:entries_exhausted', selectorFingerprint: 'public-edge-category-lens:exhausted' };
    }
    const u = relationUnitsForEdges(v.edges, offset);
    return makePatchFrom(u, `honest:relation_lifecycle:${v.name}:off${offset}`, target?.id ?? null, {
      relationLensOffset: offset,
      relationLensEdges: v.edges,
      cursorUpdate: { relationLifecycleOffsetDelta: v.edges.length, relationLifecycleAttemptDelta: 1 },
    });
  }
  if (family === 'coreference') {
    const offset = slotCursor.coreferenceOffset;
    if (offset >= 96) {
      return { skipped: true, family, reason: 'coreference_entries_exhausted', fingerprint: `honest:coreference:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:coreference:entries_exhausted', selectorFingerprint: 'public-edge-category-lens:exhausted' };
    }
    const u = relationUnitsForEdges(['coreference_of'], offset);
    return makePatchFrom(u, `honest:coreference:coreference_of:off${offset}`, target?.id ?? null, {
      relationLensOffset: offset,
      relationLensEdges: ['coreference_of'],
      cursorUpdate: { coreferenceOffsetDelta: 1, coreferenceAttemptDelta: 1 },
    });
  }
  if (family === 'temporal' || family === 'temporal_update') {
    const u = temporalUnits({ pack, logicalQById, recordSlot: slotCursor.temporalRecord, skipDocIds: slotCursor.temporalSkipDocs, eventByDocId });
    if (!u.indices.length || u.recordsCompiled === 0) {
      return { skipped: true, family, reason: u.reason ?? 'no_temporal_pack_query_available', fingerprint: `honest:temporal:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:temporal:current_stale', selectorFingerprint: 'public-temporal-currentStale-pack-mined' };
    }
    return makePatchFrom(u, 'honest:temporal:current_stale', u.minedDocId, {
      temporalRecordSlot: slotCursor.temporalRecord,
      cursorUpdate: { temporalRecordDelta: 1, addTemporalSkipDocs: [u.minedDocId] },
    });
  }
  if (family === 'validity_atom') {
    const u = temporalUnits({ pack, logicalQById, recordSlot: slotCursor.temporalRecord, skipDocIds: slotCursor.validitySkipDocs, eventByDocId, families: ['validity_atom'] });
    if (!u.indices.length || u.recordsCompiled === 0) {
      return { skipped: true, family, reason: u.reason ?? 'no_validity_atom_pack_query_available', fingerprint: `honest:validity_atom:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:validity_atom:temporal_record', selectorFingerprint: 'public-validity-subject-attribute-currentStale-pack-mined' };
    }
    return makePatchFrom(u, 'honest:validity_atom:temporal_record', u.minedDocId, {
      temporalRecordSlot: slotCursor.temporalRecord,
      cursorUpdate: { temporalRecordDelta: 1, addValiditySkipDocs: [u.minedDocId] },
    });
  }
  if (family === 'conflict' || family === 'conflict_lifecycle') {
    const u = conflictUnits({ pack, logicalQById, eventByDocId, conflictSlot: slotCursor.conflictSlot, action: 'boost', skipDocIds: slotCursor.conflictSkipDocs });
    if (!u.indices.length) {
      return { skipped: true, family, reason: u.reason ?? 'no_conflict_pack_query_available', fingerprint: `honest:conflict:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:conflict:CONFLICT_SET_MEMBER:boost', selectorFingerprint: 'public-policy-CONFLICT_SET_MEMBER:CONTRADICTS_EDGE:boost' };
    }
    return makePatchFrom(u, 'honest:conflict:CONFLICT_SET_MEMBER:boost', u.minedDocId, {
      conflictAtomSlot: u.slot,
      cursorUpdate: { conflictSlotDelta: 1, addConflictSkipDocs: [u.minedDocId] },
    });
  }
  if (family === 'evidence_bundle') {
    const u = evidenceBundleUnits({ pack, logicalQById, eventByDocId, memorySlot: slotCursor.evidenceSlot, skipDocIds: slotCursor.evidenceSkipDocs, action: 'bundle' });
    if (!u.indices.length) {
      return { skipped: true, family, reason: u.reason ?? 'no_evidence_bundle_pack_query_available', fingerprint: `honest:evidence_bundle:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:evidence_bundle:RELATION_PATH_PRESENT:bundle', selectorFingerprint: 'public-policy-RELATION_PATH_PRESENT:SUPPORT_IN_DEGREE:bundle' };
    }
    return makePatchFrom(u, 'honest:evidence_bundle:RELATION_PATH_PRESENT:bundle', u.minedDocId, {
      evidenceMemorySlot: u.memorySlot,
      evidenceAtomSlot: u.atomSlot,
      evidenceSourceQueryId: u.sourceQueryId,
      cursorUpdate: { evidenceSlotDelta: 1, addEvidenceSkipDocs: [u.minedDocId] },
    });
  }
  if (family === 'noise_suppression') {
    const u = noiseSuppressionUnits({ pack, logicalQById, eventByDocId, memorySlot: slotCursor.noiseSlot, skipDocIds: slotCursor.noiseSkipDocs });
    if (!u.indices.length) {
      return { skipped: true, family, reason: u.reason ?? 'no_noise_suppression_pack_query_available', fingerprint: `honest:noise_suppression:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:noise_suppression:ANSWER_DENSITY:suppress', selectorFingerprint: 'public-policy-ANSWER_DENSITY:SUPPORT_IN_DEGREE:suppress' };
    }
    return makePatchFrom(u, 'honest:noise_suppression:ANSWER_DENSITY:suppress', u.minedDocId, {
      noiseMemorySlot: u.memorySlot,
      noiseAtomSlot: u.atomSlot,
      noiseSourceQueryId: u.sourceQueryId,
      noiseCategory: u.noiseCategory,
      cursorUpdate: { noiseSlotDelta: 1, addNoiseSkipDocs: [u.minedDocId] },
    });
  }
  if (family === 'abstention' || family === 'abstention_top1') {
    const u = abstentionUnits({ pack, logicalQById, abstentionSlot: slotCursor.abstentionSlot });
    if (!u.indices.length) {
      return { skipped: true, family, reason: u.reason ?? 'no_abstention_pack_query_available', fingerprint: `honest:abstention:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:abstention:MISSING_EVIDENCE:NO_PUBLIC_EVIDENCE_PATH', selectorFingerprint: 'public-policy-MISSING_EVIDENCE:NO_PUBLIC_EVIDENCE_PATH:abstain' };
    }
    return makePatchFrom(u, 'honest:abstention:MISSING_EVIDENCE:NO_PUBLIC_EVIDENCE_PATH', null, {
      abstentionAtomSlot: u.slot,
      cursorUpdate: { abstentionSlotDelta: 1 },
    });
  }
  if (family === 'scope_atom') {
    const u = atomAnchorUnits({ pack, logicalQById, eventByDocId, atomFamily: 'scope_atom', memorySlot: slotCursor.scopeSlot, skipDocIds: slotCursor.scopeSkipDocs, maxRecords: 1 });
    if (!u.indices.length) {
      return { skipped: true, family, reason: u.reason ?? 'no_scope_atom_pack_query_available', fingerprint: `honest:scope_atom:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:scope_atom:constrain', selectorFingerprint: 'public-scope-project-session-topic-task-selector' };
    }
    return makePatchFrom(u, 'honest:scope_atom:constrain', u.minedDocId, {
      scopeAtomSlot: u.slot,
      scopeAtomSlots: u.slots ?? [u.slot],
      atomRecordsCompiled: u.recordsCompiled ?? 1,
      atomMinedDocIds: u.minedDocIds ?? [u.minedDocId],
      cursorUpdate: { scopeSlotDelta: u.recordsCompiled ?? 1, addScopeSkipDocs: u.minedDocIds ?? [u.minedDocId] },
    });
  }
  if (family === 'entity_resolution_atom') {
    const u = atomAnchorUnits({ pack, logicalQById, eventByDocId, atomFamily: 'entity_resolution_atom', memorySlot: slotCursor.entitySlot, skipDocIds: slotCursor.entitySkipDocs, maxRecords: 1 });
    if (!u.indices.length) {
      return { skipped: true, family, reason: u.reason ?? 'no_entity_resolution_atom_pack_query_available', fingerprint: `honest:entity_resolution_atom:skipped:e${epoch}:h${honestIdx}`, operationFingerprint: 'honest:entity_resolution_atom:prefer', selectorFingerprint: 'public-entity-duplicate-name-role-alias-selector' };
    }
    return makePatchFrom(u, 'honest:entity_resolution_atom:prefer', u.minedDocId, {
      entityResolutionAtomSlot: u.slot,
      entityResolutionAtomSlots: u.slots ?? [u.slot],
      atomRecordsCompiled: u.recordsCompiled ?? 1,
      atomMinedDocIds: u.minedDocIds ?? [u.minedDocId],
      cursorUpdate: { entitySlotDelta: u.recordsCompiled ?? 1, addEntitySkipDocs: u.minedDocIds ?? [u.minedDocId] },
    });
  }
  return { skipped: true, family, reason: `unknown_family:${family}`, fingerprint: `honest:unknown:${family}:e${epoch}:h${honestIdx}`, operationFingerprint: `honest:unknown:${family}`, selectorFingerprint: 'unknown' };
}

// ─── Genesis frontier (BUILD ONCE, step every epoch on the SAME instance) ───
// Build the frontier from the genesis corpus and call stepEpoch on the persisted instance,
// so C3 rotation observes the real accept/attempt history and reserveRemaining drains over
// time. Each epoch's evolveCorpusDelta-generated eval_hidden ids are then INJECTED into the
// frontier's reserve via frontier.addReserveIds(...) so live-update churn is exercised
// (new evals get priority — spliced in at reservePtr, drained before remaining genesis reserve).
const bucketFamily = (f) => f === 'temporal_update' ? 'temporal'
  : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance') ? 'multi_hop_relation'
  : f === 'conflict_lifecycle' ? 'conflict_lifecycle'
  : f === 'aspect_constraint' ? 'aspect_constraint'
  : f === 'coreference_resolution' ? 'coreference'
  : (f === 'validity_atom' || f === 'scope_atom' || f === 'entity_resolution_atom') ? f
  : 'near_collision';
const frontier = makeLaunchFrontier(profile, currentProd);
if (!frontier) {
  console.error('HARD FAIL: profile has no epochFrontier — cannot run live-evolve harness'); exit(1);
}
const fr0 = frontier.stepEpoch(0, null, null);
let prevActiveRoot = fr0.activeRoot;
let prevHonestAccepts = 0;
let prevQualityAttempts = 0;
console.log(`[live-evolve] genesis activeRoot=${prevActiveRoot.slice(0, 18)}… active=${fr0.activeIds.size}`);

// score genesis active + heldout
let basePack = deriveQueryPack(0, evalSeedHex, currentProd, hiddenPackProfile);
let prevActivePack = filterPackToActive(basePack, fr0.activeIds);
let prevHeldoutPack = filterPackToHeldout(basePack, fr0.activeIds);
// Hard subset assertion: every activePack id MUST be in frontier.activeIds.
for (const ev of prevActivePack.events) if (!fr0.activeIds.has(ev.id)) { console.error(`HARD FAIL: activePack contains id ${ev.id} not in frontier.activeIds`); exit(1); }

const genesisScoringTelemetry = makeScoringTelemetry('genesis');
const prevActiveEval = prevActivePack.events.length ? await evaluatePack(currentProd, prevActivePack, genesisScoringTelemetry, TRACE_DIAGNOSTICS) : null;
const prevHeldoutEval = prevHeldoutPack.events.length ? await evaluatePack(currentProd, prevHeldoutPack, genesisScoringTelemetry, TRACE_DIAGNOSTICS) : null;
let prevActiveScorePpm = prevActiveEval?.scorePpm ?? null;
let prevHeldoutScorePpm = prevHeldoutEval?.scorePpm ?? null;
let prevActiveDetailed = prevActiveEval?.score ?? null;
let prevHeldoutDetailed = prevHeldoutEval?.score ?? null;
console.log(`[live-evolve] genesis activeScore=${prevActiveScorePpm}ppm heldoutScore=${prevHeldoutScorePpm}ppm`);

const operationReuseSet = new Set();
const selectorReuseSet = new Set();
let acceptedOperationCount = 0;
let acceptedOperationReuseCount = 0;
let acceptedSelectorCount = 0;
let acceptedSelectorReuseCount = 0;
let bestState = makeGenesisState();
const perEpoch = [];
const baselineFloors = { ...profile.patchAcceptanceFloors, acceptanceThresholdPpm: profile.patchAcceptanceFloors?.minImprovementPpm ?? 2500 };
// Persistent slot cursor for mixed-fingerprint mining — keeps temporal/conflict/abstention
// slot indices monotonically advancing across epochs so successive patches occupy disjoint
// substrate regions and never collide. relation entries are placed at fixed offsets per
// fingerprint (relation_causal=0..1, relation_lifecycle=2..3).
const honestSlotCursor = makeHonestSlotCursor();
const atomTraceCounts = new Map();
// Per-epoch logical query/event-id maps refreshed after evolveCorpusDelta extends currentLogical.
let logicalQById = new Map(currentLogical.queries.map((q) => [q.id, q]));
const liveLogicalQByProductionId = new Map();
let eventByDocId = new Map();
eventByDocId = buildMemoryEventByDocId(currentProd);

function atomFamilyForFingerprint(fp) {
  if (!fp) return 'unknown';
  if (fp.includes('validity_atom')) return 'validity_atom';
  if (fp.includes('scope_atom')) return 'scope_atom';
  if (fp.includes('entity_resolution_atom')) return 'entity_resolution_atom';
  if (fp.includes('evidence_bundle')) return 'evidence_bundle';
  if (fp.includes('noise_suppression')) return 'noise_suppression';
  if (fp.includes('temporal')) return 'temporal_update';
  if (fp.includes('conflict')) return 'conflict_lifecycle';
  if (fp.includes('abstention')) return 'abstention_top1';
  if (fp.includes('relation_lifecycle')) return 'relation_lifecycle';
  if (fp.includes('relation_causal')) return 'relation_causal';
  if (fp.includes('honest:coreference')) return 'coreference';
  if (fp.includes('relation')) return 'relation_causal';
  return 'unknown';
}

for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  const epochStartMs = Date.now();
  const epochScoringTelemetry = makeScoringTelemetry(`epoch-${epoch}`);
  let lastMarkMs = epochStartMs;
  const timingsMs = {};
  const mark = (name) => {
    const now = Date.now();
    timingsMs[name] = now - lastMarkMs;
    lastMarkMs = now;
  };
  console.log(`\n[live-evolve] ===== EPOCH ${epoch} =====`);
  const ld = evolveCorpusDelta({ baseLogical: currentLogical, epoch, seed: frontierSeed, churnFraction: CHURN_FRACTION });
  mark('deltaGeneration');
  console.log(`[live-evolve] evolveCorpusDelta: +${ld.addedDocs.length} docs / +${ld.addedRelations.length} rels / +${ld.addedQueries.length} queries / churnRate=${ld.liveChurnRate.toFixed(4)}`);

  if (!ld.addedDocs.length) { console.warn(`[live-evolve] epoch ${epoch}: no churn signal at fraction=${CHURN_FRACTION}; skipping`); continue; }

  // CANONICAL: bridge the logical delta into production additions via
  // bridgeLogicalDeltaToProductionEvents (packages/cortex/src/corpus/logical-delta-bridge.ts).
  // The harness owns ONLY the Python embedding step; the package owns the mapping.
  const docVecs = MOCK_EMBEDDINGS
    ? ld.addedDocs.map((_, i) => mockVec(epoch * 1000 + i))
    : await embedTexts(ld.addedDocs.map((d) => d.text));
  const qVecs = MOCK_EMBEDDINGS
    ? ld.addedQueries.map((_, i) => mockVec(epoch * 2000 + i))
    : (ld.addedQueries.length ? await embedTexts(ld.addedQueries.map((q) => q.queryText)) : []);
  mark(MOCK_EMBEDDINGS ? 'mockEmbedding' : 'biEncoderEmbedding');
  for (const d of ld.addedDocs) docTextById.set(d.id, d);
  const addedDocEmbeddings = new Map();
  ld.addedDocs.forEach((d, i) => addedDocEmbeddings.set(d.id, int8Bytes(docVecs[i])));
  const addedQueryEmbeddings = new Map();
  ld.addedQueries.forEach((q, i) => addedQueryEmbeddings.set(q.id, int8Bytes(qVecs[i])));
  const additions = bridgeLogicalDeltaToProductionEvents({
    previousCorpus: currentProd,
    logicalDelta: ld,
    addedDocEmbeddings,
    addedQueryEmbeddings,
    biEncoder: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT },
  });
  const addedLogicalByKey = new Map(ld.addedQueries.map((q) => [`${q.family}\n${q.queryText}`, q]));
  for (const ev of additions) {
    if (ev.truthDocuments.length === 1 && ev.id.includes('_mem_')) continue;
    const q = addedLogicalByKey.get(`${ev.logicalFamily ?? ev.family}\n${ev.queryText}`);
    if (q) liveLogicalQByProductionId.set(ev.id, q);
  }
  mark('bridgeLogicalDelta');

  const rootCacheBefore = currentProd.corpusRootCache ?? null;
  const delta = buildCorpusDelta({ previousCorpus: currentProd, additions, removals: [], epoch, labelingProvenance, ...(rootCacheBefore ? { previousRootCache: rootCacheBefore } : {}) });
  mark('buildCorpusDeltaRoot');
  if (delta.previousRoot.toLowerCase() !== currentProd.corpusRoot.toLowerCase()) { console.error(`HARD FAIL: delta.previousRoot != currentProd.corpusRoot epoch=${epoch}`); exit(1); }
  const newProd = applyCorpusDelta(currentProd, delta, { ...(rootCacheBefore ? { rootCache: rootCacheBefore, attachRootCache: true } : {}) });
  mark('applyCorpusDeltaRoot');
  if (newProd.corpusRoot.toLowerCase() !== delta.nextRoot.toLowerCase()) { console.error(`HARD FAIL: applyCorpusDelta root mismatch epoch=${epoch}`); exit(1); }
  console.log(`[live-evolve] delta: ${delta.previousRoot.slice(0, 18)} → ${delta.nextRoot.slice(0, 18)} (+${delta.addedIds.length} events, rootCache=${rootCacheBefore ? 'yes' : 'no'})`);

  const corpusRootChanged = newProd.corpusRoot !== currentProd.corpusRoot;
  // INJECT new eval_hidden ids from this epoch's evolveCorpusDelta into frontier reserve
  // BEFORE stepping. New ids land at reservePtr → next activation drains live evals first.
  // ld.addedQueries are the new eval_hidden queries; the canonical query-event id is q.id.
  // Note: ALL evolveCorpusDelta-added queries get assigned a split via splitForRecord at
  // production-event build time; many will be eval_hidden. Filter to those whose canonical
  // split is eval_hidden using the same splitForRecord the bridge uses.
  const newEvalIds = additions.filter((ev) => ev.split === 'eval_hidden').map((ev) => ev.id);
  const newEvalIdsByFamily = eventFamilyCounts(newEvalIds.map((id) => newProd.byId.get(id)).filter(Boolean));
  const newEvalAdded = newEvalIds.length > 0 ? frontier.addReserveIds(newEvalIds, (id) => {
    const ev = newProd.byId.get(id);
    return ev ? bucketFamily(ev.logicalFamily ?? ev.family ?? 'unknown') : 'unknown';
  }) : 0;
  if (newEvalAdded > 0) console.log(`[live-evolve] frontier.addReserveIds: injected ${newEvalAdded} new eval_hidden ids into reserve`);
  // CANONICAL stepEpoch: NUMERIC honest-accepts + quality-attempts (NEVER roots).
  // Step the PERSISTED frontier instance — preserves reservePtr / cumulative counts.
  const frontierSnap = frontier.stepEpoch(epoch, prevHonestAccepts, prevQualityAttempts);
  mark('frontierUpdate');
  const activeRootChanged = frontierSnap.activeRoot !== prevActiveRoot;
  const baselineRecomputedBecause = corpusRootChanged ? 'corpusRootChanged' : (activeRootChanged ? 'activeRootChanged' : null);

  const fullPack = deriveQueryPack(0, evalSeedHex, newProd, hiddenPackProfile);
  let activePack = filterPackToActive(fullPack, frontierSnap.activeIds);
  const activeLiveEvalPack = forceActiveLiveEvalEvents(activePack, newProd, frontierSnap.activeIds, LIVE_EVAL_PACK_LIMIT);
  activePack = activeLiveEvalPack.pack;
  if (activeLiveEvalPack.added > 0) console.log(`[live-evolve] active live eval pack: +${activeLiveEvalPack.added} forced, families=${JSON.stringify(activeLiveEvalPack.familyCounts)}`);
  const heldoutPack = filterPackToHeldout(fullPack, frontierSnap.activeIds);
  const oldCorpusPair = stablePackForOldCorpusPair(prevActivePack, currentProd, newProd);
  for (const ev of activePack.events) if (!frontierSnap.activeIds.has(ev.id)) { console.error(`HARD FAIL: epoch ${epoch} activePack contains id ${ev.id} not in frontierSnap.activeIds`); exit(1); }
  const idShuffledActivePack = buildIdShuffledPack(activePack);
  mark('evalPackRefresh');

  let activeScorePpm = null, heldoutScorePpm = null, idShuffledScorePpm = null;
  let activeDetailed = null, heldoutDetailed = null;
  if (baselineRecomputedBecause) {
    console.log(`[live-evolve] scoring active(${activePack.events.length}) + heldout(${heldoutPack.events.length}) + idShuffled control ...`);
    console.log(`[live-evolve]   scoring active baseline ...`);
    const activeEval = activePack.events.length ? await evaluatePack(newProd, activePack, epochScoringTelemetry, TRACE_DIAGNOSTICS) : null;
    console.log(`[live-evolve]   active baseline done`);
    console.log(`[live-evolve]   scoring heldout baseline ...`);
    const heldoutEval = heldoutPack.events.length ? await evaluatePack(newProd, heldoutPack, epochScoringTelemetry, TRACE_DIAGNOSTICS) : null;
    console.log(`[live-evolve]   heldout baseline done`);
    activeScorePpm = activeEval?.scorePpm ?? null;
    heldoutScorePpm = heldoutEval?.scorePpm ?? null;
    activeDetailed = activeEval?.score ?? null;
    heldoutDetailed = heldoutEval?.score ?? null;
    console.log(`[live-evolve]   scoring idShuffled control ...`);
    idShuffledScorePpm = idShuffledActivePack.events.length ? await scoreOnPack(newProd, idShuffledActivePack, epochScoringTelemetry) : null;
    console.log(`[live-evolve]   idShuffled control done`);
  }
  mark('baselineScoring');

  const crossFrontierLift = (activeScorePpm != null && prevActiveScorePpm != null) ? (activeScorePpm - prevActiveScorePpm) : null;
  const heldoutFrontierLift = (heldoutScorePpm != null && prevHeldoutScorePpm != null) ? (heldoutScorePpm - prevHeldoutScorePpm) : null;
  // Rename: this is qrel-shuffle collapse, NOT doc-id-dependence (a true ID-dependence probe
  // would rename mem_* events and rewire references — out of scope for this harness).
  const qrelShuffleCollapseRatio = (activeScorePpm != null && idShuffledScorePpm != null && activeScorePpm > 0)
    ? (activeScorePpm - idShuffledScorePpm) / Math.max(1, activeScorePpm) : null;
  const docIdDependence = qrelShuffleCollapseRatio; // DEPRECATED alias; remove after readers migrate.

  // Honest mining: K patches per epoch across mixed canonical fingerprints. Cycle rotates
  // through HONEST_FAMILIES so each epoch attempts one patch per promoted surface (plus
  // wrap-around if HONEST_PER_EPOCH > HONEST_FAMILIES.length).
  let honestAcceptsThisEpoch = 0, qualityAttemptsThisEpoch = 0, honestReuseThisEpoch = 0;
  const honestPerPatch = [];
  const acceptsByFingerprint = {};
  const attemptsByFingerprint = {};
  const attemptsByAtomFamily = {};
  const acceptsByAtomFamily = {};
  const easySkipsByAtomFamily = {};
  const easySkipsByFingerprint = {};
  const operationReuseByAtomFamily = {};
  const selectorReuseByAtomFamily = {};
  const activeStateEvalCache = new Map();
  const oldStateEvalCache = new Map();
  if (activeDetailed) activeStateEvalCache.set(`${GENESIS_PARENT_ROOT}:plain`, { scorePpm: activeScorePpm, score: activeDetailed });
  // Refresh logical-query and event-by-doc maps post-evolve so this epoch's pack-mined patches
  // can resolve newly-added queries and event ids.
  logicalQById = new Map([...currentLogical.queries.map((q) => [q.id, q]), ...liveLogicalQByProductionId]);
  eventByDocId = buildMemoryEventByDocId(newProd);
  for (let h = 0; h < HONEST_PER_EPOCH; h++) {
    const family = HONEST_FAMILIES[h % HONEST_FAMILIES.length];
    const hp = honestPatchForEpoch(epoch, h, family, { pack: activePack, logicalQById, eventByDocId, addedDocs: ld.addedDocs, slotCursor: honestSlotCursor });
    if (!hp) break;
    console.log(`[live-evolve]   honest ${h + 1}/${HONEST_PER_EPOCH} family=${family} fingerprint=${hp.operationFingerprint ?? hp.fingerprint ?? 'unknown'}`);
    attemptsByFingerprint[hp.operationFingerprint] = (attemptsByFingerprint[hp.operationFingerprint] ?? 0) + 1;
    const fpFamily = atomFamilyForFingerprint(hp.operationFingerprint);
    attemptsByAtomFamily[fpFamily] = (attemptsByAtomFamily[fpFamily] ?? 0) + 1;
    if (hp.skipped) {
      console.log(`[live-evolve]   honest ${h + 1}/${HONEST_PER_EPOCH} skipped:${hp.reason}`);
      honestPerPatch.push({ h, family, accepted: false, deltaPpm: 0, heldoutDeltaPpm: null, reason: `skipped:${hp.reason}`, fingerprint: hp.fingerprint, operationFingerprint: hp.operationFingerprint, selectorFingerprint: hp.selectorFingerprint, targetDocId: null, targetDocIdRecordedOnly: true });
      continue;
    }
    const shouldAtomTrace = ATOM_TRACE
      && (fpFamily === 'validity_atom' || fpFamily === 'entity_resolution_atom')
      && ((atomTraceCounts.get(fpFamily) ?? 0) < ATOM_TRACE_LIMIT_PER_FAMILY);
    if (ATOM_CHURN_FAMILIES.has(fpFamily)) {
      const hardness = baselineAtomHardness({ targetDocId: hp.targetDocId, targetDocIds: hp.atomMinedDocIds, pack: activePack, baselineScore: activeDetailed });
      if (!hardness.hard) {
        easySkipsByAtomFamily[fpFamily] = (easySkipsByAtomFamily[fpFamily] ?? 0) + 1;
        easySkipsByFingerprint[hp.operationFingerprint] = (easySkipsByFingerprint[hp.operationFingerprint] ?? 0) + 1;
        console.log(`[live-evolve]   honest ${h + 1}/${HONEST_PER_EPOCH} skipped:${hardness.reason}`);
        let atomTraceDiagnostics = null;
        if (shouldAtomTrace) {
          const parentState = bestState;
          const parentStateRoot = merkleizeState(parentState);
          const candidatePatch = { ...hp.patch, parentStateRoot };
          const appliedTrace = applyPatch(parentState, candidatePatch, optsForProd(null, true).policyAtomsMode === true);
          const traceBeforeEval = await cachedStateEval(activeStateEvalCache, parentStateRoot, parentState, newProd, activePack, epochScoringTelemetry, true);
          atomTraceDiagnostics = buildAtomTraceDiagnostics({
            epoch, h, hp, fpFamily, pack: activePack, activeIds: frontierSnap.activeIds, corpus: newProd,
            appliedState: appliedTrace?.ok ? appliedTrace.state : null,
            before: traceBeforeEval.score,
            after: null,
          });
          atomTraceCounts.set(fpFamily, (atomTraceCounts.get(fpFamily) ?? 0) + 1);
          console.log(`[live-evolve]   atom-trace emitted family=${fpFamily} reason=${hardness.reason}`);
        }
        honestPerPatch.push({
          h, family,
          accepted: false,
          deltaPpm: 0,
          heldoutDeltaPpm: null,
          reason: `skipped:${hardness.reason}`,
          fingerprint: hp.fingerprint,
          operationFingerprint: hp.operationFingerprint,
          selectorFingerprint: hp.selectorFingerprint,
          targetDocId: hp.targetDocId,
          targetDocIdRecordedOnly: true,
          temporalRecordSlot: hp.temporalRecordSlot ?? null,
          scopeAtomSlot: hp.scopeAtomSlot ?? null,
          entityResolutionAtomSlot: hp.entityResolutionAtomSlot ?? null,
          atomHardness: hardness,
          ...(atomTraceDiagnostics ? { atomTraceDiagnostics } : {}),
        });
        continue;
      }
      hp.atomHardness = hardness;
    }
    qualityAttemptsThisEpoch++;
    try {
      const tracePatch = TRACE_DIAGNOSTICS || shouldAtomTrace;
      const parentState = bestState;
      const parentStateRoot = merkleizeState(parentState);
      const candidatePatch = { ...hp.patch, parentStateRoot };
      const opts = optsForProd(epochScoringTelemetry, tracePatch);
      const appliedForDecomposition = applyPatch(parentState, candidatePatch, opts.policyAtomsMode === true);
      if (!appliedForDecomposition?.ok) {
        console.log(`[live-evolve]   honest ${h + 1}/${HONEST_PER_EPOCH} apply_failed:${appliedForDecomposition?.code ?? 'unknown'}`);
        honestPerPatch.push({
          h, family,
          accepted: false,
          deltaPpm: 0,
          heldoutDeltaPpm: null,
          reason: `apply_failed:${appliedForDecomposition?.code ?? 'unknown'}`,
          fingerprint: hp.fingerprint,
          operationFingerprint: hp.operationFingerprint,
          selectorFingerprint: hp.selectorFingerprint,
          targetDocId: hp.targetDocId,
          targetDocIdRecordedOnly: true,
        });
        continue;
      }
      const activeBeforeEval = await cachedStateEval(activeStateEvalCache, parentStateRoot, parentState, newProd, activePack, epochScoringTelemetry, tracePatch);
      const r = await evaluateRetrievalBenchmarkPatch(parentState, candidatePatch, newProd, activePack, opts, baselineFloors, activeBeforeEval.score);
      const heldoutPatch = TRACE_DIAGNOSTICS && heldoutPack.events.length
        ? await evaluateRetrievalBenchmarkPatch(parentState, candidatePatch, newProd, heldoutPack, optsForProd(epochScoringTelemetry, true), baselineFloors)
        : null;
      const oldBeforeEval = await cachedStateEval(oldStateEvalCache, parentStateRoot, parentState, currentProd, oldCorpusPair.pack, epochScoringTelemetry, false);
      const acceptanceDecomposition = await buildAcceptanceDecomposition({
        parentState,
        candidateState: appliedForDecomposition.state,
        oldCorpus: currentProd,
        newCorpus: newProd,
        oldPack: oldCorpusPair.pack,
        newPack: activePack,
        newBefore: r.before,
        newAfter: r.after,
        telemetry: epochScoringTelemetry,
        oldBeforeEval,
      });
      const c = acceptanceDecomposition.acceptanceComponents;
      const accepted = !!r.accepted
        && c.passesRecovery
        && c.passesOldCorpusDamage
        && c.passesOldFamilyRegression
        && c.passesGoldDamage;
      const rejectReason = accepted ? null
        : (!r.accepted ? (r.reason ?? 'patch_rejected')
          : (!c.passesOldCorpusDamage ? 'old_corpus_damage'
            : (!c.passesOldFamilyRegression ? 'old_family_regression'
              : (!c.passesGoldDamage ? 'gold_damage'
                : (!c.passesRecovery ? 'no_recovery' : 'decomposition_reject')))));
      if (accepted) {
        honestAcceptsThisEpoch++;
        acceptedOperationCount++;
        acceptedSelectorCount++;
        acceptsByFingerprint[hp.operationFingerprint] = (acceptsByFingerprint[hp.operationFingerprint] ?? 0) + 1;
        acceptsByAtomFamily[fpFamily] = (acceptsByAtomFamily[fpFamily] ?? 0) + 1;
        if (operationReuseSet.has(hp.operationFingerprint)) {
          honestReuseThisEpoch++;
          acceptedOperationReuseCount++;
          operationReuseByAtomFamily[fpFamily] = (operationReuseByAtomFamily[fpFamily] ?? 0) + 1;
        } else {
          operationReuseSet.add(hp.operationFingerprint);
        }
        if (selectorReuseSet.has(hp.selectorFingerprint)) {
          acceptedSelectorReuseCount++;
          selectorReuseByAtomFamily[fpFamily] = (selectorReuseByAtomFamily[fpFamily] ?? 0) + 1;
        } else {
          selectorReuseSet.add(hp.selectorFingerprint);
        }
        bestState = appliedForDecomposition.state;
      }
      const cursorUpdateApplied = applyHonestCursorUpdate(honestSlotCursor, hp.cursorUpdate);
      console.log(`[live-evolve]   honest ${h + 1}/${HONEST_PER_EPOCH} ${accepted ? 'accepted' : `rejected:${rejectReason}`} delta=${r.deltaPpm ?? 0}ppm recovery=${acceptanceDecomposition.patchRecoveryPpm}ppm oldDamage=${acceptanceDecomposition.oldCorpusDamagePpm}ppm`);
      const activeComparisons = tracePatch ? compareQueries(r.before, r.after) : [];
      const targetDiagnostics = targetDocDiagnostics({ targetDocId: hp.targetDocId, before: r.before, after: r.after, pack: activePack, patch: candidatePatch });
      const atomTraceDiagnostics = shouldAtomTrace ? buildAtomTraceDiagnostics({
        epoch, h, hp, fpFamily, pack: activePack, activeIds: frontierSnap.activeIds, corpus: newProd,
        appliedState: appliedForDecomposition.state,
        before: r.before,
        after: r.after,
      }) : null;
      if (atomTraceDiagnostics) {
        atomTraceCounts.set(fpFamily, (atomTraceCounts.get(fpFamily) ?? 0) + 1);
        console.log(`[live-evolve]   atom-trace emitted family=${fpFamily} accepted=${accepted}`);
      }
      const activeImprovements = activeComparisons
        .filter((c) => c.deltaNdcg > 0)
        .sort((a, b) => b.deltaNdcg - a.deltaNdcg)
        .slice(0, TRACE_LIMIT);
      const topActiveImprovement = activeImprovements[0] ?? null;
      const heldoutComparisons = tracePatch && heldoutPatch ? compareQueries(heldoutPatch.before, heldoutPatch.after) : [];
      const heldoutById = new Map(heldoutPack.events.map((e) => [e.id, e]));
      const activeById = new Map(activePack.events.map((e) => [e.id, e]));
      const traceDiagnostics = tracePatch ? {
        worstHeldoutRegressions: heldoutComparisons
          .filter((c) => c.deltaNdcg < 0)
          .sort((a, b) => a.deltaNdcg - b.deltaNdcg)
          .slice(0, TRACE_LIMIT)
          .filter((c) => heldoutById.has(c.recordId))
          .map((c) => buildTraceEntry({ epoch, h, patchProvenance: patchTraceProvenance(hp), comparison: c, query: heldoutById.get(c.recordId), corpus: newProd, activeImprovement: topActiveImprovement, kind: 'heldout_regression' })),
        activeNonRegressions: stableSample(activeComparisons.filter((c) => c.deltaNdcg >= 0), TRACE_LIMIT, `${frontierSeed}:${epoch}:${h}:active-nonregression`)
          .filter((c) => activeById.has(c.recordId))
          .map((c) => buildTraceEntry({ epoch, h, patchProvenance: patchTraceProvenance(hp), comparison: c, query: activeById.get(c.recordId), corpus: newProd, activeImprovement: topActiveImprovement, kind: 'active_non_regression' })),
        heldoutNonRegressions: stableSample(heldoutComparisons.filter((c) => c.deltaNdcg >= 0), TRACE_LIMIT, `${frontierSeed}:${epoch}:${h}:heldout-nonregression`)
          .filter((c) => heldoutById.has(c.recordId))
          .map((c) => buildTraceEntry({ epoch, h, patchProvenance: patchTraceProvenance(hp), comparison: c, query: heldoutById.get(c.recordId), corpus: newProd, activeImprovement: topActiveImprovement, kind: 'heldout_non_regression' })),
        activeImprovements: activeImprovements
          .filter((c) => activeById.has(c.recordId))
          .map((c) => buildTraceEntry({ epoch, h, patchProvenance: patchTraceProvenance(hp), comparison: c, query: activeById.get(c.recordId), corpus: newProd, activeImprovement: c, kind: 'active_improvement' })),
      } : undefined;
      honestPerPatch.push({
        h, family,
        accepted,
        deltaPpm: r.deltaPpm ?? 0,
        heldoutDeltaPpm: heldoutPatch ? (heldoutPatch.deltaPpm ?? 0) : null,
        reason: rejectReason,
        fingerprint: hp.fingerprint,
        operationFingerprint: hp.operationFingerprint,
        selectorFingerprint: hp.selectorFingerprint,
        targetDocId: hp.targetDocId,
        targetDocIdRecordedOnly: true,
        temporalRecordSlot: hp.temporalRecordSlot ?? null,
        conflictAtomSlot: hp.conflictAtomSlot ?? null,
        evidenceMemorySlot: hp.evidenceMemorySlot ?? null,
        evidenceAtomSlot: hp.evidenceAtomSlot ?? null,
        evidenceSourceQueryId: hp.evidenceSourceQueryId ?? null,
        noiseMemorySlot: hp.noiseMemorySlot ?? null,
        noiseAtomSlot: hp.noiseAtomSlot ?? null,
        noiseSourceQueryId: hp.noiseSourceQueryId ?? null,
        noiseCategory: hp.noiseCategory ?? null,
        relationLensOffset: hp.relationLensOffset ?? null,
        relationLensEdges: hp.relationLensEdges ?? null,
        scopeAtomSlot: hp.scopeAtomSlot ?? null,
        scopeAtomSlots: hp.scopeAtomSlots ?? null,
        entityResolutionAtomSlot: hp.entityResolutionAtomSlot ?? null,
        entityResolutionAtomSlots: hp.entityResolutionAtomSlots ?? null,
        atomRecordsCompiled: hp.atomRecordsCompiled ?? null,
        atomMinedDocIds: hp.atomMinedDocIds ?? null,
        cursorUpdateApplied,
        oldCorpusPairExcludedQueryCount: oldCorpusPair.excluded.length,
        oldCorpusPairExcludedQueryIds: oldCorpusPair.excluded.slice(0, 16),
        acceptanceDecomposition,
        ...(tracePatch ? { decodedPatchTrace: buildDecodedPatchTrace({ hp, appliedState: appliedForDecomposition.state, corpus: newProd }) } : {}),
        ...(hp.atomHardness ? { atomHardness: hp.atomHardness } : {}),
        ...(targetDiagnostics ? { targetDiagnostics } : {}),
        ...(atomTraceDiagnostics ? { atomTraceDiagnostics } : {}),
        ...(traceDiagnostics ? { traceDiagnostics } : {}),
      });
    } catch (e) {
      console.log(`[live-evolve]   honest ${h + 1}/${HONEST_PER_EPOCH} eval_error:${e.message?.slice(0, 120)}`);
      honestPerPatch.push({
        h, family,
        accepted: false,
        deltaPpm: 0,
        reason: `eval_error:${e.message?.slice(0, 80)}`,
        fingerprint: hp.fingerprint,
        operationFingerprint: hp.operationFingerprint,
        selectorFingerprint: hp.selectorFingerprint,
        targetDocId: hp.targetDocId,
        targetDocIdRecordedOnly: true,
      });
    }
  }
  const operationReuseRate = honestAcceptsThisEpoch ? honestReuseThisEpoch / honestAcceptsThisEpoch : 0;
  mark('honestPatchScoring');

  const rand = mulberry32(hseed(`${frontierSeed}:live-evolve:anti-cheat:${epoch}`));
  let randomAccepts = 0, hillclimbAccepts = 0;
  const randomDeltas = [], hillclimbDeltas = [];
  for (let i = 0; i < RANDOM_PROBES; i++) {
    const state = makeGenesisState();
    const r = await evaluateRetrievalBenchmarkPatch(state, randomPatch(state, rand), newProd, activePack, optsForProd(epochScoringTelemetry, false), baselineFloors);
    randomDeltas.push(r.deltaPpm ?? 0);
    if (r.accepted) randomAccepts++;
  }
  for (let i = 0; i < HILLCLIMB_PROBES; i++) {
    const r = await evaluateRetrievalBenchmarkPatch(bestState, randomPatch(bestState, rand), newProd, activePack, optsForProd(epochScoringTelemetry, false), baselineFloors);
    hillclimbDeltas.push(r.deltaPpm ?? 0);
    if (r.accepted) hillclimbAccepts++;
  }
  mark('antiCheatScoring');
  const decompositionRows = honestPerPatch.map((p) => p.acceptanceDecomposition).filter(Boolean);
  const acceptedDecompositionRows = honestPerPatch.filter((p) => p.accepted).map((p) => p.acceptanceDecomposition).filter(Boolean);
  const mean = (vals) => vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const oldDamageVals = decompositionRows.map((d) => d.oldCorpusDamagePpm);
  const recoveryVals = decompositionRows.map((d) => d.patchRecoveryPpm);
  const decompositionSummary = {
    oldCorpusDamageTolerancePpm: OLD_CORPUS_DAMAGE_TOLERANCE_PPM,
    oldCorpusPairQueryCount: oldCorpusPair.pack.events.length,
    oldCorpusPairExcludedQueryCount: oldCorpusPair.excluded.length,
    oldCorpusPairExcludedQueryIds: oldCorpusPair.excluded.slice(0, 16),
    meanOldCorpusDamagePpm: mean(oldDamageVals),
    worstOldCorpusDamagePpm: oldDamageVals.length ? Math.min(...oldDamageVals) : null,
    meanPatchRecoveryPpm: mean(recoveryVals),
    acceptedPatchRecoveryPpm: acceptedDecompositionRows.map((d) => d.patchRecoveryPpm),
    acceptedOldCorpusDamagePpm: acceptedDecompositionRows.map((d) => d.oldCorpusDamagePpm),
    rejectedForOldCorpusDamage: honestPerPatch.filter((p) => p.acceptanceDecomposition && !p.acceptanceDecomposition.acceptanceComponents.passesOldCorpusDamage).length,
    rejectedForNoRecovery: honestPerPatch.filter((p) => p.acceptanceDecomposition && !p.acceptanceDecomposition.acceptanceComponents.passesRecovery).length,
    rejectedForOldFamilyRegression: honestPerPatch.filter((p) => p.acceptanceDecomposition && !p.acceptanceDecomposition.acceptanceComponents.passesOldFamilyRegression).length,
    rejectedForGoldDamage: honestPerPatch.filter((p) => p.acceptanceDecomposition && !p.acceptanceDecomposition.acceptanceComponents.passesGoldDamage).length,
  };
  timingsMs.epochTotal = Date.now() - epochStartMs;
  timingsMs.live_delta_mechanics_ms = (timingsMs.deltaGeneration ?? 0) + (timingsMs.bridgeLogicalDelta ?? 0);
  timingsMs.embedding_ms = (timingsMs.biEncoderEmbedding ?? 0) + (timingsMs.mockEmbedding ?? 0);
  timingsMs.root_update_ms = (timingsMs.buildCorpusDeltaRoot ?? 0) + (timingsMs.applyCorpusDeltaRoot ?? 0);
  timingsMs.frontier_update_ms = timingsMs.frontierUpdate ?? 0;
  timingsMs.candidate_rendering_ms = epochScoringTelemetry.candidateRenderingMs;
  timingsMs.qwen_scoring_ms = epochScoringTelemetry.qwenScoringMs;
  timingsMs.total_epoch_ms = timingsMs.epochTotal;
  const frontierTraceDiagnostics = TRACE_DIAGNOSTICS && prevHeldoutDetailed && heldoutDetailed ? (() => {
    const heldoutById = new Map(heldoutPack.events.map((e) => [e.id, e]));
    const activeById = new Map(activePack.events.map((e) => [e.id, e]));
    const activeImprovements = compareQueries(prevActiveDetailed, activeDetailed)
      .filter((c) => c.deltaNdcg > 0)
      .sort((a, b) => b.deltaNdcg - a.deltaNdcg)
      .slice(0, TRACE_LIMIT);
    const topActiveImprovement = activeImprovements[0] ?? null;
    const heldoutComparisons = compareQueries(prevHeldoutDetailed, heldoutDetailed);
    const patchProvenance = patchTraceProvenance(honestPerPatch.find((p) => p.accepted) ?? null);
    return {
      note: 'Frontier/baseline comparison across epoch boundary; query set changes can affect aggregate heldout_frontier_lift independently of patch causality.',
      comparedHeldoutQueries: heldoutComparisons.length,
      worstHeldoutRegressions: heldoutComparisons
        .filter((c) => c.deltaNdcg < 0 && heldoutById.has(c.recordId))
        .sort((a, b) => a.deltaNdcg - b.deltaNdcg)
        .slice(0, TRACE_LIMIT)
        .map((c) => buildTraceEntry({ epoch, h: null, patchProvenance, comparison: c, query: heldoutById.get(c.recordId), corpus: newProd, activeImprovement: topActiveImprovement, kind: 'frontier_heldout_regression' })),
      heldoutNonRegressions: stableSample(heldoutComparisons.filter((c) => c.deltaNdcg >= 0 && heldoutById.has(c.recordId)), TRACE_LIMIT, `${frontierSeed}:${epoch}:frontier-heldout-nonregression`)
        .map((c) => buildTraceEntry({ epoch, h: null, patchProvenance, comparison: c, query: heldoutById.get(c.recordId), corpus: newProd, activeImprovement: topActiveImprovement, kind: 'frontier_heldout_non_regression' })),
      activeImprovements: activeImprovements
        .filter((c) => activeById.has(c.recordId))
        .map((c) => buildTraceEntry({ epoch, h: null, patchProvenance, comparison: c, query: activeById.get(c.recordId), corpus: newProd, activeImprovement: c, kind: 'frontier_active_improvement' })),
    };
  })() : undefined;

  perEpoch.push({
    epoch,
    previousCorpusRoot: currentProd.corpusRoot, deltaNextRoot: delta.nextRoot, currentCorpusRoot: newProd.corpusRoot,
    activeRoot: frontierSnap.activeRoot, activeRootChanged, corpusRootChanged,
    activeFrontierSize: frontierSnap.activeIds.size,
    // Frontier rotation provenance (proves real C3 rotation, not re-genesis each epoch).
    frontierRotation: {
      activated: frontierSnap.activated,
      retired: frontierSnap.retired,
      churnRate: frontierSnap.churnRate,
      reserveRemaining: frontierSnap.reserveRemaining,
      cumulativeActivated: frontierSnap.cumulativeActivated,
      cumulativeRetired: frontierSnap.cumulativeRetired,
      newEvalIdsInjectedThisEpoch: newEvalAdded,
      newEvalIdsByFamily,
    },
    activePackSize: activePack.events.length, heldoutPackSize: heldoutPack.events.length,
    activePackFamilyCounts: eventFamilyCounts(activePack.events),
    activeLiveEvalForcedIntoPack: activeLiveEvalPack.added,
    activeLiveEvalPackSize: activeLiveEvalPack.liveEvalInPack,
    activeLiveEvalPackFamilyCounts: activeLiveEvalPack.familyCounts,
    addedDocs: ld.addedDocs.length, addedQueries: ld.addedQueries.length,
    addedMemDocs: ld.addedDocs.length, addedRelations: ld.addedRelations.length,
    liveChurnRate: ld.liveChurnRate,
    rootCacheUsed: !!rootCacheBefore,
    rootCacheLeavesBefore: rootCacheBefore?.eventCount ?? null,
    rootCacheLeavesAfter: newProd.corpusRootCache?.eventCount ?? null,
    timingsMs,
    scoringTelemetry: summarizeScoringTelemetry(epochScoringTelemetry),
    ...(frontierTraceDiagnostics ? { frontierTraceDiagnostics } : {}),
    baselineRecomputedBecause,
    activeScorePpm, heldoutScorePpm, idShuffledActiveScorePpm: idShuffledScorePpm,
    cross_frontier_lift: crossFrontierLift,
    heldout_frontier_lift: heldoutFrontierLift,
    qrel_shuffle_collapse_ratio: qrelShuffleCollapseRatio,
    doc_id_dependence: docIdDependence, // DEPRECATED: alias of qrel_shuffle_collapse_ratio
    honestAttempted: qualityAttemptsThisEpoch, honestAccepted: honestAcceptsThisEpoch,
    operation_reuse_rate: operationReuseRate,
    attemptsByFingerprint, acceptsByFingerprint,
    attemptsByAtomFamily, acceptsByAtomFamily,
    easySkipsByFingerprint, easySkipsByAtomFamily,
    operationReuseByAtomFamily, selectorReuseByAtomFamily,
    decompositionSummary,
    honestPerPatch,
    antiCheat: {
      randomProbes: RANDOM_PROBES,
      randomAccepts,
      randomAcceptanceRate: randomAccepts / Math.max(1, RANDOM_PROBES),
      randomDeltaPpmMax: randomDeltas.length ? Math.max(...randomDeltas) : null,
      hillclimbProbes: HILLCLIMB_PROBES,
      hillclimbAccepts,
      hillclimbAcceptanceRate: hillclimbAccepts / Math.max(1, HILLCLIMB_PROBES),
      hillclimbDeltaPpmMax: hillclimbDeltas.length ? Math.max(...hillclimbDeltas) : null,
    },
    stepEpochInputs: { prevHonestAccepts, prevQualityAttempts },
  });

  console.log(`[live-evolve] activeScore=${activeScorePpm}ppm heldoutScore=${heldoutScorePpm}ppm idShuffledScore=${idShuffledScorePpm}ppm`);
  console.log(`[live-evolve] cross_frontier_lift=${crossFrontierLift} heldout_frontier_lift=${heldoutFrontierLift} doc_id_dependence=${docIdDependence}`);
  console.log(`[live-evolve] honest: ${honestAcceptsThisEpoch}/${qualityAttemptsThisEpoch} accepted, operation_reuse_rate=${operationReuseRate.toFixed(3)}; antiCheat random=${randomAccepts}/${RANDOM_PROBES} hill=${hillclimbAccepts}/${HILLCLIMB_PROBES}`);
  if (Object.keys(easySkipsByFingerprint).length > 0) {
    console.log(`[live-evolve] atom easy skips: ${JSON.stringify(easySkipsByFingerprint)}`);
  }
  for (const fp of Object.keys(attemptsByFingerprint)) {
    const att = attemptsByFingerprint[fp]; const acc = acceptsByFingerprint[fp] ?? 0;
    console.log(`[live-evolve]   fp ${fp}: ${acc}/${att}`);
  }

  currentLogical = { ...currentLogical, docs: [...currentLogical.docs, ...ld.addedDocs], relations: [...currentLogical.relations, ...ld.addedRelations], queries: [...currentLogical.queries, ...ld.addedQueries] };
  // evolveCorpusDelta does not currently emit new entities, but refresh the registry
  // anyway so any future extension that does is picked up by next-epoch scoring.
  policyEntityRegistryCached = buildPolicyEntityRegistry(currentLogical);
  currentProd = newProd;
  prevActiveRoot = frontierSnap.activeRoot;
  prevActiveScorePpm = activeScorePpm ?? prevActiveScorePpm;
  prevHeldoutScorePpm = heldoutScorePpm ?? prevHeldoutScorePpm;
  prevActiveDetailed = activeDetailed ?? prevActiveDetailed;
  prevHeldoutDetailed = heldoutDetailed ?? prevHeldoutDetailed;
  prevActivePack = activePack;
  prevHeldoutPack = heldoutPack;
  prevHonestAccepts = honestAcceptsThisEpoch;        // feed to next epoch's stepEpoch
  prevQualityAttempts = qualityAttemptsThisEpoch;
}

const qrelShuffleCollapseValues = perEpoch.map((e) => e.qrel_shuffle_collapse_ratio).filter((v) => v != null);
const timingKeys = Array.from(new Set(perEpoch.flatMap((e) => Object.keys(e.timingsMs ?? {}))));
const timingSummaryMs = Object.fromEntries(timingKeys.map((key) => {
  const vals = perEpoch.map((e) => e.timingsMs?.[key]).filter((v) => typeof v === 'number');
  return [key, {
    max: vals.length ? Math.max(...vals) : null,
    mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
  }];
}));
const report = {
  schema: 'coretex.live-evolve-long-horizon.v2',
  ...provenance,
  tag: TAG,
  command: ['node', 'scripts/simulate-v2-live-evolve-long-horizon.mjs', ...process.argv.slice(2)].join(' '),
  commandArgs: process.argv.slice(2),
  reranker: RERANKER === 'gpu' ? `Qwen/${RR.modelId}@${RR.revision}` : 'deterministic',
  rerankerModel: RR.modelId,
  rerankerRevision: RR.revision,
  rerankerMode: RERANKER,
  profile: PROFILE_PATH, bundle: BUNDLE_PATH, corpus: CORPUS_PATH, embeddings: EMB_PATH,
  bundleHash: JSON.parse(readFileSync(resolve(repoRoot, BUNDLE_PATH), 'utf8')).bundleHash,
  corpusRoot: baseBundle.manifest.corpusRoot,
  baseCorpusRoot: baseBundle.corpus.corpusRoot, finalCorpusRoot: currentProd.corpusRoot,
  finalActiveRoot: prevActiveRoot,
  epochsRun: perEpoch.length, churnFraction: CHURN_FRACTION, seed: frontierSeed,
  traceDiagnosticsEnabled: TRACE_DIAGNOSTICS,
  genesisScoringTelemetry: summarizeScoringTelemetry(genesisScoringTelemetry),
  rerankerTelemetry: {
    ...reranker.telemetrySnapshot?.(),
    modelStartupMs: reranker.modelStartupMs?.() ?? null,
    safeCacheKey: {
      queryTextHash: true,
      renderedCandidateHash: true,
      rerankerModelId: RR.modelId,
      rerankerRevision: RR.revision,
      memoryIRVersion: profile.memoryIRSchemaVersion ?? 'raw',
      profileHash,
      substrateMode: profile.pipelineVersion ?? 'unknown',
      includesQrelsOrHiddenLabels: false,
      cacheExposedToMiner: false,
    },
  },
  perEpoch,
  honestFamiliesCycled: HONEST_FAMILIES,
  uniqueHonestOperations: operationReuseSet.size,
  uniqueHonestSelectors: selectorReuseSet.size,
  acceptsByFingerprintTotals: (() => {
    const out = {};
    for (const ep of perEpoch) for (const fp of Object.keys(ep.acceptsByFingerprint ?? {})) out[fp] = (out[fp] ?? 0) + ep.acceptsByFingerprint[fp];
    return out;
  })(),
  attemptsByFingerprintTotals: (() => {
    const out = {};
    for (const ep of perEpoch) for (const fp of Object.keys(ep.attemptsByFingerprint ?? {})) out[fp] = (out[fp] ?? 0) + ep.attemptsByFingerprint[fp];
    return out;
  })(),
  attemptsByAtomFamilyTotals: (() => {
    const out = {};
    for (const ep of perEpoch) for (const fp of Object.keys(ep.attemptsByAtomFamily ?? {})) out[fp] = (out[fp] ?? 0) + ep.attemptsByAtomFamily[fp];
    return out;
  })(),
  acceptsByAtomFamilyTotals: (() => {
    const out = {};
    for (const ep of perEpoch) for (const fp of Object.keys(ep.acceptsByAtomFamily ?? {})) out[fp] = (out[fp] ?? 0) + ep.acceptsByAtomFamily[fp];
    return out;
  })(),
  easySkipsByFingerprintTotals: (() => {
    const out = {};
    for (const ep of perEpoch) for (const fp of Object.keys(ep.easySkipsByFingerprint ?? {})) out[fp] = (out[fp] ?? 0) + ep.easySkipsByFingerprint[fp];
    return out;
  })(),
  easySkipsByAtomFamilyTotals: (() => {
    const out = {};
    for (const ep of perEpoch) for (const fp of Object.keys(ep.easySkipsByAtomFamily ?? {})) out[fp] = (out[fp] ?? 0) + ep.easySkipsByAtomFamily[fp];
    return out;
  })(),
  operationReuseByAtomFamilyTotals: (() => {
    const out = {};
    for (const ep of perEpoch) for (const fp of Object.keys(ep.operationReuseByAtomFamily ?? {})) out[fp] = (out[fp] ?? 0) + ep.operationReuseByAtomFamily[fp];
    return out;
  })(),
  selectorReuseByAtomFamilyTotals: (() => {
    const out = {};
    for (const ep of perEpoch) for (const fp of Object.keys(ep.selectorReuseByAtomFamily ?? {})) out[fp] = (out[fp] ?? 0) + ep.selectorReuseByAtomFamily[fp];
    return out;
  })(),
  summary: {
    atomHardnessFilterEnabled: true,
    honestCandidateSelections: perEpoch.reduce((s, e) => s + Object.values(e.attemptsByAtomFamily ?? {}).reduce((a, b) => a + b, 0), 0),
    honestAttempts: perEpoch.reduce((s, e) => s + e.honestAttempted, 0),
    honestAccepted: perEpoch.reduce((s, e) => s + e.honestAccepted, 0),
    atomEasySkips: perEpoch.reduce((s, e) => s + Object.values(e.easySkipsByAtomFamily ?? {}).reduce((a, b) => a + b, 0), 0),
    acceptedOperationReuseRate: acceptedOperationCount ? acceptedOperationReuseCount / acceptedOperationCount : 0,
    acceptedSelectorReuseRate: acceptedSelectorCount ? acceptedSelectorReuseCount / acceptedSelectorCount : 0,
    randomProbes: perEpoch.reduce((s, e) => s + e.antiCheat.randomProbes, 0),
    randomAccepts: perEpoch.reduce((s, e) => s + e.antiCheat.randomAccepts, 0),
    hillclimbProbes: perEpoch.reduce((s, e) => s + e.antiCheat.hillclimbProbes, 0),
    hillclimbAccepts: perEpoch.reduce((s, e) => s + e.antiCheat.hillclimbAccepts, 0),
    antiCheatCleanRandom: perEpoch.every((e) => e.antiCheat.randomAccepts === 0),
    antiCheatCleanHillclimb: perEpoch.every((e) => e.antiCheat.hillclimbAccepts === 0),
    crossFrontierLiftPpm: perEpoch.map((e) => e.cross_frontier_lift).filter((v) => v != null),
    heldoutFrontierLiftPpm: perEpoch.map((e) => e.heldout_frontier_lift).filter((v) => v != null),
    liveEvalIdsInjected: perEpoch.reduce((s, e) => s + e.frontierRotation.newEvalIdsInjectedThisEpoch, 0),
    rootCacheUsedAllEpochs: perEpoch.every((e) => e.rootCacheUsed),
    decomposition: (() => {
      const rows = perEpoch.flatMap((e) => (e.honestPerPatch ?? []).map((p) => p.acceptanceDecomposition).filter(Boolean));
      const acceptedRows = perEpoch.flatMap((e) => (e.honestPerPatch ?? []).filter((p) => p.accepted).map((p) => p.acceptanceDecomposition).filter(Boolean));
      const oldDamage = rows.map((r) => r.oldCorpusDamagePpm);
      const recovery = rows.map((r) => r.patchRecoveryPpm);
      return {
        oldCorpusDamageTolerancePpm: OLD_CORPUS_DAMAGE_TOLERANCE_PPM,
        measuredPatchCount: rows.length,
        acceptedMeasuredPatchCount: acceptedRows.length,
        meanOldCorpusDamagePpm: oldDamage.length ? oldDamage.reduce((a, b) => a + b, 0) / oldDamage.length : null,
        worstOldCorpusDamagePpm: oldDamage.length ? Math.min(...oldDamage) : null,
        meanPatchRecoveryPpm: recovery.length ? recovery.reduce((a, b) => a + b, 0) / recovery.length : null,
        acceptedPatchRecoveryPpm: acceptedRows.map((r) => r.patchRecoveryPpm),
        acceptedOldCorpusDamagePpm: acceptedRows.map((r) => r.oldCorpusDamagePpm),
        acceptedHasMaterialOldCorpusDamage: acceptedRows.some((r) => r.oldCorpusDamagePpm < -OLD_CORPUS_DAMAGE_TOLERANCE_PPM),
        rejectedForOldCorpusDamage: perEpoch.reduce((s, e) => s + (e.decompositionSummary?.rejectedForOldCorpusDamage ?? 0), 0),
        rejectedForNoRecovery: perEpoch.reduce((s, e) => s + (e.decompositionSummary?.rejectedForNoRecovery ?? 0), 0),
        rejectedForOldFamilyRegression: perEpoch.reduce((s, e) => s + (e.decompositionSummary?.rejectedForOldFamilyRegression ?? 0), 0),
        rejectedForGoldDamage: perEpoch.reduce((s, e) => s + (e.decompositionSummary?.rejectedForGoldDamage ?? 0), 0),
      };
    })(),
    timingSummaryMs,
    qrelShuffleCollapseRatioMean: qrelShuffleCollapseValues.length
      ? qrelShuffleCollapseValues.reduce((a, b) => a + b, 0) / qrelShuffleCollapseValues.length
      : null,
    antiIndexer: {
      patchUsesDirectDocId: false,
      patchUsesCorpusHeaderOrLabel: false,
      targetDocIdRecordedOnly: true,
      operationFingerprint: 'mixed; see honestFamiliesCycled and attemptsByFingerprintTotals',
      selectorFingerprint: 'mixed; see per-patch selectorFingerprint',
      qrelShuffleCollapseIsNotDocIdDependence: true,
    },
  },
  canonicalAPIsUsed: [
    'evolveCorpusDelta(baseLogical, epoch, seed, churnFraction)',
    'bridgeLogicalDeltaToProductionEvents({previousCorpus, logicalDelta, addedDocEmbeddings, addedQueryEmbeddings, biEncoder})',
    'buildCorpusDelta({previousCorpus, additions, removals, epoch, labelingProvenance})',
    'applyCorpusDelta(currentProd, delta)',
    'makeLaunchFrontier(profile, prod).addReserveIds(newEvalIds, familyOf)',
    'makeLaunchFrontier(profile, prod).stepEpoch(epoch, prevHonestAccepts, prevQualityAttempts)',
    'evaluateRetrievalBenchmarkState(state, corpus, pack, opts)',
    'evaluateRetrievalBenchmarkPatch(state, patch, corpus, pack, opts, floors)',
  ],
};
const outPath = resolve(repoRoot, OUTDIR, `V2_LIVE_EVOLVE_LONG_HORIZON_${TAG}_qwen.json`);
writeFileSync(outPath, JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
console.log(`\n[live-evolve] wrote ${outPath}`);
console.log(`[live-evolve] epochsRun=${perEpoch.length} uniqueHonestOps=${operationReuseSet.size}`);

await reranker.close?.();
exit(0);
