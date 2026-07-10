/**
 * BMU P2 — conflict_lifecycle generator gates (BMU_SPEC.md rev3.2 ad7e523):
 *   - determinism: same (epoch, seed, bank, registry) → byte-identical output;
 *   - GLOBAL m=1 census over multi-epoch generation (§4.1) + fail-closed
 *     collision behavior + rotation-waits-for-retirement;
 *   - template mint-partition law (§4.1 M7): same-family same-epoch clusters
 *     carry DISJOINT templateId sets; templateId ↔ surface form is 1:1;
 *   - forbidden-trap construction (§5.2/§6.5): candidate trap + ≥2
 *     scope-mismatch decoys in every row's forbiddenEvidence;
 *   - §4.1 schema completeness on every row (every field, all invariants the
 *     P3 corpus loader enforces, replicated here until branches merge);
 *   - rows land in eval_hidden under the CANONICAL splitForRecord over the
 *     production live-tail id (no partial clusters);
 *   - no-answer-leak lint: clean on minted rows, and the lint itself catches
 *     a deliberately leaky control row.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitForRecord, liveTailQueryId } from '../../dist/index.js';
import {
  buildConflictLifecycleClusterSpec,
  conflictDecoyCount,
  CONFLICT_FAMILY,
  CONFLICT_QUESTION_TYPES,
  CONFLICT_OPERATION_FAMILIES,
  conflictOperationFamilyForCluster,
  generateConflictLifecycleClusters,
} from '../../../../scripts/lib/bmu-generators/conflict_lifecycle.mjs';
import {
  BMU_CLUSTER_SIZE_K,
  BMU_DEFAULT_BUDGET_B,
  BMU_FAMILIES,
  BMU_TASK_MAX_BUDGET,
  createM1Registry,
  lintNoAnswerLeak,
  m1CensusOverRows,
  makeCanonicalSplitOf,
} from '../../../../scripts/lib/bmu-generators/common.mjs';

const CORPUS_EPOCH = 136;
const splitOf = makeCanonicalSplitOf({ splitForRecord, liveTailQueryId, corpusEpoch: CORPUS_EPOCH });

const bank = (n) => Array.from({ length: n }, (_, i) => ({
  id: `e_bmu_s${i}`,
  canonicalName: i % 3 === 2 ? `atlas-svc-${i}` : `Subject Persona${i}`,
}));

const gen = (over = {}) => generateConflictLifecycleClusters({
  epoch: 137, seed: 'bmu-p2-test', subjects: bank(40), registry: createM1Registry(),
  splitOf, clusterCount: 4, escalationLevel: 1, ...over,
});

describe('determinism', () => {
  test('same inputs → byte-identical output', () => {
    assert.equal(JSON.stringify(gen()), JSON.stringify(gen()));
  });
  test('different seed → different structure; different epoch → different ids', () => {
    const a = gen();
    const b = gen({ seed: 'bmu-p2-test-2' });
    assert.notEqual(JSON.stringify(a.addedDocs), JSON.stringify(b.addedDocs));
    const c = gen({ epoch: 138 });
    assert.ok(c.addedQueries.every((q) => q.id.startsWith('q_e138_')));
    assert.ok(a.addedQueries.every((q) => q.id.startsWith('q_e137_')));
  });
});

describe('v2 operation-general public path', () => {
  test('multiple deterministic operation classes are exposed as P5 strata', () => {
    const out = gen({ clusterCount: 6 });
    assert.deepEqual(new Set(out.clusters.map((c) => c.operationFamily)), new Set(CONFLICT_OPERATION_FAMILIES));
    for (const c of out.clusters) {
      assert.equal(c.operationFamily, conflictOperationFamilyForCluster(c.clusterSlot));
      assert.equal(c.operationClass, c.operationFamily);
      const rows = out.addedQueries.filter((q) => q.bmuTask.motifGroupId === c.motifGroupId);
      assert.ok(rows.every((q) => q.operationFamily === c.operationFamily && q.operationClass === c.operationFamily));
    }
    assert.deepEqual(Object.keys(out.telemetry.operationFamilyHistogram).sort(), [...CONFLICT_OPERATION_FAMILIES].sort());
  });

  test('balanced outgoing→incoming diamonds defeat structural/recency/metadata selectors', () => {
    const out = gen({ clusterCount: 4, escalationLevel: 2 });
    const docById = new Map(out.addedDocs.map((doc) => [doc.id, doc]));
    for (const c of out.clusters) {
      const p = c.publicPath;
      assert.equal(p.terminalBranchIds.length, 4);
      assert.equal(p.goldBranchIds.length, 2);
      assert.equal(p.decoyBranchIds.length, 2);
      assert.ok(out.addedRelations.some((r) => r.src === p.seedId && r.dst === p.pivotId && r.type === p.firstEdgeType));
      const observable = (id) => {
        const { id: _id, text: _text, ...metadata } = JSON.parse(JSON.stringify(docById.get(id)));
        const topology = out.addedRelations
          .filter((r) => r.src === id)
          .map((r) => ({ dstClass: r.dst === p.pivotId ? 'pivot' : r.dst === p.seedId ? 'seed' : 'other', type: r.type, label: r.label }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return JSON.stringify({ metadata, topology });
      };
      assert.equal(new Set(p.terminalBranchIds.map(observable)).size, 1);
      assert.equal(new Set(p.terminalBranchIds.map((id) => docById.get(id).text)).size, 4);
    }
  });

  test('public envelopes use neutral kinds and never serialize construction roles', () => {
    const serialized = JSON.parse(JSON.stringify(gen({ clusterCount: 2 }).addedDocs));
    assert.ok(serialized.every((doc) => doc.kind === 'bmu_public_record'));
    assert.ok(serialized.every((doc) => !Object.hasOwn(doc, 'role')));
  });
});

describe('GLOBAL m=1 (§4.1 multiplicity mint law)', () => {
  test('multi-epoch census clean with a shared registry', () => {
    const registry = createM1Registry();
    const subjects = bank(60);
    const rows = [];
    for (const epoch of [137, 138, 139]) {
      const out = generateConflictLifecycleClusters({
        epoch, seed: 'bmu-p2-census', subjects, registry, splitOf, clusterCount: 6, escalationLevel: 0,
      });
      rows.push(...out.addedQueries);
    }
    assert.equal(rows.length, 3 * 6 * BMU_CLUSTER_SIZE_K);
    assert.deepEqual(m1CensusOverRows(rows), []);
    // 18 clusters × distinct subjects — no subject reused while active.
    const subjectsUsed = new Set(rows.map((r) => r.subjectEntityId));
    assert.equal(subjectsUsed.size, 18);
  });

  test('subjects with an ACTIVE cluster are skipped (rotation waits for retirement)', () => {
    const registry = createM1Registry();
    const subjects = bank(10);
    // Pre-claim the first three subjects as active in ANOTHER family (global scope).
    for (const s of subjects.slice(0, 3)) {
      registry.claimCluster({ subjectEntityId: s.id, templateIds: [`tt_other_${s.id}`], motifGroupId: `mg_other_${s.id}` });
    }
    const out = generateConflictLifecycleClusters({
      epoch: 137, seed: 'bmu-p2-skip', subjects, registry, splitOf, clusterCount: 2, escalationLevel: 0,
    });
    const used = new Set(out.clusters.map((c) => c.subjectEntityId));
    for (const s of subjects.slice(0, 3)) assert.ok(!used.has(s.id), `pre-claimed ${s.id} must be skipped`);
    // ...and released subjects become mintable again (retirement hook).
    registry.releaseCluster({ subjectEntityId: subjects[0].id, templateIds: [`tt_other_${subjects[0].id}`] });
    const out2 = generateConflictLifecycleClusters({
      epoch: 138, seed: 'bmu-p2-skip', subjects, registry, splitOf, clusterCount: 1, escalationLevel: 0,
    });
    assert.equal(out2.clusters[0].subjectEntityId, subjects[0].id);
  });

  test('distinct subject ids sharing a canonical alias cannot occupy two active clusters', () => {
    const subjects = [
      { id: 'e_alias_a', canonicalName: 'Shared Name', aliases: ['S. Name'] },
      { id: 'e_alias_b', canonicalName: 'Shared Name', aliases: ['Other Alias'] },
      { id: 'e_alias_c', canonicalName: 'Clean Name', aliases: ['Clean Alias'] },
    ];
    const out = generateConflictLifecycleClusters({
      epoch: 137, seed: 'bmu-alias-m1', subjects, registry: createM1Registry(),
      splitOf, clusterCount: 2, escalationLevel: 0,
    });
    assert.deepEqual(out.clusters.map((c) => c.subjectEntityId), ['e_alias_a', 'e_alias_c']);
    assert.ok(out.addedQueries.every((q) => q.bmuTask.entityHoldoutKeys.includes(`id:${q.subjectEntityId}`)));
  });

  test('fail-closed: bank exhaustion under m=1 throws (no partial mint)', () => {
    const registry = createM1Registry();
    assert.throws(
      () => generateConflictLifecycleClusters({
        epoch: 137, seed: 'bmu-p2-exhaust', subjects: bank(3), registry, splitOf, clusterCount: 5, escalationLevel: 0,
      }),
      /subject bank exhausted under GLOBAL m=1/,
    );
  });

  test('fail-closed: registry template collision throws', () => {
    const registry = createM1Registry();
    const out = gen({ registry: createM1Registry() });
    const takenTemplate = out.addedQueries[0].bmuTask.templateId;
    registry.claimCluster({ subjectEntityId: 'e_elsewhere', templateIds: [takenTemplate], motifGroupId: 'mg_other' });
    assert.throws(
      () => generateConflictLifecycleClusters({
        epoch: 137, seed: 'bmu-p2-test', subjects: bank(40), registry, splitOf, clusterCount: 4, escalationLevel: 1,
      }),
      /m=1 violation: templateId/,
    );
  });
});

describe('template mint-partition law (§4.1 M7)', () => {
  test('same-epoch clusters carry DISJOINT templateId sets; k distinct per cluster', () => {
    const out = gen({ clusterCount: 8 });
    const seen = new Map();
    for (const c of out.clusters) {
      assert.equal(new Set(c.templateIds).size, BMU_CLUSTER_SIZE_K, 'k distinct templates per cluster');
      for (const t of c.templateIds) {
        assert.ok(!seen.has(t), `templateId ${t} reused across clusters ${seen.get(t)} and ${c.motifGroupId}`);
        seen.set(t, c.motifGroupId);
      }
    }
  });
  test('cross-epoch disjointness inside the active window (shared registry)', () => {
    const registry = createM1Registry();
    const subjects = bank(60);
    const all = new Set();
    for (const epoch of [137, 138, 139]) {
      const out = generateConflictLifecycleClusters({
        epoch, seed: 'bmu-p2-tpl', subjects, registry, splitOf, clusterCount: 6, escalationLevel: 0,
      });
      for (const c of out.clusters) for (const t of c.templateIds) {
        assert.ok(!all.has(t), `templateId ${t} reused across epochs`);
        all.add(t);
      }
    }
  });
  test('templateId ↔ surface form: rows share a templateId iff identical question skeleton instance', () => {
    // Two clusters, same question type/variant, different attr/scope → both
    // the templateId AND the surface form differ (attr+scope are baked into
    // the template, the documented design decision).
    const out = gen({ clusterCount: 2 });
    const rowsByType = (cluster, type, variant) => out.addedQueries.find((q) =>
      q.bmuTask.motifGroupId === cluster.motifGroupId && q.questionType === type
      && q.bmuTask.templateId.includes(`_v${variant}__`));
    const a = rowsByType(out.clusters[0], 'current_for_scope', 0);
    const b = rowsByType(out.clusters[1], 'current_for_scope', 0);
    assert.notEqual(a.bmuTask.templateId, b.bmuTask.templateId);
    assert.ok(a.bmuTask.templateId.includes(out.clusters[0].attribute.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase()));
    assert.notEqual(a.queryText, b.queryText);
  });
});

describe('forbidden-trap construction (§5.2, §6.5)', () => {
  test('every row forbids the candidate trap + >=2 scope-mismatch decoys', () => {
    for (const escalationLevel of [0, 2]) {
      const out = gen({ escalationLevel });
      const docById = new Map(out.addedDocs.map((d) => [d.id, d]));
      for (const q of out.addedQueries) {
        const t = q.bmuTask;
        assert.ok(t.forbiddenEvidence.length >= 3, 'trap + >=2 decoys');
        assert.equal(t.forbiddenEvidence.length, 1 + conflictDecoyCount(escalationLevel));
        assert.equal(docById.get(t.forbiddenEvidence[0]).lifecycleScope, q.publicIntent.lifecycleScope,
          'first forbidden is the same-scope candidate trap');
        assert.ok(t.forbiddenEvidence.slice(1).every((id) => docById.get(id).lifecycleScope === q.publicIntent.lifecycleScope),
          'public scope metadata is balanced; mismatch is discernible only from text');
        // Trap doc claims currency with exact-question vocabulary (the §2.2
        // "out-ranks honestly" screen — asserted via the lint in mint, spot-
        // checked here on text shape).
        const trapDoc = out.addedDocs.find((d) => d.id === t.forbiddenEvidence[0]);
        assert.match(trapDoc.text, /^What is .*current .*\?/);
        assert.equal('lifecycleState' in trapDoc, false, 'public docs must not expose answer/trap role metadata');
      }
    }
  });
  test('cluster relations carry the Stage 3-G1-CONFLICT cross-type shape', () => {
    const out = gen({ clusterCount: 3 });
    const docById = new Map(out.addedDocs.map((d) => [d.id, d]));
    for (const c of out.clusters) {
      const rels = out.addedRelations.filter((r) => c.docIds.includes(r.src));
      const contradicts = rels.find((r) => r.label === 'contradicts');
      const derived = rels.find((r) => r.type === 'derived_from' && r.label === 'resolution_of');
      assert.ok(contradicts && docById.has(contradicts.src) && docById.has(contradicts.dst), 'contradicts B→A');
      assert.equal(contradicts.type, 'co_occurs_with'); // ancestor encoding (evolve-corpus.mjs:446)
      assert.ok(derived && docById.has(derived.src) && derived.dst === contradicts.dst, 'derived_from R→A');
    }
  });
  test('distractor pressure at B=4: forbidden+required neighborhood exceeds the budget', () => {
    const out = gen({ escalationLevel: 0 });
    for (const q of out.addedQueries) {
      const t = q.bmuTask;
      assert.ok(t.requiredEvidence.length + t.forbiddenEvidence.length > t.budgetB,
        'cluster neighborhood must overflow top-B so admission is contested');
    }
  });
});

describe('§4.1 schema completeness (P3 load-validation invariants, replicated)', () => {
  test('every row carries a complete, internally consistent bmuTask', () => {
    const out = gen({ clusterCount: 6 });
    assert.equal(out.addedQueries.length, 6 * BMU_CLUSTER_SIZE_K);
    const docIds = new Set(out.addedDocs.map((d) => d.id));
    const rowsByMotif = new Map();
    for (const q of out.addedQueries) {
      const t = q.bmuTask;
      assert.ok(t.entityHoldoutKeys.includes(`id:${q.subjectEntityId}`));
      // family + namespaces (§5.6: logicalFamily conflict_lifecycle ↔ bucketed conflict_lifecycle)
      assert.ok(BMU_FAMILIES.includes(t.family));
      assert.equal(t.family, CONFLICT_FAMILY);
      assert.equal(q.family, 'conflict_lifecycle'); // logical family on the delta row
      // budget law
      assert.ok(Number.isInteger(t.budgetB) && t.budgetB >= 1 && t.budgetB <= BMU_TASK_MAX_BUDGET);
      assert.equal(t.budgetB, BMU_DEFAULT_BUDGET_B.conflict_lifecycle);
      // evidence sets
      assert.ok(t.requiredEvidence.length > 0 && t.requiredEvidence.length <= t.budgetB);
      assert.equal(new Set(t.requiredEvidence).size, t.requiredEvidence.length);
      for (const id of [...t.requiredEvidence, ...t.forbiddenEvidence]) {
        assert.ok(docIds.has(id), `evidence doc ${id} exists`);
      }
      assert.equal(t.requiredEvidence.filter((id) => t.forbiddenEvidence.includes(id)).length, 0);
      // answer
      assert.equal(t.abstain, false);
      assert.ok(t.answer && typeof t.answer.id === 'string' && t.requiredEvidence.includes(t.answer.id));
      assert.ok(typeof t.answer.value === 'string' && t.answer.value.length > 0);
      // partition keys
      assert.ok(typeof t.motifGroupId === 'string' && t.motifGroupId.length > 0);
      assert.ok(typeof t.templateId === 'string' && t.templateId.length > 0);
      // §4.3 mint-time consistency: required ⊆ {qrels ≥ 0.5}; forbidden ⊆ {qrels=0} ∪ hardNegatives
      const qrelOf = new Map(q.qrels.map((r) => [r.docId, r.relevance]));
      for (const id of t.requiredEvidence) assert.ok((qrelOf.get(id) ?? 0) >= 0.5, `required ${id} graded >= 0.5`);
      const negIds = new Set(q.hardNegatives.map((n) => n.docId));
      for (const id of t.forbiddenEvidence) {
        assert.ok(qrelOf.get(id) === 0.0 || negIds.has(id), `forbidden ${id} is zero-qrel or hard-negative`);
      }
      // graded-relevance grid
      for (const r of q.qrels) assert.ok([0.0, 0.2, 0.4, 0.6, 0.8, 1.0].includes(r.relevance));
      const rows = rowsByMotif.get(t.motifGroupId) ?? [];
      rows.push(q);
      rowsByMotif.set(t.motifGroupId, rows);
    }
    // k=5 per motifGroup, 4 distinct question types, motifGroup shared by
    // exactly its own cluster's rows
    for (const [, rows] of rowsByMotif) {
      assert.equal(rows.length, BMU_CLUSTER_SIZE_K);
      const types = new Set(rows.map((r) => r.questionType));
      assert.equal(types.size, CONFLICT_QUESTION_TYPES.length);
      for (const type of types) assert.ok(CONFLICT_QUESTION_TYPES.includes(type));
      assert.equal(new Set(rows.map((r) => r.subjectEntityId)).size, 1);
    }
  });

  test('rows land in eval_hidden under the canonical production-id split; docs and ids are cluster-scoped', () => {
    const out = gen({ clusterCount: 4 });
    for (const q of out.addedQueries) {
      assert.equal(splitForRecord(liveTailQueryId(q.id, q.liveUpdateEpoch), CORPUS_EPOCH), 'eval_hidden');
      assert.equal(q.liveUpdateEpoch, 137);
    }
    // no partial clusters, ever (fail-closed salt search)
    assert.equal(out.addedQueries.length % BMU_CLUSTER_SIZE_K, 0);
    for (const d of out.addedDocs) {
      assert.match(d.id, /^d_bmu_[0-9a-f]{64}$/);
      assert.doesNotMatch(d.id, /_(?:ca|cb|cr|dx\d+)$/);
    }
  });
});

describe('no-answer-leak lint', () => {
  test('minted rows are clean: answer value + gold-only vocabulary absent from questions', () => {
    const out = gen({ clusterCount: 8, escalationLevel: 2 });
    const docText = new Map(out.addedDocs.map((d) => [d.id, d.text]));
    for (const q of out.addedQueries) {
      const t = q.bmuTask;
      const answerValue = out.clusters.find((c) => c.motifGroupId === t.motifGroupId);
      const cluster = out.clusters.find((c) => c.motifGroupId === t.motifGroupId);
      const resolvedId = out.addedRelations.find((r) => r.label === 'contradicts' && cluster.docIds.includes(r.src))?.src;
      const resolvedDoc = docText.get(resolvedId);
      assert.ok(!q.queryText.includes(t.answer.id));
      const errors = lintNoAnswerLeak({
        rowId: q.id,
        queryText: q.queryText,
        answerValue: /is (\S+),? per|to (\S+) in/.exec(resolvedDoc)?.slice(1).find(Boolean),
        requiredDocTexts: t.requiredEvidence.map((id) => docText.get(id)),
        forbiddenDocTexts: t.forbiddenEvidence.map((id) => docText.get(id)),
        primaryTrapText: docText.get(t.forbiddenEvidence[0]),
        answerDocText: docText.get(t.answer.id),
      });
      assert.deepEqual(errors, [], `row ${q.id} leak-free`);
      assert.ok(answerValue);
    }
  });

  test('lint control: a deliberately leaky row FAILS each check', () => {
    // (1) answer value in question
    assert.ok(lintNoAnswerLeak({
      rowId: 'ctl', queryText: 'Is bergen-yard the current depot?', answerValue: 'bergen-yard',
      requiredDocTexts: [], forbiddenDocTexts: [],
    }).some((e) => /answer token/.test(e)));
    // (2) gold-only vocabulary in question
    assert.ok(lintNoAnswerLeak({
      rowId: 'ctl', queryText: 'Which reconciled value stands?', answerValue: undefined,
      requiredDocTexts: ['the claims were reconciled yesterday'], forbiddenDocTexts: ['the claim stands'],
    }).some((e) => /gold-only/.test(e)));
    // (3) gold lexically dominates the trap
    assert.ok(lintNoAnswerLeak({
      rowId: 'ctl', queryText: 'zeta gamma question', answerValue: undefined,
      requiredDocTexts: ['zeta gamma answer'], forbiddenDocTexts: ['unrelated trap'],
      primaryTrapText: 'unrelated trap', answerDocText: 'zeta gamma answer',
    }).some((e) => /trap lexical overlap/.test(e)));
  });

  test('mint-time lint is fail-closed: a leaking spec throws at build time', () => {
    // Force valA === valB → constructor refuses before any lint even runs…
    assert.throws(() => buildConflictLifecycleClusterSpec({
      canonical: 'X', subjectId: 'e_x', attr: 'rollout approver', scope: 'weekday care',
      decoyScopes: ['weekend care', 'home care'], valA: 'same-val', valB: 'same-val',
      decoyVals: ['d1', 'd2'], tsDate: '2027-06-01', priorDate: '2027-05-31',
      candidateId: 'd_ca', resolvedId: 'd_cb', resolutionId: 'd_cr', decoyIds: ['d_dx0', 'd_dx1'],
      motifGroupId: 'mg_x',
    }), /values must differ/);
    // …and fewer than 2 decoys violates the distractor-pressure floor.
    assert.throws(() => buildConflictLifecycleClusterSpec({
      canonical: 'X', subjectId: 'e_x', attr: 'rollout approver', scope: 'weekday care',
      decoyScopes: ['weekend care'], valA: 'val-a', valB: 'val-b',
      decoyVals: ['d1'], tsDate: '2027-06-01', priorDate: '2027-05-31',
      candidateId: 'd_ca', resolvedId: 'd_cb', resolutionId: 'd_cr', decoyIds: ['d_dx0'],
      motifGroupId: 'mg_x',
    }), />=2 scope-mismatch decoys/);
  });
});
