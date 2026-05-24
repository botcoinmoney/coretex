#!/usr/bin/env node
/**
 * MAXIMUM SUSTAINABLE TARGET calculator (CPU, deterministic).
 *
 * Launch is NOT a fixed emission target. The goal is the MAX SUSTAINABLE RUNWAY:
 *   maximize genuine accepts/epoch  s.t.  no junk acceptance, no redundant Δ0 churn,
 *   baseline-reset correctness, and corpus growth/replenishment keeps pace.
 *
 * Architect formula (operator-defined):
 *   T_max ≈ replenishment + churn · workingSet           [accepts/epoch]
 *   bounded by available honest lift (minable yield) and anti-cheat (= gate, held at 0).
 *
 * Where:
 *   replenishment = new minable temporal facts/epoch from corpus growth
 *   churn         = fraction of the held working set re-minably superseded/epoch (LIVE updates)
 *   workingSet    = concurrent temporal-pair capacity (cap64 observed end-to-end, cap96 r4 substrate)
 *
 * ── Measured grounding (DGEN-1 G1→G2→G3; see RUNWAY_RATEMATCH_MEASURED_FINDINGS.md) ──
 *   - new eval_hidden temporal chains per G2→G3 tripling = 749 (density ~36/10k docs, stable).
 *   - mean chain depth ~6 → but chains are BORN COMPLETE on growth (new facts carry their full
 *     revision history); growth does NOT re-revise already-held facts. So LIVE churn of held
 *     facts ≈ 0 in DGEN-1 today. churn>0 requires a live-update corpus OR a 2nd surface (B,
 *     conflict/update lifecycle) that emits supersession events against held state.
 *   - honest-lift yield: of new eval chains, the fraction that produce genuine acceptable lift:
 *       isolated-burial  ≈ 310/380 = 0.816 (upper bound, vs base retrieval in isolation)
 *       in-context       ≈  64/380 = 0.168 (observed end-to-end on g2 w/ calibrated controller)
 *
 * Usage: node scripts/calc-max-sustainable-target.mjs [--accepts-per-miner a]
 *        [--major-delta-threshold M] [--churn c] [--out <path>]
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const num = (n, d) => { const v = flag(n, undefined); return v === undefined ? d : Number(v); };

// Measured (reload from the measurement artifact when present; else fall back to recorded values).
let NEW_EVAL_CHAINS_PER_TRIPLING = 749;
try {
  const m = JSON.parse(readFileSync(resolve(repoRoot, `${base}/dgen1-churn-replenish.json`), 'utf8'));
  const d = (m.deltas || []).find((x) => x.to === 'G3') ?? (m.deltas || [])[m.deltas.length - 1];
  if (d?.dEvalHiddenChains) NEW_EVAL_CHAINS_PER_TRIPLING = d.dEvalHiddenChains;
} catch { /* use fallback */ }

const ACCEPTS_PER_MINER = num('accepts-per-miner', 0.5);
const MAJOR_DELTA_THRESHOLD = num('major-delta-threshold', 56); // launch ~5% of G3 eval_hidden (1129) ≈ 56
const CHURN = num('churn', 0.0);                                // LIVE churn of held facts: 0 in DGEN-1 today
const WORKING_SETS = [64, 96];
// Honest-lift yield = fraction of new eval chains that produce genuine acceptable lift.
// CPU-CONFIRMED (measure-temporal-honest-lift-yield.mjs, g2 100k): supply+admission yield = 309/380 = 0.813
// (a stale buries current AND the boosted current re-admits to the rerank cap past unrelated docs; admission
// is non-binding). The legacy 0.168 "in-context" floor was a CONFOUNDED stock/schedule number — RETIRED.
// The realized in-context yield ≤ cpuSupplyAdmission, degraded only by cross-query pack interference + Qwen
// final reorder — pending the staged A100 confirmation. 'ideal' = upper sanity bound.
const YIELDS = { cpuSupplyAdmission: 309 / 380, ideal: 1.0 };

// Cadence = epochs to deliver one G2→G3-magnitude (≈3×) corpus expansion (1 epoch ≈ 1 day).
// "daily/weekly/..." = that 3× expansion delivered over the named period; realistic band is
// monthly→annual. 50/100 included per the operator's tripling scenarios.
const CADENCES = [
  { name: 'daily(1)',      epochsPerTripling: 1 },
  { name: 'weekly(7)',     epochsPerTripling: 7 },
  { name: 'monthly(30)',   epochsPerTripling: 30 },
  { name: '50ep',          epochsPerTripling: 50 },
  { name: 'quarterly(90)', epochsPerTripling: 90 },
  { name: '100ep',         epochsPerTripling: 100 },
  { name: 'annual(365)',   epochsPerTripling: 365 },
];

function tmax({ epochsPerTripling, churn, workingSet, yield: y }) {
  const rawReplenish = NEW_EVAL_CHAINS_PER_TRIPLING / epochsPerTripling; // new chains/epoch
  const effReplenish = rawReplenish * y;                                 // honest-lift-minable/epoch
  const churnSupply = churn * workingSet;                                // live re-minable turnover/epoch
  const T = effReplenish + churnSupply;
  return { rawReplenish: +rawReplenish.toFixed(3), effReplenish: +effReplenish.toFixed(3), churnSupply: +churnSupply.toFixed(3), T: +T.toFixed(3) };
}

