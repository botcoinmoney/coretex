# User Actions — Testnet

Phase 8 testnet launch checklist. Maps to §9 Phase 8 completion items.

## 1. Set env vars

```bash
export DEPLOYER_PK=0x...                 # funded testnet deployer
export BASE_TESTNET_RPC_URL=https://...  # Base Sepolia or similar
export COORDINATOR_ADDRESS=0x...         # coordinator EOA (same as SWCP coordinator)
export BOTCOIN_TOKEN=0x...               # testnet BOTCOIN ERC-20 (mock OK)
export MULTISIG_OPERATOR_ADDRESSES=0xaaa...,0xbbb...,0xccc...
export CORTEX_REGISTRY_ADDRESS=          # filled after deploy
export CORTEX_MERGE_BONUS_ADDRESS=       # filled after deploy
```

## 2. Deploy

```bash
node scripts/testnet/deploy-testnet.mjs
```

Records addresses in `ops/testnet-deployment.json` (gitignored). Update env vars and proceed.

## 3. Start cortex-server (testnet config)

```bash
PORT=8081 \
INTERNAL_RPC_URL=$SWCP_INTERNAL_URL \
INTERNAL_RPC_SHARED_SECRET=$SECRET \
CORTEX_DB_PATH=data/cortex-testnet/queue.db \
node packages/cortex-server/dist/index.js
```

`/healthz` should return `{ ok: true }`.

## 4. Drive synthetic traffic

```bash
COORDINATOR_BASE=http://127.0.0.1:8081 \
N_MINERS=20 \
TOTAL_PATCHES=1500 \
node scripts/testnet/feed-synthetic-traffic.mjs
```

Drives ≥1k patches per §9 Phase 8.

## 5. Run for ≥100 epochs

The coordinator advances epochs at its configured cadence. Watch the dashboard (Grafana) until epoch count ≥ 100.

## 6. Auditor reproduction (≥10 epochs, ≥3 from snapshots)

```bash
# 7 epochs reproduced from genesis
node scripts/testnet/auditor-reproduce.mjs --range 90,96

# 3 epochs reproduced starting from a mid-history snapshot
node scripts/testnet/auditor-reproduce.mjs --snapshot-anchored 75,77
```

All must return `matchesOnChain: true`. Divergence STOPS the launch.

## 7. Latch / unlatch rehearsal (twice)

```bash
node scripts/testnet/latch-unlatch-rehearsal.mjs
# follow operator prompts; SWCP must remain unaffected
# after 1st iteration completes:
node scripts/testnet/latch-unlatch-rehearsal.mjs
# 2nd iteration
```

## 8. Multisig override drill (synthetic divergence)

Operators announce a synthetic divergence ≥24h in advance, then run:

```bash
MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL \
node scripts/mainnet/multisig-revert-rehearsal.mjs
```

(Same script as mainnet — the testnet is a safe place to rehearse.)

## 9. Saturation alarm + dashboard

Confirm the saturation alarm fires on synthetic flat input via:

```bash
node test/e2e/phase-8/saturation-alarm.mjs
```

Dashboard panels populated and reflecting reality:
- pass rate (overall, per-family, per-tier)
- score-delta distribution
- protected-regression rate
- reducer rejects (R01 / R02)
- eval latency p50 / p99
- state root per epoch
- corpus snapshot hash
- live state-advance distribution

## Pass/fail gates (per §9 Phase 8)

- [ ] Golden e2e fixture green in CI: `npm run test:e2e -- --filter phase-8`.
- [ ] ≥10 finalized epochs reproduced by an auditor.
- [ ] ≥3 epochs reproduced from snapshots (sparse mid-history).
- [ ] Saturation alarm fires on synthetic flat-score sequence.
- [ ] Multisig revert drill succeeds (2-of-N) and is rejected (1-of-N).
- [ ] Pass-rate per tier within ±5% over the run.
- [ ] No single miner > 25% of state-advance credits.
- [ ] Latch/unlatch rehearsals × 2 with SWCP unaffected.

A green Phase 8 gate is the precondition for the Phase 9 mainnet checklist.
