# Cortex V0 Non-Goals

> Phase 0 deliverable. The list of things V0 explicitly does **not** ship, so the design does not sprawl.

V0 is a **memory-codec improvement lane that pays through the existing receipt path**. Not a model-training lane.

## Hard rejected

- Weights on-chain.
- LoRA mining.
- Arbitrary memory text storage on-chain.
- Miner-to-miner mandatory coordination.
- Subjective AI judging in canonical scoring.
- Constantly mutable Botcoin Core (Core upgrades publish a `state_translation_patch` or explicit reset; ambiguity is not acceptable — §3 Phase 3).
- Separate Cortex reward currency.
- New EIP-712 domain. (Cortex receipts ride the existing `BotcoinMining` domain with the §6 receipt field mapping, `rulesVersion = 0xC0`.)
- Editing `BotcoinMiningV3`. The contract is unmodified.
- On-chain fraud proofs for the audit window in V0. (V1 path: bond-based or ZK fraud proofs.)

## Tracked V1 paths (not blocking V0)

- `BotcoinMining.submitCortexReceipt(...)` sister function with explicit Cortex field names.
- Bond-based or ZK fraud proofs replacing the multisig audit-window override.

These are listed in [`ORGANISM_CORTEX_STATE_PLAN.md`](../ORGANISM_CORTEX_STATE_PLAN.md) §9 Phase 9 release notes.
