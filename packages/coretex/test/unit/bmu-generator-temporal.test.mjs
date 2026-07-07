/**
 * BMU P2 — family "temporal" offline generator unit suite.
 * Frozen spec: specs/BMU_SPEC.md rev3.2 (ad7e523) §4.1, §4.2, §5.1, §6.3.
 *
 * Covers: determinism; GLOBAL m=1 census over multi-epoch generation with
 * retirement; per-(family, epoch) template partition + the "same templateId
 * iff same surface form" law; forbidden-trap presence + structure; §4.1
 * schema completeness (mirrors the load-time validation rules); no-answer-
 * leak lint; canonical eval_hidden split landing; fail-closed behaviors.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { splitForRecord } from '../../dist/eval/retrieval-corpus.js';
import { liveTailQueryId } from '../../dist/corpus/logical-delta-bridge.js';
import {
  generateTemporalClusters,
  TEMPORAL_TEMPLATE_BANK,
  TEMPORAL_ROW_SLOTS,
  BMU_TEMPORAL_BUDGET_B,
  BMU_TEMPORAL_CLUSTER_K,
  renderTemplate,
} from '../../../../scripts/lib/bmu-generators/temporal.mjs';
import {
  createBmuActiveIndex,
  retireAgedClusters,
  m1Census,
  containsValue,
  sharedSkeletonNgrams,
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
      ? { id: `subj_prj_${i}`, canonicalName: `harbor-svc-lane${i}` }
      : { id: `subj_usr_${i}`, canonicalName: `Test Person ${i}` });
  }
  return subjects;
}

const baseOpts = (over = {}) => ({
  epoch: 150,
  seed: 'bmu-p2-temporal-test-v1',
  subjects: subjectBank(),
  universe: 'user_scope_bmu_test',
  clusterCount: 3,
  splitOf: canonicalSplitOf,
  ...over,
});

// ── determinism ──────────────────────────────────────────────────────────────

test('determinism: identical inputs → byte-identical output', () => {
  const a = generateTemporalClusters(baseOpts());
  const b = generateTemporalClusters(baseOpts());
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
});

test('determinism: seed and epoch move the draw', () => {
  const a = generateTemporalClusters(baseOpts());
  const b = generateTemporalClusters(baseOpts({ seed: 'bmu-p2-temporal-test-v2' }));
  const c = generateTemporalClusters(baseOpts({ epoch: 151 }));
  // a subject-start offset MAY coincide across seeds (40-wide bank), but the
  // full draw (values, templates, ids) must not
  assert.notDeepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert.notEqual(a.clusters[0].rows[0].id, c.clusters[0].rows[0].id);
});

test('determinism: activeIndex state participates (same seed, occupied subject → different pick)', () => {
  const a = generateTemporalClusters(baseOpts({ clusterCount: 1 }));
  const occupied = createBmuActiveIndex();
  occupied.subjects.set(a.clusters[0].subjectEntityId, 'mg_other_family_cluster');
  const b = generateTemporalClusters(baseOpts({ clusterCount: 1, activeIndex: occupied }));
  assert.notEqual(b.clusters[0].subjectEntityId, a.clusters[0].subjectEntityId);
});

// ── schema completeness (§4.1) ───────────────────────────────────────────────

test('every row carries a complete, self-consistent §4.1 bmuTask stamp', () => {
  const { clusters } = generateTemporalClusters(baseOpts());
  for (const cluster of clusters) {
    assert.equal(cluster.rows.length, BMU_TEMPORAL_CLUSTER_K, 'cluster size k=5 is law');
    const docIds = new Set(cluster.docs.map((d) => d.id));
    for (const row of cluster.rows) {
      const t = row.bmuTask;
      // required fields
      assert.equal(t.family, 'temporal');
      assert.ok(Number.isInteger(t.budgetB) && t.budgetB >= 1 && t.budgetB <= 8);
      assert.equal(t.budgetB, BMU_TEMPORAL_BUDGET_B);
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
      // motifGroupId shared by every row of the cluster
      assert.equal(t.motifGroupId, cluster.motifGroupId);
      // §5.6 namespace pair on the row
      assert.equal(row.family, 'temporal_update');
      assert.equal(row.subjectEntityId, cluster.subjectEntityId);
      assert.equal(row.liveUpdateEpoch, cluster.epoch);
    }
    // motifGroupId owned by no other cluster
    const others = clusters.filter((c) => c !== cluster);
    for (const o of others) assert.notEqual(o.motifGroupId, cluster.motifGroupId);
    // temporal docs carry validity (§4.3)
    for (const d of cluster.docs) {
      assert.ok(d.validity && d.validity.subjectEntityId === cluster.subjectEntityId);
      assert.equal(d.validity.attribute, cluster.attribute);
    }
  }
});

test('mint-time consistency rule (§4.3): required ⊆ qrels≥0.5, forbidden ⊆ qrels=0 ∪ hardNegatives', () => {
  const { clusters } = generateTemporalClusters(baseOpts());
  for (const cluster of clusters) {
    for (const row of cluster.rows) {
      const relOf = new Map(row.qrels.map((r) => [r.docId, r.relevance]));
      const negs = new Set(row.hardNegatives.map((n) => n.docId));
      for (const req of row.bmuTask.requiredEvidence) assert.ok((relOf.get(req) ?? 0) >= 0.5);
      for (const f of row.bmuTask.forbiddenEvidence) assert.ok(relOf.get(f) === 0 || negs.has(f));
    }
  }
});

// ── forbidden-trap construction (§5.1 / §6.5 part 1) ─────────────────────────

test('trap presence: stale doc claims currency, is forbidden on every row, shadows escalate', () => {
  const { clusters } = generateTemporalClusters(baseOpts());
  for (const cluster of clusters) {
    const stale = cluster.docs.find((d) => d.role === 'stale_trap');
    assert.ok(stale, 'stale trap doc minted');
    // the trap claims currency with exact-question vocabulary (ancestor law)
    assert.ok(stale.text.includes(`current ${cluster.attribute}`));
    assert.ok(containsValue(stale.text, cluster.staleValue));
    assert.ok(stale.validity.supersededBy, 'trap validity records supersession');
    assert.equal(stale.currentStaleFlag, false);
    const shadows = cluster.docs.filter((d) => d.role === 'escalation_shadow');
    assert.equal(shadows.length, cluster.escalationLevel);
    for (const row of cluster.rows) {
      assert.ok(row.bmuTask.forbiddenEvidence.includes(stale.id), 'stale doc IS the forbidden evidence');
      for (const s of shadows) assert.ok(row.bmuTask.forbiddenEvidence.includes(s.id), 'shadows forbidden too');
      // trap present in qrels at relevance 0 (graded-negative substrate retained, §4.3)
      const trapRel = row.qrels.find((r) => r.docId === stale.id);
      assert.ok(trapRel && trapRel.relevance === 0);
    }
  }
});

// ── template partition (§4.1 mint law) ───────────────────────────────────────

test('template partition: same-epoch clusters carry disjoint templateId sets; same id ⟺ same skeleton', () => {
  const { clusters } = generateTemporalClusters(baseOpts({ clusterCount: 6 }));
  const seen = new Set();
  for (const cluster of clusters) {
    for (const t of cluster.templateIds) {
      assert.ok(!seen.has(t), `templateId ${t} reused across same-epoch clusters`);
      seen.add(t);
    }
    // within a cluster, the two current_value rows use DIFFERENT templates
    const cvIds = cluster.rows.filter((r) => r.questionType === 'current_value').map((r) => r.bmuTask.templateId);
    assert.equal(new Set(cvIds).size, cvIds.length);
  }
  // same templateId ⟺ same surface skeleton, across the whole bank definition
  for (const [qtype, bank] of Object.entries(TEMPORAL_TEMPLATE_BANK)) {
    const byId = new Map();
    for (const v of bank) {
      assert.ok(!byId.has(v.templateId), `duplicate templateId in ${qtype} bank`);
      byId.set(v.templateId, v.skeleton);
    }
  }
  // and rendered rows really came from their pinned skeleton
  for (const cluster of clusters) {
    for (const row of cluster.rows) {
      const bank = TEMPORAL_TEMPLATE_BANK[row.questionType];
      const variant = bank.find((v) => v.templateId === row.bmuTask.templateId);
      assert.ok(variant, 'templateId resolves in its bank');
      assert.equal(
        renderTemplate(variant.skeleton, {
          canonical: cluster.canonicalName, attr: cluster.attribute, staleVal: cluster.staleValue,
        }),
        row.queryText,
      );
    }
  }
});

test('row slots follow the ancestor k=5 layout (4 distinct question types)', () => {
  const { clusters } = generateTemporalClusters(baseOpts({ clusterCount: 2 }));
  for (const cluster of clusters) {
    assert.deepEqual(cluster.rows.map((r) => r.questionType), TEMPORAL_ROW_SLOTS);
    assert.equal(new Set(cluster.rows.map((r) => r.questionType)).size, 4);
  }
});

// ── GLOBAL m=1 census over multi-epoch generation ────────────────────────────

test('m=1 census: multi-epoch generation with aging never double-books a subject or template', () => {
  const index = createBmuActiveIndex();
  const subjects = subjectBank(24);
  const maxAge = 4;
  const perEpochClusters = [];
  for (let epoch = 150; epoch < 162; epoch++) {
    retireAgedClusters(index, epoch, maxAge);
    const { clusters } = generateTemporalClusters(baseOpts({
      epoch, subjects, clusterCount: 3, activeIndex: index,
    }));
    perEpochClusters.push(...clusters);
    assert.deepEqual(m1Census(index), [], `m=1 census violation at epoch ${epoch}`);
  }
  // positive check: rotation-waits-for-retirement — subjects DO come back
  // after their prior cluster leaves the active window
  const bySubject = new Map();
  for (const c of perEpochClusters) {
    const arr = bySubject.get(c.subjectEntityId) ?? [];
    arr.push(c.epoch);
    bySubject.set(c.subjectEntityId, arr);
  }
  const reused = [...bySubject.values()].filter((epochs) => epochs.length > 1);
  assert.ok(reused.length > 0, 'expected subject reuse after retirement (bank of 24, 3/epoch, maxAge 4)');
  for (const epochs of reused) {
    const sorted = [...epochs].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i] - sorted[i - 1] >= maxAge, `subject reminted after ${sorted[i] - sorted[i - 1]} epochs < maxAge ${maxAge}`);
    }
  }
  // motifGroupIds unique across the whole run
  const mgs = perEpochClusters.map((c) => c.motifGroupId);
  assert.equal(new Set(mgs).size, mgs.length);
});

test('m=1 fail-closed: all subjects active → generator refuses to mint', () => {
  const index = createBmuActiveIndex();
  const subjects = subjectBank(6);
  generateTemporalClusters(baseOpts({ epoch: 150, subjects, clusterCount: 6, activeIndex: index }));
  assert.throws(
    () => generateTemporalClusters(baseOpts({ epoch: 151, subjects, clusterCount: 1, activeIndex: index })),
    /subject bank exhausted/,
  );
});

// ── no-answer-leak lint ──────────────────────────────────────────────────────

test('answer-leak lint: answer value never in question text; no 4-gram skeleton overlap with gold docs', () => {
  const { clusters } = generateTemporalClusters(baseOpts({ clusterCount: 6 }));
  for (const cluster of clusters) {
    const slotValues = [
      cluster.canonicalName, cluster.attribute, cluster.currentValue,
      cluster.staleValue, ...cluster.decoyValues, cluster.subjectEntityId,
    ];
    const golds = cluster.docs.filter((d) => d.role === 'current' || d.role === 'change_provenance');
    const trap = cluster.docs.find((d) => d.role === 'stale_trap');
    for (const row of cluster.rows) {
      assert.ok(!containsValue(row.queryText, cluster.currentValue),
        `answer value '${cluster.currentValue}' leaked into '${row.queryText}'`);
      for (const g of golds) {
        assert.deepEqual(sharedSkeletonNgrams(row.queryText, g.text, slotValues, 4), [],
          `4-gram skeleton overlap between question and gold ${g.id}`);
      }
      // questions never hand over gold-only supersession vocabulary
      for (const gift of ['supersession', 'superseded', 'replaced', 'ledger records']) {
        assert.ok(!row.queryText.toLowerCase().includes(gift), `gold-only vocab '${gift}' in question`);
      }
      // no rendered question is a verbatim substring of any public doc
      for (const d of cluster.docs) {
        assert.ok(!d.text.toLowerCase().includes(row.queryText.toLowerCase()));
      }
      // subject grounding: the question names the subject and the attribute
      assert.ok(row.queryText.includes(cluster.canonicalName));
      assert.ok(row.queryText.includes(cluster.attribute));
      // trap lexical dominance substrate: verification/provenance questions
      // carry the stale value, which the TRAP claims as current
      if (row.questionType === 'stale_verification' || row.questionType === 'change_provenance') {
        assert.ok(containsValue(row.queryText, cluster.staleValue));
        assert.ok(containsValue(trap.text, cluster.staleValue));
      }
    }
  }
});

// ── canonical split landing ──────────────────────────────────────────────────

test('every emitted row id lands in eval_hidden under the canonical split composition', () => {
  const { clusters } = generateTemporalClusters(baseOpts({ clusterCount: 4 }));
  for (const cluster of clusters) {
    for (const row of cluster.rows) {
      assert.equal(canonicalSplitOf(row.id, row.liveUpdateEpoch), 'eval_hidden');
    }
  }
});

test('fail-closed: a splitOf that never yields eval_hidden throws (no partial clusters)', () => {
  assert.throws(
    () => generateTemporalClusters(baseOpts({ splitOf: () => 'train_visible' })),
    /no eval_hidden id found/,
  );
});

// ── attribute rotation inheritance ───────────────────────────────────────────

test('attribute rotation: same-epoch clusters alternate attributes; epochs move the attribute pair', () => {
  const a = generateTemporalClusters(baseOpts({ epoch: 150, clusterCount: 2 }));
  const b = generateTemporalClusters(baseOpts({ epoch: 151, clusterCount: 2 }));
  const attrsA = a.clusters.map((c) => c.attribute);
  const attrsB = b.clusters.map((c) => c.attribute);
  assert.notDeepEqual(attrsA, attrsB, 'attribute rotation advances with the epoch');
});
