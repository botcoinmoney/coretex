import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitForRecord, liveTailQueryId } from '../../dist/index.js';
import * as dist from '../../dist/index.js';
import {
  buildOracleSolvedMarginJob,
  certifyNoSubstrateScoring,
  certifyV2Banks,
  oracleSolvedMarginAudit,
  crossFamilyDedupAudit,
  DEFAULT_V2_BANK_ADAPTERS,
  idMetadataPathAttacker,
  knownSeedGeneratorInversionAttacker,
  makeV2BankAdapter,
  normalizeV2Bank,
} from '../../../../scripts/lib/bmu-generators/certify-v2-bank.mjs';
import { generateTemporalClusters } from '../../../../scripts/lib/bmu-generators/temporal.mjs';
import { generateConflictLifecycleClusters } from '../../../../scripts/lib/bmu-generators/conflict_lifecycle.mjs';
import { createBmuActiveIndex, createM1Registry, makeCanonicalSplitOf } from '../../../../scripts/lib/bmu-generators/common.mjs';
import { buildWorld, mintEvolve, resolveGeneratedOperationClass } from '../../../../scripts/lib/bmu-sim/lifecycle-sim.mjs';

const splitOf = makeCanonicalSplitOf({ splitForRecord, liveTailQueryId, corpusEpoch: 138 });
const DOC_ID_KEY = `0x${'01'.repeat(32)}`;
const subjects = (prefix, name, count = 24) => Array.from({ length: count }, (_, i) => ({
  id: `${prefix}${i}`, canonicalName: `${name} ${i}`,
}));

function fixtureBanks() {
  const activeIndex = createBmuActiveIndex();
  const t1 = generateTemporalClusters({
    epoch: 150, seed: 'v2-cert-temporal', docIdKeyHex: DOC_ID_KEY, subjects: subjects('t_', 'Temporal Person'),
    universe: 'u_temporal', clusterCount: 2, splitOf, activeIndex, operationSequenceOffset: 0,
  });
  const t2 = generateTemporalClusters({
    epoch: 158, seed: 'v2-cert-temporal', docIdKeyHex: DOC_ID_KEY, subjects: subjects('t_', 'Temporal Person'),
    universe: 'u_temporal', clusterCount: 2, splitOf, activeIndex, operationSequenceOffset: 32,
  });
  t1.clusters[0].docs.push(...Array.from({ length: 96 }, (_, i) => ({
    id: `d_temporal_neutral_${i}`, text: `unrelated temporal neutral record ${i}`,
    kind: 'bmu_public_record', lane: 'deep', entityIds: ['neutral'], shape: 'neutral',
    timestamp: '2020-01-01', currentStaleFlag: false, liveUpdateEpoch: 0,
  })));
  const temporal = { family: 'temporal', params: { seed: 'v2-cert-temporal' }, clusters: [...t1.clusters, ...t2.clusters] };

  const registry = createM1Registry();
  const c1 = generateConflictLifecycleClusters({
    epoch: 150, seed: 'v2-cert-conflict', docIdKeyHex: DOC_ID_KEY, subjects: subjects('c_', 'Conflict Person'),
    registry, splitOf, clusterCount: 2, escalationLevel: 0, operationSequenceOffset: 0,
  });
  const c2 = generateConflictLifecycleClusters({
    epoch: 158, seed: 'v2-cert-conflict', docIdKeyHex: DOC_ID_KEY, subjects: subjects('c_', 'Conflict Person'),
    registry, splitOf, clusterCount: 2, escalationLevel: 1, operationSequenceOffset: 40,
  });
  const conflict = {
    family: 'conflict_lifecycle', params: { seed: 'v2-cert-conflict' },
    clusters: [...c1.clusters, ...c2.clusters],
    publicDocs: [
      ...c1.addedDocs, ...c2.addedDocs,
      ...Array.from({ length: 96 }, (_, i) => ({
        id: `d_conflict_neutral_${i}`, text: `unrelated conflict neutral record ${i}`,
        kind: 'bmu_public_record', lane: 'deep', entityIds: ['neutral'], shape: 'neutral',
        timestamp: '2020-01-01', currentStaleFlag: false, lifecycleScope: 'neutral', liveUpdateEpoch: 0,
      })),
    ],
    rows: [...c1.addedQueries, ...c2.addedQueries],
    relations: [...c1.addedRelations, ...c2.addedRelations],
  };
  return [temporal, conflict];
}