// Build the curve: per cadence × workingSet × yield.
const curve = [];
for (const c of CADENCES) {
  for (const ws of WORKING_SETS) {
    for (const [yname, y] of Object.entries(YIELDS)) {
      const r = tmax({ epochsPerTripling: c.epochsPerTripling, churn: CHURN, workingSet: ws, yield: y });
      curve.push({
        cadence: c.name, epochsPerTripling: c.epochsPerTripling, workingSet: ws, yieldName: yname, yield: +y.toFixed(3),
        maxSustainableAcceptsPerEpoch: r.T,
        productiveMiners: +(r.T / ACCEPTS_PER_MINER).toFixed(1),
        baselineResetEveryEpochs: r.rawReplenish > 0 ? +(MAJOR_DELTA_THRESHOLD / r.rawReplenish).toFixed(1) : Infinity,
        // If growth STALLS (replenish→0), the static accessible pool (=workingSet) depletes at the
        // last sustained consumption rate T: depletionEpochs ≈ workingSet / T.
        depletionEpochsIfGrowthStalls: r.T > 0 ? +(ws / r.T).toFixed(1) : Infinity,
        components: r,
      });
    }
  }
}

// cap64-vs-cap96 sensitivity: ΔT_max = churn·(96−64). Zero when churn=0 (DGEN-1 today).
const capMatters = +(CHURN * (96 - 64)).toFixed(3);

// When does a 2nd renewable surface become MANDATORY?
// A single temporal surface caps the network at T_max(best realistic cadence). If the desired
// productive network exceeds that, you need more surfaces (each adds its own T_max budget) OR a
// faster cadence. Report the network ceiling per yield at a realistic monthly cadence + the churn
// needed to lift it without faster growth.
const realisticCadence = 30; // monthly
const secondSurface = Object.entries(YIELDS).map(([yname, y]) => {
  const t96 = tmax({ epochsPerTripling: realisticCadence, churn: CHURN, workingSet: 96, yield: y }).T;
  return {
    yieldName: yname, cadence: 'monthly(30)', workingSet: 96,
    maxSustainableAcceptsPerEpoch: t96,
    productiveMinerCeiling: +(t96 / ACCEPTS_PER_MINER).toFixed(1),
    note: 'Beyond this productive-miner ceiling at this cadence, either grow the corpus faster or add a 2nd renewable surface (B). With DGEN-1 churn≈0, a 2nd surface that emits LIVE supersession (conflict/update lifecycle) adds churn·workingSet on top — the only lever that does not require faster corpus growth.',
  };
});

const summary = {
  generatedAt: new Date().toISOString(),
  model: 'max-sustainable-target T_max = replenishment + churn·workingSet, bounded by honest-lift yield; anti-cheat held at 0',
  grounding: { NEW_EVAL_CHAINS_PER_TRIPLING, ACCEPTS_PER_MINER, MAJOR_DELTA_THRESHOLD, CHURN,
    yields: YIELDS, churnNote: 'DGEN-1 chains are born complete on growth → LIVE churn of held facts ≈ 0 today; churn>0 needs a live-update corpus or surface B.' },
  curve, capMatters, secondSurface,
};
const outPath = resolve(repoRoot, flag('out', `${base}/max-sustainable-target.json`));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2));

// ── Report (in-context-observed yield = the conservative launch bound; isolated = optimistic) ──
const pad = (s, n) => String(s).padEnd(n), padN = (s, n) => String(s).padStart(n);
console.log(`\n=== Maximum Sustainable Target curve  (T_max = replenishment + churn·workingSet) ===`);
console.log(`grounding: ${NEW_EVAL_CHAINS_PER_TRIPLING} new eval chains/tripling, accepts/miner=${ACCEPTS_PER_MINER}, LIVE churn=${CHURN} (DGEN-1 today), majorDeltaThreshold=${MAJOR_DELTA_THRESHOLD}`);
console.log(`cap64 vs cap96 ΔT_max = churn·32 = ${capMatters}/epoch  → ${capMatters === 0 ? 'cap does NOT matter while churn=0 (replenishment-bound)' : 'cap matters'}\n`);

for (const yname of ['cpuSupplyAdmission']) {
  console.log(`--- honest-lift yield = ${yname} (${(YIELDS[yname]).toFixed(3)}); workingSet=96 ---`);
  console.log(`${pad('cadence', 15)} ${pad('replenish/ep', 13)} ${pad('Tmax acc/ep', 12)} ${pad('prod.miners', 12)} ${pad('baselineReset@', 15)} ${pad('depletes@stall', 15)}`);
  for (const row of curve.filter((r) => r.workingSet === 96 && r.yieldName === yname)) {
    console.log(`${pad(row.cadence, 15)} ${padN(row.components.effReplenish, 13)} ${padN(row.maxSustainableAcceptsPerEpoch, 12)} ${padN(row.productiveMiners, 12)} ${padN(row.baselineResetEveryEpochs, 15)} ${padN(row.depletionEpochsIfGrowthStalls, 15)}`);
  }
  console.log('');
}
console.log(`--- second-surface ceiling (monthly cadence, cap96) ---`);
for (const s of secondSurface) console.log(`  yield=${pad(s.yieldName, 18)} Tmax=${padN(s.maxSustainableAcceptsPerEpoch, 7)}/ep  productive-miner ceiling=${padN(s.productiveMinerCeiling, 7)}`);
console.log(`\nKey: with DGEN-1 churn≈0, T_max is REPLENISHMENT-bound → set the controller target to track measured`);
console.log(`replenishment (dynamic), not a fixed constant. cap64↔96 is irrelevant until a live-churn surface exists.`);
console.log(`To raise the productive-miner ceiling: grow the corpus faster (lower epochs/tripling) OR add surface B`);
console.log(`(conflict/update lifecycle) which introduces churn·workingSet — the only non-growth lever.\n`);
console.log(`artifact: ${flag('out', `${base}/max-sustainable-target.json`)}`);
