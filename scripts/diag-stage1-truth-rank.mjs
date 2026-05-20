#!/usr/bin/env node
/**
 * Diagnostic: where do the answer truths sit in stage-1 for the viability pack?
 * Decides the fix path:
 *   - truth rank <= rerankerInputTopK (cap)        -> stage-1 + reranker already see it
 *   - cap < truth rank <= firstStageTopK           -> lens REWEIGHT can rescue (no scorer change)
 *   - truth rank > firstStageTopK (stage-1 miss)   -> only EXPANSION can rescue (scorer change)
 * Pure cosine; no reranker, no state.
 */
import { distIndex } from './_repo-root.mjs';
import { existsSync } from 'node:fs';
import { argv, exit } from 'node:process';

function flag(n, fb) { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; }
const corpusPath = flag('corpus', '/var/lib/coretex/corpus-epoch-0-calibration-relation-qrels.json');
const packSize = Number(flag('pack-size', '16'));
const seedHex = flag('seed', '0x' + 'c7'.repeat(32));
const targetFamily = flag('family', 'multi_hop_relation');
const cap = Number(flag('cap', '128'));
const firstStageTopK = Number(flag('first-stage', '3200'));
if (!existsSync(corpusPath)) { console.error('corpus missing'); exit(1); }

const { loadProductionCorpus, dequantize, cosineSimilarity } = await import(distIndex);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
const layout = corpus.biEncoderRetrievalKeyLayout;
console.log(`[diag] ${corpus.events.length} events; layout dim=${layout.dim} ${layout.quantization}; cap=${cap} firstStageTopK=${firstStageTopK}`);

// Build the SAME pack the viability probe uses.
function shaIdx(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff; return h >>> 0; }
const cands = corpus.events.filter((e) => e.family === targetFamily && Array.isArray(e.relations) && e.relations.length > 0);
const pack = cands.map((e) => ({ e, s: shaIdx(seedHex + ':' + e.id) })).sort((a, b) => a.s - b.s).slice(0, packSize).map((x) => x.e);

// Precompute all corpus doc vectors once (truths + negatives).
const allDocs = [];
for (const ev of corpus.events) {
  for (const [id, emb] of ev.embeddings.perTruth) allDocs.push({ id, vec: dequantize(emb, layout) });
  for (const [id, emb] of ev.embeddings.perNegative) allDocs.push({ id, vec: dequantize(emb, layout) });
}
console.log(`[diag] ${allDocs.length} corpus docs; pack=${pack.length} queries (family=${targetFamily})`);

const buckets = { inCap: 0, inStageNotCap: 0, beyondStage: 0 };
const rows = [];
for (const q of pack) {
  const qv = dequantize(q.embeddings.query, layout);
  // truth doc ids for this query (relevance > 0 in qrels)
  const truthIds = new Set(q.qrels.filter((r) => r.relevance > 0).map((r) => r.documentId));
  // rank all docs by cosine desc
  const scored = allDocs.map((d) => ({ id: d.id, c: cosineSimilarity(qv, d.vec) })).sort((a, b) => b.c - a.c);
  let bestRank = Infinity, bestId = null;
  for (let i = 0; i < scored.length; i++) { if (truthIds.has(scored[i].id)) { bestRank = i + 1; bestId = scored[i].id; break; } }
  const where = bestRank <= cap ? 'inCap' : bestRank <= firstStageTopK ? 'inStageNotCap' : 'beyondStage';
  buckets[where]++;
  rows.push({ q: q.id.slice(-40), truthRank: bestRank === Infinity ? null : bestRank, where });
}
for (const r of rows) console.log(`  truthRank=${String(r.truthRank).padStart(6)} [${r.where}]  ${r.q}`);
console.log(`[diag] SUMMARY of ${pack.length} queries: inCap(<=${cap})=${buckets.inCap}  inStageNotCap(${cap}<r<=${firstStageTopK})=${buckets.inStageNotCap}  beyondStage(>${firstStageTopK})=${buckets.beyondStage}`);
console.log(`[diag] => ${buckets.inStageNotCap > 0 ? 'lens REWEIGHT can rescue some (no scorer change needed for those)' : ''}${buckets.beyondStage > 0 ? `; ${buckets.beyondStage} require EXPANSION (scorer change)` : ''}`);
exit(0);
