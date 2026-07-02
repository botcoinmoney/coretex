/**
 * Fix B — evolveCorpusDelta: deterministic live-update churn fuel.
 * CPU gates (the production embedding + corpusRoot-replay gate is the A100/pipeline step):
 *   - replay determinism: same (base, epoch, seed) → byte-identical delta;
 *   - live_churn_rate > 0 and tracks churnFraction;
 *   - distinct epochs produce distinct (new) structure;
 *   - delta queries are subject-grounded (subjectEntityId) and supersede/contradict held facts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { evolveCorpusDelta } from '../../../../scripts/lib/evolve-corpus.mjs';
import {
  applyCorpusDelta,
  bridgeLogicalDeltaToProductionEvents,
  buildCorpusDelta,
  buildCorpusRootLeafCache,
  computeCorpusRoot,
  expectedSplitForRecord,
  isMemoryDocumentEventId,
  liveTailQueryId,
  parseCorpusDelta,
  serializeCorpusDelta,
  signCorpusDelta,
  splitForRecord,
  verifyCorpusDeltaSignature,
} from '../../dist/index.js';

// minimal base logical corpus: 1 universe + 40 subjects, each with one prior temporal doc.
const baseLogical = {
  entities: [
    { id: 'e_universe', canonicalName: 'Deep Memory Universe 0', aliases: [] },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `e_universe_s${i}`, canonicalName: i % 3 === 0 ? `svc-${i}-pipeline-svc-${i}` : `First${i} Last${i}`, aliases: [] })),
  ],
  docs: Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, kind: 'temporal_city', entityIds: ['e_universe', `e_universe_s${i}`], currentStaleFlag: false, text: 'prior' })),
  relations: [],
  queries: [],
};

describe('Fix B — evolveCorpusDelta (deterministic live-update churn)', () => {
  test('replay determinism: same inputs → byte-identical delta', () => {
    const a = evolveCorpusDelta({ baseLogical, epoch: 3, seed: 'launch-frontier', churnFraction: 0.25 });
    const b = evolveCorpusDelta({ baseLogical, epoch: 3, seed: 'launch-frontier', churnFraction: 0.25 });
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });

  test('live_churn_rate > 0 and approximates churnFraction', () => {
    const d = evolveCorpusDelta({ baseLogical, epoch: 1, seed: 's', churnFraction: 0.25 });
    assert.ok(d.liveChurnRate > 0, 'live churn must be > 0 (the static-corpus failure was ~0)');
    assert.ok(d.churnedSubjects.length >= 4 && d.churnedSubjects.length <= 18, `~25% of 40 expected, got ${d.churnedSubjects.length}`);
    assert.ok(d.addedDocs.length > 0 && d.addedQueries.length > 0);
  });

  test('distinct epochs produce distinct new structure (fresh minable work each epoch)', () => {
    const e1 = evolveCorpusDelta({ baseLogical, epoch: 1, seed: 's', churnFraction: 0.5 });
    const e2 = evolveCorpusDelta({ baseLogical, epoch: 2, seed: 's', churnFraction: 0.5 });
    const ids1 = new Set(e1.addedDocs.map((d) => d.id));
    const overlap = e2.addedDocs.filter((d) => ids1.has(d.id));
    assert.equal(overlap.length, 0, 'epoch deltas must not collide on doc ids');
    assert.notEqual(JSON.stringify(e1.churnedSubjects), JSON.stringify(e2.churnedSubjects));
  });

  test('delta is subject-grounded and revises held facts (supersedes / contradicts)', () => {
    const d = evolveCorpusDelta({ baseLogical, epoch: 5, seed: 's', churnFraction: 1.0 });
    assert.ok(d.addedQueries.every((q) => typeof q.subjectEntityId === 'string' && q.subjectEntityId !== 'e_universe'), 'every delta query is subject-grounded');
    const edgeLabels = new Set(d.addedRelations.map((r) => r.label));
    assert.ok(edgeLabels.has('supersedes') || edgeLabels.has('contradicts'), 'delta must revise held facts via supersedes/contradicts edges');
    // supersedes edges point at a prior (held) doc id from the base corpus
    const baseDocIds = new Set(baseLogical.docs.map((x) => x.id));
    assert.ok(d.addedRelations.filter((r) => r.label === 'supersedes').every((r) => baseDocIds.has(r.dst)), 'supersedes targets a held base fact');
  });

  test('validity_atom churn is semantically honest about stale vs query-time current records', () => {
    const d = evolveCorpusDelta({ baseLogical: { ...baseLogical, queries: [{ id: 'q_atom_seed', family: 'validity_atom' }] }, epoch: 5, seed: 's', churnFraction: 1.0 });
    const stale = d.addedDocs.filter((doc) => doc.kind === 'atom_validity_fact' && doc.currentStaleFlag === false);
    const current = d.addedDocs.filter((doc) => doc.kind === 'atom_validity_fact' && doc.currentStaleFlag === true);
    assert.ok(stale.length > 0, 'test fixture must generate validity_atom stale records');
    assert.equal(stale.length, current.length * 5);
    for (const doc of stale) {
      assert.ok(doc.validity.validUntil, 'stale validity records must carry a closed valid-time interval');
      assert.ok(doc.validity.supersededBy, 'stale validity records must point at the superseding current doc');
      assert.ok(doc.validity.observedAt > doc.validity.validUntil, 'stale record should be an observed-time trap, not text-obvious stale data');
      assert.doesNotMatch(doc.text, /at query time/i);
      assert.doesNotMatch(doc.text, /current .* should be/i);
      assert.doesNotMatch(doc.text, /previously|ended before/i);
    }
    for (const doc of current) {
      assert.equal(doc.validity.validUntil, undefined);
      assert.ok(doc.validity.observedAt < doc.validity.validFrom, 'current record should be valid-time driven, not simply latest-observed text');
      assert.doesNotMatch(doc.text, /legacy|previously|ended before/i);
    }
    const docsById = new Map(d.addedDocs.map((doc) => [doc.id, doc]));
    for (const q of d.addedQueries.filter((query) => query.family === 'validity_atom')) {
      const queryTime = q.publicIntent.queryTime;
      const currentDoc = docsById.get(q.qrels.find((r) => r.role === 'direct').docId);
      const staleDoc = docsById.get(q.qrels.find((r) => r.role === 'stale').docId);
      const distractorDoc = docsById.get(q.qrels.find((r) => r.role === 'stale_distractor').docId);
      assert.equal(q.hardNegatives.length, 5, 'validity query should carry enough stale public distractors to be a real retrieval trap');
      assert.ok(currentDoc.validity.validFrom <= queryTime, 'current record must be valid at query time');
      assert.ok(!currentDoc.validity.validUntil || currentDoc.validity.validUntil >= queryTime, 'current record must not end before query time');
      assert.ok(staleDoc.validity.validUntil < queryTime, 'stale record must end before query time');
      assert.ok(distractorDoc.validity.validUntil < queryTime, 'stale distractor must also be invalid at query time');
    }
  });

  test('entity_resolution_atom churn grounds duplicate-name queries to the target entity id', () => {
    const duplicateBase = {
      ...baseLogical,
      entities: [
        ...baseLogical.entities,
        { id: 'e_dup_backend', canonicalName: 'Jordan Vale', aliases: ['Jordan Vale the API migration lead'], roleAliases: ['API migration lead', 'backend lead'] },
        { id: 'e_dup_design', canonicalName: 'Jordan Vale', aliases: ['Jordan Vale the design lead'], roleAliases: ['design lead'] },
      ],
      queries: [{ id: 'q_atom_seed', family: 'entity_resolution_atom' }],
    };
    let found = null;
    for (let epoch = 1; epoch <= 12 && !found; epoch++) {
      const d = evolveCorpusDelta({ baseLogical: duplicateBase, epoch, seed: 'entity-grounding', churnFraction: 1.0 });
      found = d.addedQueries.find((q) => q.family === 'entity_resolution_atom') ?? null;
      if (found) {
        const directId = found.qrels.find((r) => r.role === 'direct').docId;
        const wrongId = found.qrels.find((r) => r.role === 'wrong_entity_same_name').docId;
        const direct = d.addedDocs.find((doc) => doc.id === directId);
        const wrong = d.addedDocs.find((doc) => doc.id === wrongId);
        assert.equal(found.subjectEntityId, 'e_dup_backend');
        assert.equal(found.publicIntent.subjectEntityId, 'e_dup_backend');
        assert.ok(direct.entityIds.includes('e_dup_backend'));
        assert.ok(wrong.entityIds.includes('e_dup_design'));
        assert.ok(!wrong.entityIds.includes(found.subjectEntityId));
      }
    }
    assert.ok(found, 'test fixture must generate at least one entity_resolution_atom query');
  });

  test('v16 live churn supplies low-runway surface hard cases', () => {
    const atomBase = { ...baseLogical, queries: [{ id: 'q_atom_seed', family: 'validity_atom' }] };
    const totals = { coreference: 0, relation_lifecycle: 0, noise_suppression: 0, scope_atom: 0 };
    const samples = {};
    const relations = [];
    for (let epoch = 1; epoch <= 4; epoch++) {
      const d = evolveCorpusDelta({ baseLogical: atomBase, epoch, seed: 'low-surface-supply', churnFraction: 1.0 });
      relations.push(...d.addedRelations);
      for (const q of d.addedQueries) {
        if (!(q.family in totals)) continue;
        totals[q.family]++;
        samples[q.family] ??= { query: q, delta: d };
      }
    }

    for (const [family, count] of Object.entries(totals)) {
      assert.ok(count > 0, `${family} should have live evolve query supply`);
    }

    const coref = samples.coreference;
    assert.ok(coref.query.hardNegatives.length > 0, 'coreference query should have a plausible wrong-alias distractor');
    assert.ok(coref.query.qrels.some((r) => r.role === 'alias_bridge' && r.relevance === 0.6));
    assert.ok(relations.some((r) => r.type === 'coreference_of'), 'coreference docs should expose public coreference_of edges');

    const lifecycle = samples.relation_lifecycle;
    assert.ok(lifecycle.query.hardNegatives.some((n) => n.category === 'stale_relation_high_overlap'));
    assert.ok(relations.some((r) => r.type === 'supersedes'), 'relation_lifecycle docs should expose public supersedes edges');

    const noise = samples.noise_suppression;
    assert.ok(noise.query.hardNegatives.some((n) => n.category === 'lexical_distractor_exact_terms'));
    const noiseDocs = new Map(noise.delta.addedDocs.map((d) => [d.id, d]));
    const noiseHard = noiseDocs.get(noise.query.hardNegatives[0].docId);
    assert.match(noiseHard.text, /exact query wording|current approved owner/i);

    const scope = samples.scope_atom;
    const scopeDocs = new Map(scope.delta.addedDocs.map((d) => [d.id, d]));
    const wrongScopeDoc = scopeDocs.get(scope.query.hardNegatives[0].docId);
    assert.match(scope.query.queryText, /math project scope/);
    assert.match(wrongScopeDoc.text, /math project scope from last week/);
    assert.notEqual(scope.query.scope.projectId, wrongScopeDoc.scope.projectId);
  });

  test('evalHiddenPolicy fallback mints clustered temporal hidden rows, not singleton probes', () => {
    const splitOf = (logicalQueryId, liveUpdateEpoch) => splitForRecord(liveTailQueryId(logicalQueryId, liveUpdateEpoch), 0);
    const d = evolveCorpusDelta({
      baseLogical,
      epoch: 9,
      seed: 'clustered-hidden-surface',
      churnFraction: 0,
      retractionFraction: 0,
      evalHiddenPolicy: {
        splitOf,
        minFreshPerEpoch: 5,
        maxMintedPerEpoch: 8,
        retireAfterEpochs: Infinity,
      },
    });

    assert.equal(d.freshEvalHiddenQueryIds.length, 5);
    assert.equal(d.addedDocs.some((doc) => doc.kind === 'temporal_hidden_probe'), false);
    const fresh = d.addedQueries.filter((q) => d.freshEvalHiddenQueryIds.includes(q.id));
    assert.equal(fresh.length, 5);
    assert.ok(fresh.every((q) => splitOf(q.id, q.liveUpdateEpoch) === 'eval_hidden'));
    assert.ok(fresh.every((q) => q.family === 'temporal_update'));
    assert.ok(fresh.every((q) => q.operationFamily === 'temporal_cluster_typed'));
    assert.ok(fresh.every((q) => q.hardNegatives.some((n) => n.category === 'temporal_stale_exact_terms')));
    assert.ok(fresh.every((q) => typeof q.questionType === 'string' && q.questionType.length > 0));
    assert.ok(fresh.every((q) => q.publicIntent?.selector === `qtype_${q.questionType}_v${q.publicIntent.selector.match(/_v(\d+)$/)[1]}`));

    // Cross-question-TYPE clustering (N1): one memory structure, DISTINCT question types —
    // not paraphrases of one question. Group rows by their cluster doc structure via the
    // stale-trap doc every row shares.
    const byTrap = new Map();
    for (const q of fresh) {
      const trap = q.qrels.find((r) => r.role === 'stale_trap');
      assert.ok(trap, 'typed cluster query must carry the stale-trap qrel');
      byTrap.set(trap.docId, [...(byTrap.get(trap.docId) ?? []), q]);
    }
    const cluster = [...byTrap.entries()].find(([, rows]) => rows.length >= 4);
    assert.ok(cluster, `expected >=4 typed rows over one supersession structure, got ${JSON.stringify([...byTrap].map(([k, v]) => [k, v.length]))}`);
    const [staleId, rows] = cluster;
    const types = new Set(rows.map((q) => q.questionType));
    assert.ok(types.size >= 3, `cluster rows must span >=3 distinct question types, got ${[...types].join(',')}`);
    assert.ok(types.has('current_value'), 'cluster must include the current_value type');
    assert.ok(new Set(rows.map((q) => q.queryText)).size === rows.length, 'every cluster row must have distinct query text');

    // Typed golds differ by question type: change_provenance / stale_verification rows are
    // answered by the change-provenance record, not the current-value record.
    const docs = new Map(d.addedDocs.map((doc) => [doc.id, doc]));
    const goldOf = (q) => q.qrels.find((r) => r.role === 'direct').docId;
    const currentGold = goldOf(rows.find((q) => q.questionType === 'current_value'));
    const verifyRow = rows.find((q) => q.questionType === 'stale_verification');
    assert.ok(verifyRow, 'cluster must include the stale_verification type');
    const provenanceGold = goldOf(verifyRow);
    assert.notEqual(provenanceGold, currentGold, 'stale_verification gold must be the provenance record, not the current record');
    assert.match(docs.get(provenanceGold).text, /superseded and replaced/);
    assert.equal(docs.get(currentGold).currentStaleFlag, true);
    assert.equal(docs.get(staleId).currentStaleFlag, false);
    // validity metadata (subject+attribute) is what scopes temporalRecordAppliesToQuery.
    for (const docId of [currentGold, provenanceGold, staleId]) {
      assert.ok(docs.get(docId).validity?.subjectEntityId, `${docId} must carry validity.subjectEntityId`);
      assert.ok(docs.get(docId).validity?.attribute, `${docId} must carry validity.attribute`);
    }
    assert.ok(d.addedRelations.some((r) => r.src === currentGold && r.dst === staleId && r.type === 'supersedes'));

    // Telemetry (N2 anti-coverage-indexing signal).
    assert.equal(d.hiddenClusterTelemetry.capability, 'temporal_supersession');
    assert.equal(d.hiddenClusterTelemetry.escalationLevel, 0);
    assert.ok(d.hiddenClusterTelemetry.clusterCount >= 1);
    assert.ok(d.hiddenClusterTelemetry.questionTypeHistogram.current_value >= 1);
    // Epoch 9 is below the escalation base: no shadow decoys, band 'hard'.
    assert.ok(fresh.every((q) => q.band === 'hard'));
    assert.equal(d.addedDocs.some((doc) => /_sh\d+$/.test(doc.id)), false);
  });

  test('temporal attribute rotation avoids burned attributes and stays fresh per epoch', async () => {
    const { temporalAttributeForEpochSlot } = await import('../../../../scripts/lib/evolve-corpus.mjs');
    const burned = new Set(['city', 'diet', 'package manager', 'language', 'runtime', 'region']);
    const seen = new Set();
    for (let epoch = 133; epoch < 133 + 18; epoch += 1) {
      for (const slot of [0, 1]) {
        const { attr, bank } = temporalAttributeForEpochSlot(epoch, slot, {});
        assert.ok(!burned.has(attr), `rotated attribute must never be a bare substrate-burned attribute: ${attr}`);
        assert.ok(!seen.has(attr), `attribute must be fresh within a rotation cycle: ${attr}`);
        assert.ok(Array.isArray(bank) && bank.length >= 4, 'attribute needs a value bank');
        seen.add(attr);
      }
    }
    // Next cycle stays fresh via the series suffix.
    const next = temporalAttributeForEpochSlot(133 + 18, 0, {});
    assert.ok(!seen.has(next.attr), `post-cycle attribute must remain fresh: ${next.attr}`);
    assert.match(next.attr, /\(series 2\)$/);
    // Deterministic.
    assert.deepEqual(temporalAttributeForEpochSlot(140, 1, {}), temporalAttributeForEpochSlot(140, 1, {}));
    // Minted clusters actually carry rotated attributes.
    const splitOf = (logicalQueryId, liveUpdateEpoch) => splitForRecord(liveTailQueryId(logicalQueryId, liveUpdateEpoch), 0);
    const d = evolveCorpusDelta({
      baseLogical, epoch: 140, seed: 'rotation-surface', churnFraction: 0, retractionFraction: 0,
      evalHiddenPolicy: { splitOf, minFreshPerEpoch: 10, maxMintedPerEpoch: 12, retireAfterEpochs: Infinity },
    });
    const attrs = new Set(d.hiddenClusterTelemetry.clusters.map((c) => c.attribute));
    assert.ok([...attrs].every((a) => !burned.has(a)), `minted attrs must be rotated: ${[...attrs].join(',')}`);
    assert.ok(attrs.size >= 2, 'an epoch minting 2+ clusters must span 2 rotated attributes');
  });

  test('typed hidden clusters escalate difficulty deterministically past the base epoch', () => {
    const splitOf = (logicalQueryId, liveUpdateEpoch) => splitForRecord(liveTailQueryId(logicalQueryId, liveUpdateEpoch), 0);
    const mint = (epoch) => evolveCorpusDelta({
      baseLogical,
      epoch,
      seed: 'escalation-surface',
      churnFraction: 0,
      retractionFraction: 0,
      evalHiddenPolicy: { splitOf, minFreshPerEpoch: 5, maxMintedPerEpoch: 8, retireAfterEpochs: Infinity },
    });
    const early = mint(9);
    const late = mint(150);
    assert.equal(early.hiddenClusterTelemetry.escalationLevel, 0);
    assert.ok(late.hiddenClusterTelemetry.escalationLevel >= 1, 'epoch 150 must escalate past level 0');
    const lateShadows = late.addedDocs.filter((doc) => /_sh\d+$/.test(doc.id));
    assert.ok(lateShadows.length >= 1, 'escalated clusters must mint stale-shadow decoys');
    assert.ok(lateShadows.every((doc) => doc.currentStaleFlag === false && doc.validity?.supersededBy));
    const lateFresh = late.addedQueries.filter((q) => late.freshEvalHiddenQueryIds.includes(q.id));
    assert.ok(lateFresh.every((q) => q.band === 'very_hard'), 'escalated cluster rows are very_hard band');
    assert.ok(lateFresh.every((q) => q.qrels.some((r) => r.role === 'stale_shadow')), 'escalated rows must expose shadow qrels');
    // Determinism at both epochs.
    assert.deepEqual(JSON.parse(JSON.stringify(mint(150))), JSON.parse(JSON.stringify(late)));
    // Capability schedule is pure in epoch.
    assert.equal(late.hiddenClusterTelemetry.capability, 'temporal_supersession');
  });
});

describe('Fix B — production delta/root path (mock embeddings): logical delta → buildCorpusDelta → applyCorpusDelta → replay same root', () => {
  const BI = { modelId: 'BAAI/bge-m3', revision: 'a'.repeat(40) };
  const LAYOUT = { dim: 8, quantization: 'int8', headerBytes: 9 };
  const labelingProvenance = { modelId: 'memreranker/4B', revision: 'b'.repeat(40), runtime: 'cpu', batchHash: 'c'.repeat(64) };
  const mockEmb = () => new Uint8Array(LAYOUT.dim + 4); // deterministic mock — proves the delta/root wiring, not lift
  const prevCorpus = (corpusEpoch = 0) => ({
    events: [], byId: new Map(), corpusRoot: computeCorpusRoot([]), corpusEpoch,
    biEncoderModelId: BI.modelId, biEncoderRevision: BI.revision, biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: labelingProvenance.modelId, labelingModelRevision: labelingProvenance.revision,
  });
  const prevCorpusWithBaseMemory = (corpusEpoch = 0) => {
    const memEvents = baseLogical.docs.map((d) => ({
      id: `mem_${d.id}`, family: 'near_collision', domain: 'deep', split: 'train_visible',
      queryText: d.text, truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag !== false }],
      hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
      entityIds: d.entityIds, provenance: { source: 'synthetic_challenge', sourceHash: '0x' + 'aa'.repeat(32) },
      embeddings: { modelId: BI.modelId, revision: BI.revision, layout: LAYOUT, query: mockEmb(), perTruth: new Map([[d.id, mockEmb()]]), perNegative: new Map() },
    }));
    const existingQuery = {
      id: 'q_existing_tail_guard', family: 'temporal', domain: 'deep', split: splitForRecord('q_existing_tail_guard', corpusEpoch),
      queryText: 'existing query for tail-sort guard', truthDocuments: [{ id: 'd0', text: 'p', isCurrent: false }],
      hardNegatives: [], qrels: [{ documentId: 'd0', relevance: 1.0 }], protected: false,
      provenance: { source: 'synthetic_challenge', sourceHash: '0x' + 'aa'.repeat(32) },
      embeddings: { modelId: BI.modelId, revision: BI.revision, layout: LAYOUT, query: mockEmb(), perTruth: new Map([['d0', mockEmb()]]), perNegative: new Map() },
    };
    const events = [...memEvents, existingQuery];
    return {
      events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot: computeCorpusRoot(events),
      corpusRootCache: buildCorpusRootLeafCache(events), corpusEpoch,
      biEncoderModelId: BI.modelId, biEncoderRevision: BI.revision, biEncoderRetrievalKeyLayout: LAYOUT,
      labelingModelId: labelingProvenance.modelId, labelingModelRevision: labelingProvenance.revision,
    };
  };
  const docTextById = (logicalDelta) => new Map(logicalDelta.addedDocs.map((d) => [d.id, d.text]));
  // Build production events from the live-update logical delta — split assigned by the CANONICAL
  // splitForRecord (NOT evolveCorpus's local hint), matching what buildCorpusDelta validates.
  function prodEvents(logicalDelta, corpusEpoch) {
    const txt = docTextById(logicalDelta);
    return logicalDelta.addedQueries.map((q) => {
      const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => ({ id: r.docId, text: txt.get(r.docId) ?? '', isCurrent: true }));
      const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: txt.get(n.docId) ?? '' }));
      return {
        id: q.id, family: q.family === 'conflict_lifecycle' ? 'conflict_lifecycle' : 'temporal', domain: q.lane, split: splitForRecord(q.id, corpusEpoch),
        queryText: q.queryText, truthDocuments: truths, hardNegatives: negs,
        qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })), protected: false,
        subjectEntityId: q.subjectEntityId, provenance: { source: 'synthetic_challenge', sourceHash: '0x' + 'aa'.repeat(32) },
        embeddings: { modelId: BI.modelId, revision: BI.revision, layout: LAYOUT, query: mockEmb(),
          perTruth: new Map(truths.map((t) => [t.id, mockEmb()])), perNegative: new Map(negs.map((n) => [n.id, mockEmb()])) },
      };
    });
  }

  const baseLogical = {
    entities: [{ id: 'e_universe', canonicalName: 'U', aliases: [] }, ...Array.from({ length: 20 }, (_, i) => ({ id: `e_universe_s${i}`, canonicalName: `First${i} Last${i}`, aliases: [] }))],
    docs: Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, kind: 'temporal_city', entityIds: ['e_universe', `e_universe_s${i}`], currentStaleFlag: false, text: 'p' })),
    relations: [], queries: [],
  };

  test('split assigned via canonical splitForRecord (buildCorpusDelta does NOT throw)', () => {
    const ld = evolveCorpusDelta({ baseLogical, epoch: 2, seed: 'frontier', churnFraction: 1.0 });
    const additions = prodEvents(ld, 0);
    // every production-record split must equal splitForRecord(id) or buildCorpusDelta throws.
    for (const e of additions) assert.equal(e.split, splitForRecord(e.id, 0));
    assert.doesNotThrow(() => buildCorpusDelta({ previousCorpus: prevCorpus(0), additions, removals: [], epoch: 2, labelingProvenance }));
  });

  test('delta → new corpusRoot, deterministic + replay-identical, applyCorpusDelta reconstructs it', () => {
    const ld = evolveCorpusDelta({ baseLogical, epoch: 3, seed: 'frontier', churnFraction: 0.5 });
    const mk = () => buildCorpusDelta({ previousCorpus: prevCorpus(0), additions: prodEvents(ld, 0), removals: [], epoch: 3, labelingProvenance });
    const d1 = mk(), d2 = mk();
    assert.equal(d1.nextRoot, d2.nextRoot, 'same logical delta + mock embeddings → identical corpusRoot (replay-stable)');
    assert.notEqual(d1.nextRoot, d1.previousRoot, 'delta advances the root');
    const evolved = applyCorpusDelta(prevCorpus(0), d1);
    assert.equal(evolved.corpusRoot, d1.nextRoot, 'applyCorpusDelta reconstructs the delta nextRoot');
    assert.ok(d1.addedIds.length > 0);
  });

  test('applyCorpusDelta rejects addedRecords not listed in addedIds', () => {
    const ld = evolveCorpusDelta({ baseLogical, epoch: 4, seed: 'frontier', churnFraction: 0.5 });
    const delta = buildCorpusDelta({ previousCorpus: prevCorpus(0), additions: prodEvents(ld, 0), removals: [], epoch: 4, labelingProvenance });
    assert.ok(delta.addedRecords.length > 0, 'fixture should produce additions');
    const bad = { ...delta, addedIds: delta.addedIds.slice(0, -1) };
    assert.throws(() => applyCorpusDelta(prevCorpus(0), bad), /not listed in addedIds/);
  });

  test('signed corpus delta preserves live metadata through disk round-trip', () => {
    const previousCorpus = prevCorpusWithBaseMemory(0);
    const ld = evolveCorpusDelta({ baseLogical, epoch: 7, seed: 'frontier', churnFraction: 1.0 });
    const additions = bridgeLogicalDeltaToProductionEvents({
      previousCorpus,
      logicalDelta: ld,
      addedDocEmbeddings: new Map(ld.addedDocs.map((d) => [d.id, mockEmb()])),
      addedQueryEmbeddings: new Map(ld.addedQueries.map((q) => [q.id, mockEmb()])),
      biEncoder: { modelId: BI.modelId, revision: BI.revision, layout: LAYOUT },
    });
    const liveQuery = additions.find((e) => e.logicalFamily && e.band);
    assert.ok(liveQuery, 'bridge must emit live query metadata');
    const unsigned = buildCorpusDelta({
      previousCorpus,
      previousRootCache: previousCorpus.corpusRootCache,
      additions,
      removals: [],
      epoch: 7,
      labelingProvenance,
    });
    const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privateKeyPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKeyPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const signed = signCorpusDelta(unsigned, privateKeyPem, 'unit-key');
    const parsed = parseCorpusDelta(serializeCorpusDelta(signed));
    const parsedLiveQuery = parsed.addedRecords.find((e) => e.id === liveQuery.id);

    assert.equal(parsedLiveQuery.logicalFamily, liveQuery.logicalFamily);
    assert.equal(parsedLiveQuery.band, liveQuery.band);
    assert.equal(verifyCorpusDeltaSignature(parsed, publicKeyPem), true);
    assert.equal(verifyCorpusDeltaSignature({ ...parsed, signature: null }, publicKeyPem), false);
    const evolved = applyCorpusDelta(previousCorpus, parsed, { rootCache: previousCorpus.corpusRootCache, attachRootCache: true });
    assert.equal(evolved.corpusRoot, signed.nextRoot);
  });

  test('clustered evalHiddenPolicy rows bridge into production delta and replay root', () => {
    const previousCorpus = prevCorpusWithBaseMemory(0);
    const splitOf = (logicalQueryId, liveUpdateEpoch) => splitForRecord(
      liveTailQueryId(logicalQueryId, liveUpdateEpoch),
      previousCorpus.corpusEpoch,
    );
    const ld = evolveCorpusDelta({
      baseLogical,
      epoch: 9,
      seed: 'clustered-hidden-surface',
      churnFraction: 0,
      retractionFraction: 0,
      evalHiddenPolicy: {
        splitOf,
        minFreshPerEpoch: 5,
        maxMintedPerEpoch: 8,
        retireAfterEpochs: Infinity,
      },
    });
    const additions = bridgeLogicalDeltaToProductionEvents({
      previousCorpus,
      logicalDelta: ld,
      addedDocEmbeddings: new Map(ld.addedDocs.map((d) => [d.id, mockEmb()])),
      addedQueryEmbeddings: new Map(ld.addedQueries.map((q) => [q.id, mockEmb()])),
      biEncoder: { modelId: BI.modelId, revision: BI.revision, layout: LAYOUT },
    });
    const additionsById = new Map(additions.map((e) => [e.id, e]));
    const freshEvents = ld.freshEvalHiddenQueryIds.map((id) => additionsById.get(liveTailQueryId(id, 9)));
    assert.equal(freshEvents.length, 5);
    assert.ok(freshEvents.every(Boolean), 'every fresh logical hidden query must bridge to a production event');
    assert.ok(freshEvents.every((e) => e.split === 'eval_hidden'));
    assert.ok(freshEvents.every((e) => e.id.startsWith('zz_e000000000009_q_')));

    const byTrap = new Map();
    for (const e of freshEvents) {
      assert.equal(e.logicalFamily, 'temporal_update');
      assert.equal(e.band, 'hard'); // epoch 9 < escalation base ⇒ unescalated band
      const current = e.qrels.find((r) => r.relevance === 1);
      const stale = e.hardNegatives.find((n) => n.category === 'temporal_stale_exact_terms');
      assert.ok(current, 'bridged cluster query must keep direct qrel');
      assert.ok(stale, 'bridged cluster query must keep stale exact-term hard negative');
      assert.ok(e.truthDocuments.some((t) => t.id === current.documentId && t.isCurrent === true));
      // The stale trap is a relevance-0 qrel: the bridge carries it as a hard negative
      // (with embedding), NOT as a truth document. Suppression still reaches it pool-wide
      // (temporalOracleScopePerQuery is unset in the live profile).
      assert.ok(!e.truthDocuments.some((t) => t.id === stale.id), 'relevance-0 trap must not be a truth document');
      assert.ok(e.qrels.some((r) => r.documentId === stale.id && r.relevance === 0), 'trap qrel must bridge at relevance 0');
      assert.match(e.publicIntent?.selector ?? '', /^qtype_/, 'bridged cluster query must carry the question-type selector');
      byTrap.set(stale.id, [...(byTrap.get(stale.id) ?? []), e]);
    }
    const bridgedCluster = [...byTrap.values()].find((rows) => rows.length >= 4);
    assert.ok(bridgedCluster, 'production bridge keeps typed cluster rows over one supersession structure');
    const bridgedTypes = new Set(bridgedCluster.map((e) => e.publicIntent.selector.replace(/^qtype_/, '').replace(/_v\d+$/, '')));
    assert.ok(bridgedTypes.size >= 3, `bridged cluster must span >=3 distinct question types, got ${[...bridgedTypes].join(',')}`);
    const bridgedGolds = new Set(bridgedCluster.map((e) => e.qrels.find((r) => r.relevance === 1).documentId));
    assert.ok(bridgedGolds.size >= 2, 'bridged cluster question types must not all share one gold doc');

    const memDocs = additions.filter((e) => isMemoryDocumentEventId(e.id));
    const currentDocIds = new Set(freshEvents.flatMap((e) => e.qrels.filter((r) => r.relevance === 1).map((r) => r.documentId)));
    const staleDocIds = new Set(freshEvents.flatMap((e) => e.hardNegatives.filter((n) => n.category === 'temporal_stale_exact_terms').map((n) => n.id)));
    assert.ok(memDocs.some((e) => currentDocIds.has(e.truthDocuments[0].id) && e.split === 'train_visible'));
    assert.ok(memDocs.some((e) => staleDocIds.has(e.truthDocuments[0].id) && e.truthDocuments[0].isCurrent === false));

    const delta = buildCorpusDelta({
      previousCorpus,
      previousRootCache: previousCorpus.corpusRootCache,
      additions,
      removals: [],
      epoch: 9,
      labelingProvenance,
    });
    const evolved = applyCorpusDelta(previousCorpus, delta, { rootCache: previousCorpus.corpusRootCache, attachRootCache: true });
    assert.equal(evolved.corpusRoot, delta.nextRoot);
  });

  test('package bridge emits tail-sortable live memory/query ids for incremental roots', () => {
    const previousCorpus = prevCorpusWithBaseMemory(0);
    const ld = evolveCorpusDelta({ baseLogical, epoch: 6, seed: 'frontier', churnFraction: 1.0 });
    const addedDocEmbeddings = new Map(ld.addedDocs.map((d) => [d.id, mockEmb()]));
    const addedQueryEmbeddings = new Map(ld.addedQueries.map((q) => [q.id, mockEmb()]));
    const additions = bridgeLogicalDeltaToProductionEvents({
      previousCorpus,
      logicalDelta: ld,
      addedDocEmbeddings,
      addedQueryEmbeddings,
      biEncoder: { modelId: BI.modelId, revision: BI.revision, layout: LAYOUT },
    });

    const maxPreviousId = [...previousCorpus.byId.keys()].sort().at(-1);
    assert.ok(maxPreviousId, 'previous corpus must have a max id');
    assert.ok(additions.every((e) => e.id > maxPreviousId), 'live additions must tail-sort after existing v15-style ids');
    assert.ok(additions.filter((e) => isMemoryDocumentEventId(e.id)).every((e) => e.id.startsWith('zz_e000000000006_mem_')), 'live memory docs use epoch-prefixed tail-sort memory ids');
    assert.ok(additions.filter((e) => !isMemoryDocumentEventId(e.id)).every((e) => e.id.startsWith('zz_e000000000006_q_')), 'live queries use epoch-prefixed tail-sort query ids');
    for (const e of additions) assert.equal(e.split, expectedSplitForRecord(e.id, 0));

    const delta = buildCorpusDelta({
      previousCorpus,
      previousRootCache: previousCorpus.corpusRootCache,
      additions,
      removals: [],
      epoch: 6,
      labelingProvenance,
    });
    const evolved = applyCorpusDelta(previousCorpus, delta, { rootCache: previousCorpus.corpusRootCache, attachRootCache: true });
    assert.equal(evolved.corpusRoot, delta.nextRoot);
    assert.equal(evolved.corpusRootCache.root, delta.nextRoot);
  });

  test('package bridge keeps later live epochs tail-sortable after prior live query ids', () => {
    let corpus = prevCorpusWithBaseMemory(0);
    const applyLiveEpoch = (epoch) => {
      const logical = {
        ...baseLogical,
        docs: [...baseLogical.docs, ...[...corpus.byId.values()]
          .filter((e) => isMemoryDocumentEventId(e.id))
          .map((e) => ({
            id: e.truthDocuments[0].id,
            kind: 'temporal_city',
            entityIds: e.entityIds ?? ['e_universe'],
            currentStaleFlag: e.truthDocuments[0].isCurrent !== false,
            text: e.truthDocuments[0].text,
          }))],
      };
      const ld = evolveCorpusDelta({ baseLogical: logical, epoch, seed: 'frontier', churnFraction: 1.0 });
      const addedDocEmbeddings = new Map(ld.addedDocs.map((d) => [d.id, mockEmb()]));
      const addedQueryEmbeddings = new Map(ld.addedQueries.map((q) => [q.id, mockEmb()]));
      const additions = bridgeLogicalDeltaToProductionEvents({
        previousCorpus: corpus,
        logicalDelta: ld,
        addedDocEmbeddings,
        addedQueryEmbeddings,
        biEncoder: { modelId: BI.modelId, revision: BI.revision, layout: LAYOUT },
      });
      const maxPreviousId = [...corpus.byId.keys()].sort().at(-1);
      assert.ok(additions.every((e) => e.id > maxPreviousId), `epoch ${epoch} additions must tail-sort after ${maxPreviousId}`);
      const delta = buildCorpusDelta({
        previousCorpus: corpus,
        previousRootCache: corpus.corpusRootCache,
        additions,
        removals: [],
        epoch,
        labelingProvenance,
      });
      corpus = applyCorpusDelta(corpus, delta, { rootCache: corpus.corpusRootCache, attachRootCache: true });
      return additions;
    };

    const e1 = applyLiveEpoch(1);
    const e2 = applyLiveEpoch(2);
    assert.ok(e1.some((e) => e.id.startsWith('zz_e000000000001_q_')));
    assert.ok(e2.some((e) => e.id.startsWith('zz_e000000000002_mem_')));
    assert.ok(Math.max(...e2.map((e) => e.id.localeCompare('zz_e000000000001_q_'))) > 0);
  });

  // P0: live churn needs NEW PUBLIC MEMORY-DOC events (mem_*) so policy atoms / aspect maps / relations /
  // retrieval structure can see the updated memories — not only query events. Memory docs are train_visible
  // (expectedSplitForRecord), queries use splitForRecord; both must pass buildCorpusDelta/applyCorpusDelta.
  const memId = (id) => `mem_${id}`;
  function prodMemDocs(logicalDelta) {
    const relBySrc = new Map();
    for (const r of logicalDelta.addedRelations) { if (!relBySrc.has(r.src)) relBySrc.set(r.src, []); relBySrc.get(r.src).push(r); }
    return logicalDelta.addedDocs.map((d) => ({
      id: memId(d.id), family: 'near_collision', domain: d.lane, split: expectedSplitForRecord(memId(d.id), 0),
      queryText: d.text,
      truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true, ...(d.aspectTags ? { aspectTags: d.aspectTags } : {}) }],
      hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
      relations: (relBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type, ...(r.label ? { label: r.label } : {}) })),
      entityIds: d.entityIds, provenance: { source: 'synthetic_challenge', sourceHash: '0x' + 'aa'.repeat(32) },
      embeddings: { modelId: BI.modelId, revision: BI.revision, layout: LAYOUT, query: mockEmb(), perTruth: new Map([[d.id, mockEmb()]]), perNegative: new Map() },
    }));
  }

  test('LIVE MEMORY-DOC delta: mem_* docs (train_visible) + relations + aspectTags + queries pass buildCorpusDelta→applyCorpusDelta', () => {
    const ld = evolveCorpusDelta({ baseLogical, epoch: 4, seed: 'frontier', churnFraction: 1.0 });
    // tag one delta doc with public aspect tags to prove the field flows through the mem-doc delta path.
    ld.addedDocs[0] = { ...ld.addedDocs[0], aspectTags: ['latency', 'cost'] };
    const memDocs = prodMemDocs(ld);
    const queries = prodEvents(ld, 0);
    assert.ok(memDocs.length > 0, 'live churn must add public memory docs, not only queries');
    // memory docs are train_visible; queries are splitForRecord — both must equal expectedSplitForRecord.
    for (const e of memDocs) assert.equal(e.split, 'train_visible');
    for (const e of [...memDocs, ...queries]) assert.equal(e.split, expectedSplitForRecord(e.id, 0));
    // the split-authority fix: buildCorpusDelta MUST accept train_visible mem_* docs (previously threw).
    const mk = () => buildCorpusDelta({ previousCorpus: prevCorpus(0), additions: [...memDocs, ...queries], removals: [], epoch: 4, labelingProvenance });
    assert.doesNotThrow(mk, 'mem_* train_visible docs must not be rejected by the split validator');
    const d1 = mk(), d2 = mk();
    assert.equal(d1.nextRoot, d2.nextRoot, 'replay-stable root');
    const evolved = applyCorpusDelta(prevCorpus(0), d1);
    assert.equal(evolved.corpusRoot, d1.nextRoot, 'applyCorpusDelta reconstructs the root with live memory docs');
    // public memory structure is visible on the merged corpus: aspectTags + the continuity label survive.
    const memEv = evolved.byId.get(memDocs[0].id);
    assert.deepEqual(memEv.truthDocuments[0].aspectTags, ['latency', 'cost'], 'public aspectTags survive into the merged corpus');
    const withLabel = [...memDocs, ...queries].flatMap((e) => e.relations ?? []).filter((r) => r.label);
    assert.ok(withLabel.some((r) => r.label === 'supersedes' || r.label === 'contradicts'), 'public continuity label (direction) is preserved on live relations');
  });
});
