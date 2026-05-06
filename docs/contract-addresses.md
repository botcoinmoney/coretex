# Botcoin Cortex — Contract Addresses

> **TEMPLATE.** Replace `<TBD>` with mainnet deploy outputs (Phase 9). Verify against the on-chain bytecode for each address.

## Mainnet (Base)

| Contract            | Address          | Compiler          | First-deploy tx | Source            |
|---------------------|------------------|-------------------|-----------------|-------------------|
| `CortexRegistry`    | `<TBD>`          | solc 0.8.26       | `<TBD>`         | [`contracts/src/CortexRegistry.sol`](../contracts/src/CortexRegistry.sol) |
| `CortexMergeBonus`  | `<TBD>`          | solc 0.8.26       | `<TBD>`         | [`contracts/src/CortexMergeBonus.sol`](../contracts/src/CortexMergeBonus.sol) |
| `BotcoinMiningV3`   | `<EXISTING>`     | (existing — unchanged by Cortex) | (pre-existing) | external repo    |
| `BonusEpochManager` | `0xA185...6Ba8`  | (existing)        | (pre-existing)  | external repo    |

## Genesis state

```
winner:              Baseline A (empty)
genesisStateRoot:    0x7e704f76d6156405800141206cec1e6d7804daa8bf4e7da1542a1e431958504e
coreVersionHash:     0xe1a957805f855828338a2a9d1f90c46eb78c378d85f10c8d8c83a1ce6eb388d3
```

Frozen by `scripts/freeze-core-version.mjs --baseline A` on 2026-05-06
from the real CortexBench V0 evaluator. Selection rationale + numbers in
`experiments/results/phase7-real-30/comparison.md` plus per-seed stability
runs under `experiments/results/phase7-stability/`. Source of truth is
`ops/v0-frozen.json`.

The `coreVersionHash` is committed in the first `CortexEpochFinalized`
event (epoch 0). Auditors must use the corresponding pinned
`packages/cortex/dist/` to reproduce roots — recompute by running
`node scripts/freeze-core-version.mjs --baseline A` against the same
checkout and confirming the same `coreVersionHash` lands.

## Configuration parameters

| Parameter                  | Value         | Where set                                    |
|----------------------------|---------------|----------------------------------------------|
| `CHALLENGE_WINDOW_SECONDS` | `21600` (6h)  | Constructor of `CortexRegistry`              |
| `SNAPSHOT_EPOCH_INTERVAL`  | `100`         | Constructor of `CortexRegistry`              |
| `MERGE_MULTIPLIER_BPS`     | `10000` (1.0× / no separate uplift) | Legacy `CortexMergeBonus` constant |
| Multisig operator set      | see [`multisig-key-set.md`](./multisig-key-set.md) | `setOperator(idx, addr)` |

## Testnet

Testnet addresses move; do not bookmark. Current testnet: see [`../ops/testnet/USER_ACTIONS.md`](../ops/testnet/USER_ACTIONS.md).

## Verifying a deploy

```bash
# Check bytecode is present
cast code <ADDRESS> --rpc-url $BASE_RPC_URL | head -c 80

# Check the basic config matches
cast call $CORTEX_REGISTRY 'challengeWindowSeconds() (uint256)' --rpc-url $BASE_RPC_URL
cast call $CORTEX_REGISTRY 'snapshotInterval() (uint256)' --rpc-url $BASE_RPC_URL
cast call $CORTEX_MERGE_BONUS 'mergeMultiplierBps() (uint256)' --rpc-url $BASE_RPC_URL
```

The post-deploy smoke script does this automatically:

```bash
node scripts/post-deploy-smoke.mjs
```
