/**
 * §18 fix-3 pack-density law.
 *
 * The 64-row pack prices one judged flip at 15,625 ppm against the 20,000 ppm
 * minImprovement floor, so a pack holding ONE row of an installed operation
 * class is arithmetically unacceptable regardless of ranking. The density law
 * makes each scored pack sample FEWER distinct classes with >=2-3 rows per
 * sampled class on BOTH the gate pack and the §6.3 excluded-confirm pack:
 *  - the class set per family block is SEED-INDEPENDENT (pure function of
 *    epochId + family cohort), so gate and confirm sample the SAME classes;
 *  - rows within a block are seed-drawn and lock to ONE motif cluster after
 *    the first draw, so the confirm side always keeps the I6-disjoint paired
 *    cluster of the class post-exclusion;
 *  - legacy cohorts without operationClass draw byte-identically to rev3.1
 *    (the overlay golden pins that separately).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BMU_MIN_IMPROVEMENT_PPM,
  bmuClassForBlock,
  BMU_PACK_CLASS_DENSITY,
  BMU_PACK_DENSITY_MARGIN_PPM,
  BMU_PACK_ROW_FLIP_PPM,
  bmuExclusionKeySetForPack,
  computeCorpusRoot,
  deriveScoredQueryPack,
} from '../../dist/index.js';

const GATE_SEED = '0x' + '31'.repeat(32);
const CONFIRM_SEED = '0x' + '57'.repeat(32);
const EPOCH = 137;

const FAMS = [
  { bmu: 'temporal', bucketed: 'temporal', logical: 'temporal_update' },
  { bmu: 'conflict_lifecycle', bucketed: 'conflict_lifecycle', logical: 'conflict_lifecycle' },
  { bmu: 'multi_hop_relation', bucketed: 'multi_hop_relation', logical: 'multi_session_bridge' },
  { bmu: 'near_collision_abstention', bucketed: 'near_collision', logical: 'abstention_missing' },
];
const CLASSES_PER_FAMILY = 4;
const CLUSTERS_PER_CLASS = 2; // adjacent I6-disjoint paired mints
const ROWS_PER_CLUSTER = 5;

function row({ id, fam, motif, subject, template, operationClass }) {
  return {
    id, family: fam.bucketed, domain: 'd', split: 'eval_hidden', queryText: `q ${id}`,
    truthDocuments: [{ id: `${id}-t`, text: 't', isCurrent: true }], hardNegatives: [],
    qrels: [{ documentId: `${id}-t`, relevance: 1 }], protected: false,
    logicalFamily: fam.logical, subjectEntityId: subject,
    bmuTask: {
      family: fam.bmu, budgetB: 3, requiredEvidence: [`${id}-t`], forbiddenEvidence: [],
      answer: { id: `${id}-t` }, motifGroupId: motif, templateId: template,
      entityHoldoutKeys: [`id:${subject}`, `alias:${subject}`],
      ...(operationClass ? { operationClass } : {}),
    },
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) },
  };
}

function makeCorpus() {
  const events = [];
  for (const fam of FAMS) {
    for (let i = 0; i < 40; i++) {
      events.push(row({
        id: `q_${fam.bmu}_${String(i).padStart(3, '0')}`, fam,
        motif: `mg_broad_${fam.bmu}_${i}`, subject: `ent_broad_${fam.bmu}_${i}`,
        template: `tt_broad_${fam.bmu}_${i}`,
      }));
    }
    for (let c = 0; c < CLASSES_PER_FAMILY; c++) {
      const operationClass = `${fam.bmu} era 1 class ${c}=>b4/outgoing:causes/incoming:supports/incoming:supports`;
      for (let k = 0; k < CLUSTERS_PER_CLASS; k++) {
        for (let r = 0; r < ROWS_PER_CLUSTER; r++) {
          events.push(row({
            id: `zz_e${String(EPOCH).padStart(12, '0')}_q_${fam.bmu}_c${c}_k${k}_r${r}`, fam,
            motif: `mg_${fam.bmu}_c${c}_k${k}`, subject: `ent_${fam.bmu}_c${c}_k${k}`,
            template: `tt_${fam.bmu}_c${c}_k${k}_r${r}`, operationClass,
          }));
        }
      }
    }
  }
  return {
    events, byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: 'm', biEncoderRevision: 'r', biEncoderRetrievalKeyLayout: { dim: 8, headerBytes: 9, quantization: 'int8' },
    labelingModelId: 'lm', labelingModelRevision: 'lr',
  };
}

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
  familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 3 },
  freshWindow: 2,
};

/** Judged density is a whole-pack quantity: every scored row of a class
 * counts toward its flip budget, wherever it entered the pack. */
function classRowsByFamily(pack) {
  const byFamily = new Map();
  for (const e of pack.events) {
    if (!e.id.startsWith('zz_e') || !e.bmuTask?.operationClass) continue;
    const perClass = byFamily.get(e.bmuTask.family) ?? new Map();
    const rows = perClass.get(e.bmuTask.operationClass) ?? [];
    rows.push(e);
    perClass.set(e.bmuTask.operationClass, rows);
    byFamily.set(e.bmuTask.family, perClass);
  }
  return byFamily;
}

function denseClasses(perClass) {
  return new Set([...(perClass ?? new Map())].filter(([, rows]) => rows.length >= 2).map(([cls]) => cls));
}

