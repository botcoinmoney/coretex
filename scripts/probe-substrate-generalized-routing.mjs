#!/usr/bin/env node
/**
 * Substrate generalized-routing viability probe.
 *
 * THE question this answers: does the current substrate produce GENERALIZED
 * (non-anchor) routing lift, or is it a high-quality bookmark index whose
 * only lever is anchor-on-truth coverage?
 *
 * It runs ONE fixed cell matrix on a single pack, holding the pack, corpus,
 * reranker and bi-encoder constant across cells so the ONLY variable is the
 * substrate configuration + the selective Phase B knobs. Three cell families:
 *
 *   baseline ─ empty / stage1-only / anchor-on-truth (bookmark ceiling) /
 *              anchor-on-answer-alias / anchor-on-irrelevant (noise floor)
 *
 *   anchor-scarcity ─ anchor-on-truth capped at budget 1/4/8/full. If the
 *              substrate is a bookmark index, composite scales ~linearly with
 *              anchor budget and collapses at low budget. anchor-both /
 *              anchor-both+rels isolate endpoint-coverage vs anchor-graph edge.
 *
 *   generalized-routing ─ the cells that can ONLY win via non-anchor routing:
 *              lens-only (no anchors, Phase B bidirectional) — the key cell;
 *              lens+non-answer-anchors; phaseA-rels-no-answer-anchor;
 *              selective-phaseB-forward-budget-1/2/4 (forward traversal, the
 *              near-trivial expansion); selective-phaseB-no-bonus (inclusion
 *              without bias); broad-phaseB-legacy (bidirectional, large budget
 *              — the historical flooding comparator).
 *
 * Decisive metric: `relevantTop10ViaPhaseBOnly` — count of qrel-relevant docs
 * in the reranker top-10 whose source set includes categoryLensBFS and
 * EXCLUDES anchorMandatory/anchorBFS. That is a truth doc reached purely by
 * Phase B routing, not by being bookmarked. Generalized routing is real iff
 * this is materially > 0 AND the generalized-routing cells beat stage1-only
 * without the hard-negative flooding that broad-phaseB-legacy shows.
 *
 * Usage:
 *   node --max-old-space-size=8192 scripts/probe-substrate-generalized-routing.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-calibration-relation-qrels.json \
 *     --bundle-profile /etc/coretex/bundle-profile-launch-v3.json \
 *     --reranker deterministic --pack-size 16 \
 *     --out /var/lib/coretex/reports/substrate-generalized-routing.json
 */
import { distIndex } from './_repo-root.mjs';
import { profileAttestation } from './lib/profile-attestation.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}
const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const packSize = Number(flag('pack-size', '16'));
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/substrate-generalized-routing.json');
const seedHex = flag('seed', '0x' + 'c7'.repeat(32));
const targetFamily = flag('family', 'multi_hop_relation');
// Optional comma-separated cell-name allowlist (for timing probes / subsets).
const cellsFilter = flag('cells', '');
const cellsAllow = cellsFilter ? new Set(cellsFilter.split(',').map((s) => s.trim())) : null;

if (!corpusPath || !existsSync(corpusPath)) { console.error('--corpus missing'); exit(1); }

const {
  loadProductionCorpus,
  evaluateRetrievalBenchmarkState,
  biEncoderModelIdHash,
  dequantize,
  createDeterministicBiEncoder,
  createDeterministicReranker,
  rerankerFromEnv,
  encodeMemoryIndexSlot,
  encodeRetrievalKeySlot,
  encodeRelationEdge,
  encodeRelationCategoryLens,
  stableRecordIdFor,
  DEFAULT_PROFILE,
} = await import(distIndex);
const { buildProvenance } = await import('./calibration-provenance.mjs');

console.log(`[genroute] loading corpus`);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.log(`  ${corpus.events.length} events`);

const profile = profilePath && existsSync(profilePath)
  ? (() => { const r = JSON.parse(readFileSync(profilePath, 'utf8')); return r.profile ?? r; })()
  : DEFAULT_PROFILE;

const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);

// Quantize a float vector to the corpus int8 byte format: [f32 BE scale][codes].
// Used to write DERIVED lens vectors (e.g. relation-cluster centroids) into the
// substrate RetrievalKeys region for lens-construction experiments.
function quantizeVec(vec) {
  const dim = LAYOUT.dim;
  let maxAbs = 0;
  for (const x of vec) maxAbs = Math.max(maxAbs, Math.abs(x));
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const out = new Uint8Array(4 + dim);
  new DataView(out.buffer).setFloat32(0, scale, false);
  for (let i = 0; i < dim; i++) {
    let c = Math.round((vec[i] ?? 0) / scale);
    c = Math.max(-127, Math.min(127, c));
    out[4 + i] = c & 0xff;
  }
  return out;
}

