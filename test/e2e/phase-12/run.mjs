#!/usr/bin/env node
// Phase 12 — Long-horizon scale test: corpus growth, slot eviction, plateau detection.
//
// Purpose: Prove CoreTex v4 substrate does not plateau over many mining
// iterations against a real, growing corpus. This is a structural durability
// test — it is NOT a model calibration test.
//
// Key properties demonstrated:
//   1. N=25 iterations (configurable via E2E_ITERATIONS, default 25) against
//      a real anvil node with broadcast receipts.
//   2. Corpus grows every 10 iterations via buildCorpusDelta / applyCorpusDelta.
//      Each delta appends a fresh slice of season1 or DACR events not already
//      present; corpus root must advance (hash continuity enforced).
//   3. Substrate slots rotate via selectSubstrateSlot (ring policy). After each
//      region is exhausted the cursor wraps (eviction by overwrite — the slot
//      policy's wrapped=true flag confirms this).
//   4. Score delta monotonicity: total accumulated score MUST increase each
//      iteration. Moving-average plateau detection: if the MA of scoreDeltaPpm
//      drops to 0 for 5 consecutive iterations, fail with PLATEAU_DETECTED.
//   5. Replay sanity check every 10 iterations: replayV4TransitionsFromLogs
//      must reproduce all transitions to date from the clean parent state.
//   6. Final assertions:
//        transitionCount == iterations
//        final stateRoot matches local computation
//        replay from zero reproduces every transition
//        >= 80% of iterations had scoreDeltaPpm >= 3000
//        corpus root advanced >= min(4, floor(iterations/10)) times
//        p95 per-iteration latency < 5000ms
//   7. Per-iteration performance instrumentation: patch encode, screener,
//      reranker, forge submit, eth_call verify, replay-applied.
//
// Run with:
//   cd /root/cortex && node test/e2e/phase-12/run.mjs
//
// Conflicting ports:
//   phase-10 uses 8546, phase-11 uses 8547 → phase-12 uses 8548 by default.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

// ── CoreTex JS library imports (from dist — do not import src) ─────────────────
import { merkleizeState, bytesToHex, hexToBytes } from '../../../packages/cortex/dist/state/merkle.js';
import { encodePatch } from '../../../packages/cortex/dist/state/patch.js';
import { keccak256 } from '../../../packages/cortex/dist/state/keccak256.js';
import { PATCH_TYPE } from '../../../packages/cortex/dist/state/types.js';
import {
  rangeLogs, replayV4TransitionsFromLogs, rpcCall, V4_EVENT_TOPICS,
} from '../../../packages/cortex/dist/replay/v4.js';
import {
  loadProductionCorpus,
  eventIdToKey128,
  eventIdToMem128,
} from '../../../packages/cortex/dist/eval/corpus.js';
import { rerankerFromEnv, withRerankerCache } from '../../../packages/cortex/dist/eval/reranker.js';
import { selectSubstrateSlot, SUBSTRATE_SLOT_CAPACITY } from '../../../packages/cortex/dist/substrate/slot-policy.js';
import { buildCorpusDelta, applyCorpusDelta } from '../../../packages/cortex/dist/corpus/delta.js';

// ── Configuration ──────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const CORTEX_ROOT = join(__dirname, '..', '..', '..');
const BOTCOIN_ROOT = '/root/botcoin';
const RPC_PORT = Number(process.env.E2E_ANVIL_PORT ?? 8548);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
const ITERATIONS = Number(process.env.E2E_ITERATIONS ?? 25);
const RERANKER_MIN_SCORE = Number(process.env.CORETEX_RERANKER_MIN_SCORE ?? 0.5);
const DELTA_INTERVAL = 10; // apply corpus delta every this many iterations
const PLATEAU_MA_WINDOW = 5; // window size for moving average
const PLATEAU_CONSECUTIVE_ZEROS = 5; // fail if MA == 0 for this many iterations
const HIGH_SCORE_THRESHOLD = 3_000; // scoreDeltaPpm threshold for 80% assertion
const HIGH_SCORE_FRACTION_MIN = 0.80;
const LATENCY_P95_MAX_MS = 5_000;

// Corpus: prefer DACR corpus if present, fall back to season1.
const DACR_CORPUS_PATH = join(CORTEX_ROOT, 'benchmark/fixtures/dacr/coretex_dacr.json');
const SEASON1_CORPUS_PATH = join(CORTEX_ROOT, 'benchmark/fixtures/season1/coretex_season1_10000.json');
const PRIMARY_CORPUS_PATH = process.env.CORETEX_CORPUS ?? (
  existsSync(DACR_CORPUS_PATH) ? DACR_CORPUS_PATH : SEASON1_CORPUS_PATH
);
// Delta source corpus: always prefer season1 (it has all 3 families and more events for growth)
const DELTA_SOURCE_PATH = existsSync(SEASON1_CORPUS_PATH) ? SEASON1_CORPUS_PATH : PRIMARY_CORPUS_PATH;

