/**
 * BMU v1 task schema + loading (BMU_SPEC.md §4.1, §5.6, §6.7a):
 *   - validateBmuTaskOnEvent fail-closed rules (budget bounds, answer∈required,
 *     abstain shape, required∩forbidden, doc-id existence, family namespaces);
 *   - cross-row motifGroup family consistency;
 *   - serializer round-trip (bmuTask must survive serializeProductionCorpus's
 *     field allowlist — same trap class as the bridge);
 *   - logical-delta-bridge pass-through (§6.7a prerequisite 1): a stamped
 *     query's bmuTask must survive the bridge's explicit field allowlist so
 *     rows are root-committed with the task from birth;
 *   - bmuTask absence does not change canonical event leaf hashes (pre-flip
 *     inert-minting premise).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateBmuTaskOnEvent,
  validateBmuCorpusConsistency,
  bmuExclusionKeysForEvent,
  bmuFamilyForLogicalFamily,
  BMU_FAMILIES,
  computeCorpusEventLeafHash,
  serializeProductionCorpus,
  computeCorpusRoot,
  bridgeLogicalDeltaToProductionEvents,
  liveTailQueryId,
  splitForRecord,
} from '../../dist/index.js';

const DOC_IDS = new Set(['d1', 'd2', 'd3', 'trap1', 'trap2']);
const docIdExists = (id) => DOC_IDS.has(id);

function taskOf(overrides = {}) {
  return {
    family: 'temporal',
    budgetB: 3,
    requiredEvidence: ['d1', 'd2'],
    forbiddenEvidence: ['trap1'],
    answer: { id: 'd1', value: 'vegan' },
    motifGroupId: 'mg_e137_temporal_0042',
    templateId: 'tt_supersession_q7_v3',
    ...overrides,
  };
}

function eventOf(taskOverrides = {}, eventOverrides = {}) {
  return {
    id: 'zz_e000000000137_q_q1',
    family: 'temporal',
    split: 'eval_hidden',
    logicalFamily: 'temporal_update',
    subjectEntityId: 'ent_42',
    bmuTask: taskOf(taskOverrides),
    ...eventOverrides,
  };
}

describe('validateBmuTaskOnEvent (§4.1 fail-closed load rules)', () => {
  test('a well-formed answerable task validates clean', () => {
    assert.deepEqual(validateBmuTaskOnEvent(eventOf(), docIdExists), []);
  });

  test('a well-formed abstention task validates clean', () => {
    const e = eventOf({ abstain: true, requiredEvidence: [], answer: undefined, forbiddenEvidence: ['trap1', 'trap2'] },
      { family: 'near_collision', logicalFamily: 'abstention_missing' });
    e.bmuTask.family = 'near_collision_abstention';
    assert.deepEqual(validateBmuTaskOnEvent(e, docIdExists), []);
  });

  test('budgetB bounds: 0 and 9 fail, 1 and 8 pass', () => {
    assert.ok(validateBmuTaskOnEvent(eventOf({ budgetB: 0 }), docIdExists).length > 0);
    assert.ok(validateBmuTaskOnEvent(eventOf({ budgetB: 9 }), docIdExists).length > 0);
    assert.ok(validateBmuTaskOnEvent(eventOf({ budgetB: 2.5 }), docIdExists).length > 0);
    assert.deepEqual(validateBmuTaskOnEvent(eventOf({ budgetB: 8 }), docIdExists), []);
    assert.deepEqual(validateBmuTaskOnEvent(eventOf({ budgetB: 1, requiredEvidence: ['d1'] }), docIdExists), []);
  });

  test('answer.id must be a member of requiredEvidence', () => {
    const errors = validateBmuTaskOnEvent(eventOf({ answer: { id: 'd3' } }), docIdExists);
    assert.ok(errors.some((e) => e.includes("answer.id 'd3'")), errors.join('; '));
  });

  test('answer is required unless abstain=true', () => {
    assert.ok(validateBmuTaskOnEvent(eventOf({ answer: undefined }), docIdExists).length > 0);
  });

  test('requiredEvidence ∩ forbiddenEvidence must be empty', () => {
    const errors = validateBmuTaskOnEvent(eventOf({ forbiddenEvidence: ['d2'] }), docIdExists);
    assert.ok(errors.some((e) => e.includes('BOTH requiredEvidence and forbiddenEvidence')), errors.join('; '));
  });

  test('|requiredEvidence| must be <= budgetB', () => {
    const errors = validateBmuTaskOnEvent(eventOf({ budgetB: 1 }), docIdExists);
    assert.ok(errors.some((e) => e.includes('must be <= budgetB')), errors.join('; '));
  });

  test('abstain=true forbids requiredEvidence and answer', () => {
    assert.ok(validateBmuTaskOnEvent(eventOf({ abstain: true }), docIdExists).length > 0);
    assert.ok(validateBmuTaskOnEvent(eventOf({ abstain: true, requiredEvidence: [], answer: { id: 'd1' } }), docIdExists).length > 0);
  });

  test('requiredEvidence=[] is only legal when abstain=true', () => {
    const errors = validateBmuTaskOnEvent(eventOf({ requiredEvidence: [], answer: undefined }), docIdExists);
    assert.ok(errors.length > 0);
  });

  test('every referenced doc id must exist in the corpus', () => {
    const errors = validateBmuTaskOnEvent(eventOf({ forbiddenEvidence: ['ghost'] }), docIdExists);
    assert.ok(errors.some((e) => e.includes("'ghost' does not exist")), errors.join('; '));
  });

  test('motifGroupId and templateId must be non-empty', () => {
    assert.ok(validateBmuTaskOnEvent(eventOf({ motifGroupId: '' }), docIdExists).length > 0);
    assert.ok(validateBmuTaskOnEvent(eventOf({ templateId: undefined }), docIdExists).length > 0);
  });

  test('bmuTask on a non-eval_hidden row is refused', () => {
    const errors = validateBmuTaskOnEvent(eventOf({}, { split: 'train_visible' }), docIdExists);
    assert.ok(errors.some((e) => e.includes("split 'train_visible'")), errors.join('; '));
  });

  test('§5.6 namespace checks: bucketed family and logicalFamily must map to bmuTask.family', () => {
    // wrong bucketed family for a temporal task
    assert.ok(validateBmuTaskOnEvent(eventOf({}, { family: 'near_collision' }), docIdExists)
      .some((e) => e.includes('does not map to bmuTask.family')));
    // wrong logicalFamily for a temporal task
    assert.ok(validateBmuTaskOnEvent(eventOf({}, { logicalFamily: 'conflict_lifecycle' }), docIdExists)
      .some((e) => e.includes("logicalFamily 'conflict_lifecycle'")));
    // multi_hop maps from both multi_hop_relation AND the legacy coreference bucket
    const mh = eventOf({ family: 'multi_hop_relation' }, { family: 'coreference', logicalFamily: 'coreference_resolution' });
    assert.deepEqual(validateBmuTaskOnEvent(mh, docIdExists), []);
  });

  test('unknown family short-circuits with one error', () => {
    const errors = validateBmuTaskOnEvent(eventOf({ family: 'compression' }), docIdExists);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('not a BMU family'));
  });
});

describe('cross-row consistency + mappings', () => {
  test('motifGroupId spanning two families is refused', () => {
    const a = eventOf();
    const b = eventOf({ family: 'conflict_lifecycle', motifGroupId: 'mg_e137_temporal_0042' },
      { id: 'zz_e000000000137_q_q2', family: 'conflict_lifecycle', logicalFamily: 'conflict_lifecycle' });
    const errors = validateBmuCorpusConsistency([a, b]);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('spans families'));
  });

  test('bmuFamilyForLogicalFamily covers the §5.6 table and rejects non-BMU families', () => {
    assert.equal(bmuFamilyForLogicalFamily('temporal_update'), 'temporal');
    assert.equal(bmuFamilyForLogicalFamily('conflict_lifecycle'), 'conflict_lifecycle');
    for (const lf of ['multi_session_bridge', 'causal_memory_chain', 'decision_provenance', 'coreference_resolution']) {
      assert.equal(bmuFamilyForLogicalFamily(lf), 'multi_hop_relation');
    }
    for (const lf of ['abstention_missing', 'entity_resolution_atom', 'scope_atom', 'validity_atom']) {
      assert.equal(bmuFamilyForLogicalFamily(lf), 'near_collision_abstention');
    }
    assert.equal(bmuFamilyForLogicalFamily('aspect_constraint'), null);
    assert.equal(bmuFamilyForLogicalFamily(undefined), null);
    assert.equal(BMU_FAMILIES.length, 4);
  });

  test('bmuExclusionKeysForEvent emits namespaced motif/subject/template keys', () => {
    assert.deepEqual([...bmuExclusionKeysForEvent(eventOf())].sort(), [
      'motif:mg_e137_temporal_0042',
      'subject:ent_42',
      'template:tt_supersession_q7_v3',
    ]);
    // No subjectEntityId → only two keys (never an 'undefined' key).
    const noSubject = eventOf({}, { subjectEntityId: undefined });
    assert.equal(bmuExclusionKeysForEvent(noSubject).length, 2);
  });
});

// ─── Canonical-hash + serializer + bridge integration ─────────────────────────

const LAYOUT = { dim: 8, headerBytes: 9, quantization: 'int8' };

function fullEvent(id, { bmuTask } = {}) {
  return {
    id,
    family: 'temporal',
    domain: 'd',
    split: 'eval_hidden',
    queryText: `q ${id}`,
    truthDocuments: [{ id: `${id}-t`, text: 't', isCurrent: true }],
    hardNegatives: [],
    qrels: [{ documentId: `${id}-t`, relevance: 1 }],
    protected: false,
    logicalFamily: 'temporal_update',
    subjectEntityId: 'ent_1',
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) },
    ...(bmuTask ? { bmuTask } : {}),
    embeddings: {
      modelId: 'm',
      revision: 'r',
      layout: LAYOUT,
      query: new Uint8Array(4 + 8).fill(7),
      perTruth: new Map([[`${id}-t`, new Uint8Array(4 + 8).fill(9)]]),
      perNegative: new Map(),
    },
  };
}

describe('bmuTask canonical hashing + serialization (§6.7a inert-minting premise)', () => {
  test('an ABSENT bmuTask key does not change the canonical event leaf hash', () => {
    const bare = fullEvent('e1');
    const spreadCopy = { ...bare }; // same fields, no bmuTask key
    assert.deepEqual(computeCorpusEventLeafHash(bare), computeCorpusEventLeafHash(spreadCopy));
  });

  test('a PRESENT bmuTask is committed into the leaf hash (root commits from birth)', () => {
    const bare = fullEvent('e1');
    const stamped = fullEvent('e1', {
      bmuTask: {
        family: 'temporal', budgetB: 3, requiredEvidence: ['e1-t'], forbiddenEvidence: [],
        answer: { id: 'e1-t' }, motifGroupId: 'mg1', templateId: 'tt1',
      },
    });
    assert.notDeepEqual(computeCorpusEventLeafHash(bare), computeCorpusEventLeafHash(stamped));
  });

  test('serializeProductionCorpus round-trips bmuTask (allowlist trap closed)', () => {
    const stamped = fullEvent('e1', {
      bmuTask: {
        family: 'temporal', budgetB: 3, requiredEvidence: ['e1-t'], forbiddenEvidence: [],
        answer: { id: 'e1-t' }, motifGroupId: 'mg1', templateId: 'tt1',
      },
    });
    const corpus = {
      events: [stamped],
      byId: new Map([[stamped.id, stamped]]),
      corpusRoot: computeCorpusRoot([stamped]),
      corpusEpoch: 0,
      biEncoderModelId: 'm',
      biEncoderRevision: 'r',
      biEncoderRetrievalKeyLayout: LAYOUT,
      labelingModelId: 'lm',
      labelingModelRevision: 'lr',
    };
    const onDisk = serializeProductionCorpus(corpus);
    assert.deepEqual(onDisk.events[0].bmuTask, stamped.bmuTask);
  });
});

describe('logical-delta-bridge bmuTask pass-through (§6.7a prerequisite 1)', () => {
  test('a stamped added query carries its bmuTask through the bridge allowlist', () => {
    const epoch = 137;
    const qid = 'q_e137_x1';
    // Grind for a query id whose production id lands in eval_hidden (the
    // minter's Stage-3 G0A obligation); the bridge derives split from the id.
    let queryId = qid;
    for (let i = 0; i < 512; i++) {
      const cand = `q_e137_x${i}`;
      if (splitForRecord(liveTailQueryId(cand, epoch), 0) === 'eval_hidden') { queryId = cand; break; }
    }
    const prodId = liveTailQueryId(queryId, epoch);
    assert.equal(splitForRecord(prodId, 0), 'eval_hidden', 'fixture grind failed to land eval_hidden');

    const docId = 'd_e137_doc1';
    const previousCorpus = {
      events: [],
      byId: new Map(),
      corpusRoot: '0x' + '11'.repeat(32),
      corpusEpoch: 0,
      biEncoderModelId: 'm',
      biEncoderRevision: 'r',
      biEncoderRetrievalKeyLayout: LAYOUT,
      labelingModelId: 'lm',
      labelingModelRevision: 'lr',
    };
    const bmuTask = {
      family: 'temporal', budgetB: 3, requiredEvidence: [docId], forbiddenEvidence: [],
      answer: { id: docId, value: 'v' }, motifGroupId: 'mg_e137_temporal_0001', templateId: 'tt_supersession_q1_v1',
    };
    const emb = new Uint8Array(4 + 8).fill(3);
    const events = bridgeLogicalDeltaToProductionEvents({
      previousCorpus,
      logicalDelta: {
        epoch,
        seed: 's',
        churnFraction: 0,
        addedDocs: [{ id: docId, lane: 'temporal_update', text: 'doc text', currentStaleFlag: false }],
        addedRelations: [],
        addedQueries: [{
          id: queryId,
          lane: 'temporal_update',
          family: 'temporal_update',
          queryText: 'what is current?',
          qrels: [{ docId, relevance: 1 }],
          subjectEntityId: 'ent_9',
          liveUpdateEpoch: epoch,
          bmuTask,
        }],
        churnedSubjects: [],
        liveChurnRate: 0,
      },
      addedDocEmbeddings: new Map([[docId, emb]]),
      addedQueryEmbeddings: new Map([[queryId, emb]]),
      biEncoder: { modelId: 'm', revision: 'r', layout: LAYOUT },
    });
    const qEvent = events.find((e) => e.id === prodId);
    assert.ok(qEvent, `bridged query event ${prodId} missing`);
    assert.deepEqual(qEvent.bmuTask, bmuTask);
    assert.equal(qEvent.logicalFamily, 'temporal_update');
    // An unstamped query stays unstamped (no empty-object stamping).
    const events2 = bridgeLogicalDeltaToProductionEvents({
      previousCorpus,
      logicalDelta: {
        epoch, seed: 's', churnFraction: 0,
        addedDocs: [{ id: docId, lane: 'temporal_update', text: 'doc text', currentStaleFlag: false }],
        addedRelations: [],
        addedQueries: [{ id: queryId, lane: 'temporal_update', family: 'temporal_update', queryText: 'q', qrels: [{ docId, relevance: 1 }], liveUpdateEpoch: epoch }],
        churnedSubjects: [],
        liveChurnRate: 0,
      },
      addedDocEmbeddings: new Map([[docId, emb]]),
      addedQueryEmbeddings: new Map([[queryId, emb]]),
      biEncoder: { modelId: 'm', revision: 'r', layout: LAYOUT },
    });
    assert.equal(events2.find((e) => e.id === prodId).bmuTask, undefined);
  });
});