// MINER-FEASIBLE lens construction: cosine k-means region centroids over the
// NON-HIDDEN corpus (train_visible + calibration + canary). Uses ONLY data a
// patch proposer can know — no eval_hidden events, no per-query relations, no
// qrels, no hidden truths. Fixed ≤k centroids cover the corpus's answer regions;
// whichever hidden query arrives, its answer is surfaced iff it falls in a
// covered region. Cached (deterministic init + fixed iters).
function kmeansCentroids(vecs, k, iters = 12) {
  const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; };
  const n = vecs.length;
  if (n === 0) return [];
  const kk = Math.min(k, n);
  const step = Math.max(1, Math.floor(n / kk));
  let cent = [];
  for (let i = 0; i < kk; i++) cent.push(norm(Float64Array.from(vecs[Math.min(i * step, n - 1)])));
  for (let iter = 0; iter < iters; iter++) {
    const sums = cent.map(() => new Float64Array(LAYOUT.dim));
    const cnt = new Array(cent.length).fill(0);
    for (const v of vecs) {
      let bi = 0, bc = -2;
      for (let c = 0; c < cent.length; c++) { let d = 0; const cc = cent[c]; for (let i = 0; i < v.length; i++) d += v[i] * cc[i]; if (d > bc) { bc = d; bi = c; } }
      const s = sums[bi]; for (let i = 0; i < v.length; i++) s[i] += v[i]; cnt[bi]++;
    }
    for (let c = 0; c < cent.length; c++) if (cnt[c] > 0) cent[c] = norm(sums[c]);
  }
  return cent;
}
// MINER-FEASIBLE variant 2: lens the entity regions that NON-HIDDEN queries
// reference via their relations (visible query -> derived_from -> entity is
// allowed). Tests whether visible query patterns predict eval-query targets.
let _visTargetCentroids = null;
function getVisibleQueryTargetCentroids(k = 36) {
  if (_visTargetCentroids) return _visTargetCentroids;
  const seen = new Set();
  const vecs = [];
  for (const ev of corpus.events) {
    if (ev.split === 'eval_hidden') continue; // miner cannot see hidden queries
    for (const rel of ev.relations ?? []) {
      const tgt = eventById.get(rel.other_id);
      if (!tgt || seen.has(tgt.id)) continue;
      seen.add(tgt.id);
      const t = tgt.truthDocuments.find((x) => x.isCurrent) ?? tgt.truthDocuments[0];
      const b = t && tgt.embeddings.perTruth.get(t.id);
      if (b) vecs.push(dequantize(b, LAYOUT));
    }
  }
  const cents = kmeansCentroids(vecs, k);
  console.log(`[genroute] miner-feasible visible-query-target lens: ${cents.length} centroids over ${vecs.length} visible-referenced entities`);
  _visTargetCentroids = cents;
  return cents;
}
let _regionCentroids = null;
function getRegionCentroids(k = 36) {
  if (_regionCentroids) return _regionCentroids;
  const vecs = [];
  for (const ev of corpus.events) {
    if (ev.split === 'eval_hidden') continue; // forbidden to the miner
    const t = ev.truthDocuments.find((x) => x.isCurrent) ?? ev.truthDocuments[0];
    const b = t && ev.embeddings.perTruth.get(t.id);
    if (b) vecs.push(dequantize(b, LAYOUT));
  }
  const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; for (let i = 0; i < v.length; i++) v[i] /= s; return v; };
  const n = vecs.length;
  const kk = Math.min(k, n);
  const step = Math.max(1, Math.floor(n / kk));
  let cent = [];
  for (let i = 0; i < kk; i++) cent.push(norm(Float64Array.from(vecs[Math.min(i * step, n - 1)])));
  for (let iter = 0; iter < 12; iter++) {
    const sums = cent.map(() => new Float64Array(LAYOUT.dim));
    const cnt = new Array(cent.length).fill(0);
    for (const v of vecs) {
      let bi = 0, bc = -2;
      for (let c = 0; c < cent.length; c++) { let d = 0; const cc = cent[c]; for (let i = 0; i < v.length; i++) d += v[i] * cc[i]; if (d > bc) { bc = d; bi = c; } }
      const s = sums[bi]; for (let i = 0; i < v.length; i++) s[i] += v[i]; cnt[bi]++;
    }
    for (let c = 0; c < cent.length; c++) if (cnt[c] > 0) cent[c] = norm(sums[c]);
  }
  console.log(`[genroute] miner-feasible region lens: k-means ${cent.length} centroids over ${n} non-hidden docs`);
  _regionCentroids = cent;
  return cent;
}

