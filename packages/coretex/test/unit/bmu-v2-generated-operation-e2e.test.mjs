import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BMU_V2_PUBLIC_PATH_BUNDLE,
  CORETEX_PIPELINE_VERSION_BMU_V2,
  DEFAULT_PROFILE,
  applyPatch,
  bmuOperationQueryKey,
  buildBmuPublicPathProgramPatch,
  computeCorpusRoot,
  decodeBmuPublicPathPrograms,
  evaluateBmuBenchmarkState,
} from '../../dist/index.js';
import { buildCombinedSample } from '../../../../scripts/lib/bmu-generators/cross-family-checks.mjs';

const LAYOUT = { dim: 8, headerBytes: 9, quantization: 'int8' };
const MODEL_ID = 'test/generated-bmu-operation';
const REVISION = 'candidate-causality-v1';
const DOC_ID_MASTER_KEY = `0x${'91'.repeat(32)}`;
const HIGH = [1, 0, 0, 0, 0, 0, 0, 0];
const MEDIUM = [0.8, 0.6, 0, 0, 0, 0, 0, 0];
const LOW = [0, 1, 0, 0, 0, 0, 0, 0];

function quantize(values) {
  const bytes = new Uint8Array(4 + values.length);
  new DataView(bytes.buffer).setFloat32(0, 1, false);
  for (let i = 0; i < values.length; i++) bytes[4 + i] = Math.round(values[i] * 127) & 0xff;
  return bytes;
}

function corpusEvent(doc, vector, relations) {
  return {
    id: doc.id,
    family: 'generic', domain: 'generated-gb17', split: 'train_visible', queryText: doc.text,
    truthDocuments: [{ id: doc.id, text: doc.text, isCurrent: true }], hardNegatives: [], qrels: [],
    protected: false,
    relations: relations.map((relation) => ({ other_id: relation.dst, edgeType: relation.type })),
    provenance: { source: 'synthetic_challenge', sourceHash: `0x${'11'.repeat(32)}` },
    embeddings: {
      modelId: MODEL_ID, revision: REVISION, layout: LAYOUT,
      query: quantize(vector), perTruth: new Map([[doc.id, quantize(vector)]]), perNegative: new Map(),
    },
  };
}

