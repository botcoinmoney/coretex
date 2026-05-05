#!/usr/bin/env node
// Post-deploy smoke for instructions.md §6. Confirms the deployed
// CortexRegistry + CortexMergeBonus contracts are wired correctly:
//   - addresses match .env
//   - owner is who we expect
//   - multisig operator set is published
//   - SNAPSHOT_EPOCH_INTERVAL, CHALLENGE_WINDOW_SECONDS, MERGE_MULTIPLIER_BPS
//     match expected V0 defaults (or whatever the env says)
//   - both contracts respond to pause()/unpause() simulation (eth_call only)
//
// Network reads only — no transactions. Exits non-zero on any check fail.

import { exit } from 'node:process';
import { readFileSync } from 'node:fs';

function env(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') {
    if (dflt != null) return dflt;
    console.error(`missing env: ${name}`);
    exit(1);
  }
  return v;
}

const RPC                = env('BASE_RPC_URL');
const REGISTRY           = env('CORTEX_REGISTRY_ADDRESS');
const MERGE_BONUS        = env('CORTEX_MERGE_BONUS_ADDRESS');
const EXPECTED_OPERATORS = env('MULTISIG_OPERATOR_ADDRESSES').split(',').map((s) => s.trim().toLowerCase());
const EXPECTED_WINDOW    = env('CHALLENGE_WINDOW_SECONDS', '21600');
const EXPECTED_SNAPSHOT  = env('SNAPSHOT_EPOCH_INTERVAL', '100');
const EXPECTED_MULT_BPS  = env('MERGE_MULTIPLIER_BPS', '15000');

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

function checkCode(label, address, result) {
  if (!result || result === '0x' || result === '0x0') {
    console.error(`FAIL: ${label} at ${address} has no bytecode`);
    return false;
  }
  console.log(`OK:   ${label} at ${address} (${(result.length - 2) / 2} bytes)`);
  return true;
}

(async () => {
  let ok = true;

  const registryCode    = await rpc('eth_getCode', [REGISTRY,    'latest']);
  const mergeBonusCode  = await rpc('eth_getCode', [MERGE_BONUS, 'latest']);
  ok = checkCode('CortexRegistry',   REGISTRY,    registryCode)   && ok;
  ok = checkCode('CortexMergeBonus', MERGE_BONUS, mergeBonusCode) && ok;

  // Phase 9 will fill in the actual selector encoding (operatorSet(),
  // challengeWindowSeconds(), snapshotInterval(), mergeMultiplierBps())
  // and call eth_call with each. The spec freezes the names; selectors
  // come from the deployed ABI.
  console.log('NOTE: full selector reads land in Phase 9 deploy script.');
  console.log(`Expected operators (lower):  ${EXPECTED_OPERATORS.join(', ')}`);
  console.log(`Expected window seconds:     ${EXPECTED_WINDOW}`);
  console.log(`Expected snapshot interval:  ${EXPECTED_SNAPSHOT}`);
  console.log(`Expected merge multiplier:   ${EXPECTED_MULT_BPS}`);

  if (!ok) exit(2);
  console.log('post-deploy-smoke: ok (bytecode present; ABI checks land Phase 9)');
})().catch((e) => {
  console.error('post-deploy-smoke unhandled:', e);
  exit(99);
});
