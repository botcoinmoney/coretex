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

Warning: this table is a launch drill snapshot. Before live launch or any real epoch cutover, verify every registry pin against `CoreTexRegistry` and the current `coretex-launch-v16-artifacts.json`.

| field | value |
|---|---|
| epoch | 106 |
| coreVersionHash / bundleHash | `0x78336d1d11a0796047baff340f4f90f154d98d9de064678471cbdf50e974069b` |
| corpusRoot | `0xb692b4a133963399257979bc5f632a0900d2d5d73dbadf191d3cf9889188e57e` |
| activeFrontierRoot | `0x5e1b6684c1ceed28de26035294e49c278de6a1d4d9f1bb26c4fcbab2d1187823` |
| baselineManifestHash | `0xaa9b46d1d60d67bd49c7132c8b7faca49c98bc4d256c77776614b913699a37f3` |
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

## V3 launch posture — economically inert

V3 remains callable on-chain (it cannot be turned off without a signer
rotation). The launch gate is that V3 is **economically inert** after V4
cutover:

- **No V3 reward deposits.** Reward funding goes only to V4's epoch pool.
- **No V3 epoch finalization.** Finalization happens on V4 only.
- **No V3 claim flow in miner docs / UI / skill.** All miner-facing claim
  paths target `V4.claim(uint64[])`.
- **V4 is the sole funded / finalized / claimed reward ledger.**
- **V3 is the stake / epoch / tier source** for V4 (`V4.stakeSource ==
  V3`; `V4.currentEpoch()` mirrors V3; `V4.tierCreditsOf(miner)` reads
  V3's tier schedule).

A coordinator that accidentally kept signing V3 standard-lane receipts
would NOT lose tx (V3 may still accept) but those credits would land
in V3's pool with no path to claim — they would be permanently
stranded. Production coord cutover MUST ensure the standard-receipt
signer targets V4's contract address + EIP-712 v4 domain only.

## Rollback

```bash
# Disable /coretex/* (coord-side, does not affect V3 mining)
export CORETEX_ENABLED=false
systemctl restart botcoin-coordinator   # /coretex/health → 503

# Chain-level pause (halts all CoreTex state advances; V3 keeps running)
cast send --rpc-url "$RPC" --private-key "$OWNER_PK" "$REG" 'pause()' && \
  cast call --rpc-url "$RPC" "$REG" 'paused()(bool)'
```
