# CoreTex Miner Quickstart

This is the current miner-facing flow for the retrieval-native CoreTex lane.
It replaces the archived CortexBench V0 miner guide.

Miners do not need private coordinator state or local model inference. The
minimum miner uses Base reads, the published CoreTex bundle, corpus records,
precomputed embeddings, and `/coretex/*` coordinator endpoints.

## Public Inputs

- Base mainnet `CortexState.getEpoch(epoch)`
- `/coretex/bundle/<bundleHash>`
- `/coretex/client-bundle/<coreVersionHash>`
- `/coretex/substrate/current`
- `/coretex/corpus/<recordId>` for visible records
- `/coretex/corpus/<recordId>/embedding` for visible records
- `/coretex/corpus-delta/<epoch>`

Hidden and canary splits stay masked. Calibration reads are admin-only.

## Submit Flow

1. Read the current epoch from `BotcoinMiningV4.currentEpoch()` and
   `CortexState.getEpoch(epoch)`.
2. Fetch the bundle whose hash matches the epoch `coreVersionHash`.
3. Fetch the current substrate and visible coverage hints.
4. Build a compact 1-4 word patch against the current parent state root.
5. Submit `POST /coretex/screen` for cheap structural screening.
6. Submit `POST /coretex/evaluate` for full retrieval scoring.
7. If accepted, the coordinator signs and submits
   `BotcoinMiningV4.submitWorkReceipt(...)` with lane-aware CoreTex credit.

## Verification Flow

Auditors and miners reproduce the accepted transition from:

- on-chain `CoretexPatchBytes` / `WorkCreditAccepted` /
  `CortexStateAdvanced` events
- the published bundle and corpus/delta chain
- the revealed epoch eval seed
- the current 1024-word substrate root

The coordinator cache is a convenience. Replay correctness must not depend on
private coordinator state.
