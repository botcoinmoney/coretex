/**
 * BMU P2 — hardness-certification harness gates (BMU_SPEC.md rev3.2 ad7e523
 * §13.2 / I8 / G-B1..G-B3) over an in-memory conflict_lifecycle bank:
 *   - judge law: required ⊆ top-B ∧ zero forbidden, at the row's budget;
 *   - baseline determinism (BM25 ordering, seeded random-K) — re-run stable;
 *   - the legacy public structural oracle cannot solve balanced BMU-v2
 *     branches and fails closed (null) when the structure is amputated;
 *   - the legacy certifier rejects the v2 bank at G-B2 while G-B3 remains
 *     green; a poisoned bank (answer text leaked into the query)
 *     is REJECTED with reasons, never silently dropped;
 *   - §13.2 boundary margins: quantized grid-cell distances on both sides
 *     of a rank boundary, cap-vs-pool degenerate case logged.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitForRecord, liveTailQueryId } from '../../dist/index.js';
import {
  generateConflictLifecycleClusters,
} from '../../../../scripts/lib/bmu-generators/conflict_lifecycle.mjs';
import {
  createM1Registry,
  makeCanonicalSplitOf,
} from '../../../../scripts/lib/bmu-generators/common.mjs';
import {
  boundaryMargins,
  buildBm25Index,
  bm25Rank,
  buildRealLaneJob,
  certifyBank,
  conflictLifecycleOracleRank,
  judgeTopB,
  randomKRank,
  selectRealLaneClusters,
} from '../../../../scripts/lib/bmu-generators/certify.mjs';

const CORPUS_EPOCH = 136;
const splitOf = makeCanonicalSplitOf({ splitForRecord, liveTailQueryId, corpusEpoch: CORPUS_EPOCH });

function makeBank({ epochs = [137, 138], clustersPerEpoch = 3 } = {}) {
  const subjects = Array.from({ length: 40 }, (_, i) => ({
    id: `e_cert_s${i}`,
    canonicalName: i % 3 === 2 ? `atlas-svc-${i}` : `Subject Persona${i}`,
  }));
  const registry = createM1Registry();
  const rows = []; const docs = []; const relations = []; const clusters = [];
  let operationSequenceOffset = 0;
  for (const epoch of epochs) {
    const out = generateConflictLifecycleClusters({
      epoch, seed: 'bmu-certify-test', subjects, registry, splitOf,
      clusterCount: clustersPerEpoch, escalationLevel: epoch - epochs[0],
      operationSequenceOffset,
    });
    operationSequenceOffset += clustersPerEpoch;
    rows.push(...out.addedQueries); docs.push(...out.addedDocs);
    relations.push(...out.addedRelations); clusters.push(...out.clusters);
  }
  return {
    schema: 'coretex.bmu-p2-sample-bank.v1',
    family: 'conflict_lifecycle',
    params: { family: 'conflict_lifecycle', seed: 'bmu-certify-test', corpusEpoch: CORPUS_EPOCH },
    counts: { clusters: clusters.length, rows: rows.length, publicDocs: docs.length, relations: relations.length },
    clusters, publicDocs: docs, relations, rows,
  };
}

describe('judge law (§13.2)', () => {
  const task = { budgetB: 4, requiredEvidence: ['b', 'r'], forbiddenEvidence: ['a', 'd0'], answer: { id: 'b', value: 'x' } };
  const ranked = (ids) => ids.map((docId, i) => ({ docId, score: -i }));
  test('u=1 iff required ⊆ top-B and zero forbidden admitted', () => {
    assert.equal(judgeTopB(ranked(['b', 'r', 'n1', 'n2', 'a']), task).judgeSuccess, true);
    assert.equal(judgeTopB(ranked(['b', 'r', 'n1', 'a', 'n2']), task).judgeSuccess, false); // forbidden in-B
    assert.equal(judgeTopB(ranked(['b', 'n1', 'n2', 'n3', 'r']), task).judgeSuccess, false); // required out
  });
  test('answer recovery is tracked separately from judge success', () => {
    const j = judgeTopB(ranked(['b', 'n1', 'n2', 'n3', 'r']), task);
    assert.equal(j.answerNoForbidden, true);
    assert.equal(j.judgeSuccess, false);
  });
});

describe('baseline determinism', () => {
  const bank = makeBank();
  test('BM25 ordering is re-run stable', () => {
    const idx = buildBm25Index(bank.publicDocs);
    const q = bank.rows[0].queryText;
    assert.deepEqual(bm25Rank(idx, q), bm25Rank(buildBm25Index(bank.publicDocs), q));
  });
  test('random-K is seeded (same seed → same order; different seed → different)', () => {
    const a = randomKRank(bank.publicDocs, 'seed:1');
    assert.deepEqual(a, randomKRank(bank.publicDocs, 'seed:1'));
    assert.notDeepEqual(a, randomKRank(bank.publicDocs, 'seed:2'));
  });
});

describe('structural oracle (G-B2, qrels-blind)', () => {
  const bank = makeBank();
  const ctx = {
    docs: bank.publicDocs,
    docById: new Map(bank.publicDocs.map((d) => [d.id, d])),
    relations: bank.relations,
  };
  test('cannot distinguish the hidden operation across balanced public branches', () => {
    let solved = 0;
    for (const row of bank.rows) {
      const ranked = conflictLifecycleOracleRank(row, ctx);
      assert.ok(ranked, `oracle returned null for ${row.id}`);
      solved += judgeTopB(ranked, row.bmuTask).judgeSuccess ? 1 : 0;
    }
    assert.equal(solved, 0, 'public relation/metadata selectors must not solve a v2 bank');
  });
  test('fails closed (null) when the contradicts edge is amputated', () => {
    const row = bank.rows[0];
    const amputated = { ...ctx, relations: ctx.relations.filter((r) => r.label !== 'contradicts') };
    assert.equal(conflictLifecycleOracleRank(row, amputated), null);
  });
});

describe('certifyBank end-to-end', () => {
  test('balanced v2 bank: legacy G-B2 fails closed while G-B3 remains green', () => {
    const bank = makeBank();
    const report = certifyBank(bank, { realClusters: 2 });
    assert.equal(report.counts.rejected, bank.rows.length);
    assert.equal(report.counts.certified, 0);
    assert.equal(report.rejectionReasonHistogram.oracle_judge_failed, bank.rows.length);
    assert.equal(report.gates['G-B2_oracle'].pass, false);
    assert.equal(report.gates['G-B3_bm25'].pass, true);
    assert.equal(report.gates['G-B3_firstK'].pass, true);
    assert.equal(report.gates['G-B3_randomK'].pass, true);
    assert.equal(report.gates.leakScreen.pass, true);
    // no real-lane scores supplied → the gate must NOT silently pass
    assert.equal(report.gates['G-B1_realLane_noSubstrate'].pass, false);
    assert.equal(report.realLane.rowsCertified, 0);
    assert.ok(report.realLane.caps.length >= 2);
  });

  test('poisoned bank (answer value leaked into a query) → rejected WITH reasons', () => {
    const bank = makeBank();
    const victim = bank.rows.find((r) => r.questionType === 'current_for_scope');
    victim.queryText = `${victim.queryText} (${victim.bmuTask.answer.value})`;
    const report = certifyBank(bank, { realClusters: 2 });
    const rej = report.rejected.find((r) => r.rowId === victim.id);
    assert.ok(rej, 'leaky row must be rejected');
    assert.ok(rej.reasons.includes('answer_leak'), JSON.stringify(rej));
    assert.ok(report.rejectionReasonHistogram.answer_leak >= 1);
    // nothing silently dropped: certified + rejected == total
    assert.equal(report.counts.certified + report.counts.rejected, bank.rows.length);
  });

  test('a task whose oracle structure is broken is rejected, not dropped', () => {
    const bank = makeBank();
    const victimCluster = bank.clusters[0];
    bank.relations = bank.relations.filter((r) => !(r.label === 'contradicts' && victimCluster.docIds.includes(r.src)));
    const report = certifyBank(bank, { realClusters: 2 });
    for (const rowId of victimCluster.rowIds) {
      const rej = report.rejected.find((r) => r.rowId === rowId);
      assert.ok(rej && rej.reasons.includes('oracle_no_structural_solution'), `row ${rowId}: ${JSON.stringify(rej)}`);
    }
    assert.equal(report.gates['G-B2_oracle'].rate < 1, true);
  });
});

describe('real-lane plumbing', () => {
  const bank = makeBank();
  test('subsample selection is deterministic and epoch-spread', () => {
    const a = selectRealLaneClusters(bank, 2);
    const b = selectRealLaneClusters(bank, 2);
    assert.deepEqual(a.map((c) => c.motifGroupId), b.map((c) => c.motifGroupId));
    assert.equal(new Set(a.map((c) => c.epoch)).size, 2, 'must spread across epochs (escalation coverage)');
  });
  test('job carries the full doc pool + exactly the subsample queries', () => {
    const job = buildRealLaneJob(bank, { realClusters: 2 });
    assert.equal(job.docs.length, bank.publicDocs.length);
    assert.equal(job.queries.length, 10);
    assert.equal(job.pins.rerankerInputTopK, 64);
  });
  test('margins: quantized grid-cell distance on both sides of a boundary', () => {
    const ranked = [
      { docId: 'x1', score: 0.9 }, { docId: 'x2', score: 0.8 },
      { docId: 'x3', score: 0.5 }, { docId: 'x4', score: 0.499 },
    ];
    const m = boundaryMargins(ranked, 2, 1e-3, ['x1', 'x3', 'x4']);
    const by = Object.fromEntries(m.perDoc.map((d) => [d.docId, d]));
    assert.equal(by.x1.side, 'in');
    assert.equal(by.x1.cells, 400); // 0.9 vs first-out 0.5
    assert.equal(by.x3.side, 'out');
    assert.equal(by.x3.cells, 300); // last-in 0.8 vs 0.5
    assert.equal(by.x4.cells, 301);
    // degenerate: pool smaller than the cap → logged, no margins invented
    const deg = boundaryMargins(ranked, 64, 1e-3, ['x1']);
    assert.equal(deg.boundary, null);
    assert.match(deg.note, /in-cap/);
  });
});
