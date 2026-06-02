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
import { hseed, mulberry32, randomPatch, relationUnits } from './lib/v2-patch-families.mjs';
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
  merkleizeState,
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
const CLEAR_PACK_QUOTAS = has('clear-pack-quotas');
const MOCK_EMBEDDINGS = has('mock-embeddings');
const TRACE_DIAGNOSTICS = has('trace-diagnostics');
const TRACE_LIMIT = Number(flag('trace-limit', '5'));
const DISABLE_QWEN_CACHE = has('disable-qwen-cache');

if (!PROFILE_PATH || !BUNDLE_PATH || !CORPUS_PATH || !EMB_PATH || !OUTDIR) {
  console.error('HARD FAIL: --profile, --bundle, --corpus, --emb, --out required');
  exit(1);
}

mkdirSync(resolve(repoRoot, OUTDIR), { recursive: true });

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
const frontierSeed = SEED_OVERRIDE ?? profile.epochFrontier?.seed ?? 'coretex-launch-frontier';
console.log(`[live-evolve] profile=${PROFILE_PATH} bundle=${BUNDLE_PATH}`);
console.log(`[live-evolve] corpus=${CORPUS_PATH} epochs=${EPOCHS} churn=${CHURN_FRACTION} seed=${frontierSeed}`);

console.log('[live-evolve] loading materialized base production corpus (NO rebuild) ...');
const baseBundle = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
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
function optsForProd(telemetry = null, trace = false) {
  return {
    ...scoringOptionsFromProfile(profile, rt()),
    ...(trace ? { exposeFullRanking: true, policyEmitTraces: true, exposeRenderedCandidates: true } : {}),
    ...(telemetry ? { scoringTelemetry: (e) => recordScoringTelemetry(telemetry, e) } : {}),
  };
}

