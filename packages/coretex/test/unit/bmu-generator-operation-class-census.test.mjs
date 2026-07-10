/**
 * BMU v2 class-capacity census on the exact P5 cadence and mint cycle.
 * This is intentionally generator-only: no corpus materialization, model
 * scoring, or lifecycle simulation is performed here.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { splitForRecord, liveTailQueryId } from '../../dist/index.js';
import {
  BMU_MULTI_HOP_OPERATION_CLASSES,
  generateMultiHopClusters,
} from '../../../../scripts/lib/bmu-generators/multi_hop_relation.mjs';
import {
  NEARCOL_OPERATION_CLASSES,
  generateNearCollisionAbstentionClusters,
} from '../../../../scripts/lib/bmu-generators/near_collision_abstention.mjs';
import {
  createBmuActiveIndex,
  createM1Registry,
  m1CensusOverRows,
  makeCanonicalSplitOf,
} from '../../../../scripts/lib/bmu-generators/common.mjs';

const splitOf = makeCanonicalSplitOf({ splitForRecord, liveTailQueryId, corpusEpoch: 136 });
const DOC_ID_KEY = `0x${'77'.repeat(32)}`;
const subjects = (prefix, name, n) => Array.from({ length: n }, (_, i) => ({
  id: `${prefix}${i}`,
  canonicalName: `${name} ${i}`,
  aliases: [`${name.split(' ')[0]}-${i}`],
}));

function metadata(doc) {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => key !== 'id' && key !== 'text'));
}

function assertBalanced(cluster, docs, relations) {
  const docById = new Map(docs.map((doc) => [doc.id, doc]));
  for (const group of cluster.pathGroups) {
    const branches = group.branchIds ?? [group.truthId, ...group.decoyIds];
    assert.equal(branches.length, 4, `${cluster.operationClass}: bounded four-branch group`);
    const signature = (id) => ({
      metadata: metadata(docById.get(id)),
      outgoing: relations.filter((relation) => relation.src === id)
        .map(({ src: _src, dst: _dst, ...observable }) => observable),
    });
    for (const decoyId of group.decoyIds) {
      assert.deepEqual(signature(decoyId), signature(group.truthId),
        `${cluster.operationClass}: structural/recency/metadata selector must tie truth and decoy`);
    }
  }
}

function assertRepeatSupport(byClass, capacity) {
  assert.ok(byClass.size > capacity, `observed ${byClass.size} classes must exceed capacity ${capacity}`);
  for (const [operationClass, clusters] of byClass) {
    assert.ok(clusters.length >= 2, `${operationClass}: at least two support clusters`);
    const ordered = [...clusters].sort((a, b) => a.epoch - b.epoch);
    assert.ok(ordered.some((cluster, i) => i > 0 && cluster.epoch - ordered[i - 1].epoch <= 8),
      `${operationClass}: a repeated pair must be simultaneously active on the +8 cadence`);
    const [a, b] = ordered;
    assert.notEqual(a.subjectEntityId, b.subjectEntityId);
    assert.equal(a.templateIds.some((id) => b.templateIds.includes(id)), false);
    assert.equal(a.entityHoldoutKeys.some((key) => b.entityHoldoutKeys.includes(key)), false);
  }
}

test('48 exact P5 evolves expose semantic-label inflation despite repeat support and balanced paths', () => {
  assert.equal(BMU_MULTI_HOP_OPERATION_CLASSES.length, 80, '80 > conservative multi-hop capacity 32');
  assert.equal(NEARCOL_OPERATION_CLASSES.length, 48, '48 > conservative near-collision capacity 8');
  const expectedPrograms = new Set(['causes', 'derived_from'].flatMap((outgoing) =>
    ['supports', 'supersedes', 'coreference_of', 'co_occurs_with'].map((incoming) => `${outgoing}/${incoming}`)));
  for (const [label, classes, semanticCount] of [
    ['multi-hop', BMU_MULTI_HOP_OPERATION_CLASSES, 5],
    ['near-collision', NEARCOL_OPERATION_CLASSES, 3],
  ]) {
    assert.deepEqual(new Set(classes.map((plan) => `${plan.outgoingEdgeType}/${plan.incomingEdgeType}`)), expectedPrograms,
      `${label}: complete disjoint 2×4 edge-program matrix`);
    assert.equal(new Set(classes.map((plan) => plan.semantic)).size, semanticCount, `${label}: truthful semantic dimension`);
    assert.deepEqual(new Set(classes.map((plan) => plan.topology)), new Set(['single_sink', 'dual_sink']),
      `${label}: both topology dimensions`);
  }

  const armEpoch = 152;
  const steadyCycle = [
    { temporal: 1, conflict: 2, multi: 1, near: 1 },
    { temporal: 1, conflict: 1, multi: 2, near: 1 },
    { temporal: 1, conflict: 2, multi: 1, near: 1 },
    { temporal: 1, conflict: 1, multi: 2, near: 1 },
  ];
  const multiActive = createBmuActiveIndex();
  const nearRegistry = createM1Registry();
  const multiSubjects = subjects('e_p5_mh_', 'MultiP5 Subject', 160);
  const nearSubjects = subjects('e_p5_nc_', 'NearP5 Subject', 96);
  const multiByClass = new Map();
  const nearByClass = new Map();
  const multiExecutableSignatures = new Set();
  const nearExecutableSignatures = new Set();
  const allRows = [];
  let multiClassCursor = 0;
  let nearClassCursor = 0;
  let previousEpoch = null;

  for (let evolve = 0; evolve < 48; evolve++) {
    const epoch = armEpoch + evolve * 8;
    if (previousEpoch === null) assert.equal(epoch, armEpoch, 'first evolve is the arm epoch');
    else assert.equal(epoch - previousEpoch, 8, 'subsequent evolves use exact +8 cadence');
    previousEpoch = epoch;
    const counts = steadyCycle[evolve % steadyCycle.length];
    assert.equal(counts.temporal, 1);
    assert.ok(counts.conflict === 1 || counts.conflict === 2);
    assert.equal(counts.near, 1);
    assert.ok(counts.multi === 1 || counts.multi === 2);

    const multi = generateMultiHopClusters({
      epoch, seed: 'bmu-v2-p5-class-census-multi', docIdKeyHex: DOC_ID_KEY, subjects: multiSubjects,
      universe: 'e_p5_multi_universe', clusterCount: counts.multi,
      splitOf, activeIndex: multiActive, escalation: { baseEpoch: epoch },
      operationClassSlotOffset: multiClassCursor,
    });
    multiClassCursor += counts.multi;
    for (const cluster of multi.clusters) {
      const plan = BMU_MULTI_HOP_OPERATION_CLASSES.find((candidate) => candidate.name === cluster.operationClass);
      const answerDoc = cluster.docs.find((doc) => doc.role === 'chain_answer');
      assert.ok(plan && answerDoc.text.includes(plan.truthKind), 'class semantic changes truthful public text');
      multiExecutableSignatures.add(`${plan.outgoingEdgeType}/${plan.incomingEdgeType}/${plan.sinkMultiplicity}`);
      assert.ok(cluster.relations.filter((relation) => relation.label === 'public_path_seed').every((relation) => relation.type === plan.outgoingEdgeType));
      assert.ok(cluster.relations.filter((relation) => relation.label === 'public_path_branch').every((relation) => relation.type === plan.incomingEdgeType));
      assert.ok(cluster.pathGroups.every((group) => group.sinkIds.length === plan.sinkMultiplicity));
      const list = multiByClass.get(cluster.operationClass) ?? [];
      list.push(cluster);
      multiByClass.set(cluster.operationClass, list);
      assertBalanced(cluster, cluster.docs, cluster.relations);
      allRows.push(...cluster.rows);
    }

    const near = generateNearCollisionAbstentionClusters({
      epoch, seed: 'bmu-v2-p5-class-census-near', docIdKeyHex: DOC_ID_KEY, subjects: nearSubjects,
      registry: nearRegistry, splitOf, clusterCount: counts.near,
      escalationLevel: evolve % 3, ownerEntityId: 'e_p5_near_universe',
      rotationBaseEpoch: armEpoch, operationClassSlotOffset: nearClassCursor,
    });
    nearClassCursor += counts.near;
    const nearDocByCluster = (cluster) => near.addedDocs.filter((doc) => cluster.docIds.includes(doc.id));
    const nearRelByCluster = (cluster) => near.addedRelations.filter((relation) => cluster.docIds.includes(relation.src));
    for (const cluster of near.clusters) {
      const plan = NEARCOL_OPERATION_CLASSES.find((candidate) => candidate.name === cluster.operationClass);
      assert.ok(plan);
      nearExecutableSignatures.add(`${plan.outgoingEdgeType}/${plan.incomingEdgeType}/${plan.sinkMultiplicity}`);
      assert.equal(cluster.decoyKinds[0].kind, plan.primaryKind, 'semantic class changes primary truthful discrimination axis');
      assert.ok(nearRelByCluster(cluster).filter((relation) => relation.label === 'public_path_seed').every((relation) => relation.type === plan.outgoingEdgeType));
      assert.ok(nearRelByCluster(cluster).filter((relation) => relation.label === 'public_path_branch').every((relation) => relation.type === plan.incomingEdgeType));
      assert.ok(cluster.pathGroups.every((group) => group.sinkIds.length === plan.sinkMultiplicity));
      const list = nearByClass.get(cluster.operationClass) ?? [];
      list.push(cluster);
      nearByClass.set(cluster.operationClass, list);
      assertBalanced(cluster, nearDocByCluster(cluster), nearRelByCluster(cluster));
    }
    allRows.push(...near.addedQueries);
  }

  assert.equal(multiClassCursor, 72, 'exact P5 multi-hop 1/2 cycle over 48 evolves');
  assert.equal(nearClassCursor, 48, 'exact P5 near-collision 1/evolve cycle');
  assert.equal(multiByClass.size, 36, '72 paired clusters realize 36 distinct classes');
  assert.equal(nearByClass.size, 24, '48 paired slots realize 24 distinct classes');
  // The capacity argument must count executable operations, not semantic text
  // or primary-decoy labels. In this exact window the 36/24 advertised class
  // labels collapse to only 8 real edge/topology programs apiece. Derived-from
  // is not reached at all, so multi remains below 32 and near merely equals 8.
  assert.equal(multiExecutableSignatures.size, 8);
  assert.equal(nearExecutableSignatures.size, 8);
  assert.ok([...multiExecutableSignatures].every((signature) => signature.startsWith('causes/')));
  assert.ok([...nearExecutableSignatures].every((signature) => signature.startsWith('causes/')));
  assert.ok(multiExecutableSignatures.size <= 32, 'multi executable census does not exceed capacity 32');
  assert.ok(nearExecutableSignatures.size <= 8, 'near executable census does not exceed capacity 8');
  assertRepeatSupport(multiByClass, 32);
  assertRepeatSupport(nearByClass, 8);
  assert.deepEqual(m1CensusOverRows(allRows), [], 'global m=1 + alias-aware I6 census remains clean');
});
