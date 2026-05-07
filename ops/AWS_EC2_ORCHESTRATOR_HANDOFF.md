# AWS EC2 Orchestrator Handoff — Cortex Mainnet Latch

Date: 2026-05-07

This is the handoff for the AWS EC2 agent that will clone Cortex and latch it
onto the existing Botcoin coordinator. Cortex is a sidecar mining lane: it does
not replace the existing SWCP coordinator. The mining contract should be the V4
extension so CoreTex can issue lane-aware work receipts while preserving V3
staking, funding, claims, and Trace receipts.

## Goal

Run `cortex-server` beside the existing coordinator and expose:

```text
/v1/cortex/challenge
/v1/cortex/submit
/v1/cortex/state
/v1/cortex/epoch
```

The existing coordinator remains responsible for:

- miner authentication;
- epoch secret management;
- receipt-chain state;
- rate limits;
- EIP-712 receipt signing;
- normal epoch settlement through the V3-compatible claim path.

Cortex is responsible for:

- loading the current packed 32 KB Cortex state;
- evaluating 1-4 word memory-index patches;
- running deterministic CortexBench eval;
- running the local MiniLM no-regression gate;
- emitting / preparing state-advance data;
- requesting a CoreTex V4 work receipt after a qualified screener pass or state advance.

## Instance Sizing

Upgrade the EC2 host before running both lanes on one box. The current SWCP
coordinator plus Cortex Core plus MiniLM should not share a tiny instance.

Recommended minimum for production dry-run:

```text
Instance:   c7i.xlarge, c7a.xlarge, m7i.xlarge, or better
vCPU:       4+
RAM:        16 GB+
Disk:       100 GB gp3
Node:       >=22.5
OS:         Ubuntu 22.04/24.04 LTS
```

Recommended after public rollout:

```text
Instance:   c7i.2xlarge / c7a.2xlarge / m7i.2xlarge
vCPU:       8+
RAM:        32 GB+
Disk:       200 GB gp3
```

Why: `cortex-server` is light, but the local open-weight model gate needs warm
embedding cache space and predictable CPU. The coordinator also needs headroom
for normal mining traffic, Bankr/funding tasks, and receipt signing.

## Clone And Build

```bash
cd /opt
git clone https://github.com/botcoinmoney/cortex.git
cd /opt/cortex
git checkout main

# Node >=22.5 is required.
node -v
npm ci
npm run build --workspaces --if-present
```

Run the required local checks:

```bash
node --test --test-reporter=spec \
  test/unit/cortex-bench-eval.test.mjs \
  test/unit/local-model-eval.test.mjs \
  packages/cortex/test/unit/merkle.test.mjs \
  packages/cortex/test/unit/eval.test.mjs \
  packages/cortex/test/unit/patch.test.mjs \
  packages/cortex/test/unit/reducer.test.mjs

node scripts/local-model-calibration.mjs
node scripts/local-model-eval-smoke.mjs
```

Expected:

- unit suite passes;
- calibration passes all three families: long-horizon, near-collision, temporal;
- MiniLM model is `Xenova/multi-qa-MiniLM-L6-cos-v1`.

## Required Existing Coordinator Internals

The existing SWCP coordinator must expose internal RPC endpoints to
`cortex-server` over localhost or private VPC only.

Cortex expects internal support for:

- current epoch and `epochSecret`;
- `hiddenSeedCommit`;
- miner tier / credits per solve;
- miner receipt chain and `prevReceiptHash`;
- shared outstanding challenge lock;
- shared rate-limit budget;
- `sign-coretex-work-receipt`;
- optional `sign-cortex-receipt` only for explicitly configured V3 fallback drills;
- clearing an outstanding challenge after successful submit.

The internal shared secret must be private and never exposed through public
nginx routes.

## Environment

Create `/etc/botcoin-cortex.env`:

```bash
BASE_RPC_URL=https://...

BOTCOIN_MINING_V4_ADDRESS=0x...
CORTEX_REGISTRY_ADDRESS=0x...

INTERNAL_RPC_URL=http://127.0.0.1:8080
INTERNAL_RPC_SHARED_SECRET=...
CORTEX_RECEIPT_MODE=v4

CORTEX_DB_PATH=/var/lib/cortex/queue.db
CORTEX_WORKER_POOL_SIZE=2

CORTEX_REAL_EVAL=1
CORTEX_STATE_PACKED_PATH=/var/lib/cortex/current-state.bin
CORTEX_SCORE_THRESHOLD=0

CORTEX_LOCAL_MODEL_EVAL=1
CORTEX_LOCAL_MODEL=Xenova/multi-qa-MiniLM-L6-cos-v1
CORTEX_LOCAL_MODEL_MIN_DELTA=0
CORTEX_LOCAL_MODEL_PREWARM=1
CORTEX_LOCAL_MODEL_CACHE=/var/lib/cortex/model-cache
CORTEX_LOCAL_MODEL_LOCAL_ONLY=0

PORT=8091
```

Important production rule:

```text
CORTEX_LOCAL_MODEL_EVAL=0 is only allowed for non-reward drills.
Never run paying epochs with the local model gate disabled.
```

## Current State File

Create the Cortex data directory:

