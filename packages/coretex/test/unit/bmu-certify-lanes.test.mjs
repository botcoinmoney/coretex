/**
 * BMU P2 — hardness-certification harness unit suite (certify-lanes.mjs,
 * the temporal/multihop lane harness; renamed from certify.mjs at the P2
 * consolidation merge — the conflict/nearcol harness kept the certify.mjs
 * name and packages/coretex/test/unit/bmu-certify.test.mjs).
 * Frozen spec: specs/BMU_SPEC.md rev3.2 (ad7e523) §2.2 (judge), §13.2
 * (quantized ordering + margins), gates G-B1..G-B3.
 *
 * Covers: judge u(t) component logic (required/forbidden/answer conjuncts);
 * deterministic quantized ranking + docId tiebreak; BM25 sanity; seeded
 * random-K determinism; temporal oracle structural derivation (label-free);
 * leak-screen detections; end-to-end certifyBank on a real (small) generator
 * bank — oracle 100%, baselines 0, all rows certified; real-lane merge with
 * synthetic cosine/rerank scores incl. no-substrate-solves rejection and
 * blank-state margin fields; fail-closed on duplicate doc ids / unknown
 * family.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  quantize,
  rankDocs,
  judgeTopB,
  buildBm25Index,
  bm25Score,
  randomKLane,
  subjectScopedRecencyLane,
  validityCurrencyLane,
  ORACLE_LANES,
  LEAK_SCREENS,
  certifyBank,
} from '../../../../scripts/lib/bmu-generators/certify-lanes.mjs';
import { buildTemporalSampleBank, SAMPLE_BANK_PARAMS } from '../../../../scripts/lib/bmu-generators/emit-temporal-sample-bank.mjs';

/** Small real bank: one epoch, two clusters — fast but end-to-end honest. */
function smallBank() {
  const params = { ...SAMPLE_BANK_PARAMS, epochs: [150], clustersPerEpoch: 2 };
  const { clusters } = buildTemporalSampleBank(params);
  return { kind: 'bmu-p2-sample-bank', family: 'temporal', clusters };
}

test('rankDocs: quantized desc order with docId asc tiebreak (§13.2)', () => {
  const ranked = rankDocs([
    { docId: 'b', primary: 0.5004 },
    { docId: 'a', primary: 0.5001 },   // same 1e-3 cell as b -> docId tiebreak
    { docId: 'c', primary: 0.9 },
    { docId: 'd', primary: 0.1 },
  ]);
  assert.deepEqual(ranked, ['c', 'a', 'b', 'd']);
  assert.equal(quantize(0.5004, 1e-3), quantize(0.5001, 1e-3));
});

test('judgeTopB: u=1 requires ALL of R⊆topB, F∩topB=∅, answer∈topB (§2.2)', () => {
  const task = {
    budgetB: 3,
    requiredEvidence: ['r1', 'r2'],
    forbiddenEvidence: ['f1'],
    answer: { id: 'r1', value: 'x' },
  };
  assert.equal(judgeTopB(['r1', 'r2', 'z'], task).u, 1);
  // forbidden admitted -> 0
  const f = judgeTopB(['r1', 'r2', 'f1'], task);
  assert.equal(f.u, 0);
  assert.deepEqual(f.forbiddenAdmitted, ['f1']);
  // required not covered -> 0
  assert.equal(judgeTopB(['r1', 'z', 'y'], task).u, 0);
  // answer outside topB (r1 at rank 4) -> 0
  assert.equal(judgeTopB(['r2', 'z', 'y', 'r1'], task, 3).u, 0);
  // budget override tightens: at B=1 r2 no longer fits
  assert.equal(judgeTopB(['r1', 'r2', 'z'], task, 1).u, 0);
  // ... while B=2 still admits the full required set
  assert.equal(judgeTopB(['r1', 'r2', 'z'], task, 2).u, 1);
});

