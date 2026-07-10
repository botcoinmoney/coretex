/**
 * BMU v1 law end-to-end (BMU_SPEC.md §2, §5.5, §13.2) through the REAL
 * two-stage retrieval pipeline (deterministic bi-encoder + injectable
 * reranker; blank r5 substrate):
 *   - evaluateBmuBenchmarkState: scalar = round(1e6·Σu/packSize) with the
 *     forbidden-trap veto live at the final ordering; ppm round-trip
 *     exactness; per-family U_f; blank state earns NO abstention utility
 *     (§5.5 — the atom-less fallback is excluded from u(t));
 *   - fail-closed: unstamped pack row / wrong pipelineVersion / atoms off;
 *   - evaluateBmuBenchmarkPatch floors (§2.4/§2.5): no-op → below threshold;
 *     2-flip improvement accepted at exactly the 20,250 threshold; protected
 *     zero-tolerance veto; per-family and total regression budgets;
 *   - evaluateBmuBaseline: BMU scalar + familyUtilitiesPpm on the baseline
 *     lane (§8.4).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateBmuBenchmarkState,
  evaluateBmuBenchmarkPatch,
  evaluateBmuBaseline,
  deriveQueryPack,
  computeCorpusRoot,
  createDeterministicBiEncoder,
  biEncoderModelIdHash,
  merkleizeState,
  PATCH_TYPE,
  RANGES,
  CORETEX_PIPELINE_VERSION_BMU_V2,
  isBmuV2ScoringLaw,
} from '../../dist/index.js';

const BI = { modelId: 'BAAI/bge-m3', revision: 'a'.repeat(40), mode: 'dense' };
const LAYOUT = { dim: 32, quantization: 'int8', headerBytes: 9 };
const ZERO_STATE = { words: new Array(1024).fill(0n) };
const EPOCH = 7;
const SEED = '0x' + '11'.repeat(32);

const FAMS = [
  { bmu: 'temporal', bucketed: 'temporal', logical: 'temporal_update' },
  { bmu: 'conflict_lifecycle', bucketed: 'conflict_lifecycle', logical: 'conflict_lifecycle' },
  { bmu: 'multi_hop_relation', bucketed: 'multi_hop_relation', logical: 'multi_session_bridge' },
  { bmu: 'near_collision_abstention', bucketed: 'near_collision', logical: 'abstention_missing' },
];

function makeBmuEvent({ rid, fam, abstain = false, isProtected = false }) {
  const truthId = `${rid}-t`;
  const trapId = `${rid}-trap`;
  const fillId = `${rid}-fill`;
  return {
    id: rid,
    family: fam.bucketed,
    domain: 'companies',
    split: 'eval_hidden',
    queryText: `q-${rid}`,
    truthDocuments: abstain ? [] : [{ id: truthId, text: `truth-${rid}`, isCurrent: true }],
    hardNegatives: [
      { id: trapId, text: `trap-${rid}` },
      { id: fillId, text: `fill-${rid}` },
    ],
    qrels: abstain
      ? [{ documentId: trapId, relevance: 0 }, { documentId: fillId, relevance: 0 }]
      : [
          { documentId: truthId, relevance: 1.0 },
          { documentId: trapId, relevance: 0.0 },
          { documentId: fillId, relevance: 0.0 },
        ],
    protected: isProtected,
    logicalFamily: fam.logical,
    subjectEntityId: `ent-${rid}`,
    bmuTask: abstain
      ? {
          family: fam.bmu, budgetB: 3, requiredEvidence: [], forbiddenEvidence: [trapId],
          abstain: true, motifGroupId: `mg-${rid}`, templateId: `tt-${rid}`,
        }
      : {
          family: fam.bmu, budgetB: 3, requiredEvidence: [truthId], forbiddenEvidence: [trapId],
          answer: { id: truthId }, motifGroupId: `mg-${rid}`, templateId: `tt-${rid}`,
        },
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + 'aa'.repeat(32) },
    embeddings: {
      modelId: BI.modelId,
      revision: BI.revision,
      layout: LAYOUT,
      query: new Uint8Array(LAYOUT.dim + 4),
      perTruth: new Map(abstain ? [] : [[truthId, new Uint8Array(LAYOUT.dim + 4)]]),
      perNegative: new Map([
        [trapId, new Uint8Array(LAYOUT.dim + 4)],
        [fillId, new Uint8Array(LAYOUT.dim + 4)],
      ]),
    },
  };
}

// 8 rows, 2 per family; row b of near_collision is the abstention variant;
// row a of temporal is protected.
function makeFixture() {
  const events = [];
  for (const fam of FAMS) {
    for (const v of ['a', 'b']) {
      events.push(makeBmuEvent({
        rid: `${fam.bmu}-${v}`,
        fam,
        abstain: fam.bmu === 'near_collision_abstention' && v === 'b',
        isProtected: fam.bmu === 'temporal' && v === 'a',
      }));
    }
  }
  const corpus = {
    events,
    byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot: computeCorpusRoot(events),
    corpusEpoch: 0,
    biEncoderModelId: BI.modelId,
    biEncoderRevision: BI.revision,
    biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'memreranker/4B',
    labelingModelRevision: 'b'.repeat(40),
  };
  const pack = deriveQueryPack(EPOCH, SEED, corpus, { packSize: 8, quotas: [] });
  assert.equal(pack.events.length, 8);
  return { corpus, pack };
}

/** Reranker keyed on (query row id, doc text). `trapHighRows` lists row ids
 *  whose TRAP outranks everything (forbidden admitted → u = 0). */
