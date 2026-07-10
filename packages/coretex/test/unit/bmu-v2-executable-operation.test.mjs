import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  BMU_V2_PUBLIC_PATH_BUNDLE,
  BMU_V2_OPERATION_CLASS_BASIS,
  CORETEX_PIPELINE_VERSION_BMU_V2,
  CORETEX_PIPELINE_VERSION_R5,
  DEFAULT_PROFILE,
  RANGES,
  applyPatch,
  bmuOperationQueryKey,
  bmuOperationProgramValidationError,
  bmuOperationProgramsEqual,
  computeCorpusRoot,
  decodeBmuPublicPathPrograms,
  decodeSubstrate,
  encodeBmuPublicPathProgramWords,
  encodeMemoryIndexSlot,
  evaluateRetrievalBenchmarkState,
  merkleizeState,
  validatePolicyRegions,
} from '../../dist/index.js';
import {
  BMU_EXECUTABLE_PROGRAM_CAPACITY,
  BMU_EXECUTABLE_OPERATION_CLASS_BASIS,
  executableOperationSignature,
} from '../../../../scripts/lib/bmu-generators/operation-program.mjs';

const LAYOUT = { dim: 8, headerBytes: 9, quantization: 'int8' };
const MODEL_ID = 'test/bmu-v2-executable';
const REVISION = 'operation-law-v1';
const CUE = 'effective record protocol 017';
const EXACT_PROGRAM = {
  branchLimit: 4,
  steps: [
    { direction: 'outgoing', edgeType: 'derived_from' },
    { direction: 'incoming', edgeType: 'supports' },
  ],
};

function quantize(values) {
  const bytes = new Uint8Array(4 + values.length);
  new DataView(bytes.buffer).setFloat32(0, 1, false);
  for (let i = 0; i < values.length; i++) bytes[4 + i] = Math.round(values[i] * 127) & 0xff;
  return bytes;
}

function event(id, text, vector, relations = []) {
  const docId = `${id}-doc`;
  return {
    id, family: 'generic', domain: 'test', split: 'train_visible', queryText: text,
    truthDocuments: [{ id: docId, text, isCurrent: true }], hardNegatives: [], qrels: [],
    protected: false, relations,
    provenance: { source: 'synthetic_challenge', sourceHash: `0x${'11'.repeat(32)}` },
    embeddings: {
      modelId: MODEL_ID, revision: REVISION, layout: LAYOUT, query: quantize(vector),
      perTruth: new Map([[docId, quantize(vector)]]), perNegative: new Map(),
    },
  };
}

function fixture() {
  const high = [1, 0, 0, 0, 0, 0, 0, 0];
  const low = [0, 1, 0, 0, 0, 0, 0, 0];
  const medium = [0.8, 0.6, 0, 0, 0, 0, 0, 0];
  const branches = [
    event('opaque-71', 'the authoritative branch is confirmed and currently in force', low, [{ other_id: 'pivot', edgeType: 'supports' }]),
    event('opaque-13', 'the compared branch was rejected before ratification', low, [{ other_id: 'pivot', edgeType: 'supports' }]),
    event('opaque-88', 'the compared branch remained a nonbinding draft', low, [{ other_id: 'pivot', edgeType: 'supports' }]),
    event('opaque-42', 'the compared branch expired before review', low, [{ other_id: 'pivot', edgeType: 'supports' }]),
  ];
  const events = [
    event('seed', 'review the public operation request', high, [{ other_id: 'pivot', edgeType: 'derived_from' }]),
    event('pivot', 'neutral comparison pivot for the review', low),
    ...branches,
    ...Array.from({ length: 20 }, (_, i) => event(`noise-${i}`, `high cosine unrelated record ${i}`, medium)),
  ];
  const corpus = {
    events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: MODEL_ID, biEncoderRevision: REVISION, biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'test/qwen', labelingModelRevision: 'q'.repeat(40),
  };
  const query = {
    ...event('query', 'which reviewed branch is authoritative and in force?', high),
    split: 'eval_hidden', bmuOperationCue: CUE, bmuOperationProgram: EXACT_PROGRAM,
    qrels: [{ documentId: 'opaque-71-doc', relevance: 1 }],
    truthDocuments: [{ id: 'opaque-71-doc', text: 'hidden answer', isCurrent: true }],
  };
  return { corpus, query };
}

