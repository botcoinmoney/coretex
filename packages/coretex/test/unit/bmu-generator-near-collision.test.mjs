/**
 * BMU P2 — near_collision_abstention generator gates (BMU_SPEC.md rev3.2
 * ad7e523):
 *   - determinism: same (epoch, seed, bank, registry) → byte-identical output;
 *   - GLOBAL m=1 census over multi-epoch generation (§4.1) + fail-closed
 *     collision behavior + rotation-waits-for-retirement;
 *   - template mint-partition law (§4.1 M7): same-family same-epoch clusters
 *     carry DISJOINT templateId sets; templateId ↔ surface form is 1:1;
 *   - forbidden-trap construction (§5.4/§6.5): alias-collision primary trap +
 *     attribute/scope lookalikes in every row's forbiddenEvidence; the abstain
 *     row additionally forbids the answerable sibling E; the abstain scope is
 *     covered by NO doc (genuinely unanswerable);
 *   - answerable/abstain mix (§5.4/§2.2): 4:1 per cluster — answerable rows
 *     are the false-abstain counterweight;
 *   - §4.1 schema completeness on every row (every field, all invariants the
 *     P3 corpus loader enforces, replicated here until branches merge),
 *     including the abstain-row laws (requiredEvidence=[] ∧ answer absent);
 *   - rows land in eval_hidden under the CANONICAL splitForRecord over the
 *     production live-tail id (no partial clusters);
 *   - no-answer-leak lint: clean on minted rows, and the lint itself catches
 *     a deliberately leaky control row.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitForRecord, liveTailQueryId } from '../../dist/index.js';
import {
  buildNearCollisionClusterSpec,
  nearcolDecoyCount,
  NEARCOL_FAMILY,
  NEARCOL_LOGICAL_FAMILY_ABSTAIN,
  NEARCOL_LOGICAL_FAMILY_ANSWERABLE,
  NEARCOL_QUESTION_TYPES,
  generateNearCollisionAbstentionClusters,
} from '../../../../scripts/lib/bmu-generators/near_collision_abstention.mjs';
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
  id: `e_bmu_n${i}`,
  canonicalName: i % 3 === 2 ? `beacon-svc-${i}` : `Persona Vintra${i}`,
}));

const gen = (over = {}) => generateNearCollisionAbstentionClusters({
  epoch: 137, seed: 'bmu-p2-nearcol-test', subjects: bank(40), registry: createM1Registry(),
  splitOf, clusterCount: 4, escalationLevel: 1, ...over,
});

describe('determinism', () => {
  test('same inputs → byte-identical output', () => {
    assert.equal(JSON.stringify(gen()), JSON.stringify(gen()));
  });
  test('different seed → different structure; different epoch → different ids', () => {
    const a = gen();
    const b = gen({ seed: 'bmu-p2-nearcol-test-2' });
    assert.notEqual(JSON.stringify(a.addedDocs), JSON.stringify(b.addedDocs));
    const c = gen({ epoch: 138 });
    assert.ok(c.addedQueries.every((q) => q.id.startsWith('q_e138_')));
    assert.ok(a.addedQueries.every((q) => q.id.startsWith('q_e137_')));
  });
});

describe('GLOBAL m=1 (§4.1 multiplicity mint law)', () => {
  test('multi-epoch census clean with a shared registry', () => {
    const registry = createM1Registry();
    const subjects = bank(60);
    const rows = [];
    for (const epoch of [137, 138, 139]) {
      const out = generateNearCollisionAbstentionClusters({
        epoch, seed: 'bmu-p2-nearcol-census', subjects, registry, splitOf, clusterCount: 6, escalationLevel: 0,
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
    const out = generateNearCollisionAbstentionClusters({
      epoch: 137, seed: 'bmu-p2-nearcol-skip', subjects, registry, splitOf, clusterCount: 2, escalationLevel: 0,
    });
    const used = new Set(out.clusters.map((c) => c.subjectEntityId));
    for (const s of subjects.slice(0, 3)) assert.ok(!used.has(s.id), `pre-claimed ${s.id} must be skipped`);
    // ...and released subjects become mintable again (retirement hook).
    registry.releaseCluster({ subjectEntityId: subjects[0].id, templateIds: [`tt_other_${subjects[0].id}`] });
    const out2 = generateNearCollisionAbstentionClusters({
      epoch: 138, seed: 'bmu-p2-nearcol-skip', subjects, registry, splitOf, clusterCount: 1, escalationLevel: 0,
    });
    assert.equal(out2.clusters[0].subjectEntityId, subjects[0].id);
  });

  test('fail-closed: bank exhaustion under m=1 throws (no partial mint)', () => {
    const registry = createM1Registry();
    assert.throws(
      () => generateNearCollisionAbstentionClusters({
        epoch: 137, seed: 'bmu-p2-nearcol-exhaust', subjects: bank(3), registry, splitOf, clusterCount: 5, escalationLevel: 0,
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
      () => generateNearCollisionAbstentionClusters({
        epoch: 137, seed: 'bmu-p2-nearcol-test', subjects: bank(40), registry, splitOf, clusterCount: 4, escalationLevel: 1,
      }),
      /m=1 violation: templateId/,
    );
  });

  test('synthetic duplicate-entity ids are cluster-scoped, never bank subjects', () => {
    const out = gen({ clusterCount: 6, escalationLevel: 3 });
    const bankIds = new Set(bank(40).map((s) => s.id));
    for (const doc of out.addedDocs.filter((d) => d.collisionRole === 'alias_collision_decoy')) {
      const dupId = doc.entityIds[1];
      assert.match(dupId, /^e_e137_.*_dup\d+$/);
      assert.ok(!bankIds.has(dupId), 'duplicate entity must not be a bank subject');
    }
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
      const out = generateNearCollisionAbstentionClusters({
        epoch, seed: 'bmu-p2-nearcol-tpl', subjects, registry, splitOf, clusterCount: 6, escalationLevel: 0,
      });
      for (const c of out.clusters) for (const t of c.templateIds) {
        assert.ok(!all.has(t), `templateId ${t} reused across epochs`);
        all.add(t);
      }
    }
  });
  test('templateId ↔ surface form: attr+scope baked in; abstain template bakes the ABSENT scope', () => {
    const out = gen({ clusterCount: 2 });
    const rowOf = (cluster, type) => out.addedQueries.find((q) =>
      q.bmuTask.motifGroupId === cluster.motifGroupId && q.questionType === type);
    const a = rowOf(out.clusters[0], 'exact_variant_lookup');
    const b = rowOf(out.clusters[1], 'exact_variant_lookup');
    assert.notEqual(a.bmuTask.templateId, b.bmuTask.templateId);
    assert.notEqual(a.queryText, b.queryText);
    const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    assert.ok(a.bmuTask.templateId.includes(slugify(out.clusters[0].attribute)));
    // Abstain row's surface form uses absentScope — its template must too (1:1 law).
    const abst = rowOf(out.clusters[0], 'missing_variant_abstain');
    assert.ok(abst.bmuTask.templateId.endsWith(`__${slugify(out.clusters[0].absentScope)}`));
    assert.ok(abst.queryText.includes(out.clusters[0].absentScope));
  });
});

describe('forbidden-trap construction (§5.4, §6.5) + answerable/abstain mix', () => {
  test('answerable rows forbid the full sibling decoy set (alias trap first); abstain rows also forbid E', () => {
    for (const escalationLevel of [0, 2]) {
      const out = gen({ escalationLevel });
      for (const q of out.addedQueries) {
        const t = q.bmuTask;
        if (t.abstain) {
          assert.equal(t.forbiddenEvidence.length, 1 + nearcolDecoyCount(escalationLevel));
          assert.ok(t.forbiddenEvidence[0].endsWith('_ne'), 'abstain row forbids the answerable sibling E first');
          assert.ok(t.forbiddenEvidence[1].endsWith('_na0'), 'then the alias primary trap');
        } else {
          assert.equal(t.forbiddenEvidence.length, nearcolDecoyCount(escalationLevel));
          assert.ok(t.forbiddenEvidence.length >= 3, 'alias + attribute + scope lookalikes');
          assert.ok(t.forbiddenEvidence[0].endsWith('_na0'), 'first forbidden = alias-collision primary trap');
        }
        // The primary trap ECHOES the question skeleton and claims currency
        // (§2.2 "out-ranks honestly" — asserted via the lint at mint, spot-
        // checked here on text shape).
        const trapId = t.forbiddenEvidence.find((id) => id.endsWith('_na0'));
        const trapDoc = out.addedDocs.find((d) => d.id === trapId);
        assert.match(trapDoc.text, /^What .* did .* set for the .*\?/);
        assert.match(trapDoc.text, /remains the standing/);
        assert.equal(trapDoc.collisionRole, 'alias_collision_decoy');
      }
    }
  });
  test('4:1 answerable/abstain mix per cluster (§2.2 false-abstain counterweight)', () => {
    const out = gen({ clusterCount: 6 });
    for (const c of out.clusters) {
      assert.equal(c.answerableRowCount, 4);
      assert.equal(c.abstainRowCount, 1);
    }
    assert.equal(out.telemetry.abstainRowCount, 6);
    assert.equal(out.telemetry.answerableRowCount, 24);
  });
  test('the abstain scope is covered by NO doc in the cluster (genuinely unanswerable)', () => {
    const out = gen({ clusterCount: 8, escalationLevel: 4 });
    for (const c of out.clusters) {
      const clusterDocs = out.addedDocs.filter((d) => c.docIds.includes(d.id));
      for (const d of clusterDocs) {
        assert.notEqual(d.collisionScope, c.absentScope, `${d.id} must not cover the abstain scope`);
        assert.ok(!d.text.includes(c.absentScope), `${d.id} text must not mention the abstain scope`);
      }
      assert.notEqual(c.absentScope, c.scope);
    }
  });
  test('cluster relations: disambiguation record disambiguates E and flags the duplicate', () => {
    const out = gen({ clusterCount: 3 });
    for (const c of out.clusters) {
      const rels = out.addedRelations.filter((r) => c.docIds.includes(r.src));
      const derived = rels.find((r) => r.type === 'derived_from');
      const flags = rels.find((r) => r.label === 'disambiguates_duplicate');
      assert.ok(derived && derived.src.endsWith('_nd') && derived.dst.endsWith('_ne'), 'derived_from D→E');
      assert.equal(derived.label, 'disambiguates');
      assert.ok(flags && flags.src.endsWith('_nd') && flags.dst.endsWith('_na0'), 'co_occurs_with D→trap');
      assert.equal(flags.type, 'co_occurs_with'); // ancestor label encoding (evolve-corpus.mjs:446)
    }
  });
  test('distractor pressure at B=3: forbidden+required neighborhood exceeds the budget on EVERY row', () => {
    const out = gen({ escalationLevel: 0 });
    for (const q of out.addedQueries) {
      const t = q.bmuTask;
      assert.ok(t.requiredEvidence.length + t.forbiddenEvidence.length > t.budgetB,
        'cluster neighborhood must overflow top-B so admission is contested');
    }
  });
});

describe('§4.1 schema completeness (P3 load-validation invariants, replicated)', () => {
  test('every row carries a complete, internally consistent bmuTask (incl. abstain-row laws)', () => {
    const out = gen({ clusterCount: 6 });
    assert.equal(out.addedQueries.length, 6 * BMU_CLUSTER_SIZE_K);
    const docIds = new Set(out.addedDocs.map((d) => d.id));
    const rowsByMotif = new Map();
    for (const q of out.addedQueries) {
      const t = q.bmuTask;
      // family + namespaces (§5.6: logicalFamily ∈ {entity_resolution_atom,
      // abstention_missing} ↔ bucketed near_collision ↔ bmuTask.family)
      assert.ok(BMU_FAMILIES.includes(t.family));
      assert.equal(t.family, NEARCOL_FAMILY);
      assert.equal(q.family, t.abstain ? NEARCOL_LOGICAL_FAMILY_ABSTAIN : NEARCOL_LOGICAL_FAMILY_ANSWERABLE);
      // budget law
      assert.ok(Number.isInteger(t.budgetB) && t.budgetB >= 1 && t.budgetB <= BMU_TASK_MAX_BUDGET);
      assert.equal(t.budgetB, BMU_DEFAULT_BUDGET_B.near_collision_abstention);
      // evidence sets
      assert.equal(new Set(t.requiredEvidence).size, t.requiredEvidence.length);
      assert.ok(t.requiredEvidence.length <= t.budgetB);
      for (const id of [...t.requiredEvidence, ...t.forbiddenEvidence]) {
        assert.ok(docIds.has(id), `evidence doc ${id} exists`);
      }
      assert.equal(t.requiredEvidence.filter((id) => t.forbiddenEvidence.includes(id)).length, 0);
      // abstain vs answerable laws (§4.1)
      if (t.abstain) {
        assert.equal(q.abstain, true, 'logical row carries abstain:true for the corpus builder branch');
        assert.deepEqual(t.requiredEvidence, []);
        assert.ok(!('answer' in t), 'abstain ⇒ answer ABSENT');
        assert.deepEqual(q.qrels, []);
        // forbidden ⊆ hardNegatives (qrels are empty on the truthless branch)
        const negIds = new Set(q.hardNegatives.map((n) => n.docId));
        for (const id of t.forbiddenEvidence) assert.ok(negIds.has(id), `abstain forbidden ${id} is a hard negative`);
      } else {
        assert.equal(t.abstain, false);
        assert.ok(t.requiredEvidence.length > 0);
        assert.ok(t.answer && typeof t.answer.id === 'string' && t.requiredEvidence.includes(t.answer.id));
        assert.ok(typeof t.answer.value === 'string' && t.answer.value.length > 0);
        // §4.3 mint-time consistency: required ⊆ {qrels ≥ 0.5}; forbidden ⊆ {qrels=0} ∪ hardNegatives
        const qrelOf = new Map(q.qrels.map((r) => [r.docId, r.relevance]));
        for (const id of t.requiredEvidence) assert.ok((qrelOf.get(id) ?? 0) >= 0.5, `required ${id} graded >= 0.5`);
        const negIds = new Set(q.hardNegatives.map((n) => n.docId));
        for (const id of t.forbiddenEvidence) {
          assert.ok(qrelOf.get(id) === 0.0 || negIds.has(id), `forbidden ${id} is zero-qrel or hard-negative`);
        }
      }
      // partition keys
      assert.ok(typeof t.motifGroupId === 'string' && t.motifGroupId.length > 0);
      assert.ok(typeof t.templateId === 'string' && t.templateId.length > 0);
      // graded-relevance grid
      for (const r of q.qrels) assert.ok([0.0, 0.2, 0.4, 0.6, 0.8, 1.0].includes(r.relevance));
      const rows = rowsByMotif.get(t.motifGroupId) ?? [];
      rows.push(q);
      rowsByMotif.set(t.motifGroupId, rows);
    }
    // k=5 per motifGroup, 4 distinct question types, one subject per cluster
    for (const [, rows] of rowsByMotif) {
      assert.equal(rows.length, BMU_CLUSTER_SIZE_K);
      const types = new Set(rows.map((r) => r.questionType));
      assert.equal(types.size, NEARCOL_QUESTION_TYPES.length);
      for (const type of types) assert.ok(NEARCOL_QUESTION_TYPES.includes(type));
      assert.equal(new Set(rows.map((r) => r.subjectEntityId)).size, 1);
      assert.equal(rows.filter((r) => r.bmuTask.abstain).length, 1);
    }
  });

  test('rows land in eval_hidden under the canonical production-id split; no partial clusters', () => {
    const out = gen({ clusterCount: 4 });
    for (const q of out.addedQueries) {
      assert.equal(splitForRecord(liveTailQueryId(q.id, q.liveUpdateEpoch), CORPUS_EPOCH), 'eval_hidden');
      assert.equal(q.liveUpdateEpoch, 137);
    }
    assert.equal(out.addedQueries.length % BMU_CLUSTER_SIZE_K, 0);
  });
});

describe('no-answer-leak lint', () => {
  test('minted rows are clean: answer value + gold-only vocabulary absent from questions', () => {
    const out = gen({ clusterCount: 8, escalationLevel: 2 });
    const docText = new Map(out.addedDocs.map((d) => [d.id, d.text]));
    for (const q of out.addedQueries) {
      const t = q.bmuTask;
      const cluster = out.clusters.find((c) => c.motifGroupId === t.motifGroupId);
      const exactDoc = docText.get(cluster.docIds.find((id) => id.endsWith('_ne')));
      const exactValue = / to (\S+) in the registry/.exec(exactDoc)?.[1];
      assert.ok(exactValue, 'exact-match value recoverable from E');
      assert.ok(!q.queryText.includes(exactValue), 'the cluster secret never appears in any question');
      const errors = lintNoAnswerLeak({
        rowId: q.id,
        queryText: q.queryText,
        answerValue: exactValue,
        requiredDocTexts: t.requiredEvidence.map((id) => docText.get(id)),
        forbiddenDocTexts: t.forbiddenEvidence.map((id) => docText.get(id)),
        ...(t.abstain ? {} : {
          primaryTrapText: docText.get(t.forbiddenEvidence[0]),
          answerDocText: docText.get(t.answer.id),
        }),
      });
      assert.deepEqual(errors, [], `row ${q.id} leak-free`);
    }
  });

  test('lint control: a deliberately leaky row FAILS each check', () => {
    // (1) answer value in question
    assert.ok(lintNoAnswerLeak({
      rowId: 'ctl', queryText: 'Is relay-nova the intake channel?', answerValue: 'relay-nova',
      requiredDocTexts: [], forbiddenDocTexts: [],
    }).some((e) => /answer token/.test(e)));
    // (2) gold-only vocabulary in question
    assert.ok(lintNoAnswerLeak({
      rowId: 'ctl', queryText: 'Which disambiguated filing stands?', answerValue: undefined,
      requiredDocTexts: ['the filings were disambiguated yesterday'], forbiddenDocTexts: ['the filing stands'],
    }).some((e) => /gold-only/.test(e)));
    // (3) gold lexically dominates the trap
    assert.ok(lintNoAnswerLeak({
      rowId: 'ctl', queryText: 'zeta gamma question', answerValue: undefined,
      requiredDocTexts: ['zeta gamma answer'], forbiddenDocTexts: ['unrelated trap'],
      primaryTrapText: 'unrelated trap', answerDocText: 'zeta gamma answer',
    }).some((e) => /trap lexical overlap/.test(e)));
  });

  test('spec constructor is fail-closed on malformed collision neighborhoods', () => {
    const base = {
      canonical: 'X', subjectId: 'e_x', attr: 'intake channel', scope: 'morning desk',
      absentScope: 'evening desk', role: 'manifest steward', value: 'relay-kilo',
      tsDate: '2027-06-01', exactId: 'd_ne', disambigId: 'd_nd', motifGroupId: 'mg_x',
      decoys: [
        { kind: 'alias', id: 'd_na0', entityId: 'e_dup0', value: 'relay-nova', role: 'visiting clerk' },
        { kind: 'attribute', id: 'd_nt0', value: 'relay-orion', lookalikeAttr: 'provisional channel' },
        { kind: 'scope', id: 'd_ns0', value: 'relay-vega', scope: 'overnight desk' },
      ],
    };
    // decoy value colliding with the exact value
    assert.throws(() => buildNearCollisionClusterSpec({
      ...base, decoys: [{ ...base.decoys[0], value: 'relay-kilo' }, base.decoys[1], base.decoys[2]],
    }), /decoy values must differ/);
    // fewer than 3 decoys (missing collision axis)
    assert.throws(() => buildNearCollisionClusterSpec({
      ...base, decoys: base.decoys.slice(0, 2),
    }), />=3 sibling decoys/);
    // primary trap must be the alias collision
    assert.throws(() => buildNearCollisionClusterSpec({
      ...base, decoys: [base.decoys[1], base.decoys[0], base.decoys[2]],
    }), /decoys\[0\] must be the alias-collision primary trap/);
    // abstain scope answered by a scope-lookalike → not genuinely unanswerable
    assert.throws(() => buildNearCollisionClusterSpec({
      ...base, decoys: [base.decoys[0], base.decoys[1], { ...base.decoys[2], scope: 'evening desk' }],
    }), /absentScope must be covered by NO doc/);
    // abstain scope equal to the answered scope
    assert.throws(() => buildNearCollisionClusterSpec({
      ...base, absentScope: 'morning desk',
    }), /absentScope must be covered by NO doc/);
  });
});
