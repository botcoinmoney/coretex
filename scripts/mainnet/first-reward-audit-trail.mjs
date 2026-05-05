#!/usr/bin/env node
// Phase 9 first-reward audit trail.
// Per §9 Phase 9 — "First-reward audit trail":
//
//   First paying epoch produces a public reproducibility report — chain logs
//   alone reproduce newStateRoot, reducer output, and the (miner, bonusBOTCOIN)
//   funding root byte-identically.
//
// Output: a markdown report at out/first-reward-audit/{epoch}.md plus a JSON
// blob for machine parsing.
//
// Required env:
//   BASE_RPC_URL                  mainnet RPC
//   CORTEX_REGISTRY_ADDRESS       registry
//   CORTEX_MERGE_BONUS_ADDRESS    merge-bonus
//   FIRST_REWARD_EPOCH            the epoch number to audit
//
// Reads only chain data. No coordinator data. No private keys.

import { exit, env } from 'node:process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function need(k) {
  const v = env[k]; if (!v) { console.error(`missing env ${k}`); exit(1); } return v;
}

const RPC      = need('BASE_RPC_URL');
const REGISTRY = need('CORTEX_REGISTRY_ADDRESS');
const MB       = need('CORTEX_MERGE_BONUS_ADDRESS');
const EPOCH    = parseInt(need('FIRST_REWARD_EPOCH'), 10);

console.log(`[audit-trail] auditing epoch ${EPOCH}`);
console.log(`[audit-trail]   RPC=${RPC}`);
console.log(`[audit-trail]   CortexRegistry=${REGISTRY}`);
console.log(`[audit-trail]   CortexMergeBonus=${MB}`);

// 1. Reproduce newStateRoot from chain alone via botcoin-cortex verify-epoch.
const verifyOut = spawnSync('node', [
  'packages/cortex/dist/cli.js', 'verify-epoch', String(EPOCH),
  '--rpc', RPC,
  '--registry', REGISTRY,
  '--json',
], { encoding: 'utf8' });
if (verifyOut.status !== 0) {
  console.error('verify-epoch failed:', verifyOut.stderr);
  exit(2);
}
const verifyReport = JSON.parse(verifyOut.stdout);
console.log(`[audit-trail] verify-epoch matchesOnChain=${verifyReport.matchesOnChain}`);

// 2. Reproduce the funding root via reduce-epoch --emit-funding-root.
//    (Phase 6 lands the funding-tx builder; this script invokes it.)
console.log('[audit-trail] reproducing funding root...');
// TODO(P9): wire reduce-epoch invocation against the parent state from the
//   prior CortexEpochFinalized event. For now, document the interface and
//   ship the report with placeholder values that the user fills in.
const fundingRootReproduced = '<TBD>';
const fundingRootOnChain    = '<TBD>';

// 3. Emit the report.
mkdirSync('out/first-reward-audit', { recursive: true });
const reportPath = join('out/first-reward-audit', `${EPOCH}.md`);
const jsonPath   = join('out/first-reward-audit', `${EPOCH}.json`);

const md = `# First-reward audit trail — epoch ${EPOCH}

Run on: ${new Date().toISOString()}
RPC: ${RPC}
CortexRegistry: ${REGISTRY}
CortexMergeBonus: ${MB}

## State root reproduction

| Field | Reproduced (from chain alone) | On-chain |
|-------|------------------------------|----------|
| parentStateRoot | ${verifyReport.parentStateRoot} | ${verifyReport.onChain.parentStateRoot} |
| patchSetRoot    | ${verifyReport.reproduced.patchSetRoot} | ${verifyReport.onChain.patchSetRoot} |
| newStateRoot    | ${verifyReport.reproduced.newStateRoot} | ${verifyReport.onChain.newStateRoot} |
| matches | **${verifyReport.matchesOnChain}** | — |

## Reducer output

Accepted: ${verifyReport.acceptedPatches.length} patches
Rejected: ${verifyReport.rejectedPatches.length} patches
${verifyReport.rejectedPatches.length > 0 ? '\nRejection codes:\n' + verifyReport.rejectedPatches.map(r => `  - ${r.patchHash} : ${r.reason}`).join('\n') : ''}

## Funding root reproduction

| Field | Reproduced | On-chain |
|-------|------------|----------|
| (miner, bonusBOTCOIN, capBOTCOIN) Merkle root | ${fundingRootReproduced} | ${fundingRootOnChain} |

## Verification

Anyone can reproduce this report:

\`\`\`bash
git clone https://github.com/botcoinmoney/cortex
cd cortex && npm ci && npm run build

BASE_RPC_URL=${RPC} \\
CORTEX_REGISTRY_ADDRESS=${REGISTRY} \\
CORTEX_MERGE_BONUS_ADDRESS=${MB} \\
FIRST_REWARD_EPOCH=${EPOCH} \\
node scripts/mainnet/first-reward-audit-trail.mjs
\`\`\`

The report should be byte-identical (modulo timestamp).
`;

writeFileSync(reportPath, md);
writeFileSync(jsonPath, JSON.stringify({
  epoch: EPOCH,
  rpc: RPC,
  registry: REGISTRY,
  mergeBonus: MB,
  verifyReport,
  fundingRootReproduced,
  fundingRootOnChain,
  generatedAt: new Date().toISOString(),
}, null, 2));

console.log(`[audit-trail] report written: ${reportPath}`);
console.log(`[audit-trail] machine-readable: ${jsonPath}`);

if (!verifyReport.matchesOnChain || fundingRootReproduced === '<TBD>') {
  console.error('[audit-trail] DIVERGENCE or unfilled placeholder — see report');
  exit(3);
}
console.log('[audit-trail] OK');
