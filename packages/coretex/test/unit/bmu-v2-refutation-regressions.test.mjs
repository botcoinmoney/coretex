/**
 * Durable adversarial controls for three BMU-v2 generator/scorer refutations.
 *
 * These are intentionally negative controls: they demonstrate that the
 * current public-path/class-census/id-attacker claims are insufficient. A
 * redesign should make the asserted counterexamples impossible and replace
 * these controls with the corresponding fail-closed security assertions.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  computeCorpusRoot,
  DEFAULT_PROFILE,
  CORETEX_PIPELINE_VERSION_BMU_V2,
  bmuOperationQueryKey,
  encodeBmuPublicPathProgramWords,
  encodeMemoryIndexSlot,
  evaluateRetrievalBenchmarkState,
  RANGES,
  splitForRecord,
  stableRecordIdFor,
  liveTailQueryId,
} from '../../dist/index.js';
import { judgeTopB } from '../../../../scripts/lib/bmu-generators/certify.mjs';
import {
  generateMultiHopClusters,
} from '../../../../scripts/lib/bmu-generators/multi_hop_relation.mjs';
import {
  generateNearCollisionAbstentionClusters,
} from '../../../../scripts/lib/bmu-generators/near_collision_abstention.mjs';
import {
  createM1Registry,
  makeCanonicalSplitOf,
  opaqueBmuDocId,
} from '../../../../scripts/lib/bmu-generators/common.mjs';

const LAYOUT = { dim: 8, headerBytes: 9, quantization: 'int8' };
const MODEL_ID = 'test/bmu-v2-refutation';
const REVISION = 'all-edge-programs-v1';
const ZERO_STATE = { words: new Array(1024).fill(0n) };

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
    negativeDocuments: [], hardNegatives: [], qrels, relations,
    embeddings: {
      modelId: MODEL_ID, revision: REVISION, layout: LAYOUT,
      query: quantize(queryVector),
      perTruth: new Map([[docId, quantize(vector)]]), perNegative: new Map(),
    },
  };
}

function corpusFor(outgoingEdgeType, incomingEdgeType) {
  const query = [1, 0, 0, 0, 0, 0, 0, 0];
  const low = [0.08, 0.997, 0, 0, 0, 0, 0, 0];
  const high = [0.70, 0.714, 0, 0, 0, 0, 0, 0];
  const branch = (id, text) => event({
    id, text, vector: low,
    relations: [{ other_id: 'pivot', edgeType: incomingEdgeType }],
  });
  const events = [
    event({
      id: 'seed', text: 'review anchor', vector: query, queryVector: query,
      relations: [{ other_id: 'pivot', edgeType: outgoingEdgeType }],
      qrels: [{ documentId: 'truth-doc', relevance: 1 }],
    }),
    event({ id: 'pivot', text: 'neutral comparison pivot', vector: low }),
    branch('truth', 'the reviewed entry is confirmed and in force'),
    branch('decoy-a', 'the reviewed entry was rejected and never took effect'),
    branch('decoy-b', 'the reviewed entry was copied from an unapproved draft'),
    branch('decoy-c', 'the reviewed entry was superseded before ratification'),
    ...Array.from({ length: 70 }, (_, i) => event({
      id: `distractor-${String(i).padStart(2, '0')}`,
      text: `high-cosine distractor ${i}`, vector: high,
    })),
  ];
  events[0].bmuOperationCue = 'refutation executable route';
  return {
    schemaVersion: 'coretex.production-corpus.v1', corpusEpoch: 0,
    corpusRoot: computeCorpusRoot(events), generatedAt: '2026-07-10T00:00:00.000Z',
    biEncoderModelId: MODEL_ID, biEncoderRevision: REVISION,
    biEncoderRetrievalKeyLayout: LAYOUT, events,
    splitRatios: { trainVisiblePct: 70, calibrationPct: 10, evalHiddenPct: 15, canaryPct: 5 },
  };
}

function scoringOptions() {
  return {
    weights: DEFAULT_PROFILE.compositeWeights,
    retrievalKeyLayout: LAYOUT,
    biEncoder: { model: { id: MODEL_ID, revision: REVISION }, async encode() { return new Float32Array(LAYOUT.dim); } },
    reranker: {
      model: 'truth-reader',
      async score(pairs) { return pairs.map((pair) => pair.document.includes('confirmed and in force') ? 0.99 : 0.1); },
    },
    biEncoderHash: '0xb6d2cafe', relationHopBudget: 2,
    abstentionThreshold: 0.001, rerankerTopK: 10, retrievalKeyTopK: 50,
    firstStageTopK: 300, rerankerInputTopK: 64, lensTopK: 36,
    lensWeight: 0.1, anchorWeight: 0.15, relationExpansionBudget: 50,
    temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1,
    exposeFullRanking: true,
    policyAtomsMode: true,
    pipelineVersion: CORETEX_PIPELINE_VERSION_BMU_V2,
    bmuPublicPathBundle: {
      stage1SeedLimit: 4, branchLimit: 4,
      maxPrograms: 32, maxRenderedLineageChars: 8192,
    },
  };
}

function candidateStateAnchoringDistractor() {
  const words = [...ZERO_STATE.words];
  words[RANGES.MEMORY_INDEX_START] = encodeMemoryIndexSlot({
    slotIndex: 0,
    recordId: stableRecordIdFor('distractor-69'),
    family: 'near_collision', domainBits: 0n,
    valid: true, revoked: false, protected: false,
    retrievalSlot: 0, expiryEpoch: 0n,
  })[0];
  return { words };
}

test('regression: ZERO_STATE fails and exact candidate bytecode causally controls every public edge program', async () => {
  const programs = ['causes', 'derived_from'].flatMap((outgoing) =>
    ['supports', 'supersedes', 'coreference_of', 'co_occurs_with'].map((incoming) => [outgoing, incoming]));
  for (const [outgoing, incoming] of programs) {
    const corpus = corpusFor(outgoing, incoming);
    const pack = { epochId: 0, evalSeedCommit: `0x${'71'.repeat(32)}`, events: [corpus.events[0]] };
    const parent = await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, scoringOptions());
    const candidateState = { words: new Array(1024).fill(0n) };
    const program = encodeBmuPublicPathProgramWords({
      programIndex: 0, queryKey: bmuOperationQueryKey('refutation executable route'), branchLimit: 4,
      validFromEpoch: 0n, expiryEpoch: 0n,
      steps: [{ direction: 'outgoing', edgeType: outgoing }, { direction: 'incoming', edgeType: incoming }],
    });
    for (let i = 0; i < 4; i++) candidateState.words[RANGES.POLICY_EVIDENCE_START + i] = program[i];
    const candidate = await evaluateRetrievalBenchmarkState(candidateState, corpus, pack, scoringOptions());
    const p = parent.perQuery[0];
    const c = candidate.perQuery[0];
    const parentTruthIndex = p.cappedDocIds.indexOf('truth-doc');
    const candidateTruthIndex = c.cappedDocIds.indexOf('truth-doc');
    assert.equal(parentTruthIndex, -1, `${outgoing}/${incoming}: blank state cannot execute the route`);
    assert.notEqual(candidateTruthIndex, -1, `${outgoing}/${incoming}: candidate admits truth`);
    assert.ok(c.cappedDocSources[candidateTruthIndex].includes('publicPath'));
    assert.equal(c.finalRankingTop20.find((row) => row.docId === 'truth-doc')?.rank, 1);
    assert.equal(p.cappedDocSources.some((sources) => sources.includes('publicPath')), false);
  }
});

// §18 era-iteration fix pin (mode-2 refutation): under an ADVERSARIAL reranker
// that ranks the routed terminal LOWEST and the high-cosine distractors highest
// (the real-Qwen failure mode where admission alone moved nothing), the
// program-derived ranking bias must still promote the routed terminal into
// topB — and ZERO_STATE, which routes nothing, must get NO bias and NOT admit
// or promote it. This is the causal pin for BMU_V2_PROGRAM_ROUTE_BONUS_UNITS.
test('regression: program-derived rank bias promotes routed terminal under adversarial Qwen; ZERO_STATE gets none', async () => {
  const corpus = corpusFor('causes', 'supports');
  const pack = { epochId: 0, evalSeedCommit: `0x${'71'.repeat(32)}`, events: [corpus.events[0]] };
  // Adversarial reranker: routed truth scores the FLOOR, distractors the CEIL.
  const adversarial = {
    ...scoringOptions(),
    reranker: {
      model: 'adversarial-anti-truth',
      async score(pairs) {
        return pairs.map((pair) => (pair.document.includes('confirmed and in force') ? 0.02 : 0.98));
      },
    },
  };
  const parent = await evaluateRetrievalBenchmarkState(ZERO_STATE, corpus, pack, adversarial);
  const candidateState = { words: new Array(1024).fill(0n) };
  const program = encodeBmuPublicPathProgramWords({
    programIndex: 0, queryKey: bmuOperationQueryKey('refutation executable route'), branchLimit: 4,
    validFromEpoch: 0n, expiryEpoch: 0n,
    steps: [{ direction: 'outgoing', edgeType: 'causes' }, { direction: 'incoming', edgeType: 'supports' }],
  });
  for (let i = 0; i < 4; i++) candidateState.words[RANGES.POLICY_EVIDENCE_START + i] = program[i];
  const candidate = await evaluateRetrievalBenchmarkState(candidateState, corpus, pack, adversarial);
  const p = parent.perQuery[0];
  const c = candidate.perQuery[0];
  // ZERO_STATE: no program, no routed terminal, no bias, no admission.
  assert.equal(p.cappedDocIds.indexOf('truth-doc'), -1, 'blank state does not admit the terminal');
  assert.equal(p.cappedDocSources.some((sources) => sources.includes('publicPath')), false);
  // Candidate: terminal admitted via publicPath AND promoted to rank 1 by the
  // program-derived bias, DESPITE the reranker scoring it lowest.
  const candidateTruthIndex = c.cappedDocIds.indexOf('truth-doc');
  assert.notEqual(candidateTruthIndex, -1, 'candidate admits the routed terminal');
  assert.ok(c.cappedDocSources[candidateTruthIndex].includes('publicPath'));
  const truthRow = c.finalRankingTop20.find((row) => row.docId === 'truth-doc');
  assert.ok(truthRow, 'routed terminal reaches the final ranking');
  // The program routes all four branch docs (truth + 3 decoys) as terminals;
  // every routed terminal is promoted ABOVE all 70 high-cosine distractors by
  // the bias, so truth enters the top-4 despite the reranker ranking it last.
  assert.ok(truthRow.rank <= 4, `routed terminal promoted into top-4 by bias (rank ${truthRow.rank})`);
  // The bias is the ONLY reason it outranks the distractors: its raw reranker
  // score is the floor, yet it clears every non-routed high-cosine distractor.
  assert.ok(truthRow.rerankerScore < 0.5, 'terminal was reranked at the floor (bias, not Qwen, promoted it)');
  const top4 = c.finalRankingTop20.filter((row) => row.rank <= 4).map((row) => row.docId);
  assert.deepEqual(new Set(top4), new Set(['truth-doc', 'decoy-a-doc', 'decoy-b-doc', 'decoy-c-doc']),
    'the four routed terminals occupy ranks 1-4, above every non-routed distractor');
});

const splitOf = makeCanonicalSplitOf({ splitForRecord, liveTailQueryId, corpusEpoch: 136 });
const publicDocs = (docs) => JSON.parse(JSON.stringify(docs));

function attackerRanking(allDocIds, preferredIds, forbiddenIds) {
  const preferred = new Set(preferredIds);
  const forbidden = new Set(forbiddenIds);
  return [
    ...preferredIds,
    ...allDocIds.filter((id) => !preferred.has(id) && !forbidden.has(id)).sort(),
    ...forbiddenIds,
  ].map((docId, index) => ({ docId, score: -index }));
}

test('regression: known public generator seed cannot reverse keyed multi-hop answer/trap ids', () => {
  const seed = 'known-generator-seed-multi';
  const docIdKeyHex = `0x${'c1'.repeat(32)}`;
  const attackerKeyHex = `0x${'d2'.repeat(32)}`;
  const epoch = 152;
  const out = generateMultiHopClusters({
    epoch, seed, docIdKeyHex,
    subjects: [{ id: 'e_public_multi_subject', canonicalName: 'Public Multi Subject', aliases: ['PMS'] }],
    universe: 'e_public_universe', clusterCount: 1, splitOf,
    // Escalation 2 mints a second balanced path group, leaving enough safe
    // documents to fill B=4 after the attacker excludes all six traps.
    escalation: { baseEpoch: epoch - 8 }, operationClassSlotOffset: 0,
  });
  const cluster = out.clusters[0];
  const docs = publicDocs(cluster.docs);
  const ordinalToken = docs.map((doc) => doc.text.match(new RegExp(`${epoch}r(\\d+)`))).find(Boolean);
  assert.ok(ordinalToken, 'ordinal is recoverable from public document text');
  const ordinal = Number(ordinalToken[1]);
  const subjectEntityId = cluster.rows[0].subjectEntityId;
  const motifGroupId = `mg_e${epoch}_multi_hop_${String(ordinal).padStart(4, '0')}_${subjectEntityId}`;
  const attackerId = (slot) => opaqueBmuDocId({ docIdKeyHex: attackerKeyHex, seed, epoch, motifGroupId, slot });
  const attackerRequired = [attackerId('chain_hop1'), attackerId('chain_answer')];
  const attackerForbidden = [
    attackerId('offpath_decoy'), attackerId('near_bridge_decoy'),
    attackerId('offpath_shadow:0'), attackerId('offpath_shadow:1'),
    attackerId('path_balance_decoy:0'), attackerId('path_balance_decoy:1'),
    attackerId('path_balance_decoy:2'),
  ];
  const ranking = attackerRanking(docs.map((doc) => doc.id), attackerRequired, attackerForbidden);
  assert.ok(cluster.rows.every((row) => !judgeTopB(ranking, row.bmuTask).judgeSuccess));
  assert.ok([...attackerRequired, ...attackerForbidden].every((id) => !docs.some((doc) => doc.id === id)));
  const privateId = (slot) => opaqueBmuDocId({ docIdKeyHex, seed, epoch, motifGroupId, slot });
  const required = [privateId('chain_hop1'), privateId('chain_answer')];
  const forbidden = [
    privateId('offpath_decoy'), privateId('near_bridge_decoy'),
    privateId('offpath_shadow:0'), privateId('offpath_shadow:1'),
    privateId('path_balance_decoy:0'), privateId('path_balance_decoy:1'),
    privateId('path_balance_decoy:2'),
  ];
  const positive = attackerRanking(docs.map((doc) => doc.id), required, forbidden);
  assert.ok(cluster.rows.every((row) => judgeTopB(positive, row.bmuTask).judgeSuccess), 'private-key positive control');
  assert.deepEqual(new Set(required), new Set(cluster.rows[0].bmuTask.requiredEvidence));
  assert.deepEqual(new Set(forbidden), new Set(cluster.rows[0].bmuTask.forbiddenEvidence));
});

test('regression: known public generator seed cannot reverse keyed near-collision identities', () => {
  const seed = 'known-generator-seed-near';
  const docIdKeyHex = `0x${'e3'.repeat(32)}`;
  const attackerKeyHex = `0x${'f4'.repeat(32)}`;
  const epoch = 152;
  const out = generateNearCollisionAbstentionClusters({
    epoch, seed, docIdKeyHex,
    subjects: [{ id: 'e_public_near_subject', canonicalName: 'Public Near Subject', aliases: ['PNS'] }],
    registry: createM1Registry(), splitOf, clusterCount: 1, escalationLevel: 0,
    ownerEntityId: 'e_public_universe', rotationBaseEpoch: epoch,
    operationClassSlotOffset: 0,
  });
  const cluster = out.clusters[0];
  const docs = publicDocs(out.addedDocs.filter((doc) => cluster.docIds.includes(doc.id)));
  const pivot = docs.map((doc) => doc.text.match(/registry pivot (\d+)-(\d+)-/)).find(Boolean);
  assert.ok(pivot, 'epoch and cluster slot are recoverable from public pivot text');
  const publicEpoch = Number(pivot[1]);
  const clusterSlot = Number(pivot[2]);
  const motifGroupId = `mg_e${publicEpoch}_nearcol_${String(clusterSlot).padStart(4, '0')}`;
  const attackerId = (slot) => opaqueBmuDocId({ docIdKeyHex: attackerKeyHex, seed, epoch: publicEpoch, motifGroupId, slot });
  const attackerPreferred = [attackerId('exact_match'), attackerId('disambiguation_record')];
  const attackerForbidden = [attackerId('alias_collision_decoy:0'), attackerId('attribute_lookalike_decoy:0'), attackerId('scope_lookalike_decoy:0')];
  const matchedAttackerIds = [...attackerPreferred, ...attackerForbidden]
    .filter((id) => docs.some((doc) => doc.id === id));
  const ranking = matchedAttackerIds.map((docId, index) => ({ docId, score: -index }));
  const answerableRows = out.addedQueries.filter((row) => row.bmuTask.abstain !== true);
  const successRate = answerableRows.filter((row) => judgeTopB(ranking, row.bmuTask).judgeSuccess).length / out.addedQueries.length;
  assert.equal(successRate, 0, 'known-seed/wrong-key id attacker must solve zero rows');
  assert.deepEqual(matchedAttackerIds, []);
  const privateId = (slot) => opaqueBmuDocId({ docIdKeyHex, seed, epoch: publicEpoch, motifGroupId, slot });
  const preferred = [privateId('exact_match'), privateId('disambiguation_record')];
  const forbidden = [privateId('alias_collision_decoy:0'), privateId('attribute_lookalike_decoy:0'), privateId('scope_lookalike_decoy:0')];
  const positive = attackerRanking(docs.map((doc) => doc.id), preferred, forbidden);
  const positiveRate = answerableRows.filter((row) => judgeTopB(positive, row.bmuTask).judgeSuccess).length / out.addedQueries.length;
  assert.equal(positiveRate, 0.8, 'private-key positive control solves all four answerable rows');
  assert.equal(preferred.includes(cluster.truthDocId), true);
  assert.ok(cluster.forbiddenEvidenceAnswerable.every((docId) => forbidden.includes(docId)));
});
