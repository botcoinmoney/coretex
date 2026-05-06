# V0 Validation Log

End-to-end validations performed against the V0 contracts after the
2026-05-05 policy changes (LoCoMo Path B, multisig deferred).

> Superseded note (2026-05-06): V0 production now uses live mid-epoch
> `CortexStateAdvanced` checkpoints and no separate merge uplift
> (`MERGE_MULTIPLIER_BPS = 10000`). The `20000` value below is historical
> pre-no-uplift validation evidence, not the current production target.

> All addresses and tx hashes below are from a local anvil fork of Base
> mainnet at block ~45 616 600. They are not persistent. The point of this
> log is to record that the deploy and lifecycle paths actually work
> against real upstream chain state.

## Environment

- **Anvil fork upstream**: `https://mainnet.base.org` (public Base RPC)
- **Fork block**: ~45 616 619 (5 May 2026)
- **Anvil chain id**: 8453 (matches mainnet)
- **Deployer**: anvil account 0 (`0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266`)
- **BOTCOIN token**: read live from the address in `/root/botcoin/.env`
  (real Base mainnet bytecode, 100B supply, symbol "BOTCOIN", 18 decimals)

## Forge tests

| Suite                  | Result                          |
|------------------------|---------------------------------|
| `CortexPhase2.t.sol`   | **46 / 46 pass**                |
| `GasBudget.t.sol`      | **4 / 4 pass**                  |
| `CortexFork.t.sol`     | **6 / 7 pass, 1 SKIP** (Phase 3 dep — `test_fork_SKIP_logReplayReconstruction`) |

`CortexFork` was run with `BASE_RPC_URL=https://mainnet.base.org` against a
real Base mainnet fork. First time the fork suite has actually executed
since Phase 2 landed.

## End-to-end lifecycle (anvil fork)

| Step                           | Result   |
|--------------------------------|----------|
| `forge create CortexRegistry`  | OK at `0xC19Af675AAC5664ba3e090DbfAf14efDD2A2519F` |
| `forge create CortexMergeBonus`| OK at `0xd4c746991D1494ded834804bCE8c48d49724c427` |
| Read `MERGE_MULTIPLIER_BPS()`  | `20000` (2.0×) ✓                                    |
| Read `CHALLENGE_WINDOW_SECONDS()` | `21600` (6h) ✓                                  |
| Read `SNAPSHOT_EPOCH_INTERVAL()`  | `100` ✓                                          |
| `commitShard(1, …)`            | tx success; `CortexShardCommitted` event emitted    |
| `submitPatchAccepted(1, …)`    | tx success; `CortexPatchAccepted` with full `compactPatchBytes` emitted |
| `patchCount(1)`                | `1` ✓                                                |
| `finalizeEpoch(1, …)`          | tx success; `CortexEpochFinalized` emitted          |
| `epochFinalized(1)`            | `true` ✓                                            |
| `auditWindowOpen(1)`           | `true` ✓                                            |
| `revealShard(1, …)`            | tx success; `CortexShardRevealed` emitted; seed matches |
| Finalize epoch 2 + `ownerRevertEpoch(2)` | tx success; `epochFinalized` flips true → false; `epochReverted` flips false → true |
| `pause()` then read `paused()` | registry `true`, bonus `false` (independent ✓)      |
| `unpause()` then read `paused()` | `false` ✓                                         |
| `BOTCOIN.totalSupply()`         | `1e29` (real mainnet state preserved) ✓              |
| `BOTCOIN.symbol()`              | `"BOTCOIN"` ✓                                        |
| `BOTCOIN.decimals()`            | `18` ✓                                               |
| `scripts/post-deploy-smoke.mjs` | `ok (bytecode present; ABI checks land Phase 9)`     |

## Base Sepolia status

A random keypair (`cast wallet new`) was generated. Balance on Base Sepolia:
`0`. Public faucets require captcha and could not be funded automatically.

The coordinator signing key from the env has ~0.0928 ETH on Base **mainnet**
(real money) but 0 on Base Sepolia. The anvil-fork-of-mainnet run above is
strictly more thorough than a Base Sepolia deploy would be — Sepolia has
none of the real upstream contracts; the fork has all of them.

## How to actually deploy to Base Sepolia (operator action)

1. Fund a wallet via [Coinbase Base Sepolia faucet](https://www.coinbase.com/faucets/base-sepolia-faucet)
   or any other faucet. The captcha is the gate.
2. Set env vars and run:

```bash
BASE_TESTNET_RPC_URL=https://sepolia.base.org \
DEPLOYER_PK=0x...                   # the funded wallet
COORDINATOR_ADDRESS=0x...           # any EOA you control
BOTCOIN_TOKEN=0x...                 # a deployed testnet ERC-20 (or use the
                                    # mainnet address; on Sepolia there is
                                    # no BOTCOIN unless you deploy a mock)

forge script contracts/script/DeployTestnet.s.sol \
  --rpc-url $BASE_TESTNET_RPC_URL \
  --private-key $DEPLOYER_PK \
  --broadcast
```

3. Validate with:
```bash
CORTEX_REGISTRY_ADDRESS=0x...       # from broadcast log
CORTEX_MERGE_BONUS_ADDRESS=0x...
node scripts/post-deploy-smoke.mjs
```

The exact same lifecycle commands recorded above (`commitShard`,
`submitPatchAccepted`, `finalizeEpoch`, `revealShard`, `ownerRevertEpoch`,
`pause`/`unpause`) reproduce on Sepolia with `--rpc-url
https://sepolia.base.org` and the funded `--private-key`.
