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
genesisStateRoot:    <TBD — set after Phase 7 baseline iteration freezes the winner>
coreVersionHash:     <TBD — keccak256 of the pinned Core V0 binary>
```

The `coreVersionHash` is committed in the first `CortexEpochFinalized` event (epoch 0). Auditors must use the corresponding pinned `packages/cortex/dist/` to reproduce roots.

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