test('exact operation-body matcher rejects every other legal 1..4-step body and branch limit', () => {
  const opcodes = ['outgoing', 'incoming'].flatMap((direction) =>
    ['supports', 'supersedes', 'coreference_of', 'causes', 'derived_from', 'co_occurs_with']
      .map((edgeType) => ({ direction, edgeType })));
  let legalBodies = 0;
  let matches = 0;
  const visit = (steps, remaining) => {
    if (steps.length > 0) {
      for (let branchLimit = 1; branchLimit <= 4; branchLimit++) {
        const candidate = { branchLimit, steps };
        legalBodies += 1;
        assert.equal(bmuOperationProgramValidationError(candidate), branchLimit === 4 ? null : 'branchLimit must equal 4');
        if (bmuOperationProgramsEqual(EXACT_PROGRAM, candidate)) matches += 1;
      }
    }
    if (remaining === 0) return;
    for (const opcode of opcodes) visit([...steps, opcode], remaining - 1);
  };
  visit([], 4);
  assert.equal(legalBodies, 90_480);
  assert.equal(matches, 1, 'only exact branchLimit and ordered bytecode may bind a cue key');
  assert.notEqual(bmuOperationProgramValidationError(undefined), null);
  assert.notEqual(bmuOperationProgramValidationError({ branchLimit: 4, steps: [] }), null);
  assert.notEqual(bmuOperationProgramValidationError({
    branchLimit: 4, steps: [{ direction: 'sideways', edgeType: 'supports' }],
  }), null);
});

function stateWithProgram(steps, queryKey = bmuOperationQueryKey(CUE), slot = 0) {
  const state = { words: new Array(1024).fill(0n) };
  const words = encodeBmuPublicPathProgramWords({
    programIndex: slot, queryKey, branchLimit: 4, validFromEpoch: 0n, expiryEpoch: 0n, steps,
  });
  for (let i = 0; i < 4; i++) state.words[RANGES.POLICY_EVIDENCE_START + slot * 4 + i] = words[i];
  return state;
}

function opts(pipelineVersion, capture) {
  const semanticRouteScore = (document) => document.includes('Path 0: review the public operation request')
    && document.includes('Path 1: neutral comparison pivot')
    && document.includes('Path 2: the authoritative branch is confirmed') ? 0.99 : 0.1;
  return {
    weights: DEFAULT_PROFILE.compositeWeights,
    retrievalKeyLayout: LAYOUT,
    biEncoder: { model: { id: MODEL_ID, revision: REVISION }, async encode() { return new Float32Array(8); } },
    reranker: { model: 'semantic-reader', async score(pairs) {
      capture.push(...pairs.map((pair) => pair.document));
      return pairs.map((pair) => semanticRouteScore(pair.document));
    } },
    biEncoderHash: '0x01020304', relationHopBudget: 0, abstentionThreshold: 0,
    rerankerTopK: 10, firstStageTopK: 1, rerankerInputTopK: 8, lensTopK: 1,
    lensWeight: 0, anchorWeight: 0, relationExpansionBudget: 0,
    temporalCurrentBoost: 0, temporalStaleSuppression: 0,
    policyAtomsMode: true, pipelineVersion,
    ...(pipelineVersion === CORETEX_PIPELINE_VERSION_BMU_V2 ? { bmuPublicPathBundle: BMU_V2_PUBLIC_PATH_BUNDLE } : {}),
  };
}

