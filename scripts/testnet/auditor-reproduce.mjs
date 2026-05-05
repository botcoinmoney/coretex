#!/usr/bin/env node
// Phase 8 auditor reproduction.
// Runs `botcoin-cortex verify-epoch <e>` for one or more finalized epochs
// against the testnet RPC and reports match/divergence.
//
// Usage:
//   node scripts/testnet/auditor-reproduce.mjs --epoch 50
//   node scripts/testnet/auditor-reproduce.mjs --range 50,75
//   node scripts/testnet/auditor-reproduce.mjs --snapshot-anchored 50,75

import { exit, env, argv } from 'node:process';
import { spawnSync } from 'node:child_process';

const args = Object.fromEntries(argv.slice(2)
  .map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i+1]] : [])
  .filter((p) => p && p.length === 2));

const RPC = env.BASE_TESTNET_RPC_URL ?? env.BASE_RPC_URL;
if (!RPC) { console.error('BASE_TESTNET_RPC_URL or BASE_RPC_URL required'); exit(1); }
const REGISTRY = env.CORTEX_REGISTRY_ADDRESS;
if (!REGISTRY) { console.error('CORTEX_REGISTRY_ADDRESS required'); exit(1); }

let epochs = [];
if (args.epoch) epochs = [parseInt(args.epoch, 10)];
else if (args.range) {
  const [a, b] = args.range.split(',').map((s) => parseInt(s, 10));
  for (let e = a; e <= b; e++) epochs.push(e);
} else if (args['snapshot-anchored']) {
  const [a, b] = args['snapshot-anchored'].split(',').map((s) => parseInt(s, 10));
  for (let e = a; e <= b; e++) epochs.push(e);
} else {
  console.error('usage: --epoch <n> | --range a,b | --snapshot-anchored a,b');
  exit(1);
}

let pass = 0, fail = 0;
for (const e of epochs) {
  const args2 = ['packages/cortex/dist/cli.js', 'verify-epoch', String(e),
                 '--rpc', RPC, '--registry', REGISTRY, '--json'];
  if (args['snapshot-anchored']) {
    args2.push('--start-from-snapshot', String(Math.floor((e-1)/10)*10));
  }
  const r = spawnSync('node', args2, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`epoch ${e}: verify-epoch failed: ${r.stderr.trim()}`);
    fail++; continue;
  }
  let report;
  try { report = JSON.parse(r.stdout); } catch { fail++; console.error(`epoch ${e}: bad json`); continue; }
  if (report.matchesOnChain) { pass++; console.log(`  PASS  epoch ${e}`); }
  else                       { fail++; console.error(`  FAIL  epoch ${e} — divergence`); }
}

console.log(`\nauditor-reproduce: ${pass}/${epochs.length} matched`);
exit(fail === 0 ? 0 : 1);
