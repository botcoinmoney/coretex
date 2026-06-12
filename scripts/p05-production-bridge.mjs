#!/usr/bin/env node
/**
 * P0.5 — production-scorer bridge. Confirms the Layer-5 proxy lift reproduces
 * through the REAL `evaluateRetrievalBenchmarkState` decoder/scorer path.
 *
 * Maps the logical V2 corpus → an in-memory ProductionCorpus (every doc becomes a
 * train_visible MEMORY event so the full ~1599-doc pool is present and answers stay
 * buried; every query becomes an eval_hidden QUERY event with relations to its
 * answer's memory event). Family-bucketed onto the decoder's 4-family code
 * (temporal_update→temporal; bridge/causal→multi_hop_relation; else near_collision).
 * Explicit splits, NO split:null.
 *
 * Two real compiled substrates vs an empty substrate (same pool, OFF/ON):
 *   - RELATION arm  : corpus-native categoryLensBFS over public supports/causes edges
 *                     (NO anchoring — driven by stage-1 finding the bridge + the edge).
 *   - TEMPORAL arm  : substrate memory slots + temporal records (suppress stale / boost current).
 * Reads finalRankingTop20 source attribution (categoryLensBFS / temporalBonus).
 *
 * Local gate: --reranker deterministic (plumbing + routing/source-attribution).
 * A100 confirm: --reranker env  (pinned Qwen-0.6B → real quality lift).
 *
 * Usage: node scripts/p05-production-bridge.mjs --corpus <logical.json> --emb <cache.json>
 *        [--pack-size 24] [--reranker deterministic|env] [--out dir]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

// Stream reranker uses the shared scripts/lib/stream-reranker.mjs (fail-fast: startup
// timeout, stderr capture, child-exit rejection, in-flight rejection). The historical
// local copy in this file lacked all of those and was a drift hazard.
const streamReranker = makeStreamReranker;

const argv = process.argv.slice(2);
// HARD GUARD: this is the LEGACY P0.5 bridge. It is STALE for r5/churn/A100 — it does NOT thread public
// aspectTags onto memory docs, carries raw q.split (not the canonical splitForRecord authority), and drops
// continuity labels. Final r5 / churn / A100 runs MUST use buildV2ProductionCorpus
// (scripts/lib/build-v2-production-corpus.mjs). Fail-fast unless explicitly opted into for historical P0.5
// reproduction only.
if (process.env.CORETEX_ALLOW_LEGACY_P05 !== '1') {
  console.error('[p05] REFUSING TO RUN: legacy P0.5 bridge is not r5/churn/A100-safe (no aspectTags, raw q.split, no continuity labels). Use scripts/lib/build-v2-production-corpus.mjs. Set CORETEX_ALLOW_LEGACY_P05=1 only for historical P0.5 reproduction.');
  process.exit(2);
}
const START_T = Date.now();
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p0-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p0-embeddings.json');
const packSize = Math.min(32, Number(flag('pack-size', '24')));
const rerankCap = Number(flag('rerank-cap', '128')); // rerankerInputTopK (lower → fewer Qwen pairs for CPU-bounded runs)
// Relation traversal mode. DEFAULT 'no-query' (P1.5 #2 quarantine): query-event query→answer relations are
// scorer/metric-only and must NEVER be traversed by categoryLensBFS. 'all' (legacy, LEAKY — reproduces the
// query→answer bookmark) and 'no-memory' (query-only) are kept for the leak-ablation smoke.
const relMode = flag('rel-mode', 'no-query');
const junkEdges = Number(flag('junk-edges', '0')); // adversarial: inject N random wrong mem→mem edges
const rerankerArg = flag('reranker', 'deterministic');
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2');

const {
  evaluateRetrievalBenchmarkState, biEncoderModelIdHash, computeCorpusRoot,
  buildPublicCorpusIndex, firstStageCandidates, dequantize,
  createDeterministicBiEncoder, createDeterministicReranker, rerankerFromEnv, biEncoderFromEnv,
  encodeMemoryIndexSlot, encodeRelationCategoryLens, encodeTemporalRecord, stableRecordIdFor,
  DEFAULT_COMPOSITE_WEIGHTS, scoringOptionsFromProfile,
} = await import(distIndex);

// ── bundle bi-encoder pin + layout ──
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/bundle-manifest-v2-ownerscope-candidate.json'), 'utf8'));
const BE = manifest.model.biEncoder;
const LAYOUT = { dim: BE.retrievalKeyLayout.dim, quantization: BE.retrievalKeyLayout.quantization, headerBytes: BE.retrievalKeyLayout.headerBytes };
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');

// ── load logical corpus + embedding cache; reconstruct int8 bytes ──
const logical = JSON.parse(readFileSync(corpusPath, 'utf8'));
const cache = JSON.parse(readFileSync(embPath, 'utf8'));
const b64ToVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
function int8Bytes(vec) { // reconstruct runner wire format: float32-BE scale + dim int8 codes
  let maxAbs = 0; for (const v of vec) maxAbs = Math.max(maxAbs, Math.abs(v));
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const out = new Uint8Array(4 + LAYOUT.dim);
  new DataView(out.buffer).setFloat32(0, scale, false);
  for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / scale); c = Math.max(-127, Math.min(127, c)); out[4 + i] = c & 0xff; }
  return out;
}
const docEmb = new Map(logical.docs.map((d) => [d.id, int8Bytes(b64ToVec(cache.docs[d.id]))]));
const qEmb = new Map(logical.queries.map((q) => [q.id, int8Bytes(b64ToVec(cache.queries[q.id]))]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));

const bucket = (fam) => fam === 'temporal_update' ? 'temporal'
  : (fam === 'multi_session_bridge' || fam === 'causal_memory_chain' || fam === 'decision_provenance') ? 'multi_hop_relation'
  // r5 operation families: first-class buckets (no longer collapsed into near_collision) so
  // per-family quotas/metrics isolate them. Scorer behaviour is unchanged (no family-specific path).
  : fam === 'conflict_lifecycle' ? 'conflict_lifecycle'
  : fam === 'aspect_constraint' ? 'aspect_constraint'
  : fam === 'coreference_resolution' ? 'coreference'
  : 'near_collision';
const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const mkEmb = (queryBytes, perTruth, perNeg) => ({ modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: queryBytes, perTruth: new Map(perTruth), perNegative: new Map(perNeg) });

// ── build ProductionCorpus events ──
// MEMORY events first (so pool dedup assigns each doc's owner = its mem event), train_visible.
const memId = (docId) => `mem_${docId}`;
const events = [];
// logical doc->doc relations grouped by src doc
const relBySrc = new Map();
for (const r of logical.relations) { if (!relBySrc.has(r.src)) relBySrc.set(r.src, []); relBySrc.get(r.src).push(r); }
for (const d of logical.docs) {
  const emb = docEmb.get(d.id);
  events.push({
    id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible',
    queryText: d.text,
    truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }],
    hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
    relations: relMode === 'no-memory' ? [] : (relBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type })),
    // Proposer-visible entity tags: the entity this memory is ABOUT. Drives the
    // scorer's query-text entity resolver → scale-aware seeding.
    ...(Array.isArray(d.entityIds) && d.entityIds.length > 0 ? { entityIds: d.entityIds } : {}),
    provenance: PROV, embeddings: mkEmb(emb, [[d.id, emb]], []),
  });
}
// adversarial: inject N random (semantically WRONG) mem→mem edges of a lens edge-type, to test whether the
// strong categoryLensBonus lets junk edges promote irrelevant docs (gameability). Deterministic by index.
if (junkEdges > 0) {
  const memEvById = new Map(events.map((e) => [e.id, e]));
  const ids = logical.docs.map((d) => memId(d.id));
  let s = 0x9e3779b1 >>> 0; const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s / 4294967296; };
  for (let k = 0; k < junkEdges; k++) {
    const src = memEvById.get(ids[Math.floor(rnd() * ids.length)]);
    const dst = ids[Math.floor(rnd() * ids.length)];
    if (src && dst && dst !== src.id) src.relations = [...(src.relations ?? []), { other_id: dst, edgeType: 'supports' }];
  }
}
// QUERY events, eval_hidden.
for (const q of logical.queries) {
  if (q.abstain) {
    // abstention event: empty truths (scorer treats truthDocuments.length===0 as an abstention probe).
    const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: docById.get(n.docId).text, category: n.category }));
    events.push({ id: q.id, family: bucket(q.family), domain: q.lane, split: q.split ?? 'eval_hidden',
      queryText: q.queryText, truthDocuments: [], hardNegatives: negs, qrels: [], protected: false, relations: [],
      provenance: PROV, embeddings: mkEmb(qEmb.get(q.id), [], negs.map((n) => [n.id, docEmb.get(n.id)])) });
    continue;
  }
  const fam = bucket(q.family);
  const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => {
    const d = docById.get(r.docId);
    const isCurrent = d.currentStaleFlag === false ? false : true;
    return { id: r.docId, text: d.text, isCurrent };
  });
  const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: docById.get(n.docId).text, category: n.category }));
  const perTruth = truths.map((t) => [t.id, docEmb.get(t.id)]);
  const perNeg = negs.map((n) => [n.id, docEmb.get(n.id)]);
  // answer doc = highest-relevance qrel; relation query->mem(answer) for multi-hop metric + routing
  const answer = [...(q.qrels ?? [])].sort((a, b) => b.relevance - a.relevance)[0];
  const relations = (relMode === 'no-query' || !answer) ? [] : [{ other_id: memId(answer.docId), edgeType: q.family === 'causal_memory_chain' ? 'causes' : 'supports' }];
  const ev = {
    id: q.id, family: fam, domain: q.lane, split: q.split ?? 'eval_hidden',
    queryText: q.queryText, truthDocuments: truths, hardNegatives: negs,
    qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })),
    protected: false, relations,
    // PUBLIC owner scope from generation (q.ownerEntityId / q.ownerScoped) — the
    // realistic session/user store the query searches. NEVER derived from qrels.
    ...(q.ownerEntityId !== undefined ? { ownerEntityId: q.ownerEntityId, ownerScoped: q.ownerScoped !== false } : {}),
    // PUBLIC subject grounding (exact entity id) — collision-proof selector input for r5 admission.
    ...(q.subjectEntityId !== undefined ? { subjectEntityId: q.subjectEntityId } : {}),
    provenance: PROV, embeddings: mkEmb(qEmb.get(q.id), perTruth, perNeg),
  };
  if (fam === 'temporal') {
    ev.temporal = { validFromEpoch: 1, validUntilEpoch: Number.MAX_SAFE_INTEGER, currentStaleFlag: false };
  }
  events.push(ev);
}
const corpusRoot = computeCorpusRoot(events);
const corpus = {
  events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot, corpusEpoch: 0,
  // Proposer-visible entity table for the scorer's query-text resolver.
  entities: (logical.entities ?? []).map((e) => ({ id: e.id, canonicalName: e.canonicalName, aliases: e.aliases ?? [] })),
  biEncoderModelId: BE.modelId, biEncoderRevision: BE.revision, biEncoderRetrievalKeyLayout: LAYOUT,
  labelingModelId: manifest.model.reranker.modelId, labelingModelRevision: manifest.model.reranker.revision,
};

// ── build packs (≤ packSize, SPLIT-PURE eval_hidden, multi-seed via --pack-seed) ──
const packSeed = flag('pack-seed', 'a5');
const seedHex = '0x' + (packSeed.length >= 2 ? packSeed.slice(0, 2) : 'a5').repeat(32);
// deterministic shuffle keyed by packSeed (so ≥3 seeds give distinct eval subsets)
function hseed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const shuf = (arr) => arr.map((x) => [x, hseed(`${packSeed}:${x.id}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
// Optional realism-slice filter: restrict relation families to one grounding band
// (distant = maximally lexically-distant answer; partial = weak subject reference).
const groundingFilter = flag('grounding', '');
// Grounding filter constrains ONLY queries that carry a grounding field (bridge family);
// temporal/causal/coref queries have none and must pass through unaffected (else the
// temporal pack empties → false temporal=0).
const leverQ = (famLogical) => shuf(logical.queries.filter((q) => !q.abstain && q.family === famLogical && (q.split ?? 'eval_hidden') === 'eval_hidden' && (!groundingFilter || q.grounding === undefined || q.grounding === groundingFilter)).map((q) => corpus.byId.get(q.id)));
const relationPack = [...leverQ('multi_session_bridge').slice(0, Math.floor(packSize / 2)), ...leverQ('causal_memory_chain').slice(0, packSize - Math.floor(packSize / 2))].slice(0, packSize);
const temporalPack = leverQ('temporal_update').slice(0, packSize);

// ── substrate states ──
const RANGES = { MEMORY_INDEX_START: 32, RELATIONS_START: 672, TEMPORAL_START: 800 };
const emptyWords = () => new Array(1024).fill(0n);

function relationSubstrate() {
  // categoryLensBFS: category-lens entries for supports/causes/supersedes at top entryIndices.
  const words = emptyWords();
  const edges = ['supports', 'causes', 'supersedes', 'coreference_of'];
  for (let i = 0; i < edges.length; i++) {
    words[RANGES.RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: edges[i], weight: 0x8000 });
  }
  return { words };
}

function temporalSubstrate(pack) {
  // For each temporal query: memory slots for the stale + current doc's MEM events + a temporal record.
  const words = emptyWords();
  let slot = 0, rec = 0;
  for (const q of pack) {
    // Temporal RECORD capacity is 96 (stride-1). But each current/stale PAIR uses two
    // MemoryIndex slots whose retrievalSlot must be < 36, so curSlot=slot+1 < 36 caps the
    // patch-family at 18 temporal pairs end-to-end (NOT 96). This is the honest ceiling.
    // Tier-2 (stride-1 + retrievalSlot decoupled): pair cap is now the Temporal region (96
    // records) / MemoryIndex slot count (352), NOT the old retrievalSlot<36 → 18.
    if (rec >= 96 || slot + 1 >= 352) break;
    const lq = logical.queries.find((x) => x.id === q.id);
    const cur = lq.qrels.find((r) => r.role === 'direct'); const stale = lq.qrels.find((r) => r.role === 'stale');
    if (!cur || !stale) continue;
    const staleSlot = slot++, curSlot = slot++;
    const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(memId(stale.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: 0, expiryEpoch: 0n });
    words[RANGES.MEMORY_INDEX_START + staleSlot] = sw[0]; // Tier-2 stride-1: one word per slot
    const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(memId(cur.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n });
    words[RANGES.MEMORY_INDEX_START + curSlot] = cw[0]; // Tier-2 stride-1: one word per slot
    const tw = encodeTemporalRecord({ recordIndex: rec, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
    for (let j = 0; j < tw.length; j++) words[RANGES.TEMPORAL_START + rec * tw.length + j] = tw[j]; // stride-1 temporal records
    rec++;
  }
  return { words };
}

// ── scoring options ──
// Inert bi-encoder stub: the scorer never calls encode() (corpus/query embeddings are
// pre-baked), and createDeterministicBiEncoder is refused under CORETEX_RERANKER_PRODUCTION=1.
const biEncoder = { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, async encode() { throw new Error('biEncoder.encode not used — embeddings are pre-baked'); } };
const RR = manifest.model.reranker;
const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu'
  ? streamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : rerankerArg === 'env' ? await rerankerFromEnv() : await createDeterministicReranker();
// CANONICAL base: scoring options from the signed V2 profile (single source of
// truth), then CALIBRATION sweep overrides on top (this is a sweep/diagnostic
// tool; OFF/ON arms + CLI flags vary specific knobs). lensWeight/anchorWeight/
// temporal/hop/abstention/pipelineVersion come from the profile.
const V2_PROFILE = JSON.parse(readFileSync(resolve(repoRoot, flag('profile', 'release/bundle/evaluator-profile-v2-ownerscope-r1.json')), 'utf8'));
const baseOpts = {
  ...scoringOptionsFromProfile(V2_PROFILE, { biEncoder, reranker, biEncoderHash, retrievalKeyLayout: LAYOUT }),
  // sweep overrides:
  firstStageTopK: (() => { const i = argv.indexOf('--first-stage-topk'); return i >= 0 ? Number(argv[i + 1]) : (V2_PROFILE.firstStageTopK ?? 3200); })(),
  rerankerInputTopK: rerankCap,
  categoryLensExpansionBudget: 0, // base/OFF arm; relOptsOn overrides
  ownerScopeMode: flag('owner-scope', V2_PROFILE.ownerScopeMode ?? 'restrict'),
  pipelineVersion: 'coretex-retrieval-v2-lens-r3',
};
const lensBonusWeight = (() => { const i = argv.indexOf('--lens-bonus-weight'); return i >= 0 ? Number(argv[i + 1]) : undefined; })();
// Non-flooding promotion: FINAL-reorder lens bonus. Default 0 = INCLUSION-ONLY
// (category-lens admits to the cap; the reranker decides final order). Pass a
// value to restore a final additive bonus (legacy/flood-prone) for comparison.
const lensFinalBonusWeight = (() => { const i = argv.indexOf('--lens-final-bonus-weight'); return i >= 0 ? Number(argv[i + 1]) : 0; })();
const catBudget = (() => { const i = argv.indexOf('--cat-budget'); return i >= 0 ? Number(argv[i + 1]) : 50; })();
// Score-inheritance alpha (default 0 = off). When >0, ON arm lets a lens-linked
// answer inherit a bounded fraction of its bridge's reranker score.
const lensInherit = (() => { const i = argv.indexOf('--lens-inherit'); return i >= 0 ? Number(argv[i + 1]) : 0; })();
// Precise-admission: seed the category-lens BFS only from the top-K most query-similar
// stage-1 docs (0/undefined = legacy all-stage-1-seed). Deep universes need a small K.
const lensSeedTopK = (() => { const i = argv.indexOf('--lens-seed-topk'); return i >= 0 ? Number(argv[i + 1]) : undefined; })();
// Evidence-bundle reranking: score routed answer together with its bridge (final-surfacing fix).
const evidenceBundle = argv.includes('--evidence-bundle');
// Traversal: 'forward' admits only the seed's forward edge-targets (the direct bridge→answer hop,
// minimal cluster); 'bidirectional' (default) also pulls inverse-edge cluster (more collateral).
const traversal = (() => { const i = argv.indexOf('--traversal'); return i >= 0 ? argv[i + 1] : 'bidirectional'; })();
// Lens-specific hop budget: 1 admits only direct routed-edge targets of the query-similar seed
// (the answer), excluding the answer's 2-hop sibling cluster (induced-junk source).
const lensHopBudget = (() => { const i = argv.indexOf('--lens-hop-budget'); return i >= 0 ? Number(argv[i + 1]) : undefined; })();
const relOptsOff = { ...baseOpts, categoryLensExpansionBudget: 0 };
const relOptsOn = { ...baseOpts, categoryLensExpansionBudget: catBudget, categoryLensTraversalDirection: traversal,
  categoryLensFinalBonusWeight: lensFinalBonusWeight, categoryLensScoreInheritance: lensInherit,
  ...(lensSeedTopK !== undefined ? { categoryLensSeedTopK: lensSeedTopK } : {}),
  ...(lensHopBudget !== undefined ? { categoryLensHopBudget: lensHopBudget } : {}),
  ...(evidenceBundle ? { categoryLensEvidenceBundle: true } : {}),
  ...(lensBonusWeight !== undefined ? { categoryLensBonusWeight: lensBonusWeight } : {}) };
const tempOptsOff = { ...baseOpts, temporalCurrentBoost: 0, temporalStaleSuppression: 0 };
const tempOptsOn = { ...baseOpts, temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1 };

const mkPack = (evs) => ({ epochId: 0, evalSeedCommit: seedHex, corpusRoot, events: evs });

console.error(`[p05] corpus events=${events.length} (mem=${logical.docs.length}, query=${events.length - logical.docs.length}); relationPack=${relationPack.length} temporalPack=${temporalPack.length}; reranker=${rerankerArg}`);

// ── ABSTENTION-SEPARABILITY mode (P1.5 #6): threshold stats on top1Score ──
// Mixed eval_hidden pack of abstention (no truth) + answerable queries; collect top1Score; compute
// ROC-AUC + best balanced-accuracy threshold. Proves whether a global score threshold can gate abstention.
if (argv.includes('--abstention')) {
  // Threshold CALIBRATION (not held-out): use all abstention queries (small per-split) vs a matched
  // answerable sample from non-train splits. AUC/threshold is a global-score-cutoff calibration estimate.
  const abstainQ = shuf(logical.queries.filter((q) => q.abstain).map((q) => corpus.byId.get(q.id))).slice(0, packSize);
  const answerableQ = shuf(logical.queries.filter((q) => !q.abstain && (q.split === 'eval_hidden' || q.split === 'calibration')).map((q) => corpus.byId.get(q.id))).slice(0, abstainQ.length);
  const mixed = [...abstainQ, ...answerableQ];
  const sc = await evaluateRetrievalBenchmarkState({ words: emptyWords() }, corpus, mkPack(mixed), baseOpts);
  const rows = (sc.perQuery ?? []).map((pq) => ({ id: pq.recordId, abstain: corpus.byId.get(pq.recordId)?.truthDocuments.length === 0, top1: pq.top1Score }));
  const pos = rows.filter((r) => !r.abstain).map((r) => r.top1); // answerable
  const neg = rows.filter((r) => r.abstain).map((r) => r.top1);   // abstain
  // ROC-AUC (P(answerable top1 > abstain top1))
  let wins = 0, ties = 0; for (const p of pos) for (const n of neg) { if (p > n) wins++; else if (p === n) ties++; }
  const auc = pos.length && neg.length ? (wins + 0.5 * ties) / (pos.length * neg.length) : null;
  // best balanced-accuracy threshold over candidate cutoffs
  const cuts = [...new Set([...pos, ...neg])].sort((a, b) => a - b);
  let best = { thr: null, bacc: 0, tpr: 0, tnr: 0 };
  for (const t of cuts) {
    const tpr = pos.filter((x) => x >= t).length / (pos.length || 1); // answerable correctly above
    const tnr = neg.filter((x) => x < t).length / (neg.length || 1);  // abstain correctly below
    const bacc = (tpr + tnr) / 2;
    if (bacc > best.bacc) best = { thr: +t.toFixed(4), bacc: +bacc.toFixed(3), tpr: +tpr.toFixed(3), tnr: +tnr.toFixed(3) };
  }
  const mean = (a) => a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(4) : null;
  const out = { provenance: { specVersion: logical.specVersion, corpusRoot, gitSha: (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })(), reranker: rerankerArg, packSeed, n: { abstain: neg.length, answerable: pos.length } },
    auc, answerableTop1Mean: mean(pos), abstainTop1Mean: mean(neg), bestThreshold: best,
    viableGlobalThreshold: auc != null && auc >= 0.9 && best.bacc >= 0.85 };
  writeFileSync(resolve(outDir, `P05_ABSTENTION_${(rerankerArg === 'env' || rerankerArg === 'gpu' || rerankerArg === 'cpu') ? 'qwen' : 'det'}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  if (typeof reranker.close === 'function') reranker.close();
  process.exit(0);
}

// ── run arms ──
const empty = { words: emptyWords() };
const relOff = await evaluateRetrievalBenchmarkState(empty, corpus, mkPack(relationPack), relOptsOff);
const relOn = await evaluateRetrievalBenchmarkState(relationSubstrate(), corpus, mkPack(relationPack), relOptsOn);
const tmpOff = await evaluateRetrievalBenchmarkState(empty, corpus, mkPack(temporalPack), tempOptsOff);
const tmpOn = await evaluateRetrievalBenchmarkState(temporalSubstrate(temporalPack), corpus, mkPack(temporalPack), tempOptsOn);

// debug: inspect why memory-doc routing does/doesn't tag the answer (P1.5 #3)
if (argv.includes('--debug')) {
  // int8 stage-1 rank check (the scorer's ACTUAL stage-1 path) for bridge/answer docs
  const pidx = buildPublicCorpusIndex(corpus);
  const docOrderById = (qEv) => {
    const qv = dequantize(qEv.embeddings.query, LAYOUT);
    const cands = firstStageCandidates(qv, pidx, corpus.events.length); // full ranking
    const m = new Map(); cands.forEach((c, r) => m.set(c.id ?? c.documentId ?? c, r + 1));
    return m;
  };
  const lq2 = new Map(logical.queries.map((q) => [q.id, q]));
  for (let i = 0; i < Math.min(4, relationPack.length); i++) {
    const ev = relationPack[i]; const q = lq2.get(ev.id);
    const ans = [...(q.qrels ?? [])].sort((a, b) => b.relevance - a.relevance)[0]?.docId;
    const br = (q.qrels ?? []).find((r) => r.role === 'bridge')?.docId;
    const ranks = docOrderById(ev);
    console.error(`[int8-stage1] ${ev.id} bridgeDoc=${br}@${ranks.get(br)} answerDoc=${ans}@${ranks.get(ans)} (firstStageTopK=${baseOpts.firstStageTopK})`);
  }
  const lq = new Map(logical.queries.map((q) => [q.id, q]));
  for (let i = 0; i < Math.min(3, relationPack.length); i++) {
    const ev = relationPack[i]; const pq = relOn.perQuery?.[i];
    const q = lq.get(ev.id);
    const answerDoc = [...(q.qrels ?? [])].sort((a, b) => b.relevance - a.relevance)[0]?.docId;
    const bridgeDoc = (q.qrels ?? []).find((r) => r.role === 'bridge')?.docId;
    const inCapped = (id) => { const k = (pq?.cappedDocIds ?? []).indexOf(id); return k >= 0 ? (pq.cappedDocSources?.[k] ?? []).join('+') : 'NOT-IN-POOL'; };
    const inTop20 = (id) => { const r = (pq?.finalRankingTop20 ?? []).find((x) => x.docId === id); return r ? `rank${r.rank}[${(r.sources ?? []).join('+')}]` : 'not-top20'; };
    console.error(`[debug] ${ev.id} answer=${answerDoc} bridge=${bridgeDoc}`);
    console.error(`   answer: pool=${inCapped(answerDoc)} | ${inTop20(answerDoc)}`);
    console.error(`   bridge: pool=${inCapped(bridgeDoc)} | ${inTop20(bridgeDoc)}`);
  }
}

// hard-negative flood: mean # of the query's hard negatives appearing in finalRankingTop20 (top-20)
const negsById = new Map(logical.queries.map((q) => [q.id, new Set((q.hardNegatives ?? []).map((n) => n.docId))]));
function pctl(sorted, p) { if (!sorted.length) return 0; const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length)); return sorted[i]; }
function floodStats(score) {
  let n = 0, sum = 0, max = 0;
  const junkArr = []; const offenders = []; // per-query lens junk + query-ids exceeding tail
  for (const pq of score.perQuery ?? []) {
    const negs = negsById.get(pq.recordId) ?? new Set();
    const top = pq.finalRankingTop20 ?? [];
    const c = top.filter((r) => r.rank <= 20 && negs.has(r.docId)).length;
    // adversarial/gameability: irrelevant (relevance 0) doc routed into top-10 via categoryLensBFS
    const junk = top.filter((r) => r.rank <= 10 && (r.relevance ?? 0) === 0 && (r.sources ?? []).includes('categoryLensBFS')).length;
    n++; sum += c; junkArr.push(junk); if (c > max) max = c;
    if (junk >= 3) offenders.push({ id: pq.recordId, junk }); // tail-gate offenders (p95<=3, max<=4)
  }
  const sorted = [...junkArr].sort((a, b) => a - b);
  const mean = n ? junkArr.reduce((a, b) => a + b, 0) / n : 0;
  return { meanHardNegInTop20: n ? +(sum / n).toFixed(3) : null, maxHardNegInTop20: max,
    meanLensJunkInTop10: +mean.toFixed(3), p95LensJunkInTop10: pctl(sorted, 0.95), maxLensJunkInTop10: sorted.length ? sorted[sorted.length - 1] : 0,
    junkOffenderIds: offenders.sort((a, b) => b.junk - a.junk).slice(0, 10) };
}
// Bridge-seed capture: for relation queries, did the public bridge SEED (qrels role 'bridge')
// land in the final top-20 (necessary for the lens to route from it to the buried answer)?
// And was the buried direct answer reached via categoryLensBFS (routing succeeded)?
function bridgeCapture(score) {
  let n = 0, seedInTop20 = 0, answerViaLens = 0;
  for (const pq of score.perQuery ?? []) {
    const lq = logical.queries.find((q) => q.id === pq.recordId); if (!lq) continue;
    const bridgeDoc = (lq.qrels ?? []).find((r) => r.role === 'bridge')?.docId;
    const ansDoc = (lq.qrels ?? []).find((r) => r.role === 'direct')?.docId;
    if (!bridgeDoc && !ansDoc) continue;
    n++;
    const top = pq.finalRankingTop20 ?? [];
    if (bridgeDoc && top.some((r) => r.docId === bridgeDoc)) seedInTop20++;
    const ans = top.find((r) => r.docId === ansDoc && r.rank <= 10);
    if (ans && (ans.sources ?? []).includes('categoryLensBFS')) answerViaLens++;
  }
  return { n, bridgeSeedInTop20Rate: n ? +(seedInTop20 / n).toFixed(3) : null, answerViaLensTop10Rate: n ? +(answerViaLens / n).toFixed(3) : null };
}
// Explicit surfacing metrics (per operator): is the EXACT direct target surfaced cleanly,
// or is the substrate just lifting a cluster? All from PUBLIC structure + the ranking; the
// qrels roles are used only for MEASUREMENT (not by the scorer).
function surfacingStats(score, seedTopK) {
  let n = 0, bridgeInCap = 0, bridgeInTopK = 0, directInCap = 0, directTop10 = 0, viaLens = 0;
  const clusterSizes = [], nonTargetLifted = [];
  for (const pq of score.perQuery ?? []) {
    const lq = logical.queries.find((q) => q.id === pq.recordId); if (!lq) continue;
    const bridgeDoc = (lq.qrels ?? []).find((r) => r.role === 'bridge')?.docId;
    const ansDoc = (lq.qrels ?? []).find((r) => r.role === 'direct')?.docId;
    if (!ansDoc) continue; n++;
    const cap = pq.cappedDocIds ?? [], capSrc = pq.cappedDocSources ?? [];
    const top = pq.finalRankingTop20 ?? [];
    const aCap = cap.indexOf(ansDoc), bCap = bridgeDoc ? cap.indexOf(bridgeDoc) : -1;
    if (bCap >= 0) { bridgeInCap++; if (bCap < (seedTopK || 64)) bridgeInTopK++; }
    if (aCap >= 0) directInCap++;
    const aTop = top.find((r) => r.docId === ansDoc && r.rank <= 10);
    if (aTop) { directTop10++; if ((aTop.sources ?? []).includes('categoryLensBFS')) viaLens++; }
    // cluster admitted = #docs in cap sourced categoryLensBFS; non-target lifted = lens-sourced
    // docs in top-10 that are NOT the direct answer (cluster collateral surfacing).
    let cluster = 0; for (const s of capSrc) if ((s ?? []).includes('categoryLensBFS')) cluster++;
    clusterSizes.push(cluster);
    let nonTgt = 0; for (const r of top) if (r.rank <= 10 && r.docId !== ansDoc && r.docId !== bridgeDoc && (r.sources ?? []).includes('categoryLensBFS')) nonTgt++;
    nonTargetLifted.push(nonTgt);
  }
  const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : 0;
  return { n, seedTopK: seedTopK ?? null,
    bridgeSeedInCapRate: n ? +(bridgeInCap / n).toFixed(3) : null,
    bridgeSeedInTopKRate: n ? +(bridgeInTopK / n).toFixed(3) : null,
    directTargetInCapRate: n ? +(directInCap / n).toFixed(3) : null,
    directTargetTop10Rate: n ? +(directTop10 / n).toFixed(3) : null,
    answerViaLensTop10Rate: n ? +(viaLens / n).toFixed(3) : null,
    clusterSizeAdmittedMean: mean(clusterSizes),
    nonTargetPeersLiftedTop10Mean: mean(nonTargetLifted) };
}
// LEGITIMACY guard: the substrate must NOT effectively hardcode answer selection. If the
// EXACT direct target reaches top-10 far more than the bridge seed it routes from, or the
// cluster is suspiciously precise (≈1 admitted doc that is always the answer), flag it —
// honest routing surfaces a cluster the reranker must still resolve, not the gold alone.
function legitimacyFlags(surf) {
  const flags = [];
  // a near-1.0 direct-top10 with near-0 non-target lift + cluster≈1 would look like answer-selection.
  if ((surf.directTargetTop10Rate ?? 0) > 0.9 && (surf.clusterSizeAdmittedMean ?? 9) < 1.5) flags.push('SUSPECT_answer_selection: near-perfect direct surfacing with ~1 admitted doc');
  return { suspectAnswerSelection: flags.length > 0, flags };
}
// SUBSTRATE-INDUCED flood/lift (paired ON vs OFF, same pack order). The honest
// gameability gate: irrelevant docs the substrate PUSHED into top-10 (ON rank≤10
// but OFF rank>10), separated from the GOOD lift (relevant docs it pulled in).
// Avoids the tag-based meanLensJunkInTop10 artifact, which over-counts docs that
// were already in OFF's top-10 (now merely tagged) under owner-scope.
function inducedDelta(onScore, offScore) {
  const offByRec = new Map((offScore.perQuery ?? []).map((pq) => [pq.recordId, pq]));
  let n = 0, junkIn = 0, junkInMax = 0, liftIn = 0;
  for (const on of onScore.perQuery ?? []) {
    const off = offByRec.get(on.recordId); if (!off) continue;
    n++;
    const offRank = new Map((off.finalRankingTop20 ?? []).map((r) => [r.docId, r.rank]));
    const rank = (id) => offRank.get(id) ?? 999; // not in OFF top-20 ⇒ >10
    const onTop = (on.finalRankingTop20 ?? []).filter((r) => r.rank <= 10);
    const j = onTop.filter((r) => (r.relevance ?? 0) === 0 && rank(r.docId) > 10).length;
    const l = onTop.filter((r) => (r.relevance ?? 0) >= 0.8 && rank(r.docId) > 10).length;
    junkIn += j; liftIn += l; if (j > junkInMax) junkInMax = j;
  }
  return { meanInducedJunkTop10: n ? +(junkIn / n).toFixed(3) : null, maxInducedJunkTop10: junkInMax,
    meanInducedLiftTop10: n ? +(liftIn / n).toFixed(3) : null, n };
}
// categoryLensBFS attribution: relevant doc in top-10 reached via categoryLensBFS
const logFamById = new Map(logical.queries.map((q) => [q.id, q.family]));
function bfsAttribution(score) {
  let n = 0, viaLens = 0;
  const byFam = {};
  for (const pq of score.perQuery ?? []) {
    n++;
    const lf = logFamById.get(pq.recordId) ?? pq.family;
    byFam[lf] = byFam[lf] || { n: 0, hit: 0 };
    byFam[lf].n++;
    const top = pq.finalRankingTop20 ?? [];
    const hit = top.some((r) => r.rank <= 10 && r.relevance >= 0.8 && (r.sources ?? []).includes('categoryLensBFS'));
    if (hit) { viaLens++; byFam[lf].hit++; }
  }
  const perFamily = Object.fromEntries(Object.entries(byFam).map(([f, o]) => [f, +(o.hit / o.n).toFixed(3)]));
  return { n, viaLens, perFamily };
}
const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
// Gate-required provenance: dist (scorer) hash + dirty-tree waiver + reranker revision.
const distHash = (() => { try { return execSync('sha256sum packages/coretex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
const RRev = manifest.model.reranker.revision;

const report = {
  provenance: { specVersion: logical.specVersion, corpusRoot, gitSha, distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: (rerankerArg === 'env' || rerankerArg === 'gpu' || rerankerArg === 'cpu') ? `Qwen/Qwen3-Reranker-0.6B@${RRev} (${rerankerArg})` : 'deterministic-stub',
    biEncoder: BE.modelId, layout: LAYOUT, packSizeCap: packSize, rerankerInputTopK: rerankCap, relMode, packSeed,
    ownerScopeMode: baseOpts.ownerScopeMode, categoryLensFinalBonusWeight: lensFinalBonusWeight, categoryLensScoreInheritance: lensInherit, categoryLensSeedTopK: lensSeedTopK ?? null, categoryLensHopBudget: lensHopBudget ?? null, categoryLensEvidenceBundle: evidenceBundle, categoryLensTraversalDirection: traversal,
    firstStageTopK: baseOpts.firstStageTopK, categoryLensBonusWeight: lensBonusWeight ?? 'default', junkEdges, splits: { memory: 'train_visible', queries: 'logical (split-pure eval_hidden pack)' } },
  relation: {
    pack: relationPack.map((e) => e.id), n: relationPack.length,
    off: { nDCG10: relOff.nDCG10, recall10: relOff.recall10, multiHopRecall10: relOff.multiHopRecall10, categoryLensRelationHit10: relOff.categoryLensRelationHit10 },
    on: { nDCG10: relOn.nDCG10, recall10: relOn.recall10, multiHopRecall10: relOn.multiHopRecall10, categoryLensRelationHit10: relOn.categoryLensRelationHit10 },
    attribution: { off: bfsAttribution(relOff), on: bfsAttribution(relOn) },
    flood: { off: floodStats(relOff), on: floodStats(relOn) },
    bridgeCapture: { off: bridgeCapture(relOff), on: bridgeCapture(relOn) },
    surfacing: { on: surfacingStats(relOn, lensSeedTopK) },
    legitimacy: legitimacyFlags(surfacingStats(relOn, lensSeedTopK)),
    induced: inducedDelta(relOn, relOff),
  },
  temporal: {
    pack: temporalPack.map((e) => e.id), n: temporalPack.length,
    off: { nDCG10: tmpOff.nDCG10, recall10: tmpOff.recall10, temporal: tmpOff.temporal },
    on: { nDCG10: tmpOn.nDCG10, recall10: tmpOn.recall10, temporal: tmpOn.temporal },
    flood: { off: floodStats(tmpOff), on: floodStats(tmpOn) },
  },
  cost: { qwenPairsApprox: rerankCap * (relationPack.length * 2 + temporalPack.length * 2), wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1) },
};
const suffix = (rerankerArg === 'env' || rerankerArg === 'gpu' || rerankerArg === 'cpu') ? 'qwen' : 'det';
const relTag = relMode === 'all' ? '' : `_${relMode}`;
// Run-specific filename so D1/D2/cap/seed/alpha runs don't overwrite each other (audit provenance).
const phaseTag = (logical.phase || 'p').toLowerCase().replace(/[^a-z0-9]+/g, '');
const nsTag = logical.deepRemap ? `_ns${logical.deepRemap.namespaces}` : '';
const runTag = `${phaseTag}${nsTag}_cap${rerankCap}_a${String(lensInherit).replace('.', 'p')}${lensSeedTopK !== undefined ? '_seed' + lensSeedTopK : ''}${lensHopBudget !== undefined ? '_h' + lensHopBudget : ''}${groundingFilter ? '_g' + groundingFilter : ''}_${packSeed}`;
const outName = `P05_PRODUCTION_BRIDGE_${phaseTag}_${suffix}${relTag}_${runTag}.json`;
writeFileSync(resolve(outDir, outName), JSON.stringify(report, null, 2));
console.error(`[p05] wrote ${outName}`);
console.log(JSON.stringify(report, null, 2));
if (typeof reranker.close === 'function') reranker.close();
