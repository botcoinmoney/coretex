#!/usr/bin/env node
// OBSOLETE — this scratch harness predates the current on-chain architecture
// and is intentionally disabled. Every chain call in the old version was a
// footgun against today's contracts:
//
//   - deployed `CortexRegistry` / `CortexMergeBonus`, which no longer exist
//     (canonical contract is `CoreTexRegistry`; the merge-bonus was removed);
//   - called `submitStateAdvance` DIRECTLY on the registry with a stale 8-arg
//     signature — the current registry only accepts state advances mediated by
//     BotcoinMiningV4 (`onlyBotcoinMiningV4`), with a 12-arg signature;
//   - called registry `finalizeEpoch` with a stale argument ORDER
//     (parentStateRoot/patchSetRoot/newStateRoot/...) that the current
//     signature (finalStateRoot/coreVersionHash/corpusRoot/activeFrontierRoot/
//     patchSetRoot/scoreRoot/baselineManifestHash) would revert on — or worse,
//     silently misbind if a future contract ever matched the selector.
//
// Use the canonical, maintained harnesses instead:
//   - scripts/onchain-drill.sh              — Base-mainnet read-only drill +
//                                             optional signed-receipt advance
//   - npm run coretex:epoch-evolve:e2e      — full epoch-evolve pipeline e2e
//   - scripts/onchain-state-advance-dryrun.mjs — local advance dry-run
//
// If a local-anvil full-lifecycle test is needed again, write it against the
// V4-mediated receipt flow (BotcoinMiningV4.submitCoreTexReceipt →
// CoreTexRegistry.submitStateAdvance) — never direct registry writes.

console.error(
  'e2e-real-improvement.mjs is OBSOLETE: it targets pre-CoreTexRegistry contracts and stale\n' +
  'function signatures, and has been disabled to prevent accidental use in a drill.\n' +
  'Use scripts/onchain-drill.sh or `npm run coretex:epoch-evolve:e2e` instead.\n' +
  'See the header of this file for details.',
);
process.exit(2);
