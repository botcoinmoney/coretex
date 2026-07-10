import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as dist from '../../dist/index.js';
import {
  BMU_EXECUTABLE_OPERATION_CLASS_BASIS,
  BMU_EXECUTABLE_PROGRAM_BANK,
  BMU_EXECUTABLE_PROGRAM_CAPACITY,
  executableOperationSignature,
} from '../../../../scripts/lib/bmu-generators/operation-program.mjs';
import {
  globalExecutableIdentityCollisionAudit,
  operationClassCensus,
} from '../../../../scripts/lib/bmu-generators/certify-v2-bank.mjs';
import { buildWorld, mintEvolve, SIM_PINS } from '../../../../scripts/lib/bmu-sim/lifecycle-sim.mjs';

const FAMILIES = [
  'temporal',
  'conflict_lifecycle',
  'multi_hop_relation',
  'near_collision_abstention',
];
const DOC_ID_MASTER_KEY = `0x${'77'.repeat(32)}`;

test('exact 48-evolve executable-era cursor gives every family 36 paired classes and +4 shared-capacity margin', () => {
  assert.deepEqual(SIM_PINS.steadyMintCycle, [
    { temporal: 2, conflict_lifecycle: 2, multi_hop_relation: 1, near_collision_abstention: 1 },
    { temporal: 1, conflict_lifecycle: 1, multi_hop_relation: 2, near_collision_abstention: 2 },
  ]);
  assert.equal(BMU_EXECUTABLE_PROGRAM_BANK.length, 36);
  assert.equal(BMU_EXECUTABLE_PROGRAM_CAPACITY, 32);

  const world = buildWorld({
    dist,
    simSeed: 'bmu-v2-executable-era-census',
    bankSize: 512,
    docIdMasterKeyHex: DOC_ID_MASTER_KEY,
  });
  const mintedByFamily = Object.fromEntries(FAMILIES.map((family) => [family, []]));
  for (let evolve = 0; evolve < 48; evolve++) {
    const epoch = 152 + (evolve + 1) * SIM_PINS.cadenceEpochs;
    const counts = SIM_PINS.steadyMintCycle[evolve % SIM_PINS.steadyMintCycle.length];
    const minted = mintEvolve(world, epoch, counts, { escalationLevel: evolve % 3 });
    for (const motifGroupId of minted.clusters) {
      const cluster = world.clusters.get(motifGroupId);
      mintedByFamily[cluster.family].push(cluster);
    }
  }

  const allCues = new Set();
  const allQueryKeys = new Set();
  const allClasses = new Set();
  const certifiedCensuses = {};
  for (const family of FAMILIES) {
    const clusters = mintedByFamily[family];
    assert.equal(clusters.length, 72, `${family}: exact cursor mints 72 clusters`);
    const byClass = new Map();
    const stepSignatures = new Set();
    const cues = new Set();
    const queryKeys = new Set();
    for (const cluster of clusters) {
      assert.equal(cluster.operationClassBasis, BMU_EXECUTABLE_OPERATION_CLASS_BASIS);
      assert.equal(cluster.operationLaw, 'public_path_program_v1');
      assert.equal(cluster.operationClass,
        executableOperationSignature({
          operationCue: cluster.bmuOperationCue,
          operationProgram: cluster.bmuOperationProgram,
        }).operationClass);
      assert.equal(cluster.operationClass,
        dist.bmuExecutableOperationClass(cluster.bmuOperationCue, cluster.bmuOperationProgram));
      const rows = cluster.rowProductionIds.map((id) => world.eventsById.get(id));
      assert.equal(rows.length, 5);
      for (const row of rows) {
        assert.equal(row.bmuOperationCue, cluster.bmuOperationCue);
        assert.deepEqual(row.bmuOperationProgram, cluster.bmuOperationProgram);
        assert.equal(row.bmuTask.operationLaw, cluster.operationLaw);
        assert.equal(row.bmuTask.operationClass, cluster.operationClass);
        assert.equal(row.bmuTask.operationClassBasis, cluster.operationClassBasis);
      }
      const members = byClass.get(cluster.operationClass) ?? [];
      members.push(cluster);
      byClass.set(cluster.operationClass, members);
      const steps = cluster.bmuOperationProgram.steps.map((step) => `${step.direction}:${step.edgeType}`).join('/');
      stepSignatures.add(steps);
      cues.add(cluster.bmuOperationCue);
      queryKeys.add(dist.bmuOperationQueryKey(cluster.bmuOperationCue).toString(16));
      allCues.add(cluster.bmuOperationCue);
      allQueryKeys.add(dist.bmuOperationQueryKey(cluster.bmuOperationCue).toString(16));
      allClasses.add(cluster.operationClass);
    }
    assert.equal(byClass.size, 36, `${family}: executable class census`);
    assert.equal(stepSignatures.size, 36, `${family}: no cue-only class inflation`);
    assert.equal(cues.size, 36, `${family}: one cue per exact program`);
    assert.equal(queryKeys.size, 36, `${family}: zero 56-bit key collisions`);
    assert.equal(byClass.size - BMU_EXECUTABLE_PROGRAM_CAPACITY, 4, `${family}: shared-capacity margin`);
    for (const [operationClass, pair] of byClass) {
      assert.equal(pair.length, 2, `${family}:${operationClass}: exact I6 pair`);
      assert.notEqual(pair[0].subjectEntityId, pair[1].subjectEntityId);
      assert.equal(pair[0].templateIds.some((id) => pair[1].templateIds.includes(id)), false);
      assert.equal(pair[0].entityHoldoutKeys.some((key) => pair[1].entityHoldoutKeys.includes(key)), false);
      assert.ok(Math.abs(pair[0].epoch - pair[1].epoch) <= SIM_PINS.cadenceEpochs,
        `${family}:${operationClass}: pair coexists inside one cadence`);
    }
    const certified = operationClassCensus({
      family,
      clusters: clusters.map((cluster) => ({
        ...cluster,
        rows: cluster.rowProductionIds.map((id) => world.eventsById.get(id)),
      })),
    }, BMU_EXECUTABLE_PROGRAM_CAPACITY, 32);
    assert.equal(certified.pass, true, `${family}: ${JSON.stringify(certified.errors)}`);
    assert.equal(certified.identityPass, true);
    assert.equal(certified.capacityPass, true);
    assert.equal(certified.repeatPass, true);
    assert.equal(certified.distinctClasses, 36);
    certifiedCensuses[family] = certified;
  }
  assert.equal(allCues.size, 144, 'family cues are globally disjoint');
  assert.equal(allQueryKeys.size, 144, 'zero global cue-key collisions');
  assert.equal(allClasses.size, 144, 'shared resident store sees 144 exact programs across the era');
  assert.equal(globalExecutableIdentityCollisionAudit(certifiedCensuses).pass, true,
    'shared resident store has no cross-family cue/query-key/encoded/signature collisions');
});

