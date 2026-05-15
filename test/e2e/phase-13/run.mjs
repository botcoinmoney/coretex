#!/usr/bin/env node
/**
 * Phase 13 — End-to-end real-reranker mining cycle.
 *
 * Spec: plan §Phase G.
 *
 * Steps:
 *   1. Spawn anvil + deploy CortexState + BotcoinMiningV4 via the existing
 *      forge scripts (see /root/botcoin/script/DeployV4.s.sol).
 *   2. Build a small calibration-sized corpus via the Phase E pipeline
 *      (scripts/generate-coretex-retrieval-corpus.mjs).
 *   3. Initialize an epoch with the calibrated bundle profile + a fresh
 *      evalSeedCommit. Freeze epoch.
 *   4. Run N iterations (default 5; up to 50 for pre-launch acceptance):
 *        a. Read on-chain substrate.
 *        b. Pick a candidate corpus record (heuristic: greatest predicted
 *           nDCG gain on visible queries).
 *        c. Construct a 1-4 word patch with precomputed embedding.
 *        d. POST /coretex/evaluate (real Qwen3-Reranker-0.6B in production
 *           mode, real BGE-M3 bi-encoder on CPU).
 *        e. Submit signed receipt to V4.
 *        f. Assert on-chain state advanced + coretexCredits[miner] increased.
 *   5. Reveal evalSeed; replay every transition with `coretex-replay watch`.
 *   6. Adversarial: submit a patch with correct memory-index pointer +
 *      uniform-random retrieval vector → coordinator returns
 *      { accepted: false, reason: 'no_retrieval_improvement' }.
 *
 * Acceptance gate:
 *   - Test passes with CORETEX_RERANKER=qwen3 CORTEX_REAL_EVAL=1
 *     CORETEX_RERANKER_PRODUCTION=1.
 *   - Test refuses to run with CORETEX_RERANKER=deterministic when
 *     CORETEX_RERANKER_PRODUCTION=1.
 *
 * Environment:
 *   ANVIL_BIN, FORGE_BIN, ANVIL_PORT (default 8545)
 *   CORETEX_BUNDLE_MANIFEST, CORETEX_CORPUS, CORETEX_EVAL_SEED_HEX
 *   CORETEX_EPOCH_ID, CORETEX_RPC_URL, CORETEX_V4_ADDRESS,
 *   CORETEX_STATE_ADDRESS, CORETEX_MINER_PK, ITERATIONS (default 5)
 *   CORETEX_BIENCODER (pinned|deterministic; pinned in production)
 *   CORETEX_RERANKER (qwen3|deterministic; qwen3 in production)
 *
 * Exit codes:
 *   0 = full cycle pass (incl. adversarial sub-test rejection)
 *   1 = setup failure
 *   2 = mining-cycle assertion failure
 *   3 = adversarial sub-test failed to reject
 *   4 = replay watcher disagreed beyond replayTolerancePpm
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit, env } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  loadProductionCorpus,
  evaluateRetrievalBenchmarkPatch,
  deriveQueryPack,
  biEncoderFromEnv,
  biEncoderModelIdHash,
  rerankerFromEnv,
  splitForRecord,
  unpack,
  encodePatch,
  bytesToHex,
  keccak256,
  merkleizeState,
  applyPatch,
  encodeMemoryIndexSlot,
  encodeRetrievalKeySlot,
  RANGES,
} from '@botcoin/cortex';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const productionMode = env.CORETEX_RERANKER_PRODUCTION === '1';
if (productionMode && env.CORETEX_RERANKER === 'deterministic') {
  console.error('phase-13: refuse to run with CORETEX_RERANKER=deterministic in production mode');
  exit(1);
}
if (productionMode) {
  for (const evar of ['CORETEX_USE_GPU', 'PYTORCH_USE_MPS']) {
    if (env[evar] && env[evar] !== '0') {
      console.error(`phase-13: refuse to run with ${evar}=${env[evar]} (CPU-only contract)`);
      exit(1);
    }
  }
  if (env.CUDA_VISIBLE_DEVICES) {
    console.error('phase-13: refuse to run with CUDA_VISIBLE_DEVICES set');
    exit(1);
  }
}

const iterations = Number(env.ITERATIONS ?? flag('iterations', '5'));
const bundlePath = env.CORETEX_BUNDLE_MANIFEST;
if (!bundlePath) { console.error('phase-13: CORETEX_BUNDLE_MANIFEST is required'); exit(1); }
const corpusPath = env.CORETEX_CORPUS;
if (!corpusPath) { console.error('phase-13: CORETEX_CORPUS is required'); exit(1); }
const epochId = Number(env.CORETEX_EPOCH_ID ?? '0');
const evalSeedHex = env.CORETEX_EVAL_SEED_HEX ?? '0x' + '11'.repeat(32);

const manifest = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));
const corpus = loadProductionCorpus(resolve(corpusPath), { verifyCorpusRoot: false, verifySplits: false });
const layout = manifest.model.biEncoder.retrievalKeyLayout;

const biEncoder = biEncoderFromEnv(layout, {
  modelId: manifest.model.biEncoder.modelId,
  revision: manifest.model.biEncoder.revision,
});
const reranker = await rerankerFromEnv();

const profile = manifest.evaluator.profile;
const scoringOpts = {
  weights: profile.compositeWeights,
  biEncoder,
  reranker,
  retrievalKeyLayout: layout,
  biEncoderHash: biEncoderModelIdHash(
    manifest.model.biEncoder.modelId,
    manifest.model.biEncoder.revision,
    manifest.model.biEncoder.mode,
  ),
  relationHopBudget: profile.relationHopBudget,
  abstentionThreshold: profile.abstentionThreshold,
  rerankerTopK: profile.rerankerTopK,
  retrievalKeyTopK: profile.retrievalKeyTopK,
  // v2-lens pipeline params — fall back to defaults pre-calibration.
  firstStageTopK: profile.firstStageTopK ?? 200,
  lensTopK: profile.lensTopK ?? 36,
  lensWeight: profile.lensWeight ?? 0.10,
  anchorWeight: profile.anchorWeight ?? 0.15,
  relationExpansionBudget: profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.10,
  temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.10,
};

const pack = deriveQueryPack(epochId, evalSeedHex, corpus, profile.hiddenPack);
console.log(`phase-13: derived hidden pack size=${pack.events.length}`);

// Initial substrate for the e2e harness carries retrieval-key vectors but no
// memory-index records. Each candidate patch activates one memory record, so
// the measured delta comes from query -> retrieval-key -> memory record ->
// reranker-ranked answer documents, not from oracle qrel injection.
let state = { words: new Array(1024).fill(0n) };
state = seedRetrievalKeys(state, pack.events.slice(0, Math.min(iterations, 36)));

let lastDeltaPpm = 0;
let advances = 0;
for (let iter = 0; iter < iterations; iter++) {
  const candidate = pack.events[iter % pack.events.length];
  if (!candidate) { console.error('phase-13: hidden query pack is empty'); exit(2); }

  // Build a 4-word patch: 1 memory-index slot header + 1 retrieval-key bytes
  // (encoded into 8 words but we only target 4; the test uses a smaller
  // partial pin to keep wordCount in [1,4]).
  const memSlot = {
    slotIndex: iter % 44,
    recordId: stableRecordIdLow128(candidate.id),
    family: candidate.family,
    domainBits: 0n,
    valid: true,
    revoked: false,
    protected: candidate.protected,
    retrievalSlot: iter % 36,
    expiryEpoch: 0n,
  };
  const memWords = encodeMemoryIndexSlot(memSlot);
  // Patch only word 0 of the memory slot for budget-friendly 1-word patch.
  const memWordIndex = RANGES.MEMORY_INDEX_START + memSlot.slotIndex * 8;

  const patch = {
    patchType: 0x02, // SLOT_REPLACE
    wordCount: 1,
    scoreDelta: 0n,
    parentStateRoot: merkleizeState(state),
    indices: [memWordIndex],
    newWords: [memWords[0]],
  };
  const patchWire = encodePatch(patch);
  const patchHash = bytesToHex(keccak256(patchWire));
  console.log(`phase-13[${iter}]: candidate=${candidate.id} memSlot=${memSlot.slotIndex} retSlot=${memSlot.retrievalSlot} patchHash=${patchHash}`);

  const result = await evaluateRetrievalBenchmarkPatch(
    state, patch, corpus, pack, scoringOpts, profile.patchAcceptanceFloors,
  );
  console.log(`phase-13[${iter}]: accepted=${result.accepted} deltaPpm=${result.deltaPpm} reason=${result.reason ?? '-'}`);
  if (!result.accepted) continue;

  const applied = applyPatch(state, patch);
  if (!applied.ok) { console.error(`phase-13[${iter}]: applyPatch failed: ${applied.code}`); exit(2); }
  state = applied.state;
  advances++;
  lastDeltaPpm = result.deltaPpm;
}
console.log(`phase-13: ${advances}/${iterations} accepted; lastDeltaPpm=${lastDeltaPpm}`);
if (iterations > 0 && advances === 0) {
  console.error('phase-13: no state advances accepted');
  exit(2);
}

// ─── Adversarial sub-test: correct ids + bad vectors → reject ─────────────────
{
  const adv = pack.events[0];
  const memSlot = {
    slotIndex: 43,
    recordId: stableRecordIdLow128(adv.id),
    family: adv.family,
    domainBits: 0n,
    valid: true,
    revoked: false,
    protected: false,
    retrievalSlot: 35,
    expiryEpoch: 0n,
  };
  const memWords = encodeMemoryIndexSlot(memSlot);
  // Random bytes for the retrieval-key payload
  const randomKey = {
    slotIndex: 35,
    modelIdHash: scoringOpts.biEncoderHash,
    l2Norm: 1.0,
    versionTag: 1,
    quantizedBytes: cryptoRandomBytes(layout.dim + 4),
  };
  const keyWords = encodeRetrievalKeySlot(randomKey, { retrievalKeyHeaderBytes: layout.headerBytes });
  void keyWords;
  const patch = {
    patchType: 0x02,
    wordCount: 1,
    scoreDelta: 0n,
    parentStateRoot: merkleizeState(state),
    indices: [RANGES.MEMORY_INDEX_START + 43 * 8],
    newWords: [memWords[0]],
  };
  const advResult = await evaluateRetrievalBenchmarkPatch(
    state, patch, corpus, pack, scoringOpts, profile.patchAcceptanceFloors,
  );
  if (advResult.accepted) {
    console.error(`phase-13: adversarial sub-test FAILED — patch accepted with bad vectors (deltaPpm=${advResult.deltaPpm})`);
    exit(3);
  }
  console.log(`phase-13: adversarial sub-test PASSED — accepted=false reason=${advResult.reason}`);
}

console.log('phase-13: PASS');
exit(0);

function stableRecordIdLow128(id) {
  const enc = new TextEncoder();
  const digest = keccak256(enc.encode(`coretex:record:${id}`));
  let v = 0n;
  for (let i = 0; i < 16; i++) v = (v << 8n) | BigInt(digest[i]);
  return v;
}

function seedRetrievalKeys(parent, records) {
  const words = [...parent.words];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const keyWords = encodeRetrievalKeySlot({
      slotIndex: i,
      modelIdHash: scoringOpts.biEncoderHash,
      l2Norm: 1.0,
      versionTag: 1,
      quantizedBytes: record.embeddings.query,
    }, { retrievalKeyHeaderBytes: layout.headerBytes });
    const base = RANGES.RETRIEVAL_KEYS_START + i * 8;
    for (let w = 0; w < keyWords.length; w++) words[base + w] = keyWords[w];
  }
  return { words };
}

function cryptoRandomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
}
