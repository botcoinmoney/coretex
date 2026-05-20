#!/usr/bin/env node
/**
 * Track 1 — teacher memory retriever (substrate-compiler sprint).
 *
 * Question 1: can a strong, PROPOSER-VISIBLE, query-time retriever produce real
 * generalized lift WITHOUT hidden-qrel leakage? Built closest-to-CoreTex:
 *   dense stage1  +  BM25 / RRF  +  [entity/region linker + relation traversal]  +  Qwen utility rerank
 *
 * Leakage discipline (labeled in the report):
 *   proposer-visible — query TEXT + query EMBEDDING (the retriever's input at eval
 *     time), corpus doc texts + embeddings + the corpus relation graph.
 *   scorer-only      — qrels / relevance labels (used ONLY to score, never to retrieve).
 *   FORBIDDEN        — the query event's OWN stored relations / truthDocuments
 *     (those encode the answer; using them is the oracle leakage we already flagged).
 *
 * This file builds incrementally. LAYER 1 (here): dense + BM25 + RRF, measured by
 * recall@K of qrel-relevant docs vs dense-only — does retrieval fusion even SURFACE
 * the answer into a rerankable pool? Qwen + entity/graph layers come next.
 *
 * Usage:
 *   node scripts/teacher-retriever.mjs --corpus <cal.json> --split eval_hidden --pack-size 10 --layer fusion
 */
import { distIndex } from './_repo-root.mjs';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';

function flag(n, fb) { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; }
const corpusPath = flag('corpus', '/var/lib/coretex/corpus-epoch-0-calibration-relation-qrels.json');
const packSplit = flag('split', 'eval_hidden');
const packSize = Number(flag('pack-size', '10'));
const seedHex = flag('seed', '0x' + 'c7'.repeat(32));
const targetFamily = flag('family', 'multi_hop_relation');
const reportPath = flag('out', '/var/lib/coretex/reports/teacher-fusion.json');
if (!existsSync(corpusPath)) { console.error('corpus missing'); exit(1); }

const { loadProductionCorpus, dequantize, cosineSimilarity } = await import(distIndex);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
const layout = corpus.biEncoderRetrievalKeyLayout;
console.log(`[teacher] ${corpus.events.length} events; layout dim=${layout.dim}`);

// ── Doc table: every truth+negative doc, with text + embedding + owning event ──
const docs = [];           // { id, text, vec, eventId }
for (const ev of corpus.events) {
  for (const t of ev.truthDocuments) { const b = ev.embeddings.perTruth.get(t.id); if (b) docs.push({ id: t.id, text: t.text, vec: dequantize(b, layout), eventId: ev.id }); }
  for (const n of ev.hardNegatives) { const b = ev.embeddings.perNegative.get(n.id); if (b) docs.push({ id: n.id, text: n.text, vec: dequantize(b, layout), eventId: ev.id }); }
}
const docIndexById = new Map(docs.map((d, i) => [d.id, i]));
console.log(`[teacher] doc table: ${docs.length} docs`);

// ── BM25 index over doc texts (proposer-visible) ──────────────────────────────
function tokenize(s) { return String(s).toLowerCase().match(/[a-z0-9$]+/g) ?? []; }
const N = docs.length;
const df = new Map();
const docTokens = docs.map((d) => {
  const toks = tokenize(d.text);
  const seen = new Set();
  for (const t of toks) if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) ?? 0) + 1); }
  return toks;
});
const avgdl = docTokens.reduce((s, t) => s + t.length, 0) / Math.max(1, N);
const docTF = docTokens.map((toks) => { const m = new Map(); for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1); return m; });
const idf = (t) => { const n = df.get(t) ?? 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); };
const K1 = 1.2, B = 0.75;
function bm25Scores(queryTerms) {
  const scores = new Float64Array(N);
  const qset = [...new Set(queryTerms)];
  for (let i = 0; i < N; i++) {
    const tf = docTF[i]; const dl = docTokens[i].length; let s = 0;
    for (const t of qset) { const f = tf.get(t); if (!f) continue; s += idf(t) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / avgdl)); }
    scores[i] = s;
  }
  return scores;
}

// ── Query pack (split-pure) ───────────────────────────────────────────────────
function shaIdx(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff; return h >>> 0; }
const cands = corpus.events.filter((e) => e.family === targetFamily && Array.isArray(e.relations) && e.relations.length > 0 && (!packSplit || e.split === packSplit));
const pack = cands.map((e) => ({ e, s: shaIdx(seedHex + ':' + e.id) })).sort((a, b) => a.s - b.s).slice(0, packSize).map((x) => x.e);
console.log(`[teacher] pack=${pack.length} (split=${packSplit || 'mixed'} family=${targetFamily})`);
if (pack.length === 0) { console.error('empty pack'); exit(2); }

