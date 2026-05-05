#!/usr/bin/env node
// Phase 9 emergency-disable rehearsal.
// Per §9 Phase 9 — "Emergency disable rehearsal":
//
//   Pause CortexRegistry mid-epoch on mainnet; SWCP claim parity preserved
//   end-to-end through a real claim transaction.
//
// Modes (same as multisig-revert-rehearsal.mjs):
//   - synthetic: anvil-driven drill in CI.
//   - mainnet: requires MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL.

import { exit, env } from 'node:process';

const MODE = env.MAINNET_CONFIRM ? 'mainnet' : 'synthetic';
console.log(`[pause-drill] mode=${MODE}`);

if (MODE === 'mainnet') {
  if (env.MAINNET_CONFIRM !== 'I-UNDERSTAND-THIS-IS-MAINNET-DRILL') {
    console.error('mainnet mode requires MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL');
    exit(1);
  }
  console.log('[pause-drill] MAINNET MODE');
  console.log('[pause-drill] step 1: cast send $CORTEX_REGISTRY_ADDRESS "pause()" --rpc-url $BASE_RPC_URL --private-key $OWNER_KEY');
  console.log('[pause-drill] step 2: confirm CortexRegistry.paused() == true');
  console.log('[pause-drill] step 3: a SWCP miner submits a SWCP receipt — verify it lands and claim succeeds');
  console.log('[pause-drill] step 4: a Cortex miner attempts /v1/cortex/submit — verify finalize is blocked');
  console.log('[pause-drill] step 5: cast send $CORTEX_REGISTRY_ADDRESS "unpause()"');
  console.log('[pause-drill] step 6: verify Cortex finalize resumes on next epoch');
  console.log('[pause-drill] command sequence printed above; this script does not broadcast for you');
  exit(0);
}

console.log('[pause-drill] synthetic mode (anvil)');
console.log('[pause-drill] would: 1) deploy CortexRegistry + a mock BotcoinMiningV3 on anvil');
console.log('[pause-drill]        2) submit a SWCP receipt + claim — confirm path works');
console.log('[pause-drill]        3) call CortexRegistry.pause() from owner');
console.log('[pause-drill]        4) submit another SWCP receipt — confirm SWCP unaffected');
console.log('[pause-drill]        5) attempt finalizeEpoch — confirm reverts with "paused"');
console.log('[pause-drill]        6) unpause; finalize resumes');
console.log('[pause-drill] FULL DRIVER: TBD — wire actual forge/anvil invocations in P9 follow-up');
console.log('[pause-drill] synthetic drill scaffolded; CI runs it via test/e2e/phase-9/run.mjs');
