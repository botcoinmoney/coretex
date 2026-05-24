#!/usr/bin/env node
/**
 * Network runway RATE-MATCHING simulator (CPU-only, deterministic).
 *
 * Answers the launch-gating question the handoff/runbook defer to a growth+churn
 * model: does the temporal working-set CAPACITY (a SHARED ~96-pair buffer, of which
 * ~64 are mineable end-to-end on the current static corpus) translate into
 * launch-PERIOD RUNWAY under realistic miner counts + corpus growth?
 *
 * This is a MODEL, not real endurance. Per runbook §5E it may rank candidates and
 * expose exhaustion/headroom regimes; it does NOT by itself close the endurance
 * program. Every assumption is explicit and flag-overridable; defaults are grounded
 * in the measured 2026-05-24 numbers (see GROUNDING below).
 *
 * ── Model (discrete epochs) ──────────────────────────────────────────────────
 * State: unmined (accessible fresh minable current/stale pairs not yet mined),
 *        occupancy (pairs currently held in the SHARED substrate buffer ≤ cap),
 *        cumulativeAccepts.
 * Per non-grace epoch:
 *   capacity   = miners × acceptsPerMinerPerEpoch        (network honest throughput if supply existed)
 *   demand     = min(emissionTarget, capacity)           (controller regulates accepts toward target)
 *   freeSlots  = cap − occupancy                         (substrate buffer is finite & SHARED)
 *   accepts    = min(demand, unmined, freeSlots)         (binding constraint = whichever is smallest)
 *   redundant  = demand − accepts                        (Δ0/anti-cheat-clean attempts: no supply or no free slot)
 *   freed      = churnRate × occupancy                   (supersession/conflict lifecycle frees slots)
 *   occupancy += accepts − freed
 *   unmined   += replenishment + freed×reMineFrac − accepts   (growth + re-minable from churn − consumed)
 * Every baselineResetEpochs: one major-delta GRACE epoch — accepts frozen to 0 (baseline recompute),
 *   demand still attempted (counts as redundant), supply still grows.
 *
 * Steady-state accepts/epoch (analytic) = min(emissionTarget, miners×a, replenishment, churnRate×cap).
 * The substrate cap (64 vs 96) is the BINDING term only in the churn-limited regime (churnRate×cap);
 * if replenishment or emissionTarget binds first, lifting 64→96 does NOT change sustained runway.
 *
 * Usage: node scripts/simulate-v2-runway-ratematch.mjs [--out <path>] [--epochs N]
 *        [--miners 10,50,100,500] [--target T] [--accepts-per-miner a]
 *        [--replenish r] [--churn c] [--remine-frac f] [--baseline-reset K]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const num = (n, d) => { const v = flag(n, undefined); return v === undefined ? d : Number(v); };

// ── GROUNDING (measured 2026-05-24; see CURRENT.md + CALIBRATION_LEDGER.jsonl) ──
const SUBSTRATE_CAP = num('substrate-cap', 96);     // r4 concurrent temporal-PAIR slots (Tier-2)
const OBSERVED_MINED = num('observed-mined', 64);   // end-to-end mined ceiling on g2 100k (calibrated controller)
const TOTAL_MINABLE_STATIC = num('total-minable', 310); // isolated-minable eval_hidden pairs (UPPER bound; in-context lower)
const EVAL_HIDDEN_TEMPORAL = 380;                   // g2 eval_hidden temporal_update queries
const TOTAL_TEMPORAL = 2500;                        // g2 total temporal_update queries (distinct current docs)

// ── Tunable network / corpus parameters (defaults documented) ──
const EPOCHS = num('epochs', 2000);
const MINERS = (flag('miners', '10,50,100,500')).split(',').map(Number);
const EMISSION_TARGET = num('target', 2);           // controller targetAdvances/epoch (per-epoch network accept budget)
const ACCEPTS_PER_MINER = num('accepts-per-miner', 0.5); // honest accepts a miner lands/epoch when supply is plentiful
const BASELINE_RESET = num('baseline-reset', 50);   // 1 grace epoch every K epochs (corpus-growth recompute cadence)
const REMINE_FRAC = num('remine-frac', 1.0);        // fraction of churn-freed pairs that become re-minable (new current/stale)

// Replenishment r = new minable temporal/update pairs per epoch from corpus growth.
// Churn c = fraction of held pairs/epoch superseded (conflict/update lifecycle) → frees a slot + (×reMineFrac) new minable.
// We sweep BOTH because they are the launch unknowns. Scenarios chosen to bracket the regimes.
// MEASURED MODE: pass --replenish R --churn C (from measure-dgen1-churn-replenish.mjs) to run a single
// measured operating point instead of the bracketing sweep (--scenario-name labels the artifact).
const replenishFlag = flag('replenish', undefined);
const churnFlag = flag('churn', undefined);
const SCENARIOS = (replenishFlag !== undefined && churnFlag !== undefined)
  ? [{ name: flag('scenario-name', 'measured'), replenish: Number(replenishFlag), churn: Number(churnFlag) }]
  : [
      { name: 'static-corpus',        replenish: 0.0,  churn: 0.00 },  // no growth, no churn → pure depletion
      { name: 'slow-growth',          replenish: 0.5,  churn: 0.01 },  // modest daily growth
      { name: 'target-matched-growth',replenish: EMISSION_TARGET, churn: 0.02 }, // growth == emission target
      { name: 'fast-growth',          replenish: 4.0,  churn: 0.04 },  // aggressive growth
    ];

function runSim({ miners, cap, replenish, churn, accessibleInitial }) {
  let unmined = accessibleInitial;     // accessible static pool at t=0 (=cap-bound burst on current corpus)
  let occupancy = 0;
  let cumAccepts = 0, cumRedundant = 0, cumDemand = 0, cumIdleMiner = 0;
  let depletionEpoch = null;           // first epoch accepts hit 0 while demand>0 (static-style exhaustion)
  let firstSaturationEpoch = null;     // first epoch occupancy reaches cap
  const occ = [];                      // occupancy samples (downsampled)
  const acceptsSeries = [];
  const capacity = miners * ACCEPTS_PER_MINER;
  for (let t = 1; t <= EPOCHS; t++) {
    const grace = (t % BASELINE_RESET === 0);
    const demand = Math.min(EMISSION_TARGET, capacity);
    let accepts = 0;
    if (!grace) {
      const freeSlots = cap - occupancy;
      accepts = Math.max(0, Math.min(demand, unmined, freeSlots));
    }
    const redundant = demand - accepts;            // attempted but Δ0 (no supply / no slot / grace)
    const idleMiner = Math.max(0, capacity - accepts); // wasted miner throughput this epoch
    const freed = churn * occupancy;
    occupancy = Math.max(0, occupancy + accepts - freed);
    unmined = Math.max(0, unmined - accepts + replenish + freed * REMINE_FRAC);
    cumAccepts += accepts; cumRedundant += redundant; cumDemand += demand; cumIdleMiner += idleMiner;
    if (depletionEpoch === null && demand > 0 && accepts === 0 && !grace) depletionEpoch = t;
    if (firstSaturationEpoch === null && occupancy >= cap - 1e-9) firstSaturationEpoch = t;
    if (t % Math.max(1, Math.floor(EPOCHS / 40)) === 0) { occ.push({ t, occupancy: +occupancy.toFixed(2), unmined: +unmined.toFixed(2), accepts: +accepts.toFixed(3) }); }
    acceptsSeries.push(accepts);
  }
  // Steady-state = mean accepts over the LAST 20% of the horizon (post-transient).
  const tail = acceptsSeries.slice(Math.floor(EPOCHS * 0.8));
  const steadyAccepts = tail.reduce((a, b) => a + b, 0) / tail.length;
  const analyticSteady = Math.min(EMISSION_TARGET, capacity, replenish + churn * cap * REMINE_FRAC, churn > 0 ? churn * cap : Infinity);
  return {
    miners, cap, capacity: +capacity.toFixed(2), replenish, churn,
    cumAccepts: +cumAccepts.toFixed(1),
    steadyAccepts: +steadyAccepts.toFixed(4),
    analyticSteadyAccepts: +(Number.isFinite(analyticSteady) ? analyticSteady : EMISSION_TARGET).toFixed(4),
    redundantRate: +(cumRedundant / Math.max(1e-9, cumDemand)).toFixed(4),
    idleMinerRate: +(cumIdleMiner / Math.max(1e-9, capacity * EPOCHS)).toFixed(4),
    depletionEpoch, firstSaturationEpoch,
    finalOccupancy: +occupancy.toFixed(2),
    occSamples: occ,
  };
}

// Binding-constraint classifier for a steady state.
function bindingConstraint({ miners, cap, replenish, churn }) {
  const capacity = miners * ACCEPTS_PER_MINER;
  const terms = {
    emissionTarget: EMISSION_TARGET,
    minerCapacity: capacity,
    replenishment: replenish + churn * cap * REMINE_FRAC,
    churnSlotFreeing: churn > 0 ? churn * cap : Infinity,
  };
  let min = Infinity, which = 'none';
  for (const [k, v] of Object.entries(terms)) if (v < min) { min = v; which = k; }
  return { binding: which, value: +min.toFixed(4), terms };
}

// ── Run the matrix ──
const results = [];
for (const scen of SCENARIOS) {
  for (const cap of [OBSERVED_MINED, SUBSTRATE_CAP]) {
    for (const miners of MINERS) {
      const r = runSim({ miners, cap, replenish: scen.replenish, churn: scen.churn, accessibleInitial: cap });
      r.scenario = scen.name;
      r.binding = bindingConstraint({ miners, cap, replenish: scen.replenish, churn: scen.churn });
      results.push(r);
    }
  }
}

// ── Required-replenishment table: r* to sustain emissionTarget for M miners ──
// Sustained accepts == target requires min(capacity, replenishment+churnTerm, churn*cap) >= target.
// For each (M, cap, churn) report the replenishment r* that makes steady == target.
const requiredReplenish = [];
for (const churn of [0.0, 0.01, 0.02, 0.04]) {
  for (const cap of [OBSERVED_MINED, SUBSTRATE_CAP]) {
    for (const miners of MINERS) {
      const capacity = miners * ACCEPTS_PER_MINER;
      const churnSlotFree = churn > 0 ? churn * cap : Infinity;
      // capacity must independently cover target:
      const capacityOk = capacity >= EMISSION_TARGET;
      // churn slot-freeing must independently cover target (else even infinite growth can't keep the buffer cycling):
      const churnOk = churnSlotFree >= EMISSION_TARGET;
      // required growth-supply r* so replenishment+churn-remine >= target:
      const rStar = Math.max(0, EMISSION_TARGET - churn * cap * REMINE_FRAC);
      requiredReplenish.push({
        miners, cap, churn, capacity: +capacity.toFixed(2),
        requiredReplenishPerEpoch: +rStar.toFixed(3),
        capacityCoversTarget: capacityOk,
        churnSlotFreeingCoversTarget: churnOk,
        sustainableAtTarget: capacityOk && churnOk,
      });
    }
  }
}

// ── 64→96 sensitivity: cumulative-accept delta (cap96 − cap64) per scenario×miners ──
const capSensitivity = [];
for (const scen of SCENARIOS) {
  for (const miners of MINERS) {
    const r64 = results.find((x) => x.scenario === scen.name && x.cap === OBSERVED_MINED && x.miners === miners);
    const r96 = results.find((x) => x.scenario === scen.name && x.cap === SUBSTRATE_CAP && x.miners === miners);
    capSensitivity.push({
      scenario: scen.name, miners,
      cumAccepts64: r64.cumAccepts, cumAccepts96: r96.cumAccepts,
      cumDelta: +(r96.cumAccepts - r64.cumAccepts).toFixed(1),
      cumDeltaPct: +(100 * (r96.cumAccepts - r64.cumAccepts) / Math.max(1e-9, r64.cumAccepts)).toFixed(2),
      steadyDelta: +(r96.steadyAccepts - r64.steadyAccepts).toFixed(4),
      binding64: r64.binding.binding, binding96: r96.binding.binding,
    });
  }
}

// ── Second-surface necessity: with ONE surface, fraction of miner capacity left idle at the
//    realistic operating point (target-matched growth, churn 0.02). A high idle fraction at
//    larger M means temporal alone can't keep miners productive → a 2nd renewable surface adds
//    an independent supply stream (its own target budget + working set). ──
const secondSurface = [];
{
  const scen = SCENARIOS.find((s) => s.name === 'target-matched-growth') ?? SCENARIOS[0];
  for (const miners of MINERS) {
    const r = results.find((x) => x.scenario === scen.name && x.cap === SUBSTRATE_CAP && x.miners === miners);
    secondSurface.push({
      miners, cap: SUBSTRATE_CAP,
      idleMinerRate: r.idleMinerRate,
      redundantRate: r.redundantRate,
      steadyAccepts: r.steadyAccepts,
      // a 2nd independent surface would add ~its own emissionTarget of supply → roughly halves idle if symmetric
      productiveMinerFraction: +(1 - r.idleMinerRate).toFixed(4),
    });
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  model: 'v2-runway-ratematch (CPU, deterministic, discrete-epoch growth+churn)',
  grounding: { SUBSTRATE_CAP, OBSERVED_MINED, TOTAL_MINABLE_STATIC, EVAL_HIDDEN_TEMPORAL, TOTAL_TEMPORAL,
    note: 'cap 96 = r4 substrate; 64 = end-to-end mined on g2; 310 = isolated-minable UPPER bound (in-context lower).' },
  params: { EPOCHS, MINERS, EMISSION_TARGET, ACCEPTS_PER_MINER, BASELINE_RESET, REMINE_FRAC },
  scenarios: SCENARIOS,
  results, requiredReplenish, capSensitivity, secondSurface,
};

const outPath = resolve(repoRoot, flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/runway-ratematch.json'));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2));

// ── Readable report ──
const pad = (s, n) => String(s).padEnd(n);
const padN = (s, n) => String(s).padStart(n);
console.log(`\n=== Network Runway Rate-Matching (CPU model) ===`);
console.log(`grounding: substrate cap=${SUBSTRATE_CAP}, observed mined=${OBSERVED_MINED}, isolated-minable=${TOTAL_MINABLE_STATIC} (UPPER); target=${EMISSION_TARGET}/epoch, accepts/miner=${ACCEPTS_PER_MINER}, horizon=${EPOCHS}ep, baseline-reset every ${BASELINE_RESET}ep\n`);

console.log(`--- Steady-state accepts/epoch + binding constraint (cap=${SUBSTRATE_CAP}) ---`);
console.log(`${pad('scenario',22)} ${pad('miners',7)} ${pad('steady',8)} ${pad('binding',16)} ${pad('depletes@',10)} ${pad('redund%',8)}`);
for (const r of results.filter((x) => x.cap === SUBSTRATE_CAP)) {
  console.log(`${pad(r.scenario,22)} ${padN(r.miners,7)} ${padN(r.steadyAccepts,8)} ${pad(r.binding.binding,16)} ${padN(r.depletionEpoch ?? '—',10)} ${padN((r.redundantRate*100).toFixed(1),8)}`);
}

console.log(`\n--- 64→96 sensitivity (does lifting the accessible cap change runway?) ---`);
console.log(`${pad('scenario',22)} ${pad('miners',7)} ${pad('cumAcc64',10)} ${pad('cumAcc96',10)} ${pad('Δcum',8)} ${pad('Δ%',7)} ${pad('ΔsteadyEp',10)} ${pad('binds(64→96)',16)}`);
for (const s of capSensitivity) {
  console.log(`${pad(s.scenario,22)} ${padN(s.miners,7)} ${padN(s.cumAccepts64,10)} ${padN(s.cumAccepts96,10)} ${padN(s.cumDelta,8)} ${padN(s.cumDeltaPct,7)} ${padN(s.steadyDelta,10)} ${pad(s.binding64+'→'+s.binding96,16)}`);
}

console.log(`\n--- Required replenishment r* (new minable pairs/epoch) to sustain target=${EMISSION_TARGET} ---`);
console.log(`${pad('miners',7)} ${pad('cap',5)} ${pad('churn',7)} ${pad('capacityOK',11)} ${pad('churnFreeOK',12)} ${pad('r*',6)} ${pad('sustainable',12)}`);
for (const q of requiredReplenish.filter((x) => x.cap === SUBSTRATE_CAP)) {
  console.log(`${padN(q.miners,7)} ${padN(q.cap,5)} ${padN(q.churn,7)} ${pad(q.capacityCoversTarget,11)} ${pad(q.churnSlotFreeingCoversTarget,12)} ${padN(q.requiredReplenishPerEpoch,6)} ${pad(q.sustainableAtTarget,12)}`);
}

console.log(`\n--- Second-surface necessity (target-matched growth, cap=${SUBSTRATE_CAP}) ---`);
console.log(`${pad('miners',7)} ${pad('productiveFrac',15)} ${pad('idleRate',9)} ${pad('redund%',8)}`);
for (const s of secondSurface) {
  console.log(`${padN(s.miners,7)} ${padN(s.productiveMinerFraction,15)} ${padN(s.idleMinerRate,9)} ${padN((s.redundantRate*100).toFixed(1),8)}`);
}

console.log(`\nartifact: ${flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/runway-ratematch.json')}`);
