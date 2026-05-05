# Botcoin Cortex — Verifier Guide

This guide is for **auditors** who reproduce finalized Cortex state from chain alone, and for parties who want to demonstrate divergence within the audit-and-multisig-override window.

## Why audit from chain alone

The Cortex protocol's correctness claim is: **a finalized `newStateRoot` is reproducible byte-identically by anyone who has the published Core V0 binary, a Base RPC endpoint, and the on-chain events.** No coordinator data, no off-chain trust.

If reproduction diverges, the coordinator is wrong. The audit window exists to surface that divergence in time for the multisig to act.

## Tools

```bash
# Install
git clone https://github.com/botcoinmoney/cortex
cd cortex
npm ci && npm run build

# The CLI
node packages/cortex/dist/cli.js verify-epoch <EPOCH> --rpc $BASE_RPC_URL
```

Output is a deterministic JSON report including:

```json
{
  "epoch": 812,
  "parentStateRoot": "0x...",
  "patchSetRoot": "0x...",
  "newStateRoot": "0x...",
  "coreVersionHash": "0x...",
  "experienceCorpusRoot": "0x...",
  "acceptedPatches": [{ "patchHash": "0x...", "miner": "0x..." }, ...],
  "rejectedPatches": [{ "patchHash": "0x...", "reason": "R01_TARGET_OVERLAP" }, ...],
  "matchesOnChain": true
}
```

`matchesOnChain: false` is divergence.

## What `verify-epoch` does

1. Fetches the parent epoch's `CortexEpochFinalized` event from chain. Reads `parentStateRoot` from it. (For epoch 0 this is the genesis state root, published in [`contract-addresses.md`](./contract-addresses.md).)
2. Fetches all `CortexPatchAccepted(epoch=<EPOCH>)` events. Each event carries the **full `compactPatchBytes`** in calldata — not just the hash. Data availability is binding.
3. Decodes each patch via `decodePatch` (specs/patch_format_v0.md).
4. Re-runs the deterministic reducer (specs/reducer_v0.md): sort by `(scoreDelta, -patchSize, +patchHash)` desc; apply in order with target-overlap and semantic-conflict guards.
5. Re-derives `patchSetRoot` and `newStateRoot`.
6. Compares against the on-chain `CortexEpochFinalized` for `<EPOCH>`. Reports match or divergence.

## What you need locally

- Node ≥ 20.10
- Foundry ≥ 1.5 (for chain RPC + ABI helpers)
- A Base RPC URL (free public endpoints work for read-only audits)
- The published Core V0 binary (`packages/cortex/dist/`) — pinned to the `coreVersionHash` posted on chain at epoch start

You do **not** need:

- Any coordinator data
- Any signing key
- A funded mainnet account (read-only RPC is fine)

## Reproducing across snapshot boundaries

Every `SNAPSHOT_EPOCH_INTERVAL` epochs (V0 default: 100), `CortexRegistry` emits a `CortexStateSnapshot` event carrying the full 1024 words of state in calldata. To reproduce a recent epoch without scanning every prior `CortexPatchAccepted` since genesis:

```bash
node packages/cortex/dist/cli.js verify-epoch 875 \
  --rpc $BASE_RPC_URL \
  --start-from-snapshot 800
```

The CLI loads the snapshot at epoch 800, then replays events from `(800, 875]`. Equivalent result, much less RPC work.

## Demonstrating divergence (audit window)

If `verify-epoch` reports `matchesOnChain: false` within `CHALLENGE_WINDOW_SECONDS` of the epoch's finalization timestamp:

1. **Generate a divergence report.** The JSON report from `verify-epoch` is the public artifact. Include:
   - Inputs: `parentStateRoot`, list of `CortexPatchAccepted` event log indices included.
   - Replay output: your computed `newStateRoot`.
   - On-chain: the `CortexEpochFinalized.newStateRoot` for the same epoch.
   - The `coreVersionHash` you used (must match the on-chain hash).

2. **Publish the report.** Post to a public location (the issue tracker on this repo accepts divergence reports as labeled issues).

3. **Notify the multisig.** Operator addresses are published in [`docs/multisig-key-set.md`](./multisig-key-set.md). 2-of-N agreement is required to call `CortexRegistry.revertEpoch(<EPOCH>)`.

4. **Operator response.** Operators verify your report independently. If 2-of-N agree, they call `revertEpoch(<EPOCH>)`. The coordinator re-finalizes, the audit window restarts, `CortexMergeBonus` is not funded for that epoch.

**Hard rules** (per [`ops/multisig.md`](../ops/multisig.md)):
- No revert after the audit window closes.
- No revert without divergence demonstrated publicly.
- No revert touches `BotcoinMiningV3`. Screener-pass receipts are already settled.
- Every revert must be followed by a public post-mortem within 72h.

## What does *not* trigger a revert

- `verify-epoch` succeeds and matches on-chain → no action.
- Divergence after the audit window → cannot revert; document for V1 (bond/ZK fraud proofs).
- Disagreement with the score formula or family weights → these are governance changes, not divergence; raise a new spec PR.
- A patch you think *should* have been accepted but wasn't → re-run the reducer locally; if the inputs match and the output is the same, the result is canonical.

## Worked example

Suppose you suspect epoch 812 diverged.

```bash
$ node packages/cortex/dist/cli.js verify-epoch 812 --rpc $BASE_RPC_URL --json > report.json
$ jq .matchesOnChain report.json
true
```

In this case there is no divergence. Move on.

If `matchesOnChain` is `false`:

```bash
$ jq '{epoch, parentStateRoot, patchSetRoot: .reproduced.patchSetRoot, onChainPatchSetRoot: .onChain.patchSetRoot, newStateRoot: .reproduced.newStateRoot, onChainNewStateRoot: .onChain.newStateRoot}' report.json
```

You'd see exactly which root diverges. File the divergence report against the multisig.

## Reproducing the merge-bonus funding root

Funding for an epoch posts a Merkle root of `(miner, bonusBOTCOIN, capBOTCOIN)` leaves. You can reproduce it:

```bash
node packages/cortex/dist/cli.js reduce-epoch \
  <state.bin> <patches.json> \
  --emit-funding-root
```

The output should match the funding tx's `EpochFunded(epoch, minerBonusRoot, totalBonus)` event for the same epoch. If it doesn't, that's also reportable divergence — same revert procedure.

## See also

- [`miner-guide.md`](./miner-guide.md) — what miners do.
- [`multisig-key-set.md`](./multisig-key-set.md) — the operator key set + revert procedure.
- [`receipt-mapping.md`](./receipt-mapping.md) — how to read Cortex receipts on-chain.
- [`../specs/reducer_v0.md`](../specs/reducer_v0.md) — full reducer algorithm.
- [`../specs/merkleization_spec_v0.md`](../specs/merkleization_spec_v0.md) — state Merkle layout.