// The scorer reads the query vector from the corpus's stored embedding
// (query.embeddings.query) and runs stage-1 over the corpus's pre-baked real
// BGE-M3 doc embeddings — opts.biEncoder.encode() is never called. So the
// bi-encoder is always deterministic (zero-cost, no python child); only the
// RERANKER needs to be real (Qwen3) for a substrate verdict.
const biEncoder = createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT });
const reranker = rerankerArg === 'env'
  ? await rerankerFromEnv()
  : await createDeterministicReranker();
console.log(`[genroute] reranker: ${reranker.model} (bi-encoder: deterministic; corpus embeddings are pre-baked)`);

const eventById = new Map(corpus.events.map((e) => [e.id, e]));

const candidates = corpus.events.filter((e) =>
  e.family === targetFamily && Array.isArray(e.relations) && e.relations.length > 0,
);
console.log(`[genroute] target family=${targetFamily}; ${candidates.length} events with non-empty relations`);
if (candidates.length === 0) { console.error(`[genroute] no relation-bearing ${targetFamily} events`); exit(2); }

function shaIdx(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
  return h >>> 0;
}
const scored = candidates.map((e) => ({ e, s: shaIdx(seedHex + ':' + e.id) }));
scored.sort((a, b) => a.s - b.s);
const pack = { epochId: 0, evalSeedCommit: seedHex, events: scored.slice(0, packSize).map((x) => x.e) };
console.log(`[genroute] pack size=${pack.events.length}`);

// Per-pack-event related ("answer-alias") set + spanning edgeTypes.
const relatedByPackIndex = pack.events.map((ev) => {
  const related = [];
  for (const rel of ev.relations) {
    const tgt = eventById.get(rel.other_id);
    if (tgt && tgt.id !== ev.id) related.push({ event: tgt, edgeType: rel.edgeType });
  }
  return related;
});
const relatedEdgeTypes = new Set();
for (const rels of relatedByPackIndex) for (const r of rels) relatedEdgeTypes.add(r.edgeType);
console.log(`[genroute] edgeTypes spanning pack relations: ${[...relatedEdgeTypes].join(',')}`);

// Irrelevant-anchor pool: events with NO corpus path to any pack query and
// no qrel credit. Anchoring these is the noise floor.
function buildIrrelevantAnchorPool() {
  const excluded = new Set(pack.events.map((e) => e.id));
  for (const rels of relatedByPackIndex) for (const r of rels) excluded.add(r.event.id);
  return corpus.events
    .filter((e) => !excluded.has(e.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, pack.events.length);
}
const irrelevantAnchorPool = buildIrrelevantAnchorPool();

const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };
const EMPTY = new Array(1024).fill(0n);

// Anchor placement modes (mutually exclusive, set by cell.anchors):
//   'none'        — no anchors at all (pure stage-1 + Phase B)
//   'truth'       — anchor pack events themselves; capped by cell.anchorBudget
//   'answerAlias' — anchor relations[*].other_id (qrel-credited answer-alias)
//   'irrelevant'  — anchor off-answer events (noise floor / non-answer-near)
//   'both'        — anchor BOTH answer-alias and pack event in distinct slots
function slotAssignmentFor(cell) {
  const assignments = new Array(44).fill(null);
  const n = pack.events.length;
  const budget = cell.anchorBudget ?? n;
  switch (cell.anchors) {
    case 'none':
      break;
    case 'truth':
      for (let i = 0; i < Math.min(n, budget); i++) assignments[i] = pack.events[i];
      break;
    case 'answerAlias':
      for (let i = 0; i < n; i++) assignments[i] = relatedByPackIndex[i][0]?.event ?? null;
      if (cell.anchorBoth) for (let i = 0; i < n; i++) assignments[n + i] = pack.events[i];
      break;
    case 'irrelevant':
      for (let i = 0; i < n; i++) assignments[i] = irrelevantAnchorPool[i] ?? null;
      break;
    case 'both':
      for (let i = 0; i < n; i++) assignments[i] = relatedByPackIndex[i][0]?.event ?? null;
      for (let i = 0; i < n; i++) assignments[n + i] = pack.events[i];
      break;
  }
  return assignments;
}

