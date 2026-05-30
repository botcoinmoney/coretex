#!/usr/bin/env node
/**
 * CANONICAL LIVE-EVOLVE LONG-HORIZON CHURN HARNESS.
 *
 * Replaces the deprecated `simulate-v2-long-horizon.mjs` for launch calibration. The deprecated
 * harness froze the corpus at startup and only rotated frontier slices — useful as a frontier
 * diagnostic but NOT a live-update churn calibration. This harness drives the canonical chain
 * the production pipeline must run each epoch:
 *
 *   evolveCorpusDelta(currentLogical, epoch, seed, churnFraction)
 *     → embed addedDocs + addedQueries with the pinned BGE-M3 (real, CPU one-shot)
 *     → convert to production additions (mem_* train_visible + query events, splits by splitForRecord)
 *     → buildCorpusDelta({previousCorpus: currentProd, additions, removals: [], epoch, labelingProvenance})
 *     → applyCorpusDelta(currentProd, delta)
 *     → assert newProd.corpusRoot === delta.nextRoot === delta.previousRoot⇒ currentProd.corpusRoot
 *     → frontier = makeLaunchFrontier(profile, newProd).stepEpoch(epoch, prevCorpusRoot, prevActiveRoot)
 *     → baseline recompute (real Qwen GPU on the active pack) when corpusRootChanged OR activeRootChanged
 *
 * Each epoch report includes per the calibration handoff:
 *   epoch, previousCorpusRoot, delta.nextRoot, current corpusRoot, activeRoot,
 *   liveChurnRate, addedDocs, addedQueries, addedMemDocs,
 *   baselineRecomputedBecause, baselineParentScorePpm,
 *   operation_reuse_rate, cross_frontier_lift, heldout_frontier_lift, doc_id_dependence.
 *
 * Usage:
 *   node scripts/simulate-v2-live-evolve-long-horizon.mjs --reranker gpu
 *     --profile <profile.json> --corpus <base-corpus.json> --emb <base-embeddings.json>
 *     --out <outdir> --tag <tag> [--epochs 12] [--churn-fraction 0.05] [--seed coretex-launch-frontier]
 *     [--honest-per-epoch 3] [--random-probes 12] [--hillclimb-probes 6]
 *     [--pack-size 64] [--clear-pack-quotas] [--target-advances 3] [--skip-rejected-temporal]
 *     [--frontier-mode C3] [--frontier-window 3072]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { evolveCorpusDelta } from './lib/evolve-corpus.mjs';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { embedTexts } from './_embed-v2.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const C = await import(distIndex);
const {
  buildCorpusDelta, applyCorpusDelta, computeCorpusRoot, makeLaunchFrontier,
  splitForRecord, expectedSplitForRecord, biEncoderModelIdHash,
  scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState,
  createDeterministicReranker, qwen3Reranker06BManifest,
} = C;

// ─── arg parsing ───
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const RERANKER = flag('reranker', 'gpu'); // 'gpu' | 'deterministic'
const PROFILE_PATH = flag('profile');
const CORPUS_PATH = flag('corpus');
const EMB_PATH = flag('emb');
const OUTDIR = flag('out');
const TAG = flag('tag', 'live-evolve');
const EPOCHS = Number(flag('epochs', '12'));
const CHURN_FRACTION = Number(flag('churn-fraction', '0.05'));
const SEED = flag('seed', null);
const HONEST_PER_EPOCH = Number(flag('honest-per-epoch', '3'));
const RANDOM_PROBES = Number(flag('random-probes', '12'));
const HILLCLIMB_PROBES = Number(flag('hillclimb-probes', '6'));
const PACK_SIZE = Number(flag('pack-size', '64'));
const CLEAR_PACK_QUOTAS = has('clear-pack-quotas');
const TARGET_ADVANCES = Number(flag('target-advances', '3'));
const SKIP_REJECTED_TEMPORAL = has('skip-rejected-temporal');

if (!PROFILE_PATH || !CORPUS_PATH || !EMB_PATH || !OUTDIR) {
  console.error('HARD FAIL: --profile, --corpus, --emb, --out are required');
  exit(1);
}

mkdirSync(resolve(repoRoot, OUTDIR), { recursive: true });

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
const frontierSeed = SEED ?? profile.epochFrontier?.seed ?? 'coretex-launch-frontier';
console.log(`[live-evolve] profile=${PROFILE_PATH}`);
console.log(`[live-evolve] corpus=${CORPUS_PATH} emb=${EMB_PATH}`);
console.log(`[live-evolve] epochs=${EPOCHS} churn=${CHURN_FRACTION} seed=${frontierSeed}`);

// ─── 1. base production corpus (real embeddings) ───
console.log('[live-evolve] building base production corpus ...');
const baseBundle = buildV2ProductionCorpus({ corpusPath: CORPUS_PATH, embPath: EMB_PATH });
let currentProd = baseBundle.corpus;
const { BE, RR, LAYOUT } = baseBundle;
const labelingProvenance = {
  modelId: RR.modelId, revision: RR.revision,
  runtime: 'coretex-retrieval-v2-policy-r5', batchHash: '0x' + '00'.repeat(32),
};
console.log(`[live-evolve] base corpus events=${currentProd.events.length} root=${currentProd.corpusRoot.slice(0, 18)}…`);

// Working logical corpus (mutated each epoch with the evolve delta)
let currentLogical = JSON.parse(readFileSync(resolve(repoRoot, CORPUS_PATH), 'utf8'));
// docId → text for truth-doc resolution (includes BOTH original + evolve-added docs as we grow)
const docTextById = new Map(currentLogical.docs.map((d) => [d.id, d]));

const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const memId = (id) => `mem_${id}`;
const bucket = (f) => f === 'temporal_update' ? 'temporal'
  : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance') ? 'multi_hop_relation'
  : f === 'conflict_lifecycle' ? 'conflict_lifecycle'
  : f === 'aspect_constraint' ? 'aspect_constraint'
  : f === 'coreference_resolution' ? 'coreference'
  : 'near_collision';

function int8Bytes(vec) {
  let m = 0; for (const v of vec) m = Math.max(m, Math.abs(v));
  const s = m > 0 ? m / 127 : 1;
  const o = new Uint8Array(4 + LAYOUT.dim);
  new DataView(o.buffer).setFloat32(0, s, false);
  for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / s); c = Math.max(-127, Math.min(127, c)); o[4 + i] = c & 0xff; }
  return o;
}

// ─── 2. reranker init (GPU stream or deterministic) ───
const reranker = RERANKER === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();

const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');

async function scoreActivePack(prod, frontierProfile) {
  const hiddenPack = CLEAR_PACK_QUOTAS
    ? { packSize: PACK_SIZE, quotas: [] }
    : { ...(profile.hiddenPack || { packSize: PACK_SIZE, quotas: [] }), packSize: PACK_SIZE };
  const evalSeedHex = profile.baselineEvalSeedHex ?? '0x' + 'a5'.repeat(32);
  const pack = deriveQueryPack(0, evalSeedHex, prod, hiddenPack);
  const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
  const opts = scoringOptionsFromProfile({ ...profile, ...frontierProfile }, rt);
  const result = await evaluateRetrievalBenchmarkState(prod, pack, opts);
  return { pack, result, scorePpm: Math.round((result.compositeScore ?? 0) * 1_000_000) };
}

let prevCorpusRoot = currentProd.corpusRoot;
const fr0 = makeLaunchFrontier(profile, currentProd).stepEpoch(0, null, null);
let prevActiveRoot = fr0.activeRoot;
let baselineParentScorePpm = Number(profile.baselineParentScorePpm) || null;

console.log(`[live-evolve] genesis activeRoot=${prevActiveRoot.slice(0, 18)}…`);
console.log(`[live-evolve] starting baseline=${baselineParentScorePpm}ppm`);

const perEpoch = [];
const allHonestPatches = [];
const honestPatchKeys = new Set();

for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  console.log(`\n[live-evolve] ===== EPOCH ${epoch} =====`);
  const ld = evolveCorpusDelta({ baseLogical: currentLogical, epoch, seed: frontierSeed, churnFraction: CHURN_FRACTION });
  console.log(`[live-evolve] evolveCorpusDelta: +${ld.addedDocs.length} docs, +${ld.addedRelations.length} rels, +${ld.addedQueries.length} queries, churnRate=${ld.liveChurnRate.toFixed(4)}`);

  // Embed added docs + queries with pinned BGE-M3 (CPU)
  const docTexts = ld.addedDocs.map((d) => d.text);
  const qTexts = ld.addedQueries.map((q) => q.queryText);
  const docVecs = docTexts.length ? await embedTexts(docTexts) : [];
  const qVecs = qTexts.length ? await embedTexts(qTexts) : [];

  // Update docTextById index BEFORE building query events (queries may reference newly-added docs in qrels)
  for (const d of ld.addedDocs) docTextById.set(d.id, d);

  // Per-doc int8 embedding cache (mem_* event uses both query slot + perTruth)
  const memEmbCache = new Map();
  ld.addedDocs.forEach((d, i) => { memEmbCache.set(d.id, int8Bytes(docVecs[i])); });

  const relsBySrc = new Map();
  for (const r of ld.addedRelations) { if (!relsBySrc.has(r.src)) relsBySrc.set(r.src, []); relsBySrc.get(r.src).push(r); }

  const additions = [];

  // mem_* docs (train_visible)
  ld.addedDocs.forEach((d, i) => {
    const e = memEmbCache.get(d.id);
    additions.push({
      id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible',
      queryText: d.text,
      truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true, ...(d.aspectTags ? { aspectTags: d.aspectTags } : {}) }],
      hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
      relations: (relsBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type, ...(r.label ? { label: r.label } : {}) })),
      ...(Array.isArray(d.entityIds) && d.entityIds.length ? { entityIds: d.entityIds } : {}),
      provenance: PROV,
      embeddings: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: e, perTruth: new Map([[d.id, e]]), perNegative: new Map() },
    });
  });

  // query events — note: split = splitForRecord(q.id, currentProd.corpusEpoch)
  ld.addedQueries.forEach((q, i) => {
    const qe = int8Bytes(qVecs[i]);
    const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => {
      const d = docTextById.get(r.docId);
      if (!d) throw new Error(`live-evolve: missing truth doc ${r.docId} for query ${q.id}`);
      return { id: r.docId, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true };
    });
    const negs = (q.hardNegatives ?? []).map((n) => {
      const d = docTextById.get(n.docId);
      if (!d) throw new Error(`live-evolve: missing hard-neg doc ${n.docId} for query ${q.id}`);
      return { id: n.docId, text: d.text, category: n.category };
    });
    // perTruth + perNegative embeddings — use memEmbCache if the doc is in the current delta, else
    // pull the int8 bytes from currentProd's mem_<docId> event (already int8-encoded with same layout).
    const lookupDocEmb = (docId) => {
      if (memEmbCache.has(docId)) return memEmbCache.get(docId);
      const memEv = currentProd.byId.get(memId(docId));
      if (memEv?.embeddings?.perTruth?.get(docId)) return memEv.embeddings.perTruth.get(docId);
      throw new Error(`live-evolve: missing doc embedding for ${docId} (mem_${docId} not in currentProd and not in epoch delta)`);
    };
    const ev = {
      id: q.id, family: bucket(q.family), logicalFamily: q.family, domain: q.lane,
      split: splitForRecord(q.id, currentProd.corpusEpoch),
      queryText: q.queryText,
      truthDocuments: truths, hardNegatives: negs,
      qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })),
      protected: false, relations: [],
      ...(q.band ? { band: q.band } : {}),
      ...(q.ownerEntityId !== undefined ? { ownerEntityId: q.ownerEntityId, ownerScoped: q.ownerScoped !== false } : {}),
      ...(q.subjectEntityId !== undefined ? { subjectEntityId: q.subjectEntityId } : {}),
      provenance: PROV,
      embeddings: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: qe,
        perTruth: new Map(truths.map((t) => [t.id, lookupDocEmb(t.id)])),
        perNegative: new Map(negs.map((n) => [n.id, lookupDocEmb(n.id)])) },
    };
    if (ev.family === 'temporal') ev.temporal = { validFromEpoch: 1, validUntilEpoch: Number.MAX_SAFE_INTEGER, currentStaleFlag: false };
    additions.push(ev);
  });

  // Canonical buildCorpusDelta + applyCorpusDelta — replay validates against this same chain.
  const delta = buildCorpusDelta({ previousCorpus: currentProd, additions, removals: [], epoch, labelingProvenance });
  if (delta.previousRoot.toLowerCase() !== currentProd.corpusRoot.toLowerCase()) {
    console.error(`HARD FAIL: delta.previousRoot != currentProd.corpusRoot at epoch ${epoch}`);
    exit(1);
  }
  const newProd = applyCorpusDelta(currentProd, delta);
  if (newProd.corpusRoot.toLowerCase() !== delta.nextRoot.toLowerCase()) {
    console.error(`HARD FAIL: applyCorpusDelta nextRoot mismatch at epoch ${epoch}: applied=${newProd.corpusRoot} delta=${delta.nextRoot}`);
    exit(1);
  }
  console.log(`[live-evolve] buildCorpusDelta OK: previousRoot=${delta.previousRoot.slice(0, 18)}… nextRoot=${delta.nextRoot.slice(0, 18)}… added=${delta.addedIds.length}`);

  const corpusRootChanged = newProd.corpusRoot !== currentProd.corpusRoot;
  // Rebuild frontier from the NEW production corpus — frontier is a function of current prod.
  const frontier = makeLaunchFrontier(profile, newProd).stepEpoch(epoch, prevCorpusRoot, prevActiveRoot);
  const activeRootChanged = frontier.activeRoot !== prevActiveRoot;

  let baselineRecomputedBecause = null;
  let scorePpm = null;
  if (corpusRootChanged) baselineRecomputedBecause = 'corpusRootChanged';
  else if (activeRootChanged) baselineRecomputedBecause = 'activeRootChanged';

  if (baselineRecomputedBecause) {
    console.log(`[live-evolve] baseline recompute (${baselineRecomputedBecause}) — scoring active pack with real Qwen ...`);
    const { scorePpm: spm } = await scoreActivePack(newProd, { epochFrontier: profile.epochFrontier });
    scorePpm = spm;
    baselineParentScorePpm = spm;
    console.log(`[live-evolve] new baselineParentScorePpm = ${spm}`);
  }

  // Honest mining attempt — simple structural fingerprint (subject+family) so we can compute
  // operation_reuse_rate across epochs without needing the full screener pipeline.
  const honestThisEpoch = ld.addedQueries.slice(0, HONEST_PER_EPOCH).map((q) => ({
    subjectId: q.subjectEntityId ?? null, family: q.family, epoch,
    fingerprint: `subj:${q.subjectEntityId ?? 'none'}|fam:${q.family}`,
  }));
  let reuseCount = 0;
  for (const h of honestThisEpoch) { if (honestPatchKeys.has(h.fingerprint)) reuseCount++; else honestPatchKeys.add(h.fingerprint); }
  const operationReuseRate = honestThisEpoch.length ? reuseCount / honestThisEpoch.length : 0;
  allHonestPatches.push(...honestThisEpoch);

  perEpoch.push({
    epoch,
    previousCorpusRoot: currentProd.corpusRoot,
    deltaNextRoot: delta.nextRoot,
    currentCorpusRoot: newProd.corpusRoot,
    activeRoot: frontier.activeRoot,
    liveChurnRate: ld.liveChurnRate,
    addedDocs: ld.addedDocs.length,
    addedQueries: ld.addedQueries.length,
    addedMemDocs: ld.addedDocs.length, // every added doc becomes a mem_* train_visible event
    addedRelations: ld.addedRelations.length,
    baselineRecomputedBecause,
    baselineParentScorePpm,
    scoredPackPpm: scorePpm,
    operation_reuse_rate: operationReuseRate,
    honestPatchesAttempted: honestThisEpoch.length,
    // Per-handoff metrics that require dedicated probe design — recorded as null with reason rather
    // than silently omitted. Follow-up commit will add: split active vs heldout pack scoring, and the
    // doc-id-mangled control probe.
    cross_frontier_lift: null,
    heldout_frontier_lift: null,
    doc_id_dependence: null,
    _deferredMetricsReason: 'cross_frontier_lift / heldout_frontier_lift / doc_id_dependence require dedicated active-vs-reserve scoring + id-shuffled control; deferred to a follow-up commit so the canonical live-evolve loop ships now.',
  });

  // Advance state for next epoch
  currentLogical = {
    ...currentLogical,
    docs: [...currentLogical.docs, ...ld.addedDocs],
    relations: [...currentLogical.relations, ...ld.addedRelations],
    queries: [...currentLogical.queries, ...ld.addedQueries],
  };
  currentProd = newProd;
  prevCorpusRoot = newProd.corpusRoot;
  prevActiveRoot = frontier.activeRoot;
}

const report = {
  schema: 'coretex.live-evolve-long-horizon.v1',
  tag: TAG,
  reranker: RERANKER === 'gpu' ? `Qwen/${RR.modelId}@${RR.revision}` : 'deterministic',
  profile: PROFILE_PATH,
  corpus: CORPUS_PATH,
  embeddings: EMB_PATH,
  epochsRun: perEpoch.length,
  churnFraction: CHURN_FRACTION,
  seed: frontierSeed,
  baseCorpusRoot: baseBundle.corpus.corpusRoot,
  finalCorpusRoot: currentProd.corpusRoot,
  finalActiveRoot: prevActiveRoot,
  perEpoch,
  honestPatchesSeen: allHonestPatches.length,
  honestPatchesUnique: honestPatchKeys.size,
  generatedAtNote: 'stamp externally — replay path is deterministic from (seed, profile, base, embeddings)',
};
const outPath = resolve(repoRoot, OUTDIR, `V2_LIVE_EVOLVE_LONG_HORIZON_${TAG}_qwen.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\n[live-evolve] wrote ${outPath}`);
console.log(`[live-evolve] base→final corpusRoot: ${baseBundle.corpus.corpusRoot.slice(0, 18)} → ${currentProd.corpusRoot.slice(0, 18)}`);
console.log(`[live-evolve] epochs with corpusRoot advance: ${perEpoch.filter((e) => e.baselineRecomputedBecause === 'corpusRootChanged').length}/${perEpoch.length}`);
console.log(`[live-evolve] epochs with activeRoot-only advance: ${perEpoch.filter((e) => e.baselineRecomputedBecause === 'activeRootChanged').length}/${perEpoch.length}`);

await reranker.close?.();
exit(0);
