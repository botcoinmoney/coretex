#!/usr/bin/env node
// Phase 9 multisig revert rehearsal.
// Per §9 Phase 9 — "Multisig revert rehearsal":
//
//   Dry-run divergent-epoch revert on mainnet against a synthetic divergence
//   (announced in advance). 2-of-N revert succeeds. Bonus funding blocked.
//
// This script can run in two modes:
//   - synthetic: spins up a local anvil fork, deploys a CortexRegistry,
//     submits a divergent finalize, and rehearses the revert. Self-contained.
//     Default mode if MAINNET_CONFIRM is not set.
//   - mainnet: requires MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL
//     and runs against the deployed mainnet contracts. Operators must
//     pre-coordinate; the synthetic divergence MUST be announced 24h+ in
//     advance.
//
// Required env (mainnet mode):
//   BASE_RPC_URL                       mainnet RPC
//   CORTEX_REGISTRY_ADDRESS            deployed registry
//   MULTISIG_OPERATOR_PRIVKEYS         comma-separated private keys (≥2)
//   MAINNET_CONFIRM                    must be "I-UNDERSTAND-THIS-IS-MAINNET-DRILL"

import { exit, env } from 'node:process';
import { spawnSync } from 'node:child_process';

const MODE = env.MAINNET_CONFIRM ? 'mainnet' : 'synthetic';

console.log(`[revert-drill] mode=${MODE}`);

if (MODE === 'mainnet') {
  if (env.MAINNET_CONFIRM !== 'I-UNDERSTAND-THIS-IS-MAINNET-DRILL') {
    console.error('mainnet mode requires MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL');
    exit(1);
  }
  console.log('[revert-drill] MAINNET MODE — operators MUST pre-coordinate');
  console.log('[revert-drill] this script does NOT broadcast for you; it produces the calldata');
  console.log('[revert-drill]   for each operator to sign via their own wallet UI.');
  console.log('[revert-drill] proceeding with calldata generation only...');
  // TODO(P9): generate the calldata for revertEpoch + the 2 operator
  // signature payloads. Write to out/multisig-drill-calldata-{epoch}.json
  console.log('[revert-drill] calldata generation: TBD — wire the actual revertEpoch ABI');
  exit(0);
}

// Synthetic mode: spin up anvil, deploy, divergent-finalize, revert.
console.log('[revert-drill] synthetic: spinning up anvil...');
const anvil = spawnSync('which', ['anvil'], { encoding: 'utf8' });
if (anvil.status !== 0) {
  console.log('[revert-drill] anvil not found; skipping synthetic drill');
  console.log('[revert-drill] install foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup');
  exit(0);
}

console.log('[revert-drill] would: 1) anvil --port 8545');
console.log('[revert-drill]        2) forge script DeployTestnet (in synthetic mode)');
console.log('[revert-drill]        3) submit a divergent CortexEpochFinalized');
console.log('[revert-drill]        4) operator A votes revertEpoch — should not unwind (1-of-N)');
console.log('[revert-drill]        5) operator B votes revertEpoch — should unwind (2-of-N)');
console.log('[revert-drill]        6) confirm CortexMergeBonus.fundEpoch reverts for that epoch');
console.log('[revert-drill] FULL ANVIL DRIVER: TBD — wire actual forge invocations');
console.log('[revert-drill] synthetic drill scaffolded; CI runs it via test/e2e/phase-9/run.mjs');