function intersection(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function operationTerminalIds(cluster) {
  return new Set([
    ...(cluster.publicPath?.terminalBranchIds ?? []),
    ...(cluster.pathGroups ?? []).flatMap((group) => group.branchIds
      ?? [group.truthId, ...(group.decoyIds ?? [])].filter(Boolean)),
  ]);
}

function generatedPairFixture(family, lane) {
  const clusters = lane.clusters.slice(0, 2);
  assert.equal(clusters.length, 2, `${family}: paired fixture exists`);
  assert.equal(clusters[0].bmuOperationCue, clusters[1].bmuOperationCue, `${family}: pair shares cue`);
  assert.deepEqual(clusters[0].bmuOperationProgram, clusters[1].bmuOperationProgram, `${family}: pair shares bytecode`);
  assert.equal(clusters[0].operationClass, clusters[1].operationClass, `${family}: pair shares executable class`);
  assert.notEqual(clusters[0].subjectEntityId, clusters[1].subjectEntityId, `${family}: pair subjects are I6-disjoint`);
  assert.deepEqual(intersection(clusters[0].templateIds, clusters[1].templateIds), [], `${family}: pair templates are I6-disjoint`);
  assert.deepEqual(intersection(clusters[0].entityHoldoutKeys, clusters[1].entityHoldoutKeys), [],
    `${family}: pair entity holdouts are I6-disjoint`);

  const clusterDocIds = new Set(clusters.flatMap((cluster) => cluster.docIds ?? cluster.docs.map((doc) => doc.id)));
  const docs = lane.docs.filter((doc) => clusterDocIds.has(doc.id));
  const relations = lane.relations.filter((relation) =>
    clusterDocIds.has(relation.src) && clusterDocIds.has(relation.dst));
  const seedIds = new Set(clusters.flatMap((cluster) => [
    ...(cluster.publicPath?.seedId ? [cluster.publicPath.seedId] : []),
    ...(cluster.pathGroups ?? []).map((group) => group.anchorId),
  ]));
  assert.ok(seedIds.size >= 2, `${family}: generated pair exposes public anchors`);
  const bySrc = new Map();
  for (const relation of relations) {
    const list = bySrc.get(relation.src) ?? [];
    list.push(relation);
    bySrc.set(relation.src, list);
  }
  const events = docs.map((doc) => corpusEvent(doc, seedIds.has(doc.id) ? HIGH : LOW, bySrc.get(doc.id) ?? []));
  events.push(...Array.from({ length: 70 }, (_, index) => corpusEvent({
    id: `noise-${family}-${index}`,
    text: `high cosine unrelated generated-row distractor ${family} ${index}`,
  }, MEDIUM, [])));
  const corpus = {
    events,
    byId: new Map(events.map((event) => [event.id, event])),
    corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: MODEL_ID, biEncoderRevision: REVISION, biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'test/qwen', labelingModelRevision: 'q'.repeat(40),
  };
  const docById = new Map(docs.map((doc) => [doc.id, doc]));
  const semanticsByQuery = new Map();
  const operationRequiredByQuery = [];
  const queries = clusters.map((cluster, pairIndex) => {
    const terminals = operationTerminalIds(cluster);
    const rows = cluster.rows ?? lane.rows.filter((row) => row.bmuTask.motifGroupId === cluster.motifGroupId);
    const candidates = rows
      .filter((candidate) => candidate.bmuTask.abstain !== true
        && candidate.bmuTask.requiredEvidence.some((id) => terminals.has(id)))
      .sort((a, b) => a.bmuTask.requiredEvidence.length - b.bmuTask.requiredEvidence.length);
    const row = candidates[0];
    assert.ok(row, `${family}: paired cluster ${pairIndex} has an answerable operation-dependent row`);
    const required = new Set(row.bmuTask.requiredEvidence);
    const forbidden = new Set(row.bmuTask.forbiddenEvidence);
    const operationRequired = new Set([...required].filter((id) => terminals.has(id)));
    assert.ok(operationRequired.size > 0, `${family}: row ${pairIndex} requires a terminal produced by the operation`);
    const query = {
      id: `query-${family}-${pairIndex}`,
      family: family === 'near_collision_abstention' ? 'near_collision' : family,
      logicalFamily: row.family,
      domain: 'generated-gb17', split: 'eval_hidden', queryText: row.queryText,
      truthDocuments: [...required].map((id) => ({ id, text: docById.get(id).text, isCurrent: true })),
      hardNegatives: [...forbidden].filter((id) => docById.has(id)).map((id) => ({ id, text: docById.get(id).text })),
      qrels: (row.qrels ?? []).map((qrel) => ({ documentId: qrel.docId, relevance: qrel.relevance })),
      protected: false,
      bmuOperationCue: row.bmuOperationCue,
      bmuOperationProgram: row.bmuOperationProgram,
      bmuTask: row.bmuTask,
      provenance: { source: 'synthetic_challenge', sourceHash: `0x${'22'.repeat(32)}` },
      embeddings: {
        modelId: MODEL_ID, revision: REVISION, layout: LAYOUT,
        query: quantize(HIGH),
        perTruth: new Map([...required].map((id) => [id, quantize(LOW)])),
        perNegative: new Map([...forbidden].filter((id) => docById.has(id)).map((id) => [id, quantize(LOW)])),
      },
    };
    semanticsByQuery.set(query.queryText, {
      requiredTexts: [...required].map((id) => docById.get(id).text),
      forbiddenTexts: [...forbidden].filter((id) => docById.has(id)).map((id) => docById.get(id).text),
    });
    operationRequiredByQuery.push(operationRequired);
    return query;
  });
  return { clusters, corpus, queries, operationRequiredByQuery, semanticsByQuery };
}

function scoringOptions(semanticsByQuery) {
  return {
    weights: DEFAULT_PROFILE.compositeWeights,
    retrievalKeyLayout: LAYOUT,
    biEncoder: { model: { id: MODEL_ID, revision: REVISION }, async encode() { return new Float32Array(8); } },
    reranker: { model: 'generated-semantic-reader', async score(pairs) {
      return pairs.map(({ query, document }) => {
        const { requiredTexts, forbiddenTexts } = semanticsByQuery.get(query);
        const semanticDocument = document.startsWith('Path 0:') ? document.split('\n').at(-1) : document;
        if (requiredTexts.some((text) => semanticDocument.includes(text))) return 0.99;
        if (forbiddenTexts.some((text) => semanticDocument.includes(text))) return 0.01;
        return 0.1;
      });
    } },
    biEncoderHash: '0x01020304', relationHopBudget: 0, abstentionThreshold: 0,
    rerankerTopK: 10, firstStageTopK: 16, rerankerInputTopK: 64, lensTopK: 1,
    lensWeight: 0, anchorWeight: 0, relationExpansionBudget: 0,
    temporalCurrentBoost: 0, temporalStaleSuppression: 0,
    exposeFullRanking: true, policyAtomsMode: true,
    pipelineVersion: CORETEX_PIPELINE_VERSION_BMU_V2,
    bmuPublicPathBundle: BMU_V2_PUBLIC_PATH_BUNDLE,
  };
}

test('exact generated programs transfer across I6 pairs while same-cue temporal/conflict shortcut bodies stay inert', async () => {
  const { families } = buildCombinedSample(undefined, { docIdMasterKeyHex: DOC_ID_MASTER_KEY });
  let familyIndex = 0;
  let sameCueWrongBodyFamilies = 0;
  for (const [family, lane] of Object.entries(families)) {
    const { clusters, corpus, queries, operationRequiredByQuery, semanticsByQuery } = generatedPairFixture(family, lane);
    const pack = { epochId: 152, evalSeedCommit: `0x${String(familyIndex + 1).padStart(64, '0')}`, events: queries };
    const zero = { words: new Array(1024).fill(0n) };
    const obsoletePatch = buildBmuPublicPathProgramPatch({
      parent: zero,
      operationCue: `${queries[0].bmuOperationCue} obsolete`,
      operationProgram: queries[0].bmuOperationProgram,
      programSlot: familyIndex,
    });
    const obsolete = applyPatch(zero, obsoletePatch, true);
    assert.equal(obsolete.ok, true);
    const patch = buildBmuPublicPathProgramPatch({
      parent: obsolete.state,
      operationCue: queries[0].bmuOperationCue,
      operationProgram: queries[0].bmuOperationProgram,
      programSlot: familyIndex,
    });
    assert.equal(patch.wordCount, 4);
    assert.deepEqual(patch.indices, Array.from({ length: 4 }, (_, offset) => 384 + familyIndex * 4 + offset));
    const applied = applyPatch(obsolete.state, patch, true);
    assert.equal(applied.ok, true);
    let sameCueWrongBodyState = null;
    let sameCueWrongBodyLabel = null;
    if (family === 'temporal' || family === 'conflict_lifecycle') {
      const shortcutEdge = family === 'temporal' ? 'supersedes' : 'derived_from';
      for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
        const seedId = clusters[queryIndex].publicPath.seedId;
        const incomingShortcutSources = new Set(lane.relations
          .filter((relation) => relation.dst === seedId && relation.type === shortcutEdge)
          .map((relation) => relation.src));
        assert.ok([...operationRequiredByQuery[queryIndex]].some((id) => incomingShortcutSources.has(id)),
          `${family}: one-step incoming:${shortcutEdge} is a real emitted-row shortcut counterexample`);
      }
      const wrongBodyProgram = {
        branchLimit: 4,
        steps: [{ direction: 'incoming', edgeType: shortcutEdge }],
      };
      const wrongBodyPatch = buildBmuPublicPathProgramPatch({
        parent: zero,
        operationCue: queries[0].bmuOperationCue,
        // These real-generator shortcuts were executable under cue-only
        // binding because they skip the advertised outgoing step.
        operationProgram: wrongBodyProgram,
        programSlot: familyIndex,
      });
      const wrongBody = applyPatch(zero, wrongBodyPatch, true);
      assert.equal(wrongBody.ok, true);
      const decodedWrongBody = decodeBmuPublicPathPrograms(wrongBody.state).programs[0];
      assert.equal(decodedWrongBody.queryKey, bmuOperationQueryKey(queries[0].bmuOperationCue),
        `${family}: negative control deliberately shares the exact cue key`);
      assert.deepEqual(decodedWrongBody.steps, wrongBodyProgram.steps);
      assert.notDeepEqual(decodedWrongBody.steps, queries[0].bmuOperationProgram.steps);
      sameCueWrongBodyState = wrongBody.state;
      sameCueWrongBodyLabel = `same-cue/wrong-body incoming:${shortcutEdge}`;
      sameCueWrongBodyFamilies += 1;
    }
    const opts = scoringOptions(semanticsByQuery);
    const [blankScore, parentScore, candidateScore, sameCueWrongBodyScore] = await Promise.all([
      evaluateBmuBenchmarkState(zero, corpus, pack, opts),
      evaluateBmuBenchmarkState(obsolete.state, corpus, pack, opts),
      evaluateBmuBenchmarkState(applied.state, corpus, pack, opts),
      sameCueWrongBodyState === null
        ? Promise.resolve(null)
        : evaluateBmuBenchmarkState(sameCueWrongBodyState, corpus, pack, opts),
    ]);
    const inertScores = [['ZERO_STATE', blankScore], ['parent', parentScore]];
    if (sameCueWrongBodyScore !== null) inertScores.push([sameCueWrongBodyLabel, sameCueWrongBodyScore]);
    for (const [label, score] of inertScores) {
      assert.equal(score.perQuery.some((result) => result.cappedDocSources.some((sources) => sources.includes('publicPath'))),
        false, `${family}:${label}: no executable public-path source`);
      for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
        const result = score.perQuery[queryIndex];
        const operationRequired = operationRequiredByQuery[queryIndex];
        assert.ok([...operationRequired].every((id) => !result.cappedDocIds.includes(id)),
          `${family}:${label}: operation-caused terminal is not admitted`);
        assert.ok([...operationRequired].every((id) => !result.finalRankingTop20.some((entry) => entry.docId === id)),
          `${family}:${label}: operation-caused terminal is not ranked`);
        assert.equal(score.bmu.perTask[queryIndex].utility, 0, `${family}:${label}: generated row fails the BMU judge`);
      }
    }
    for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
      const candidate = candidateScore.perQuery[queryIndex];
      const operationRequired = operationRequiredByQuery[queryIndex];
      assert.ok([...operationRequired].every((id) => candidate.cappedDocIds.includes(id)),
        `${family}: candidate admits operation terminal for disjoint row ${queryIndex}`);
      assert.ok([...operationRequired].every((id) =>
        candidate.cappedDocSources[candidate.cappedDocIds.indexOf(id)].includes('publicPath')),
      `${family}: exact candidate program is the causal source for disjoint row ${queryIndex}`);
      assert.ok([...operationRequired].every((id) => candidate.finalRankingTop20.some((entry) => entry.docId === id)),
        `${family}: semantic reader ranks generated terminal for disjoint row ${queryIndex}`);
      assert.equal(candidateScore.bmu.perTask[queryIndex].utility, 1,
        `${family}: four-word program makes disjoint row ${queryIndex} judge-success ${JSON.stringify(candidateScore.bmu.perTask[queryIndex])}`);
    }
    assert.equal(candidateScore.bmu.utilitySum, 2, `${family}: one patch transfers across both paired mints`);
    assert.equal(clusters[0].operationClass, clusters[1].operationClass);
    familyIndex += 1;
  }
  assert.equal(sameCueWrongBodyFamilies, 2, 'real emitted temporal and conflict wrong-body controls both executed');
});
