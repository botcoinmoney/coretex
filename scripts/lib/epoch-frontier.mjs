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
 * @param {'off'|'C0'|'C1'|'C2'} o.mode  off/C0 static; C1 conveyor; C2 replenish-on-low-advances
 * @param {number} o.activeWindow  active-frontier size K (held EQUAL across arms)
 * @param {number} o.churnRate  base units retired+activated per epoch (C1/C2)
 * @param {number} o.maxAge  hard age cap in epochs (∞ = none); retires aged units even in C0
 * @param {number} o.lowAdvancesThreshold  C2: if prevHonestAccepts < this → bump churn
 * @param {number} o.lowAdvancesBumpRate  C2 bumped rate (default 2×churnRate)
 * @param {string} o.seed  activation seed (precommit)
 */
export function makeEpochFrontier({
  evalHiddenIds, familyOf, mode = 'off', activeWindow, churnRate = 4,
  maxAge = Infinity, lowAdvancesThreshold = 1, lowAdvancesBumpRate, seed = 'frontier',
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
    // C1 conveyor / C2 replenish-on-low-advances (AGGREGATE-ONLY trigger).
    let rate = churnRate;
    if (mode === 'C2' && prevHonestAccepts !== null && prevHonestAccepts < lowAdvancesThreshold) {
      rate = lowAdvancesBumpRate ?? (churnRate * 2);
    }
    ret += retireOldest(rate);
    const a = activateNext(ret, epoch);        // refill to maintain window (shrinks if reserve exhausted)
    return snapshot(epoch, a, ret, rate);
  }

  return { stepEpoch, order, orderIdx, K, totalUnits: order.length, familyOrder: famNames };
}
