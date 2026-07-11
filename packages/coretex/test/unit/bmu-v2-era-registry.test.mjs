/**
 * §18 grammar-era registry + era-rotation machinery (era-2 iteration).
 *
 * Refuter for the three-question (G-B17) era posture and the transfer-collapse
 * guard: proves era-2 is a genuinely NEW, disjoint-partition grammar whose
 * classes cannot collide or transfer-collapse onto era-1, and that the
 * coexistence / retirement / rollback / journal machinery behaves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BMU_EXECUTABLE_ERA_REGISTRY,
  assertEraSpec,
  eraSpec,
  programBankForEra,
  executableOperationForFamilySlot,
  assertDisjointPartitionProgram,
  inferProgramEra,
} from '../../../../scripts/lib/bmu-generators/operation-program.mjs';
import {
  makeEraSchedule,
  genesisEraSchedule,
  activeEraForEpoch,
  priorEraEntry,
  eraTransitionAt,
  inCoexistenceWindow,
  retirementEligiblePriorEra,
  eraFrontierId,
  rollbackEra,
  validateEraActivation,
  buildEraJournalEvolveRecord,
  emptyFamilyCounts,
} from '../../../../scripts/lib/bmu-sim/era-schedule.mjs';

const stepSig = (p) => p.steps.map((s) => `${s.direction}:${s.edgeType}`).join('/');
const FAMILIES = ['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention'];

test('every registered era passes the §18 partition invariants', () => {
  for (const spec of Object.values(BMU_EXECUTABLE_ERA_REGISTRY)) {
    assert.doesNotThrow(() => assertEraSpec(spec));
    assert.equal(spec.outgoingEdgeTypes.length, 2);
    assert.equal(spec.incomingEdgeTypes.length, 4);
    // symmetric-route inexpressible: outgoing ∩ incoming = ∅
    const inc = new Set(spec.incomingEdgeTypes);
    for (const e of spec.outgoingEdgeTypes) assert.ok(!inc.has(e), `era ${spec.era} edge ${e} in both`);
  }
});

test('era-2 exists and is a genuinely new grammar vs era-1', () => {
  const e1 = eraSpec(1);
  const e2 = eraSpec(2);
  assert.notDeepEqual([...e2.outgoingEdgeTypes].sort(), [...e1.outgoingEdgeTypes].sort());
  assert.notEqual(e2.basis, e1.basis);
});

test('Q2 executable class space > capacity: each era mints 36 disjoint classes, cross-era reuseRatio 0', () => {
  const b1 = programBankForEra(1);
  const b2 = programBankForEra(2);
  assert.equal(b1.length, 36);
  assert.equal(b2.length, 36);
  const s1 = new Set(b1.map(stepSig));
  const s2 = new Set(b2.map(stepSig));
  assert.equal(s1.size, 36, 'era-1 intra-era distinct step-sigs');
  assert.equal(s2.size, 36, 'era-2 intra-era distinct step-sigs');
  // cross-era disjoint ⇒ aggregate executable space = 72 > resident capacity 32
  const shared = [...s2].filter((s) => s1.has(s));
  assert.equal(shared.length, 0, 'cross-era step-sig collision (transfer-collapse hazard)');
  const aggregate = new Set([...s1, ...s2]);
  assert.equal(aggregate.size, 72);
});

test('every era-2 bank program lints only under era-2 and infers as era-2', () => {
  for (const program of programBankForEra(2)) {
    assert.equal(inferProgramEra(program), 2);
    assert.doesNotThrow(() => assertDisjointPartitionProgram(program, 2));
    // an era-2 program must FAIL the era-1 lint (leading edge not in era-1 outgoing)
    assert.throws(() => assertDisjointPartitionProgram(program, 1));
  }
  for (const program of programBankForEra(1)) {
    assert.equal(inferProgramEra(program), 1);
    assert.throws(() => assertDisjointPartitionProgram(program, 2));
  }
});

test('executableOperationForFamilySlot stamps disjoint classes + per-era basis', () => {
  for (const family of FAMILIES) {
    const o1 = executableOperationForFamilySlot(family, 0, { era: 1 });
    const o2 = executableOperationForFamilySlot(family, 0, { era: 2 });
    assert.notEqual(o1.operationClass, o2.operationClass);
    assert.equal(o1.operationClassBasis, eraSpec(1).basis);
    assert.equal(o2.operationClassBasis, eraSpec(2).basis);
    assert.equal(o1.era, 1);
    assert.equal(o2.era, 2);
  }
});

test('no era-1 program can be re-keyed to solve an era-2 class (honest transfer)', () => {
  // A miner that learned all era-1 step-sigs still covers 0 era-2 classes.
  const era1Sigs = new Set(programBankForEra(1).map(stepSig));
  const era2Covered = programBankForEra(2).filter((p) => era1Sigs.has(stepSig(p)));
  assert.equal(era2Covered.length, 0);
});

// ─── schedule / coexistence / retirement / rollback ──────────────────────────

test('genesis schedule is era-1 forever', () => {
  const s = genesisEraSchedule(1);
  assert.equal(activeEraForEpoch(s, 100), 1);
  assert.equal(activeEraForEpoch(s, 100000), 1);
  assert.equal(eraTransitionAt(s, 100), null);
});

test('two-era schedule: active era flips at activation; transition detected once', () => {
  const s = makeEraSchedule([
    { era: 1, activationEpoch: -Infinity },
    { era: 2, activationEpoch: 200, coexistenceWindowEpochs: 32, retireGraceEpochs: 16 },
  ]);
  assert.equal(activeEraForEpoch(s, 199), 1);
  assert.equal(activeEraForEpoch(s, 200), 2);
  assert.equal(activeEraForEpoch(s, 400), 2);
  assert.deepEqual(eraTransitionAt(s, 200), { fromEra: 1, toEra: 2, epoch: 200 });
  assert.equal(eraTransitionAt(s, 201), null);
  assert.equal(priorEraEntry(s, 250).era, 1);
  assert.notEqual(eraFrontierId(s, 199), eraFrontierId(s, 200));
});

test('coexistence window then retirement eligibility of the prior era', () => {
  const s = makeEraSchedule([
    { era: 1, activationEpoch: -Infinity },
    { era: 2, activationEpoch: 200, coexistenceWindowEpochs: 32, retireGraceEpochs: 16 },
  ]);
  assert.equal(inCoexistenceWindow(s, 210), true);   // within 200..232
  assert.equal(inCoexistenceWindow(s, 240), false);
  // retire grace 16: prior era (1) eligible from epoch 216
  assert.equal(retirementEligiblePriorEra(s, 210), null);
  assert.equal(retirementEligiblePriorEra(s, 216), 1);
  assert.equal(retirementEligiblePriorEra(s, 300), 1);
  // genesis era has no prior era to retire
  assert.equal(retirementEligiblePriorEra(genesisEraSchedule(1), 100), null);
});

test('era-2 activation passes the validation gate; rollback reverts to era-1', () => {
  const s = makeEraSchedule([
    { era: 1, activationEpoch: -Infinity },
    { era: 2, activationEpoch: 200 },
  ]);
  const gate = validateEraActivation({ schedule: s, epoch: 200 });
  assert.equal(gate.ok, true, JSON.stringify(gate.reasons));
  assert.equal(gate.freshClassCount, 36);
  assert.equal(gate.crossEraSharedStepSigs, 0);

  const rolled = rollbackEra(s, { failedActivationEpoch: 200, rollbackEpoch: 208 });
  assert.equal(activeEraForEpoch(rolled, 199), 1);
  assert.equal(activeEraForEpoch(rolled, 208), 1); // reverted to era-1 minting
  assert.equal(activeEraForEpoch(rolled, 500), 1);
  assert.equal(eraTransitionAt(rolled, 200), null); // the failed activation is gone
});

test('journal record derives eviction + costly-eviction counters from detail', () => {
  const s = makeEraSchedule([
    { era: 1, activationEpoch: -Infinity },
    { era: 2, activationEpoch: 200, coexistenceWindowEpochs: 32, retireGraceEpochs: 16 },
  ]);
  const rec = buildEraJournalEvolveRecord({
    schedule: s, evolve: 7, epoch: 224,
    acceptedByFamily: { ...emptyFamilyCounts(), temporal: 3 },
    gateConfirmAcceptedByFamily: { ...emptyFamilyCounts(), temporal: 3 },
    retirementsByFamily: { ...emptyFamilyCounts(), temporal: 2 },
    evictionDetail: [
      { residencyKey: 'k1', family: 'temporal', era: 1, stillCoversActiveMotif: false }, // costless (dead era-1)
      { residencyKey: 'k2', family: 'temporal', era: 2, stillCoversActiveMotif: true },  // costly
      { residencyKey: 'k3', family: 'conflict_lifecycle', era: 1, stillCoversActiveMotif: false },
    ],
  });
  assert.equal(rec.eraId, 2);
  assert.equal(rec.retirementEligiblePriorEra, 1);
  assert.equal(rec.evictionsByFamily.temporal, 2);
  assert.equal(rec.costlyEvictionsByFamily.temporal, 1);
  assert.equal(rec.evictionsByFamily.conflict_lifecycle, 1);
  assert.equal(rec.costlyEvictionsByFamily.conflict_lifecycle, 0);
  assert.equal(rec.retirementsByFamily.temporal, 2);
  assert.equal(rec.eraTransition, null); // not the flip evolve
});

test('malformed era spec is refused fail-closed', () => {
  assert.throws(() => assertEraSpec({ era: 9, outgoingEdgeTypes: ['causes'], incomingEdgeTypes: ['supports'] }));
  assert.throws(() => assertEraSpec({
    era: 9,
    outgoingEdgeTypes: ['causes', 'supports'],           // outgoing ∩ incoming != ∅
    incomingEdgeTypes: ['supports', 'supersedes', 'coreference_of', 'co_occurs_with'],
    fourStepIncomingChains: [['supports', 'supersedes', 'coreference_of'], ['co_occurs_with', 'coreference_of', 'supersedes']],
    basis: 'x',
  }));
  assert.throws(() => eraSpec(999));
});
