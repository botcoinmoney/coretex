#!/usr/bin/env node
// Phase 10 — Live Anvil full-flow E2E.
//
// Per CoreTex v4 production plan §13 "Required End-to-End Scenarios" 2-5,8:
//   - Deploy CortexState + BotcoinMiningV4 + MockERC20 to a real Anvil node.
//   - Submit a screener receipt (asserts state unchanged + credits earned).
//   - Submit a state-advance receipt with a real compact patch
//     (asserts CortexState root advances + credits earned).
//   - Run `coretex-replay` against the chain logs and assert replay
//     reproduces the on-chain new-state root from the parent state + events.
//
// Requires:
//   - foundry (`anvil`, `forge`) on PATH
//   - /root/cortex packages built (npm run build)
//   - /root/botcoin contracts buildable (forge build)
//
// Exits non-zero on any assertion failure.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { merkleizeState, bytesToHex, hexToBytes } from '../../../packages/cortex/dist/state/merkle.js';
import { encodePatch } from '../../../packages/cortex/dist/state/patch.js';
import { keccak256 } from '../../../packages/cortex/dist/state/keccak256.js';
import {
  rangeLogs,
  receiptLogs,
  replayV4TransitionsFromLogs,
  rpcCall,
  V4_EVENT_TOPICS,
} from '../../../packages/cortex/dist/replay/v4.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORTEX_ROOT = join(__dirname, '..', '..', '..');
// Repo that holds the V4 contracts + `script/CoreTexE2EFlow.s.sol`.
// Default is the historical /root/botcoin path; override with the
// CORETEX_CONTRACTS_ROOT env var to point at the orchestrator harness
// repo (/root/coretex-calibration-orchestrator) or any other clone.
const BOTCOIN_ROOT = process.env.CORETEX_CONTRACTS_ROOT ?? '/root/botcoin';
const RPC_PORT = Number(process.env.E2E_ANVIL_PORT ?? 8546);
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

// Anvil's default deterministic accounts.
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const COORD_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

const PATCH_TYPE_KEY_UPDATE = 0x01;     // RetrievalKeys: 384–671
const RETRIEVAL_KEYS_BASE = 384;
const SCORE_DELTA_PPM = 5_000;            // 0.5% improvement; >= MIN_IMPROVEMENT_PPM (2_500)

const log = (msg) => console.log(`[phase-10] ${msg}`);
const fail = (msg) => { console.error(`[phase-10][FAIL] ${msg}`); process.exit(1); };

function buildState() {
  return { words: new Array(1024).fill(0n) };
}

function selector(signature) {
  return bytesToHex(keccak256(new TextEncoder().encode(signature))).slice(0, 10);
}

async function ethCall(rpcUrl, to, data) {
  return rpcCall(rpcUrl, 'eth_call', [{ to, data }, 'latest']);
}

function pad32(value) {
  let hex = typeof value === 'bigint' ? value.toString(16) : String(value).replace(/^0x/, '');
  return hex.padStart(64, '0');
}

async function readEpochId(rpcUrl, mining) {
  const sig = selector('currentEpoch()');
  const result = await ethCall(rpcUrl, mining, sig);
  return BigInt(result);
}

async function readCortexEpoch(rpcUrl, cortexState, epochId) {
  const sig = selector('getEpoch(uint64)');
  const calldata = sig + pad32(epochId);
  const raw = await ethCall(rpcUrl, cortexState, calldata);
  const data = raw.replace(/^0x/, '');
  const slot = (i) => '0x' + data.slice(i * 64, (i + 1) * 64);
  return {
    initialized: BigInt(slot(0)) !== 0n,
    frozen: BigInt(slot(1)) !== 0n,
    rulesVersion: Number(BigInt(slot(2))),
    workPolicyHash: slot(3),
    corpusRoot: slot(4),
    coreVersionHash: slot(5),
    stateRoot: slot(6),
    wordCount: Number(BigInt(slot(7))),
    transitionCount: BigInt(slot(8)),
    parentCorpusRoot: slot(9),
    minImprovementPpm: Number(BigInt(slot(10))),
    evalSeedCommit: slot(11),
    evalSeed: slot(12),
  };
}

async function readMinerCredits(rpcUrl, mining, epochId, miner) {
  const sig = selector('coretexCredits(uint64,address)');
  const calldata = sig + pad32(epochId) + pad32(miner);
  const raw = await ethCall(rpcUrl, mining, calldata);
  return BigInt(raw);
}

function hexNorm(value) {
  if (value instanceof Uint8Array) return '0x' + Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
  if (typeof value === 'string') return value.startsWith('0x') ? value.toLowerCase() : '0x' + value.toLowerCase();
  throw new Error(`hexNorm: unsupported ${typeof value}`);
}