```bash
sudo mkdir -p /var/lib/cortex/model-cache
sudo chown -R ubuntu:ubuntu /var/lib/cortex
```

At genesis, write the frozen Baseline A state to:

```text
/var/lib/cortex/current-state.bin
```

After every accepted state advance, the operator process must atomically update
this file:

```bash
tmp=/var/lib/cortex/current-state.bin.tmp
# write exactly 32768 bytes to $tmp
mv "$tmp" /var/lib/cortex/current-state.bin
```

`cortex-server` fails closed if the file's Merkle root does not match the
challenge parent state root.

## Systemd

`/etc/systemd/system/cortex-server.service`:

```ini
[Unit]
Description=Botcoin Cortex Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/cortex
EnvironmentFile=/etc/botcoin-cortex.env
ExecStart=/usr/bin/node packages/cortex-server/dist/index.js
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable cortex-server
sudo systemctl start cortex-server
sudo journalctl -u cortex-server -f
```

Expected boot logs:

```text
[cortex-server] real CortexBench evaluator installed
[cortex-server] local model eval prewarmed ... texts ...
```

## Nginx / Routing

Route only public Cortex paths:

```nginx
location /v1/cortex/ {
    proxy_pass http://127.0.0.1:8091/v1/cortex/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Do not expose `/internal/*`.

## Deployment Order

1. Upgrade EC2 instance.
2. Clone/build Cortex.
3. Deploy `BotcoinMiningV4` if the existing mainnet lane has not already migrated, then deploy `CortexRegistry`.
4. Fill `/etc/botcoin-cortex.env`.
5. Write `/var/lib/cortex/current-state.bin`.
6. Run `node scripts/local-model-calibration.mjs`.
7. Start `cortex-server`.
8. Add nginx route.
9. Run shadow mode.
10. Run allowlisted mainnet dry-run.
11. Open gradually.

## Gradual Latch Plan

### Stage 0 — Shadow Mode

- Do not issue signed receipts.
- Accept internal/test submissions only.
- Log eval reports and model-gate outcomes.
- Confirm no SWCP traffic is impacted.

### Stage 1 — Allowlisted Miners

- Enable signed receipts for 1-3 known miners only.
- Low per-miner submit cap.
- Confirm normal Trace receipts and CoreTex V4 work receipts share the same `nextIndex` / `lastReceiptHash` chain.
- Confirm `CortexStateAdvanced` events chain by parent root.

### Stage 2 — Existing High-Stake Miners

- Open to trusted existing miners.
- Keep `CORTEX_LOCAL_MODEL_EVAL=1`.
- Watch pass rate, score deltas, model regressions, and stale-parent rejects.

### Stage 3 — Public Lane

- Publish miner docs.
- Keep saturation alarm and no-single-miner >25% state-advance credit alert.

## 24h Epochs And 100-Epoch Snapshots

Cortex still uses normal 24-hour BOTCOIN epochs.

State improvements do **not** wait 100 epochs. Verified improvements can advance
the live Cortex state many times during the same 24-hour epoch.

The `SNAPSHOT_EPOCH_INTERVAL=100` setting is only a replay/audit optimization:
every 100 epochs the contract emits a full 32 KB state snapshot so fresh
validators do not need to replay from genesis forever.

```text
During epoch N:
  patch A screener-passes -> 1x V4 work receipt
  patch A advances state  -> liveStateRoot advances immediately, state-advance V4 receipt
  patch B screener-passes -> 1x V4 work receipt
  patch C fails           -> no receipt

Every 100 epochs:
  emit full-state snapshot for faster validator sync
```

## Validator

Run at least one coordinator-owned validator process. Independent validators
should be able to run the same checks from chain logs.

Minimum periodic check:

```bash
node packages/cortex/dist/cli.js verify-epoch <epoch> --rpc "$BASE_RPC_URL"
```

Healthy:

```text
matchesOnChain = true
latest local state root == finalized on-chain state root
coreVersionHash == ops/v0-frozen.json coreVersionHash
genesisStateRoot == ops/v0-frozen.json genesisStateRoot
```

## Emergency Controls

- Stop lane only:
  ```bash
  sudo systemctl stop cortex-server
  ```
- Remove nginx Cortex route and reload nginx.
- Pause registry if deployed owner key is available:
  ```bash
  cast send $CORTEX_REGISTRY_ADDRESS "pause()" --rpc-url $BASE_RPC_URL --private-key $OWNER_PK
  ```

SWCP mining and claims must remain unaffected by stopping `cortex-server`.

## Production Checklist

- [ ] EC2 upgraded.
- [ ] `npm ci && npm run build --workspaces --if-present` passed.
- [ ] `node scripts/local-model-calibration.mjs` passed on host.
- [ ] `CORTEX_REAL_EVAL=1`.
- [ ] `CORTEX_LOCAL_MODEL_EVAL=1`.
- [ ] `CORTEX_STATE_PACKED_PATH` points to a 32768-byte file.
- [ ] Internal RPC secret configured.
- [ ] `/internal/*` not public.
- [ ] nginx route active for `/v1/cortex/*`.
- [ ] coordinator-owned validator running.
- [ ] shadow mode clean.
- [ ] allowlist dry-run clean.
- [ ] Phase 8 testnet campaign complete before broad rollout.