// Corpus-attested anchor-to-anchor edges (no synthetic edges).
function corpusAttestedAnchorEdges(assignments) {
  const edges = [];
  for (let s = 0; s < assignments.length; s++) {
    const src = assignments[s];
    if (!src || !src.relations) continue;
    for (let t = 0; t < assignments.length; t++) {
      if (s === t) continue;
      const tgt = assignments[t];
      if (!tgt) continue;
      for (const rel of src.relations) {
        if (rel.other_id === tgt.id) edges.push({ sourceSlot: s, targetSlot: t, edgeType: rel.edgeType });
      }
    }
  }
  return edges;
}

function buildState(cell) {
  const words = [...EMPTY];
  const sharedDomain = 1n;
  const assignments = slotAssignmentFor(cell);
  let anchorsPlaced = 0;
  for (let s = 0; s < assignments.length; s++) {
    const ev = assignments[s];
    if (!ev) continue;
    anchorsPlaced++;
    const memWords = encodeMemoryIndexSlot({
      slotIndex: s,
      recordId: stableRecordIdFor(ev.id),
      family: ev.family,
      domainBits: sharedDomain,
      valid: true, revoked: false, protected: ev.protected ?? false,
      retrievalSlot: s, expiryEpoch: 0n,
    });
    const base = RANGES.MEMORY_INDEX_START + s * 8;
    for (let j = 0; j < 8; j++) words[base + j] = memWords[j];
  }
  let edgesWritten = 0;
  if (cell.relations) {
    let entryIndex = 0;
    for (const e of corpusAttestedAnchorEdges(assignments)) {
      if (entryIndex >= 8) break;
      words[RANGES.RELATIONS_START + entryIndex] = encodeRelationEdge({
        entryIndex, sourceSlot: e.sourceSlot, targetSlot: e.targetSlot, edgeType: e.edgeType, weight: 1,
      });
      entryIndex++; edgesWritten++;
    }
  }
  let lensesWritten = 0;
  if (cell.categoryLenses) {
    let entry = 128 - 1;
    for (const edgeType of relatedEdgeTypes) {
      words[RANGES.RELATIONS_START + entry] = encodeRelationCategoryLens({ entryIndex: entry, edgeType, weight: 0x8000 });
      entry--; lensesWritten++;
      if (entry < 8) break;
    }
  }
  // Semantic lens VECTORS (RetrievalKeys) — distinct from category-lens edgeType
  // markers above. cell.lensVectors='truth' writes the pack events' answer-region
  // (truth) embeddings as lens vectors. The scorer's lensBonus (lensWeight ×
  // max cos(doc, lens)) then PROMOTES a stage-1-retrieved-but-cap-excluded truth
  // into the reranker view + lifts its final rank — WITHOUT anchoring it
  // (source stays 'stage1', never 'anchorMandatory'). This exercises the lens
  // reweight path the historical matrix never wrote vectors for. Idealized
  // (lens == truth region) to test mechanism viability on the real corpus;
  // legitimate lens CONSTRUCTION (deriving such vectors without truth bookmark)
  // is the follow-on once the mechanism is shown corpus-viable.
  let lensVectorsWritten = 0;
  if (cell.lensVectors === 'corpus-regions' || cell.lensVectors === 'visible-query-targets') {
    // MINER-FEASIBLE: fixed centroids from non-hidden data; no pack info.
    const cents = cell.lensVectors === 'visible-query-targets' ? getVisibleQueryTargetCentroids(36) : getRegionCentroids(36);
    for (let i = 0; i < cents.length && i < 36; i++) {
      const kw = encodeRetrievalKeySlot(
        { slotIndex: i, modelIdHash: biEncoderHash, l2Norm: 1.0, versionTag: 1, quantizedBytes: quantizeVec(cents[i]) },
        { retrievalKeyHeaderBytes: LAYOUT.headerBytes },
      );
      const base = RANGES.RETRIEVAL_KEYS_START + i * 8;
      for (let j = 0; j < 8; j++) words[base + j] = kw[j];
      lensVectorsWritten++;
    }
  } else if (cell.lensVectors) {
    const n = Math.min(pack.events.length, 36);
    for (let i = 0; i < n; i++) {
      const ev = pack.events[i];
      let embBytes = null;
      if (cell.lensVectors === 'truth') {
        // Idealized answer-region lens = the event's own truth embedding
        // (bookmark-equivalent; tests the mechanism + cap bottleneck).
        const truth = ev.truthDocuments.find((t) => t.isCurrent) ?? ev.truthDocuments[0];
        embBytes = (truth && ev.embeddings.perTruth.get(truth.id)) || null;
      } else if (cell.lensVectors === 'relation-centroid') {
        // GRAPH-DERIVED lens = renormalized centroid of the event's related
        // (derived_from) entities' truth embeddings — NOT the event's own truth.
        // Tests whether a legitimately-derivable lens (no exact-truth bookmark)
        // surfaces the answer. relatedByPackIndex[i] = [{event, edgeType}].
        const related = relatedByPackIndex[i] ?? [];
        const acc = new Float64Array(LAYOUT.dim);
        let cnt = 0;
        for (const r of related) {
          const rt = r.event.truthDocuments.find((t) => t.isCurrent) ?? r.event.truthDocuments[0];
          const rb = rt && r.event.embeddings.perTruth.get(rt.id);
          if (!rb) continue;
          const fv = dequantize(rb, LAYOUT);
          for (let k = 0; k < LAYOUT.dim; k++) acc[k] += fv[k];
          cnt++;
        }
        if (cnt > 0) {
          let nrm = 0; for (const x of acc) nrm += x * x; nrm = Math.sqrt(nrm) || 1;
          for (let k = 0; k < acc.length; k++) acc[k] /= nrm;
          embBytes = quantizeVec(acc);
        }
      }
      if (!embBytes) continue;
      const kw = encodeRetrievalKeySlot(
        { slotIndex: i, modelIdHash: biEncoderHash, l2Norm: 1.0, versionTag: 1, quantizedBytes: embBytes },
        { retrievalKeyHeaderBytes: LAYOUT.headerBytes },
      );
      const base = RANGES.RETRIEVAL_KEYS_START + i * 8;
      for (let j = 0; j < 8; j++) words[base + j] = kw[j];
      lensVectorsWritten++;
    }
  }
  return { words, slotAssignments: assignments, anchorsPlaced, edgesWritten, lensesWritten, lensVectorsWritten };
}