function precomputeArtifacts() {
  const parentState = buildState();
  const parentRoot = merkleizeState(parentState);

  // KEY_UPDATE patch at retrieval-keys slot 0 (word index 384).
  // Encode a key-id with the active flag set per substrate region map.
  // Layout per scoreProductionState (eval/corpus.ts):
  //   bits[128..256] = keyId (128 bits)
  //   bits[80..96]   = flags (low bit = active)
  // For e2e we just need a deterministic non-zero value.
  const keyId = 0x123456789abcdefn;
  const flags = 1n;
  const keyWord = (keyId << 128n) | (flags << 80n);

  const newState = buildState();
  newState.words[RETRIEVAL_KEYS_BASE] = keyWord;
  const newStateRoot = merkleizeState(newState);

  const patch = {
    patchType: PATCH_TYPE_KEY_UPDATE,
    wordCount: 1,
    scoreDelta: BigInt(SCORE_DELTA_PPM),
    parentStateRoot: parentRoot,
    indices: [RETRIEVAL_KEYS_BASE],
    newWords: [keyWord],
  };
  const patchBytes = encodePatch(patch);
  const patchHash = keccak256(patchBytes);

  return {
    parentRootHex: bytesToHex(parentRoot),
    newStateRootHex: bytesToHex(newStateRoot),
    patchBytesHex: bytesToHex(patchBytes),
    patchHashHex: bytesToHex(patchHash),
    parentState,
    newState,
  };
}

async function rpcReady(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await rpcCall(url, 'eth_blockNumber', []);
      return true;
    } catch (_e) {
      await wait(200);
    }
  }
  return false;
}

