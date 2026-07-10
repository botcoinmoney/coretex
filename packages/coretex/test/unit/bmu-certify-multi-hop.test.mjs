/**
 * BMU P2 — multi_hop_relation certification adapter unit suite
 * (certify-multi-hop.mjs over the SHARED certify.mjs harness).
 * Frozen spec: specs/BMU_SPEC.md rev3.2 (ad7e523) §2.2 (judge), §5.3
 * (evidence law), §6.5 (trap law), §13.2 (margins), gates G-B1..G-B3.
 *
 * Covers: structure-only oracle chain reconstruction (2-hop and 3-hop,
 * answer = terminal vs head by question type; corrupted structure ⇒ oracle
 * fails, proving it never reads bmuTask labels); leak-screen detections
 * (answer value, bridge token, gold-only skeleton vocab) and the
 * slot-collapse non-detection ('duty owner' target-attr fills are not
 * leaks); end-to-end certifyMultiHopBank on a real (small) generator bank —
 * oracle 1.0, trivial baselines u=0, all rows certified; real-lane merge
 * with synthetic scores incl. the no-substrate-solves rejection and the
 * §13.2 blank-state margin/cap fields; fail-closed on foreign-family banks.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  multiHopOracleLane,
  multiHopLeakScreen,
  certifyMultiHopBank,
  MULTI_HOP_GOLD_ONLY_TOKENS,
} from '../../../../scripts/lib/bmu-generators/certify-multi-hop.mjs';
import { judgeTopB, buildBm25Index } from '../../../../scripts/lib/bmu-generators/certify-lanes.mjs';
import { buildMultiHopSampleBank, SAMPLE_BANK_PARAMS } from '../../../../scripts/lib/bmu-generators/emit-multi-hop-sample-bank.mjs';

/** Small real bank: one epoch, four clusters (both hop shapes, both subject
 *  kinds under the block subject layout) — fast but end-to-end honest. */
function smallBank() {
  const params = { ...SAMPLE_BANK_PARAMS, epochs: [150], clustersPerEpoch: 4 };
  const { clusters } = buildMultiHopSampleBank(params);
  return { kind: 'bmu-p2-sample-bank', family: 'multi_hop_relation', clusters };
}

test('oracle: reconstructs the disjoint public-path diamond and judges u=1 on every row (2-hop and 3-hop)', () => {
  const bank = smallBank();
  const docs = bank.clusters.flatMap((c) => c.docs);
  assert.ok(bank.clusters.some((c) => c.hopCount === 2) && bank.clusters.some((c) => c.hopCount === 3));
  for (const cluster of bank.clusters) {
    for (const row of cluster.rows) {
      const o = multiHopOracleLane(row, cluster, docs, row.bmuTask.budgetB);
      // Structure-derived evidence must equal the labeled chain (mint-consistency).
      assert.deepEqual([...o.evidence].sort(), [...row.bmuTask.requiredEvidence].sort(), row.id);
      assert.equal(o.answerId, row.bmuTask.answer.id, `${row.id} (${row.questionType})`);
      assert.equal(judgeTopB(o.ranked, row.bmuTask).u, 1, row.id);
    }
  }
});

test('oracle: answer doc is the chain TERMINAL for endpoint/rejection/routing and the chain HEAD for provenance', () => {
  const bank = smallBank();
  const docs = bank.clusters.flatMap((c) => c.docs);
  const threeHop = bank.clusters.find((c) => c.hopCount === 3);
  const byType = Object.fromEntries(threeHop.rows.map((r) => [r.questionType, r]));
  const term = multiHopOracleLane(byType.chain_endpoint_value, threeHop, docs, 4);
  const prov = multiHopOracleLane(byType.chain_provenance, threeHop, docs, 4);
  assert.notEqual(term.answerId, prov.answerId);
  const docById = new Map(docs.map((d) => [d.id, d]));
  assert.equal(docById.get(term.answerId)?.role, 'chain_answer');
  assert.equal(docById.get(prov.answerId)?.role, 'chain_hop1');
  // Both still require bridge + answer (head + terminal); hop-2 is graded support.
  assert.equal(term.evidence.length, 2);
  assert.equal(prov.evidence.length, 2);
  assert.deepEqual([...term.evidence].sort(), [...byType.chain_endpoint_value.bmuTask.requiredEvidence].sort());
});

test('oracle is structure-only: cutting the public-path seed breaks it even though bmuTask labels are intact', () => {
  const bank = smallBank();
  const docs = bank.clusters.flatMap((c) => c.docs);
  const cluster = bank.clusters.find((c) => c.hopCount === 3);
  const corrupted = { ...cluster, relations: cluster.relations.filter((r) => r.label !== 'public_path_seed') };
  const row = cluster.rows[0];
  const o = multiHopOracleLane(row, corrupted, docs, row.bmuTask.budgetB);
  assert.notDeepEqual([...o.evidence].sort(), [...row.bmuTask.requiredEvidence].sort());
  assert.equal(judgeTopB(o.ranked, row.bmuTask).u, 0);
});

test('leak screen: real bank rows pass; trap dominance is recorded as a diagnostic', () => {
  const bank = smallBank();
  const docs = bank.clusters.flatMap((c) => c.docs);
  const index = buildBm25Index(docs);
  let dominant = 0; let rows = 0;
  for (const cluster of bank.clusters) {
    for (const row of cluster.rows) {
      const res = multiHopLeakScreen(row, cluster, index);
      assert.deepEqual(res.reasons, [], `${row.id}: ${res.reasons}`);
      assert.equal(typeof res.trapLexicallyDominant, 'boolean');
      dominant += res.trapLexicallyDominant ? 1 : 0;
      rows += 1;
    }
  }
  // The §6.5 off-path trap should dominate the golds lexically on most rows.
  assert.ok(dominant / rows > 0.5, `trap dominant on ${dominant}/${rows}`);
});