const TEST_ADAPTERS = {
  temporal: makeV2BankAdapter({
    conservativeOperationCapacity: 1,
    publicAttackers: DEFAULT_V2_BANK_ADAPTERS.temporal.publicAttackers,
  }),
  conflict_lifecycle: makeV2BankAdapter({ conservativeOperationCapacity: 1 }),
};

function hardNoSubstrateOutput(job, rawBanks) {
  const rows = new Map(rawBanks.flatMap((raw) => normalizeV2Bank(raw).rows).map((row) => [row.id, row]));
  return {
    schema: 'coretex.bmu-v2.no-substrate-scoring-output.v1',
    jobIdentity: job.identity,
    freshScoring: true,
    cacheRebound: false,
    noSubstrate: true,
    pins: job.pins,
    perQuery: job.queries.map((query) => {
      const forbidden = new Set(rows.get(query.id).bmuTask.forbiddenEvidence);
      const bge = job.docs.map((doc, index) => ({ docId: doc.id, score: forbidden.has(doc.id) ? 10 - index * 1e-6 : -index }));
      const qwenInputDocIds = [...bge].sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
        .slice(0, Math.min(job.pins.rerankerInputTopK, bge.length)).map((entry) => entry.docId);
      const qwen = qwenInputDocIds.map((docId, index) => ({ docId, score: forbidden.has(docId) ? 1 : -index - 1 }));
      return { id: query.id, bge, qwenInputDocIds, qwen };
    }),
  };
}

test('generic v2 certification covers temporal/conflict cheap gates and separates hidden oracle', () => {
  const banks = fixtureBanks();
  const sourceCheckout = { commit: 'a'.repeat(40), clean: true };
  const pending = certifyV2Banks(banks, { adapters: TEST_ADAPTERS, sourceCheckout });
  assert.equal(pending.cheapPass, true, JSON.stringify({ perFamily: pending.perFamily, global: pending.globalGates }, null, 2));
  assert.equal(pending.fullPass, false);
  assert.equal(pending.noSubstrate.pending, true);
  for (const report of Object.values(pending.perFamily)) {
    assert.equal(report.gates.randomK.pass, true);
    assert.equal(report.gates.idMetadataPathAttacker.pass, true);
    assert.equal(report.gates.generatorInversionAttacker.pass, true);
    assert.equal(report.gates.balancedTerminalBranches.pass, true);
    assert.equal(report.gates.operationClassCensus.pass, true);
    assert.equal(report.gates.roleRetirement.pass, true);
    assert.equal(report.offlineHiddenOracle.pass, true);
    assert.equal(report.offlineHiddenOracle.inputAuthority, 'hidden_bmuTask_only');
  }
  assert.equal(pending.perFamily.temporal.gates.subjectScopedRecency.pass, true);
  assert.equal(pending.perFamily.temporal.gates.validityCurrency.pass, true);
  assert.equal(pending.globalGates.crossFamilyDedup.pass, true);
  assert.equal(pending.globalGates.globalAliasM1.pass, true);

  const scores = hardNoSubstrateOutput(pending.noSubstrate.job, banks);
  const complete = certifyV2Banks(banks, { adapters: TEST_ADAPTERS, noSubstrateOutput: scores, sourceCheckout });
  assert.equal(complete.noSubstrate.contractPass, true);
  assert.equal(complete.noSubstrate.hardnessPass, true);
  assert.equal(complete.fullPass, true);
});

test('BGE→Qwen contract fails closed on cache rebinding, job tampering, and Qwen input drift', () => {
  const banks = fixtureBanks();
  const sourceCheckout = { commit: 'b'.repeat(40), clean: true };
  const pending = certifyV2Banks(banks, { adapters: TEST_ADAPTERS, sourceCheckout });
  const scores = hardNoSubstrateOutput(pending.noSubstrate.job, banks);
  scores.cacheRebound = true;
  scores.perQuery[0].qwenInputDocIds = scores.perQuery[0].qwenInputDocIds.slice(1);
  pending.noSubstrate.job.queries[0].text = 'tampered after identity binding';
  const rowById = new Map(banks.flatMap((bank) => normalizeV2Bank(bank).rows).map((row) => [row.id, row]));
  const tamperedJob = certifyNoSubstrateScoring(pending.noSubstrate.job, scores, rowById);
  assert.ok(tamperedJob.errors.some((error) => /identity is not self-consistent/.test(error)));
  const report = certifyV2Banks(banks, { adapters: TEST_ADAPTERS, noSubstrateOutput: scores, sourceCheckout });
  assert.equal(report.noSubstrate.contractPass, false);
  assert.equal(report.noSubstrate.hardnessPass, false);
  assert.ok(report.noSubstrate.errors.some((error) => /fresh scoring/.test(error)));
  assert.ok(report.noSubstrate.errors.some((error) => /Qwen input/.test(error)));
});

