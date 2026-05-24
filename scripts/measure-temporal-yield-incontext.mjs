#!/usr/bin/env node
/**
 * A100 real-Qwen confirmation of the temporal honest-lift YIELD (the SUFFICIENT
 * condition the CPU prefilter could not settle). For a stratified sample of
 * eval_hidden temporal chains on the launch-like track (g2 100k):
 *
 *   - ISOLATED Δ:  mine the chain into an empty substrate, score over a SINGLE-query
 *                  pack (just that chain's query). Per-query temporal lift.
 *   - IN-CONTEXT Δ: mine the SAME chain into empty, score over its PRODUCTION pack
 *                  (deriveQueryPack, profile quotas) — the chain competes with the
 *                  other pack queries (cross-query interference is live).
 *
 * Realized in-context yield = fraction of chains with in-context Δ > 0 (and the
 * accept rate at the production threshold). Pack-interference factor = isolated
 * yield − in-context yield. Reuses the SAME patch encoder + scorer as the endurance
 * harness (honestPatch temporal + evaluateRetrievalBenchmarkPatch), so the numbers
 * are production-faithful. CPU-smoke with --reranker deterministic; real run --reranker gpu.
 *
 * Usage: node scripts/measure-temporal-yield-incontext.mjs --reranker gpu
 *        [--corpus <p>] [--emb <p>] [--profile <p>] [--pack-size 12] [--target 80]
 *        [--seeds a5,b7,c3] [--max-packs 40] [--out <p>]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { honestPatch, empty } from './lib/v2-patch-families.mjs';

const { scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkPatch, createDeterministicReranker } = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const num = (n, d) => { const v = flag(n, undefined); return v === undefined ? d : Number(v); };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-realism-g2-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-realism-g2-embeddings.json`);
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-deep-r1.json');
const PACK_SIZE = num('pack-size', 12);          // production pack shape (endurance regime used 12)
const TARGET = num('target', 80);                // distinct chains to measure
const MAX_PACKS = num('max-packs', 40);
const SEEDS = flag('seeds', 'a5,b7,c3').split(',');
const rerankerArg = flag('reranker', 'deterministic');

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const { corpus, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const reranker = (rerankerArg === 'gpu' || rerankerArg === 'cpu')
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : await createDeterministicReranker();
const opts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
// ORACLE scoped-lifecycle upper-bound (substrate-vNext): scope each chain's temporal boost/suppress
// to its OWNING query (vs the blunt global default that floods neighbours = the 0.65 interference).
const oracleScope = argv.includes('--oracle-scope');
if (oracleScope) opts.temporalOracleScopePerQuery = true;
const minImpr = Number(profile.patchAcceptanceFloors.minImprovementPpm);
const replayTol = Number(profile.replayTolerancePpm);
const accOpts = { structuralFloor: profile.patchAcceptanceFloors.structuralFloor, minImprovementPpm: minImpr, acceptanceThresholdPpm: minImpr + replayTol };
const hiddenPack = { ...profile.hiddenPack, packSize: PACK_SIZE };

const directOf = (lq) => (lq.qrels ?? []).find((r) => r.role === 'direct')?.docId ?? null;
async function deltaFor(pack, chainDirectDoc, otherTemporalDirects) {
  // mine ONLY this chain: skip every other temporal direct doc in the pack.
  const skip = new Set(otherTemporalDirects.filter((d) => d !== chainDirectDoc));
  const patch = honestPatch({ state: empty(), family: 'temporal', pack, logicalQById, recordSlot: 0, skipDocIds: skip });
  const r = await evaluateRetrievalBenchmarkPatch(empty(), patch, corpus, pack, opts, accOpts);
  return { deltaPpm: r.deltaPpm, dTemporal: r.after.temporal - r.before.temporal, dNdcg: r.after.nDCG10 - r.before.nDCG10,
    accepted: r.deltaPpm > (minImpr + replayTol), minedDoc: patch && patch.wordCount > 0 };
}

const measured = [];
const seen = new Set();
const eventById = new Map(corpus.events.map((e) => [e.id, e]));
outer:
for (const seed of SEEDS) {
  for (let p = 0; p < MAX_PACKS; p++) {
    const seedHex = '0x' + createHash('sha256').update(`${seed}:${p}`).digest('hex');
    const pack = deriveQueryPack(p, seedHex, corpus, hiddenPack);
    const tEvents = pack.events.filter((e) => e.logicalFamily === 'temporal_update');
    const directs = tEvents.map((e) => directOf(logicalQById.get(e.id))).filter(Boolean);
    for (const e of tEvents) {
      const lq = logicalQById.get(e.id); const cur = directOf(lq); if (!cur || seen.has(cur)) continue;
      // IN-CONTEXT Δ over the production pack.
      const inctx = await deltaFor(pack, cur, directs);
      // ISOLATED Δ over a single-query pack (same scorer config).
      const soloPack = { ...pack, events: [e] };
      const iso = await deltaFor(soloPack, cur, [cur]);
      measured.push({ id: cur, band: e.band, seed, packSize: pack.events.length,
        isoDeltaPpm: iso.deltaPpm, isoAccepted: iso.accepted, isoPos: iso.deltaPpm > 0,
        inctxDeltaPpm: inctx.deltaPpm, inctxAccepted: inctx.accepted, inctxPos: inctx.deltaPpm > 0,
        inctxDTemporal: inctx.dTemporal, inctxDNdcg: inctx.dNdcg });
      seen.add(cur);
      if (measured.length % 10 === 0) console.error(`[yield-gpu] measured ${measured.length}/${TARGET}`);
      if (measured.length >= TARGET) break outer;
    }
  }
}

function rate(arr, f) { return arr.length ? +(arr.filter(f).length / arr.length).toFixed(4) : null; }
function wilson(k, n) { if (!n) return [null, null]; const z = 1.96, p = k / n, d = 1 + z * z / n; const c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [+((c - m) / d).toFixed(4), +((c + m) / d).toFixed(4)]; }
function pct(arr, q) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(0); }

const n = measured.length;
const inctxPos = measured.filter((m) => m.inctxPos).length;
const isoPos = measured.filter((m) => m.isoPos).length;
const inctxAcc = measured.filter((m) => m.inctxAccepted).length;
const inctxZero = measured.filter((m) => Math.abs(m.inctxDeltaPpm) < 1).length;
const byBand = {};
for (const m of measured) { const b = m.band || 'none'; (byBand[b] ??= { n: 0, isoPos: 0, inctxPos: 0, inctxAcc: 0 }); byBand[b].n++; if (m.isoPos) byBand[b].isoPos++; if (m.inctxPos) byBand[b].inctxPos++; if (m.inctxAccepted) byBand[b].inctxAcc++; }
const inctxDeltas = measured.map((m) => m.inctxDeltaPpm);

const summary = {
  generatedAt: new Date().toISOString(),
  track: corpusPath, profile: profilePath, reranker: rerankerArg, packSize: PACK_SIZE, nChains: n, seeds: SEEDS,
  oracleScope, mode: oracleScope ? 'scoped-lifecycle-oracle' : 'blunt-global (current temporal)',
  isolatedPositiveYield: rate(measured, (m) => m.isoPos),
  inContextPositiveYield: rate(measured, (m) => m.inctxPos),
  inContextPositiveYield_CI95: wilson(inctxPos, n),
  inContextAcceptYield: rate(measured, (m) => m.inctxAccepted),
  inContextZeroRate: rate(measured, (m) => Math.abs(m.inctxDeltaPpm) < 1),
  packInterferenceFactor: (isoPos != null && inctxPos != null) ? +((isoPos - inctxPos) / n).toFixed(4) : null,
  inContextDeltaPpm_dist: { p10: pct(inctxDeltas, 0.1), p50: pct(inctxDeltas, 0.5), p90: pct(inctxDeltas, 0.9), min: pct(inctxDeltas, 0), max: pct(inctxDeltas, 1) },
  byBand,
  note: 'Realized in-context yield = inContextPositiveYield (Δ>0). Production accept rate = inContextAcceptYield (Δ>minImpr+replayTol). Pack-interference = isolated − in-context positive yield. CPU prefilter bounded supply+admission at 0.813; this places the realized real-Qwen yield within (·,0.813].',
};
const outName = `temporal-yield-incontext-${rerankerArg}-pk${PACK_SIZE}.json`;
const outPath = resolve(repoRoot, flag('out', `${base}/${outName}`));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ...summary, rows: measured }, null, 2));
if (typeof reranker.close === 'function') reranker.close();

const pad = (s, w) => String(s).padEnd(w), padN = (s, w) => String(s).padStart(w);
console.log(`\n=== Temporal in-context YIELD (real-Qwen=${rerankerArg}, packSize=${PACK_SIZE}, n=${n}) ===`);
console.log(`ISOLATED positive-Δ yield:    ${summary.isolatedPositiveYield}`);
console.log(`IN-CONTEXT positive-Δ yield:  ${summary.inContextPositiveYield}  (95% CI ${summary.inContextPositiveYield_CI95[0]}–${summary.inContextPositiveYield_CI95[1]})  ← realized yield`);
console.log(`IN-CONTEXT accept yield (>thr):${summary.inContextAcceptYield}`);
console.log(`IN-CONTEXT Δ0 rate:           ${summary.inContextZeroRate}`);
console.log(`PACK-INTERFERENCE factor:     ${summary.packInterferenceFactor}  (isolated − in-context)`);
console.log(`in-context Δppm dist: p10=${summary.inContextDeltaPpm_dist.p10} p50=${summary.inContextDeltaPpm_dist.p50} p90=${summary.inContextDeltaPpm_dist.p90}`);
console.log(`--- by band ---`);
console.log(`${pad('band', 12)} ${pad('n', 5)} ${pad('iso+', 7)} ${pad('inctx+', 8)} ${pad('inctxAcc', 9)}`);
for (const [b, v] of Object.entries(byBand).sort((a, c) => c[1].n - a[1].n)) console.log(`${pad(b, 12)} ${padN(v.n, 5)} ${padN((v.isoPos / v.n).toFixed(2), 7)} ${padN((v.inctxPos / v.n).toFixed(2), 8)} ${padN((v.inctxAcc / v.n).toFixed(2), 9)}`);
console.log(`\nartifact: ${outPath.replace(repoRoot + '/', '')}`);
