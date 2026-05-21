#!/usr/bin/env node
/**
 * Relation scorer TRACE harness (P2 diagnosis). Proves what categoryLensBFS does INSIDE
 * evaluateRetrievalBenchmarkState on a stratified set of bridge/causal queries, and classifies each at its
 * lowest failing layer:
 *   seed_missing | seed_present_edge_missing | edge_present_answer_not_enqueued | answer_enqueued_not_tagged
 *   | answer_tagged_dropped_before_cap | answer_in_cap_low_final (qwen/noise) | answer_top10_but_junk_floods | OK
 * Uses the real scorer (env-guarded RELTRACE) + deterministic reranker (structural layers are
 * reranker-independent; the in-cap final-rank layer is flagged for the Qwen rerun). No model needed.
 *
 * Usage: node scripts/relation-trace-harness.mjs --corpus <logical.json> --emb <cache.json> [--fst 128] [--cap 64] [--budget 12] [--bonus 10] [--per-bucket 4] [--out dir]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p1-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p1-embeddings.json');
const FST = Number(flag('fst', '128')), CAP = Number(flag('cap', '64')), BUDGET = Number(flag('budget', '12')), BONUS = Number(flag('bonus', '10'));
const PER_BUCKET = Number(flag('per-bucket', '4'));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2');

const {
  evaluateRetrievalBenchmarkState, biEncoderModelIdHash, computeCorpusRoot, createDeterministicReranker,
  buildPublicCorpusIndex, firstStageCandidates, dequantize, encodeRelationCategoryLens, DEFAULT_COMPOSITE_WEIGHTS,
} = await import(distIndex);

const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/bundle-manifest-launch-v3.json'), 'utf8'));
const BE = manifest.model.biEncoder;
const LAYOUT = { dim: BE.retrievalKeyLayout.dim, quantization: BE.retrievalKeyLayout.quantization, headerBytes: BE.retrievalKeyLayout.headerBytes };
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const logical = JSON.parse(readFileSync(corpusPath, 'utf8'));
const cache = JSON.parse(readFileSync(embPath, 'utf8'));
const b64ToVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
function int8Bytes(vec) { let m = 0; for (const v of vec) m = Math.max(m, Math.abs(v)); const s = m > 0 ? m / 127 : 1; const o = new Uint8Array(4 + LAYOUT.dim); new DataView(o.buffer).setFloat32(0, s, false); for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / s); c = Math.max(-127, Math.min(127, c)); o[4 + i] = c & 0xff; } return o; }
const docEmb = new Map(logical.docs.map((d) => [d.id, int8Bytes(b64ToVec(cache.docs[d.id]))]));
const qEmb = new Map(logical.queries.map((q) => [q.id, int8Bytes(b64ToVec(cache.queries[q.id]))]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));
const memId = (id) => `mem_${id}`;
const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const mkEmb = (q, pt, pn) => ({ modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: q, perTruth: new Map(pt), perNegative: new Map(pn) });
const bucketFam = (f) => f === 'temporal_update' ? 'temporal' : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance') ? 'multi_hop_relation' : 'near_collision';

// build production corpus (no-query: mem-doc edges only; query events carry NO query→answer relations)
const relBySrc = new Map();
for (const r of logical.relations) { if (!relBySrc.has(r.src)) relBySrc.set(r.src, []); relBySrc.get(r.src).push(r); }
// public edge index for classification: does mem(bridge) connect to mem(answer) via a lens edge (either dir)?
const edgeUndirected = new Set();
for (const r of logical.relations) { edgeUndirected.add(`${r.src}|${r.dst}`); edgeUndirected.add(`${r.dst}|${r.src}`); }
const events = [];
for (const d of logical.docs) {
  const e = docEmb.get(d.id);
  events.push({ id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible', queryText: d.text,
    truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }],
    hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
    relations: (relBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type })),
    provenance: PROV, embeddings: mkEmb(e, [[d.id, e]], []) });
}
for (const q of logical.queries) {
  if (q.abstain) continue;
  const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => ({ id: r.docId, text: docById.get(r.docId).text, isCurrent: docById.get(r.docId).currentStaleFlag === false ? false : true }));
  const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: docById.get(n.docId).text, category: n.category }));
  const ev = { id: q.id, family: bucketFam(q.family), domain: q.lane, split: q.split ?? 'eval_hidden', queryText: q.queryText,
    truthDocuments: truths, hardNegatives: negs, qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })),
    protected: false, relations: [], provenance: PROV,
    embeddings: mkEmb(qEmb.get(q.id), truths.map((t) => [t.id, docEmb.get(t.id)]), negs.map((n) => [n.id, docEmb.get(n.id)])) };
  events.push(ev);
}
const corpusRoot = computeCorpusRoot(events);
const corpus = { events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot, corpusEpoch: 0,
  biEncoderModelId: BE.modelId, biEncoderRevision: BE.revision, biEncoderRetrievalKeyLayout: LAYOUT,
  labelingModelId: manifest.model.reranker.modelId, labelingModelRevision: manifest.model.reranker.revision };

// substrate: category-lens entries (supports/causes/supersedes/coreference_of)
const RELATIONS_START = 672;
const words = new Array(1024).fill(0n);
['supports', 'causes', 'supersedes', 'coreference_of'].forEach((et, i) => { words[RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: et, weight: 0x8000 }); });
const state = { words };

const reranker = await createDeterministicReranker();
const opts = { weights: DEFAULT_COMPOSITE_WEIGHTS, biEncoder: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, async encode() { throw new Error('unused'); } },
  reranker, retrievalKeyLayout: LAYOUT, biEncoderHash, relationHopBudget: 3, abstentionThreshold: 0.001, rerankerTopK: 10, retrievalKeyTopK: 50,
  firstStageTopK: FST, rerankerInputTopK: CAP, lensTopK: 36, lensWeight: 0.4, anchorWeight: 0.6,
  relationExpansionBudget: 12, categoryLensExpansionBudget: BUDGET, categoryLensTraversalDirection: 'bidirectional', categoryLensBonusWeight: BONUS,
  temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1, pipelineVersion: 'coretex-retrieval-v2-lens-r3' };

// public index for bridge/answer dense-rank stratification (the scorer's int8 stage-1 path)
const pidx = buildPublicCorpusIndex(corpus);
function denseRank(qId, docId) { const qv = dequantize(corpus.byId.get(qId).embeddings.query, LAYOUT); const cands = firstStageCandidates(qv, pidx, corpus.events.length); const r = cands.findIndex((c) => (c.id ?? c.documentId ?? c) === docId); return r >= 0 ? r + 1 : Infinity; }

// stratify bridge/causal eval_hidden queries by bridge dense-rank bucket
const relQ = logical.queries.filter((q) => !q.abstain && (q.family === 'multi_session_bridge' || q.family === 'causal_memory_chain') && (q.split ?? 'eval_hidden') === 'eval_hidden');
function meta(q) {
  const ans = [...q.qrels].sort((a, b) => b.relevance - a.relevance)[0].docId;
  const br = (q.qrels.find((r) => r.role === 'bridge') ?? {}).docId ?? ans;
  return { q, ans, br, brRank: denseRank(q.id, br), ansRank: denseRank(q.id, ans), edge: edgeUndirected.has(`${ans}|${br}`) };
}
const metas = relQ.map(meta);
const strata = {
  bridge_brRank_le128: metas.filter((m) => m.q.family === 'multi_session_bridge' && m.brRank <= 128),
  bridge_brRank_129_512: metas.filter((m) => m.q.family === 'multi_session_bridge' && m.brRank > 128 && m.brRank <= 512),
  bridge_brRank_gt512: metas.filter((m) => m.q.family === 'multi_session_bridge' && m.brRank > 512),
  causal: metas.filter((m) => m.q.family === 'causal_memory_chain'),
};
const sample = [];
for (const [k, arr] of Object.entries(strata)) for (const m of arr.slice(0, PER_BUCKET)) sample.push({ stratum: k, ...m });

// capture RELTRACE from stderr
const origWrite = process.stderr.write.bind(process.stderr);
let captured = null;
process.stderr.write = (s, ...a) => { if (typeof s === 'string' && s.startsWith('RELTRACE ')) { try { captured = JSON.parse(s.slice(9)); } catch { /* */ } return true; } return origWrite(s, ...a); };

