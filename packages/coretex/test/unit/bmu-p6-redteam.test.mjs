/**
 * P6 red-team controls for the BMU law.
 *
 * These are deterministic, CPU-only attack checks. They deliberately avoid a
 * new scorer abstraction: each attack is pinned either against the BMU utility
 * law, the gate/confirm exclusion law, or the P2 cross-family dedup scanner.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bmuEventExcluded,
  bmuExclusionKeySetForPack,
  computeBmuTaskUtility,
  computeCorpusRoot,
  deriveBmuDualPacks,
  packQuotaCoverage,
} from '../../dist/index.js';
import {
  crossFamilyDedup,
} from '../../../../scripts/lib/bmu-generators/cross-family-checks.mjs';

const FAMILIES = [
  { bmu: 'temporal', bucketed: 'temporal', logical: 'temporal_update' },
  { bmu: 'conflict_lifecycle', bucketed: 'conflict_lifecycle', logical: 'conflict_lifecycle' },
  { bmu: 'multi_hop_relation', bucketed: 'multi_hop_relation', logical: 'multi_session_bridge' },
  { bmu: 'near_collision_abstention', bucketed: 'near_collision', logical: 'abstention_missing' },
];

const PROFILE = {
  packSize: 64,
  quotas: [
    { stratum: 'family=temporal', minCount: 10 },
    { stratum: 'family=conflict_lifecycle', minCount: 15 },
    { stratum: 'family=multi_hop_relation', minCount: 15 },
    { stratum: 'family=near_collision', minCount: 10 },
  ],
};

const LAW = {
  limit: 12,
  familyPriority: ['temporal_update', 'conflict_lifecycle', 'multi_session_bridge', 'abstention_missing'],
  familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 3 },
  freshWindow: 2,
};

function task(overrides = {}) {
  return {
    family: 'temporal',
    budgetB: 3,
    requiredEvidence: ['doc-current'],
    forbiddenEvidence: ['doc-stale'],
    answer: { id: 'doc-current', value: 'BERGEN-YARD' },
    motifGroupId: 'mg-a',
    templateId: 'tt-a',
    ...overrides,
  };
}

function row({ id, fam, motif, subject, template, queryText = `q ${id}` }) {
  const truthId = `${id}-truth`;
  return {
    id,
    family: fam.bucketed,
    logicalFamily: fam.logical,
    domain: 'p6',
    split: 'eval_hidden',
    queryText,
    truthDocuments: [{ id: truthId, text: `truth ${id}`, isCurrent: true }],
    hardNegatives: [{ id: `${id}-trap`, text: `trap ${id}` }],
    qrels: [{ documentId: truthId, relevance: 1 }, { documentId: `${id}-trap`, relevance: 0 }],
    protected: false,
    subjectEntityId: subject,
    bmuTask: {
      family: fam.bmu,
      budgetB: 3,
      requiredEvidence: [truthId],
      forbiddenEvidence: [`${id}-trap`],
      answer: { id: truthId },
      motifGroupId: motif,
      templateId: template,
    },
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '66'.repeat(32) },
  };
}

function makePackLawCorpus({ perFamily = 56 } = {}) {
  const events = [];
  for (const fam of FAMILIES) {
    for (let i = 0; i < perFamily; i++) {
      const fresh = i < 8;
      const id = fresh
        ? `zz_e000000000137_q_${fam.bmu}_${String(i).padStart(3, '0')}`
        : `q_${fam.bmu}_${String(i).padStart(3, '0')}`;
      events.push(row({
        id,
        fam,
        motif: `mg_${fam.bmu}_${i}`,
        subject: `subject_${fam.bmu}_${i}`,
        template: `template_${fam.bmu}_${i}`,
      }));
    }
  }
  return {
    events,
    byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot: computeCorpusRoot(events),
    corpusEpoch: 0,
    biEncoderModelId: 'bge-m3',
    biEncoderRevision: 'p6',
    biEncoderRetrievalKeyLayout: { dim: 8, headerBytes: 9, quantization: 'int8' },
    labelingModelId: 'offline',
    labelingModelRevision: 'p6',
  };
}

describe('P6 utility-law attacks', () => {
  test('answer-string leakage is not evidence: answer.value in a decoy doc id earns zero', () => {
    const out = computeBmuTaskUtility({
      task: task(),
      topB: ['doc-says-BERGEN-YARD', 'doc-unrelated', 'doc-other'],
      abstainSignal: false,
    });
    assert.equal(out.utility, 0);
    assert.equal(out.failure, 'missing_required');
  });

  test('stale/current inversion is a hard forbidden-evidence veto', () => {
    const out = computeBmuTaskUtility({
      task: task(),
      topB: ['doc-current', 'doc-stale', 'doc-support'],
      abstainSignal: false,
    });
    assert.equal(out.utility, 0);
    assert.equal(out.failure, 'forbidden_admitted');
  });

  test('relation-cycle bridge docs cannot substitute for required answer evidence', () => {
    const out = computeBmuTaskUtility({
      task: task({
        family: 'multi_hop_relation',
        budgetB: 4,
        requiredEvidence: ['doc-bridge', 'doc-answer'],
        forbiddenEvidence: ['doc-cycle-trap'],
        answer: { id: 'doc-answer', value: 'final answer text' },
      }),
      topB: ['doc-bridge', 'doc-cycle-a', 'doc-cycle-b', 'doc-cycle-a'],
      abstainSignal: false,
    });
    assert.equal(out.utility, 0);
    assert.equal(out.failure, 'missing_required');
  });

  test('budget spam loses even when the answer doc is present', () => {
    const out = computeBmuTaskUtility({
      task: task(),
      topB: ['doc-current', 'doc-stale', 'doc-spam'],
      abstainSignal: false,
    });
    assert.equal(out.utility, 0);
    assert.equal(out.failure, 'forbidden_admitted');
  });

  test('trivial first-K/random-K mimicry across a pack has zero utility without required evidence', () => {
    const events = Array.from({ length: 16 }, (_, i) => row({
      id: `trivial_${i}`,
      fam: FAMILIES[i % FAMILIES.length],
      motif: `mg_trivial_${i}`,
      subject: `subject_trivial_${i}`,
      template: `template_trivial_${i}`,
    }));
    const results = events.map((e) => computeBmuTaskUtility({
      task: e.bmuTask,
      topB: [`${e.id}-filler-a`, `${e.id}-filler-b`, `${e.id}-trap`],
      abstainSignal: false,
    }));
    assert.equal(results.every((r) => r.utility === 0), true);
    assert.ok(results.some((r) => r.failure === 'forbidden_admitted'));
  });

  test('exact-doc anchoring does not transfer to held-out rows in any family', () => {
    for (const fam of FAMILIES) {
      const gate = row({
        id: `gate_exact_${fam.bmu}`,
        fam,
        motif: `mg_gate_${fam.bmu}`,
        subject: `subject_gate_${fam.bmu}`,
        template: `template_gate_${fam.bmu}`,
      });
      const confirm = row({
        id: `confirm_exact_${fam.bmu}`,
        fam,
        motif: `mg_confirm_${fam.bmu}`,
        subject: `subject_confirm_${fam.bmu}`,
        template: `template_confirm_${fam.bmu}`,
      });
      const gateDocIds = gate.bmuTask.requiredEvidence;
      const gateHit = computeBmuTaskUtility({ task: gate.bmuTask, topB: [...gateDocIds, `${gate.id}-filler`, `${gate.id}-other`], abstainSignal: false });
      const confirmWithGateDocs = computeBmuTaskUtility({ task: confirm.bmuTask, topB: [...gateDocIds, `${gate.id}-filler`, `${gate.id}-other`], abstainSignal: false });
      assert.equal(gateHit.utility, 1, fam.bmu);
      assert.equal(confirmWithGateDocs.utility, 0, fam.bmu);
      assert.equal(confirmWithGateDocs.failure, 'missing_required', fam.bmu);
    }
  });

  test('public-example memorizer fails held-out motifs because public docs are not required evidence', () => {
    const hidden = task({
      family: 'conflict_lifecycle',
      budgetB: 4,
      requiredEvidence: ['hidden-current-note', 'hidden-resolution-note'],
      forbiddenEvidence: ['public-example-note', 'hidden-stale-note'],
      answer: { id: 'hidden-current-note', value: 'CERULEAN' },
      motifGroupId: 'mg-heldout-public-memorizer',
      templateId: 'tt-heldout-public-memorizer',
    });
    const publicOnlyTopB = ['public-example-note', 'public-example-copy', 'public-decoy-a', 'public-decoy-b'];
    const out = computeBmuTaskUtility({ task: hidden, topB: publicOnlyTopB, abstainSignal: false });
    assert.equal(out.utility, 0);
    assert.equal(out.failure, 'forbidden_admitted');
    const publicWithoutTrap = computeBmuTaskUtility({
      task: hidden,
      topB: ['public-example-copy', 'public-decoy-a', 'public-decoy-b', 'public-decoy-c'],
      abstainSignal: false,
    });
    assert.equal(publicWithoutTrap.utility, 0);
    assert.equal(publicWithoutTrap.failure, 'missing_required');
  });
});

describe('P6 held-out and dedup attacks', () => {
  test('cross-family entity/template/motif leakage is excluded from confirm', () => {
    const gate = row({
      id: 'gate_temporal',
      fam: FAMILIES[0],
      motif: 'mg-shared',
      subject: 'subject-shared',
      template: 'template-shared',
    });
    const keys = bmuExclusionKeySetForPack({ events: [gate] });
    const leaky = [
      row({ id: 'leak_subject', fam: FAMILIES[1], motif: 'mg-other-a', subject: 'subject-shared', template: 'template-other-a' }),
      row({ id: 'leak_template', fam: FAMILIES[2], motif: 'mg-other-b', subject: 'subject-other-b', template: 'template-shared' }),
      row({ id: 'leak_motif', fam: FAMILIES[3], motif: 'mg-shared', subject: 'subject-other-c', template: 'template-other-c' }),
    ];
    for (const e of leaky) assert.equal(bmuEventExcluded(e, keys), true, e.id);
    const clean = row({ id: 'clean', fam: FAMILIES[1], motif: 'mg-clean', subject: 'subject-clean', template: 'template-clean' });
    assert.equal(bmuEventExcluded(clean, keys), false);
  });

  test('seed overfitting cannot make confirm reuse gate rows or held-out keys', () => {
    const corpus = makePackLawCorpus();
    const activeLiveEval = { activeIds: new Set(corpus.events.map((e) => e.id)), law: LAW };
    for (const [gateByte, confirmByte] of [['11', '22'], ['33', '44'], ['55', '66'], ['77', '88'], ['99', 'aa'], ['bb', 'cc'], ['dd', 'ee'], ['f0', '0f']]) {
      const dual = deriveBmuDualPacks({
        epochId: 137,
        gateSeedHex: `0x${gateByte.repeat(32)}`,
        confirmSeedHex: `0x${confirmByte.repeat(32)}`,
        corpus,
        profile: PROFILE,
        activeLiveEval,
      });
      const gateIds = new Set(dual.gate.events.map((e) => e.id));
      for (const e of dual.confirm.events) {
        assert.equal(gateIds.has(e.id), false, `confirm reused gate row ${e.id}`);
        assert.equal(bmuEventExcluded(e, dual.exclusionKeys), false, `confirm leaked gate key ${e.id}`);
      }
      for (const pack of [dual.gate, dual.confirm]) {
        assert.equal(pack.events.length, 64);
        for (const cov of packQuotaCoverage(pack, PROFILE)) assert.equal(cov.satisfied, true, cov.stratum);
      }
    }
  });

  test('public-example memorization collisions are caught by the cross-family scanner', () => {
    const families = {
      temporal: {
        rows: [{
          id: 'row_t',
          queryText: 'What standing value should the agent use?',
          subjectEntityId: 'subject-public',
          publicIntent: { atom: 'intent', subjectEntityId: 'subject-public', attribute: 'routing_code' },
        }],
        docs: [{ id: 'doc_t', text: 'Public example: use CERULEAN for the routing code.' }],
        clusters: [],
      },
      conflict_lifecycle: {
        rows: [{
          id: 'row_c',
          queryText: 'What standing value should the agent use?',
          subjectEntityId: 'subject-public',
          publicIntent: { atom: 'intent', subjectEntityId: 'subject-public', attribute: 'routing_code' },
        }],
        docs: [{ id: 'doc_c', text: 'Public example: use CERULEAN for the routing code.' }],
        clusters: [],
      },
      multi_hop_relation: { rows: [], docs: [], clusters: [] },
      near_collision_abstention: { rows: [], docs: [], clusters: [] },
    };
    const out = crossFamilyDedup(families);
    assert.equal(out.clean, false);
    assert.ok(out.report.queryText.crossFamilyDuplicateKeys > 0);
    assert.ok(out.report.docText.crossFamilyDuplicateKeys > 0);
    assert.ok(out.report.publicIntentKey.crossFamilyDuplicateKeys > 0);
  });
});