const baseOpts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: profile.relationHopBudget ?? 3,
  abstentionThreshold: profile.abstentionThreshold ?? 0.001,
  rerankerTopK: profile.rerankerTopK ?? 10,
  retrievalKeyTopK: profile.retrievalKeyTopK ?? 50,
  firstStageTopK: profile.firstStageTopK ?? 3200,
  rerankerInputTopK: profile.rerankerInputTopK ?? 128,
  lensTopK: profile.lensTopK ?? 36,
  lensWeight: profile.lensWeight ?? 0.4,
  anchorWeight: profile.anchorWeight ?? 0.6,
  relationExpansionBudget: profile.relationExpansionBudget ?? 12,
  categoryLensExpansionBudget: profile.categoryLensExpansionBudget ?? profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.1,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.1,
  lensDiversityFloor: profile.lensDiversityFloor,
  pipelineVersion: profile.pipelineVersion,
};

// Per-cell scoring options: the substrate-viability knobs vary per cell.
// Viability default Phase B budget. The launch-v3 profile pins
// categoryLensExpansionBudget=0 (Phase B disabled for production). The
// viability question requires Phase B turned ON to be measurable, so any
// categoryLenses cell that doesn't pin its own budget gets this default
// (mirrors the historical relationExpansionBudget fallback). Cells that DO
// pin a budget (selective/broad) keep theirs.
const VIABILITY_PHASE_B_BUDGET = profile.relationExpansionBudget ?? 12;

function optsFor(cell) {
  const o = { ...baseOpts };
  if (cell.relationExpansionBudget !== undefined) o.relationExpansionBudget = cell.relationExpansionBudget;
  if (cell.categoryLensExpansionBudget !== undefined) o.categoryLensExpansionBudget = cell.categoryLensExpansionBudget;
  else if (cell.categoryLenses) o.categoryLensExpansionBudget = VIABILITY_PHASE_B_BUDGET;
  if (cell.traversalDirection !== undefined) o.categoryLensTraversalDirection = cell.traversalDirection;
  if (cell.bonusEnabled !== undefined) o.categoryLensBonusEnabled = cell.bonusEnabled;
  if (cell.bonusWeight !== undefined) o.categoryLensBonusWeight = cell.bonusWeight;
  return o;
}