test('v2 scorer fails closed on missing or malformed public operation bodies', async () => {
  const { corpus, query } = fixture();
  const state = { words: new Array(1024).fill(0n) };
  const invalidPrograms = [
    undefined,
    { branchLimit: 3, steps: EXACT_PROGRAM.steps },
    { branchLimit: 4, steps: [] },
    { branchLimit: 4, steps: [{ direction: 'incoming', edgeType: 'answers' }] },
  ];
  for (const operationProgram of invalidPrograms) {
    const invalid = { ...query };
    if (operationProgram === undefined) delete invalid.bmuOperationProgram;
    else invalid.bmuOperationProgram = operationProgram;
    await assert.rejects(
      evaluateRetrievalBenchmarkState(
        state,
        corpus,
        { epoch: 0, seed: `0x${'23'.repeat(32)}`, events: [invalid] },
        opts(CORETEX_PIPELINE_VERSION_BMU_V2, []),
      ),
      /missing\/malformed bmuOperationProgram/,
    );
  }
  const missing = { ...query };
  delete missing.bmuOperationProgram;
  const v2WithoutExplicitBundle = { ...opts(CORETEX_PIPELINE_VERSION_BMU_V2, []) };
  delete v2WithoutExplicitBundle.bmuPublicPathBundle;
  await assert.rejects(
    evaluateRetrievalBenchmarkState(
      state,
      corpus,
      { epoch: 0, seed: `0x${'25'.repeat(32)}`, events: [missing] },
      v2WithoutExplicitBundle,
    ),
    /missing\/malformed bmuOperationProgram/,
    'the pipeline pin itself fails closed even if a direct caller omits the bundle option',
  );
});

test('blank and obsolete parent fail while a four-word query-key program executes and supplies uniform route context', async () => {
  const { corpus, query } = fixture();
  const pack = { epoch: 0, seed: `0x${'22'.repeat(32)}`, events: [query] };
  const blank = { words: new Array(1024).fill(0n) };
  const parent = stateWithProgram([{ direction: 'outgoing', edgeType: 'causes' }, { direction: 'incoming', edgeType: 'supports' }]);
  const candidate = stateWithProgram([{ direction: 'outgoing', edgeType: 'derived_from' }, { direction: 'incoming', edgeType: 'supports' }]);
  const blankDocs = [], parentDocs = [], candidateDocs = [];
  const blankScore = await evaluateRetrievalBenchmarkState(blank, corpus, pack, opts(CORETEX_PIPELINE_VERSION_BMU_V2, blankDocs));
  const parentScore = await evaluateRetrievalBenchmarkState(parent, corpus, pack, opts(CORETEX_PIPELINE_VERSION_BMU_V2, parentDocs));
  const candidateScore = await evaluateRetrievalBenchmarkState(candidate, corpus, pack, opts(CORETEX_PIPELINE_VERSION_BMU_V2, candidateDocs));
  assert.equal(blankScore.perQuery[0].answerInCap, false);
  assert.equal(parentScore.perQuery[0].answerInCap, false);
  assert.equal(candidateScore.perQuery[0].answerInCap, true,
    JSON.stringify({ capped: candidateScore.perQuery[0].cappedDocIds, programs: decodeBmuPublicPathPrograms(candidate).programs.map((p) => p.steps), failures: decodeBmuPublicPathPrograms(candidate).failures }));
  const routed = candidateDocs.filter((text) => text.startsWith('Path 0:'));
  assert.equal(routed.length, 4);
  assert.ok(routed.every((text) => text.split('\n').length === 3));
  assert.ok(routed.every((text) => text.includes('review the public operation request') && text.includes('neutral comparison pivot')));
  assert.equal(candidateScore.perQuery[0].finalRankingTop20.find((row) => row.docId === 'opaque-71-doc')?.rank, 1,
    'semantic terminal scores high only with the complete route lineage');
  assert.equal(blankDocs.some((text) => text.startsWith('Path 0:')), false);
});

