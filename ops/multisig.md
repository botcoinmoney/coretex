# Multisig — Audit-Window Override

> **Trust model:** the EVM cannot re-run Botcoin Core. The 6-hour audit window is **not** an on-chain fraud proof. It is a public delay during which any party can run `botcoin-cortex verify-epoch` locally and demonstrate divergence; if divergence is shown, the operator multisig calls `revertEpoch(epoch)` and the coordinator re-finalizes. Documented honestly to miners. **V1 path** replaces the multisig with bond-based or ZK fraud proofs.

## Operator key set

Published before first reward epoch (Phase 9 deliverable). 2-of-N threshold.

| # | Address | Operator | First-reward-epoch acknowledged |
|---|---------|----------|--------------------------------|
| 1 | _TBD_   | _TBD_    | _TBD_                          |
| 2 | _TBD_   | _TBD_    | _TBD_                          |
| 3 | _TBD_   | _TBD_    | _TBD_                          |

> Each operator must successfully sign a no-op test multisig transaction before the first reward epoch (Phase 9 E2E gate).

## Revert procedure

1. **Detect divergence.** Any party runs:
   ```bash
   botcoin-cortex verify-epoch <epoch> --rpc $BASE_RPC_URL
   ```
   If `newStateRoot` mismatches the on-chain finalized header within `CHALLENGE_WINDOW_SECONDS`, divergence is real. Publish the report (chain-reproducible inputs only).

2. **Convene the multisig.** Operators verify independently. 2-of-N agreement required.

3. **Execute revert.** From the multisig wallet, call:
   ```solidity
   CortexRegistry.revertEpoch(uint64 epoch);
   ```
   This unwinds finalization. No V0 legacy merge-bonus funding is expected for that epoch.

4. **Coordinator re-finalizes.** The coordinator re-runs the reducer on the same input set and re-submits the corrected `CortexEpochFinalized` event. Audit window restarts.

## Hard rules

- **No revert after the audit window closes.** Expired finalizations are canonical.
- **No revert without divergence demonstrated publicly.** Operators do not act on private reports.
- **No revert touches `BotcoinMiningV3`.** State-advance receipts are settled through the existing `BotcoinMining.submitReceipt` path; the revert is scoped to the Cortex state root.
- **Disclosure**: every revert must be followed by a public post-mortem within 72h.

## Pause vs revert

`CortexRegistry.pause()` halts live state advances and finalization at any time. `CortexMergeBonus.pause()` only matters for legacy funded bonus epochs. `revertEpoch` retroactively unwinds a finalized header within the audit window. They are independent powers; pause does not require multisig (single owner key is acceptable for emergency halt), revert does.

See [`runbook.md`](./runbook.md) for emergency-pause vs revert decision flow.