function rerankerFor({ trapHighRows = [] } = {}) {
  const trapHigh = new Set(trapHighRows);
  return {
    model: 'unit-test-reranker',
    async score(pairs) {
      return pairs.map((p) => {
        const rid = p.query.slice(2); // strip 'q-'
        if (p.document === `truth-${rid}`) return 0.9;
        if (p.document === `trap-${rid}`) return trapHigh.has(rid) ? 0.95 : 0.05;
        if (p.document === `fill-${rid}`) return 0.4; // in top-3, harmless
        return 0.1; // other rows' docs
      });
    },
  };
}

const WEIGHTS = { w_retrieval: 0.75, w_temporal: 0.08, w_relation_recall: 0.07, w_abstention: 0.05, w_structural_sanity: 0.05 };

function bmuOpts(reranker) {
  return {
    weights: WEIGHTS,
    retrievalKeyLayout: LAYOUT,
    biEncoderHash: biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode),
    biEncoder: createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT }),
    reranker,
    relationHopBudget: 2,
    abstentionThreshold: 0.001,
    rerankerTopK: 10,
    rerankerInputTopK: 128,
    firstStageTopK: 50,
    lensTopK: 36,
    lensWeight: 0.1,
    anchorWeight: 0.15,
    relationExpansionBudget: 50,
    temporalCurrentBoost: 0.1,
    temporalStaleSuppression: 0.1,
    pipelineVersion: 'coretex-bmu-v1-r5state',
    policyAtomsMode: true,
  };
}

const FLOORS = {
  minImprovementPpm: 20_000,
  structuralFloor: 0,
  protectedRegressionFloor: 1,
  familyCatastrophicFloor: 0,
  acceptanceThresholdPpm: 20_250,
};

function makeApplyablePatch(parentState) {
  return {
    patchType: PATCH_TYPE.SLOT_REPLACE,
    wordCount: 1,
    scoreDelta: 0n,
    parentStateRoot: merkleizeState(parentState),
    indices: [RANGES.MEMORY_INDEX_START],
    newWords: [1n],
  };
}

