/**
 * §18 GRAMMAR-ERA ROTATION machinery (era-2 iteration — this lane).
 *
 * The §17.26 runway verdict (harness ledger) is: the operation-general runway is
 * SUSTAINABLE only as a PROPERTY of era-rotation + retirement — a static frontier
 * reads net→0 at motif saturation. Until now the executable-operation ERA was the
 * hard-coded constant 1 and only the FRONTIER (motifs) rotated; the GRAMMAR era
 * never changed. This module makes the grammar era a first-class, scheduled,
 * rotatable quantity and owns the transition lifecycle:
 *
 *   coexistence → retirement of the prior era's motifs → rollback on failure,
 *
 * plus the per-evolve TRANSITION JOURNAL the coordinator verifier consumes.
 *
 * Everything here is a PURE, deterministic function of the schedule + epoch — no
 * Date.now / Math.random. The actual grammar (edge partition, 36-class bank,
 * disjointness + G-B17 posture) lives in
 * `scripts/lib/bmu-generators/operation-program.mjs` (`BMU_EXECUTABLE_ERA_REGISTRY`,
 * `eraSpec`, `programBankForEra`). This module schedules WHEN each registered era
 * is the active minting grammar and WHEN the prior era retires.
 *
 * STOP-LINE: build+test+prove; arms nothing; mutates no production state.
 */
import { eraSpec, programBankForEra } from '../bmu-generators/operation-program.mjs';

const FAMILIES = Object.freeze(['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention']);

/**
 * Build a validated era schedule.
 *
 * @param {Array<{
 *   era: number,               // must be a registered era in BMU_EXECUTABLE_ERA_REGISTRY
 *   activationEpoch: number,   // epoch from which this era becomes the minting grammar
 *   coexistenceWindowEpochs?: number, // epochs after activation during which the prior
 *                                     //   era's residents/motifs are allowed to remain
 *                                     //   active (they retire naturally afterwards)
 *   retireGraceEpochs?: number,       // epochs after activation before the prior era's
 *                                     //   motifs become RETIREMENT-ELIGIBLE (dead residents)
 * }>} entries
 */
export function makeEraSchedule(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('makeEraSchedule: at least one era activation required');
  }
  const normalized = entries.map((e, i) => {
    if (!Number.isInteger(e.era) || e.era < 1) throw new Error(`makeEraSchedule: entry ${i} era must be a positive integer`);
    eraSpec(e.era); // validates the era exists + passes the §18 partition invariants
    if (!Number.isFinite(e.activationEpoch) && !(i === 0 && e.activationEpoch === -Infinity)) {
      throw new Error(`makeEraSchedule: entry ${i} activationEpoch must be a finite epoch (only the genesis era may use -Infinity)`);
    }
    return Object.freeze({
      era: e.era,
      activationEpoch: e.activationEpoch,
      coexistenceWindowEpochs: e.coexistenceWindowEpochs ?? 0,
      retireGraceEpochs: e.retireGraceEpochs ?? 0,
    });
  });
  const sorted = [...normalized].sort((a, b) => a.activationEpoch - b.activationEpoch);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].activationEpoch === sorted[i - 1].activationEpoch) {
      throw new Error('makeEraSchedule: two eras activate on the same epoch');
    }
    // NOTE: consecutive same-era activations ARE permitted — that is exactly a
    // rollback re-activation of the prior grammar after a failed era activation.
  }
  return Object.freeze({ entries: Object.freeze(sorted) });
}

/** The single-era genesis schedule (era-1 only) — the pre-this-lane behaviour. */
export function genesisEraSchedule(era = 1) {
  return makeEraSchedule([{ era, activationEpoch: -Infinity }]);
}

/** The entry whose grammar is the active MINTING era at `epoch`. */
export function activeEraEntry(schedule, epoch) {
  let active = null;
  for (const entry of schedule.entries) {
    if (entry.activationEpoch <= epoch) active = entry;
  }
  if (!active) {
    throw new Error(`activeEraEntry: no era active at epoch ${epoch} (schedule starts at ${schedule.entries[0].activationEpoch})`);
  }
  return active;
}

/** The active minting era id at `epoch`. */
export function activeEraForEpoch(schedule, epoch) {
  return activeEraEntry(schedule, epoch).era;
}

/** The entry active immediately BEFORE the current era (the prior grammar), or null. */
export function priorEraEntry(schedule, epoch) {
  const active = activeEraEntry(schedule, epoch);
  const idx = schedule.entries.indexOf(active);
  return idx > 0 ? schedule.entries[idx - 1] : null;
}

/**
 * A transition is HAPPENING at `epoch` iff `epoch` equals a non-genesis
 * activationEpoch. Returns { fromEra, toEra, epoch } or null.
 */
