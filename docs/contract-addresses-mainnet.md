# CoreTex v0 — Base Mainnet Addresses

**Chain:** Base mainnet (chainId 8453).
**Coordinator-signer / registry owner / V4 policy admin (same address):** `0x6463f89F102e9f53168ABe557173f53c0bBbF635`.

## Live contracts

| Contract | Address |
|---|---|
| Botcoin token | [`0xA601877977340862Ca67f816eb079958E5bd0BA3`](https://basescan.org/token/0xA601877977340862Ca67f816eb079958E5bd0BA3) |
| BotcoinMiningV3 (stake source + epoch source) | [`0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea`](https://basescan.org/address/0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea) |
| CoreTexRegistry | [`0xeA49b8cC25d45d6CcFE5B9d2541e8F05B1Df0acE`](https://basescan.org/address/0xeA49b8cC25d45d6CcFE5B9d2541e8F05B1Df0acE) |
| BotcoinMiningV4 | [`0xf3B83A63465214ad6D65c383580b55F13f4BE68f`](https://basescan.org/address/0xf3B83A63465214ad6D65c383580b55F13f4BE68f) |

The CoreTexRegistry + V4 above are the **only** CoreTex deploys treated as
canonical. Any earlier address that appeared in a prior revision of this doc is
decommissioned. v0 has no backward-compat requirement; do not cite older
addresses anywhere.

## v0 epoch context (epoch 106)

| field | value |
|---|---|
| epoch | 106 |
| coreVersionHash / bundleHash | `0x0e570580e48402eccf2e0df91fc7022d460092b73bd920a65e44446c85dfc5d2` |
| corpusRoot | `0xb692b4a133963399257979bc5f632a0900d2d5d73dbadf191d3cf9889188e57e` |
| activeFrontierRoot | `0x0509ec5f76e9a65034268b6da67db6bda6ede1facd04ebbec3f8896ea97a59bc` |
| baselineManifestHash | `0x82025dfda644cf609783905ed6c41feb5b5f4fcc1a268cfcb3cf1989b6099bd0` |
| rulesVersion | 192 (`0xC0`) |
| workPolicyHash | `0xd15e904997bdb2bb13d932953a77c0ed3ef309076146a4416cfe5a4e0cdb3775` |
| screenerWorkBps | 10 000 |
| perMinerScreenerCap | 50 |
| MAX_WORK_RECEIPT_TTL | 3600 s |

The `hiddenSeedCommit` preimage lives at
`/root/botcoin/.coretex-mainnet-secret-DO-NOT-COMMIT.txt` (gitignored). Reveal
the seed via `V4.revealEpochSecret(106, <preimage>)` at epoch close
(BotcoinMiningV4.sol — owner/coordinatorSigner only; the registry has no
revealEpochSecret entry point).

## Verification commands

```bash
RPC="$BASE_RPC_URL"
REG=0xeA49b8cC25d45d6CcFE5B9d2541e8F05B1Df0acE
V4=0xf3B83A63465214ad6D65c383580b55F13f4BE68f
V3=0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea

cast call --rpc-url "$RPC" "$V4" 'coreTexRegistry()(address)'             # → REG
cast call --rpc-url "$RPC" "$V4" 'stakeSource()(address)'                 # → V3
cast call --rpc-url "$RPC" "$V4" 'coordinatorSigner()(address)'           # → operator
cast call --rpc-url "$RPC" "$V4" 'currentEpoch()(uint64)'                 # → V3.currentEpoch
cast call --rpc-url "$RPC" "$V4" 'coreTexScreenerCapPerMinerPerEpoch()(uint256)'   # → 50
cast call --rpc-url "$RPC" "$REG" 'isCoordinator(address)(bool)' "$V4"    # → true
cast call --rpc-url "$RPC" "$REG" 'liveStateRoot(uint64)(bytes32)' 106    # → current
cast call --rpc-url "$RPC" "$REG" 'transitionCount(uint64)(uint64)' 106   # → N advances
```

## Coordinator startup contract

For the v0 launch coord (reference implementation:
`coretex_miner_testing/mainnet-coord-v16.mjs`):

1. Read `registry.liveStateRoot(epochId)` and replay every
   `CoreTexStateAdvanced` log since the `CoreTexEpochStarted` block, sorted by
   `(blockNumber, logIndex)`, with `transitionIndex` required to be contiguous.
2. Re-derive every advance: parent must equal coord `liveRoot`,
   `computePatchHash(compactPatchBytes) == event.patchHash`, r5-aware
   `applyPatch` succeeds, `merkleizeState(next.state) == event.newStateRoot`.
3. After replay, hard-equal `coord.liveRoot == registry.liveStateRoot(epoch)`.
   Fail startup on mismatch.
4. Run a watcher (poll or filter) that re-applies the same checks on every new
   landed event. On any parity mismatch, set unhealthy + refuse to sign.

## Rollback

```bash
# Disable /coretex/* (coord-side, does not affect V3 mining)
export CORETEX_ENABLED=false
systemctl restart botcoin-coordinator   # /coretex/health → 503

# Chain-level pause (halts all CoreTex state advances; V3 keeps running)
cast send --rpc-url "$RPC" --private-key "$OWNER_PK" "$REG" 'pause()' && \
  cast call --rpc-url "$RPC" "$REG" 'paused()(bool)'
```