describe('evaluateBmuBenchmarkState (e2e through the real pipeline)', () => {
  test('v2 is a separately pinned law and preserves the deterministic scalar contract', async () => {
    const { corpus, pack } = makeFixture();
    const opts = {
      ...bmuOpts(rerankerFor()),
      pipelineVersion: CORETEX_PIPELINE_VERSION_BMU_V2,
      // These are deliberately hostile v1 knobs. v2 owns the invocation and
      // removes them before scoring; the fixture still has no family route.
      temporalMotifAdmission: true,
      conflictMotifAdmission: true,
      evidenceMotifAdmission: true,
      policyQueryConditionedAdmission: true,
    };
    assert.equal(isBmuV2ScoringLaw(opts.pipelineVersion), true);
    const result = await evaluateBmuBenchmarkState(ZERO_STATE, corpus, pack, opts);
    assert.equal(result.bmu.packSize, 8);
    assert.equal(result.bmu.scalarPpm, 875000);
    // A blank state has no executable path program, so it owns no mandatory
    // public-path pool and a smaller cap remains valid. Program-specific
    // overflow refusal is covered by bmu-v2-executable-operation.test.mjs.
    const blankAt63 = await evaluateBmuBenchmarkState(ZERO_STATE, corpus, pack, { ...opts, rerankerInputTopK: 63 });
    assert.equal(blankAt63.bmu.scalarPpm, result.bmu.scalarPpm);
  });

  test('scalar law: 7/8 answerable rows lift; the blank state earns NO abstention utility (§5.5)', async () => {
    const { corpus, pack } = makeFixture();
    const score = await evaluateBmuBenchmarkState(ZERO_STATE, corpus, pack, bmuOpts(rerankerFor()));
    // 7 answerable rows: truth top-1, trap suppressed → u=1 each.
    // 1 abstention row: no policy atoms on a blank substrate → signal never
    // fires → u=0 (and the r5 atom-less fallback must NOT leak in).
    assert.equal(score.bmu.utilitySum, 7);
    assert.equal(score.bmu.scalarPpm, Math.round((1_000_000 * 7) / 8));
    assert.equal(Math.round(score.composite * 1_000_000), score.bmu.scalarPpm, 'ppm round-trip must be exact');
    assert.equal(score.bmu.familyUtilitiesPpm.temporal, 1_000_000);
    assert.equal(score.bmu.familyUtilitiesPpm.near_collision_abstention, 500_000);
    const abst = score.bmu.perTask.find((t) => t.recordId === 'near_collision_abstention-b');
    assert.equal(abst.utility, 0);
    assert.equal(abst.failure, 'abstain_signal_missing');
    assert.equal(abst.abstainSignal, false);
  });

  test('the forbidden-trap veto fires at the FINAL ordering (one trap-high row = one flip down)', async () => {
    const { corpus, pack } = makeFixture();
    const score = await evaluateBmuBenchmarkState(ZERO_STATE, corpus, pack, bmuOpts(rerankerFor({ trapHighRows: ['conflict_lifecycle-a'] })));
    assert.equal(score.bmu.utilitySum, 6);
    const hit = score.bmu.perTask.find((t) => t.recordId === 'conflict_lifecycle-a');
    assert.equal(hit.utility, 0);
    assert.equal(hit.failure, 'forbidden_admitted');
    assert.ok(hit.topB.includes('conflict_lifecycle-a-trap'));
  });

  test('fail-closed: unstamped pack row, wrong pipelineVersion, atoms off', async () => {
    const { corpus, pack } = makeFixture();
    const stripped = pack.events.map((e, i) => { if (i !== 0) return e; const { bmuTask, ...rest } = e; return rest; });
    await assert.rejects(
      evaluateBmuBenchmarkState(ZERO_STATE, corpus, { ...pack, events: stripped }, bmuOpts(rerankerFor())),
      /no bmuTask/,
    );
    await assert.rejects(
      evaluateBmuBenchmarkState(ZERO_STATE, corpus, pack, { ...bmuOpts(rerankerFor()), pipelineVersion: 'coretex-retrieval-v2-policy-r5' }),
      /does not pin the BMU law/,
    );
    await assert.rejects(
      evaluateBmuBenchmarkState(ZERO_STATE, corpus, pack, { ...bmuOpts(rerankerFor()), policyAtomsMode: false }),
      /policyAtomsMode/,
    );
  });
});

