/**
 * P3-R2-C1 — PRODUCTION-PATH multi-slot overlay golden.
 *
 * The P3-R1 golden vectors verified test-local tuple assembly, and the
 * behavioral byte-law pin only covered slot 0 — so a `slotBE → u64BE(0)`
 * mutation inside the PRODUCTION `drawSlot` (module-private digestU256
 * assembly) survived the suite. This test closes that hole: a pinned
 * corpus/seed fixture through the REAL `deriveScoredQueryPack`, asserting
 * the exact ordered ids of ALL 12 overlay draws — and the full 64-row pack —
 * as LITERAL constants captured 2026-07-07 from the pinned byte law
 * (rev3.3 §6.4). Slots 1 and 2 of every family draw DIFFERENT probe
 * sequences than slot 0, so any change to the per-slot digest tuple (domain,
 * epochId, seed bytes, family name, SLOT INDEX, probe counter), the pool
 * ordering, or the skip-probe semantics moves at least one literal id.
 *
 * DO NOT regenerate these constants casually: a diff here means the §6.4
 * seeded-draw byte law changed — a replay break for every armed BMU epoch.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveQueryPack,
  deriveScoredQueryPack,
  computeCorpusRoot,
  evaluateBmuArmGate,
} from '../../dist/index.js';

const SEED = '0x' + '22'.repeat(32);
const EPOCH = 137;

const FAMS = [
  { bmu: 'temporal', bucketed: 'temporal', logical: 'temporal_update' },
  { bmu: 'conflict_lifecycle', bucketed: 'conflict_lifecycle', logical: 'conflict_lifecycle' },
  { bmu: 'multi_hop_relation', bucketed: 'multi_hop_relation', logical: 'multi_session_bridge' },
  { bmu: 'near_collision_abstention', bucketed: 'near_collision', logical: 'abstention_missing' },
];

function row({ id, fam, motif, subject, template }) {
  return {
    id, family: fam.bucketed, domain: 'd', split: 'eval_hidden', queryText: `q ${id}`,
    truthDocuments: [{ id: `${id}-t`, text: 't', isCurrent: true }], hardNegatives: [],
    qrels: [{ documentId: `${id}-t`, relevance: 1 }], protected: false,
    logicalFamily: fam.logical, subjectEntityId: subject,
    bmuTask: {
      family: fam.bmu, budgetB: 3, requiredEvidence: [`${id}-t`], forbiddenEvidence: [],
      answer: { id: `${id}-t` }, motifGroupId: motif, templateId: template,
      entityHoldoutKeys: [`id:${subject}`, `alias:${subject}`],
    },
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) },
  };
}

/** Pinned fixture: per family 40 broad rows + 6 stale live rows (mint 100)
 *  + 8 fresh live rows (mint 137). Every row is its own cluster. */
