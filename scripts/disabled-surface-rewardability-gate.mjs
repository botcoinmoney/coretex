#!/usr/bin/env node
/**
 * Direct reduced-profile disabled-surface rewardability gate.
 *
 * Proves representative disabled arms are inert under the reduced launch
 * profile's scorer options, while the promoted replacement arm remains alive
 * where applicable.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';

const C = await import(distIndex);
const {
  evaluateRetrievalBenchmarkState, computeCorpusRoot, scoringOptionsFromProfile,
  biEncoderModelIdHash, encodeMemoryIndexSlot, encodeRelationEdge, encodePolicyAtom,
  stableRecordIdFor, POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE,
} = C;
const { RANGES } = await import(resolve(repoRoot, 'packages/cortex/dist/state/types.js'));

const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-launch-reduced.json');
const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));

const LAYOUT = { dim: 8, headerBytes: 9, quantization: 'int8' };
const BE = { modelId: 'test/biencoder', revision: 'disabled-gate', mode: 'dense' };
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, BE.mode);
const GENESIS = { words: new Array(RANGES.WORD_COUNT).fill(0n) };
const UNIVERSE = 'e_universe';

function qvec(values) {
  const buf = new Uint8Array(4 + values.length);
  new DataView(buf.buffer).setFloat32(0, 1, false);
  for (let i = 0; i < values.length; i++) {
    let v = Math.round(values[i] * 127);
    v = Math.max(-127, Math.min(127, v));
    buf[4 + i] = v & 0xff;
  }
  return buf;
}
const V = {
  q: qvec([1, 0, 0, 0, 0, 0, 0, 0]),
  far: qvec([-1, 0, 0, 0, 0, 0, 0, 0]),
  near: qvec([1, 0, 0, 0, 0, 0, 0, 0]),
};
function event({ id, queryText, truthText, truthVec, queryVec = V.q, family = 'multi_hop_relation', split = 'eval_hidden', qrels, relations = [], entityIds = [UNIVERSE, 'e_alice'], subjectEntityId = 'e_alice', aspectTags }) {
  const docId = `${id}-truth`;
  return {
    id, queryText, family, logicalFamily: family, domain: 'gate', split, epochId: 0, subjectEntityId,
    truthDocuments: [{ id: docId, text: truthText, isCurrent: true, ...(aspectTags ? { aspectTags } : {}) }],
    hardNegatives: [], qrels: qrels ?? [{ documentId: docId, relevance: 1 }],
    relations, entityIds,
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '11'.repeat(32) },
    embeddings: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: queryVec, perTruth: new Map([[docId, truthVec]]), perNegative: new Map() },
  };
}
function corpusOf(events) {
  return {
    schemaVersion: 'coretex.production-corpus.v1',
    corpusEpoch: 0,
    corpusRoot: computeCorpusRoot(events),
    biEncoderModelId: BE.modelId,
    biEncoderRevision: BE.revision,
    biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'test/reranker',
    labelingModelRevision: 'x',
    entities: [
      { id: UNIVERSE, canonicalName: 'Universe', aliases: [] },
      { id: 'e_alice', canonicalName: 'Alice', aliases: [] },
    ],
    events,
    byId: new Map(events.map((e) => [e.id, e])),
  };
}
function reranker() {
  return {
    model: 'disabled-gate-reranker',
    async score(pairs) {
      return pairs.map((p) => p.document.includes('GOLD') || p.document.includes('ANSWER') ? 0.99 : 0.1);
    },
  };
}
function opts(extra = {}) {
  return {
    ...scoringOptionsFromProfile(profile, {
      biEncoder: inertBiEncoder(BE, LAYOUT),
      reranker: reranker(),
      biEncoderHash,
      retrievalKeyLayout: LAYOUT,
    }),
    firstStageTopK: 1,
    rerankerInputTopK: 1,
    exposeFullRanking: true,
    policyEmitTraces: true,
    policyEntityRegistry: [
      { id: UNIVERSE, names: ['universe'] },
      { id: 'e_alice', names: ['alice'] },
    ],
    policyGenericEntityIds: [UNIVERSE],
    ...extra,
  };
}
async function score(state, corpus, query, extra) {
  const r = await evaluateRetrievalBenchmarkState(state, corpus, { epochId: 0, events: [query] }, opts(extra));
  return r.perQuery[0];
}
function memoryAnchor(words, slot, evId, policyAnchor = false) {
  words[RANGES.MEMORY_INDEX_START + slot] = encodeMemoryIndexSlot({
    slotIndex: slot,
    recordId: stableRecordIdFor(evId),
    family: 'multi_hop_relation',
    domainBits: 1n,
    valid: true,
    revoked: false,
    protected: false,
    policyAnchor,
    retrievalSlot: 0,
    expiryEpoch: 0n,
  })[0];
}

async function rawAnchorDisabled() {
  const q = event({ id: 'q-raw', queryText: 'raw anchor query', truthText: 'unused', truthVec: V.far, qrels: [{ documentId: 'ev-gold-truth', relevance: 1 }] });
  const gold = event({ id: 'ev-gold', queryText: 'gold', truthText: 'GOLD raw-anchor answer', truthVec: V.far, split: 'train_visible' });
  const dist = event({ id: 'ev-dist', queryText: 'dist', truthText: 'distractor', truthVec: V.near, split: 'train_visible' });
  const corpus = corpusOf([q, gold, dist]);
  const words = new Array(RANGES.WORD_COUNT).fill(0n);
  memoryAnchor(words, 0, 'ev-gold', false);
  const state = { words };
  const enabled = await score(state, corpus, q, { enableRawRoutingAnchors: true });
  const disabled = await score(state, corpus, q, { enableRawRoutingAnchors: false });
  return {
    surface: 'raw_anchors',
    pass: disabled.nDCG10 === 0 && enabled.nDCG10 > disabled.nDCG10,
    enabledNdcg: enabled.nDCG10,
    disabledNdcg: disabled.nDCG10,
    disabledSources: disabled.cappedDocSources ?? [],
  };
}

async function phaseAEdgesDisabled() {
  const q = event({ id: 'q-phasea', queryText: 'what does Alice depend on?', truthText: 'unused', truthVec: V.far, qrels: [{ documentId: 'ev-answer-truth', relevance: 1 }] });
  const bridge = event({ id: 'ev-bridge', queryText: 'bridge', truthText: 'bridge', truthVec: V.near, split: 'train_visible', relations: [{ other_id: 'ev-answer', edgeType: 'supports' }] });
  const answer = event({ id: 'ev-answer', queryText: 'answer', truthText: 'ANSWER phase-a target', truthVec: V.far, split: 'train_visible' });
  const corpus = corpusOf([q, bridge, answer]);
  const words = new Array(RANGES.WORD_COUNT).fill(0n);
  memoryAnchor(words, 0, 'ev-bridge', false);
  memoryAnchor(words, 1, 'ev-bridge', false);
  words[RANGES.RELATIONS_START] = encodeRelationEdge({ entryIndex: 0, sourceSlot: 0, targetSlot: 1, edgeType: 'supports', weight: 1 });
  const state = { words };
  const enabled = await score(state, corpus, q, { enableRawRoutingAnchors: true, enableRelationAnchorEdges: true, rerankerInputTopK: 3 });
  const disabled = await score(state, corpus, q, { enableRawRoutingAnchors: true, enableRelationAnchorEdges: false, rerankerInputTopK: 3 });
  const enabledHit = (enabled.finalRankingTop20 ?? []).some((r) => r.docId === 'ev-answer-truth');
  const disabledHit = (disabled.finalRankingTop20 ?? []).some((r) => r.docId === 'ev-answer-truth');
  return {
    surface: 'phaseAEdges',
    pass: enabledHit && !disabledHit,
    enabledNdcg: enabled.nDCG10,
    disabledNdcg: disabled.nDCG10,
    enabledHit,
    disabledHit,
  };
}

async function evidencePolicyAtomsDisabled() {
  const q = event({ id: 'q-evidence', queryText: 'what does Alice depend on?', truthText: 'unused', truthVec: V.far, qrels: [{ documentId: 'ev-answer-truth', relevance: 1 }] });
  const bridge = event({ id: 'ev-ebridge', queryText: 'Alice dependency bridge', truthText: 'bridge', truthVec: V.near, split: 'train_visible', relations: [{ other_id: 'ev-answer', edgeType: 'supports' }] });
  const answer = event({ id: 'ev-answer', queryText: 'answer', truthText: 'ANSWER evidence target', truthVec: V.far, split: 'train_visible' });
  const dist = event({ id: 'ev-edist', queryText: 'dist', truthText: 'distractor', truthVec: V.near, split: 'train_visible' });
  const corpus = corpusOf([q, bridge, answer, dist]);
  const build = (action) => {
    const words = new Array(RANGES.WORD_COUNT).fill(0n);
    memoryAnchor(words, 0, 'ev-ebridge', true);
    words[RANGES.POLICY_EVIDENCE_START] = encodePolicyAtom({
      atomIndex: 0,
      family: 'evidence_bundle',
      selector: POLICY_SELECTOR.ANSWER_DENSITY,
      evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE,
      action,
      scope: 'relation_path',
      targetSlot: 0,
      budget: 250,
      flags: 0,
      validFromEpoch: 0n,
      expiryEpoch: 0n,
    });
    return { words };
  };
  const boostBlocked = await score(build('boost'), corpus, q, { rerankerInputTopK: 2 });
  const bundleBlocked = await score(build('bundle'), corpus, q, { rerankerInputTopK: 2 });
  const bundleWouldFireIfEnabled = await score(build('bundle'), corpus, q, { enableEvidenceBundleAtoms: true, policyEvidenceAllowedActions: ['bundle'], rerankerInputTopK: 2 });
  return {
    surface: 'evidence_policy_atoms',
    pass: boostBlocked.nDCG10 === 0 && bundleBlocked.nDCG10 === 0 && bundleWouldFireIfEnabled.nDCG10 > 0
      && (boostBlocked.policyTraces ?? []).length === 0 && (bundleBlocked.policyTraces ?? []).length === 0,
    boostBlockedNdcg: boostBlocked.nDCG10,
    bundleBlockedNdcg: bundleBlocked.nDCG10,
    bundleWouldFireIfEnabledNdcg: bundleWouldFireIfEnabled.nDCG10,
    boostTraces: boostBlocked.policyTraces ?? [],
    bundleBlockedTraces: bundleBlocked.policyTraces ?? [],
    bundleWouldFireIfEnabledTraces: bundleWouldFireIfEnabled.policyTraces ?? [],
  };
}

async function aspectConstraintDisabled() {
  const q = event({
    id: 'q-aspect',
    family: 'aspect_constraint',
    queryText: 'For Alice, what is the latency detail?',
    truthText: 'unused',
    truthVec: V.far,
    qrels: [{ documentId: 'mem_zzz-gold-truth', relevance: 1 }, { documentId: 'mem_aaa-dist-truth', relevance: 0 }],
  });
  const gold = event({ id: 'mem_zzz-gold', queryText: 'gold', truthText: 'GOLD latency detail', truthVec: V.far, split: 'train_visible', aspectTags: ['latency'] });
  const dist = event({ id: 'mem_aaa-dist', queryText: 'dist', truthText: 'distractor', truthVec: V.near, split: 'train_visible' });
  const corpus = corpusOf([q, gold, dist]);
  const constant = { model: 'aspect-constant', async score(pairs) { return pairs.map(() => 0.5); } };
  const disabled = await score(GENESIS, corpus, q, {
    enableAspectConstraintAtoms: false, policyAspectIntentAdmission: false, policyAspectBoost: 0,
    firstStageTopK: 3, rerankerInputTopK: 3, reranker: constant,
  });
  const enabled = await score(GENESIS, corpus, q, {
    enableAspectConstraintAtoms: true, policyAspectIntentAdmission: true, policyAspectBoost: 0.2,
    firstStageTopK: 3, rerankerInputTopK: 3, reranker: constant,
  });
  return {
    surface: 'aspect_constraint',
    pass: disabled.nDCG10 < enabled.nDCG10,
    disabledNdcg: disabled.nDCG10,
    enabledNdcg: enabled.nDCG10,
  };
}

const checks = [
  await rawAnchorDisabled(),
  await phaseAEdgesDisabled(),
  await evidencePolicyAtomsDisabled(),
  await aspectConstraintDisabled(),
];
const profilePins = {
  enableRawRoutingAnchors: profile.enableRawRoutingAnchors,
  enableRelationAnchorEdges: profile.enableRelationAnchorEdges,
  enableEvidenceBundleAtoms: profile.enableEvidenceBundleAtoms,
  policyEvidenceAllowedActions: profile.policyEvidenceAllowedActions,
  enableAspectConstraintAtoms: profile.enableAspectConstraintAtoms,
  policyAspectIntentAdmission: profile.policyAspectIntentAdmission,
};
const okPins =
  profile.enableRawRoutingAnchors === false &&
  profile.enableRelationAnchorEdges === false &&
  profile.enableEvidenceBundleAtoms === false &&
  JSON.stringify(profile.policyEvidenceAllowedActions) === JSON.stringify(['bundle']) &&
  profile.enableAspectConstraintAtoms === false &&
  profile.policyAspectIntentAdmission === false;
const result = { ok: okPins && checks.every((c) => c.pass), profile: profilePath, profilePins, checks };
console.log(JSON.stringify(result, null, 2));
if (!result.ok) exit(2);
