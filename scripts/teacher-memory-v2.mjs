#!/usr/bin/env node
/**
 * Layer 3 — proposer-visible hybrid memory teacher for Corpus V2.
 *
 * Components (ALL proposer-visible — query text, doc text+embeddings, public
 * entity aliases, doc timestamps/supersedes metadata, public doc↔doc relation
 * edges). NEVER uses qrels / hidden truth ids; qrels are loaded only to MEASURE
 * recall after ranking.
 *
 *   T0  hybrid base            RRF(dense BGE-M3 int8/243, BM25)
 *   T1  + entity narrowing     boost docs of the query-linked entity (RetrievalKeys/region)
 *   T2  + temporal currency    demote superseded (stale) docs, promote current, among entity docs (Temporal)
 *   T3  + public relation hop  boost entity docs reachable by a public edge from a top base-ranked seed (Relations/anchorBFS)
 *
 * Reports answer recall@{10,20} per family for T0..T3 (source attribution: which
 * mechanism moved the answer) and emits per-query traces with self-attestation.
 *
 * Usage: node scripts/teacher-memory-v2.mjs <corpus.json> <embeddings.json> [--out dir]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STOP = new Set(('a an the of to in on for and or but is are was were be been do does did how what when ' +
  'where why which who whom whose with without now still these days any keep mind i my me her his she he it ' +
  'they them this that use using used go should').split(/\s+/));
const tokenize = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
const b64ToVec = (b64) => { const buf = Buffer.from(b64, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
function cosine(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return (na && nb) ? d / Math.sqrt(na * nb) : 0; }

function bm25Factory(docs) {
  const N = docs.length, docTokens = docs.map((d) => tokenize(d.text)), df = new Map();
  for (const toks of docTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgdl = docTokens.reduce((s, t) => s + t.length, 0) / N;
  const tf = docTokens.map((toks) => { const m = new Map(); for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1); return m; });
  const k1 = 1.5, b = 0.75;
  return (qText) => {
    const qt = tokenize(qText);
    return docs.map((_, i) => {
      let s = 0;
      for (const t of qt) { const f = tf[i].get(t); if (!f) continue; const n = df.get(t) ?? 0; const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5)); s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (docTokens[i].length / avgdl))); }
      return s;
    });
  };
}

function linkEntities(queryText, entities) {
  const q = queryText.toLowerCase();
  const linked = new Set();
  // strong: full canonical name present
  for (const e of entities) if (q.includes(e.canonicalName.toLowerCase())) linked.add(e.id);
  if (linked.size === 0) {
    // weak: any alias as a whole word
    for (const e of entities) for (const a of e.aliases) {
      if (new RegExp(`\\b${a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q)) linked.add(e.id);
    }
  }
  return linked;
}

function main() {
  const args = process.argv.slice(2);
  const [corpusPath, embPath] = args.filter((a) => !a.startsWith('--'));
  const outDir = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : 'release/calibration/2026-05-21-memory-corpus-v2'; })();
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const emb = JSON.parse(readFileSync(embPath, 'utf8'));
  const docs = corpus.docs;
  const idToIdx = new Map(docs.map((d, i) => [d.id, i]));
  const docVec = docs.map((d) => b64ToVec(emb.docs[d.id]));
  const bm25 = bm25Factory(docs);

  // public relation adjacency (undirected — public knowledge edges)
  const adj = new Map();
  for (const r of corpus.relations) { (adj.get(r.src) ?? adj.set(r.src, new Set()).get(r.src)).add(r.dst); (adj.get(r.dst) ?? adj.set(r.dst, new Set()).get(r.dst)).add(r.src); }

  const ENTITY_W = 0.30, TEMP_PROMOTE = 0.18, TEMP_DEMOTE = 0.35, REL_W = 0.45;

  const fams = [...new Set(corpus.queries.map((q) => q.family))];
  const acc = {}; for (const f of [...fams, '__all__']) acc[f] = { n: 0, t: { T0: { 10: 0, 20: 0 }, T1: { 10: 0, 20: 0 }, T2: { 10: 0, 20: 0 }, T3: { 10: 0, 20: 0 } }, rankImprove: [] };
  const traces = [];
  const rankings = [];

  for (let qi = 0; qi < corpus.queries.length; qi++) {
    const q = corpus.queries[qi];
    if (q.abstain) continue;
    const qv = b64ToVec(emb.queries[q.id]);
    const bm = bm25(q.queryText);
    const bmMax = Math.max(...bm) || 1;
    const dense = docs.map((_, i) => cosine(qv, docVec[i]));
    // RRF base (rank fusion of dense + bm25)
    const denseOrder = [...docs.keys()].sort((a, b) => dense[b] - dense[a]);
    const bmOrder = [...docs.keys()].sort((a, b) => bm[b] - bm[a]);
    const dRank = new Array(docs.length), bRank = new Array(docs.length);
    denseOrder.forEach((idx, r) => dRank[idx] = r + 1); bmOrder.forEach((idx, r) => bRank[idx] = r + 1);
    const base = docs.map((_, i) => 1 / (60 + dRank[i]) + 1 / (60 + bRank[i]));

    const linked = linkEntities(q.queryText, corpus.entities);
    const isEntityDoc = docs.map((d) => (d.entityIds ?? []).some((e) => linked.has(e)));

    // T1: entity narrowing
    const sT1 = base.map((s, i) => s + (isEntityDoc[i] ? ENTITY_W * (1 / (60 + 1)) * 60 : 0)); // scale ~ENTITY_W in RRF units
    // simpler: add ENTITY_W * small constant; use additive in a comparable scale
    // (we keep base in RRF units ~0.016 max; convert boosts to same order)
    const RRF_UNIT = 1 / 61;
    const sT1b = base.map((s, i) => s + (isEntityDoc[i] ? ENTITY_W * RRF_UNIT : 0));

    // T2: temporal currency among entity docs
    const sT2 = sT1b.map((s, i) => {
      const d = docs[i]; if (!isEntityDoc[i]) return s;
      if (d.supersededByDocId) return s - TEMP_DEMOTE * RRF_UNIT;          // stale
      if (d.supersedesDocId || d.currentStaleFlag === true) return s + TEMP_PROMOTE * RRF_UNIT; // current
      return s;
    });

    // T3: public relation hop (anchorBFS semantics) — seeds = entity docs in top-20 by sT2.
    // A neighbor reached over a PUBLIC edge inherits a score just below its seed, routing it up
    // to near the bridge's rank (a flat additive nudge cannot lift an answer from rank ~166).
    const orderT2 = [...docs.keys()].sort((a, b) => sT2[b] - sT2[a]);
    const seedIdx = orderT2.slice(0, 20).filter((i) => isEntityDoc[i]);
    const seeds = seedIdx.map((i) => docs[i].id);
    const hopTargets = new Set();
    const sT3 = sT2.slice();
    for (const si of seedIdx) {
      const seedScore = sT2[si];
      for (const nb of (adj.get(docs[si].id) ?? [])) {
        const ni = idToIdx.get(nb);
        if (ni != null && isEntityDoc[ni] && ni !== si) {
          sT3[ni] = Math.max(sT3[ni], seedScore - 0.02 * RRF_UNIT); // inherit, just below the seed
          hopTargets.add(ni);
        }
      }
    }

    const rankOf = (scores, idx) => { let r = 1; for (let j = 0; j < scores.length; j++) if (scores[j] > scores[idx] || (scores[j] === scores[idx] && j < idx)) r++; return r; };
    const directIdx = (q.qrels ?? []).filter((r) => r.relevance >= 0.8).map((r) => idToIdx.get(r.docId)).filter((x) => x != null);
    const bestRank = (scores) => Math.min(...directIdx.map((d) => rankOf(scores, d)));
    const r0 = bestRank(base), r1 = bestRank(sT1b), r2 = bestRank(sT2), r3 = bestRank(sT3);

    for (const f of [q.family, '__all__']) {
      const a = acc[f]; a.n++;
      for (const [tk, rk] of [['T0', r0], ['T1', r1], ['T2', r2], ['T3', r3]]) { if (rk <= 10) a.t[tk][10]++; if (rk <= 20) a.t[tk][20]++; }
      a.rankImprove.push(r0 - r3);
    }
    // relation edge types used to reach a direct answer (trace)
    const relUsed = [];
    for (const d of directIdx) {
      const did = docs[d].id;
      for (const r of corpus.relations) if ((r.src === did || r.dst === did) && (seeds.includes(r.src) || seeds.includes(r.dst))) relUsed.push(r.type);
    }
    // dump ranked candidate lists (dense stage-1 vs teacher T3) for Layer 4 reranking
    const teacherOrder = [...docs.keys()].sort((a, b) => sT3[b] - sT3[a]);
    rankings.push({
      queryId: q.id, family: q.family, query: q.queryText,
      qrels: (q.qrels ?? []).map((r) => ({ docId: r.docId, relevance: r.relevance })),
      denseTop: denseOrder.slice(0, 40).map((i) => docs[i].id),
      teacherTop: teacherOrder.slice(0, 40).map((i) => docs[i].id),
    });
    traces.push({
      queryId: q.id, family: q.family, query: q.queryText,
      linkedEntities: [...linked], temporalFired: docs.some((d, i) => isEntityDoc[i] && (d.supersededByDocId || d.supersedesDocId)),
      relationHopUsed: [...new Set(relUsed)], hopTargetCount: hopTargets.size,
      answerRank: { T0: r0, T1: r1, T2: r2, T3: r3 },
      // self-attestation
      proposerVisibleInputs: ['queryText', 'queryEmbedding', 'docText', 'docEmbedding', 'publicEntityAliases', 'docTimestamps', 'supersedesMetadata', 'publicRelationEdges'],
      usesHiddenQrels: false, usesHiddenQueryRelations: false, usesHiddenTruthDocs: false,
    });
  }

  // report
  const rec = (f, tk, k) => acc[f].n ? +(acc[f].t[tk][k] / acc[f].n).toFixed(2) : null;
  const lines = [];
  lines.push(`# Layer 3 — proposer-visible teacher: per-mechanism answer recall (P0)`);
  lines.push('');
  lines.push(`Corpus \`${corpusPath}\`. T0 hybrid → T1 +entity → T2 +temporal → T3 +relation-hop. Recall = best direct doc in top-K.`);
  lines.push('All teacher inputs proposer-visible (no qrels/hidden ids used in ranking). Lift attributed to the mechanism that moves it.');
  lines.push('');
  lines.push('## answer recall@10 by family (T0→T3)');
  lines.push('| family | n | T0 | T1 | T2 | T3 | Δ(T3-T0) |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|');
  for (const f of [...fams.sort(), '__all__']) {
    if (!acc[f].n) continue;
    const d = (rec(f, 'T3', 10) - rec(f, 'T0', 10)).toFixed(2);
    lines.push(`| ${f} | ${acc[f].n} | ${rec(f, 'T0', 10)} | ${rec(f, 'T1', 10)} | ${rec(f, 'T2', 10)} | ${rec(f, 'T3', 10)} | ${d} |`);
  }
  lines.push('');
  lines.push('## answer recall@20 by family (T0→T3)');
  lines.push('| family | n | T0 | T1 | T2 | T3 |');
  lines.push('|---|--:|--:|--:|--:|--:|');
  for (const f of [...fams.sort(), '__all__']) { if (!acc[f].n) continue; lines.push(`| ${f} | ${acc[f].n} | ${rec(f, 'T0', 20)} | ${rec(f, 'T1', 20)} | ${rec(f, 'T2', 20)} | ${rec(f, 'T3', 20)} |`); }

  const report = { specVersion: corpus.specVersion, phase: corpus.phase, corpus: corpusPath, weights: { ENTITY_W, TEMP_PROMOTE, TEMP_DEMOTE, REL_W },
    families: Object.fromEntries(Object.entries(acc).map(([f, a]) => [f, { n: a.n, recall10: { T0: rec(f, 'T0', 10), T1: rec(f, 'T1', 10), T2: rec(f, 'T2', 10), T3: rec(f, 'T3', 10) }, recall20: { T0: rec(f, 'T0', 20), T1: rec(f, 'T1', 20), T2: rec(f, 'T2', 20), T3: rec(f, 'T3', 20) } }])),
  };
  writeFileSync(resolve(outDir, 'LAYER3_TEACHER.json'), JSON.stringify(report, null, 2));
  writeFileSync(resolve(outDir, 'LAYER3_TEACHER_TRACES.json'), JSON.stringify(traces, null, 1));
  writeFileSync(resolve(outDir, 'LAYER3_RANKINGS.json'), JSON.stringify(rankings));
  writeFileSync(resolve(outDir, 'LAYER3_TEACHER.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
main();