test('bm25: exact-vocabulary doc outranks unrelated doc', () => {
  const docs = [
    { id: 'gold', text: 'the launch window for orion is march' },
    { id: 'noise', text: 'unrelated text about gardening and soil' },
  ];
  const idx = buildBm25Index(docs);
  const q = 'what is the launch window for orion?';
  assert.ok(bm25Score(idx, q, 'gold') > bm25Score(idx, q, 'noise'));
});

test('randomKLane: deterministic per (seed,row), varies across rows', () => {
  const docs = Array.from({ length: 20 }, (_, i) => ({ id: `d${String(i).padStart(2, '0')}` }));
  const a = randomKLane({ id: 'row1' }, docs, 's');
  const b = randomKLane({ id: 'row1' }, docs, 's');
  const c = randomKLane({ id: 'row2' }, docs, 's');
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual([...a].sort(), docs.map((d) => d.id));
});

test('temporal shortcut attackers use public structure only and the minted controls defeat them', () => {
  const bank = smallBank();
  const docs = bank.clusters.flatMap((c) => c.docs);
  for (const cluster of bank.clusters) {
    for (const row of cluster.rows) {
      const recency = judgeTopB(subjectScopedRecencyLane(row, docs), row.bmuTask);
      const currency = judgeTopB(validityCurrencyLane(row, docs), row.bmuTask);
      assert.equal(recency.u, 0, `${row.id}: last-mention must not solve`);
      assert.equal(currency.u, 0, `${row.id}: validity-only must not solve`);
      assert.equal(recency.requiredCovered && recency.answerInTopB, false,
        `${row.id}: last-mention must not match oracle positive coverage`);
      assert.equal(currency.requiredCovered && currency.answerInTopB, false,
        `${row.id}: validity-only must not match oracle positive coverage`);
      assert.equal(recency.topB.some((id) => row.bmuTask.forbiddenEvidence.includes(id)), false,
        'shortcut controls should defeat recency without relying on the forbidden veto');
    }
  }
});

test('temporal oracle derives evidence from STRUCTURE and matches generator labels', () => {
  const bank = smallBank();
  const docs = bank.clusters.flatMap((c) => c.docs);
  for (const cluster of bank.clusters) {
    for (const row of cluster.rows) {
      const o = ORACLE_LANES.temporal(row, cluster, docs, row.bmuTask.budgetB);
      // label agreement (mint-consistency): structure-derived == stamped
      assert.deepEqual([...o.evidence].sort(), [...row.bmuTask.requiredEvidence].sort(), row.id);
      assert.equal(o.answerId, row.bmuTask.answer.id, row.id);
      // never admits a forbidden doc
      for (const f of row.bmuTask.forbiddenEvidence) assert.ok(!o.ranked.includes(f), row.id);
      assert.equal(judgeTopB(o.ranked, row.bmuTask).u, 1, row.id);
    }
  }
});

test('leak screen: detects answer-value leak, gold-only vocab, shared skeleton', () => {
  const bank = smallBank();
  const cluster = bank.clusters[0];
  const docs = bank.clusters.flatMap((c) => c.docs);
  const idx = buildBm25Index(docs);
  const row = cluster.rows.find((r) => r.questionType === 'current_value');
  // clean generator row passes
  assert.equal(LEAK_SCREENS.temporal(row, cluster, idx).pass, true);
  // answer value injected -> fail
  const leaky = { ...row, queryText: `${row.queryText} maybe ${cluster.currentValue}?` };
  const r1 = LEAK_SCREENS.temporal(leaky, cluster, idx);
  assert.equal(r1.pass, false);
  assert.ok(r1.reasons.some((x) => x.startsWith('answer_value_in_question')));
  // gold-only vocab injected -> fail
  const vocab = { ...row, queryText: `${row.queryText} was it superseded?` };
  const r2 = LEAK_SCREENS.temporal(vocab, cluster, idx);
  assert.ok(r2.reasons.some((x) => x.startsWith('gold_only_vocab_in_question')));
  // gold doc text pasted into question -> shared-skeleton fail
  const goldDoc = cluster.docs.find((d) => d.id === row.bmuTask.requiredEvidence[0]);
  const skel = { ...row, queryText: goldDoc.text };
  const r3 = LEAK_SCREENS.temporal(skel, cluster, idx);
  assert.ok(r3.reasons.some((x) => x.startsWith('shared_4gram_skeleton_with_gold')));
});