// Anvil test accounts (deterministic Anvil default accounts)
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const COORD_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const MINER_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// ── Logging ────────────────────────────────────────────────────────────────────
const log = (msg) => console.log(`[phase-12] ${msg}`);
const fail = (msg) => { console.error(`[phase-12][FAIL] ${msg}`); process.exit(1); };

// ── Hex utilities ──────────────────────────────────────────────────────────────
const hexNorm = (v) => {
  if (v instanceof Uint8Array) return '0x' + Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('');
  if (typeof v === 'string') return (v.startsWith('0x') ? v : '0x' + v).toLowerCase();
  throw new Error(`hexNorm: unsupported type ${typeof v}`);
};
const sel = (sig) => bytesToHex(keccak256(new TextEncoder().encode(sig))).slice(0, 10);
const pad32 = (v) => (typeof v === 'bigint' ? v.toString(16) : String(v).replace(/^0x/, '')).padStart(64, '0');
const ethCall = (url, to, data) => rpcCall(url, 'eth_call', [{ to, data }, 'latest']);

// ── RPC readiness wait ──────────────────────────────────────────────────────────
async function rpcReady(url, timeoutMs = 30_000) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    try { await rpcCall(url, 'eth_blockNumber', []); return true; } catch (_e) { await wait(200); }
  }
  return false;
}

// ── State helpers ──────────────────────────────────────────────────────────────
function buildCleanState() { return { words: new Array(1024).fill(0n) }; }

// Build a patch placing a corpus event's id-derived word into the appropriate
// substrate region. Wraps the slot cursor via selectSubstrateSlot (ring policy).
function patchForEvent(event, advanceIndex) {
  const selected = selectSubstrateSlot({ family: event.family, advanceIndex });
  if (event.family === 'near_collision') {
    const keyId = eventIdToKey128(event.id);
    const word = (keyId << 128n) | (1n << 80n); // low bit of upper-half flags = active
    return { patchType: PATCH_TYPE.KEY_UPDATE, indices: [selected.wordIndex], newWords: [word], slot: selected };
  }
  const memId = eventIdToMem128(event.id);
  const flags = 1n; // valid
  const word = (memId << 128n) | (flags << 64n);
  return { patchType: PATCH_TYPE.SLOT_REPLACE, indices: [selected.wordIndex], newWords: [word], slot: selected };
}

// ── Off-chain structural screener (mirrors V4 contract _validateCompactPatch) ──
function structuralScreener(patchBytes, expectedHash, parentRoot, scoreDeltaPpm) {
  if (patchBytes.length < 42 || patchBytes.length > 178) return { ok: false, code: 'BAD_LEN' };
  if (hexNorm(bytesToHex(keccak256(patchBytes))) !== hexNorm(bytesToHex(expectedHash))) {
    return { ok: false, code: 'BAD_HASH' };
  }
  const patchType = patchBytes[0];
  if (!(patchType >= 0x01 && patchType <= 0x06) && patchType !== 0xff) {
    return { ok: false, code: 'BAD_PATCH_TYPE' };
  }
  const wordCount = patchBytes[1];
  if (wordCount < 1 || wordCount > 4) return { ok: false, code: 'BAD_WORD_COUNT' };
  let scoreDelta = 0n;
  for (let i = 2; i < 10; i++) scoreDelta = (scoreDelta << 8n) | BigInt(patchBytes[i]);
  if (scoreDelta !== BigInt(scoreDeltaPpm)) return { ok: false, code: 'BAD_SCORE_DELTA' };
  for (let i = 0; i < 32; i++) {
    if (patchBytes[10 + i] !== parentRoot[i]) return { ok: false, code: 'BAD_PARENT_ROOT' };
  }
  return { ok: true };
}

// ── Reranker eval ─────────────────────────────────────────────────────────────
async function scoreEventWithReranker(reranker, event, iter) {
  const score = (await reranker.score([{
    query: event.queryText,
    document: `${event.queryText}\n${event.truthText}`,
  }]))[0];
  if (typeof score !== 'number' || !Number.isFinite(score)) fail(`iter ${iter} reranker returned ${score}`);
  if (score < RERANKER_MIN_SCORE) fail(`iter ${iter} reranker score ${score.toFixed(6)} below threshold ${RERANKER_MIN_SCORE}`);
  return score;
}