async function main() {
  log('precomputing patch + state roots');
  const {
    parentRootHex,
    newStateRootHex,
    patchBytesHex,
    patchHashHex,
    parentState,
  } = precomputeArtifacts();
  log(`parentRoot=${parentRootHex}`);
  log(`newStateRoot=${newStateRootHex}`);
  log(`patchHash=${patchHashHex} bytes=${(patchBytesHex.length - 2) / 2}`);

  log('building forge artifacts');
  const buildResult = spawnSync('forge', ['build'], { cwd: BOTCOIN_ROOT, stdio: 'inherit' });
  if (buildResult.status !== 0) fail(`forge build failed: ${buildResult.status}`);

  log('spawning anvil');
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
  anvil.on('exit', (code) => log(`anvil exited code=${code}`));

  try {
    if (!(await rpcReady(RPC_URL))) fail('anvil RPC did not become ready in 30s');
    const chainIdHex = await rpcCall(RPC_URL, 'eth_chainId', []);
    log(`anvil ready chainId=${chainIdHex}`);

    log('running forge script CoreTexE2EFlow');
    const env = {
      ...process.env,
      DEPLOYER_PK,
      COORD_PK,
      E2E_PARENT_ROOT: parentRootHex,
      E2E_NEW_STATE_ROOT: newStateRootHex,
      E2E_PATCH_BYTES: patchBytesHex,
      E2E_PATCH_HASH: patchHashHex,
      E2E_CORPUS_ROOT: hexNorm(keccak256(new TextEncoder().encode('coretex-e2e-corpus-root'))),
      E2E_CORE_VERSION: hexNorm(keccak256(new TextEncoder().encode('coretex-e2e-core-version'))),
      E2E_EVAL_REPORT: hexNorm(keccak256(new TextEncoder().encode('coretex-e2e-eval-report'))),
      E2E_ARTIFACT_HASH: hexNorm(keccak256(new TextEncoder().encode('coretex-e2e-artifact'))),
      E2E_SCORE_DELTA: String(SCORE_DELTA_PPM),
      FOUNDRY_PROFILE: 'default',
    };
    const forgeResult = spawnSync('forge', [
      'script', 'script/CoreTexE2EFlow.s.sol:CoreTexE2EFlow',
      '--rpc-url', RPC_URL,
      '--broadcast',
      '--slow',
      '--non-interactive',
      '--silent',
    ], { cwd: BOTCOIN_ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (forgeResult.status !== 0) {
      console.error(forgeResult.stdout);
      console.error(forgeResult.stderr);
      fail(`forge script failed status=${forgeResult.status}`);
    }
    const stdout = forgeResult.stdout ?? '';
    log(`forge script ok stdout-bytes=${stdout.length}`);

    // Read broadcast log to extract deployed addresses (more reliable than stdout parsing).
    const broadcastPath = join(BOTCOIN_ROOT, 'broadcast/CoreTexE2EFlow.s.sol/31337/run-latest.json');
    if (!existsSync(broadcastPath)) {
      console.error(stdout.slice(-2000));
      fail(`broadcast log missing at ${broadcastPath}`);
    }
    const broadcast = JSON.parse(readFileSync(broadcastPath, 'utf8'));
    const txs = broadcast.transactions ?? [];
    const addrOf = (name) => {
      const tx = txs.find((t) => t.contractName === name && t.transactionType === 'CREATE');
      if (!tx) fail(`broadcast log missing CREATE for ${name}`);
      return tx.contractAddress;
    };
    const mining = addrOf('BotcoinMiningV4');
    const cortexState = addrOf('CortexState');
    const botcoinAddr = addrOf('MockERC20');
    const minerAddr = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
    log(`addresses botcoin=${botcoinAddr} cortexState=${cortexState} mining=${mining}`);

    // Query chain to assert state advanced and miner earned credits.
    const epochIdU64 = await readEpochId(RPC_URL, mining);
    const epochState = await readCortexEpoch(RPC_URL, cortexState, epochIdU64);
    const minerCredits = await readMinerCredits(RPC_URL, mining, epochIdU64, minerAddr);
    log(`epoch=${epochIdU64} stateRoot=${epochState.stateRoot} transitions=${epochState.transitionCount} credits=${minerCredits}`);
    if (hexNorm(epochState.stateRoot) !== hexNorm(newStateRootHex)) {
      fail(`final root mismatch chain=${epochState.stateRoot} expected=${newStateRootHex}`);
    }
    if (epochState.transitionCount !== 1n) fail(`expected 1 transition got ${epochState.transitionCount}`);
    if (minerCredits === 0n) fail('miner earned zero credits');
    const resultJson = { mining, cortexState };

    log('querying chain for V4 events');
    const logs = await rangeLogs(RPC_URL, [resultJson.mining, resultJson.cortexState], '0x0', 'latest');
    const patchEvents = logs.filter((l) => l.topics?.[0]?.toLowerCase() === V4_EVENT_TOPICS.CoretexPatchBytes.toLowerCase());
    const advanceEvents = logs.filter((l) => l.topics?.[0]?.toLowerCase() === V4_EVENT_TOPICS.CortexStateAdvanced.toLowerCase());
    log(`fetched logs total=${logs.length} patchEvents=${patchEvents.length} advanceEvents=${advanceEvents.length}`);
    if (patchEvents.length !== 1) fail(`expected exactly 1 CoretexPatchBytes event, got ${patchEvents.length}`);
    if (advanceEvents.length !== 1) fail(`expected exactly 1 CortexStateAdvanced event, got ${advanceEvents.length}`);

    log('replaying transitions from chain logs');
    const replayResult = replayV4TransitionsFromLogs(parentState, logs);
    if (!replayResult.ok) {
      console.error(JSON.stringify(replayResult, null, 2));
      fail(`replay failed transitionCount=${replayResult.transitionCount} errorCode=${replayResult.error?.code}`);
    }
    if (replayResult.transitionCount !== 1) fail(`replay produced ${replayResult.transitionCount} transitions, expected 1`);
    const reproducedRoot = replayResult.results[0].reproducedStateRoot;
    if (hexNorm(reproducedRoot) !== hexNorm(newStateRootHex)) {
      fail(`replay reproduced root ${reproducedRoot} != expected ${newStateRootHex}`);
    }
    const repScoreDelta = replayResult.results[0].scoreDeltaPpm;
    if (BigInt(repScoreDelta) !== BigInt(SCORE_DELTA_PPM)) {
      fail(`replay score delta ${repScoreDelta} != expected ${SCORE_DELTA_PPM}`);
    }
    log(`replay reproduced final root ${reproducedRoot} (delta ${repScoreDelta} ppm)`);

    // Cross-check: query all V4 logs (no topic filter) to count WorkCreditAccepted (screener + advance).
    const acceptedTopic = bytesToHex(keccak256(new TextEncoder().encode(
      'WorkCreditAccepted(uint64,address,uint64,uint8,uint8,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint16,uint256)',
    )));
    const allMiningLogs = await rpcCall(RPC_URL, 'eth_getLogs', [{
      fromBlock: '0x0',
      toBlock: 'latest',
      address: resultJson.mining,
      topics: [acceptedTopic],
    }]);
    log(`WorkCreditAccepted events total=${allMiningLogs.length}`);
    if (allMiningLogs.length !== 2) fail(`expected 2 WorkCreditAccepted events (screener + advance), got ${allMiningLogs.length}`);

    log('all phase-10 assertions PASSED');
    log('  - on-chain CortexState root advanced: ' + newStateRootHex);
    log('  - replay client reproduced new state root from parent + chain events');
    log('  - screener + state-advance receipts both earned credits without state mutation collision');
  } finally {
    stopAnvil();
    await wait(250);
  }
}

main().catch((e) => {
  console.error(`[phase-10] unhandled error: ${e?.stack ?? String(e)}`);
  process.exit(2);
});