async function evaluatePack(prod, pack, telemetry = null, trace = false) {
  const opts = optsForProd(telemetry, trace);
  const res = await evaluateRetrievalBenchmarkState(makeGenesisState(), prod, pack, opts);
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
  const beforeTop = topK(beforeQ, 10);
  const afterTop = topK(afterQ, 10);
  const staleIds = new Set((query.truthDocuments ?? []).filter((d) => d.isCurrent === false).map((d) => d.id));
  const staleDropped = beforeTop.some((r) => staleIds.has(r.docId) && !afterTop.some((a) => a.docId === r.docId && a.rank <= r.rank));
  const junkTop = afterTop.filter((r) => r.relevance === 0);
  const routedJunk = junkTop.filter((r) => r.sources?.some((s) => s === 'categoryLensBFS' || s === 'anchorBFS' || s === 'policyAdmitted'));
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
function honestPatchForEpoch(epoch, honestIdx, addedDocs) {
  const target = addedDocs[honestIdx % Math.max(1, addedDocs.length)];
  if (!target) return null;
  const rel = relationUnits(2);
  const operationFingerprint = 'honest:relation(2):categoryLens:supports,causes';
  const selectorFingerprint = 'public-edge-category-lens:supports,causes';
  const fingerprint = `${operationFingerprint}:e${epoch}:h${honestIdx}`;
  return { patch: {
    patchType: PATCH_TYPE.MIXED, wordCount: rel.indices.length, scoreDelta: 0,
    parentStateRoot: GENESIS_PARENT_ROOT,
    indices: rel.indices,
    newWords: rel.newWords,
  }, fingerprint, operationFingerprint, selectorFingerprint, targetDocId: target.id };
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
let acceptedOperationCount = 0;
let acceptedOperationReuseCount = 0;
let bestState = makeGenesisState();
const perEpoch = [];
const baselineFloors = { ...profile.patchAcceptanceFloors, acceptanceThresholdPpm: profile.patchAcceptanceFloors?.minImprovementPpm ?? 2500 };

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
  const activePack = filterPackToActive(fullPack, frontierSnap.activeIds);
  const heldoutPack = filterPackToHeldout(fullPack, frontierSnap.activeIds);
  for (const ev of activePack.events) if (!frontierSnap.activeIds.has(ev.id)) { console.error(`HARD FAIL: epoch ${epoch} activePack contains id ${ev.id} not in frontierSnap.activeIds`); exit(1); }
  const idShuffledActivePack = buildIdShuffledPack(activePack);
  mark('evalPackRefresh');

  let activeScorePpm = null, heldoutScorePpm = null, idShuffledScorePpm = null;
  let activeDetailed = null, heldoutDetailed = null;
  if (baselineRecomputedBecause) {
    console.log(`[live-evolve] scoring active(${activePack.events.length}) + heldout(${heldoutPack.events.length}) + idShuffled control ...`);
    const activeEval = activePack.events.length ? await evaluatePack(newProd, activePack, epochScoringTelemetry, TRACE_DIAGNOSTICS) : null;
    const heldoutEval = heldoutPack.events.length ? await evaluatePack(newProd, heldoutPack, epochScoringTelemetry, TRACE_DIAGNOSTICS) : null;
    activeScorePpm = activeEval?.scorePpm ?? null;
    heldoutScorePpm = heldoutEval?.scorePpm ?? null;
    activeDetailed = activeEval?.score ?? null;
    heldoutDetailed = heldoutEval?.score ?? null;
    idShuffledScorePpm = idShuffledActivePack.events.length ? await scoreOnPack(newProd, idShuffledActivePack, epochScoringTelemetry) : null;
  }
  mark('baselineScoring');

  const crossFrontierLift = (activeScorePpm != null && prevActiveScorePpm != null) ? (activeScorePpm - prevActiveScorePpm) : null;
  const heldoutFrontierLift = (heldoutScorePpm != null && prevHeldoutScorePpm != null) ? (heldoutScorePpm - prevHeldoutScorePpm) : null;
  // Rename: this is qrel-shuffle collapse, NOT doc-id-dependence (a true ID-dependence probe
  // would rename mem_* events and rewire references — out of scope for this harness).
  const qrelShuffleCollapseRatio = (activeScorePpm != null && idShuffledScorePpm != null && activeScorePpm > 0)
    ? (activeScorePpm - idShuffledScorePpm) / Math.max(1, activeScorePpm) : null;
  const docIdDependence = qrelShuffleCollapseRatio; // DEPRECATED alias; remove after readers migrate.

  // Honest mining: K patches per epoch, score via canonical evaluateRetrievalBenchmarkPatch.
  let honestAcceptsThisEpoch = 0, qualityAttemptsThisEpoch = 0, honestReuseThisEpoch = 0;
  const honestPerPatch = [];
  for (let h = 0; h < HONEST_PER_EPOCH; h++) {
    const hp = honestPatchForEpoch(epoch, h, ld.addedDocs);
    if (!hp) break;
    qualityAttemptsThisEpoch++;
    try {
      const tracePatch = TRACE_DIAGNOSTICS;
      const r = await evaluateRetrievalBenchmarkPatch(makeGenesisState(), hp.patch, newProd, activePack, optsForProd(epochScoringTelemetry, tracePatch), baselineFloors);
      const heldoutPatch = tracePatch && heldoutPack.events.length
        ? await evaluateRetrievalBenchmarkPatch(makeGenesisState(), hp.patch, newProd, heldoutPack, optsForProd(epochScoringTelemetry, true), baselineFloors)
        : null;
      const accepted = !!r.accepted;
      if (accepted) {
        honestAcceptsThisEpoch++;
        acceptedOperationCount++;
        if (operationReuseSet.has(hp.operationFingerprint)) {
          honestReuseThisEpoch++;
          acceptedOperationReuseCount++;
        } else {
          operationReuseSet.add(hp.operationFingerprint);
        }
        const bestPatch = { ...hp.patch, parentStateRoot: merkleizeState(bestState) };
        const applied = applyPatch(bestState, bestPatch);
        if (applied?.ok) bestState = applied.state;
      }
      const activeComparisons = tracePatch ? compareQueries(r.before, r.after) : [];
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
        heldoutNonRegressions: stableSample(heldoutComparisons.filter((c) => c.deltaNdcg >= 0), TRACE_LIMIT, `${frontierSeed}:${epoch}:${h}:heldout-nonregression`)
          .filter((c) => heldoutById.has(c.recordId))
          .map((c) => buildTraceEntry({ epoch, h, patchProvenance: patchTraceProvenance(hp), comparison: c, query: heldoutById.get(c.recordId), corpus: newProd, activeImprovement: topActiveImprovement, kind: 'heldout_non_regression' })),
        activeImprovements: activeImprovements
          .filter((c) => activeById.has(c.recordId))
          .map((c) => buildTraceEntry({ epoch, h, patchProvenance: patchTraceProvenance(hp), comparison: c, query: activeById.get(c.recordId), corpus: newProd, activeImprovement: c, kind: 'active_improvement' })),
      } : undefined;
      honestPerPatch.push({
        h,
        accepted,
        deltaPpm: r.deltaPpm ?? 0,
        heldoutDeltaPpm: heldoutPatch ? (heldoutPatch.deltaPpm ?? 0) : null,
        reason: r.reason ?? null,
        fingerprint: hp.fingerprint,
        operationFingerprint: hp.operationFingerprint,
        selectorFingerprint: hp.selectorFingerprint,
        targetDocId: hp.targetDocId,
        targetDocIdRecordedOnly: true,
        ...(traceDiagnostics ? { traceDiagnostics } : {}),
      });
    } catch (e) {
      honestPerPatch.push({
        h,
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
    },
    activePackSize: activePack.events.length, heldoutPackSize: heldoutPack.events.length,
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

  currentLogical = { ...currentLogical, docs: [...currentLogical.docs, ...ld.addedDocs], relations: [...currentLogical.relations, ...ld.addedRelations], queries: [...currentLogical.queries, ...ld.addedQueries] };
  currentProd = newProd;
  prevActiveRoot = frontierSnap.activeRoot;
  prevActiveScorePpm = activeScorePpm ?? prevActiveScorePpm;
  prevHeldoutScorePpm = heldoutScorePpm ?? prevHeldoutScorePpm;
  prevActiveDetailed = activeDetailed ?? prevActiveDetailed;
  prevHeldoutDetailed = heldoutDetailed ?? prevHeldoutDetailed;
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
  uniqueHonestOperations: operationReuseSet.size,
  summary: {
    honestAttempts: perEpoch.reduce((s, e) => s + e.honestAttempted, 0),
    honestAccepted: perEpoch.reduce((s, e) => s + e.honestAccepted, 0),
    acceptedOperationReuseRate: acceptedOperationCount ? acceptedOperationReuseCount / acceptedOperationCount : 0,
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
    timingSummaryMs,
    qrelShuffleCollapseRatioMean: qrelShuffleCollapseValues.length
      ? qrelShuffleCollapseValues.reduce((a, b) => a + b, 0) / qrelShuffleCollapseValues.length
      : null,
    antiIndexer: {
      patchUsesDirectDocId: false,
      patchUsesCorpusHeaderOrLabel: false,
      targetDocIdRecordedOnly: true,
      operationFingerprint: 'honest:relation(2):categoryLens:supports,causes',
      selectorFingerprint: 'public-edge-category-lens:supports,causes',
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
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n[live-evolve] wrote ${outPath}`);
console.log(`[live-evolve] epochsRun=${perEpoch.length} uniqueHonestOps=${operationReuseSet.size}`);

await reranker.close?.();
exit(0);