test('P2 census rejects 36 forged labels that collapse to one actual executable program', () => {
  const operationCue = 'temporal era 1 route supports then supports';
  const operationProgram = {
    branchLimit: 4,
    steps: [
      { direction: 'outgoing', edgeType: 'supports' },
      { direction: 'incoming', edgeType: 'supports' },
    ],
  };
  const actualClass = executableOperationSignature({ operationCue, operationProgram }).operationClass;
  const clusters = Array.from({ length: 72 }, (_, index) => {
    const forgedClass = `forged-label-${Math.floor(index / 2)}`;
    const motifGroupId = `mg_forged_${index}`;
    const row = {
      id: `q_forged_${index}`,
      operationLaw: 'public_path_program_v1',
      operationClass: actualClass,
      operationClassBasis: BMU_EXECUTABLE_OPERATION_CLASS_BASIS,
      bmuOperationCue: operationCue,
      bmuOperationProgram: operationProgram,
      bmuTask: {
        operationLaw: 'public_path_program_v1',
        operationClass: actualClass,
        operationClassBasis: BMU_EXECUTABLE_OPERATION_CLASS_BASIS,
        motifGroupId,
      },
    };
    return {
      motifGroupId,
      epoch: 152 + Math.floor(index / 2) * 4,
      subjectEntityId: `subject_${index}`,
      templateIds: [`template_${index}`],
      entityHoldoutKeys: [`id:entity_${index}`],
      operationLaw: 'public_path_program_v1',
      operationClass: forgedClass,
      operationClassBasis: BMU_EXECUTABLE_OPERATION_CLASS_BASIS,
      bmuOperationCue: operationCue,
      bmuOperationProgram: operationProgram,
      rows: [row],
    };
  });
  const result = operationClassCensus({ family: 'temporal', clusters }, 32, 32);
  assert.equal(result.pass, false);
  assert.equal(result.identityPass, false);
  assert.equal(result.distinctClasses, 1, 'grouping authority is recomputed executable identity, not forged label');
  assert.equal(result.margin, -31);
  assert.ok(result.errors.length >= 72);
  assert.ok(result.errors.every((error) => error.includes('forged/drifted operationClass')));
});