test('id/metadata/path attacker is invariant to hidden qrels and task labels', () => {
  const lane = normalizeV2Bank(fixtureBanks()[0]);
  const cluster = lane.clusters[0];
  const row = cluster.rows[0];
  const before = idMetadataPathAttacker(row, lane, cluster).map((entry) => entry.docId);
  const poisoned = { ...row, qrels: [], bmuTask: { family: 'poison', requiredEvidence: ['secret'], forbiddenEvidence: [] } };
  const after = idMetadataPathAttacker(poisoned, lane, cluster).map((entry) => entry.docId);
  assert.deepEqual(after, before);
});

test('known-seed generator inversion matches nothing with a public wrong-key guess and detects the private-key positive control', () => {
  const lane = normalizeV2Bank(fixtureBanks()[0]);
  const cluster = lane.clusters[0];
  const row = cluster.rows[0];
  const attack = knownSeedGeneratorInversionAttacker(row, lane, cluster);
  assert.deepEqual(attack.matchedGuessedDocIds, []);
  assert.deepEqual(attack.ranking, []);
  const positive = knownSeedGeneratorInversionAttacker(row, lane, cluster, { attackerDocIdKeyHex: DOC_ID_KEY });
  assert.ok(positive.matchedGuessedDocIds.length >= 4,
    'correct-key control must recover the generated role ids');
});

test('cross-family dedup catches doc/query/publicIntent collisions', () => {
  const [a, b] = fixtureBanks().map(normalizeV2Bank);
  b.docs[0].id = a.docs[0].id;
  b.rows[0].id = a.rows[0].id;
  b.rows[0].publicIntent = structuredClone(a.rows[0].publicIntent);
  b.rows[0].subjectEntityId = a.rows[0].subjectEntityId;
  const audit = crossFamilyDedupAudit({ temporal: a, conflict_lifecycle: b });
  assert.equal(audit.pass, false);
  assert.ok(audit.collisions.docId.length > 0);
  assert.ok(audit.collisions.queryId.length > 0);
  assert.ok(audit.collisions.publicIntent.length > 0);
});

test('adapter API accepts future multi-hop/near-collision descriptors without engine changes', () => {
  assert.deepEqual(makeV2BankAdapter({ conservativeOperationCapacity: 24 }), {
    conservativeOperationCapacity: 24, maxActiveEpochGap: 32, publicAttackers: {},
  });
  assert.deepEqual(makeV2BankAdapter({ conservativeOperationCapacity: 32, publicAttackers: { publicGraph: () => [] } }).conservativeOperationCapacity, 32);
});

test('P5 lifecycle owns one monotone cursor and persists generated class identity fail-closed', () => {
  assert.throws(() => buildWorld({ dist, simSeed: 'missing-private-doc-id-master', bankSize: 8 }), /docIdKeyHex/);
  const world = buildWorld({
    dist, simSeed: 'v2-cert-cursor', bankSize: 32,
    docIdMasterKeyHex: `0x${'02'.repeat(32)}`,
  });
  assert.equal(Object.keys(world).includes('docIdMasterKeyHex'), false, 'private master must not serialize with world evidence');
  mintEvolve(world, 144, { temporal: 1, conflict_lifecycle: 1, multi_hop_relation: 0, near_collision_abstention: 0 });
  mintEvolve(world, 152, { temporal: 1, conflict_lifecycle: 2, multi_hop_relation: 0, near_collision_abstention: 0 });
  assert.equal(world.operationSequence.temporal, 2);
  assert.equal(world.operationSequence.conflict_lifecycle, 3);
  const temporal = [...world.clusters.values()].filter((cluster) => cluster.family === 'temporal');
  const conflict = [...world.clusters.values()].filter((cluster) => cluster.family === 'conflict_lifecycle');
  assert.equal(temporal.length, 2);
  assert.equal(new Set(temporal.map((cluster) => cluster.operationClass)).size, 1,
    'adjacent temporal clusters share one exact executable class');
  assert.ok(temporal[0].operationClass.startsWith('temporal era 1 route '));
  assert.equal(new Set(conflict.map((cluster) => cluster.operationClass)).size, 2);
  assert.ok([...world.clusters.values()].every((cluster) => cluster.operationFamily === cluster.operationClass));
  assert.throws(() => resolveGeneratedOperationClass(
    { motifGroupId: 'mg_bad', operationClass: 'class-a' },
    [{ operationClass: 'class-a' }, { operationClass: 'class-b' }],
  ), /operation-class disagreement/);
  assert.throws(() => resolveGeneratedOperationClass(
    { motifGroupId: 'mg_bad', operationClass: 'class-a' },
    [{ operationClass: 'class-b' }],
  ), /operation-class mismatch/);
});

