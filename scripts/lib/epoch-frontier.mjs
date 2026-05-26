// EpochFrontier — deterministic rotating active-eval_hidden frontier for the Phase-2
// frontier-churn probe (docs/HANDOFFS/Substrate_reclaim_finalization_churn_tuning_guidance.md §Phase 2).
//
// THESIS: a STATIC active frontier plateaus once its minable units are mined out (the
// observed 64-plateau is in-context exhaustion of a fixed active set, NOT the substrate
// cap). A deterministic CONVEYOR that retires aged cohorts and activates fresh reserve
// units keeps supplying minable headroom → sustained accepted-advances without plateau.
//
// HONESTY INVARIANTS (enforced by construction, audited by the standalone smoke):
//  - AGGREGATE-ONLY churn: activation/retirement read ONLY epoch-aggregate stats
//    (prevHonestAccepts); NEVER per-query solved/failed. (No "retire solved / keep failed".)
//  - Retirement is by AGE (oldest activation-epoch cohort first), tie-broken by the
//    precommitted deterministic order index — never by success.
//  - The reserve order is PRECOMMITTED + deterministic (seeded) + stratum-balanced
//    (round-robin across families) so activation cannot be cherry-picked.
//  - mode 'off' is a strict no-op (active = all eval_hidden, never rotates) → the host
//    harness is byte-identical to its pre-frontier behaviour.
//
// Manifest (per epoch, for audit): activationSeed, epochId, activeEvalHiddenCount,
// active/reserve/retired root hashes (sha256 of sorted id list).

import { createHash } from 'node:crypto';

const h12 = (s) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 12), 16);
const rootHash = (ids) => '0x' + createHash('sha256').update([...ids].sort().join('|')).digest('hex').slice(0, 16);

/**
 * @param {object} o
 * @param {string[]} o.evalHiddenIds  all eval_hidden ids (the frontier universe)
 * @param {(id:string)=>string} o.familyOf  stratum key per id (logical family preferred)
 * @param {'off'|'C0'|'C1'|'C2'|'C3'|'C4'} o.mode  off/C0 static; C1 conveyor; C2 replenish-on-low-advances;
 *        C3 adaptive watermark/EWMA-headroom reservoir controller; C4 age-only slow maintenance.
 * @param {number} o.activeWindow  active-frontier size K (held EQUAL across arms)
 * @param {number} o.churnRate  base units retired+activated per epoch (C1/C2)
 * @param {number} o.maxAge  hard age cap in epochs (∞ = none); retires aged units even in C0
 * @param {number} o.lowAdvancesThreshold  C2: if prevHonestAccepts < this → bump churn
 * @param {number} o.lowAdvancesBumpRate  C2 bumped rate (default 2×churnRate)
 * @param {string} o.seed  activation seed (precommit)
 * --- C3 adaptive-watermark params (rotate only enough to maintain measured headroom) ---
 * @param {number} o.minChurn  C3/C4 maintenance churn floor (≥0)
 * @param {number} o.maxChurn  C3 churn ceiling
 * @param {number} o.targetAccepts  measured replenishment/churn supply (desired honest accepts/epoch)
 * @param {number} o.headroomLowWatermark  EWMA-accepts below this → reservoir LOW → replenish
 * @param {number} o.headroomHighWatermark  EWMA-accepts above this → reservoir HEALTHY → churn 0
 * @param {number} o.ewmaHalfLife  half-life (epochs) for the recent-accepts EWMA
 * @param {number} o.expectedYieldPerUnit  accepts per activated unit (deficit→units conversion)
 * @param {number} o.maxRootDeltaPerEpoch  hard cap on units rotated per epoch (replay-bounded)
 */
