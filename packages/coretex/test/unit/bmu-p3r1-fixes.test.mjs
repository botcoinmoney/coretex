/**
 * P3-R1 fix-round tests (adversarial-review findings):
 *   MAJOR-3① min(gate,confirm) governs state advance — e2e through
 *     createCoreTexEvaluatorCore with confirm < gate (kills min→max mutant);
 *   MAJOR-3② §6.3 confirm-side exclusion through the PRODUCTION scorer path
 *     (scoreBmuAgainstSeed) — kills the dropped-exclusion mutant;
 *   MAJOR-3③ GOLDEN HEX VECTORS for the §6.4 seeded-draw byte law and the
 *     §6.7b variance-seed schedule (actual hex constants — any tuple change
 *     breaks a literal, rev3.3 item 10);
 *   MAJOR-3④ variance boundary pinned with LITERALS (7811 passes, 7812 fails);
 *   rev3.3 item 5: per-doc policyBonus clamp (±1·UNIT) e2e with STACKED
 *     conflict atoms — BMU clamps, r5 path byte-unchanged (unclamped);
 *   MINOR: control-char charset law (load validation); mint-time lint through
 *     the bridge; familyUtilitiesPpm integrity digest.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  keccak256,
  bytesToHex,
  bmuArmVarianceSeedHex,
  buildBmuArmVarianceCertification,
  computeBmuFamilyUtilitiesDigest,
  validateBmuTaskOnEvent,
  createCoreTexEvaluatorCore,
  createInMemoryDedupStore,
  buildCoordinatorBootAttestation,
  scoreBmuAgainstSeed,
  deriveQueryPack,
  deriveScoredQueryPack,
  bmuExclusionKeySetForPack,
  bmuEventExcluded,
  evaluateBmuBenchmarkState,
  evaluateRetrievalBenchmarkState,
  evaluateBmuBaseline,
  computeCorpusRoot,
  createDeterministicBiEncoder,
  biEncoderModelIdHash,
  merkleizeState,
  encodePatch,
  PATCH_TYPE,
  RANGES,
  encodeMemoryIndexSlot,
  encodePolicyAtom,
  POLICY_SELECTOR,
  POLICY_EVIDENCE_FEATURE,
  stableRecordIdFor,
  BMU_OVERLAY_DRAW_DOMAIN,
  BMU_ARM_VARIANCE_DOMAIN,
} from '../../dist/index.js';

const B32 = (b) => '0x' + b.repeat(32);
const ZERO_STATE = { words: new Array(1024).fill(0n) };

// ─── MAJOR-3③: GOLDEN HEX VECTORS ────────────────────────────────────────────
// Captured 2026-07-07 from the pinned byte laws. These are LITERALS on
// purpose: any change to the digest tuples (domain tag, field order, u64BE
// widths, seed byte parsing, family enum name, slot/probe indices) or to the
// variance-seed schedule breaks a constant here, not a symbolic recompute.

const SEED_22 = '0x' + '22'.repeat(32);

const SEEDED_DRAW_GOLDENS = [
  // digestU256([enc('bmu-overlay-v1'), u64BE(137), seedBytes(0x22…), enc(family), u64BE(slot), u64BE(probe)])
  { family: 'temporal', slot: 0, probe: 0, hex: '0x585c0fcf98adecc90f3c7c42961b692a3e1c1f9fba3233e5d868d7162b8ac745', idxMod8: 5 },
  { family: 'temporal', slot: 0, probe: 1, hex: '0xaaa14eeca7ee1075ad695c7d19ce5cc6cd301be03fe10cdc44978ad28a7d6198', idxMod8: 0 },
  { family: 'conflict_lifecycle', slot: 2, probe: 0, hex: '0xa49451889f8322c82e53f1d12d111d56b3e6ce7674a37de2cc5724b1a1ae5af1', idxMod8: 1 },
  { family: 'near_collision_abstention', slot: 1, probe: 3, hex: '0x4a3c1bb4e5131b65ceae770ce75d3190ea6733e67283548b3143b15db0364253', idxMod8: 3 },
];

const VARIANCE_SEED_GOLDENS = {
  parent: [
    '0x3a2483a378a10d2ea16578661557ff1515debc618cf9d9fe73a513d88321faf6',
    '0x5dfed2e56f0f8c85cb1664ad3e301a1840962a958975a2d015cade0ad6c86104',
    '0x9258ad1ae0aa12bea3b6e68535f51818c55f4ca277d9d4c181813fc565e8b863',
    '0x7c14ff1f610797a8f83d5683ced4901cae9103c9c90ce487223215f5ab1e602c',
    '0xe96b1a8f4629d8e912f82968b73156847899a136695ee1a85d96bb7ecf41caa0',
  ],
  blank: [
    '0xdc8f418693e34b89186288a48bee6d0eb4810e38cea8976d3e809092945e27b0',
    '0x7477aa91586ab2c23dc099981883b4508f4d3aa92cfb3fd79404ff31fe20c048',
    '0x9872b74ef64af9bed6cc05b4a977acc7308e19cc6475f88982b037f1a1fb6ea9',
    '0xac69c783bfa8cff96f64f8baf864487208911b11c35fcadb036ecd98319f6a20',
    '0x5e8187fb8b67ac4edd13bd8f88e2af13e154211cdec7fca843ad4e70ad253b47',
  ],
};

describe('MAJOR-3③ golden hex vectors (rev3.3 item 10)', () => {
  test('§6.4 seeded-draw digest tuple reproduces the pinned hex byte-for-byte', () => {
    assert.equal(BMU_OVERLAY_DRAW_DOMAIN, 'bmu-overlay-v1');
    const enc = new TextEncoder();
    const u64 = (n) => { const o = new Uint8Array(8); let v = BigInt(n); for (let i = 7; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
    const seedBytes = Uint8Array.from(SEED_22.slice(2).match(/../g).map((h) => parseInt(h, 16)));
    for (const g of SEEDED_DRAW_GOLDENS) {
      const parts = [enc.encode(BMU_OVERLAY_DRAW_DOMAIN), u64(137), seedBytes, enc.encode(g.family), u64(g.slot), u64(g.probe)];
      const total = parts.reduce((a, p) => a + p.length, 0);
      const buf = new Uint8Array(total); let off = 0;
      for (const p of parts) { buf.set(p, off); off += p.length; }
      const hex = bytesToHex(keccak256(buf)).toLowerCase();
      assert.equal(hex, g.hex, `${g.family}/${g.slot}/${g.probe}`);
      assert.equal(Number(BigInt(hex) % 8n), g.idxMod8, `${g.family}/${g.slot}/${g.probe} idx`);
    }
  });

  test('§6.7b variance-seed schedule reproduces the pinned hex byte-for-byte', () => {
    assert.equal(BMU_ARM_VARIANCE_DOMAIN, 'bmu-arm-variance');
    for (const state of ['parent', 'blank']) {
      for (let i = 0; i < 5; i++) {
        assert.equal(bmuArmVarianceSeedHex(137, state, i), VARIANCE_SEED_GOLDENS[state][i], `${state}/${i}`);
      }
    }
  });
});

describe('MAJOR-3④ variance boundary — LITERAL pins', () => {
  test('integer spread 7811 passes; 7812 fails (q/2 = 7,812.5, strict <)', () => {
    assert.doesNotThrow(() => buildBmuArmVarianceCertification({
      epochId: 137,
      scoresPpm: { parent: [100000, 100000, 100000, 100000, 107811], blank: [0, 0, 0, 0, 0] },
    }));
    assert.throws(() => buildBmuArmVarianceCertification({
      epochId: 137,
      scoresPpm: { parent: [100000, 100000, 100000, 100000, 107812], blank: [0, 0, 0, 0, 0] },
    }), /certification FAILED/);
    // a real row flip (15,625) fails on the blank state too
    assert.throws(() => buildBmuArmVarianceCertification({
      epochId: 137,
      scoresPpm: { parent: [0, 0, 0, 0, 0], blank: [93750, 93750, 93750, 93750, 109375] },
    }), /blank.*certification FAILED/s);
  });
});

// ─── Shared scoring fixture (small BMU corpus, deterministic pipeline) ───────

const BI = { modelId: 'BAAI/bge-m3', revision: 'a'.repeat(40), mode: 'dense' };
const LAYOUT = { dim: 32, quantization: 'int8', headerBytes: 9 };

const FAMS = [
  { bmu: 'temporal', bucketed: 'temporal', logical: 'temporal_update' },
  { bmu: 'conflict_lifecycle', bucketed: 'conflict_lifecycle', logical: 'conflict_lifecycle' },
  { bmu: 'multi_hop_relation', bucketed: 'multi_hop_relation', logical: 'multi_session_bridge' },
  { bmu: 'near_collision_abstention', bucketed: 'near_collision', logical: 'abstention_missing' },
];

function bmuEvent({ rid, fam }) {
  const truthId = `${rid}-t`;
  const trapId = `${rid}-x`;
  return {
    id: rid,
    family: fam.bucketed,
    domain: 'companies',
    split: 'eval_hidden',
    queryText: `q-${rid}`,
    truthDocuments: [{ id: truthId, text: `truth-${rid}`, isCurrent: true }],
    hardNegatives: [{ id: trapId, text: `trap-${rid}` }],
    qrels: [{ documentId: truthId, relevance: 1 }, { documentId: trapId, relevance: 0 }],
    protected: false,
    logicalFamily: fam.logical,
    subjectEntityId: `ent-${rid}`,
    bmuTask: {
      family: fam.bmu, budgetB: 3, requiredEvidence: [truthId], forbiddenEvidence: [trapId],
      answer: { id: truthId }, motifGroupId: `mg-${rid}`, templateId: `tt-${rid}`,
    },
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + 'aa'.repeat(32) },
    embeddings: {
      modelId: BI.modelId, revision: BI.revision, layout: LAYOUT,
      query: new Uint8Array(LAYOUT.dim + 4),
      perTruth: new Map([[truthId, new Uint8Array(LAYOUT.dim + 4)]]),
      perNegative: new Map([[trapId, new Uint8Array(LAYOUT.dim + 4)]]),
    },
  };
}

function smallBmuCorpus() {
  const events = [];
  for (const fam of FAMS) {
    for (const v of ['a', 'b']) events.push(bmuEvent({ rid: `${fam.bmu}-${v}`, fam }));
  }
  return {
    events, byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: BI.modelId, biEncoderRevision: BI.revision, biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'lm', labelingModelRevision: 'lr',
  };
}

function baseOpts(reranker) {
  return {
    weights: { w_retrieval: 0.75, w_temporal: 0.08, w_relation_recall: 0.07, w_abstention: 0.05, w_structural_sanity: 0.05 },
    retrievalKeyLayout: LAYOUT,
    biEncoderHash: biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode),
    biEncoder: createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT }),
    reranker,
    relationHopBudget: 2, abstentionThreshold: 0.001, rerankerTopK: 10, rerankerInputTopK: 128,
    firstStageTopK: 100, lensTopK: 36, lensWeight: 0.1, anchorWeight: 0.15, relationExpansionBudget: 50,
    temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1,
    pipelineVersion: 'coretex-bmu-v1-r5state', policyAtomsMode: true,
  };
}

describe('rev3.3 item 5: per-doc policyBonus clamp (±1·UNIT) with stacked atoms', () => {
  // Anchor slot 5 → event X = 'conflict_lifecycle-b'. Three stacked conflict
  // BOOST atoms (budget 500 → beta 0.5 each) target the anchor's own docs.
  // Mock reranker (per query 'temporal-a'): own truth 0.9, everything else
  // 0.1, X's docs 0.1 → UNIT = 0.8.
  //   uncapped stack: 3 × 0.5 × 0.8 = 1.2  → r5 composite = 0.1 + 1.2 = 1.3
  //   clamped (BMU):  min(1.2·UNIT? no — sum 1.5·UNIT·? ) …
  //   sum = 3 × (500/1000) × UNIT = 1.5 × 0.8 = 1.2 > 1 × UNIT = 0.8
  //   → BMU composite = 0.1 + 0.8 = 0.9; single atom = 0.1 + 0.4 (unclamped).
  const X_ID = 'conflict_lifecycle-b';
  const SLOT = 5;
  function stateWithConflictAtoms(count) {
    const s = { words: new Array(1024).fill(0n) };
    s.words[RANGES.MEMORY_INDEX_START + SLOT] = encodeMemoryIndexSlot({
      slotIndex: SLOT, recordId: stableRecordIdFor(X_ID), family: 'near_collision',
      domainBits: 0n, valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n,
    })[0];
    for (let i = 0; i < count; i++) {
      s.words[RANGES.POLICY_CONFLICT_START + i] = encodePolicyAtom({
        atomIndex: i, family: 'conflict_lifecycle', selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER,
        evidenceFeature: POLICY_EVIDENCE_FEATURE.LIFECYCLE_STATE, action: 'boost', scope: 'conflict_set',
        targetSlot: SLOT, budget: 500, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n,
      });
    }
    return s;
  }
  const reranker = {
    model: 'x',
    async score(pairs) {
      return pairs.map((p) => {
        const rid = p.query.slice(2);
        return p.document === `truth-${rid}` ? 0.9 : 0.1;
      });
    },
  };
  const corpus = smallBmuCorpus();
  const pack = deriveQueryPack(7, B32('11'), corpus, { packSize: 8, quotas: [] });
  const probeRow = 'temporal-a';
  const xDoc = `${X_ID}-t`;
  const scoreOf = (perQuery) => {
    const q = perQuery.find((r) => r.recordId === probeRow);
    const entry = q.finalRankingFull.find((r) => r.docId === xDoc);
    assert.ok(entry, `boosted doc ${xDoc} missing from ${probeRow} full ranking`);
    return entry.finalReorderingScore;
  };

  test('BMU law clamps the stacked sum to +1·UNIT; a single sub-cap atom is untouched', async () => {
    const stacked = await evaluateBmuBenchmarkState(stateWithConflictAtoms(3), corpus, pack, baseOpts(reranker));
    assert.ok(Math.abs(scoreOf(stacked.perQuery) - (0.1 + 0.8)) < 1e-9, `stacked clamped score ${scoreOf(stacked.perQuery)}`);
    const single = await evaluateBmuBenchmarkState(stateWithConflictAtoms(1), corpus, pack, baseOpts(reranker));
    assert.ok(Math.abs(scoreOf(single.perQuery) - (0.1 + 0.4)) < 1e-9, `single-atom score ${scoreOf(single.perQuery)}`);
  });

  test('r5 path stays UNCLAMPED byte-for-byte (flag absent)', async () => {
    const r5 = await evaluateRetrievalBenchmarkState(stateWithConflictAtoms(3), corpus, pack, {
      ...baseOpts(reranker), pipelineVersion: 'coretex-retrieval-v2-policy-r5', exposeFullRanking: true,
    });
    assert.ok(Math.abs(scoreOf(r5.perQuery) - (0.1 + 1.2)) < 1e-9, `r5 unclamped score ${scoreOf(r5.perQuery)}`);
  });
});

describe('MAJOR-3① min(gate,confirm) governs state advance (production evaluator core)', () => {
  test('confirm < gate ⇒ the CONFIRM delta is credited and advances state', async () => {
    const parent = ZERO_STATE;
    const parentRootBytes = merkleizeState(parent);
    const parentRoot = bytesToHex(parentRootBytes).toLowerCase();
    const mkScore = (composite) => ({
      composite, nDCG10: 0, mrr10: 0, recall10: 0, temporal: 0, multiHopRecall10: 0,
      categoryLensRelationHit10: 0, abstention: 0, structuralValidity: 1, perQuery: [],
    });
    const seedScorer = async ({ which }) => ({
      accepted: true,
      before: mkScore(0.1),
      after: mkScore(which === 'gate' ? 0.15 : 0.13),
      deltaPpm: which === 'gate' ? 50_000 : 30_000,
      perFamilyDelta: {},
    });
    const core = createCoreTexEvaluatorCore({
      epochId: 7,
      epochSecret: B32('aa'),
      corpusRoot: B32('cc'),
      bundleHash: B32('dd'),
      stateThresholdPpm: 20_250,
      screenerThresholdPpm: 1_000,
      replayTolerancePpm: 250,
      targetBlockOffset: 15,
      perMinerCap: 50,
      rpcClient: { getLatestBlockNumber: async () => { throw new Error('rpc must not be called (pinned seedContext)'); }, getBlockHash: async () => { throw new Error('no'); }, waitForBlock: async () => { throw new Error('no'); } },
      dedupStore: createInMemoryDedupStore(),
      bootAttestation: buildCoordinatorBootAttestation({
        bundleHash: B32('dd'), rerankerModelId: 'm', rerankerRevision: 'r', rerankerMode: 'qwen3-streaming',
        rerankerInstruction: 'i', promptTemplateHash: B32('ab'), memoryIRMode: 'off',
      }),
      parentStateLoader: () => parent,
      seedScorer,
    });
    const patchBytesHex = bytesToHex(encodePatch({
      patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0n,
      parentStateRoot: parentRootBytes, indices: [RANGES.MEMORY_INDEX_START], newWords: [1n],
    }));
    const result = await core.scorePatch({
      patchBytesHex,
      parentStateRoot: parentRoot,
      miner: '0x' + '11'.repeat(20),
      parentState: parent,
      seedContext: { receivedAtBlock: 10, targetBlock: 25, blockhash: B32('ab') },
    });
    assert.equal(result.outcome, 'state_advance');
    // THE mutation kill: min(50k, 30k) = 30k must be the credited delta —
    // a min→max mutant reports 50k here.
    assert.equal(result.deterministicDeltaPpm, 30_000);
    assert.equal(result.scoreAfterPpm - result.scoreBeforePpm, 30_000);
    assert.equal(result.artifact.receipt.gateScorePpm, 50_000);
    assert.equal(result.artifact.receipt.confirmScorePpm, 30_000);
  });
});

// ─── MAJOR-3②: §6.3 exclusion through the PRODUCTION scorer path ─────────────

function packLawCorpus() {
  // 34 rows per family (each its own cluster) + a few live rows so the
  // overlay draws; enough post-exclusion supply for the confirm pack.
  const events = [];
  for (const fam of FAMS) {
    for (let i = 0; i < 34; i++) {
      events.push(bmuEvent({ rid: `q_${fam.bmu}_${String(i).padStart(2, '0')}`, fam }));
    }
    for (let i = 0; i < 6; i++) {
      events.push(bmuEvent({ rid: `zz_e${String(137).padStart(12, '0')}_q_${fam.bmu}_${i}`, fam }));
    }
  }
  return {
    events, byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: BI.modelId, biEncoderRevision: BI.revision, biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'lm', labelingModelRevision: 'lr',
  };
}

const BMU_HIDDEN_PACK = {
  packSize: 64,
  quotas: [
    { stratum: 'family=temporal', minCount: 10 },
    { stratum: 'family=conflict_lifecycle', minCount: 15 },
    { stratum: 'family=multi_hop_relation', minCount: 15 },
    { stratum: 'family=near_collision', minCount: 10 },
  ],
};

const BMU_TEST_PROFILE = {
  pipelineVersion: 'coretex-bmu-v1-r5state',
  hiddenPack: BMU_HIDDEN_PACK,
  patchAcceptanceFloors: { minImprovementPpm: 20_000, structuralFloor: 0, protectedRegressionFloor: 1, familyCatastrophicFloor: 0 },
  replayTolerancePpm: 250,
};

const LAW = {
  limit: 12,
  familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 3 },
  freshWindow: 2,
};

describe('MAJOR-3② confirm-side exclusion through scoreBmuAgainstSeed (production path)', () => {
  test('the confirm pack scored by the production path shares NO motif/subject/template with the gate pack', async () => {
    const corpus = packLawCorpus();
    const activeLiveEval = { activeIds: new Set(corpus.events.map((e) => e.id)), law: LAW };
    const reranker = { model: 'x', async score(pairs) { return pairs.map((p) => p.document.startsWith('truth-') ? 0.9 : 0.1); } };
    const opts = baseOpts(reranker);
    const patch = {
      patchType: PATCH_TYPE.SLOT_REPLACE, wordCount: 1, scoreDelta: 0n,
      parentStateRoot: merkleizeState(ZERO_STATE),
      indices: [RANGES.MEMORY_INDEX_START], newWords: [1n],
    };
    const common = {
      epochId: 137, parent: ZERO_STATE, patch, corpus, profile: BMU_TEST_PROFILE,
      scoringOpts: opts, thresholdPpm: 20_250, activeLiveEval, bmuScoring: {},
    };
    const GATE_SEED = B32('22');
    const CONFIRM_SEED = B32('33');
    const gate = await scoreBmuAgainstSeed({ ...common, evalSeed: GATE_SEED, which: 'gate', gateSeedHex: GATE_SEED });
    const confirm = await scoreBmuAgainstSeed({ ...common, evalSeed: CONFIRM_SEED, which: 'confirm', gateSeedHex: GATE_SEED });
    const gateRows = gate.before.bmu.perTask.map((t) => t.recordId);
    const confirmRows = confirm.before.bmu.perTask.map((t) => t.recordId);
    assert.equal(gateRows.length, 64);
    assert.equal(confirmRows.length, 64);
    // Reconstruct X from the gate pack the production path derived and assert
    // every confirm row clears it — kills the exclusion-drop mutant (13-18
    // gate rows per family from 26-32 row pools guarantee overlap without it).
    const gatePack = deriveScoredQueryPack(137, GATE_SEED, corpus, BMU_HIDDEN_PACK, activeLiveEval, {});
    assert.deepEqual(gatePack.events.map((e) => e.id), gateRows, 'production gate pack must equal the §6.3 derivation');
    const X = bmuExclusionKeySetForPack(gatePack);
    for (const rid of confirmRows) {
      assert.ok(!bmuEventExcluded(corpus.byId.get(rid), X), `confirm row ${rid} collides with the gate exclusion set`);
    }
    const overlap = confirmRows.filter((r) => gateRows.includes(r));
    assert.equal(overlap.length, 0, `row overlap: ${overlap.join(', ')}`);
  });
});

describe('MINOR fixes: charset law, mint lint, familyUtilities digest', () => {
  const DOC_IDS = new Set(['d1']);
  const okTask = () => ({
    family: 'temporal', budgetB: 3, requiredEvidence: ['d1'], forbiddenEvidence: [],
    answer: { id: 'd1' }, motifGroupId: 'mg1', templateId: 'tt1',
  });
  const ev = (taskOver = {}, evOver = {}) => ({
    id: 'zz_e000000000137_q_x', family: 'temporal', split: 'eval_hidden',
    logicalFamily: 'temporal_update', subjectEntityId: 'ent_1',
    bmuTask: { ...okTask(), ...taskOver }, ...evOver,
  });

  test('control characters in templateId/motifGroupId/subjectEntityId are refused at load (charset law)', () => {
    assert.ok(validateBmuTaskOnEvent(ev({ templateId: 'tt\n1' }), (d) => DOC_IDS.has(d)).some((e) => e.includes('control characters')));
    assert.ok(validateBmuTaskOnEvent(ev({ motifGroupId: 'mg ' }), (d) => DOC_IDS.has(d)).some((e) => e.includes('control characters')));
    assert.ok(validateBmuTaskOnEvent(ev({}, { subjectEntityId: 'ent' }), (d) => DOC_IDS.has(d)).some((e) => e.includes('control characters')));
    assert.deepEqual(validateBmuTaskOnEvent(ev(), (d) => DOC_IDS.has(d)), []);
  });

  test('an invalid stamped mint is refused by the BRIDGE at mint time (never bricks the next load)', async () => {
    const { bridgeLogicalDeltaToProductionEvents, liveTailQueryId, splitForRecord } = await import('../../dist/index.js');
    let queryId = 'q_e137_bad';
    for (let i = 0; i < 512; i++) {
      const cand = `q_e137_bad${i}`;
      if (splitForRecord(liveTailQueryId(cand, 137), 0) === 'eval_hidden') { queryId = cand; break; }
    }
    const emb = new Uint8Array(12).fill(3);
    const previousCorpus = {
      events: [], byId: new Map(), corpusRoot: B32('11'), corpusEpoch: 0,
      biEncoderModelId: 'm', biEncoderRevision: 'r', biEncoderRetrievalKeyLayout: { dim: 8, headerBytes: 9, quantization: 'int8' },
      labelingModelId: 'lm', labelingModelRevision: 'lr',
    };
    const delta = (bmuTask) => ({
      previousCorpus,
      logicalDelta: {
        epoch: 137, seed: 's', churnFraction: 0,
        addedDocs: [{ id: 'd_e137_doc1', lane: 'temporal_update', text: 'doc', currentStaleFlag: false }],
        addedRelations: [],
        addedQueries: [{ id: queryId, lane: 'temporal_update', family: 'temporal_update', queryText: 'q', qrels: [{ docId: 'd_e137_doc1', relevance: 1 }], liveUpdateEpoch: 137, bmuTask }],
        churnedSubjects: [], liveChurnRate: 0,
      },
      addedDocEmbeddings: new Map([['d_e137_doc1', emb]]),
      addedQueryEmbeddings: new Map([[queryId, emb]]),
      biEncoder: { modelId: 'm', revision: 'r', layout: { dim: 8, headerBytes: 9, quantization: 'int8' } },
    });
    // referenced doc id does not exist → mint lint refuses the DELTA
    assert.throws(
      () => bridgeLogicalDeltaToProductionEvents(delta({
        family: 'temporal', budgetB: 3, requiredEvidence: ['ghost-doc'], forbiddenEvidence: [],
        answer: { id: 'ghost-doc' }, motifGroupId: 'mg1', templateId: 'tt1',
      })),
      /mint lint FAILED/,
    );
    // valid task passes
    assert.doesNotThrow(() => bridgeLogicalDeltaToProductionEvents(delta({
      family: 'temporal', budgetB: 3, requiredEvidence: ['d_e137_doc1'], forbiddenEvidence: [],
      answer: { id: 'd_e137_doc1' }, motifGroupId: 'mg1', templateId: 'tt1',
    })));
  });

  test('evaluateBmuBaseline binds familyUtilitiesPpm into the integrity digest (recompute-verifiable)', async () => {
    const corpus = smallBmuCorpus();
    const pack = deriveQueryPack(7, B32('11'), corpus, { packSize: 8, quotas: [] });
    const reranker = { model: 'x', async score(pairs) { return pairs.map((p) => p.document.startsWith('truth-') ? 0.9 : 0.1); } };
    const scoringOpts = baseOpts(reranker);
    const baseline = await evaluateBmuBaseline(ZERO_STATE, corpus, pack, scoringOpts, {}, { samples: 1 });
    assert.ok(baseline.familyUtilitiesDigest, 'digest missing');
    const recomputed = computeBmuFamilyUtilitiesDigest({
      scoringPipelineVersion: scoringOpts.pipelineVersion,
      epochId: pack.epochId,
      corpusRoot: pack.corpusRoot,
      baselineSeedHex: pack.evalSeedHex,
      parentScorePpm: baseline.parentScorePpm,
      familyUtilitiesPpm: baseline.familyUtilitiesPpm,
    });
    assert.equal(baseline.familyUtilitiesDigest, recomputed);
    // tampering with the decomposition breaks the digest
    const tampered = computeBmuFamilyUtilitiesDigest({
      scoringPipelineVersion: scoringOpts.pipelineVersion,
      epochId: pack.epochId, corpusRoot: pack.corpusRoot, baselineSeedHex: pack.evalSeedHex,
      parentScorePpm: baseline.parentScorePpm,
      familyUtilitiesPpm: { ...baseline.familyUtilitiesPpm, temporal: 999_999 },
    });
    assert.notEqual(baseline.familyUtilitiesDigest, tampered);
  });
});
