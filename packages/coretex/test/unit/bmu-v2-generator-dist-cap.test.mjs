/**
 * Generator/scorer integration proof. The edge program comes from the real
 * v2 multi-hop class bank, while derive/evaluate runs only through compiled
 * dist. A low-cosine truth must enter the Qwen cap through the disjoint
 * outgoing→incoming diamond; amputating the seed must exclude it.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  computeCorpusRoot,
  DEFAULT_PROFILE,
  CORETEX_PIPELINE_VERSION_BMU_V2,
  RANGES,
  bmuOperationQueryKey,
  encodeBmuPublicPathProgramWords,
  evaluateRetrievalBenchmarkState,
  splitForRecord,
} from '../../dist/index.js';
import { BMU_MULTI_HOP_OPERATION_CLASSES } from '../../../../scripts/lib/bmu-generators/multi_hop_relation.mjs';
import { NEARCOL_OPERATION_CLASSES } from '../../../../scripts/lib/bmu-generators/near_collision_abstention.mjs';

const LAYOUT = { dim: 8, headerBytes: 9, quantization: 'int8' };
const MODEL_ID = 'test/bmu-v2-generator-cap';
const REVISION = 'generator-dist-cap-v1';
const MODEL_HASH = '0xb6d2cafe';
const CUE = 'generator dist executable operation';

function stateFor(plan) {
  const state = { words: new Array(1024).fill(0n) };
  const words = encodeBmuPublicPathProgramWords({
    programIndex: 0, queryKey: bmuOperationQueryKey(CUE), branchLimit: 4,
    validFromEpoch: 0n, expiryEpoch: 0n,
    steps: [{ direction: 'outgoing', edgeType: plan.outgoingEdgeType }, { direction: 'incoming', edgeType: plan.incomingEdgeType }],
  });
  for (let i = 0; i < 4; i++) state.words[RANGES.POLICY_EVIDENCE_START + i] = words[i];
  return state;
}

function quantize(values) {
  const bytes = new Uint8Array(4 + values.length);
  new DataView(bytes.buffer).setFloat32(0, 1, false);
  for (let i = 0; i < values.length; i++) bytes[4 + i] = Math.round(values[i] * 127) & 0xff;
  return bytes;
}

function event({ id, text, vector, queryVector = vector, relations = [], qrels = [] }) {
  const docId = `${id}-doc`;
  return {
    id,
    queryText: id === 'seed' ? 'which reviewed branch is confirmed and in force?' : text,
    family: 'multi_hop_relation',
    split: splitForRecord(id, 0),
    timestamp: 1_700_000_000_000,
    epochId: 0,
    truthDocuments: [{ id: docId, text, isCurrent: true }],
    negativeDocuments: [],
    hardNegatives: [],
    qrels,
    relations,
    embeddings: {
      modelId: MODEL_ID,
      revision: REVISION,
      layout: LAYOUT,
      query: quantize(queryVector),
      perTruth: new Map([[docId, quantize(vector)]]),
      perNegative: new Map(),
    },
  };
}

function corpusFor(plan, { amputateSeed = false } = {}) {
  const query = [1, 0, 0, 0, 0, 0, 0, 0];
  const low = [0.08, 0.997, 0, 0, 0, 0, 0, 0];
  const high = [0.70, 0.714, 0, 0, 0, 0, 0, 0];
  const seedRelations = amputateSeed ? [] : [{ other_id: 'pivot', edgeType: plan.outgoingEdgeType }];
  const branch = (id, text) => event({
    id, text, vector: low,
    relations: [{ other_id: 'pivot', edgeType: plan.incomingEdgeType }],
  });
  const events = [
    event({
      id: 'seed', text: 'review anchor', vector: query, queryVector: query,
      relations: seedRelations,
      qrels: [{ documentId: 'truth-doc', relevance: 1 }],
    }),
    event({ id: 'pivot', text: 'neutral comparison pivot', vector: low }),
    branch('truth', 'the reviewed entry is confirmed and in force'),
    branch('decoy-a', 'the reviewed entry was rejected and never took effect'),
    branch('decoy-b', 'the reviewed entry was copied from an unapproved draft'),
    branch('decoy-c', 'the reviewed entry was superseded before ratification'),
    ...Array.from({ length: 70 }, (_, i) => event({ id: `distractor-${String(i).padStart(2, '0')}`, text: `high-cosine distractor ${i}`, vector: high })),
  ];
  events[0].bmuOperationCue = CUE;
  return {
    schemaVersion: 'coretex.production-corpus.v1',
    corpusEpoch: 0,
    corpusRoot: computeCorpusRoot(events),
    generatedAt: '2026-07-10T00:00:00.000Z',
    biEncoderModelId: MODEL_ID,
    biEncoderRevision: REVISION,
    biEncoderRetrievalKeyLayout: LAYOUT,
    events,
    splitRatios: { trainVisiblePct: 70, calibrationPct: 10, evalHiddenPct: 15, canaryPct: 5 },
  };
}

function opts() {
  return {
    weights: DEFAULT_PROFILE.compositeWeights,
    retrievalKeyLayout: LAYOUT,
    biEncoder: { model: { id: MODEL_ID, revision: REVISION }, async encode() { return new Float32Array(LAYOUT.dim); } },
    reranker: { model: 'truth-reader', async score(pairs) { return pairs.map((pair) => pair.document.includes('confirmed and in force') ? 0.99 : 0.1); } },
    biEncoderHash: MODEL_HASH,
    relationHopBudget: 2,
    abstentionThreshold: 0.001,
    rerankerTopK: 10,
    retrievalKeyTopK: 50,
    firstStageTopK: 300,
    rerankerInputTopK: 64,
    lensTopK: 36,
    lensWeight: 0.1,
    anchorWeight: 0.15,
    relationExpansionBudget: 50,
    temporalCurrentBoost: 0.1,
    temporalStaleSuppression: 0.1,
    exposeFullRanking: true,
    policyAtomsMode: true,
    pipelineVersion: CORETEX_PIPELINE_VERSION_BMU_V2,
    bmuPublicPathBundle: {
      stage1SeedLimit: 4,
      branchLimit: 4,
      maxPrograms: 32,
      maxRenderedLineageChars: 8192,
    },
  };
}

for (const [family, plan] of [
  ['multi-hop', BMU_MULTI_HOP_OPERATION_CLASSES[0]],
  ['near-collision', NEARCOL_OPERATION_CLASSES.at(-1)],
]) {
  test(`compiled dist derives ${family} disjoint diamond membership at the real cap boundary`, async () => {
    assert.ok(['causes', 'derived_from'].includes(plan.outgoingEdgeType));
    assert.ok(['supports', 'supersedes', 'coreference_of', 'co_occurs_with'].includes(plan.incomingEdgeType));
    assert.notEqual(plan.outgoingEdgeType, plan.incomingEdgeType);

    const intactCorpus = corpusFor(plan);
    const amputatedCorpus = corpusFor(plan, { amputateSeed: true });
    const packFor = (corpus) => ({ epochId: 0, evalSeedCommit: `0x${'71'.repeat(32)}`, events: [corpus.events[0]] });
    const intact = await evaluateRetrievalBenchmarkState(stateFor(plan), intactCorpus, packFor(intactCorpus), opts());
    const amputated = await evaluateRetrievalBenchmarkState(stateFor(plan), amputatedCorpus, packFor(amputatedCorpus), opts());
    const intactQuery = intact.perQuery[0];
    const amputatedQuery = amputated.perQuery[0];

    const truthIndex = intactQuery.cappedDocIds.indexOf('truth-doc');
    assert.notEqual(truthIndex, -1, 'diamond admits the low-cosine truth into the Qwen cap');
    assert.ok(intactQuery.cappedDocSources[truthIndex].includes('publicPath'), 'cap receipt attributes truth to publicPath');
    assert.equal(intactQuery.answerInCap, true);
    assert.equal(intactQuery.finalRankingTop20.find((row) => row.docId === 'truth-doc')?.rank, 1, 'uniform Qwen reads truth after admission');

    assert.equal(amputatedQuery.cappedDocIds.includes('truth-doc'), false, 'without the outgoing seed, high-cosine distractors fill the cap');
    assert.equal(amputatedQuery.answerInCap, false);
  });
}