export function makeEpochFrontier({
  evalHiddenIds, familyOf, mode = 'off', activeWindow, churnRate = 4,
  maxAge = Infinity, lowAdvancesThreshold = 1, lowAdvancesBumpRate, seed = 'frontier',
  minChurn = 2, maxChurn = 12, targetAccepts = 2, headroomLowWatermark = 1, headroomHighWatermark = 3,
  ewmaHalfLife = 3, expectedYieldPerUnit = 0.17, maxRootDeltaPerEpoch = 24,
}) {
  // Precommitted stratum-balanced deterministic order: group by family, sort within by
  // seeded hash, round-robin interleave across families (sorted family names).
  const groups = new Map();
  for (const id of evalHiddenIds) {
    const f = familyOf(id) ?? 'unknown';
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(id);
  }
  for (const arr of groups.values()) arr.sort((a, b) => (h12(`${seed}:${a}`) - h12(`${seed}:${b}`)) || (a < b ? -1 : 1));
  const famNames = [...groups.keys()].sort();
  const order = [];
  for (let i = 0; ; i++) {
    let any = false;
    for (const f of famNames) { const arr = groups.get(f); if (i < arr.length) { order.push(arr[i]); any = true; } }
    if (!any) break;
  }
  const orderIdx = new Map(order.map((id, i) => [id, i]));
  const K = Math.min(activeWindow ?? order.length, order.length);

  let reservePtr = 0;
  const active = new Map();          // id -> activationEpoch
  const retired = new Set();
  let cumulativeActivated = 0, cumulativeRetired = 0, initialized = false;
  // C3 adaptive state: EWMA of recent honest accepts (the reservoir level). aggregate-only.
  let ewmaAccepts = null;
  const ewmaAlpha = 1 - Math.pow(0.5, 1 / Math.max(0.5, ewmaHalfLife));

  const activateNext = (n, epoch) => {
    let a = 0;
    while (a < n && reservePtr < order.length) {
      const id = order[reservePtr++];
      if (!active.has(id) && !retired.has(id)) { active.set(id, epoch); a++; cumulativeActivated++; }
    }
    return a;
  };
  const retireOldest = (n) => {                // by AGE (oldest activationEpoch), det. tie-break
    const sorted = [...active.entries()].sort((x, y) => (x[1] - y[1]) || (orderIdx.get(x[0]) - orderIdx.get(y[0])));
    let r = 0;
    for (let j = 0; j < n && j < sorted.length; j++) { const id = sorted[j][0]; active.delete(id); retired.add(id); cumulativeRetired++; r++; }
    return r;
  };
  const snapshot = (epoch, activated, ret, rate) => ({
    epochId: epoch, activationSeed: seed, activeEvalHiddenCount: active.size,
    activated, retired: ret, churnRate: rate ?? 0, reserveRemaining: order.length - reservePtr,
    cumulativeActivated, cumulativeRetired,
    activeIds: new Set(active.keys()),
    activeRoot: rootHash(active.keys()), reserveRoot: rootHash(order.slice(reservePtr)), retiredRoot: rootHash(retired),
  });

  /** Advance one epoch. `prevHonestAccepts` = aggregate honest accepts of the PREVIOUS epoch (null on first). */
  function stepEpoch(epoch, prevHonestAccepts) {
    if (!initialized) { initialized = true; const a = activateNext(K, epoch); return snapshot(epoch, a, 0, 0); }
    // hard age-cap retirement applies in all modes (incl. C0/off if maxAge finite).
    let ret = 0;
    if (Number.isFinite(maxAge)) {
      const aged = [...active.entries()].filter(([, ae]) => epoch - ae >= maxAge).map(([id]) => id);
      for (const id of aged) { active.delete(id); retired.add(id); cumulativeRetired++; ret++; }
    }
    if (mode === 'off' || mode === 'C0') {
      const a = activateNext(ret, epoch);     // C0 only refills age-capped slots (usually 0)
      return snapshot(epoch, a, ret, 0);
    }
    // update the recent-accepts EWMA (aggregate-only; drives C3). null prev = no signal yet.
    if (prevHonestAccepts !== null) ewmaAccepts = (ewmaAccepts === null) ? prevHonestAccepts : ewmaAlpha * prevHonestAccepts + (1 - ewmaAlpha) * ewmaAccepts;
    let rate;
    if (mode === 'C1') {
      rate = churnRate;                                   // fixed conveyor
    } else if (mode === 'C2') {                            // replenish-on-low-advances (bump when starved)
      rate = (prevHonestAccepts !== null && prevHonestAccepts < lowAdvancesThreshold) ? (lowAdvancesBumpRate ?? (churnRate * 2)) : churnRate;
    } else if (mode === 'C4') {
      rate = minChurn;                                     // age-only slow maintenance, accept-independent
    } else { // C3 adaptive watermark/EWMA-headroom reservoir controller (rotate only enough for headroom)
      const recent = ewmaAccepts ?? targetAccepts;         // before first signal, assume at target (no over-churn)
      const deficit = targetAccepts - recent;
      if (recent <= headroomLowWatermark) {                // reservoir LOW → replenish proportional to deficit
        rate = Math.min(maxChurn, Math.max(minChurn, Math.ceil(Math.max(0, deficit) / Math.max(1e-6, expectedYieldPerUnit))));
      } else if (recent >= headroomHighWatermark) {        // reservoir HEALTHY → rest (no churn)
        rate = 0;
      } else {                                             // hysteresis band → minimum maintenance only
        rate = minChurn;
      }
    }
    rate = Math.min(rate, maxRootDeltaPerEpoch);            // replay-bounded per-epoch root delta
    ret += retireOldest(rate);
    const a = activateNext(ret, epoch);        // refill to maintain window (shrinks if reserve exhausted)
    return snapshot(epoch, a, ret, rate);
  }

  return { stepEpoch, order, orderIdx, K, totalUnits: order.length, familyOrder: famNames };
}