// Cell matrix. `anchors` selects the placement mode; `categoryLenses` /
// `relations` toggle the substrate expansion surfaces; the knob fields
// (traversalDirection / bonusEnabled / *ExpansionBudget) configure Phase B.
const cells = [
  // ── baseline ───────────────────────────────────────────────────────────
  { family: 'baseline', name: 'empty',                  anchors: 'none' },
  { family: 'baseline', name: 'stage1-only',            anchors: 'none' }, // alias of empty; explicit reference point
  { family: 'baseline', name: 'anchor-on-truth',        anchors: 'truth' },
  { family: 'baseline', name: 'anchor-on-answer-alias', anchors: 'answerAlias' },
  { family: 'baseline', name: 'anchor-on-irrelevant',   anchors: 'irrelevant' },
  // ── anchor-scarcity ────────────────────────────────────────────────────
  { family: 'anchor-scarcity', name: 'anchor-budget-1',  anchors: 'truth', anchorBudget: 1 },
  { family: 'anchor-scarcity', name: 'anchor-budget-4',  anchors: 'truth', anchorBudget: 4 },
  { family: 'anchor-scarcity', name: 'anchor-budget-8',  anchors: 'truth', anchorBudget: 8 },
  { family: 'anchor-scarcity', name: 'anchor-budget-full', anchors: 'truth' },
  { family: 'anchor-scarcity', name: 'anchor-both',      anchors: 'both' },
  { family: 'anchor-scarcity', name: 'anchor-both+rels', anchors: 'both', relations: true },
  // ── generalized-routing ────────────────────────────────────────────────
  // The cells below can ONLY beat stage1-only via non-anchor routing.
  { family: 'generalized-routing', name: 'lens-only',                anchors: 'none',       categoryLenses: true },
  { family: 'generalized-routing', name: 'lens-answer-region',       anchors: 'none',       lensVectors: 'truth' },
  { family: 'generalized-routing', name: 'lens-relation-centroid',   anchors: 'none',       lensVectors: 'relation-centroid' },
  { family: 'generalized-routing', name: 'lens-corpus-regions',      anchors: 'none',       lensVectors: 'corpus-regions' },
  { family: 'generalized-routing', name: 'lens-visible-query-targets', anchors: 'none',     lensVectors: 'visible-query-targets' },
  { family: 'generalized-routing', name: 'lens+non-answer-anchors',  anchors: 'irrelevant', categoryLenses: true },
  { family: 'generalized-routing', name: 'phaseA-rels-no-answer-anchor', anchors: 'irrelevant', relations: true },
  { family: 'generalized-routing', name: 'selective-phaseB-fwd-budget-1', anchors: 'none', categoryLenses: true, traversalDirection: 'forward', categoryLensExpansionBudget: 1 },
  { family: 'generalized-routing', name: 'selective-phaseB-fwd-budget-2', anchors: 'none', categoryLenses: true, traversalDirection: 'forward', categoryLensExpansionBudget: 2 },
  { family: 'generalized-routing', name: 'selective-phaseB-fwd-budget-4', anchors: 'none', categoryLenses: true, traversalDirection: 'forward', categoryLensExpansionBudget: 4 },
  { family: 'generalized-routing', name: 'selective-phaseB-bidir-budget-4', anchors: 'none', categoryLenses: true, traversalDirection: 'bidirectional', categoryLensExpansionBudget: 4 },
  { family: 'generalized-routing', name: 'selective-phaseB-no-bonus', anchors: 'none', categoryLenses: true, bonusEnabled: false },
  { family: 'generalized-routing', name: 'broad-phaseB-legacy',      anchors: 'none', categoryLenses: true, traversalDirection: 'bidirectional', categoryLensExpansionBudget: 200 },
];

function aggregateSources(perQuery) {
  const blank = () => ({ stage1: 0, anchorMandatory: 0, anchorBFS: 0, categoryLensBFS: 0 });
  const cap = blank(), rel = blank(), hardNeg = blank();
  let docs = 0, relTotal = 0, hardNegTotal = 0;
  // Decisive generalized-routing metric: relevant top-10 docs reached PURELY
  // by Phase B (categoryLensBFS source present; no anchor source).
  let relevantTop10ViaPhaseBOnly = 0;
  for (const q of perQuery) {
    for (const tags of q.cappedDocSources ?? []) {
      docs++;
      for (const t of tags) if (t in cap) cap[t]++;
    }
    for (const r of q.finalRankingTop20 ?? []) {
      if (r.rank <= 10 && r.relevance > 0) {
        relTotal++;
        for (const t of r.sources) if (t in rel) rel[t]++;
        const src = new Set(r.sources);
        if (src.has('categoryLensBFS') && !src.has('anchorMandatory') && !src.has('anchorBFS')) {
          relevantTop10ViaPhaseBOnly++;
        }
      }
      if (r.rank <= 20 && r.relevance === 0) {
        hardNegTotal++;
        for (const t of r.sources) if (t in hardNeg) hardNeg[t]++;
      }
    }
  }
  const frac = (counts, denom) => denom > 0
    ? Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / denom])) : null;
  return {
    cap: { count: cap, fraction: frac(cap, docs), totalDocs: docs },
    relevantTop10: { count: rel, fraction: frac(rel, relTotal), totalDocs: relTotal },
    hardNegativeTop20: { count: hardNeg, fraction: frac(hardNeg, hardNegTotal), totalDocs: hardNegTotal },
    relevantTop10ViaPhaseBOnly,
  };
}

