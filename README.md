# Botcoin Cortex

On-chain memory codec mining lane for Botcoin. Miners propose tiny patches to a compact, on-chain-rooted 1024-word memory codec; Botcoin Core verifies improvements deterministically against an anchored benchmark; screener-pass patches earn credits at the miner's current on-chain tier through the same `BotcoinMining.submitReceipt` path; merged patches earn a multiplier-uplift bonus through a peer `CortexMergeBonus` contract that mirrors the existing `BonusEpoch` pattern.

`BotcoinMiningV3` is **unchanged**. The SWCP challenge system is **unchanged**. Cortex is a parallel lane behind the same coordinator origin (`/v1/cortex/*`) and pays through the existing receipt path.

## Status

Pre-V0. See [`context.md`](./context.md) for current state and [`ORGANISM_CORTEX_STATE_PLAN.md`](./ORGANISM_CORTEX_STATE_PLAN.md) (in source repo) for the canonical phase-by-phase plan.

## Wiring

To stand up Cortex against an existing Botcoin coordinator, follow [`instructions.md`](./instructions.md). The plug-and-play guarantee: `packages/cortex-handler` exports a single mountable router the existing coordinator imports in **one line** plus signing-key wiring. No edits to existing SWCP routes. No edits to `BotcoinMiningV3`.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