function makeCorpus() {
  const events = [];
  for (const fam of FAMS) {
    for (let i = 0; i < 40; i++) events.push(row({ id: `q_${fam.bmu}_${String(i).padStart(3, '0')}`, fam, motif: `mg_broad_${fam.bmu}_${i}`, subject: `ent_broad_${fam.bmu}_${i}`, template: `tt_broad_${fam.bmu}_${i}` }));
    for (let i = 0; i < 6; i++) events.push(row({ id: `zz_e${String(100).padStart(12, '0')}_q_${fam.bmu}_${i}`, fam, motif: `mg_stale_${fam.bmu}_${i}`, subject: `ent_stale_${fam.bmu}_${i}`, template: `tt_stale_${fam.bmu}_${i}` }));
    for (let i = 0; i < 8; i++) events.push(row({ id: `zz_e${String(EPOCH).padStart(12, '0')}_q_${fam.bmu}_${i}`, fam, motif: `mg_fresh_${fam.bmu}_${i}`, subject: `ent_fresh_${fam.bmu}_${i}`, template: `tt_fresh_${fam.bmu}_${i}` }));
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

// ─── GOLDEN (captured 2026-07-07, production deriveScoredQueryPack) ─────────
// Overlay rows in FINAL PACK ORDER (the quota-safe merge prepends draws, so
// this is the reversed family/slot draw order); 3 DISTINCT fresh rows per
// family — slots 0/1/2 each drew a different id, which is exactly what the
// slot-index mutation cannot reproduce.
const GOLDEN_OVERLAY_IDS = [
  'zz_e000000000137_q_near_collision_abstention_4',
  'zz_e000000000137_q_near_collision_abstention_6',
  'zz_e000000000137_q_near_collision_abstention_2',
  'zz_e000000000137_q_multi_hop_relation_3',
  'zz_e000000000137_q_multi_hop_relation_7',
  'zz_e000000000137_q_multi_hop_relation_5',
  'zz_e000000000137_q_conflict_lifecycle_0',
  'zz_e000000000137_q_conflict_lifecycle_1',
  'zz_e000000000137_q_conflict_lifecycle_3',
  'zz_e000000000137_q_temporal_7',
  'zz_e000000000137_q_temporal_2',
  'zz_e000000000137_q_temporal_5',
];

const GOLDEN_PACK_IDS = [
  ...GOLDEN_OVERLAY_IDS,
  'zz_e000000000100_q_temporal_3',
  'q_temporal_002', 'q_temporal_028', 'q_temporal_011',
  'zz_e000000000137_q_temporal_3',
  'q_temporal_030', 'q_temporal_033', 'q_temporal_021', 'q_temporal_018', 'q_temporal_025',
  'q_conflict_lifecycle_017', 'q_conflict_lifecycle_014',
  'zz_e000000000137_q_conflict_lifecycle_6',
  'q_conflict_lifecycle_039',
  'zz_e000000000137_q_conflict_lifecycle_7',
  'q_conflict_lifecycle_037', 'q_conflict_lifecycle_018', 'q_conflict_lifecycle_025', 'q_conflict_lifecycle_032',
  'zz_e000000000100_q_conflict_lifecycle_2',
  'q_conflict_lifecycle_009', 'q_conflict_lifecycle_013', 'q_conflict_lifecycle_024', 'q_conflict_lifecycle_033', 'q_conflict_lifecycle_000',
  'q_multi_hop_relation_027', 'q_multi_hop_relation_011', 'q_multi_hop_relation_012', 'q_multi_hop_relation_024',
  'q_multi_hop_relation_006', 'q_multi_hop_relation_005', 'q_multi_hop_relation_009', 'q_multi_hop_relation_030',
  'q_multi_hop_relation_003', 'q_multi_hop_relation_015', 'q_multi_hop_relation_017',
  'zz_e000000000137_q_multi_hop_relation_1',
  'q_multi_hop_relation_018', 'q_multi_hop_relation_013',
  'zz_e000000000100_q_multi_hop_relation_3',
  'zz_e000000000137_q_near_collision_abstention_3',
  'zz_e000000000137_q_near_collision_abstention_5',
  'q_near_collision_abstention_017',
  'zz_e000000000100_q_near_collision_abstention_1',
  'q_near_collision_abstention_029', 'q_near_collision_abstention_000', 'q_near_collision_abstention_021',
  'zz_e000000000137_q_near_collision_abstention_1',
  'zz_e000000000100_q_near_collision_abstention_2',
  'q_near_collision_abstention_038',
  'zz_e000000000100_q_conflict_lifecycle_1',
  'zz_e000000000100_q_near_collision_abstention_3',
];

describe('P3-R2-C1: production-path multi-slot overlay golden', () => {
  const corpus = makeCorpus();
  const activeIds = new Set(corpus.events.map((e) => e.id));
  const activeLiveEval = { activeIds, law: LAW };

  test('all 12 overlay draws land on the pinned ids, in pinned order (kills the slot-index mutant)', () => {
    const base = deriveQueryPack(EPOCH, SEED, corpus, PROFILE, { activeIds });
    const baseIds = new Set(base.events.map((e) => e.id));
    const pack = deriveScoredQueryPack(EPOCH, SEED, corpus, PROFILE, activeLiveEval, {});
    const overlayIds = pack.events.filter((e) => !baseIds.has(e.id)).map((e) => e.id);
    assert.deepEqual(overlayIds, GOLDEN_OVERLAY_IDS);
    // Sanity the golden itself encodes multi-slot coverage: 3 DISTINCT fresh
    // ids per family (a slot-index-collapsing mutant walks ONE probe
    // sequence and cannot reproduce independent per-slot draws).
    for (const fam of FAMS) {
      const famIds = GOLDEN_OVERLAY_IDS.filter((id) => id.includes(`_q_${fam.bmu}_`));
      assert.equal(new Set(famIds).size, 3, fam.bmu);
    }
  });

  test('the FULL 64-row production pack is byte-identical to the golden', () => {
    const pack = deriveScoredQueryPack(EPOCH, SEED, corpus, PROFILE, activeLiveEval, {});
    assert.deepEqual(pack.events.map((e) => e.id), GOLDEN_PACK_IDS);
  });
});

describe('P3-R2 hardening: evaluateBmuArmGate posture runtime validation', () => {
  test("omitting or mistyping posture throws — never silent boot semantics", () => {
    const corpus = makeCorpus();
    const poolIds = new Set(corpus.events.map((e) => e.id));
    assert.throws(() => evaluateBmuArmGate({ corpus, poolIds, epochId: EPOCH }), /posture must be 'arm' or 'boot'/);
    assert.throws(() => evaluateBmuArmGate({ corpus, poolIds, epochId: EPOCH, posture: 'launch' }), /posture must be 'arm' or 'boot'/);
    assert.doesNotThrow(() => evaluateBmuArmGate({ corpus, poolIds, epochId: EPOCH, posture: 'boot' }));
  });
});