const activeCells = cellsAllow ? cells.filter((c) => cellsAllow.has(c.name)) : cells;
if (cellsAllow) console.log(`[genroute] cell filter active: running ${activeCells.length}/${cells.length} cells`);

const results = [];
for (const cell of activeCells) {
  const tStart = Date.now();
  const state = buildState(cell);
  const opts = optsFor(cell);
  const score = await evaluateRetrievalBenchmarkState(state, corpus, pack, opts);
  const elapsedMs = Date.now() - tStart;
  const sources = aggregateSources(score.perQuery ?? []);
  console.log(
    `  [${cell.family}] ${cell.name.padEnd(34)} composite=${score.composite.toFixed(4)} ` +
    `nDCG=${score.nDCG10.toFixed(3)} R=${score.recall10.toFixed(3)} multiHop=${score.multiHopRecall10.toFixed(3)} ` +
    `anchors=${state.anchorsPlaced} lenses=${state.lensesWritten} edges=${state.edgesWritten} ` +
    `relViaPhaseBOnly=${sources.relevantTop10ViaPhaseBOnly} ` +
    `hardNegCatLens=${sources.hardNegativeTop20.count.categoryLensBFS} (${(elapsedMs / 1000).toFixed(1)}s)`,
  );
  results.push({
    family: cell.family, cell: cell.name, cellConfig: cell,
    opts: {
      relationExpansionBudget: opts.relationExpansionBudget,
      categoryLensExpansionBudget: opts.categoryLensExpansionBudget,
      categoryLensTraversalDirection: opts.categoryLensTraversalDirection ?? 'bidirectional',
      categoryLensBonusEnabled: opts.categoryLensBonusEnabled ?? true,
      categoryLensBonusWeight: opts.categoryLensBonusWeight ?? opts.lensWeight,
    },
    composite: score.composite,
    nDCG10: score.nDCG10, mrr10: score.mrr10, recall10: score.recall10,
    multiHopRecall10: score.multiHopRecall10,
    categoryLensRelationHit10: score.categoryLensRelationHit10,
    candidateSources: sources,
    substrate: { anchorsPlaced: state.anchorsPlaced, edgesWritten: state.edgesWritten, lensesWritten: state.lensesWritten },
    elapsedMs,
  });
}

const c = (n) => results.find((r) => r.cell === n)?.composite ?? null;
const viaPhaseB = (n) => results.find((r) => r.cell === n)?.candidateSources.relevantTop10ViaPhaseBOnly ?? null;
const hardNegCatLens = (n) => results.find((r) => r.cell === n)?.candidateSources.hardNegativeTop20.count.categoryLensBFS ?? null;

// ── Decision rules (Phase 4) ────────────────────────────────────────────
const stage1 = c('stage1-only');
const anchorTruth = c('anchor-on-truth');
const anchorBudget1 = c('anchor-budget-1');
const lensOnly = c('lens-only');
const selFwd4 = c('selective-phaseB-fwd-budget-4');
const selBidir4 = c('selective-phaseB-bidir-budget-4');
const broadLegacy = c('broad-phaseB-legacy');
const lensOnlyViaPhaseB = viaPhaseB('lens-only');
const selBidir4ViaPhaseB = viaPhaseB('selective-phaseB-bidir-budget-4');

// Anchor scaling: how much of full anchor lift survives at budget 1?
const anchorLiftFull = anchorTruth - stage1;
const anchorLiftAt1 = anchorBudget1 - stage1;
const anchorBudgetRetention = anchorLiftFull !== 0 ? anchorLiftAt1 / anchorLiftFull : null;

// Generalized routing: best non-anchor cell's lift over stage1-only.
const genRouteBest = Math.max(
  lensOnly ?? -Infinity, selFwd4 ?? -Infinity, selBidir4 ?? -Infinity,
);
const genRouteLift = Number.isFinite(genRouteBest) ? genRouteBest - stage1 : null;

// Broad-Phase-B flooding: does the legacy comparator drag hard negatives in?
const broadHardNegFlood = hardNegCatLens('broad-phaseB-legacy');
const selFwd4HardNeg = hardNegCatLens('selective-phaseB-fwd-budget-4');

// Fidelity guard. Under DETERMINISTIC_SMOKE the reranker scores ~constant
// and CANNOT reward a semantically-correct Phase-B-routed doc — so every
// generalized-routing cell collapses to the stage1 floor BY CONSTRUCTION.
// The decision rules below are still computed (they verify the harness +
// knobs + attribution mechanically), but the substrate VERDICT is undefined
// at this fidelity. A real verdict requires the production (Qwen3) reranker,
// which can reward correct routing. Do NOT read directAnchorDominanceRed as
// a substrate conclusion from a deterministic-smoke artifact.
const verdictValid = rerankerArg === 'env';

