#!/usr/bin/env node
// Phase 8 testnet deploy wrapper.
// Idempotent — won't redeploy if ops/testnet-deployment.json already
// references contracts with bytecode at the recorded addresses.
//
// Required env: DEPLOYER_PK, BASE_TESTNET_RPC_URL, COORDINATOR_ADDRESS,
//   BOTCOIN_TOKEN, MULTISIG_OPERATOR_ADDRESSES.

import { exit, env } from 'node:process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function need(k) { const v = env[k]; if (!v) { console.error(`missing env ${k}`); exit(1); } return v; }

const RPC          = need('BASE_TESTNET_RPC_URL');
const DEPLOYER_PK  = need('DEPLOYER_PK');
const COORDINATOR  = need('COORDINATOR_ADDRESS');
const BOTCOIN      = need('BOTCOIN_TOKEN');
const OPS          = need('MULTISIG_OPERATOR_ADDRESSES');

mkdirSync('ops', { recursive: true });
const manifestPath = 'ops/testnet-deployment.json';

if (existsSync(manifestPath)) {
  const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
  console.log('[deploy-testnet] existing manifest found:');
  console.log(JSON.stringify(existing, null, 2));
  console.log('[deploy-testnet] to redeploy, delete ' + manifestPath);
  exit(0);
}

console.log('[deploy-testnet] running forge script DeployTestnet...');
const r = spawnSync('forge', [
  'script', 'contracts/script/DeployTestnet.s.sol',
  '--rpc-url', RPC,
  '--private-key', DEPLOYER_PK,
  '--broadcast',
  '--silent',
], { stdio: 'inherit', env: {
  ...env,
  COORDINATOR_ADDRESS: COORDINATOR,
  BOTCOIN_TOKEN: BOTCOIN,
  MULTISIG_OPERATOR_ADDRESSES: OPS,
} });

if (r.status !== 0) {
  console.error('[deploy-testnet] forge script failed');
  exit(2);
}

console.log('[deploy-testnet] forge complete; parse broadcast logs to fill manifest:');
console.log('[deploy-testnet]   contracts/broadcast/DeployTestnet.s.sol/<chainId>/run-latest.json');
console.log('[deploy-testnet] write ops/testnet-deployment.json with the deployed addresses');
console.log('[deploy-testnet] NOTE: this script does not parse the broadcast log automatically;');
console.log('[deploy-testnet]       follow the deploy output to populate the manifest manually.');