test('leak screen: detects answer-value, bridge-token, and gold-only skeleton vocab leaks', () => {
  const bank = smallBank();
  const docs = bank.clusters.flatMap((c) => c.docs);
  const index = buildBm25Index(docs);
  const cluster = bank.clusters[0];
  const row = cluster.rows[0];
  const leak = (queryText) => multiHopLeakScreen({ ...row, queryText }, cluster, index);

  const v = leak(`${row.queryText} — is it ${cluster.answerValue}?`);
  assert.ok(v.reasons.some((r) => r.startsWith('answer_value_in_question:')));

  const b = leak(`${row.queryText} via ${cluster.bridgeTokens[0]}`);
  assert.ok(b.reasons.some((r) => r.startsWith('bridge_token_in_question:')));

  const g = leak(`Per the delegation ledger, ${row.queryText}`);
  assert.ok(g.reasons.some((r) => r.startsWith('gold_only_vocab_in_question:')));
  assert.ok(MULTI_HOP_GOLD_ONLY_TOKENS.includes('ledger'));
});

test('leak screen: gold-only vocab check is slot-collapsed — a "duty owner" target-attr fill is NOT a leak', () => {
  const bank = smallBank();
  const docs = bank.clusters.flatMap((c) => c.docs);
  const index = buildBm25Index(docs);
  const cluster = { ...bank.clusters[0], targetAttribute: 'duty owner' };
  const row = { ...cluster.rows[0], queryText: `Right now, which duty owner applies for ${cluster.canonicalName}’s ${cluster.topic}?` };
  const res = multiHopLeakScreen(row, cluster, index);
  assert.ok(!res.reasons.some((r) => r.startsWith('gold_only_vocab_in_question:')), `${res.reasons}`);
  // The same token OUTSIDE a slot fill (raw skeleton vocabulary) still trips.
  const raw = multiHopLeakScreen({ ...cluster.rows[0], queryText: `${cluster.rows[0].queryText} per the duty roster` }, cluster, index);
  assert.ok(raw.reasons.some((r) => r === 'gold_only_vocab_in_question:duty'));
});

test('e2e certifyMultiHopBank: oracle 1.0, trivial baselines u=0, all rows certified (G-B2/G-B3)', () => {
  const report = certifyMultiHopBank(smallBank());
  assert.equal(report.totals.oracleRate, 1);
  assert.equal(report.baselineRates.bm25.uRate, 0);
  assert.equal(report.baselineRates.firstK.uRate, 0);
  assert.equal(report.baselineRates.randomK.uRate, 0);
  assert.equal(report.totals.certificationRate, 1);
  assert.deepEqual(report.rejectedTasks, []);
  assert.equal(report.family, 'multi_hop_relation');
  // Determinism of the report body (same bank, same seed).
  const again = certifyMultiHopBank(smallBank());
  assert.deepEqual(again, report);
});

test('real-lane merge: a no-substrate solve is a rejection with reason, and §13.2 blank-state margin fields land (G-B1/I8)', () => {
  // 8 clusters ⇒ >64 public docs, so the rerankerInputTopK=64 admission
  // boundary is BINDING (same regime as the emitted 204-doc bank).
  const params = { ...SAMPLE_BANK_PARAMS, epochs: [150], clustersPerEpoch: 8 };
  const bank = { kind: 'bmu-p2-sample-bank', family: 'multi_hop_relation', clusters: buildMultiHopSampleBank(params).clusters };
  assert.ok(bank.clusters.flatMap((c) => c.docs).length > 64);
  const cluster = bank.clusters[0];
  const row = cluster.rows[0];
  const allDocs = bank.clusters.flatMap((c) => c.docs);
  // Synthetic scores that SOLVE the task at the head (chain + answer top-B,
  // no forbidden) — certifyBank must reject the row for real_lane solve.
  const cosine = {}; const rerank = {};
  allDocs.forEach((d, i) => { cosine[d.id] = 0.1 - i * 1e-4; });
  row.bmuTask.forbiddenEvidence.forEach((d) => { cosine[d] = -0.5; }); // traps evicted
  row.bmuTask.requiredEvidence.forEach((d, i) => { cosine[d] = 0.9 - i * 1e-2; rerank[d] = 0.99 - i * 1e-2; });
  const realLane = { params: { rerankerInputTopK: 64, rerankCandidates: 16 }, rows: { [row.id]: { cosine, rerank } } };
  const report = certifyMultiHopBank(bank, { realLane });
  const task = report.perTask.find((t) => t.rowId === row.id);
  assert.ok(task.reasons.includes('real_lane_no_substrate_solves:bge+qwen'));
  assert.equal(task.certified, false);
  assert.equal(task.realLane.bgeQwen.u, 1);
  // §13.2 blank-state margins: admission (cap-64 binding on this >64-doc bank)
  // and final-order structures are present, cap logged at report level.
  assert.ok(Array.isArray(task.realLane.margins.admission));
  assert.ok(Array.isArray(task.realLane.margins.finalOrder));
  assert.equal(report.realLaneCoverage.rowsCertified, 1);
  assert.match(report.realLaneCoverage.cap, /SMALL-SCALE/);
});

test('fail-closed: foreign-family bank throws', () => {
  assert.throws(() => certifyMultiHopBank({ family: 'temporal', clusters: [] }), /≠ 'multi_hop_relation'/);
});
