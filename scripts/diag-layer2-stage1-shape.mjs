#!/usr/bin/env node
/**
 * Layer 2 — Stage-1 difficulty shape diagnostic for Memory Corpus V2.
 *
 * Runs BM25, dense (pinned BGE-M3 int8 retrieval key), and hybrid (RRF) over
 * the full logical corpus and reports, per family:
 *   - answer recall@{20,50,100,128,512,all} (best direct doc, rel>=0.8)
 *   - truth-rank distribution (median / p90), bridge-doc rank distribution
 *   - hard-negatives-in-top-10 rate
 *   - abstention separability (top-1 cosine: answerable vs abstain)
 *   - per-family verdict: solved / impossible / useful-but-imperfect
 *
 * Target (spec §Layer 2): NOT solved by stage1 alone, NOT impossible, answers
 * often inside broad recall but below the cheap cap, hard negs near the top.
 *
 * Usage: node scripts/diag-layer2-stage1-shape.mjs <logical-corpus.json> [--out dir]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { embedTexts, cosine } from './_embed-v2.mjs';

const STOP = new Set(('a an the of to in on for and or but is are was were be been do does did how what when ' +
  'where why which who whom whose with without now still these days any keep mind i my me her his she he it ' +
  'they them this that use using used go should').split(/\s+/));
const tokenize = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));

function bm25Ranker(docs) {
  const N = docs.length;
  const docTokens = docs.map((d) => tokenize(d.text));
  const df = new Map();
  for (const toks of docTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = docTokens.reduce((s, t) => s + t.length, 0) / N;
  const tf = docTokens.map((toks) => { const m = new Map(); for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1); return m; });
  const k1 = 1.5, b = 0.75;
  return (queryText) => {
    const qt = tokenize(queryText);
    const scored = docs.map((d, i) => {
      let s = 0;
      for (const t of qt) {
        const f = tf[i].get(t); if (!f) continue;
        const n = df.get(t) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docTokens[i].length / avgdl)));
      }
      return { i, s };
    });
    scored.sort((a, b2) => b2.s - a.s);
    return scored.map((x) => x.i);
  };
}

function rrf(rankListsByDoc, k = 60) {
  // rankListsByDoc: array of {idx -> rank(1-based)} maps; returns idx[] sorted
  const n = rankListsByDoc[0].length;
  const score = new Array(n).fill(0);
  for (const ranks of rankListsByDoc) for (let i = 0; i < n; i++) score[i] += 1 / (k + ranks[i]);
  return [...Array(n).keys()].sort((a, b) => score[b] - score[a]);
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

async function main() {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith('--'));
  const outDir = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : 'release/calibration/2026-05-21-memory-corpus-v2'; })();
  const ownerScope = args.includes('--owner-scope');
  const corpus = JSON.parse(readFileSync(path, 'utf8'));
  const docs = corpus.docs;
  const idToIdx = new Map(docs.map((d, i) => [d.id, i]));
  // Owner→doc-index map (for owner-scoped dense-rank diagnostics): restrict the
  // candidate set to the query's owner store, matching production owner-scoped
  // retrieval. Pooled queries (ownerScoped!==true) still rank over the full pool.
  const ownerDocIdx = new Map();
  if (ownerScope) {
    for (let i = 0; i < docs.length; i++) for (const e of docs[i].entityIds ?? []) {
      if (!ownerDocIdx.has(e)) ownerDocIdx.set(e, []); ownerDocIdx.get(e).push(i);
    }
  }

  const embCachePath = (() => { const i = args.indexOf('--emb'); return i >= 0 ? args[i + 1] : null; })();
  const t0 = Date.now();
  let docVecs, qVecs;
  if (embCachePath) {
    const cache = JSON.parse(readFileSync(embCachePath, 'utf8'));
    const b64 = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
    docVecs = docs.map((d) => b64(cache.docs[d.id]));
    qVecs = corpus.queries.map((q) => b64(cache.queries[q.id]));
    console.error(`[layer2] loaded ${docVecs.length} doc + ${qVecs.length} query vecs from cache in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
    console.error(`[layer2] embedding ${docs.length} docs + ${corpus.queries.length} queries (pinned BGE-M3, int8/243)…`);
    docVecs = await embedTexts(docs.map((d) => d.text));
    qVecs = await embedTexts(corpus.queries.map((q) => q.queryText));
    console.error(`[layer2] embedded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const bm25 = bm25Ranker(docs);
  const Ks = [20, 50, 100, 128, 512, docs.length];
  const KLabels = ['20', '50', '100', '128', '512', 'all'];

  // accumulators per family + overall
  const fam = new Map();
  const ensure = (f) => { if (!fam.has(f)) fam.set(f, { n: 0, abstainN: 0, dense: {}, bm25: {}, hybrid: {}, truthRankDense: [], bridgeRankDense: [], negTop10: 0, abstainTop1: [], answerTop1: [] }); return fam.get(f); };
  for (const L of KLabels) for (const f of [...new Set(corpus.queries.map((q) => q.family)), '__all__']) { ensure(f).dense[L] = ensure(f).dense[L] || 0; ensure(f).bm25[L] = ensure(f).bm25[L] || 0; ensure(f).hybrid[L] = ensure(f).hybrid[L] || 0; }

  for (let qi = 0; qi < corpus.queries.length; qi++) {
    const q = corpus.queries[qi];
    const qv = qVecs[qi];
    // Candidate set: owner-scoped store for scoped queries (--owner-scope), else full pool.
    const scoped = ownerScope && q.ownerScoped === true && q.ownerEntityId && ownerDocIdx.has(q.ownerEntityId);
    const candIdx = scoped ? ownerDocIdx.get(q.ownerEntityId) : null; // null = full pool
    // dense ranking (within candidate set)
    const denseScored = (candIdx ?? docs.map((_, i) => i)).map((i) => ({ i, s: cosine(qv, docVecs[i]) })).sort((a, b) => b.s - a.s);
    const denseOrder = denseScored.map((x) => x.i);
    // bm25 over full pool, then restrict to candidate set (preserve order).
    const candSet = candIdx ? new Set(candIdx) : null;
    const bm25Order = candSet ? bm25(q.queryText).filter((i) => candSet.has(i)) : bm25(q.queryText);
    // rank maps for RRF (over the candidate set)
    const denseRank = new Map(), bm25Rank = new Map();
    denseOrder.forEach((idx, r) => denseRank.set(idx, r + 1));
    bm25Order.forEach((idx, r) => bm25Rank.set(idx, r + 1));
    const candList = candIdx ?? [...Array(docs.length).keys()];
    const rrfScore = new Map(candList.map((i) => [i, 1 / (60 + (denseRank.get(i) ?? candList.length)) + 1 / (60 + (bm25Rank.get(i) ?? candList.length))]));
    const hybridOrder = [...candList].sort((a, b) => rrfScore.get(b) - rrfScore.get(a));

    const rankIn = (order, idx) => order.indexOf(idx) + 1;
    const F = ensure(q.family); const A = ensure('__all__');

    if (q.abstain) {
      F.abstainN++; A.abstainN++;
      F.abstainTop1.push(denseScored[0].s); A.abstainTop1.push(denseScored[0].s);
      continue;
    }
    F.n++; A.n++;
    const directIdx = (q.qrels ?? []).filter((r) => r.relevance >= 0.8).map((r) => idToIdx.get(r.docId)).filter((x) => x != null);
    const bridgeIdx = (q.qrels ?? []).filter((r) => r.role === 'bridge').map((r) => idToIdx.get(r.docId)).filter((x) => x != null);
    const negIdx = (q.hardNegatives ?? []).map((n) => idToIdx.get(n.docId)).filter((x) => x != null);

    const bestRank = (order) => Math.min(...directIdx.map((d) => rankIn(order, d)));
    const dR = bestRank(denseOrder), bR = bestRank(bm25Order), hR = bestRank(hybridOrder);
    F.truthRankDense.push(dR); A.truthRankDense.push(dR);
    F.answerTop1.push(denseScored[0].s); A.answerTop1.push(denseScored[0].s);
    if (bridgeIdx.length) { const br = Math.min(...bridgeIdx.map((d) => rankIn(denseOrder, d))); F.bridgeRankDense.push(br); A.bridgeRankDense.push(br); }
    // hard-neg in dense top-10
    const negInTop10 = negIdx.some((nd) => rankIn(denseOrder, nd) <= 10);
    if (negInTop10) { F.negTop10++; A.negTop10++; }
    for (let ki = 0; ki < Ks.length; ki++) {
      const L = KLabels[ki], K = Ks[ki];
      if (dR <= K) { F.dense[L]++; A.dense[L]++; }
      if (bR <= K) { F.bm25[L]++; A.bm25[L]++; }
      if (hR <= K) { F.hybrid[L]++; A.hybrid[L]++; }
    }
  }

  // build report
  const report = { specVersion: corpus.specVersion, phase: corpus.phase, corpus: path, docCount: docs.length, queryCount: corpus.queries.length, families: {} };
  const famVerdict = (rDense) => {
    const r20 = rDense['20'], r128 = rDense['128'], rall = rDense['all'];
    if (r20 >= 0.95) return 'too-easy (solved at cheap cap)';
    if (rall < 0.5) return 'too-hard (answer not findable even at full recall)';
    if (r128 >= 0.8 && r20 < 0.9) return 'useful-but-imperfect (findable, below cheap cap)';
    return 'borderline';
  };
  const lines = [];
  lines.push(`# Layer 2 — Stage-1 difficulty shape (${corpus.phase})`);
  lines.push('');
  lines.push(`Corpus: \`${path}\` · ${docs.length} docs · ${corpus.queries.length} queries · pinned BGE-M3 int8/243 retrieval key.`);
  lines.push(`Target: NOT solved by stage-1 (recall@20 < ~0.9), NOT impossible (recall@all high), answers below cheap cap, hard negs near top.`);
  lines.push('');
  lines.push('## Per-family dense answer-recall@K (best direct doc)');
  lines.push('| family | n | r@20 | r@50 | r@100 | r@128 | r@512 | r@all | medRank | negTop10% | verdict |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|---|');
  const famNames = [...fam.keys()].filter((f) => f !== '__all__').sort();
  for (const f of [...famNames, '__all__']) {
    const o = fam.get(f); if (!o.n && !o.abstainN) continue;
    const rD = {}; for (const L of KLabels) rD[L] = o.n ? +(o.dense[L] / o.n).toFixed(2) : null;
    const verdict = o.n ? famVerdict(rD) : `abstain-only (n=${o.abstainN})`;
    report.families[f] = {
      n: o.n, abstainN: o.abstainN,
      denseRecall: rD,
      bm25Recall: Object.fromEntries(KLabels.map((L) => [L, o.n ? +(o.bm25[L] / o.n).toFixed(2) : null])),
      hybridRecall: Object.fromEntries(KLabels.map((L) => [L, o.n ? +(o.hybrid[L] / o.n).toFixed(2) : null])),
      medianTruthRankDense: median(o.truthRankDense), p90TruthRankDense: pct(o.truthRankDense, 0.9),
      medianBridgeRankDense: median(o.bridgeRankDense),
      negInTop10Rate: o.n ? +(o.negTop10 / o.n).toFixed(2) : null,
      verdict,
    };
    if (o.n) lines.push(`| ${f} | ${o.n} | ${rD['20']} | ${rD['50']} | ${rD['100']} | ${rD['128']} | ${rD['512']} | ${rD['all']} | ${median(o.truthRankDense)} | ${(100 * o.negTop10 / o.n).toFixed(0)}% | ${verdict} |`);
  }
  // abstention separability
  const A = fam.get('__all__');
  const ansT1 = A.answerTop1, absT1 = A.abstainTop1;
  report.abstention = {
    answerableTop1CosineMean: ansT1.length ? +(ansT1.reduce((a, b) => a + b, 0) / ansT1.length).toFixed(3) : null,
    abstainTop1CosineMean: absT1.length ? +(absT1.reduce((a, b) => a + b, 0) / absT1.length).toFixed(3) : null,
    abstainTop1CosineP90: pct(absT1, 0.9), answerableTop1CosineP10: pct(ansT1, 0.1),
  };
  lines.push('');
  lines.push('## BM25 vs dense vs hybrid (overall recall@K)');
  lines.push('| ranker | r@20 | r@50 | r@128 | r@512 | r@all |');
  lines.push('|---|--:|--:|--:|--:|--:|');
  for (const [name, key] of [['bm25', 'bm25'], ['dense', 'dense'], ['hybrid', 'hybrid']]) {
    const o = A; const r = (L) => +(o[key][L] / o.n).toFixed(2);
    lines.push(`| ${name} | ${r('20')} | ${r('50')} | ${r('128')} | ${r('512')} | ${r('all')} |`);
  }
  lines.push('');
  lines.push('## Abstention separability (dense top-1 cosine)');
  lines.push(`answerable mean=${report.abstention.answerableTop1CosineMean}, p10=${report.abstention.answerableTop1CosineP10}; abstain mean=${report.abstention.abstainTop1CosineMean}, p90=${report.abstention.abstainTop1CosineP90}.`);
  lines.push(absT1.length ? `(want abstain top-1 cosine clearly below answerable → a threshold can gate abstention)` : '(no abstention queries)');

  const jsonPath = resolve(outDir, 'LAYER2_STAGE1_SHAPE.json');
  const mdPath = resolve(outDir, 'LAYER2_STAGE1_SHAPE.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  console.error(`\n[layer2] wrote ${jsonPath} and ${mdPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
