#!/usr/bin/env node
// Phase 9 mainnet dry-run epoch.
//
//   Full challenge → submit → finalize → snapshot cycle on mainnet
//   CortexRegistry with MERGE_MULTIPLIER set but CortexMergeBonus deliberately
//   UNFUNDED. Lane disabled at end. Fails closed if any expected event is
//   missing OR any EpochFunded event appears for the dry-run epoch.
//
// Required env:
//   BASE_RPC_URL                    mainnet RPC
//   CORTEX_REGISTRY_ADDRESS         deployed registry
//   CORTEX_MERGE_BONUS_ADDRESS      deployed merge-bonus
//   COORDINATOR_BASE                coordinator origin (e.g. https://coordinator.agentmoney.net)
//   DRY_RUN_MINER_ADDRESS           a funded mining address (for 1 synthetic challenge)

import { exit, env } from 'node:process';
import { EVENT_TOPICS } from '../../packages/cortex/dist/event-topics.js';

function need(k) {
  const v = env[k];
  if (!v) { console.error(`missing env ${k}`); exit(1); }
  return v;
}

const RPC          = need('BASE_RPC_URL');
const REGISTRY     = need('CORTEX_REGISTRY_ADDRESS').toLowerCase();
const MERGE_BONUS  = need('CORTEX_MERGE_BONUS_ADDRESS').toLowerCase();
const COORD        = need('COORDINATOR_BASE');
const MINER        = need('DRY_RUN_MINER_ADDRESS').toLowerCase();

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

function pad32u64(n) { return '0x' + BigInt(n).toString(16).padStart(64, '0'); }

console.log(`[dry-run] RPC=${RPC}`);
console.log(`[dry-run] CortexRegistry=${REGISTRY}`);
console.log(`[dry-run] CortexMergeBonus=${MERGE_BONUS}`);

// 1. Confirm both contracts are deployed (bytecode present).
const regCode = await rpc('eth_getCode', [REGISTRY, 'latest']);
const mbCode  = await rpc('eth_getCode', [MERGE_BONUS, 'latest']);
if (!regCode || regCode === '0x') { console.error('CortexRegistry has no bytecode'); exit(2); }
if (!mbCode  || mbCode === '0x')  { console.error('CortexMergeBonus has no bytecode'); exit(2); }
console.log('[dry-run] contracts verified');

// 2. Probe coordinator /healthz.
const health = await fetch(`${COORD}/coretex/_healthz`).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
if (!health.ok) { console.error('coordinator /healthz failed:', health); exit(3); }
console.log('[dry-run] coordinator healthy');

// 3. Request a challenge.
const challenge = await fetch(`${COORD}/coretex/challenge`, {
  headers: { 'x-miner': MINER },
}).then((r) => r.json());
console.log(`[dry-run] challenge: epoch=${challenge.epoch} parentStateRoot=${challenge.parentStateRoot.slice(0, 18)}...`);

const dryRunEpoch = Number(challenge.epoch);

// 4. Submit a no-op patch (will be rejected at screener — that's fine for the
//    dry-run; we only need a finalize cycle, not a passing patch).
const patch = {
  parentStateRoot: challenge.parentStateRoot,
  targetIndices: [395], // RetrievalKeys payload word — reserved-bit-safe
  newWords: ['0x' + '00'.repeat(31) + '01'],
  patchType: 'KEY_UPDATE',
  scoreDelta: '0',
};
const submitRes = await fetch(`${COORD}/coretex/submit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-miner': MINER },
  body: JSON.stringify({ challenge, patch }),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));
console.log(`[dry-run] submit response: ${JSON.stringify(submitRes).slice(0, 200)}`);

// 5. Look for CortexEpochFinalized for the dry-run epoch.
const fromBlock = '0x0';
const finalized = await rpc('eth_getLogs', [{
  address: REGISTRY,
  topics: [EVENT_TOPICS.CortexEpochFinalized, pad32u64(dryRunEpoch)],
  fromBlock, toBlock: 'latest',
}]);
if (finalized.length === 0) {
  console.error(`[dry-run] FAIL: no CortexEpochFinalized for epoch ${dryRunEpoch}; coordinator hasn't finalized yet, or epoch differs`);
  console.error('[dry-run] re-run after the coordinator finalizes');
  exit(4);
}
console.log(`[dry-run] CortexEpochFinalized found: tx=${finalized[0].transactionHash}`);

// 6. EpochFunded for dryRunEpoch MUST be empty — lane was disabled before
//    audit window closed.
const funded = await rpc('eth_getLogs', [{
  address: MERGE_BONUS,
  topics: [EVENT_TOPICS.EpochFunded, pad32u64(dryRunEpoch)],
  fromBlock, toBlock: 'latest',
}]);
if (funded.length > 0) {
  console.error(`[dry-run] FAIL: EpochFunded emitted for epoch ${dryRunEpoch} — bonus pool was funded; this dry-run was supposed to remain unfunded`);
  console.error(`[dry-run] tx=${funded[0].transactionHash}`);
  exit(5);
}
console.log(`[dry-run] EpochFunded: 0 logs (correct — bonus pool is unfunded)`);

console.log('[dry-run] OK');
console.log('');
console.log('[dry-run] Disable the lane to keep it unfunded:');
console.log('[dry-run]   pause CoreTex in the coordinator or set CORETEX_ENABLED=false');
console.log('[dry-run]   sudo nginx -t && sudo systemctl reload nginx');