describe('§18 fix-3 pack-density law', () => {
  const corpus = makeCorpus();
  const activeIds = new Set(corpus.events.map((e) => e.id));
  const activeLiveEval = { activeIds, law: LAW };

  test('acceptance arithmetic: one row per class can never clear the floor; two rows clear it with the pinned margin', () => {
    assert.ok(1 * BMU_PACK_ROW_FLIP_PPM < BMU_MIN_IMPROVEMENT_PPM,
      'a single-flip class must be arithmetically unacceptable');
    assert.ok(2 * BMU_PACK_ROW_FLIP_PPM >= BMU_MIN_IMPROVEMENT_PPM + BMU_PACK_DENSITY_MARGIN_PPM,
      'the guaranteed two sparser-side rows must clear floor + margin');
    assert.ok(BMU_PACK_CLASS_DENSITY >= 2);
  });

  test('gate and excluded-confirm sample the SAME classes with >=2 rows each, on I6-disjoint clusters', () => {
    const gate = deriveScoredQueryPack(EPOCH, GATE_SEED, corpus, PROFILE, activeLiveEval, {});
    const excludeKeys = bmuExclusionKeySetForPack(gate);
    const confirm = deriveScoredQueryPack(EPOCH, CONFIRM_SEED, corpus, PROFILE, activeLiveEval, { excludeKeys });

    const gateByFamily = classRowsByFamily(gate);
    const confirmByFamily = classRowsByFamily(confirm);
    for (const fam of FAMS) {
      // The block class is a SEED-INDEPENDENT pure function of
      // (epoch, family cohort classes) — recomputed here exactly as the
      // overlay law computes it, so gate and confirm provably sample the
      // same class (a class patch must be able to clear BOTH packs).
      const cohortClasses = [...new Set(corpus.events
        .filter((e) => e.id.startsWith('zz_e') && e.bmuTask?.family === fam.bmu && e.bmuTask?.operationClass)
        .map((e) => e.bmuTask.operationClass))].sort();
      const blockClass = bmuClassForBlock(EPOCH, fam.bmu, 0, cohortClasses);
      assert.ok(blockClass, `${fam.bmu}: cohort exposes executable classes`);

      const gateRows = (gateByFamily.get(fam.bmu) ?? new Map()).get(blockClass) ?? [];
      const confirmRows = (confirmByFamily.get(fam.bmu) ?? new Map()).get(blockClass) ?? [];
      // Density on both sides: min(gate,confirm) rows x flip >= floor + margin.
      const sparser = Math.min(gateRows.length, confirmRows.length);
      assert.ok(sparser >= 2, `${fam.bmu}/${blockClass}: sparser side holds >=2 rows of the sampled class`);
      assert.ok(sparser * BMU_PACK_ROW_FLIP_PPM >= BMU_MIN_IMPROVEMENT_PPM + BMU_PACK_DENSITY_MARGIN_PPM,
        `${fam.bmu}/${blockClass}: density arithmetic clears the acceptance floor with margin`);

      // I6: confirm's rows of the sampled class are entirely disjoint from
      // gate's (motif/subject/template) — §6.3 exclusion guarantees it, the
      // motif lock guarantees a paired cluster remains available.
      const gateMotifs = new Set(gateRows.map((e) => e.bmuTask.motifGroupId));
      const confirmMotifs = new Set(confirmRows.map((e) => e.bmuTask.motifGroupId));
      assert.ok([...confirmMotifs].every((motif) => !gateMotifs.has(motif)),
        `${fam.bmu}: confirm transfers to disjoint cluster(s)`);
      const gateSubjects = new Set(gateRows.map((e) => e.subjectEntityId));
      const gateTemplates = new Set(gateRows.map((e) => e.bmuTask.templateId));
      assert.ok(confirmRows.every((e) => !gateSubjects.has(e.subjectEntityId)));
      assert.ok(confirmRows.every((e) => !gateTemplates.has(e.bmuTask.templateId)));
    }
  });

  test('density telemetry reports the sampled classes and the draw stays deterministic', () => {
    const first = deriveScoredQueryPack(EPOCH, GATE_SEED, corpus, PROFILE, activeLiveEval, {});
    const second = deriveScoredQueryPack(EPOCH, GATE_SEED, corpus, PROFILE, activeLiveEval, {});
    assert.deepEqual(first.events.map((e) => e.id), second.events.map((e) => e.id));
    // Different seed, same epoch/cohort: the sampled class set must not move.
    const other = deriveScoredQueryPack(EPOCH, CONFIRM_SEED, corpus, PROFILE, activeLiveEval, {});
    // The sampled block class per family has >=2 rows regardless of seed.
    for (const fam of FAMS) {
      const cohortClasses = [...new Set(corpus.events
        .filter((e) => e.id.startsWith('zz_e') && e.bmuTask?.family === fam.bmu && e.bmuTask?.operationClass)
        .map((e) => e.bmuTask.operationClass))].sort();
      const blockClass = bmuClassForBlock(EPOCH, fam.bmu, 0, cohortClasses);
      for (const pack of [first, other]) {
        const rows = (classRowsByFamily(pack).get(fam.bmu) ?? new Map()).get(blockClass) ?? [];
        assert.ok(rows.length >= 2, `${fam.bmu}: block class dense under every seed`);
      }
    }
  });
});
