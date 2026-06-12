# CoreTex v0 — Base Mainnet Address Record

> **CANONICAL LAUNCH DEPLOY — 2026-06-12.** Fresh CoreTexRegistry + BotcoinMiningV4
> redeployed from the current hardened source (`contracts/src` @ commit `4d87f4f`),
> Basescan-verified, confirmed at a clean blank starting state. These supersede
> all earlier drill/e2e deployments (retired list below). Runtime code/scripts
> still read addresses from env/config, never from this document.

**Chain:** Base mainnet (chainId 8453).

## Canonical Launch Contracts (2026-06-12)

| Contract | Address | Deploy block | Deploy tx |
|---|---|---|---|
| Botcoin token | [`0xA601877977340862Ca67f816eb079958E5bd0BA3`](https://basescan.org/token/0xA601877977340862Ca67f816eb079958E5bd0BA3) | (pre-existing) | — |
| BotcoinMiningV3 (stake source + epoch clock) | [`0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea`](https://basescan.org/address/0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea) | (pre-existing) | — |
| **CoreTexRegistry** | [`0x79A9e5a1Ab4D7834CB4f4fB952f1F583032021Bb`](https://basescan.org/address/0x79A9e5a1Ab4D7834CB4f4fB952f1F583032021Bb) | 47231958 | `0xd5a80605c7856fa1c0d02bc6676e503524f25e121358c57fd91c72dc6c519a07` |
| **BotcoinMiningV4** | [`0xBc71E2428cc0955b3dF9f38F5cF5DE22a1fC1D9b`](https://basescan.org/address/0xBc71E2428cc0955b3dF9f38F5cF5DE22a1fC1D9b) | 47231971 | `0xd238f2d5976beada19e108700681a0c96ae2e3c32c8bfa671df91e34fb58fd6d` |
| registry.setBotcoinMiningV4(V4) wiring | — | 47231978 | `0x2d088d5edd869ec0bebd984d84e95f7a4674bdb44feaa0c36fe2d07c3367f428` |

Both contracts are **Verified** on Basescan (Etherscan V2 API, chainid 8453).
Compiler: solc 0.8.28, optimizer_runs 200, via_ir=true (per `contracts/foundry.toml`).

**Owner / coordinator signer / V4 policy admin:** `0x6463f89F102e9f53168ABe557173f53c0bBbF635`
(the wallet of `COORDINATOR_SIGNING_KEY`). The registry constructor authorized
this address as a coordinator (`isCoordinator == true`); it is owner of both
contracts and the V4 policy admin.

**On-chain CoreTex policy (V4 constructor):** rulesVersion `192` (`0xC0`),
screenerWorkBps `10000`, stateAdvanceThresholds `[0,25,100,250,500]`,
stateAdvanceWorkBps `[30000,40000,60000,90000,120000]`; on-chain
`policyHash == 0xd15e904997bdb2bb13d932953a77c0ed3ef309076146a4416cfe5a4e0cdb3775`.
(The 2026-06-12 work-units policy v3 change — the state-advance screener-threshold
floor — is OFF-chain coordinator calibration; it does not alter this on-chain
`CoreTexPolicy` struct or its hash. The coordinator's separate
`CORETEX_WORK_POLICY_HASH` is computed from the full off-chain work policy.)

## Starting state (verified blank, 2026-06-12)

No CoreTex epoch context is pinned yet — the contracts are at a clean start.
Confirmed by readback at deploy (currentEpoch `112`, delegated from V3):

- registry: `botcoinMiningV4 == V4`, `paused == false`, `isCoordinator(owner) == true`,
  `transitionCount(112) == 0`, `epochFinalized(112) == false`.
- V4: `coreTexRegistry == registry`, `externalStakeSource == V3`,
  `botcoinToken == token`, `genesisTimestamp == V3's`, `epochDuration == 86400`,
  `stakeMode == 0 (ExternalV3)`, `epochCommit/epochSecret(112) == 0x0`,
  `coreTexEpochContextSet(112) == false`, `totalCredits/epochReward/rewardBalance/
  nativeTotalStaked == 0`, `coreTexScreenerCapPerMinerPerEpoch == 50`,
  `coreTexPolicyCount == 1`, `nextIndex(owner) == 0`.

The epoch context (`setCoreTexEpochContext` + `setEpochCommit`) is pinned at the
arm step per `docs/CORETEX_COORD_WIRING_RUNBOOK.md` (§"V3→V4 Cutover"), against
the FINAL rebundled `coreVersionHash`/`corpusRoot`/`baselineManifestHash` from
`coretex-launch-v16-artifacts.json` — NOT pinned by this deploy.

## Chain-config publication (runbook R7)

The launch manifest `chain` block is populated to:

```
{ "chainId": 8453,
  "registryAddress": "0x79A9e5a1Ab4D7834CB4f4fB952f1F583032021Bb",
  "miningContractAddress": "0xBc71E2428cc0955b3dF9f38F5cF5DE22a1fC1D9b",
  "registryDeployBlock": 47231958,
  "confirmationDepth": 4 }
```

`coretex-validator-setup --verify-chain-config` validates these (non-zero,
deployed code at both addresses, `registry.botcoinMiningV4() == miningContractAddress`).
After any S3 republish of `coretex-launch-v16-artifacts.json`, the published copy
must carry this `chain` block.

## Verification commands

```bash
RPC="$BASE_RPC_URL"
REG=0x79A9e5a1Ab4D7834CB4f4fB952f1F583032021Bb
V4=0xBc71E2428cc0955b3dF9f38F5cF5DE22a1fC1D9b
V3=0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea

cast call --rpc-url "$RPC" "$V4"  'coreTexRegistry()(address)'                  # → REG
cast call --rpc-url "$RPC" "$V4"  'externalStakeSource()(address)'             # → V3
cast call --rpc-url "$RPC" "$V4"  'coordinatorSigner()(address)'               # → owner
cast call --rpc-url "$RPC" "$V4"  'currentEpoch()(uint64)'                     # → V3.currentEpoch
cast call --rpc-url "$RPC" "$V4"  'coreTexScreenerCapPerMinerPerEpoch()(uint256)'   # → 50
cast call --rpc-url "$RPC" "$REG" 'botcoinMiningV4()(address)'                 # → V4
cast call --rpc-url "$RPC" "$REG" 'paused()(bool)'                            # → false
```

## Retired deployments (do NOT use)

| Generation | CoreTexRegistry | BotcoinMiningV4 | Note |
|---|---|---|---|
| 2026-06-09 real e2e (epoch-109 drill) | `0xDFBb6aaF638666Ff29625110B8912eb1a9308c3f` | `0x4d2771687CA47E8Cab0b5F0B2F8Cc42625ff635a` | superseded; reveal its epoch-109 secret if still unrevealed, then leave inert |
| earlier state-integrity drill | `0x0BE83fb9F214ea89C0277cd9e1b4f834b6E63fB8` | `0xb53D3AF83FBe2dd469E26811BaBC4be02e0B0C47` | superseded |

Optionally `pause()` a retired registry to halt any stray state advances:
`cast send --rpc-url "$RPC" --private-key "$OWNER_PK" <retired-registry> 'pause()'`.

## Coordinator startup contract

For the v0 launch coord (reference implementation:
`coretex_miner_testing/mainnet-coord-v16.mjs`):

1. Read `registry.liveStateRoot(epochId)` and replay every
   `CoreTexStateAdvanced` log since the registry deploy block (47231958), sorted
   by `(blockNumber, logIndex)`, with `transitionIndex` required to be contiguous.
2. Re-derive every advance: parent must equal coord `liveRoot`,
   `computePatchHash(compactPatchBytes) == event.patchHash`, r5-aware
   `applyPatch` succeeds, `merkleizeState(next.state) == event.newStateRoot`.
3. After replay, hard-equal `coord.liveRoot == registry.liveStateRoot(epoch)`.
   Fail startup on mismatch.
4. Run a watcher that re-applies the same checks on every new landed event. On
   any parity mismatch, set unhealthy + refuse to sign.

## V3 launch posture — economically inert after cutover

V3 remains callable on-chain (it cannot be turned off without a signer
rotation). The launch gate is that V3 is **economically inert** after V4
cutover:

- **No V3 reward deposits.** Reward funding goes only to V4's epoch pool.
- **No V3 epoch finalization.** Finalization happens on V4 only.
- **No V3 claim flow in miner docs / UI / skill.** All miner-facing claim
  paths target `V4.claim(uint64[])`.
- **V4 is the sole funded / finalized / claimed reward ledger.**
- **V3 is the stake / epoch / tier source** for V4 (`V4.externalStakeSource ==
  V3`; `V4.currentEpoch()` mirrors V3).

A coordinator that accidentally kept signing V3 standard-lane receipts after the
cutover epoch would strand those credits in V3's pool with no claim path.
Production coord cutover MUST route the standard-receipt signer to V4's address +
EIP-712 v4 domain for epochs ≥ the cutover epoch (see runbook §"V3→V4 Cutover",
the `CORETEX_V4_FUNDING_FROM_EPOCH` handoff).

## Rollback

```bash
# Disable /coretex/* (coord-side, does not affect V3/V4 funding lanes)
export CORETEX_ENABLED=false CORETEX_CUTOVER_ENABLED=false
docker compose up -d coordinator        # /coretex/* → 404

# Chain-level pause (halts all CoreTex state advances; standard lane keeps running)
cast send --rpc-url "$RPC" --private-key "$OWNER_PK" "$REG" 'pause()' && \
  cast call --rpc-url "$RPC" "$REG" 'paused()(bool)'
```
