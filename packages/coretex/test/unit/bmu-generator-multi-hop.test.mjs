/**
 * BMU P2 — family "multi_hop_relation" offline generator unit suite.
 * Frozen spec: specs/BMU_SPEC.md rev3.2 (ad7e523) §4.1, §4.2, §5.3, §6.3.
 *
 * Covers: determinism; GLOBAL m=1 census over multi-epoch generation with
 * retirement (rotation waits for retirement); per-(family, epoch) template
 * partition + the "same templateId iff same surface form" law; forbidden-
 * trap presence + out-ranks-honestly structure; chain-shape law (2-hop and
 * 3-hop, requiredEvidence = the chain, grounding-distant answer); §4.1
 * schema completeness (mirrors the load-time validation rules); no-answer-
 * leak lint; canonical eval_hidden split landing; fail-closed behaviors.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { splitForRecord } from '../../dist/eval/retrieval-corpus.js';
import { liveTailQueryId } from '../../dist/corpus/logical-delta-bridge.js';
import {
  generateMultiHopClusters,
  multiHopTopicForEpochSlot,
  MULTI_HOP_TEMPLATE_BANK,
  MULTI_HOP_ROW_SLOTS,
  BMU_MULTI_HOP_BUDGET_B,
  BMU_MULTI_HOP_CLUSTER_K,
  renderTemplate,
} from '../../../../scripts/lib/bmu-generators/multi_hop_relation.mjs';
import {
  createBmuActiveIndex,
  retireAgedClusters,
  m1Census,
  containsValue,
} from '../../../../scripts/lib/bmu-generators/common.mjs';

const CORPUS_EPOCH = 138;
/** Canonical split composition — exactly the evolve wiring (coretex-epoch-evolve.mjs:583). */
const canonicalSplitOf = (logicalQueryId, liveUpdateEpoch) => splitForRecord(
  liveUpdateEpoch !== undefined && liveUpdateEpoch !== null
    ? liveTailQueryId(logicalQueryId, liveUpdateEpoch)
    : logicalQueryId,
  CORPUS_EPOCH,
);

function subjectBank(n = 40) {
  const subjects = [];
  for (let i = 0; i < n; i++) {
    subjects.push(i % 3 === 0
      ? { id: `subj_mh_prj_${i}`, canonicalName: `harbor-svc-lane${i}` }
      : { id: `subj_mh_usr_${i}`, canonicalName: `Chained Person${i} Delgado` });
  }
  return subjects;
}

const baseOpts = (over = {}) => ({
  epoch: 150,
  seed: 'bmu-p2-multihop-test-v1',
  subjects: subjectBank(),
  universe: 'user_scope_bmu_mh_test',
  clusterCount: 4,
  splitOf: canonicalSplitOf,
  ...over,
});

// ── determinism ──────────────────────────────────────────────────────────────

