#!/usr/bin/env node
/**
 * Base RPC connectivity + history-depth smoke. Required by
 * docs/CORETEX_MAINNET_LAUNCH_CHECKLIST.md §3.5 and the per-patch
 * on-chain randomness design — replay watchers need a Base RPC that
 * retains blockhash history at least `replayBlockhashLookbackBlocks`
 * deep (28 h on Base mainnet at 2 s blocks).
 *
 * Usage:
 *   node scripts/verify-base-rpc.mjs \
 *     --rpc-url https://mainnet.base.org \
 *     --lookback 50000 \
 *     [--bundle-manifest /etc/coretex/bundle-manifest.json]   # validates lookback >= bundle pin
 *     [--out /var/lib/coretex/reports/base-rpc-tier.json]
 *
 * Exit codes:
 *   0   RPC reachable + lookback satisfied
 *   1   RPC reachable but lookback below required depth
 *   2   RPC unreachable or call failed
 *   3   config error
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';

import { createBaseRpcClient } from '@botcoin/coretex';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const rpcUrl = flag('rpc-url');
const lookback = Number(flag('lookback', '50000'));
const bundlePath = flag('bundle-manifest');
const outPath = flag('out');

if (!rpcUrl) {
  console.error('verify-base-rpc: --rpc-url is required');
  exit(3);
}
if (!Number.isInteger(lookback) || lookback < 1) {
  console.error('verify-base-rpc: --lookback must be a positive integer');
  exit(3);
}

// If a bundle manifest is provided, cross-check that --lookback meets
// the bundle's pinned `replayBlockhashLookbackBlocks` floor — otherwise
// the chosen RPC tier silently underprovisions replay coverage.
let bundleLookback = null;
if (bundlePath) {
  try {
    const bundle = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));
    bundleLookback = bundle.evaluator?.profile?.baseRpcConfig?.replayBlockhashLookbackBlocks;
    if (typeof bundleLookback !== 'number') {
      console.error(`verify-base-rpc: bundle does not pin replayBlockhashLookbackBlocks`);
      exit(3);
    }
    if (lookback < bundleLookback) {
      console.error(
        `verify-base-rpc: --lookback=${lookback} below bundle pin ${bundleLookback}; ` +
        `RPC must retain at least the bundle-pinned depth`,
      );
      exit(1);
    }
  } catch (e) {
    console.error(`verify-base-rpc: cannot read bundle manifest: ${e.message}`);
    exit(3);
  }
}

const client = createBaseRpcClient(rpcUrl, { requestTimeoutMs: 15_000 });

const t0 = Date.now();
let head;
try {
  head = await client.getLatestBlockNumber();
} catch (e) {
  console.error(`verify-base-rpc: eth_blockNumber failed against ${rpcUrl}: ${e.message}`);
  exit(2);
}
if (!Number.isInteger(head) || head <= 0) {
  console.error(`verify-base-rpc: eth_blockNumber returned non-positive ${head}`);
  exit(2);
}

const lookbackTarget = head - lookback;
if (lookbackTarget < 0) {
  console.error(`verify-base-rpc: chain head ${head} is below lookback target — chain too young?`);
  exit(2);
}

let lookbackHash;
try {
  lookbackHash = await client.getBlockHash(lookbackTarget);
} catch (e) {
  console.error(
    `verify-base-rpc: getBlockHash(${lookbackTarget}) failed — RPC history shallower than ${lookback} blocks: ${e.message}`,
  );
  exit(1);
}

const dtMs = Date.now() - t0;
const report = {
  schemaVersion: 'coretex.base-rpc-tier.v1',
  generatedAt: new Date().toISOString(),
  rpcUrl,
  chainHead: head,
  lookbackBlocks: lookback,
  lookbackTargetBlock: lookbackTarget,
  lookbackHash,
  bundleLookbackPinned: bundleLookback,
  durationMs: dtMs,
  ok: true,
};

if (outPath) {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), JSON.stringify(report, null, 2));
}

console.log(
  `verify-base-rpc: OK head=${head} lookback=${lookback} blocks ` +
  `(target=${lookbackTarget} hash=${lookbackHash.slice(0, 10)}...) ` +
  `bundle-pin=${bundleLookback ?? 'n/a'} ${dtMs}ms`,
);
