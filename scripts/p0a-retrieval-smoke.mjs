#!/usr/bin/env node
/**
 * P0a stage-1 difficulty smoke — lexical (BM25) only, no model, no GPU.
 *
 * Purpose: confirm the P0a manual corpus has the Layer-2 target *shape* at the
 * cheapest possible level before investing in embeddings/the generator:
 *   - NOT solved by lexical stage-1 alone (answer not always rank-1),
 *   - NOT impossible (answer is somewhere retrievable),
 *   - hard negatives frequently compete near the top,
 *   - low-lexical / temporal / disambiguation families are visibly harder.
 *
 * This is a manual-gate aid, not a calibration artifact. Dense/hybrid Layer-2
 * diagnostics run later at P0 scale with the pinned bi-encoder.
 *
 * Usage: node scripts/p0a-retrieval-smoke.mjs <logical-corpus.json> [--json]
 */
import { readFileSync } from 'node:fs';

const STOP = new Set(('a an the of to in on for and or but is are was were be been do does did how what ' +
  'when where why which who whom whose with without now still these days any to keep mind i my me her his ' +
  'she he it they them this that use using used go does her').split(/\s+/));

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

function bm25(query, docs, k1 = 1.5, b = 0.75) {
  const N = docs.length;
  const df = new Map();
  const docTokens = docs.map((d) => tokenize(d.text));
  const avgdl = docTokens.reduce((s, t) => s + t.length, 0) / N;
  for (const toks of docTokens) {
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const qt = tokenize(query);
  return docs.map((d, i) => {
    const toks = docTokens[i];
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of qt) {
      const f = tf.get(t);
      if (!f) continue;
      const n = df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (toks.length / avgdl)));
    }
    return { id: d.id, score };
  }).sort((a, b2) => b2.score - a.score);
}

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const path = args.find((a) => !a.startsWith('--'));
  const corpus = JSON.parse(readFileSync(path, 'utf8'));
  const docs = corpus.docs;

  const rows = [];
  for (const q of corpus.queries) {
    const ranked = bm25(q.queryText, docs);
    const rankOf = (id) => ranked.findIndex((r) => r.id === id) + 1;
    const directIds = (q.qrels ?? []).filter((r) => r.relevance >= 0.8).map((r) => r.docId);
    const negIds = (q.hardNegatives ?? []).map((n) => n.docId);
    const directRanks = directIds.map(rankOf);
    const bestDirect = directRanks.length ? Math.min(...directRanks) : null;
    const negRanks = negIds.map(rankOf);
    const negsAboveAnswer = q.abstain ? null
      : negRanks.filter((nr) => bestDirect != null && nr < bestDirect).length;
    rows.push({
      id: q.id, family: q.family, abstain: !!q.abstain,
      bestDirectRank: bestDirect,
      top1IsAnswer: bestDirect === 1,
      negsAboveAnswer,
      top3: ranked.slice(0, 3).map((r) => r.id),
    });
  }

  const ans = rows.filter((r) => !r.abstain);
  const solved = ans.filter((r) => r.top1IsAnswer).length;
  const impossible = ans.filter((r) => r.bestDirectRank == null || r.bestDirectRank > 20).length;
  const competed = ans.filter((r) => (r.negsAboveAnswer ?? 0) > 0).length;
  const summary = {
    answerableQueries: ans.length,
    solvedByLexicalTop1: solved,
    solvedPct: +(100 * solved / ans.length).toFixed(1),
    impossibleAt20: impossible,
    queriesWhereAHardNegOutranksAnswer: competed,
    medianDirectRank: ans.map((r) => r.bestDirectRank).filter((x) => x != null).sort((a, b) => a - b)[Math.floor(ans.length / 2)],
  };

  if (jsonOut) { console.log(JSON.stringify({ summary, rows }, null, 2)); return; }
  console.log('\n=== P0a lexical (BM25) stage-1 smoke ===');
  console.log('per-query: rank of best direct answer, #hard-negs ranked above it, top-3 ids\n');
  for (const r of rows) {
    const tag = r.abstain ? 'ABSTAIN' : `ans@${r.bestDirectRank}${r.top1IsAnswer ? ' (TOP1)' : ''} negsAbove=${r.negsAboveAnswer}`;
    console.log(`${r.id} [${r.family}] ${tag}  top3=${r.top3.join(',')}`);
  }
  console.log('\n--- summary ---');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\nInterpretation: want solvedPct well below 100 (not trivially solved), impossibleAt20≈0');
  console.log('(not impossible), and a healthy count where a hard-neg outranks the answer (negatives compete).\n');
}

main();
