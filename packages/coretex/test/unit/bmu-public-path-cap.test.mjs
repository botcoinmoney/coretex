/** Saturated BMU v2 path fixture: 4 stage-1 seeds × 4 outgoing pivots ×
 * 4 incoming terminal branches = 64 public-path documents. This is the
 * adversarial boundary that the old per-level admission implementation
 * miscounted as 64 while actually making 80 documents mandatory. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BMU_V2_PUBLIC_PATH_BUNDLE,
  CORETEX_PIPELINE_VERSION_BMU_V2,
  RANGES,
  bmuOperationQueryKey,
  biEncoderModelIdHash,
  computeCorpusRoot,
  createDeterministicBiEncoder,
  evaluateRetrievalBenchmarkState,
  encodeBmuPublicPathProgramWords,
} from '../../dist/index.js';

const BI = { modelId: 'test/bge', revision: 'a'.repeat(40), mode: 'dense' };
const LAYOUT = { dim: 8, quantization: 'int8', headerBytes: 9 };
const encoded = () => new Uint8Array(LAYOUT.dim + 4);

function event(id, relations = []) {
  const docId = id.replace(/^e_/, 'd_');
  return {
    id, family: 'generic', domain: 'test', split: 'train_visible', queryText: '',
    truthDocuments: [{ id: docId, text: `public text ${id}`, isCurrent: true }],
    hardNegatives: [], qrels: [], relations,
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '11'.repeat(32) },
    embeddings: {
      modelId: BI.modelId, revision: BI.revision, layout: LAYOUT,
      query: encoded(), perTruth: new Map([[docId, encoded()]]), perNegative: new Map(),
    },
  };
}

function saturatedFixture() {
  const events = [];
  const terminalDocIds = [];
  for (let seed = 0; seed < 4; seed++) {
    const pivots = Array.from({ length: 4 }, (_, pivot) => `e_10_pivot_${seed}_${pivot}`);
    events.push(event(`e_00_seed_${seed}`, pivots.map((other_id) => ({ other_id, edgeType: 'derived_from' }))));
    for (let pivot = 0; pivot < 4; pivot++) {
      const pivotId = pivots[pivot];
      events.push(event(pivotId));
      for (let branch = 0; branch < 4; branch++) {
        const branchId = `e_20_branch_${seed}_${pivot}_${branch}`;
        terminalDocIds.push(branchId.replace(/^e_/, 'd_'));
        events.push(event(branchId, [{ other_id: pivotId, edgeType: 'supports' }]));
      }
    }
  }
  const corpus = {
    events, byId: new Map(events.map((ev) => [ev.id, ev])),
    corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: BI.modelId, biEncoderRevision: BI.revision,
    biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'test/qwen', labelingModelRevision: 'b'.repeat(40),
  };
  const query = {
    id: 'q_saturated', family: 'generic', domain: 'test', split: 'eval_hidden',
    queryText: 'find the authoritative terminal branch',
    bmuOperationCue: 'saturated directed bundle',
    bmuOperationProgram: {
      branchLimit: 4,
      steps: [{ direction: 'outgoing', edgeType: 'derived_from' }, { direction: 'incoming', edgeType: 'supports' }],
    },
    truthDocuments: [{ id: terminalDocIds[0], text: 'answer', isCurrent: true }],
    hardNegatives: [], qrels: [{ documentId: terminalDocIds[0], relevance: 1 }],
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '22'.repeat(32) },
    embeddings: {
      modelId: BI.modelId, revision: BI.revision, layout: LAYOUT,
      query: encoded(), perTruth: new Map(), perNegative: new Map(),
    },
  };
  return { corpus, query, terminalDocIds };
}

test('all 64 terminal branches reach Qwen with no intermediate or doc-id truncation', async () => {
  const { corpus, query, terminalDocIds } = saturatedFixture();
  let rerankerDocuments = [];
  const state = { words: new Array(1024).fill(0n) };
  const program = encodeBmuPublicPathProgramWords({
    programIndex: 0, queryKey: bmuOperationQueryKey('saturated directed bundle'), branchLimit: 4,
    validFromEpoch: 0n, expiryEpoch: 0n,
    steps: [{ direction: 'outgoing', edgeType: 'derived_from' }, { direction: 'incoming', edgeType: 'supports' }],
  });
  for (let i = 0; i < 4; i++) state.words[RANGES.POLICY_EVIDENCE_START + i] = program[i];
  const result = await evaluateRetrievalBenchmarkState(
    state, corpus, { epoch: 1, seed: '0x' + '33'.repeat(32), events: [query] },
    {
      weights: { w_retrieval: 0.75, w_temporal: 0.08, w_relation_recall: 0.07, w_abstention: 0.05, w_structural_sanity: 0.05 },
      retrievalKeyLayout: LAYOUT,
      biEncoderHash: biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode),
      biEncoder: createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT }),
      reranker: { model: 'capture', async score(pairs) { rerankerDocuments = pairs.map((pair) => pair.document); return pairs.map(() => 0); } },
      relationHopBudget: 0, abstentionThreshold: 0, rerankerTopK: 10,
      rerankerInputTopK: 64, firstStageTopK: 4, lensTopK: 1,
      lensWeight: 0, anchorWeight: 0, relationExpansionBudget: 0,
      temporalCurrentBoost: 0, temporalStaleSuppression: 0,
      pipelineVersion: CORETEX_PIPELINE_VERSION_BMU_V2,
      policyAtomsMode: true, bmuPublicPathBundle: BMU_V2_PUBLIC_PATH_BUNDLE,
    },
  );
  assert.equal(rerankerDocuments.length, 64);
  assert.deepEqual(new Set(result.perQuery[0].cappedDocIds), new Set(terminalDocIds));
  assert.ok(result.perQuery[0].cappedDocSources.every((sources) => sources.includes('publicPath')));
  assert.ok(result.perQuery[0].cappedDocIds.every((id) => id.startsWith('d_20_branch_')),
    'intermediate pivots and seeds are traversal-only, never mandatory admissions');
});