export function eraTransitionAt(schedule, epoch) {
  const idx = schedule.entries.findIndex((e) => e.activationEpoch === epoch);
  if (idx <= 0) return null;
  return Object.freeze({ fromEra: schedule.entries[idx - 1].era, toEra: schedule.entries[idx].era, epoch });
}

/**
 * True while the prior era's motifs are permitted to COEXIST as active rows
 * (the transition window). Outside the window the prior era's residents are
 * dead-but-resident (costlessly evictable) until the frontier drains them.
 */
export function inCoexistenceWindow(schedule, epoch) {
  const active = activeEraEntry(schedule, epoch);
  if (schedule.entries.indexOf(active) === 0) return false; // genesis era: nothing coexists
  return epoch < active.activationEpoch + active.coexistenceWindowEpochs;
}

/**
 * The prior era whose motifs are RETIREMENT-ELIGIBLE at `epoch` (dead residents:
 * the new era is active, the retire grace has elapsed). This is the exact set
 * whose eviction is COSTLESS — the mechanism that makes net>0 sustainable
 * (ledger §17.26 point 3). Returns the prior era id or null.
 */
export function retirementEligiblePriorEra(schedule, epoch) {
  const active = activeEraEntry(schedule, epoch);
  const idx = schedule.entries.indexOf(active);
  if (idx === 0) return null;
  if (epoch < active.activationEpoch + active.retireGraceEpochs) return null;
  return schedule.entries[idx - 1].era;
}

/** A stable frontier/era identity string that changes exactly at each transition. */
export function eraFrontierId(schedule, epoch) {
  const active = activeEraEntry(schedule, epoch);
  return `era${active.era}@${active.activationEpoch === -Infinity ? 'genesis' : active.activationEpoch}`;
}

/**
 * ROLLBACK: produce a NEW schedule in which the era that activated at
 * `failedActivationEpoch` is reverted — the prior era re-becomes the active
 * minting grammar from `rollbackEpoch` onward. Used when era-N fails its
 * activation validation gate: minting falls back to era-(N-1), whose motifs are
 * still valid, and the failed era's (few) minted clusters age out normally.
 */
export function rollbackEra(schedule, { failedActivationEpoch, rollbackEpoch }) {
  const idx = schedule.entries.findIndex((e) => e.activationEpoch === failedActivationEpoch);
  if (idx <= 0) throw new Error(`rollbackEra: no non-genesis activation at epoch ${failedActivationEpoch}`);
  const priorEra = schedule.entries[idx - 1].era;
  if (!Number.isFinite(rollbackEpoch) || rollbackEpoch < failedActivationEpoch) {
    throw new Error('rollbackEra: rollbackEpoch must be a finite epoch >= failedActivationEpoch');
  }
  const kept = schedule.entries.filter((e) => e.activationEpoch !== failedActivationEpoch);
  // Re-activate the prior grammar at rollbackEpoch (records that the frontier
  // reverted; the prior-era entry stays too so pre-failure history is intact).
  return makeEraSchedule([
    ...kept.map((e) => ({ ...e })),
    { era: priorEra, activationEpoch: rollbackEpoch, coexistenceWindowEpochs: 0, retireGraceEpochs: 0 },
  ]);
}

/**
 * ERA-ACTIVATION VALIDATION GATE (fail-closed). An era-N activation is valid iff
 * its 36-class bank is fully minted, disjoint-partition, and STEP-SIGNATURE
 * disjoint from the prior era (the transfer-collapse guard: reuseRatio 0 across
 * eras). Returns { ok, reasons, freshClassCount, crossEraSharedStepSigs }. A
 * driver that gets ok:false MUST roll back rather than activate.
 */
export function validateEraActivation({ schedule, epoch }) {
  const reasons = [];
  const active = activeEraEntry(schedule, epoch);
  const idx = schedule.entries.indexOf(active);
  const prior = idx > 0 ? schedule.entries[idx - 1].era : null;
  const stepSig = (p) => p.steps.map((s) => `${s.direction}:${s.edgeType}`).join('/');

  let freshClassCount = 0;
  let bankOk = true;
  try {
    const bank = programBankForEra(active.era);
    freshClassCount = new Set(bank.map(stepSig)).size;
    if (bank.length !== 36) { bankOk = false; reasons.push(`era ${active.era} bank size ${bank.length} != 36`); }
    if (freshClassCount !== 36) { bankOk = false; reasons.push(`era ${active.era} has ${freshClassCount} distinct step-sigs != 36 (intra-era collision)`); }
  } catch (err) {
    bankOk = false;
    reasons.push(`era ${active.era} bank build failed: ${String(err?.message ?? err)}`);
  }

  let crossEraSharedStepSigs = 0;
  if (prior !== null && bankOk) {
    const priorSigs = new Set(programBankForEra(prior).map(stepSig));
    const activeSigs = programBankForEra(active.era).map(stepSig);
    crossEraSharedStepSigs = activeSigs.filter((s) => priorSigs.has(s)).length;
    if (crossEraSharedStepSigs > 0) {
      reasons.push(`era ${active.era} shares ${crossEraSharedStepSigs} step-sigs with era ${prior} (transfer-collapse hazard)`);
    }
  }

  const ok = bankOk && crossEraSharedStepSigs === 0;
  return Object.freeze({ ok, reasons, era: active.era, priorEra: prior, freshClassCount, crossEraSharedStepSigs });
}