test('certifyBank end-to-end on a real generator bank: oracle 1.0, trivial baselines 0, all certified', () => {
  const bank = smallBank();
  const report = certifyBank(bank, { seed: 'unit-test-seed' });
  assert.equal(report.totals.rows, 10);
  assert.equal(report.totals.oracleRate, 1);
  assert.equal(report.baselineRates.bm25.uRate, 0);
  assert.equal(report.baselineRates.firstK.uRate, 0);
  assert.equal(report.baselineRates.randomK.uRate, 0);
  assert.equal(report.shortcutGates.requiredForFamily, true);
  assert.equal(report.shortcutGates.pass, true);
  assert.equal(report.shortcutGates.lanes.subjectScopedRecency.competitiveWithOracle, false);
  assert.equal(report.shortcutGates.lanes.validityCurrency.competitiveWithOracle, false);
  assert.equal(report.totals.packCertified, true);
  assert.equal(report.totals.certificationRate, 1);
  assert.deepEqual(report.rejectedTasks, []);
  assert.equal(report.certifiedSubset.length, 10);
  // no-silent-caps: real lane not run must be stated
  assert.match(report.realLaneCoverage.cap, /NOT RUN/);
});

test('certifyBank real-lane merge: no-substrate solve rejects; margins reported for blank state', () => {
  const bank = smallBank();
  const cluster = bank.clusters[0];
  const row = cluster.rows.find((r) => r.questionType === 'current_value');
  const allDocs = bank.clusters.flatMap((c) => c.docs);
  // Synthetic "real" scores where the no-substrate lane SOLVES the task:
  // required docs + answer on top, forbidden buried.
  const cosine = {}; const rerank = {};
  allDocs.forEach((d, i) => { cosine[d.id] = 0.2 - i * 1e-4; });
  for (const rid of row.bmuTask.requiredEvidence) { cosine[rid] = 0.99; rerank[rid] = 0.99; }
  // benign out-of-cluster docs fill the rest of top-B; the trap reranks low
  const benign = allDocs.filter((d) => !cluster.docs.includes(d)).slice(0, 2);
  rerank[benign[0].id] = 0.9;
  rerank[benign[1].id] = 0.8;
  rerank[cluster.docs.find((d) => d.role === 'stale_trap').id] = 0.01;
  const realLane = { params: { rerankCandidates: 16, rerankerInputTopK: 64 }, rows: { [row.id]: { cosine, rerank } } };
  const report = certifyBank(bank, { seed: 'unit-test-seed', realLane });
  const t = report.perTask.find((x) => x.rowId === row.id);
  assert.equal(t.realLane.bgeQwen.u, 1);
  assert.equal(t.certified, false);
  assert.ok(t.reasons.includes('real_lane_no_substrate_solves:bge+qwen'));
  assert.equal(t.realLane.margins.state, 'blank');
  assert.ok(Array.isArray(t.realLane.margins.finalOrder));
  const reqMargin = t.realLane.margins.finalOrder.find((m) => m.docId === row.bmuTask.requiredEvidence[0]);
  assert.equal(reqMargin.inTopB, true);
  assert.ok(reqMargin.marginOk); // 0.99 vs 0.5 boundary ≈ 490 cells
  // coverage cap logged with exact counts
  assert.match(report.realLaneCoverage.cap, /1\/10 rows/);
  // other rows untouched by the real lane stay certified
  assert.equal(report.totals.certified, 9);
});

test('fail-closed: duplicate doc ids and unregistered family throw', () => {
  const bank = smallBank();
  assert.throws(() => certifyBank({ ...bank, family: 'no_such_family' }), /no oracle lane/);
  const dup = { ...bank, clusters: [bank.clusters[0], bank.clusters[0]] };
  assert.throws(() => certifyBank(dup), /duplicate doc id/);
});