test('diagonal edge programs exclude seed backtracking before applying the four-branch cap', async () => {
  const high = [1, 0, 0, 0, 0, 0, 0, 0];
  const low = [0, 1, 0, 0, 0, 0, 0, 0];
  const terminals = ['terminal-a', 'terminal-b', 'terminal-c', 'terminal-d'];
  const events = [
    event('diagonal-seed', 'diagonal seed', high, [{ other_id: 'diagonal-pivot', edgeType: 'supports' }]),
    event('diagonal-pivot', 'diagonal pivot', low),
    ...terminals.map((id) => event(id, `fresh ${id}`, low, [{ other_id: 'diagonal-pivot', edgeType: 'supports' }])),
  ];
  const corpus = {
    events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: MODEL_ID, biEncoderRevision: REVISION, biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'test/qwen', labelingModelRevision: 'q'.repeat(40),
  };
  const query = {
    ...event('diagonal-query', 'execute diagonal route', high),
    split: 'eval_hidden', bmuOperationCue: CUE,
    bmuOperationProgram: {
      branchLimit: 4,
      steps: [{ direction: 'outgoing', edgeType: 'supports' }, { direction: 'incoming', edgeType: 'supports' }],
    },
  };
  const capture = [];
  const state = stateWithProgram([
    { direction: 'outgoing', edgeType: 'supports' },
    { direction: 'incoming', edgeType: 'supports' },
  ]);
  const score = await evaluateRetrievalBenchmarkState(
    state,
    corpus,
    { epoch: 0, seed: `0x${'24'.repeat(32)}`, events: [query] },
    { ...opts(CORETEX_PIPELINE_VERSION_BMU_V2, capture), firstStageTopK: 1, rerankerInputTopK: 8 },
  );
  const result = score.perQuery[0];
  for (const id of terminals.map((terminal) => `${terminal}-doc`)) {
    assert.ok(result.cappedDocIds.includes(id), `${id} survives the fresh-neighbor branch cap`);
    assert.ok(result.cappedDocSources[result.cappedDocIds.indexOf(id)].includes('publicPath'));
  }
  assert.deepEqual(result.cappedDocSources[result.cappedDocIds.indexOf('diagonal-seed-doc')], ['stage1'],
    'the route never loops back and labels its seed as a terminal');
  assert.equal(capture.filter((document) => document.startsWith('Path 0:')).length, 4);
});

test('program is exactly one four-word patch; incomplete, duplicate-key, and occupied inert-anchor states fail closed', () => {
  const blank = { words: new Array(1024).fill(0n) };
  const candidate = stateWithProgram([{ direction: 'outgoing', edgeType: 'derived_from' }, { direction: 'incoming', edgeType: 'supports' }]);
  const newWords = candidate.words.slice(RANGES.POLICY_EVIDENCE_START, RANGES.POLICY_EVIDENCE_START + 4);
  const patch = {
    patchType: 0x07, wordCount: 4, scoreDelta: 1n, parentStateRoot: merkleizeState(blank),
    indices: [384, 385, 386, 387], newWords,
  };
  assert.equal(applyPatch(blank, patch, true).ok, true);
  assert.equal(validatePolicyRegions(candidate, false), null, 'the same words are four valid legacy r5 atoms');

  const incomplete = { words: [...blank.words] };
  for (let i = 0; i < 3; i++) incomplete.words[384 + i] = newWords[i];
  assert.equal(validatePolicyRegions(incomplete), null, 'generic r5 grammar remains unchanged');
  assert.ok(decodeSubstrate(incomplete, { policyAtomsMode: true, bmuV2PathPrograms: true }).decodeFailures > 0,
    'v2 scoring marks a partial group structurally invalid');

  const duplicate = { words: [...candidate.words] };
  const second = stateWithProgram([{ direction: 'outgoing', edgeType: 'causes' }], bmuOperationQueryKey(CUE), 1);
  for (let i = 0; i < 4; i++) duplicate.words[388 + i] = second.words[388 + i];
  assert.ok(decodeBmuPublicPathPrograms(duplicate).failures > 0);
  assert.equal(decodeSubstrate(duplicate, { policyAtomsMode: true, bmuV2PathPrograms: true }).bmuPublicPathPrograms.length, 0,
    'duplicate key maps to no executable program');

  const occupied = { words: [...candidate.words] };
  occupied.words[RANGES.MEMORY_INDEX_START + 255] = encodeMemoryIndexSlot({
    slotIndex: 255, recordId: 1n, family: 'temporal', domainBits: 1n,
    valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n,
  })[0];
  assert.equal(validatePolicyRegions(occupied), null, 'program inertness does not depend on target-slot vacancy');
});

