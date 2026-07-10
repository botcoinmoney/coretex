/**
 * BMU P2 — hardness-certification harness gates for the ABSTAIN-AWARE
 * extension + the near_collision_abstention family adapter (BMU_SPEC.md
 * rev3.2 ad7e523 §2.2 u(t), §5.4, §5.5, §13.2, I8, G-B1..G-B3), over an
 * in-memory near-collision bank:
 *   - abstain judge law: u=1 iff zero forbidden admitted AND the §5.5 signal
 *     fires; substrate-less stacks (signalFires=false) are u=0 by law; the
 *     false-abstain counterweight zeroes answerable rows when the signal
 *     fires; answerable judging without a signal is byte-compatible with the
 *     conflict lane's original judge;
 *   - §4.1 recheck abstain branch: answer-carrying / required-carrying
 *     abstain rows fail closed;
 *   - structural oracle (qrels-blind): solves every generated row — abstain
 *     rows via a structurally derived abstainSignal — and fails closed (null)
 *     when the disambiguation structure is amputated;
 *   - certifyBank end-to-end: everything certified, gates green including
 *     the §5.4 anti-free-abstention trap-adjacency gate; a leaky query is
 *     REJECTED with reasons; an abstain row whose collision neighborhood
 *     does NOT out-pull under BM25 is rejected (abstain_trap_not_adjacent);
 *   - real-lane plumbing: deterministic epoch-spread subsample.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitForRecord, liveTailQueryId } from '../../dist/index.js';
import {
  generateNearCollisionAbstentionClusters,
} from '../../../../scripts/lib/bmu-generators/near_collision_abstention.mjs';
import {
  createM1Registry,
  makeCanonicalSplitOf,
} from '../../../../scripts/lib/bmu-generators/common.mjs';
import {
  buildRealLaneJob,
  certifyBank,
  judgeTopB,
  nearCollisionOracleRank,
  selectRealLaneClusters,
  validateBankRow,
} from '../../../../scripts/lib/bmu-generators/certify.mjs';

const CORPUS_EPOCH = 136;
const DOC_ID_KEY = `0x${'66'.repeat(32)}`;
const splitOf = makeCanonicalSplitOf({ splitForRecord, liveTailQueryId, corpusEpoch: CORPUS_EPOCH });

function makeBank({ epochs = [137, 138], clustersPerEpoch = 3 } = {}) {
  const subjects = Array.from({ length: 40 }, (_, i) => ({
    id: `e_ncert_s${i}`,
    canonicalName: i % 3 === 2 ? `beacon-svc-${i}` : `Persona Vintra${i}`,
  }));
  const registry = createM1Registry();
  const rows = []; const docs = []; const relations = []; const clusters = [];
  for (const epoch of epochs) {
    const out = generateNearCollisionAbstentionClusters({
      epoch, seed: 'bmu-certify-nearcol-test', docIdKeyHex: DOC_ID_KEY, subjects, registry, splitOf,
      clusterCount: clustersPerEpoch, escalationLevel: epoch - epochs[0],
    });
    rows.push(...out.addedQueries); docs.push(...out.addedDocs);
    relations.push(...out.addedRelations); clusters.push(...out.clusters);
  }
  return {
    schema: 'coretex.bmu-p2-sample-bank.v1',
    family: 'near_collision_abstention',
    params: { family: 'near_collision_abstention', seed: 'bmu-certify-nearcol-test', corpusEpoch: CORPUS_EPOCH },
    counts: { clusters: clusters.length, rows: rows.length, publicDocs: docs.length, relations: relations.length },
    clusters, publicDocs: docs, relations, rows,
  };
}

const ranked = (ids) => ids.map((docId, i) => ({ docId, score: -i }));

describe('abstain judge law (§2.2 / §5.5)', () => {
  const abstainTask = { budgetB: 3, requiredEvidence: [], forbiddenEvidence: ['e', 'na', 'nt', 'ns'], abstain: true };
  test('u=1 iff zero forbidden admitted AND the signal fires', () => {
    assert.equal(judgeTopB(ranked(['n1', 'n2', 'n3', 'e']), abstainTask, { signalFires: true }).judgeSuccess, true);
    assert.equal(judgeTopB(ranked(['n1', 'e', 'n2', 'n3']), abstainTask, { signalFires: true }).judgeSuccess, false); // forbidden in-B
  });
  test('substrate-less stacks (no signal) are u=0 even with clean retrieval', () => {
    const j = judgeTopB(ranked(['n1', 'n2', 'n3', 'e']), abstainTask);
    assert.equal(j.retrievalClean, true);
    assert.equal(j.judgeSuccess, false);
  });
  const answerableTask = { budgetB: 3, requiredEvidence: ['e'], forbiddenEvidence: ['na', 'nt', 'ns'], answer: { id: 'e', value: 'x' } };
  test('false-abstain counterweight: a firing signal zeroes an answerable row', () => {
    assert.equal(judgeTopB(ranked(['e', 'n1', 'n2', 'na']), answerableTask).judgeSuccess, true);
    assert.equal(judgeTopB(ranked(['e', 'n1', 'n2', 'na']), answerableTask, { signalFires: true }).judgeSuccess, false);
  });
  test('answerable judging without a signal keeps the original judge semantics', () => {
    assert.equal(judgeTopB(ranked(['e', 'na', 'n1']), answerableTask).judgeSuccess, false); // forbidden in-B
    assert.equal(judgeTopB(ranked(['n1', 'n2', 'n3', 'e']), answerableTask).judgeSuccess, false); // required out
  });
});

describe('§4.1 recheck abstain branch', () => {
  const bank = makeBank({ epochs: [137], clustersPerEpoch: 1 });
  const docById = new Map(bank.publicDocs.map((d) => [d.id, d]));
  const abstainRow = bank.rows.find((r) => r.bmuTask.abstain === true);
  test('a clean abstain row passes', () => {
    assert.deepEqual(validateBankRow(abstainRow, docById), []);
  });
  test('an abstain row carrying an answer fails closed', () => {
    const poisoned = { ...abstainRow, bmuTask: { ...abstainRow.bmuTask, answer: { id: 'x', value: 'y' } } };
    assert.ok(validateBankRow(poisoned, docById).some((e) => /carries an answer/.test(e)));
  });
  test('an abstain row with required evidence fails closed', () => {
    const poisoned = { ...abstainRow, bmuTask: { ...abstainRow.bmuTask, requiredEvidence: [abstainRow.bmuTask.forbiddenEvidence[0]] } };
    assert.ok(validateBankRow(poisoned, docById).some((e) => /non-empty requiredEvidence/.test(e)));
  });
});

describe('structural oracle (G-B2, qrels-blind)', () => {
  const bank = makeBank();
  const ctx = {
    docs: bank.publicDocs,
    docById: new Map(bank.publicDocs.map((d) => [d.id, d])),
    relations: bank.relations,
    clusterByRowId: new Map(bank.clusters.flatMap((cluster) =>
      cluster.rowIds.map((rowId) => [rowId, cluster]))),
  };
  test('solves every generated row; abstain rows via structural abstainSignal', () => {
    for (const row of bank.rows) {
      const out = nearCollisionOracleRank(row, ctx);
      assert.ok(out, `oracle returned null for ${row.id}`);
      assert.equal(out.abstainSignal, row.bmuTask.abstain === true, `oracle abstain decision wrong on ${row.id}`);
      const j = judgeTopB(out.ranked, row.bmuTask, { signalFires: out.abstainSignal });
      assert.equal(j.judgeSuccess, true, `oracle judge failed on ${row.id}: ${JSON.stringify(j)}`);
    }
  });
  test('fails closed (null) when the public-path seed is amputated', () => {
    const row = bank.rows[0];
    const amputated = { ...ctx, relations: ctx.relations.filter((r) => r.label !== 'public_path_seed') };
    assert.equal(nearCollisionOracleRank(row, amputated), null);
  });
});

describe('certifyBank end-to-end', () => {
  test('clean bank: all certified, gates green incl. §5.4 trap adjacency', () => {
    const bank = makeBank();
    const report = certifyBank(bank, { realClusters: 2 });
    assert.equal(report.counts.rejected, 0, JSON.stringify(report.rejectionReasonHistogram));
    assert.equal(report.counts.certified, bank.rows.length);
    assert.equal(report.counts.abstain, bank.rows.filter((r) => r.bmuTask.abstain).length);
    assert.equal(report.gates['G-B2_oracle'].pass, true);
    assert.equal(report.gates['G-B3_bm25'].pass, true);
    assert.equal(report.gates['G-B3_firstK'].pass, true);
    assert.equal(report.gates['G-B3_randomK'].pass, true);
    assert.equal(report.gates.leakScreen.pass, true);
    assert.equal(report.gates.family_abstainTrapAdjacency_bm25.pass, true);
    // abstain rows never baseline-judge-succeed by law, and the collision
    // neighborhood out-pulls BM25 on EVERY absent-variant query
    assert.equal(report.baselineRates.bm25.abstainForbiddenAdmissionRate, 1);
    // no real-lane scores supplied → the gate must NOT silently pass
    assert.equal(report.gates['G-B1_realLane_noSubstrate'].pass, false);
  });

  test('poisoned bank (answer value leaked into a query) → rejected WITH reasons', () => {
    const bank = makeBank();
    const victim = bank.rows.find((r) => r.questionType === 'exact_variant_lookup');
    victim.queryText = `${victim.queryText} (${victim.bmuTask.answer.value})`;
    const report = certifyBank(bank, { realClusters: 2 });
    const rej = report.rejected.find((r) => r.rowId === victim.id);
    assert.ok(rej, 'leaky row must be rejected');
    assert.ok(rej.reasons.includes('answer_leak'), JSON.stringify(rej));
    assert.equal(report.counts.certified + report.counts.rejected, bank.rows.length);
  });

  test('abstain row whose neighborhood does not out-pull BM25 → abstain_trap_not_adjacent_bm25', () => {
    const bank = makeBank();
    const victim = bank.rows.find((r) => r.bmuTask.abstain === true);
    // Point the query at ANOTHER cluster's exact-lookup question: BM25's
    // top-B fills with THAT cluster's docs (its subject/attribute tokens are
    // window-unique), the victim's forbidden set stays out, and the §5.4
    // anti-free-abstention law must reject the row.
    const otherCluster = bank.clusters.find((c) => !c.rowIds.includes(victim.id));
    const otherRow = bank.rows.find((r) => r.bmuTask.motifGroupId === otherCluster.motifGroupId && r.questionType === 'exact_variant_lookup');
    victim.queryText = otherRow.queryText;
    const report = certifyBank(bank, { realClusters: 2 });
    const rej = report.rejected.find((r) => r.rowId === victim.id);
    assert.ok(rej && rej.reasons.includes('abstain_trap_not_adjacent_bm25'), JSON.stringify(rej));
    assert.equal(report.gates.family_abstainTrapAdjacency_bm25.pass, false);
    assert.deepEqual(report.gates.family_abstainTrapAdjacency_bm25.cleanRows, [victim.id]);
  });

  test('a cluster whose oracle structure is broken is rejected, not dropped', () => {
    const bank = makeBank();
    const victimCluster = bank.clusters[0];
    bank.relations = bank.relations.filter((r) => !(r.label === 'public_path_seed' && victimCluster.docIds.includes(r.src)));
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
    assert.deepEqual(
      a.map((c) => c.motifGroupId),
      selectRealLaneClusters(bank, 2).map((c) => c.motifGroupId),
    );
    assert.equal(new Set(a.map((c) => c.epoch)).size, 2, 'must spread across epochs (escalation coverage)');
  });
  test('job carries the full doc pool + exactly the subsample queries', () => {
    const job = buildRealLaneJob(bank, { realClusters: 2 });
    assert.equal(job.docs.length, bank.publicDocs.length);
    assert.equal(job.queries.length, 10);
    assert.equal(job.pins.rerankerInputTopK, 64);
  });
});
