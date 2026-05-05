# Multisig Operator Key Set

> **TEMPLATE.** Operator addresses MUST be published here before the first reward epoch (Phase 9 E2E gate). Cross-reference with [`../ops/multisig.md`](../ops/multisig.md) for the canonical revert procedure.

## Threshold

**2-of-N** required to call `CortexRegistry.revertEpoch(epoch)`. N ≥ 3 in V0.

## Operator set

| # | Address      | Operator                                | Public key (sample-signed) | First-reward-epoch acknowledged |
|---|--------------|-----------------------------------------|----------------------------|--------------------------------|
| 1 | `<TBD>`      | `<TBD>`                                 | `<sample-signed-tx-hash>`  | `<TBD>`                        |
| 2 | `<TBD>`      | `<TBD>`                                 | `<sample-signed-tx-hash>`  | `<TBD>`                        |
| 3 | `<TBD>`      | `<TBD>`                                 | `<sample-signed-tx-hash>`  | `<TBD>`                        |

> **Phase 9 gate**: each operator must sign a no-op test multisig transaction before the first reward epoch. Record the resulting tx hash in the table above.

## Revert procedure

See [`../ops/multisig.md`](../ops/multisig.md). Summary:

1. Detect divergence: any party runs `botcoin-cortex verify-epoch <epoch>` within `CHALLENGE_WINDOW_SECONDS` and publishes the report.
2. Convene multisig: operators verify independently. 2-of-N agreement.
3. Execute: `CortexRegistry.revertEpoch(<epoch>)` from the multisig wallet.
4. Coordinator re-finalizes; audit window restarts.

## Hard rules

- **No revert after the audit window closes.** Expired finalizations are canonical.
- **No revert without divergence demonstrated publicly.**
- **No revert touches `BotcoinMiningV3`.** Screener-pass receipts are already settled.
- **Public post-mortem within 72h** of any successful revert.

## Rotation

Operator addresses are replaced one at a time via `CortexRegistry.setOperator(idx, newAddr)` from the existing 2-of-N. **Public announcement required** before the rotation transaction is broadcast.

## V1 path

Bond-based or ZK fraud proofs replace the multisig override. Tracked in [`v1-roadmap.md`](./v1-roadmap.md).