test('v2 complete groups are inert under r5 rollback even when target slot 255 is populated', async () => {
  const { corpus, query } = fixture();
  const pack = { epoch: 0, seed: `0x${'33'.repeat(32)}`, events: [query] };
  const blankDocs = [], programDocs = [];
  const baselineState = { words: new Array(1024).fill(0n) };
  baselineState.words[RANGES.MEMORY_INDEX_START + 255] = encodeMemoryIndexSlot({
    slotIndex: 255, recordId: 1n, family: 'temporal', domainBits: 1n,
    valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n,
  })[0];
  const blank = await evaluateRetrievalBenchmarkState(baselineState, corpus, pack, opts(CORETEX_PIPELINE_VERSION_R5, blankDocs));
  const programState = stateWithProgram([{ direction: 'outgoing', edgeType: 'derived_from' }, { direction: 'incoming', edgeType: 'supports' }]);
  programState.words[RANGES.MEMORY_INDEX_START + 255] = baselineState.words[RANGES.MEMORY_INDEX_START + 255];
  const candidate = await evaluateRetrievalBenchmarkState(
    programState,
    corpus, pack, opts(CORETEX_PIPELINE_VERSION_R5, programDocs),
  );
  assert.deepEqual(candidate.perQuery[0].cappedDocIds, blank.perQuery[0].cappedDocIds);
  assert.deepEqual(programDocs, blankDocs);
});

test('terminal overflow fails before Qwen instead of truncating a program bundle', async () => {
  const high = [1, 0, 0, 0, 0, 0, 0, 0];
  const low = [0, 1, 0, 0, 0, 0, 0, 0];
  const events = [];
  let frontier = ['overflow-seed'];
  const relationsById = new Map();
  for (let depth = 0; depth < 4; depth++) {
    const next = [];
    for (const parent of frontier) {
      const relations = [];
      for (let branch = 0; branch < 4; branch++) {
        const child = `${parent}-${branch}`;
        relations.push({ other_id: child, edgeType: 'derived_from' });
        next.push(child);
      }
      relationsById.set(parent, relations);
    }
    frontier = next;
  }
  for (const id of new Set(['overflow-seed', ...[...relationsById.values()].flat().map((r) => r.other_id)])) {
    events.push(event(id, `bounded route node ${id}`, id === 'overflow-seed' ? high : low, relationsById.get(id) ?? []));
  }
  const corpus = {
    events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: MODEL_ID, biEncoderRevision: REVISION, biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'test/qwen', labelingModelRevision: 'q'.repeat(40),
  };
  const query = {
    ...event('overflow-query', 'follow the bounded route', high),
    split: 'eval_hidden', bmuOperationCue: CUE,
    bmuOperationProgram: {
      branchLimit: 4,
      steps: Array.from({ length: 4 }, () => ({ direction: 'outgoing', edgeType: 'derived_from' })),
    },
  };
  const capture = [];
  const overflowOpts = { ...opts(CORETEX_PIPELINE_VERSION_BMU_V2, capture), rerankerInputTopK: 64 };
  const state = stateWithProgram(Array.from({ length: 4 }, () => ({ direction: 'outgoing', edgeType: 'derived_from' })));
  await assert.rejects(
    evaluateRetrievalBenchmarkState(state, corpus, { epoch: 0, seed: `0x${'55'.repeat(32)}`, events: [query] }, overflowOpts),
    /mandatory pool has 256 docs/,
  );
  assert.equal(capture.length, 0, 'overflow is rejected before any reranker call');
});