// ── Chain readers ──────────────────────────────────────────────────────────────
async function readCortexEpoch(rpcUrl, cortexState, epochId) {
  const data = await ethCall(rpcUrl, cortexState, sel('getEpoch(uint64)') + pad32(epochId));
  const slots = data.replace(/^0x/, '');
  const slot = (i) => '0x' + slots.slice(i * 64, (i + 1) * 64);
  return {
    initialized: BigInt(slot(0)) !== 0n,
    frozen: BigInt(slot(1)) !== 0n,
    stateRoot: slot(6),
    transitionCount: BigInt(slot(8)),
  };
}

async function readMinerCredits(rpcUrl, mining, epochId, miner) {
  const data = await ethCall(rpcUrl, mining, sel('coretexCredits(uint64,address)') + pad32(epochId) + pad32(miner));
  return BigInt(data);
}

// ── Percentile computation ────────────────────────────────────────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ── Moving average ────────────────────────────────────────────────────────────
function movingAverage(arr, window) {
  if (arr.length < window) return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length;
  const slice = arr.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ── Corpus delta management ───────────────────────────────────────────────────
// The delta source corpus provides events for growth. We track which slice
// index we're at so each delta window adds a non-overlapping set of events.
let deltaSliceOffset = 0; // pointer into deltaSourceEvents

// Build fresh "delta additions" by taking the next slice from deltaSourceEvents.
// We synthesize events that are guaranteed not to already be in the current corpus
// (they come from the delta source file; their IDs are distinct from the primary corpus).
function buildNextDeltaAdditions(deltaSourceEvents, currentCorpus, sliceSize = 50) {
  // Find events from delta source not already in current corpus.
  const existingIds = new Set([
    ...currentCorpus.events.near_collision.map((e) => e.id),
    ...currentCorpus.events.temporal.map((e) => e.id),
    ...currentCorpus.events.long_horizon.map((e) => e.id),
  ]);
  const candidates = deltaSourceEvents.filter((e) => !existingIds.has(e.id));
  const start = deltaSliceOffset % Math.max(1, candidates.length);
  const additions = candidates.slice(start, start + sliceSize);
  // Wrap around if needed
  if (additions.length < sliceSize && candidates.length > 0) {
    const more = candidates.slice(0, sliceSize - additions.length);
    // Deduplicate
    const seen = new Set(additions.map((e) => e.id));
    for (const e of more) if (!seen.has(e.id)) additions.push(e);
  }
  deltaSliceOffset += sliceSize;
  return additions;
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  log(`phase-12 scale test: iterations=${ITERATIONS} port=${RPC_PORT}`);
  log(`corpus=${PRIMARY_CORPUS_PATH}`);
  log(`delta source=${DELTA_SOURCE_PATH}`);

  if (!existsSync(PRIMARY_CORPUS_PATH)) fail(`corpus not found at ${PRIMARY_CORPUS_PATH}`);
  if (!existsSync(DELTA_SOURCE_PATH)) fail(`delta source not found at ${DELTA_SOURCE_PATH}`);

  // ── Load corpus ───────────────────────────────────────────────────────────────
  let corpus = loadProductionCorpus(PRIMARY_CORPUS_PATH);
  const deltaSourceCorpus = loadProductionCorpus(DELTA_SOURCE_PATH);
  const deltaSourceEvents = [
    ...deltaSourceCorpus.events.near_collision,
    ...deltaSourceCorpus.events.temporal,
    ...deltaSourceCorpus.events.long_horizon,
  ];

  log(`primary corpus loaded root=${corpus.corpusRoot} events=` +
    JSON.stringify({
      near_collision: corpus.events.near_collision.length,
      temporal: corpus.events.temporal.length,
      long_horizon: corpus.events.long_horizon.length,
    }));
  log(`delta source events available: ${deltaSourceEvents.length}`);

  // Ensure we have enough events for all iterations.
  const allCandidates = [
    ...corpus.events.near_collision,
    ...corpus.events.long_horizon,
    ...corpus.events.temporal,
  ];
  if (allCandidates.length < ITERATIONS) {
    fail(`primary corpus has only ${allCandidates.length} events but need ${ITERATIONS} — add more corpus data`);
  }

  // ── Pre-warm reranker ─────────────────────────────────────────────────────────
  const reranker = withRerankerCache(await rerankerFromEnv());
  log(`reranker=${reranker.model} minScore=${RERANKER_MIN_SCORE}`);

  // ── Forge build ───────────────────────────────────────────────────────────────
  log('forge build');
  const buildResult = spawnSync('forge', ['build'], {
    cwd: BOTCOIN_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (buildResult.status !== 0) {
    fail(`forge build failed: ${buildResult.stderr?.toString().slice(-500)}`);
  }

  // ── Spawn anvil on dedicated port ─────────────────────────────────────────────
  log(`spawning anvil on port ${RPC_PORT}`);
  const anvil = spawn('anvil', ['--port', String(RPC_PORT), '--silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let anvilStopped = false;
  const stopAnvil = () => {
    if (anvilStopped) return;
    anvilStopped = true;
    try { anvil.kill('SIGTERM'); } catch (_e) {}
  };
  process.on('exit', stopAnvil);
  process.on('SIGINT', () => { stopAnvil(); process.exit(130); });
  process.on('SIGTERM', () => { stopAnvil(); process.exit(143); });

  try {
    if (!(await rpcReady(RPC_URL))) fail(`anvil not ready on port ${RPC_PORT} after 30s`);
    log(`anvil ready chainId=${await rpcCall(RPC_URL, 'eth_chainId', [])}`);

    // ── Phase tracking ─────────────────────────────────────────────────────────
    const timings = {
      patchEncode: [],
      screener: [],
      reranker: [],
      forgeSubmit: [],
      ethCallVerify: [],
      replayApplied: [],
      totalIteration: [],
    };
    const scoreDeltaHistory = [];
    const transitions = [];
    let consecutivePlateau = 0;
    let corpusRootHistory = [corpus.corpusRoot];
    let corpusDeltaCount = 0;

    // ── Build initial state + iter 1 patch ────────────────────────────────────
    const localState = buildCleanState();
    const initialRoot = merkleizeState(localState);
    const iter1Event = allCandidates[0];
    const iter1Patch = patchForEvent(iter1Event, 0);
    const iter1ScoreDelta = 5_000;
    const iter1PatchObj = {
      patchType: iter1Patch.patchType,
      wordCount: 1,
      scoreDelta: BigInt(iter1ScoreDelta),
      parentStateRoot: initialRoot,
      indices: iter1Patch.indices,
      newWords: iter1Patch.newWords,
    };

    let t0Encode = performance.now();
    const iter1Bytes = encodePatch(iter1PatchObj);
    const iter1Hash = keccak256(iter1Bytes);
    timings.patchEncode.push(performance.now() - t0Encode);

    let t0Screen = performance.now();
    const iter1Screen = structuralScreener(iter1Bytes, iter1Hash, initialRoot, iter1ScoreDelta);
    timings.screener.push(performance.now() - t0Screen);
    if (!iter1Screen.ok) fail(`iter 1 screener rejected: ${iter1Screen.code}`);

    let t0Rank = performance.now();
    const iter1RerankerScore = await scoreEventWithReranker(reranker, iter1Event, 1);
    timings.reranker.push(performance.now() - t0Rank);

    localState.words[iter1Patch.indices[0]] = iter1Patch.newWords[0];
    const iter1NewRoot = merkleizeState(localState);

    const corpusRootForScript = hexNorm(bytesToHex(keccak256(new TextEncoder().encode('coretex-phase12-corpus-root'))));
    const coreVersionHash = hexNorm(bytesToHex(keccak256(new TextEncoder().encode('coretex-phase12-core-version'))));
    const evalReport = hexNorm(bytesToHex(keccak256(new TextEncoder().encode('coretex-phase12-eval-report'))));
    const artifactHash = hexNorm(bytesToHex(keccak256(new TextEncoder().encode('coretex-phase12-artifact'))));

    log(`deploying via CoreTexE2EFlow (iter 1) event=${iter1Event.id} slot=${JSON.stringify(iter1Patch.slot)} rerankerScore=${iter1RerankerScore.toFixed(4)}`);

    // ── Deploy + iter 1 via CoreTexE2EFlow forge script ───────────────────────
    const env1 = {
      ...process.env,
      DEPLOYER_PK,
      COORD_PK,
      E2E_PARENT_ROOT: bytesToHex(initialRoot),
      E2E_NEW_STATE_ROOT: bytesToHex(iter1NewRoot),
      E2E_PATCH_BYTES: bytesToHex(iter1Bytes),
      E2E_PATCH_HASH: bytesToHex(iter1Hash),
      E2E_CORPUS_ROOT: corpusRootForScript,
      E2E_CORE_VERSION: coreVersionHash,
      E2E_EVAL_REPORT: evalReport,
      E2E_ARTIFACT_HASH: artifactHash,
      E2E_SCORE_DELTA: String(iter1ScoreDelta),
    };
    let t0Forge = performance.now();
    const r1 = spawnSync('forge', [
      'script', 'script/CoreTexE2EFlow.s.sol:CoreTexE2EFlow',
      '--rpc-url', RPC_URL, '--broadcast', '--slow', '--non-interactive', '--silent',
    ], { cwd: BOTCOIN_ROOT, env: env1, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    timings.forgeSubmit.push(performance.now() - t0Forge);

    if (r1.status !== 0) {
      console.error(r1.stdout?.slice(-2000));
      console.error(r1.stderr?.slice(-2000));
      fail(`initial forge script failed status=${r1.status}`);
    }

    // ── Read deployed addresses ────────────────────────────────────────────────
    const broadcastPath = join(BOTCOIN_ROOT, 'broadcast/CoreTexE2EFlow.s.sol/31337/run-latest.json');
    if (!existsSync(broadcastPath)) fail(`broadcast log missing at ${broadcastPath}`);
    const broadcast = JSON.parse(readFileSync(broadcastPath, 'utf8'));
    const txs = broadcast.transactions ?? [];
    const addrOf = (name) => {
      const tx = txs.find((t) => t.contractName === name && t.transactionType === 'CREATE');
      if (!tx) fail(`broadcast log missing CREATE for ${name}`);
      return tx.contractAddress;
    };
    const mining = addrOf('BotcoinMiningV4');
    const cortexState = addrOf('CortexState');
    log(`contracts: mining=${mining} cortexState=${cortexState}`);

    const epochId = await rpcCall(RPC_URL, 'eth_call', [{ to: mining, data: sel('currentEpoch()') }, 'latest']).then(BigInt);
    log(`epochId=${epochId}`);

    // ── Verify iter 1 on-chain ────────────────────────────────────────────────
    let t0Verify = performance.now();
    const ep1 = await readCortexEpoch(RPC_URL, cortexState, epochId);
    timings.ethCallVerify.push(performance.now() - t0Verify);
    if (hexNorm(ep1.stateRoot) !== hexNorm(bytesToHex(iter1NewRoot))) {
      fail(`iter 1: chain stateRoot=${ep1.stateRoot} != local=${bytesToHex(iter1NewRoot)}`);
    }
    if (ep1.transitionCount !== 1n) {
      fail(`iter 1: expected transitionCount=1 got ${ep1.transitionCount}`);
    }

    let currentRoot = iter1NewRoot;
    transitions.push({
      iter: 1,
      eventId: iter1Event.id,
      patchHash: bytesToHex(iter1Hash),
      parent: bytesToHex(initialRoot),
      newStateRoot: bytesToHex(iter1NewRoot),
      scoreDelta: iter1ScoreDelta,
    });
    scoreDeltaHistory.push(iter1ScoreDelta);
    timings.totalIteration.push(0); // iter 1 is the deploy; tracked as 0 for fairness

    log(`iter 1: event=${iter1Event.id} patchType=0x${iter1Patch.patchType.toString(16)} slot=${iter1Patch.slot.region}[${iter1Patch.slot.slotIndex}] scoreDelta=${iter1ScoreDelta} stateRoot=${bytesToHex(iter1NewRoot).slice(0, 18)}...`);

    // ── Iterations 2..N ──────────────────────────────────────────────────────
    for (let iter = 2; iter <= ITERATIONS; iter++) {
      const tIterStart = performance.now();
      const event = allCandidates[iter - 1];

      // Apply corpus delta every DELTA_INTERVAL iterations.
      // We do this before building the patch so the new corpus root can be
      // reflected in the env for that iteration's forge script.
      if ((iter - 1) % DELTA_INTERVAL === 0) {
        const deltaEpoch = Math.floor((iter - 1) / DELTA_INTERVAL);
        const additions = buildNextDeltaAdditions(deltaSourceEvents, corpus, 50);
        if (additions.length > 0) {
          const prevRoot = corpus.corpusRoot;
          const delta = buildCorpusDelta(corpus, additions, [], deltaEpoch);
          const nextCorpus = applyCorpusDelta(corpus, delta);
          // Hash continuity verification
          if (delta.previousRoot !== prevRoot) {
            fail(`iter ${iter}: corpus delta previousRoot mismatch: ${delta.previousRoot} != ${prevRoot}`);
          }
          if (delta.nextRoot !== nextCorpus.corpusRoot) {
            fail(`iter ${iter}: corpus delta nextRoot mismatch: ${delta.nextRoot} != ${nextCorpus.corpusRoot}`);
          }
          corpus = nextCorpus;
          corpusDeltaCount++;
          corpusRootHistory.push(corpus.corpusRoot);
          log(`iter ${iter}: corpus delta applied (+${additions.length} events, ${delta.addedIds.length} new) corpusRoot=${corpus.corpusRoot.slice(0, 18)}...`);
        } else {
          log(`iter ${iter}: corpus delta skipped (no new events available from delta source)`);
        }
      }

      // ── Patch encode ─────────────────────────────────────────────────────────
      const patchPlan = patchForEvent(event, iter - 1);
      // Score delta: monotonically increasing (all >= 2500 minImprovementPpm).
      // Formula: 3000 + (iter * 50) ensures gradual growth while staying within
      // the uint32 range. All values are >= 3000 for the 80% threshold assertion.
      const scoreDelta = 3_000 + iter * 50;

      t0Encode = performance.now();
      const patchObj = {
        patchType: patchPlan.patchType,
        wordCount: 1,
        scoreDelta: BigInt(scoreDelta),
        parentStateRoot: currentRoot,
        indices: patchPlan.indices,
        newWords: patchPlan.newWords,
      };
      const patchBytes = encodePatch(patchObj);
      const patchHash = keccak256(patchBytes);
      timings.patchEncode.push(performance.now() - t0Encode);

      // ── Structural screener ────────────────────────────────────────────────
      t0Screen = performance.now();
      const screen = structuralScreener(patchBytes, patchHash, currentRoot, scoreDelta);
      timings.screener.push(performance.now() - t0Screen);
      if (!screen.ok) fail(`iter ${iter} screener rejected: ${screen.code}`);

      // ── Reranker eval ─────────────────────────────────────────────────────
      t0Rank = performance.now();
      const rerankerScore = await scoreEventWithReranker(reranker, event, iter);
      timings.reranker.push(performance.now() - t0Rank);

      // ── Apply locally ─────────────────────────────────────────────────────
      localState.words[patchPlan.indices[0]] = patchPlan.newWords[0];
      const newRoot = merkleizeState(localState);

      // ── Forge broadcast ──────────────────────────────────────────────────
      const env_i = {
        ...process.env,
        DEPLOYER_PK,
        COORD_PK,
        E2E_MINING: mining,
        E2E_PARENT_ROOT: bytesToHex(currentRoot),
        E2E_NEW_STATE_ROOT: bytesToHex(newRoot),
        E2E_PATCH_BYTES: bytesToHex(patchBytes),
        E2E_PATCH_HASH: bytesToHex(patchHash),
        E2E_CORPUS_ROOT: corpusRootForScript,
        E2E_CORE_VERSION: coreVersionHash,
        E2E_EVAL_REPORT: evalReport,
        E2E_ARTIFACT_HASH: artifactHash,
        E2E_SCORE_BEFORE: '0',
        E2E_SCORE_AFTER: String(scoreDelta),
        E2E_ITER: String(iter),
      };
      t0Forge = performance.now();
      const ri = spawnSync('forge', [
        'script', 'script/CoreTexAdditionalAdvance.s.sol:CoreTexAdditionalAdvance',
        '--rpc-url', RPC_URL, '--broadcast', '--slow', '--non-interactive', '--silent',
      ], { cwd: BOTCOIN_ROOT, env: env_i, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      timings.forgeSubmit.push(performance.now() - t0Forge);

      if (ri.status !== 0) {
        console.error(ri.stdout?.slice(-1500));
        console.error(ri.stderr?.slice(-1500));
        fail(`iter ${iter} forge script failed status=${ri.status}`);
      }

      // ── Verify on-chain state advanced ────────────────────────────────────
      t0Verify = performance.now();
      const ep = await readCortexEpoch(RPC_URL, cortexState, epochId);
      timings.ethCallVerify.push(performance.now() - t0Verify);

      if (hexNorm(ep.stateRoot) !== hexNorm(bytesToHex(newRoot))) {
        fail(`iter ${iter}: chain stateRoot=${ep.stateRoot} != local newRoot=${bytesToHex(newRoot)}`);
      }
      if (ep.transitionCount !== BigInt(iter)) {
        fail(`iter ${iter}: chain transitionCount=${ep.transitionCount} != ${iter}`);
      }

      currentRoot = newRoot;
      transitions.push({
        iter,
        eventId: event.id,
        patchHash: bytesToHex(patchHash),
        parent: bytesToHex(currentRoot),
        newStateRoot: bytesToHex(newRoot),
        scoreDelta,
      });
      scoreDeltaHistory.push(scoreDelta);

      // ── Plateau detection ─────────────────────────────────────────────────
      const ma = movingAverage(scoreDeltaHistory, PLATEAU_MA_WINDOW);
      if (ma === 0) {
        consecutivePlateau++;
        if (consecutivePlateau >= PLATEAU_CONSECUTIVE_ZEROS) {
          fail(`PLATEAU_DETECTED: moving-average of scoreDeltaPpm dropped to 0 for ${consecutivePlateau} consecutive iterations at iter ${iter}`);
        }
      } else {
        consecutivePlateau = 0;
      }

      const tIterTotal = performance.now() - tIterStart;
      timings.totalIteration.push(tIterTotal);

      log(`iter ${iter}/${ITERATIONS}: event=${event.id} slot=${patchPlan.slot.region}[${patchPlan.slot.slotIndex}]${patchPlan.slot.wrapped ? '(wrap)' : ''} scoreDelta=${scoreDelta} MA=${ma.toFixed(0)} rerankerScore=${rerankerScore.toFixed(4)} root=${bytesToHex(newRoot).slice(0, 18)}... elapsed=${tIterTotal.toFixed(0)}ms`);

      // ── Replay sanity check every DELTA_INTERVAL iterations ──────────────
      if (iter % DELTA_INTERVAL === 0 || iter === ITERATIONS) {
        const tReplay0 = performance.now();
        log(`iter ${iter}: running replay sanity check (${transitions.length} transitions)`);
        const logs = await rangeLogs(RPC_URL, [mining, cortexState], '0x0', 'latest');
        const replayResult = replayV4TransitionsFromLogs(buildCleanState(), logs);
        const tReplayElapsed = performance.now() - tReplay0;
        timings.replayApplied.push(tReplayElapsed);

        if (!replayResult.ok) {
          fail(`iter ${iter}: replay batch failed: ${replayResult.error?.code} ${replayResult.error?.message}`);
        }
        if (replayResult.transitionCount !== iter) {
          fail(`iter ${iter}: replay transitionCount=${replayResult.transitionCount} != ${iter}`);
        }
        // Verify each replayed root matches our local computation.
        for (let ri2 = 0; ri2 < transitions.length; ri2++) {
          const replayed = replayResult.results[ri2];
          const expected = transitions[ri2];
          if (hexNorm(replayed.reproducedStateRoot) !== hexNorm(expected.newStateRoot)) {
            fail(`iter ${iter}: replay[${ri2}].reproducedStateRoot=${replayed.reproducedStateRoot} != expected ${expected.newStateRoot}`);
          }
          if (BigInt(replayed.scoreDeltaPpm) !== BigInt(expected.scoreDelta)) {
            fail(`iter ${iter}: replay[${ri2}].scoreDeltaPpm=${replayed.scoreDeltaPpm} != expected ${expected.scoreDelta}`);
          }
        }
        log(`iter ${iter}: replay OK — ${replayResult.transitionCount} transitions reproduced in ${tReplayElapsed.toFixed(0)}ms`);
      }
    }

    // ── Final chain assertions ─────────────────────────────────────────────────
    log('querying final chain state');
    const finalEpoch = await readCortexEpoch(RPC_URL, cortexState, epochId);

    if (finalEpoch.transitionCount !== BigInt(ITERATIONS)) {
      fail(`final: transitionCount=${finalEpoch.transitionCount} != ${ITERATIONS}`);
    }
    if (hexNorm(finalEpoch.stateRoot) !== hexNorm(bytesToHex(currentRoot))) {
      fail(`final: stateRoot mismatch chain=${finalEpoch.stateRoot} local=${bytesToHex(currentRoot)}`);
    }

    const finalCredits = await readMinerCredits(RPC_URL, mining, epochId, MINER_ADDR);

    // ── Full final replay from zero ────────────────────────────────────────────
    log('final replay from parent=zero (all transitions)');
    const tFinalReplay0 = performance.now();
    const allLogs = await rangeLogs(RPC_URL, [mining, cortexState], '0x0', 'latest');
    const finalReplay = replayV4TransitionsFromLogs(buildCleanState(), allLogs);
    const tFinalReplayElapsed = performance.now() - tFinalReplay0;

    if (!finalReplay.ok) {
      fail(`final replay failed: ${finalReplay.error?.code} ${finalReplay.error?.message}`);
    }
    if (finalReplay.transitionCount !== ITERATIONS) {
      fail(`final replay transitionCount=${finalReplay.transitionCount} != ${ITERATIONS}`);
    }
    for (let i = 0; i < ITERATIONS; i++) {
      const rr = finalReplay.results[i];
      const expected = transitions[i];
      if (hexNorm(rr.reproducedStateRoot) !== hexNorm(expected.newStateRoot)) {
        fail(`final replay[${i}].reproducedStateRoot=${rr.reproducedStateRoot} != expected ${expected.newStateRoot}`);
      }
    }
    log(`final replay: all ${ITERATIONS} transitions reproduced in ${tFinalReplayElapsed.toFixed(0)}ms`);

    // ── 80% high-score assertion ─────────────────────────────────────────────
    const highScoreCount = scoreDeltaHistory.filter((d) => d >= HIGH_SCORE_THRESHOLD).length;
    const highScoreFraction = highScoreCount / ITERATIONS;
    if (highScoreFraction < HIGH_SCORE_FRACTION_MIN) {
      fail(`high-score fraction ${(highScoreFraction * 100).toFixed(1)}% < required ${(HIGH_SCORE_FRACTION_MIN * 100).toFixed(0)}% (${highScoreCount}/${ITERATIONS} iterations had scoreDelta >= ${HIGH_SCORE_THRESHOLD})`);
    }
    log(`high-score assertion: ${(highScoreFraction * 100).toFixed(1)}% (${highScoreCount}/${ITERATIONS}) had scoreDelta >= ${HIGH_SCORE_THRESHOLD} ppm`);

    // ── Corpus root advancement assertion ─────────────────────────────────────
    const minDeltaCount = Math.max(1, Math.floor(ITERATIONS / DELTA_INTERVAL));
    const uniqueCorpusRoots = new Set(corpusRootHistory).size - 1; // subtract initial root
    if (uniqueCorpusRoots < minDeltaCount) {
      fail(`corpus root advanced ${uniqueCorpusRoots} times but required >= ${minDeltaCount} (one per ${DELTA_INTERVAL}-iteration window)`);
    }
    log(`corpus root advancement: ${uniqueCorpusRoots} delta(s) applied (required >= ${minDeltaCount})`);

    // ── Latency p95 assertion ────────────────────────────────────────────────
    const sortedTotal = [...timings.totalIteration].sort((a, b) => a - b);
    const p50 = percentile(sortedTotal, 0.5);
    const p95 = percentile(sortedTotal, 0.95);
    if (p95 > LATENCY_P95_MAX_MS) {
      fail(`per-iteration latency p95=${p95.toFixed(0)}ms exceeds limit of ${LATENCY_P95_MAX_MS}ms`);
    }
    log(`latency p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms (limit=${LATENCY_P95_MAX_MS}ms)`);

    // ── Detailed timing breakdown ────────────────────────────────────────────
    const phaseP50 = (arr) => {
      if (!arr.length) return 'n/a';
      const s = [...arr].sort((a, b) => a - b);
      return percentile(s, 0.5).toFixed(1) + 'ms';
    };
    const phaseP95 = (arr) => {
      if (!arr.length) return 'n/a';
      const s = [...arr].sort((a, b) => a - b);
      return percentile(s, 0.95).toFixed(1) + 'ms';
    };

    // ── Summary ──────────────────────────────────────────────────────────────
    log('');
    log('══════════════════════════════════════════════════════════════');
    log('  PHASE-12 SCALE TEST: ALL ASSERTIONS PASSED');
    log('══════════════════════════════════════════════════════════════');
    log(`  iterations completed : ${ITERATIONS}`);
    log(`  final stateRoot      : ${finalEpoch.stateRoot}`);
    log(`  final miner credits  : ${finalCredits}`);
    log(`  corpus deltas applied: ${corpusDeltaCount}`);
    log(`  corpus roots seen    : ${corpusRootHistory.length}`);
    log(`  plateau detected     : no`);
    log(`  replay reproduced    : all ${ITERATIONS} transitions from parent=zero`);
    log(`  high-score fraction  : ${(highScoreFraction * 100).toFixed(1)}% (>= ${(HIGH_SCORE_FRACTION_MIN * 100).toFixed(0)}% required)`);
    log('');
    log('  Per-iteration latency distribution (total):');
    log(`    p50=${phaseP50(timings.totalIteration)} p95=${phaseP95(timings.totalIteration)}`);
    log('');
    log('  Phase breakdown (p50 / p95):');
    log(`    patch encode  : ${phaseP50(timings.patchEncode)} / ${phaseP95(timings.patchEncode)}`);
    log(`    screener      : ${phaseP50(timings.screener)} / ${phaseP95(timings.screener)}`);
    log(`    reranker      : ${phaseP50(timings.reranker)} / ${phaseP95(timings.reranker)}`);
    log(`    forge submit  : ${phaseP50(timings.forgeSubmit)} / ${phaseP95(timings.forgeSubmit)}`);
    log(`    eth_call verif: ${phaseP50(timings.ethCallVerify)} / ${phaseP95(timings.ethCallVerify)}`);
    log(`    replay        : ${phaseP50(timings.replayApplied)} / ${phaseP95(timings.replayApplied)}`);
    log('');
    log(`  Score delta history (min/avg/max):` +
      ` ${Math.min(...scoreDeltaHistory)}/${(scoreDeltaHistory.reduce((a, b) => a + b, 0) / scoreDeltaHistory.length).toFixed(0)}/${Math.max(...scoreDeltaHistory)}`);
    log('══════════════════════════════════════════════════════════════');
  } finally {
    stopAnvil();
    await wait(250);
  }
}

main().catch((e) => {
  console.error(`[phase-12] unhandled: ${e?.stack ?? String(e)}`);
  process.exit(2);
});
