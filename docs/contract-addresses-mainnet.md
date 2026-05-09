# CoreTex v4 — Base Mainnet Addresses

**Deployed:** 2026-05-09 by `0x6463f89F102e9f53168ABe557173f53c0bBbF635` (V3 owner + coordinator signer).
**Chain:** Base mainnet (chainId 8453).

| Contract | Address | Tx |
|---|---|---|
| CortexState | [`0x5d3B9D9b246cf8457F320Bb27f008186B69D555d`](https://basescan.org/address/0x5d3B9D9b246cf8457F320Bb27f008186B69D555d) | `0x12dfcfa8152f60e7...` |
| BotcoinMiningV4 | [`0x12ff0B47389AE6d6293d44991B0D6A27394494A4`](https://basescan.org/address/0x12ff0B47389AE6d6293d44991B0D6A27394494A4) | `0x83675fc90395737c...` |
| BotcoinMiningV3 (existing, unchanged) | [`0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea`](https://basescan.org/address/0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea) | (pre-existing) |
| Botcoin token (existing, unchanged) | [`0xA601877977340862Ca67f816eb079958E5bd0BA3`](https://basescan.org/token/0xA601877977340862Ca67f816eb079958E5bd0BA3) | (pre-existing) |

## Wiring (verified on-chain)

```
V4.stakeSource         = 0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea  (live V3)
V4.cortexState         = 0x5d3B9D9b246cf8457F320Bb27f008186B69D555d  (deployed)
V4.owner               = 0x6463f89F102e9f53168ABe557173f53c0bBbF635
V4.coordinatorSigner   = 0x6463f89F102e9f53168ABe557173f53c0bBbF635  (same key)
V4.currentEpoch        = 78  (mirrors V3.currentEpoch)
CortexState.rewardLane = 0x12ff0B47389AE6d6293d44991B0D6A27394494A4  (V4)
```

## Initial epoch state (epoch 78)

```
initialized        = true
frozen             = true
rulesVersion       = 192 (0xC0)
workPolicyHash     = 0xd5bc0e0ce151f289f9cc46a3852b2154816d741c4a0adc1cd33f5e974dbbb774  (DEFAULT_CORETEX_WORK_POLICY_HASH)
corpusRoot         = 0x43ebf3457a51476adc5c563bbaace98af00106d7d28f92b5d7d29ec859fd8f7f  (Season 1 fixture root)
coreVersionHash    = 0xe1a957805f855828338a2a9d1f90c46eb78c378d85f10c8d8c83a1ce6eb388d3  (Baseline A frozen 2026-05-06)
stateRoot          = 0x7e704f76d6156405800141206cec1e6d7804daa8bf4e7da1542a1e431958504e  (genesisStateRoot)
wordCount          = 1024
transitionCount    = 0
parentCorpusRoot   = 0x0000000000000000000000000000000000000000000000000000000000000000  (genesis epoch)
minImprovementPpm  = 2500  (0.25% — plan §7 floor)
evalSeedCommit     = 0x7cb968bc19ec5ee4c34ce0c2b4eadad265b808e617ad79e2f8c9eeda44028bd1
evalSeed           = 0x0000…  (NOT yet revealed — held by deployer for epoch close)
```

The `evalSeed` preimage is stored at `/root/botcoin/.coretex-mainnet-secret-DO-NOT-COMMIT.txt` (gitignored). Reveal via `cortex.revealEvalSeed(78, <preimage>)` at epoch close.

## Verification commands

```bash
RPC=$(grep ^BASE_RPC_URL /root/botcoin/.env | cut -d= -f2)
CS=0x5d3B9D9b246cf8457F320Bb27f008186B69D555d
V4=0x12ff0B47389AE6d6293d44991B0D6A27394494A4

cast call --rpc-url "$RPC" $CS 'rewardLane()(address)'        # → V4 address
cast call --rpc-url "$RPC" $V4 'stakeSource()(address)'       # → live V3
cast call --rpc-url "$RPC" $V4 'currentEpoch()(uint64)'       # → 78
cast call --rpc-url "$RPC" $CS \
  'getEpoch(uint64)(bool,bool,uint32,bytes32,bytes32,bytes32,bytes32,uint16,uint64,bytes32,uint32,bytes32,bytes32)' \
  78
```

## Coordinator handoff

The coordinator now needs to:

1. Set in coordinator env:

   ```
   CORETEX_ENABLED=true
   CORTEX_STATE_ADDRESS=0x5d3B9D9b246cf8457F320Bb27f008186B69D555d
   BOTCOIN_MINING_V4_ADDRESS=0x12ff0B47389AE6d6293d44991B0D6A27394494A4
   CORETEX_EXPECTED_BUNDLE_HASH=0xe1a957805f855828338a2a9d1f90c46eb78c378d85f10c8d8c83a1ce6eb388d3
   CORETEX_STARTUP_RPC_URL=$BASE_RPC_URL  (or whatever Base RPC the coord uses)
   CORETEX_OPERATOR_TOKEN=<freshly generated random>
   CORETEX_RATE_LIMIT_PER_MINUTE_PER_MINER=30
   CORETEX_RATE_LIMIT_PER_MINUTE_GLOBAL=1500
   CORETEX_EVALUATOR_URL=http://localhost:7780  (sidecar)
   CORETEX_EVALUATOR_MAX_QUEUE=32
   CORETEX_RERANKER=qwen3
   CORETEX_RERANKER_PRODUCTION=1
   CORTEX_REAL_EVAL=1
   ```

2. Deploy the evaluator sidecar with pinned Qwen3-Reranker-0.6B (revision + per-file SHA-256 from the bundle manifest).

3. Restart `botcoin-coordinator` — startup will assert `cortexState.epochs[78].coreVersionHash == 0xe1a957805f855828338a2a9d1f90c46eb78c378d85f10c8d8c83a1ce6eb388d3` and refuse to start on mismatch.

4. Run `coretex-replay watch --rpc $BASE_RPC_URL --v4 0x12ff0B47389AE6d6293d44991B0D6A27394494A4 --cortex-state 0x5d3B9D9b246cf8457F320Bb27f008186B69D555d --bundle-manifest <path> --expected-bundle-hash 0xe1a957805f855828338a2a9d1f90c46eb78c378d85f10c8d8c83a1ce6eb388d3 --parent-state <packed-genesis-state>` to verify replay.

5. Smoke-test: a miner submits a screener via `/coretex/screen`, then a state advance via `/coretex/evaluate` → V4 emits `CortexStateAdvanced` → replay watcher reproduces.

That's the entire wire-up. From there the coordinator is live.

## Rollback

```bash
# Disable /coretex/* without affecting V3
export CORETEX_ENABLED=false
systemctl restart botcoin-coordinator
# Verify: curl /coretex/health → 503; curl /v1/challenge → 200

# Or chain-level pause (halts ALL state advances)
cast send --rpc-url $BASE_RPC --private-key $OWNER_PK 0x5d3B9D9b246cf8457F320Bb27f008186B69D555d \
  'setRewardLane(address)' 0x0000000000000000000000000000000000000000
```

V3 mining keeps running uninterrupted in either case.
