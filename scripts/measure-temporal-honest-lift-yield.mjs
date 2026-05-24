#!/usr/bin/env node
/**
 * Measure the temporal honest-lift YIELD on the launch-like DGEN-1 track (g2 100k),
 * to collapse the 0.168–0.816 uncertainty band. CPU PREFILTER (this script) computes
 * the structural bounds; the real-Qwen in-context Δ-rate is the smallest-sufficient
 * A100 confirmation staged separately (A100 currently unreachable — key absent).
 *
 * Yield definitions (fraction of eval_hidden temporal chains that can produce honest lift):
 *  - ISOLATED-minable (optimistic bound): in BASE biCosine, a stale doc out-scores the
 *    current/direct doc among the chain's OWN truth docs → a temporal patch (boost current,
 *    suppress stale) can reorder them. Reproduces the prior 310/380.
 *  - IN-CONTEXT-ADMISSION-minable (tighter CPU bound): over the FULL owner store (DGEN-1 =
 *    one universe → global stage-1), is the current doc buried by UNRELATED docs the temporal
 *    patch cannot move? A patch only boosts current (+temporalCurrentBoost) and suppresses the
 *    chain's stales (−temporalStaleSuppression); unrelated docs above current are untouched.
 *    Minable-admission ⇔ the boosted current enters the rerank cap (top rerankerInputTopK)
 *    AND outranks its stales. This is the structural NECESSARY condition for a positive
 *    in-context Δ; the SUFFICIENT condition (Qwen final reorder) is the A100 confirmation.
 *
 * The previously-cited 0.168 "in-context" floor was a STOCK-over-schedule number (64 mined /
 * 380 over 45 endurance epochs), confounded by mining-selection re-pick + substrate cap + pack
 * rotation (ledger 2026-05-24 re-diagnosis: 139 minable were PRESENTED, only 64 mined) — NOT a
 * clean per-chain yield. This script measures the clean per-chain structural yield instead.
 *
 * Run: node --max-old-space-size=4096 scripts/measure-temporal-honest-lift-yield.mjs
 *      [--corpus <p>] [--emb <p>] [--cap 64] [--boost 0.1] [--suppress 0.1]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const num = (n, d) => { const v = flag(n, undefined); return v === undefined ? d : Number(v); };

const corpusPath = flag('corpus', `${base}/dgen1-realism-g2-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-realism-g2-embeddings.json`);
const CAP = num('cap', 64);                 // rerankerInputTopK (profile g2 value)
const BOOST = num('boost', 0.1);            // temporalCurrentBoost (profile)
const SUPPRESS = num('suppress', 0.1);      // temporalStaleSuppression (profile)

console.error('[yield] loading corpus + embeddings…');
const corpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const cache = JSON.parse(readFileSync(resolve(repoRoot, embPath), 'utf8'));
const DIM = cache.dim;
const b64ToVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
function norm(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s; return o; }

// Decode + L2-normalize all doc vectors into one contiguous matrix for fast scans.
const docIds = corpus.docs.map((d) => d.id);
const N = docIds.length;
const mat = new Float32Array(N * DIM);
const idxById = new Map();
for (let i = 0; i < N; i++) {
  const id = docIds[i]; idxById.set(id, i);
  const nv = norm(b64ToVec(cache.docs[id]));
  mat.set(nv, i * DIM);
}
console.error(`[yield] ${N} doc vectors decoded (dim=${DIM}).`);

const docById = new Map(corpus.docs.map((d) => [d.id, d]));
function cosToAll(qn) { // returns Float32Array of cos(q, doc_i)
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) { let s = 0; const o = i * DIM; for (let k = 0; k < DIM; k++) s += qn[k] * mat[o + k]; out[i] = s; }
  return out;
}
function rankAbove(cos, threshold) { let c = 0; for (let i = 0; i < N; i++) if (cos[i] > threshold) c++; return c; } // 0-based rank

// eval_hidden temporal_update chains.
const tq = corpus.queries.filter((q) => q.family === 'temporal_update' && q.split === 'eval_hidden');
console.error(`[yield] ${tq.length} eval_hidden temporal chains; scanning…`);

const rows = [];
let done = 0;
for (const q of tq) {
  const qn = norm(b64ToVec(cache.queries[q.id]));
  const direct = (q.qrels || []).find((r) => r.role === 'direct');
  const stales = (q.qrels || []).filter((r) => r.role === 'stale').map((r) => r.docId);
  if (!direct) continue;
  const curId = direct.docId;
  const cos = cosToAll(qn);
  const curCos = cos[idxById.get(curId)];
  const staleCos = stales.map((s) => cos[idxById.get(s)]).filter((x) => x !== undefined);
  const maxStaleCos = staleCos.length ? Math.max(...staleCos) : -1;

  // ISOLATED: a stale out-scores current among the chain's own truth docs.
  const isolatedMinable = maxStaleCos > curCos;

  // IN-CONTEXT global ranks over the full owner store (DGEN-1 = one universe).
  const curRankBase = rankAbove(cos, curCos);                       // 0-based global rank of current (base)
  let staleAboveCur = 0; for (const s of stales) if ((cos[idxById.get(s)] ?? -1) > curCos) staleAboveCur++;
  // After the patch: current → curCos+BOOST, each stale → staleCos−SUPPRESS. Current outranks its stales?
  const outranksStales = staleCos.every((sc) => (curCos + BOOST) > (sc - SUPPRESS));
  // UNRELATED docs (not this chain's stales) still above the boosted current — these are IMMOVABLE
  // by a temporal patch. This is the in-context burial the isolated truth-set view misses.
  const docsAboveBoosted = rankAbove(cos, curCos + BOOST);
  let stalesAboveBoosted = 0; for (const s of stales) if ((cos[idxById.get(s)] ?? -1) > (curCos + BOOST)) stalesAboveBoosted++;
  const unrelatedAboveBoosted = Math.max(0, docsAboveBoosted - stalesAboveBoosted);
  const curInCapAfter = unrelatedAboveBoosted < CAP;                // boosted current admitted to rerank cap
  // IN-CONTEXT minable (faithful, ⊆ isolated): the chain is isolated-buried (temporal skill applies),
  // the patch reorders current above ALL its stales, AND the boosted current reaches the rerank cap
  // past unrelated docs. Necessary condition for a positive in-context temporal Δ; Qwen final reorder
  // (sufficient) is the staged A100 confirmation.
  const inContextAdmissionMinable = isolatedMinable && outranksStales && curInCapAfter;
  const inCapBase = curRankBase < CAP;
  const inCapAfter = unrelatedAboveBoosted < CAP;

  rows.push({
    id: q.id, band: q.band, depth: (q.qrels || []).length,
    curCos: +curCos.toFixed(4), maxStaleCos: +maxStaleCos.toFixed(4),
    staleGap: +(maxStaleCos - curCos).toFixed(4),       // >0 ⇒ isolated-buried; magnitude proxy for Δ
    curRankBase, unrelatedAboveBoosted, staleAboveCur, inCapBase, inCapAfter,
    isolatedMinable, inContextAdmissionMinable,
  });
  if (++done % 50 === 0) console.error(`[yield]   ${done}/${tq.length}`);
}

// ── Aggregate ──
const byBand = {};
function bandAgg(r) { const b = r.band || 'none'; (byBand[b] ??= { n: 0, isolated: 0, inContext: 0 }); byBand[b].n++; if (r.isolatedMinable) byBand[b].isolated++; if (r.inContextAdmissionMinable) byBand[b].inContext++; }
rows.forEach(bandAgg);
const n = rows.length;
const isolated = rows.filter((r) => r.isolatedMinable).length;
const inContext = rows.filter((r) => r.inContextAdmissionMinable).length;
const gaps = rows.filter((r) => r.isolatedMinable).map((r) => r.staleGap).sort((a, b) => a - b);
const gapPct = (p) => gaps.length ? +gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))].toFixed(4) : null;
// redundant-Δ0 proxy = current already top among its truths AND in-cap (patch buys nothing).
const redundantZero = rows.filter((r) => !r.isolatedMinable && r.curRankBase === 0).length;

const summary = {
  generatedAt: new Date().toISOString(),
  track: corpusPath, dim: DIM, cap: CAP, boost: BOOST, suppress: SUPPRESS,
  evalHiddenTemporalChains: n,
  isolatedMinable: isolated, isolatedYield: +(isolated / n).toFixed(4),
  inContextAdmissionMinable: inContext, inContextAdmissionYield: +(inContext / n).toFixed(4),
  redundantZeroProxy: redundantZero, redundantZeroRate: +(redundantZero / n).toFixed(4),
  staleGapMagnitude_isolated: { p10: gapPct(0.1), p50: gapPct(0.5), p90: gapPct(0.9), max: gaps.length ? +gaps[gaps.length - 1].toFixed(4) : null },
  byBand,
  note: 'CPU PREFILTER. isolatedYield = optimistic supply bound (reproduces ~310/380). inContextAdmissionYield = tighter structural NECESSARY condition for positive in-context Δ (boosted current admitted into rerank cap + outranks its stales over the full owner store). The real-Qwen final-reorder Δ rate (SUFFICIENT) is the staged A100 confirmation and lies AT OR BELOW inContextAdmissionYield. The legacy 0.168 floor was a confounded stock/schedule number, not a clean per-chain yield.',
};
const outPath = resolve(repoRoot, flag('out', `${base}/temporal-honest-lift-yield.json`));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ...summary, rows }, null, 2));

const pad = (s, n) => String(s).padEnd(n), padN = (s, n) => String(s).padStart(n);
console.log(`\n=== Temporal honest-lift YIELD — CPU prefilter (${corpusPath.split('/').pop()}) ===`);
console.log(`eval_hidden temporal chains: ${n}  | cap=${CAP} boost=${BOOST} suppress=${SUPPRESS}\n`);
console.log(`ISOLATED-minable (optimistic supply bound):        ${isolated}/${n} = ${(isolated / n).toFixed(3)}  [reproduces ~310/380]`);
console.log(`IN-CONTEXT-ADMISSION-minable (tighter CPU bound):  ${inContext}/${n} = ${(inContext / n).toFixed(3)}  [necessary cond. for +Δ]`);
console.log(`redundant-Δ0 proxy (current already top, in-cap):  ${redundantZero}/${n} = ${(redundantZero / n).toFixed(3)}`);
console.log(`isolated stale-gap magnitude (Δ proxy): p10=${gapPct(0.1)} p50=${gapPct(0.5)} p90=${gapPct(0.9)}`);
console.log(`\n--- by band ---`);
console.log(`${pad('band', 12)} ${pad('n', 6)} ${pad('isolated', 16)} ${pad('inContextAdm', 16)}`);
for (const [b, v] of Object.entries(byBand).sort((a, b2) => b2[1].n - a[1].n)) {
  console.log(`${pad(b, 12)} ${padN(v.n, 6)} ${padN(`${v.isolated} (${(v.isolated / v.n).toFixed(2)})`, 16)} ${padN(`${v.inContext} (${(v.inContext / v.n).toFixed(2)})`, 16)}`);
}
console.log(`\nYIELD BAND (post-prefilter): in-context real-Qwen yield ∈ (0, ${(inContext / n).toFixed(3)}] ; optimistic supply ${(isolated / n).toFixed(3)}.`);
console.log(`A100 confirmation needed to place the real-Qwen final-Δ rate within this CPU-bounded band.`);
console.log(`artifact: ${flag('out', `${base}/temporal-honest-lift-yield.json`)}`);