function rankToMap(order) { const m = new Map(); for (let r = 0; r < order.length; r++) m.set(order[r], r + 1); return m; }
function recallAtK(rankedIds, relevantIds, K) { let hit = 0; for (let i = 0; i < Math.min(K, rankedIds.length); i++) if (relevantIds.has(rankedIds[i])) hit++; return relevantIds.size ? hit / relevantIds.size : 0; }
function bestRank(rankedIds, relevantIds) { for (let i = 0; i < rankedIds.length; i++) if (relevantIds.has(rankedIds[i])) return i + 1; return null; }

const RRF_K = 60;
const Ks = [10, 50, 128, 512];
const perQuery = [];
const agg = { dense: {}, bm25: {}, rrf: {} };
for (const K of Ks) { agg.dense[K] = 0; agg.bm25[K] = 0; agg.rrf[K] = 0; }

for (const q of pack) {
  const qvec = dequantize(q.embeddings.query, layout);
  // scorer-only. Track the ANSWER set (relevance===1: question truth + credited
  // answer-alias entity truth), NOT the graded near-collision negatives (rel<1).
  const relevant = new Set(q.qrels.filter((r) => r.relevance === 1).map((r) => r.documentId));

  // dense ranking (proposer-visible: query embedding)
  const denseScored = docs.map((d, i) => ({ i, s: cosineSimilarity(qvec, d.vec) })).sort((a, b) => b.s - a.s);
  const denseOrder = denseScored.map((x) => docs[x.i].id);
  // bm25 ranking (proposer-visible: query text)
  const bm = bm25Scores(tokenize(q.queryText));
  const bmScored = Array.from({ length: N }, (_, i) => ({ i, s: bm[i] })).sort((a, b) => b.s - a.s);
  const bmOrder = bmScored.map((x) => docs[x.i].id);
  // RRF fusion
  const dRank = rankToMap(denseOrder), bRank = rankToMap(bmOrder);
  const rrf = docs.map((d) => { const dr = dRank.get(d.id) ?? 1e9, br = bRank.get(d.id) ?? 1e9; return { id: d.id, s: 1 / (RRF_K + dr) + 1 / (RRF_K + br) }; }).sort((a, b) => b.s - a.s);
  const rrfOrder = rrf.map((x) => x.id);

  const row = { query: q.id.slice(-44), relevantCount: relevant.size,
    denseBestRank: bestRank(denseOrder, relevant), bm25BestRank: bestRank(bmOrder, relevant), rrfBestRank: bestRank(rrfOrder, relevant),
    recall: {} };
  for (const K of Ks) {
    const rd = recallAtK(denseOrder, relevant, K), rb = recallAtK(bmOrder, relevant, K), rr = recallAtK(rrfOrder, relevant, K);
    row.recall[K] = { dense: +rd.toFixed(3), bm25: +rb.toFixed(3), rrf: +rr.toFixed(3) };
    agg.dense[K] += rd; agg.bm25[K] += rb; agg.rrf[K] += rr;
  }
  perQuery.push(row);
}
const np = pack.length;
console.log(`[teacher] LAYER 1 (dense / bm25 / RRF) — recall@K averaged over ${np} queries:`);
for (const K of Ks) console.log(`  @${String(K).padStart(4)}  dense=${(agg.dense[K]/np).toFixed(3)}  bm25=${(agg.bm25[K]/np).toFixed(3)}  rrf=${(agg.rrf[K]/np).toFixed(3)}`);

const report = {
  schemaVersion: 'coretex.teacher-retriever.v1', generatedAt: new Date().toISOString(),
  layer: 'fusion', leakage: { proposerVisible: ['query text', 'query embedding', 'corpus doc text+embeddings'], scorerOnly: ['qrels'], forbidden: ['query event stored relations/truths'] },
  inputs: { corpus: corpusPath, corpusRoot: corpus.corpusRoot, split: packSplit || 'mixed', packSize: np, targetFamily, docCount: N },
  recallAtK: Object.fromEntries(Ks.map((K) => [K, { dense: +(agg.dense[K]/np).toFixed(4), bm25: +(agg.bm25[K]/np).toFixed(4), rrf: +(agg.rrf[K]/np).toFixed(4) }])),
  perQuery,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[teacher] report -> ${reportPath}`);
exit(0);
