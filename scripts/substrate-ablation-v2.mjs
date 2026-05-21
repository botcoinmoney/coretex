#!/usr/bin/env node
/**
 * Layer 5 — substrate compile + same-pool source-attributed ablation (Corpus V2).
 *
 * Compiles the Layer-3 teacher's PROVEN proposer-visible routing into substrate
 * scoring components that mirror the production scorer's
 *   preRankScore = biCosine + lensBonus + anchorBonus + temporalBonus
 * and measures CAUSAL lift with same-pool discipline (separate "source fired"
 * from "score improved"), per the existing scorer's methodology.
 *
 * Compile map (mechanism proven in Layer 3 → substrate slot → preRankScore term):
 *   public supports/causes relation hop  → Relations/anchorBFS → anchorBonus (pool-expanding + inherit)
 *   supersedes + timestamp currency      → Temporal           → temporalBonus (+current / −superseded)
 *   entity-link region narrowing         → RetrievalKeys/lens  → lensBonus
 *
 * Ablation arms (same underlying corpus; OFF = stage-1 dense pool only):
 *   OFF              biCosine only over dense top-K pool
 *   +lens            + lensBonus (entity region)
 *   +temporal        + temporalBonus
 *   +anchorBFS       + anchorBonus with relation pool-expansion (adds non-pool neighbors)
 *   ON (all)         all three
 *
 * Checks: recall@10 / ndcg@10 OFF vs ON per family; % of Layer-3 teacher lift retained;
 *   hard-negatives-in-top-20 (flood guard); train/eval split survival.
 * No model needed (uses the embedding cache). Anchor force-include is reported
 * SEPARATELY and never counts as generalized routing.
 *
 * Usage: node scripts/substrate-ablation-v2.mjs <corpus.json> <embeddings.json> [--K 64] [--out dir]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const LEVER = new Set(['temporal_update', 'multi_session_bridge', 'causal_memory_chain']);
const STOP = new Set(('a an the of to in on for and or but is are was were be been do does did how what when ' +
  'where why which who whom whose with without now still these days any keep mind i my me her his she he it ' +
  'they them this that use using used go should').split(/\s+/));
const tok = (s) => (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
const b64ToVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
function cos(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return (na && nb) ? d / Math.sqrt(na * nb) : 0; }
const splitOf = (id) => (parseInt(createHash('sha256').update(id).digest('hex').slice(0, 8), 16) % 100) < 70 ? 'train' : 'eval';

function linkEntities(q, entities) {
  const s = q.toLowerCase(); const out = new Set();
  for (const e of entities) if (s.includes(e.canonicalName.toLowerCase())) out.add(e.id);
  if (!out.size) for (const e of entities) for (const a of e.aliases) if (new RegExp(`\\b${a.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(s)) out.add(e.id);
  return out;
}

// substrate bonus magnitudes (cosine scale ~0.4–0.75)
const LENS = 0.08, TEMP_UP = 0.10, TEMP_DOWN = 0.25, ANCHOR = 0.28;

function main() {
  const args = process.argv.slice(2);
  const [corpusPath, embPath] = args.filter((a) => !a.startsWith('--'));
  const K = parseInt((() => { const i = args.indexOf('--K'); return i >= 0 ? args[i + 1] : '64'; })(), 10);
  const outDir = (() => { const i = args.indexOf('--out'); return i >= 0 ? args[i + 1] : 'release/calibration/2026-05-21-memory-corpus-v2'; })();
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
  const emb = JSON.parse(readFileSync(embPath, 'utf8'));
  const docs = corpus.docs, idToIdx = new Map(docs.map((d, i) => [d.id, i]));
  const dvec = docs.map((d) => b64ToVec(emb.docs[d.id]));
  const adj = new Map();
  for (const r of corpus.relations) { (adj.get(r.src) ?? adj.set(r.src, new Set()).get(r.src)).add(r.dst); (adj.get(r.dst) ?? adj.set(r.dst, new Set()).get(r.dst)).add(r.src); }

  const arms = ['OFF', '+lens', '+temporal', '+anchorBFS', 'ON'];
  const mk = () => ({ recall10: 0, ndcg10: 0, negTop20: 0 });
  const fam = {};
  const ensureF = (f) => fam[f] ?? (fam[f] = { n: 0, byArm: Object.fromEntries(arms.map((a) => [a, mk()])), splits: { train: 0, eval: 0, evalOFF: 0, evalON: 0 } });
  const perQuery = [];

  for (const q of corpus.queries) {
    if (q.abstain || !LEVER.has(q.family)) continue;
    const qv = b64ToVec(emb.queries[q.id]);
    const biCos = docs.map((_, i) => cos(qv, dvec[i]));
    const denseOrder = [...docs.keys()].sort((a, b) => biCos[b] - biCos[a]);
    const pool = new Set(denseOrder.slice(0, K)); // stage-1 dense pool
    const linked = linkEntities(q.queryText, corpus.entities);
    const isEnt = docs.map((d) => (d.entityIds ?? []).some((e) => linked.has(e)));

    // anchorBFS pool expansion: from entity-linked seeds in the dense pool, add public-edge neighbors (entity docs, not superseded/stale)
    const seeds = [...pool].filter((i) => isEnt[i] && denseOrder.indexOf(i) < 20);
    const anchorReached = new Set();
    for (const si of seeds) for (const nb of (adj.get(docs[si].id) ?? [])) { const ni = idToIdx.get(nb); if (ni != null && isEnt[ni] && !docs[ni].supersededByDocId) anchorReached.add(ni); }

    const relOf = new Map((q.qrels ?? []).map((r) => [r.docId, r.relevance]));
    const directIdx = new Set((q.qrels ?? []).filter((r) => r.relevance >= 0.8).map((r) => idToIdx.get(r.docId)).filter((x) => x != null));
    const negIdx = new Set((q.hardNegatives ?? []).map((n) => idToIdx.get(n.docId)).filter((x) => x != null));

    const score = (arm) => {
      const inPool = new Set(pool);
      if (arm === '+anchorBFS' || arm === 'ON') for (const i of anchorReached) inPool.add(i);
      const sc = new Map();
      for (const i of inPool) {
        let s = biCos[i];
        if ((arm === '+lens' || arm === 'ON') && isEnt[i]) s += LENS;
        if ((arm === '+temporal' || arm === 'ON') && isEnt[i]) { if (docs[i].supersededByDocId) s -= TEMP_DOWN; else if (docs[i].supersedesDocId || docs[i].currentStaleFlag === true) s += TEMP_UP; }
        if ((arm === '+anchorBFS' || arm === 'ON') && anchorReached.has(i)) s = Math.max(s, biCos[seeds.length ? seeds[0] : i] - 0.001) + ANCHOR * 0; // inherit near top seed
        sc.set(i, s);
      }
      // anchorBFS inherit: give reached docs a score just below their best seed (route up), additive ANCHOR on top
      if (arm === '+anchorBFS' || arm === 'ON') {
        for (const i of anchorReached) {
          let best = -1;
          for (const si of seeds) if ((adj.get(docs[si].id) ?? new Set()).has(docs[i].id)) best = Math.max(best, sc.get(si) ?? biCos[si]);
          if (best >= 0) sc.set(i, Math.max(sc.get(i) ?? biCos[i], best - 0.001));
        }
      }
      return [...inPool].sort((a, b) => sc.get(b) - sc.get(a));
    };

    const row = { queryId: q.id, family: q.family, split: splitOf(q.id), arms: {} };
    const F = ensureF(q.family); const A = ensureF('__all__'); F.n++; A.n++;
    F.splits[row.split]++; A.splits[row.split]++;
    for (const arm of arms) {
      const order = score(arm);
      const top10 = order.slice(0, 10), top20 = order.slice(0, 20);
      const recall10 = top10.some((i) => directIdx.has(i)) ? 1 : 0;
      const rankedRel = order.map((i) => relOf.get(docs[i].id) ?? 0);
      const dcg = rankedRel.slice(0, 10).reduce((s, r, k) => s + (2 ** r - 1) / Math.log2(k + 2), 0);
      const ideal = [...rankedRel].sort((a, b) => b - a).slice(0, 10).reduce((s, r, k) => s + (2 ** r - 1) / Math.log2(k + 2), 0);
      const nd = ideal > 0 ? dcg / ideal : 0;
      const negTop20 = top20.filter((i) => negIdx.has(i)).length;
      F.byArm[arm].recall10 += recall10; F.byArm[arm].ndcg10 += nd; F.byArm[arm].negTop20 += negTop20;
      A.byArm[arm].recall10 += recall10; A.byArm[arm].ndcg10 += nd; A.byArm[arm].negTop20 += negTop20;
      if (row.split === 'eval') { if (arm === 'OFF') { F.splits.evalOFF += recall10; A.splits.evalOFF += recall10; } if (arm === 'ON') { F.splits.evalON += recall10; A.splits.evalON += recall10; } }
      row.arms[arm] = { recall10, ndcg10: +nd.toFixed(3), negTop20 };
    }
    perQuery.push(row);
  }

  const fmt = (o, arm, k) => o.n ? +(o.byArm[arm][k] / o.n).toFixed(2) : null;
  const lines = [];
  lines.push(`# Layer 5 — substrate same-pool source-attributed ablation (K=${K})`);
  lines.push('');
  lines.push('preRankScore = biCosine + lensBonus + temporalBonus + anchorBonus. Same dense top-K pool; +anchorBFS expands pool via public relation edges. Lever families only.');
  lines.push('');
  lines.push('## recall@10 by arm');
  lines.push('| family | n | OFF | +lens | +temporal | +anchorBFS | ON | hardNegTop20(ON avg) |');
  lines.push('|---|--:|--:|--:|--:|--:|--:|--:|');
  for (const f of [...Object.keys(fam).filter((x) => x !== '__all__').sort(), '__all__']) {
    const o = fam[f];
    lines.push(`| ${f} | ${o.n} | ${fmt(o, 'OFF', 'recall10')} | ${fmt(o, '+lens', 'recall10')} | ${fmt(o, '+temporal', 'recall10')} | ${fmt(o, '+anchorBFS', 'recall10')} | ${fmt(o, 'ON', 'recall10')} | ${fmt(o, 'ON', 'negTop20')} |`);
  }
  lines.push('');
  lines.push('## ndcg@10 by arm');
  lines.push('| family | n | OFF | ON | Δ |');
  lines.push('|---|--:|--:|--:|--:|');
  for (const f of [...Object.keys(fam).filter((x) => x !== '__all__').sort(), '__all__']) {
    const o = fam[f]; const d = (fmt(o, 'ON', 'ndcg10') - fmt(o, 'OFF', 'ndcg10')).toFixed(2);
    lines.push(`| ${f} | ${o.n} | ${fmt(o, 'OFF', 'ndcg10')} | ${fmt(o, 'ON', 'ndcg10')} | ${d} |`);
  }
  lines.push('');
  lines.push('## train/eval split survival (recall@10, eval queries only)');
  lines.push('| family | evalN | OFF | ON |');
  lines.push('|---|--:|--:|--:|');
  for (const f of [...Object.keys(fam).filter((x) => x !== '__all__').sort(), '__all__']) {
    const o = fam[f]; const en = o.splits.eval || 0;
    lines.push(`| ${f} | ${en} | ${en ? (o.splits.evalOFF / en).toFixed(2) : '-'} | ${en ? (o.splits.evalON / en).toFixed(2) : '-'} |`);
  }

  const report = { specVersion: corpus.specVersion, phase: corpus.phase, K, bonuses: { LENS, TEMP_UP, TEMP_DOWN, ANCHOR },
    families: Object.fromEntries(Object.entries(fam).map(([f, o]) => [f, { n: o.n, byArm: Object.fromEntries(arms.map((a) => [a, { recall10: fmt(o, a, 'recall10'), ndcg10: fmt(o, a, 'ndcg10'), negTop20: fmt(o, a, 'negTop20') }])), evalSplit: { n: o.splits.eval, OFF: o.splits.eval ? +(o.splits.evalOFF / o.splits.eval).toFixed(2) : null, ON: o.splits.eval ? +(o.splits.evalON / o.splits.eval).toFixed(2) : null } }])),
    perQuery };
  writeFileSync(resolve(outDir, `LAYER5_ABLATION_K${K}.json`), JSON.stringify(report, null, 2));
  writeFileSync(resolve(outDir, `LAYER5_ABLATION_K${K}.md`), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
main();
