#!/usr/bin/env node
// Phase 9 mainnet dry-run epoch.
// Per ORGANISM_CORTEX_STATE_PLAN.md §9 Phase 9 — "Mainnet dry-run epoch":
//
//   Full challenge → submit → finalize → snapshot cycle on mainnet
//   CortexRegistry with MERGE_MULTIPLIER set but CortexMergeBonus
//   deliberately UNFUNDED. Lane disabled at end. Observe events; verify zero
//   merge-bonus funding.
//
// Required env:
//   BASE_RPC_URL                    mainnet RPC
//   CORTEX_REGISTRY_ADDRESS         deployed registry
//   CORTEX_MERGE_BONUS_ADDRESS      deployed merge-bonus
//   COORDINATOR_BASE                cortex-server origin (e.g. https://coordinator.agentmoney.net)
//   DRY_RUN_MINER_ADDRESS           a funded mining address (for 1 synthetic challenge)
//
// Exits non-zero if:
//   - any contract call fails
//   - CortexEpochFinalized event is missing for the dry-run epoch
//   - any EpochFunded event appears for the dry-run epoch (must be unfunded)

import { exit, env } from 'node:process';
import { readFileSync } from 'node:fs';

function need(k) {
  const v = env[k];
  if (!v) { console.error(`missing env ${k}`); exit(1); }
  return v;
}

const RPC          = need('BASE_RPC_URL');
const REGISTRY     = need('CORTEX_REGISTRY_ADDRESS');
const MERGE_BONUS  = need('CORTEX_MERGE_BONUS_ADDRESS');
const COORD        = need('COORDINATOR_BASE');
const MINER        = need('DRY_RUN_MINER_ADDRESS');

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

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
const health = await fetch(`${COORD}/v1/cortex/_healthz`).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
if (!health.ok) { console.error('coordinator /healthz failed:', health); exit(3); }
console.log('[dry-run] coordinator healthy');

// 3. Request a challenge.
const challenge = await fetch(`${COORD}/v1/cortex/challenge`, {
  headers: { 'x-miner': MINER },
}).then((r) => r.json());
console.log(`[dry-run] challenge: epoch=${challenge.epoch} parentStateRoot=${challenge.parentStateRoot.slice(0, 18)}...`);

const dryRunEpoch = challenge.epoch;

// 4. Submit a no-op patch (will be rejected at screener — that's fine for the
//    dry-run; we only need a finalize cycle, not a passing patch).
const patch = {
  parentStateRoot: challenge.parentStateRoot,
  targetIndices: [42],
  newWords: ['0x' + '00'.repeat(31) + '01'],
  patchType: 'KEY_UPDATE',
  scoreDelta: '0',
};
const submitRes = await fetch(`${COORD}/v1/cortex/submit`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-miner': MINER },
  body: JSON.stringify({ challenge, patch }),
}).then((r) => r.json()).catch((e) => ({ error: String(e) }));
console.log(`[dry-run] submit response: ${JSON.stringify(submitRes).slice(0, 120)}...`);

// 5. Wait for the epoch to finalize (≤ epochDuration + slack).
console.log('[dry-run] waiting for epoch finalize (manual step — coordinator advances epochs)');
console.log('[dry-run] re-run this script after the next CortexEpochFinalized event lands');

// 6. Fetch CortexEpochFinalized for dryRunEpoch.
const eventTopic = '0x' /* keccak256("CortexEpochFinalized(uint64,bytes32,bytes32,bytes32,bytes32,bytes32)") */
  + 'TBD'; // TODO(P9): paste actual topic from forge inspect on the deployed ABI
console.log(`[dry-run] event topic placeholder: ${eventTopic}`);
console.log('[dry-run] would fetch via eth_getLogs filtered to CortexEpochFinalized + epoch=' + dryRunEpoch);

// 7. Confirm CortexMergeBonus is UNFUNDED for this epoch.
//    Check no EpochFunded event for dryRunEpoch.
console.log(`[dry-run] would fetch EpochFunded(${dryRunEpoch}) — must return 0 logs`);

// 8. Lane disable (operator action — we just print the command).
console.log('[dry-run] After verification, disable the lane:');
console.log('[dry-run]   sudo systemctl stop cortex-server');
console.log('[dry-run]   sudo nginx -t && sudo systemctl reload nginx');

console.log('[dry-run] DRY-RUN PLACEHOLDER OK — fill in event ABI selectors and re-run after deploy');