test('fix-2b oracle-solved margin lane certifies compliant rows and rejects a routed forbidden terminal', () => {
  const lane = normalizeV2Bank(fixtureBanks()[0]);
  const clean = oracleSolvedMarginAudit(lane);
  assert.equal(clean.pass, true, JSON.stringify(clean.rejectedRows.slice(0, 3), null, 2));
  assert.equal(clean.densityArithmeticHolds, true);
  assert.equal(clean.certifiedRows, clean.rows);

  // Poison: route a forbidden decoy as a terminal (the promiscuous-generator
  // shape the ca152a6 law-soundness finding demonstrated) — every row of the
  // cluster must be REJECTED, never certified.
  const cluster = lane.clusters[0];
  const forbiddenId = cluster.rows[0].bmuTask.forbiddenEvidence.at(-1);
  const midId = cluster.publicPath.midIds.at(-1);
  const terminalEdge = cluster.bmuOperationProgram.steps.at(-1).edgeType;
  const poisonedCluster = {
    ...cluster,
    relations: [...cluster.relations, { src: forbiddenId, dst: midId, type: terminalEdge, label: 'public_path_terminal' }],
  };
  const poisoned = {
    ...lane,
    clusters: lane.clusters.map((candidate) => (candidate === cluster ? poisonedCluster : candidate)),
  };
  const audit = oracleSolvedMarginAudit(poisoned);
  assert.equal(audit.pass, false);
  assert.ok(audit.rejectedRows.some((finding) => finding.reject === 'forbidden_terminal_routed'
    && finding.routedForbidden.includes(forbiddenId)));
});

test('fix-2b pair manifest is identity-bound and enumerates class pairs with row law only', () => {
  const banks = fixtureBanks();
  const families = Object.fromEntries(banks.map((bank) => [bank.family, normalizeV2Bank(bank)]));
  const sourceCheckout = { commit: 'c'.repeat(40), clean: true };
  const job = buildOracleSolvedMarginJob(families, { sourceCheckout });
  assert.equal(job.schema, 'coretex.bmu-v2.oracle-solved-margin-job.v1');
  assert.equal(job.oracleSolvedMargin, true);
  assert.match(job.identity, /^[0-9a-f]{64}$/);
  assert.equal(job.pins.density.rowFlipPpm, 15_625);
  for (const [family, laneJob] of Object.entries(job.perFamily)) {
    assert.ok(laneJob.classPairs.length >= 1, `${family}: class pairs present`);
    for (const pair of laneJob.classPairs) {
      assert.ok(pair.operationCue && pair.operationProgram);
      for (const cluster of pair.clusters) {
        assert.ok(cluster.seedId, 'manifest carries the public seed for solved-state execution');
        for (const row of cluster.rows) {
          assert.ok(Array.isArray(row.requiredEvidence) && Array.isArray(row.forbiddenEvidence));
          assert.equal('qrels' in row, false, 'manifest never leaks qrels');
        }
      }
    }
  }
  // Identity binds the payload: any mutation is detectable.
  const mutated = JSON.parse(JSON.stringify(job));
  mutated.perFamily[Object.keys(mutated.perFamily)[0]].classPairs[0].operationCue = 'tampered';
  const recomputed = buildOracleSolvedMarginJob(families, { sourceCheckout });
  assert.equal(recomputed.identity, job.identity);
  assert.notEqual(JSON.stringify(mutated.perFamily), JSON.stringify(job.perFamily));
});
