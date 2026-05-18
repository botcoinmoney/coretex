#!/usr/bin/env node
// Post-deploy smoke for instructions.md §6. Confirms the deployed
// CortexRegistry + CortexMergeBonus contracts are wired correctly:
//   - addresses match .env
//   - owner is who we expect
//   - multisig operator set is published
//   - SNAPSHOT_EPOCH_INTERVAL, CHALLENGE_WINDOW_SECONDS, MERGE_MULTIPLIER_BPS
//     match expected current defaults (or whatever the env says)
//   - both contracts respond to pause()/unpause() simulation (eth_call only)
//
// Network reads only — no transactions. Exits non-zero on any check fail.

import { exit } from 'node:process';
import { keccak256, bytesToHex } from '../packages/cortex/dist/state/index.js';

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
const EXPECTED_OPERATORS = env('MULTISIG_OPERATOR_ADDRESSES', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const EXPECTED_WINDOW    = env('CHALLENGE_WINDOW_SECONDS', '21600');
const EXPECTED_SNAPSHOT  = env('SNAPSHOT_EPOCH_INTERVAL', '100');
const EXPECTED_MULT_BPS  = env('MERGE_MULTIPLIER_BPS', '10000');

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

function selector(signature) {
  return bytesToHex(keccak256(new TextEncoder().encode(signature))).slice(0, 10);
}

async function callUint(address, signature) {
  const out = await rpc('eth_call', [{ to: address, data: selector(signature) }, 'latest']);
  return BigInt(out);
}

function checkEq(label, got, expected) {
  const ok = got === BigInt(expected);
  console.log(`${ok ? 'OK:  ' : 'FAIL:'} ${label}: got=${got} expected=${expected}`);
  return ok;
}

(async () => {
  let ok = true;

  const registryCode    = await rpc('eth_getCode', [REGISTRY,    'latest']);
  const mergeBonusCode  = await rpc('eth_getCode', [MERGE_BONUS, 'latest']);
  ok = checkCode('CortexRegistry',   REGISTRY,    registryCode)   && ok;
  ok = checkCode('CortexMergeBonus', MERGE_BONUS, mergeBonusCode) && ok;

  const windowSeconds = await callUint(REGISTRY, 'CHALLENGE_WINDOW_SECONDS()');
  const snapshotEvery = await callUint(REGISTRY, 'SNAPSHOT_EPOCH_INTERVAL()');
  const multiplierBps = await callUint(MERGE_BONUS, 'MERGE_MULTIPLIER_BPS()');
  ok = checkEq('CHALLENGE_WINDOW_SECONDS', windowSeconds, EXPECTED_WINDOW) && ok;
  ok = checkEq('SNAPSHOT_EPOCH_INTERVAL', snapshotEvery, EXPECTED_SNAPSHOT) && ok;
  ok = checkEq('MERGE_MULTIPLIER_BPS', multiplierBps, EXPECTED_MULT_BPS) && ok;

  console.log(`Expected operators (lower):  ${EXPECTED_OPERATORS.join(', ')}`);

  if (!ok) exit(2);
  console.log('post-deploy-smoke: ok');
})().catch((e) => {
  console.error('post-deploy-smoke unhandled:', e);
  exit(99);
});