test('determinism: identical inputs → byte-identical output', () => {
  const a = generateMultiHopClusters(baseOpts());
  const b = generateMultiHopClusters(baseOpts());
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('determinism: seed and epoch move the draw', () => {
  const a = generateMultiHopClusters(baseOpts());
  const b = generateMultiHopClusters(baseOpts({ seed: 'bmu-p2-multihop-test-v2' }));
  const c = generateMultiHopClusters(baseOpts({ epoch: 151 }));
  assert.notDeepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.notEqual(a.clusters[0].rows[0].id, c.clusters[0].rows[0].id);
});

test('determinism: activeIndex state participates (occupied subject → different pick)', () => {
  const a = generateMultiHopClusters(baseOpts({ clusterCount: 1 }));
  const occupied = createBmuActiveIndex();
  occupied.subjects.set(a.clusters[0].subjectEntityId, 'mg_other_family_cluster');
  const b = generateMultiHopClusters(baseOpts({ clusterCount: 1, activeIndex: occupied }));
  assert.notEqual(b.clusters[0].subjectEntityId, a.clusters[0].subjectEntityId);
});

// ── schema completeness (§4.1) ───────────────────────────────────────────────

test('every row carries a complete, self-consistent §4.1 bmuTask stamp', () => {
  const { clusters } = generateMultiHopClusters(baseOpts());
  for (const cluster of clusters) {
    assert.equal(cluster.rows.length, BMU_MULTI_HOP_CLUSTER_K, 'cluster size k=5 is law');
    const docIds = new Set(cluster.docs.map((d) => d.id));
    for (const row of cluster.rows) {
      const t = row.bmuTask;
      assert.equal(t.family, 'multi_hop_relation');
      assert.ok(Number.isInteger(t.budgetB) && t.budgetB >= 1 && t.budgetB <= 8);
      assert.equal(t.budgetB, BMU_MULTI_HOP_BUDGET_B);
      assert.ok(Array.isArray(t.requiredEvidence) && t.requiredEvidence.length > 0);
      assert.ok(Array.isArray(t.forbiddenEvidence) && t.forbiddenEvidence.length > 0);
      assert.ok(t.answer && typeof t.answer.id === 'string' && t.answer.id.length > 0);
      assert.equal(t.abstain, false);
      assert.ok(typeof t.motifGroupId === 'string' && t.motifGroupId.length > 0);
      assert.ok(typeof t.templateId === 'string' && t.templateId.length > 0);
      // load-time validation mirror (§4.1)
      assert.ok(t.requiredEvidence.includes(t.answer.id), 'answer.id ∈ requiredEvidence');
      assert.ok(t.requiredEvidence.length <= t.budgetB, '|requiredEvidence| ≤ budgetB');
      for (const f of t.forbiddenEvidence) assert.ok(!t.requiredEvidence.includes(f), 'required ∩ forbidden = ∅');
      assert.equal(new Set(t.requiredEvidence).size, t.requiredEvidence.length, 'no duplicate required docs');
      for (const id of [...t.requiredEvidence, ...t.forbiddenEvidence, t.answer.id]) {
        assert.ok(docIds.has(id), `referenced doc ${id} exists in cluster docs`);
      }
      assert.equal(t.motifGroupId, cluster.motifGroupId);
      // §5.6 namespace pair on the row (logicalFamily buckets to multi_hop_relation)
      assert.equal(row.family, 'multi_session_bridge');
      assert.equal(row.subjectEntityId, cluster.subjectEntityId);
      assert.equal(row.liveUpdateEpoch, cluster.epoch);
      // mint-time consistency rule (§4.3)
      const relOf = new Map(row.qrels.map((r) => [r.docId, r.relevance]));
      const negSet = new Set(row.hardNegatives.map((n) => n.docId));
      for (const req of t.requiredEvidence) assert.ok((relOf.get(req) ?? 0) >= 0.5, 'required ⊆ {qrels ≥ 0.5}');
      for (const f of t.forbiddenEvidence) assert.ok(relOf.get(f) === 0 || negSet.has(f), 'forbidden ⊆ {qrels=0} ∪ hardNegatives');
    }
    // four distinct question types across k=5 rows (typed-cluster law)
    const types = new Set(cluster.rows.map((r) => r.questionType));
    assert.equal(types.size, 4);
    assert.deepEqual(cluster.rows.map((r) => r.questionType), MULTI_HOP_ROW_SLOTS);
  }
});

// ── chain-shape law (§5.3) ───────────────────────────────────────────────────

test('chains: 2-hop and 3-hop both minted; requiredEvidence = bridge + answer (§5.3)', () => {
  const { clusters, telemetry } = generateMultiHopClusters(baseOpts());
  assert.ok(telemetry.hopCountHistogram[2] >= 1, '2-hop clusters present');
  assert.ok(telemetry.hopCountHistogram[3] >= 1, '3-hop clusters present');
  for (const cluster of clusters) {
    const byRole = new Map(cluster.docs.map((d) => [d.role, d]));
    assert.ok(byRole.get('chain_hop1'), 'hop1 exists');
    assert.ok(byRole.get('chain_answer'), 'answer exists');
    if (cluster.hopCount === 3) assert.ok(byRole.get('chain_hop2'), 'hop2 exists on 3-hop');
    const utilityRequired = [byRole.get('chain_hop1').id, byRole.get('chain_answer').id].sort();
    for (const row of cluster.rows) {
      assert.deepEqual([...row.bmuTask.requiredEvidence].sort(), utilityRequired,
        'requiredEvidence is bridge + answer (intermediate hop stays graded support)');
      assert.ok(row.bmuTask.requiredEvidence.length <= row.bmuTask.budgetB);
      if (row.questionType === 'chain_provenance') {
        assert.equal(row.bmuTask.answer.id, byRole.get('chain_hop1').id);
      } else {
        assert.equal(row.bmuTask.answer.id, byRole.get('chain_answer').id);
      }
    }
  }
});

test('grounding-distant law: answer doc (and hop2) never name subject/topic; entityIds carry no subject tag', () => {
  const { clusters } = generateMultiHopClusters(baseOpts({ clusterCount: 6 }));
  for (const cluster of clusters) {
    for (const d of cluster.docs) {
      if (d.role !== 'chain_answer' && d.role !== 'chain_hop2') continue;
      assert.equal(d.grounding, 'distant');
      assert.ok(!containsValue(d.text, cluster.canonicalName), `distant doc ${d.id} must not name the subject`);
      assert.ok(!containsValue(d.text, cluster.topic), `distant doc ${d.id} must not name the topic`);
      assert.deepEqual(d.entityIds, ['user_scope_bmu_mh_test'], 'no subject entity tag on distant docs (routing shortcut)');
    }
  }
});

test('coreference framing (I3): person 3-hop chains are alias-framed, projects are not', () => {
  const { clusters } = generateMultiHopClusters(baseOpts({ clusterCount: 8 }));
  const threeHop = clusters.filter((c) => c.hopCount === 3);
  assert.ok(threeHop.length >= 2);
  for (const cluster of threeHop) {
    const isProject = /-svc-/.test(cluster.canonicalName);
    assert.equal(cluster.corefFramed, !isProject);
    const hop1 = cluster.docs.find((d) => d.role === 'chain_hop1');
    if (cluster.corefFramed) {
      const alias = cluster.canonicalName.split(/\s+/)[0];
      assert.ok(hop1.text.startsWith(alias), 'alias opens the memo (ancestor coreference shape)');
      assert.ok(containsValue(hop1.text, cluster.canonicalName), 'bridge doc names both endpoints');
    }
  }
});

// ── forbidden-trap construction (§5.3, §6.5 part 1) ──────────────────────────

test('trap law: off-path decoy out-ranks honestly; near-bridge decoy breaks the chain; both forbidden', () => {
  const { clusters } = generateMultiHopClusters(baseOpts());
  for (const cluster of clusters) {
    const offpath = cluster.docs.find((d) => d.role === 'offpath_decoy');
    const nearBridge = cluster.docs.find((d) => d.role === 'near_bridge_decoy');
    assert.ok(offpath && nearBridge, 'both decoy kinds minted');
    // off-path decoy: subject + topic + targetAttr + wrong value (lexical trap),
    // without the bleed-prone "working ${targetAttr}" query skeleton.
    assert.ok(containsValue(offpath.text, cluster.canonicalName));
    assert.ok(containsValue(offpath.text, cluster.topic));
    assert.ok(containsValue(offpath.text, cluster.targetAttribute));
    assert.ok(containsValue(offpath.text, cluster.decoyValues[0]));
    assert.ok(!containsValue(offpath.text, cluster.answerValue), 'decoy never carries the true value');
    assert.ok(!/\bworking\b/i.test(offpath.text), 'avoid working-targetAttr bleed phrase');
    // near-bridge decoy: names the REAL last bridge token with a wrong draft value
    const lastBridge = cluster.bridgeTokens[cluster.bridgeTokens.length - 1];
    assert.ok(containsValue(nearBridge.text, lastBridge));
    assert.ok(containsValue(nearBridge.text, cluster.decoyValues[1]));
    assert.ok(!containsValue(nearBridge.text, cluster.answerValue));
    for (const row of cluster.rows) {
      assert.ok(row.bmuTask.forbiddenEvidence.includes(offpath.id));
      assert.ok(row.bmuTask.forbiddenEvidence.includes(nearBridge.id));
    }
    // escalation shadows are forbidden too
    for (const shadow of cluster.docs.filter((d) => d.role === 'offpath_shadow')) {
      for (const row of cluster.rows) assert.ok(row.bmuTask.forbiddenEvidence.includes(shadow.id));
    }
    // noise-edge hazard made explicit: decoys hang off co_occurs_with edges
    assert.ok(cluster.relations.some((r) => r.src === offpath.id && r.type === 'co_occurs_with'));
    assert.ok(cluster.relations.some((r) => r.src === nearBridge.id && r.type === 'co_occurs_with'));
  }
});

test('escalation: shadow decoy count follows escalationLevelForEpoch and hardens the band', () => {
  const low = generateMultiHopClusters(baseOpts({ epoch: 150, escalation: { baseEpoch: 150 } })); // level 0
  const high = generateMultiHopClusters(baseOpts()); // epoch 150, default base 133 → level 4
  for (const c of low.clusters) {
    assert.equal(c.docs.filter((d) => d.role === 'offpath_shadow').length, 0);
    for (const row of c.rows) assert.equal(row.band, 'hard');
  }
  for (const c of high.clusters) {
    assert.equal(c.docs.filter((d) => d.role === 'offpath_shadow').length, 4);
    for (const row of c.rows) assert.equal(row.band, 'very_hard');
  }
});

// ── GLOBAL m=1 + rotation-waits-for-retirement (§4.1, §14.2) ─────────────────

test('m=1 census: multi-epoch generation over a shared index stays clean; subjects never reused while active', () => {
  const activeIndex = createBmuActiveIndex();
  const seen = [];
  for (const epoch of [150, 151, 152]) {
    retireAgedClusters(activeIndex, epoch, 32);
    const { clusters } = generateMultiHopClusters(baseOpts({ epoch, clusterCount: 5, activeIndex }));
    seen.push(...clusters);
  }
  assert.equal(seen.length, 15);
  assert.deepEqual(m1Census(activeIndex), []);
  const subjects = seen.map((c) => c.subjectEntityId);
  assert.equal(new Set(subjects).size, subjects.length, 'no subject reuse inside the active window');
  const templates = seen.flatMap((c) => c.templateIds);
  assert.equal(new Set(templates).size, templates.length, 'no template reuse inside the active window');
});

test('rotation waits for retirement: an occupied subject is only reusable after retireAgedClusters drops it', () => {
  const subjects = subjectBank(6); // tight bank
  const activeIndex = createBmuActiveIndex();
  generateMultiHopClusters(baseOpts({ subjects, clusterCount: 6, activeIndex })); // consumes ALL 6
  assert.throws(
    () => generateMultiHopClusters(baseOpts({ epoch: 151, subjects, clusterCount: 1, activeIndex })),
    /subject bank exhausted/,
  );
  const retired = retireAgedClusters(activeIndex, 150 + 32, 32);
  assert.equal(retired.length, 6);
  const after = generateMultiHopClusters(baseOpts({ epoch: 150 + 32, subjects, clusterCount: 1, activeIndex }));
  assert.equal(after.clusters.length, 1);
});

// ── template partition (§4.1 mint law / M7) ──────────────────────────────────

test('template partition: same-epoch clusters carry disjoint templateId sets; ids are bank-unique', () => {
  const { clusters } = generateMultiHopClusters(baseOpts({ clusterCount: 6 }));
  const all = clusters.flatMap((c) => c.templateIds);
  assert.equal(new Set(all).size, all.length, 'no templateId shared across same-(family, epoch) clusters');
  // same templateId ⟺ same surface skeleton, bank-wide
  const byId = new Map();
  for (const [qtype, bank] of Object.entries(MULTI_HOP_TEMPLATE_BANK)) {
    for (const v of bank) {
      assert.ok(!byId.has(v.templateId), `templateId ${v.templateId} unique across banks`);
      byId.set(v.templateId, v.skeleton);
      assert.ok(v.templateId.includes(qtype));
    }
  }
  // every minted row's rendered text matches its templateId's skeleton
  for (const cluster of clusters) {
    for (const row of cluster.rows) {
      const skeleton = byId.get(row.bmuTask.templateId);
      assert.ok(skeleton, 'templateId resolves to a bank skeleton');
      const rendered = renderTemplate(skeleton, {
        canonical: cluster.canonicalName, topic: cluster.topic,
        target: cluster.targetAttribute, decoyVal: cluster.decoyValues[0],
      });
      assert.equal(row.queryText, rendered);
    }
  }
});

// ── no-answer-leak (delta 7; Qwen-cold-answerable = certification reject) ────

test('no-answer-leak: answer value and bridge tokens never appear in questions; value only in the answer doc', () => {
  const { clusters } = generateMultiHopClusters(baseOpts({ clusterCount: 6 }));
  for (const cluster of clusters) {
    for (const row of cluster.rows) {
      assert.ok(!containsValue(row.queryText, cluster.answerValue), 'answer value never in a question');
      for (const tok of cluster.bridgeTokens) {
        assert.ok(!containsValue(row.queryText, tok), 'bridge tokens never in a question');
      }
    }
    for (const d of cluster.docs) {
      if (d.role === 'chain_answer') {
        assert.ok(containsValue(d.text, cluster.answerValue));
      } else {
        assert.ok(!containsValue(d.text, cluster.answerValue), `value must not appear in ${d.id}`);
      }
    }
  }
});

// ── canonical split landing (§4.3) ───────────────────────────────────────────

test('every minted row id lands in eval_hidden under the canonical split', () => {
  const { clusters } = generateMultiHopClusters(baseOpts({ clusterCount: 6 }));
  for (const cluster of clusters) {
    for (const row of cluster.rows) {
      assert.equal(canonicalSplitOf(row.id, row.liveUpdateEpoch), 'eval_hidden');
    }
  }
});

// ── rotation grid ────────────────────────────────────────────────────────────

test('topic rotation: deterministic grid walk with series suffix past a full cycle', () => {
  const a = multiHopTopicForEpochSlot(150, 0);
  const b = multiHopTopicForEpochSlot(150, 1);
  assert.notDeepEqual(a, b, 'two topics per epoch (slot parity)');
  assert.deepEqual(multiHopTopicForEpochSlot(150, 2), a, 'slot parity wraps');
  const wrapped = multiHopTopicForEpochSlot(133 + 18, 0); // (18)*2 = 36 = grid size → cycle 1
  assert.match(wrapped.topic, /\(series 2\)$/);
});

// ── sample bank (certification sizing: §6.7b E_f_min = 110 rows / 22 clusters)

test('sample bank: deterministic, certification-sized, m=1-clean', async () => {
  const { buildMultiHopSampleBank } = await import('../../../../scripts/lib/bmu-generators/emit-multi-hop-sample-bank.mjs');
  const a = buildMultiHopSampleBank();
  const b = buildMultiHopSampleBank();
  assert.deepEqual(JSON.parse(JSON.stringify(a.clusters)), JSON.parse(JSON.stringify(b.clusters)), 'bank is deterministic');
  assert.ok(a.clusters.length >= 22, `>= 22 clusters (got ${a.clusters.length})`);
  const rows = a.clusters.reduce((n, c) => n + c.rows.length, 0);
  assert.ok(rows >= 110, `>= 110 rows (got ${rows})`);
  assert.ok(new Set(a.clusters.map((c) => c.epoch)).size >= 3, '>= 3 synthetic epochs');
  assert.deepEqual(a.census, []);
  const hops = new Set(a.clusters.map((c) => c.hopCount));
  assert.ok(hops.has(2) && hops.has(3), 'both chain depths represented');
  assert.ok(a.clusters.some((c) => c.corefFramed), 'coreference-framed chains present');
  assert.ok(a.clusters.some((c) => c.hopCount === 3 && !c.corefFramed), 'plain (non-coref) 3-hop chains present');
});

// ── fail-closed behaviors ────────────────────────────────────────────────────

test('fail-closed: invalid args throw', () => {
  assert.throws(() => generateMultiHopClusters(baseOpts({ epoch: 1.5 })), /epoch/);
  assert.throws(() => generateMultiHopClusters(baseOpts({ seed: '' })), /seed/);
  assert.throws(() => generateMultiHopClusters(baseOpts({ splitOf: null })), /splitOf/);
  assert.throws(() => generateMultiHopClusters(baseOpts({ subjects: [] })), /subjects/);
  assert.throws(() => generateMultiHopClusters(baseOpts({ universe: '' })), /universe/);
  assert.throws(() => generateMultiHopClusters(baseOpts({ clusterCount: 0 })), /clusterCount/);
});