test('ambiguous route collisions and oversized lineage fail closed without truncation', async () => {
  const high = [1, 0, 0, 0, 0, 0, 0, 0];
  const low = [0, 1, 0, 0, 0, 0, 0, 0];
  const query = {
    ...event('route-query', 'follow route', high),
    split: 'eval_hidden', bmuOperationCue: CUE,
    bmuOperationProgram: {
      branchLimit: 4,
      steps: [{ direction: 'outgoing', edgeType: 'derived_from' }, { direction: 'outgoing', edgeType: 'supports' }],
    },
  };
  const makeCorpus = (events) => ({
    events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: MODEL_ID, biEncoderRevision: REVISION, biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'test/qwen', labelingModelRevision: 'q'.repeat(40),
  });
  const collisionEvents = [
    event('route-seed', 'seed', high, [{ other_id: 'p1', edgeType: 'derived_from' }, { other_id: 'p2', edgeType: 'derived_from' }]),
    event('p1', 'pivot one', low, [{ other_id: 'terminal', edgeType: 'supports' }]),
    event('p2', 'pivot two', low, [{ other_id: 'terminal', edgeType: 'supports' }]),
    event('terminal', 'terminal', low),
  ];
  const state = stateWithProgram([{ direction: 'outgoing', edgeType: 'derived_from' }, { direction: 'outgoing', edgeType: 'supports' }]);
  await assert.rejects(
    evaluateRetrievalBenchmarkState(state, makeCorpus(collisionEvents), { epoch: 0, seed: `0x${'66'.repeat(32)}`, events: [query] }, opts(CORETEX_PIPELINE_VERSION_BMU_V2, [])),
    /route collision/,
  );

  const oversizedEvents = [
    event('route-seed', 'seed', high, [{ other_id: 'p1', edgeType: 'derived_from' }]),
    event('p1', 'pivot one', low, [{ other_id: 'terminal', edgeType: 'supports' }]),
    event('terminal', 'x'.repeat(9000), low),
  ];
  await assert.rejects(
    evaluateRetrievalBenchmarkState(state, makeCorpus(oversizedEvents), { epoch: 0, seed: `0x${'77'.repeat(32)}`, events: [query] }, opts(CORETEX_PIPELINE_VERSION_BMU_V2, [])),
    /refusing truncation/,
  );
});

test('paired I6-disjoint mints exert aggregate pressure on one shared 32-program region', () => {
  assert.equal(BMU_EXECUTABLE_OPERATION_CLASS_BASIS, BMU_V2_OPERATION_CLASS_BASIS);
  assert.equal(BMU_V2_OPERATION_CLASS_BASIS, 'shared-policy-evidence-384-511-4w-program-v1');
  assert.throws(() => executableOperationSignature({
    operationCue: 'invalid operation direction', operationClass: 'invalid-direction',
    steps: [{ direction: 'sideways', edgeType: 'supports' }],
  }), /unknown direction or public edge type/);
  assert.throws(() => executableOperationSignature({
    operationCue: 'invalid operation edge', operationClass: 'invalid-edge',
    steps: [{ direction: 'outgoing', edgeType: 'answers' }],
  }), /unknown direction or public edge type/);
  const aggregate = new Set();
  const aggregateKeys = new Set();
  const edges = ['supports', 'supersedes', 'coreference_of', 'causes', 'derived_from', 'co_occurs_with'];
  for (const [familyIndex, family] of ['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention'].entries()) {
    const window = Array.from({ length: 96 }, (_, mint) => {
      const classOrdinal = Math.floor(mint / 2);
      return executableOperationSignature({
        operationCue: `${family.replaceAll('_', ' ')} neutral cue ${String(classOrdinal).padStart(3, '0')}`,
        operationClass: `${family}:private-assignment-slot:${classOrdinal}`,
        steps: [
          { direction: classOrdinal % 2 ? 'incoming' : 'outgoing', edgeType: edges[(classOrdinal + familyIndex) % edges.length] },
          { direction: classOrdinal % 3 ? 'incoming' : 'outgoing', edgeType: edges[(classOrdinal * 5 + familyIndex) % edges.length] },
        ],
      });
    });
    assert.equal(new Set(window.map((row) => row.executableSignature)).size, 48);
    for (let i = 0; i < window.length; i += 2) assert.equal(window[i].executableSignature, window[i + 1].executableSignature);
    assert.equal(new Set(window.map((row) => bmuOperationQueryKey(row.operationCue))).size, 48);
    for (const row of window) {
      aggregate.add(row.executableSignature);
      aggregateKeys.add(bmuOperationQueryKey(row.operationCue));
    }
  }
  assert.ok(aggregate.size > BMU_EXECUTABLE_PROGRAM_CAPACITY);
  assert.equal(aggregateKeys.size, aggregate.size, '56-bit key collision census is zero across the aggregate window');
});