// ─── TRANSITION JOURNAL ──────────────────────────────────────────────────────
//
// Field contract: SUPERSET of the coordinator's published P5_V2_SCHEMA.md
// `eventJournal.perEvolve` record (acceptedByFamily / evictionsByFamily /
// gateConfirmAcceptedByFamily + globalCapacityReachedEpoch), PLUS the
// era-transition fields the era-rotation runway requires. Documented in
// `specs/BMU_ERA_TRANSITION_JOURNAL.md`. If the sibling gate-respec lane
// publishes different era field names, rename here and in the spec doc.

export const ERA_TRANSITION_JOURNAL_FIELDS = Object.freeze({
  perEvolve: Object.freeze([
    'evolve', 'epoch',
    'eraId',              // active minting grammar era at this evolve
    'frontierId',         // eraFrontierId — changes exactly at a transition
    'eraTransition',      // null, or { fromEra, toEra, epoch } on the flip evolve
    'inCoexistenceWindow',
    'acceptedByFamily',           // P5_V2_SCHEMA (net accepts, per family)
    'gateConfirmAcceptedByFamily',// P5_V2_SCHEMA
    'evictionsByFamily',          // P5_V2_SCHEMA (all evictions, per family)
    'costlyEvictionsByFamily',    // evictions whose evicted resident STILL covered an active non-retired motif
    'retirementsByFamily',        // prior-era motif retirements this evolve (the costless-eviction feedstock)
    'retirementEligiblePriorEra', // which prior era is dead-resident-eligible now (or null)
    // §17.39 item-2: each evictionDetail entry carries { residencyKey, family, era,
    // stillCoversActiveMotif, evictedCue, realProgramWordsHex (canonical 64-hex),
    // coverageWitness:{ activeInstanceCount } } so the coordinator verifier can
    // RE-EXECUTE the evicted program and DERIVE costliness itself rather than trust
    // the stillCoversActiveMotif boolean.
    'evictionDetail',
  ]),
});

/** Build an empty per-family counter object. */
export function emptyFamilyCounts(fill = 0) {
  return Object.fromEntries(FAMILIES.map((f) => [f, fill]));
}

/**
 * Assemble one per-evolve journal record from raw facts. `evictionDetail` is a
 * list of { residencyKey, family, era, stillCoversActiveMotif }; the aggregate
 * costly/eviction/retirement counters are DERIVED from it + `retirements`, so a
 * downstream verifier can recompute every counter (the P5_V2_SCHEMA contract).
 */
export function buildEraJournalEvolveRecord({
  schedule, evolve, epoch,
  acceptedByFamily, gateConfirmAcceptedByFamily,
  evictionDetail = [], retirementsByFamily = emptyFamilyCounts(),
}) {
  const evictionsByFamily = emptyFamilyCounts();
  const costlyEvictionsByFamily = emptyFamilyCounts();
  for (const ev of evictionDetail) {
    if (!FAMILIES.includes(ev.family)) throw new Error(`era journal: unknown eviction family '${ev.family}'`);
    evictionsByFamily[ev.family] += 1;
    if (ev.stillCoversActiveMotif === true) costlyEvictionsByFamily[ev.family] += 1;
  }
  return Object.freeze({
    evolve, epoch,
    eraId: activeEraForEpoch(schedule, epoch),
    frontierId: eraFrontierId(schedule, epoch),
    eraTransition: eraTransitionAt(schedule, epoch),
    inCoexistenceWindow: inCoexistenceWindow(schedule, epoch),
    acceptedByFamily: Object.freeze({ ...acceptedByFamily }),
    gateConfirmAcceptedByFamily: Object.freeze({ ...gateConfirmAcceptedByFamily }),
    evictionsByFamily: Object.freeze(evictionsByFamily),
    costlyEvictionsByFamily: Object.freeze(costlyEvictionsByFamily),
    retirementsByFamily: Object.freeze({ ...retirementsByFamily }),
    retirementEligiblePriorEra: retirementEligiblePriorEra(schedule, epoch),
    evictionDetail: Object.freeze(evictionDetail.map((e) => Object.freeze({ ...e }))),
  });
}

export { FAMILIES as ERA_JOURNAL_FAMILIES };