/**
 * EpochFrontierProfile — the launch-candidate adaptive churn config (the final churn output).
 * `mode:'C3'` (adaptive) is the launch direction: rotate only enough active frontier to maintain
 * measured headroom (watermark/EWMA reservoir), never blind per-epoch churn. Pin into the signed
 * bundle alongside the evaluator profile when promoting EpochFrontier from opt-in to canonical.
 * Invariants (frozen): precommitted deterministic stratum-balanced activation order; retirement by
 * AGE/cohort only (never solved-vs-failed); churn decisions read AGGREGATE epoch stats only; baseline
 * recomputes on activeRoot change; majorDelta on corpusRoot change only; every per-epoch frontier root
 * (active/reserve/retired) is deterministically reproducible from (seed, evalHiddenIds, familyOf, mode,
 * params, prevHonestAccepts sequence) → replay validators recompute it exactly.
 */
export const DEFAULT_EPOCH_FRONTIER_PROFILE = {
  mode: 'C3',                    // adaptive watermark/EWMA-headroom reservoir controller
  activeWindow: 96,              // launch frontier window (64/96 validated band)
  minChurn: 2,                   // maintenance floor in the hysteresis band
  maxChurn: 12,                  // replenishment ceiling when reservoir is low
  headroomLowWatermark: 1,       // EWMA-accepts ≤ this → replenish
  headroomHighWatermark: 3,      // EWMA-accepts ≥ this → rest (churn 0)
  ewmaHalfLife: 3,               // epochs
  targetAccepts: 2,             // tracks MEASURED replenishment/churn supply (re-pin per corpus)
  expectedYieldPerUnit: 0.17,    // accepts/activated-unit (measured: C1 = 15 accepts / 90 rotated)
  maxRootDeltaPerEpoch: 24,      // replay-bounded per-epoch root delta
  maxAge: Infinity,              // age-cap (finite enables C4-style forced cohort retirement)
  seed: 'frontier',              // precommit activation seed
  baselineRecompute: 'activeRootChanged',
  majorDeltaPolicy: 'corpusRootChanged',
};