function classify(t, m) {
  const ans = t.targets.find((x) => x.doc === m.ans) ?? {};
  const br = t.targets.find((x) => x.doc === m.br) ?? {};
  if (!br.inStage1) return 'seed_missing';
  if (!ans.inPool) return m.edge ? 'edge_present_answer_not_enqueued' : 'seed_present_edge_missing';
  if (!(ans.sources ?? []).includes('categoryLensBFS')) return 'answer_enqueued_not_tagged';
  if (!ans.inCap) return 'answer_tagged_dropped_before_cap';
  if ((ans.finalRank ?? 99) > 10) return 'answer_in_cap_low_final(qwen/noise)';
  if (t.lensJunkTop10 > 1) return 'answer_top10_but_junk_floods';
  return 'OK';
}

const rows = [];
for (const m of sample) {
  process.env.CORETEX_RELTRACE_QID = m.q.id;
  process.env.CORETEX_RELTRACE_DOCS = `${m.ans},${m.br}`;
  captured = null;
  const pack = { epochId: 0, evalSeedCommit: '0x' + 'a5'.repeat(32), corpusRoot, events: [corpus.byId.get(m.q.id)] };
  await evaluateRetrievalBenchmarkState(state, corpus, pack, opts);
  const t = captured;
  const bucket = t ? classify(t, m) : 'NO_TRACE';
  rows.push({ stratum: m.stratum, queryId: m.q.id, family: m.q.family, brRank: m.brRank, ansRank: m.ansRank, edge: m.edge, bucket,
    answer: t?.targets.find((x) => x.doc === m.ans), bridge: t?.targets.find((x) => x.doc === m.br), lensJunkTop10: t?.lensJunkTop10, poolSize: t?.poolSize });
}
process.stderr.write = origWrite;

const bucketCounts = rows.reduce((a, r) => (a[r.bucket] = (a[r.bucket] || 0) + 1, a), {});
const report = { corpus: corpusPath, phase: logical.phase, config: { FST, CAP, BUDGET, BONUS }, n: rows.length, bucketCounts, rows };
const tag = (logical.phase || 'P').toLowerCase();
writeFileSync(resolve(outDir, `RELATION_TRACE_${tag}.json`), JSON.stringify(report, null, 2));
console.log(`# Relation trace (${logical.phase}) — config fst=${FST} cap=${CAP} budget=${BUDGET} bonus=${BONUS}`);
console.log('bucket counts:', JSON.stringify(bucketCounts));
for (const r of rows) console.log(`  [${r.stratum}] ${r.queryId} ${r.family} brRank=${r.brRank} ansRank=${r.ansRank} edge=${r.edge} -> ${r.bucket} (ansSrc=${JSON.stringify(r.answer?.sources)} inCap=${r.answer?.inCap} finalRank=${r.answer?.finalRank} junk=${r.lensJunkTop10})`);