describe('evaluateBmuBenchmarkPatch — §2.4 threshold + §2.5 floors', () => {
  test('no-op patch → delta 0 → no_retrieval_improvement (below_gate lane)', async () => {
    const { corpus, pack } = makeFixture();
    const opts = bmuOpts(rerankerFor());
    const result = await evaluateBmuBenchmarkPatch(ZERO_STATE, makeApplyablePatch(ZERO_STATE), corpus, pack, opts, FLOORS);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'no_retrieval_improvement');
    assert.equal(result.deltaPpm, 0);
  });

  test('a 2-flip improvement (250,000 ppm on an 8-pack) clears the 20,250 threshold', async () => {
    const { corpus, pack } = makeFixture();
    // BEFORE: two rows trap-high (u=0); AFTER: traps suppressed → +2 flips.
    const before = await evaluateBmuBenchmarkState(
      ZERO_STATE, corpus, pack, bmuOpts(rerankerFor({ trapHighRows: ['multi_hop_relation-a', 'multi_hop_relation-b'] })));
    assert.equal(before.bmu.utilitySum, 5);
    const result = await evaluateBmuBenchmarkPatch(
      ZERO_STATE, makeApplyablePatch(ZERO_STATE), corpus, pack, bmuOpts(rerankerFor()), FLOORS, {}, before);
    assert.equal(result.accepted, true, result.reason);
    assert.equal(result.deltaPpm, 2 * 125_000); // 8-row pack quantum = 125k
    assert.ok(result.perFamilyDelta.multi_hop_relation > 0);
  });

  test('protected zero-tolerance veto: ANY protected u 1→0 rejects, even with net-positive delta', async () => {
    const { corpus, pack } = makeFixture();
    // BEFORE: 3 rows down (protected temporal-a is UP); AFTER: those 3 fixed
    // but protected temporal-a regresses → net +2 flips, still vetoed.
    const before = await evaluateBmuBenchmarkState(
      ZERO_STATE, corpus, pack,
      bmuOpts(rerankerFor({ trapHighRows: ['multi_hop_relation-a', 'multi_hop_relation-b', 'conflict_lifecycle-a'] })));
    const result = await evaluateBmuBenchmarkPatch(
      ZERO_STATE, makeApplyablePatch(ZERO_STATE), corpus, pack,
      bmuOpts(rerankerFor({ trapHighRows: ['temporal-a'] })), FLOORS, {}, before);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'protected_regression:temporal-a');
    assert.ok(result.deltaPpm > 0, 'veto must fire even on a net-positive patch');
  });

  test('per-family regression budget: 2 regressed rows in ONE family reject', async () => {
    const { corpus, pack } = makeFixture();
    const before = await evaluateBmuBenchmarkState(
      ZERO_STATE, corpus, pack,
      bmuOpts(rerankerFor({ trapHighRows: ['temporal-b', 'conflict_lifecycle-a', 'conflict_lifecycle-b'] })));
    // AFTER: both multi_hop rows regress (family budget 1) while the 3 fixed.
    const result = await evaluateBmuBenchmarkPatch(
      ZERO_STATE, makeApplyablePatch(ZERO_STATE), corpus, pack,
      bmuOpts(rerankerFor({ trapHighRows: ['multi_hop_relation-a', 'multi_hop_relation-b'] })), FLOORS, {}, before);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'regression_budget_family:multi_hop_relation');
  });

  test('total regression budget: 3 regressed rows across 3 families reject', async () => {
    const { corpus, pack } = makeFixture();
    // BEFORE: 3 rows down; AFTER: those fixed, but 3 OTHER rows regress —
    // ONE per family (each inside the ≤1 per-family budget) → total 3 > 2.
    // Protected temporal-a stays up on both sides.
    const before = await evaluateBmuBenchmarkState(
      ZERO_STATE, corpus, pack,
      bmuOpts(rerankerFor({ trapHighRows: ['temporal-b', 'conflict_lifecycle-b', 'multi_hop_relation-b'] })));
    const result = await evaluateBmuBenchmarkPatch(
      ZERO_STATE, makeApplyablePatch(ZERO_STATE), corpus, pack,
      bmuOpts(rerankerFor({ trapHighRows: ['conflict_lifecycle-a', 'multi_hop_relation-a', 'near_collision_abstention-a'] })), FLOORS, {}, before);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'regression_budget_total');
  });
});

describe('evaluateBmuBaseline (§8.4 baseline lane)', () => {
  test('baseline = BMU scalar with familyUtilitiesPpm; variance 0 on a deterministic host', async () => {
    const { corpus, pack } = makeFixture();
    const baseline = await evaluateBmuBaseline(ZERO_STATE, corpus, pack, bmuOpts(rerankerFor()), {}, { samples: 2 });
    assert.equal(baseline.parentScorePpm, Math.round((1_000_000 * 7) / 8));
    assert.equal(baseline.variancePpm, 0);
    assert.equal(baseline.samples, 2);
    assert.equal(baseline.familyUtilitiesPpm.temporal, 1_000_000);
    assert.equal(baseline.familyUtilitiesPpm.near_collision_abstention, 500_000);
    assert.equal(baseline.epochId, EPOCH);
  });
});