const decision = {
  verdictValid,
  verdictNote: verdictValid
    ? 'PRODUCTION_RERANKER — decision flags are a substrate verdict.'
    : 'DETERMINISTIC_SMOKE — decision flags exercise harness/knob mechanics ONLY. '
      + 'The deterministic reranker cannot reward correct Phase-B routing, so '
      + 'generalized-routing cells collapse to the stage1 floor by construction. '
      + 'NOT a substrate verdict. Re-run with --reranker env for the verdict.',
  // RED if the substrate is anchor-dominant AND has no generalized routing:
  //   anchor lift is large, generalized routing lift is ~0 or negative, and
  //   no relevant top-10 docs are reached purely via Phase B.
  directAnchorDominanceRed:
    (anchorLiftFull > 0) &&
    ((genRouteLift ?? -1) <= 0) &&
    ((lensOnlyViaPhaseB ?? 0) === 0) && ((selBidir4ViaPhaseB ?? 0) === 0),
  // PASS if a generalized-routing cell beats stage1-only AND reaches relevant
  // truths purely via Phase B.
  generalizedRoutingPass:
    ((genRouteLift ?? -1) > 0) &&
    (((lensOnlyViaPhaseB ?? 0) > 0) || ((selBidir4ViaPhaseB ?? 0) > 0)),
  // selective-Phase-B PASS if a bounded forward/bidir cell gives the lift
  // WITHOUT the hard-negative flooding the legacy broad cell shows.
  selectivePhaseBPass:
    ((selFwd4 ?? -Infinity) > stage1 || (selBidir4 ?? -Infinity) > stage1) &&
    ((broadHardNegFlood ?? 0) >= (selFwd4HardNeg ?? 0)),
  metrics: {
    stage1Composite: stage1,
    anchorLiftFull, anchorLiftAt1, anchorBudgetRetention,
    genRouteLift, lensOnlyViaPhaseB, selBidir4ViaPhaseB,
    broadHardNegFlood, selFwd4HardNeg,
    broadLegacyComposite: broadLegacy,
  },
};

const report = {
  schemaVersion: 'coretex.substrate-generalized-routing.v1',
  generatedAt: new Date().toISOString(),
  provenance: buildProvenance(),
  fidelity: rerankerArg === 'env' ? 'PRODUCTION_RERANKER' : 'DETERMINISTIC_SMOKE',
  scope: 'substrate-design-viability',
  inputs: {
    corpus: corpusPath, corpusRoot: corpus.corpusRoot, eventCount: corpus.events.length,
    bundleProfile: profilePath,
    profileAttestation: profileAttestation(profile, profilePath),
    rerankerMode: rerankerArg, rerankerModel: reranker.model,
    packSize: pack.events.length, packSeedHex: seedHex, targetFamily,
    edgeTypesSpanningPack: [...relatedEdgeTypes],
    pipelineVersion: profile.pipelineVersion,
    rerankerInputTopK: baseOpts.rerankerInputTopK, firstStageTopK: baseOpts.firstStageTopK,
    lensWeight: baseOpts.lensWeight, anchorWeight: baseOpts.anchorWeight,
  },
  results,
  decision,
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[genroute] report → ${reportPath}`);
console.log(`[genroute] anchor lift full=${anchorLiftFull?.toFixed(4)} at-budget-1=${anchorLiftAt1?.toFixed(4)} retention=${anchorBudgetRetention === null ? 'n/a' : anchorBudgetRetention.toFixed(2)}`);
console.log(`[genroute] generalized-routing lift over stage1-only=${genRouteLift === null ? 'n/a' : genRouteLift.toFixed(4)} (relViaPhaseBOnly: lens-only=${lensOnlyViaPhaseB}, selBidir4=${selBidir4ViaPhaseB})`);
console.log(`[genroute] broad-legacy hardNegCatLens=${broadHardNegFlood} vs selFwd4=${selFwd4HardNeg}`);
console.log(`[genroute] DECISION (verdictValid=${decision.verdictValid}): directAnchorDominanceRed=${decision.directAnchorDominanceRed} generalizedRoutingPass=${decision.generalizedRoutingPass} selectivePhaseBPass=${decision.selectivePhaseBPass}`);
if (!decision.verdictValid) console.log(`[genroute] NOTE: ${decision.verdictNote}`);
await reranker.close?.();
exit(0);
