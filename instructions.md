# Botcoin Cortex — Plug-and-Play Wiring

This file is the contract between the Cortex repo and the coordinator-server dev who will stand it up against an existing Botcoin coordinator. It MUST be executable end-to-end on a fresh clone with only the contents of this file.

> Status: **scaffolded, not launch-ready**. Sections marked `(P5)`, `(P9)`, etc. depend on the matching phase landing first. See [`context.md`](./context.md) for current phase state.

## 1. Prerequisites

| Tool        | Version       | Notes                                                   |
|-------------|---------------|---------------------------------------------------------|
| Node.js     | >= 20.10      | LTS. `nvm install 20` recommended.                      |
| npm         | >= 10         | Ships with Node 20. (Repo uses npm workspaces.)         |
| Foundry     | >= 1.5.0      | `forge`, `cast`, `anvil`. `foundryup` to install.       |
| Linux/macOS | any current   | Ubuntu 22.04 / 24.04 / macOS 14+ tested.                |
| Base RPC    | mainnet + fork | Required for forge fork tests and on-chain reads.      |

> **pnpm vs npm**: the V0 monorepo uses **npm workspaces** rather than pnpm because the build/CI hosts already have npm. All `pnpm test:e2e` references in the design plan are read as `npm run test:e2e` here. Decision recorded in [`context.md`](./context.md).

## 2. Clone and bootstrap

```bash
git clone --recurse-submodules git@github.com:botcoinmoney/cortex.git
cd cortex
npm ci
npm run build
npm run test:unit
```

A clean clone passes unit tests with zero environment configuration. Anything that reaches a network or RPC is exclusively in `test:e2e`.

## 3. Environment variables

All variables live in [`ops/env.example`](./ops/env.example) with one-line descriptions. Copy and fill:

```bash
cp ops/env.example .env
$EDITOR .env
```

| Variable                       | Required | Default                  | Notes                                                                |
|--------------------------------|----------|--------------------------|----------------------------------------------------------------------|
| `BASE_RPC_URL`                 | yes      | —                        | Base mainnet RPC for the coordinator process.                       |
| `COORDINATOR_SIGNING_KEY`      | yes      | —                        | Existing SWCP signer. **Reused, never duplicated.**                 |
| `BOTCOIN_MINING_V3_ADDRESS`    | yes      | —                        | Already-deployed contract; **unchanged** by Cortex.                 |
| `CORTEX_REGISTRY_ADDRESS`      | yes (P9) | —                        | Phase 9 deploy output.                                              |
| `CORTEX_MERGE_BONUS_ADDRESS`   | yes (P9) | —                        | Phase 9 deploy output.                                              |
| `MULTISIG_OPERATOR_ADDRESSES`  | yes (P9) | —                        | Comma-separated; audit-window override signers.                     |
| `CHALLENGE_WINDOW_SECONDS`     | no       | `21600` (6h)             | Audit window before merge-bonus funding (§9 P2).                    |
| `SNAPSHOT_EPOCH_INTERVAL`      | no       | `100`                    | Full-state snapshot cadence (§1).                                   |
| `MERGE_MULTIPLIER_BPS`         | no       | `15000` (1.5×)            | Multiplier in basis points; on-chain capped.                        |
| `CORTEX_DB_PATH`               | no       | `data/cortex/queue.db`   | SQLite path for cortex-server queue.                                |
| `CORTEX_WORKER_POOL_SIZE`      | no       | `os.cpus().length - 1`   | Core eval workers.                                                  |
| `INTERNAL_RPC_URL`             | yes (P5) | —                        | Pointer at the SWCP process for `/internal/*`.                      |
| `INTERNAL_RPC_SHARED_SECRET`   | yes (P5) | —                        | Auth between cortex-server and SWCP coordinator.                    |

`COORDINATOR_SIGNING_KEY` is **never read by `cortex-server`** — the cortex process always asks the SWCP coordinator to sign via `/internal/sign-cortex-receipt`. The variable lives on the SWCP host only.

## 4. nginx integration `(P5)`

Append the path-prefix upstream snippet from [`ops/nginx.cortex.conf`](./ops/nginx.cortex.conf) to the existing coordinator nginx config:

```bash
sudo cp ops/nginx.cortex.conf /etc/nginx/snippets/cortex.conf
# Inside the existing coordinator.agentmoney.net server block, add:
#   include snippets/cortex.conf;
sudo nginx -t && sudo systemctl reload nginx
```

`/v1/cortex/*` routes to the cortex-server upstream. **Path-prefix only — not query string.** A `?lane=cortex` query on the SWCP path must NOT route to cortex-server (verified in P5 path-routing isolation E2E test).

## 5. Coordinator integration `(P5)`

The plug-and-play guarantee: the existing coordinator imports `packages/cortex-handler` in **one line** plus signing-key wiring. No edits to existing SWCP routes.

In the SWCP coordinator entrypoint (e.g. `packages/coordinator/src/server.ts`), add:

```ts
import { mountCortexHandler } from '@botcoin/cortex-handler';
mountCortexHandler(app, { receiptSigner, epochState, rateLimitBudget, db });
```

Then apply the `cortex-store` migration:

```bash
node packages/cortex-handler/scripts/apply-migrations.mjs
```

This is the only change to the SWCP coordinator code. The mount is purely additive: `/v1/challenge` and `/v1/submit` are unchanged; `/internal/*` paths are added.

## 6. Contract deploy `(P9)`

```bash
# Dry run
forge script contracts/script/DeployCortex.s.sol \
  --rpc-url $BASE_RPC_URL --sender $DEPLOYER

# Live
forge script contracts/script/DeployCortex.s.sol \
  --rpc-url $BASE_RPC_URL --broadcast --verify

# Multisig configure
forge script contracts/script/ConfigureMultisig.s.sol \
  --rpc-url $BASE_RPC_URL --broadcast

# Smoke
node scripts/post-deploy-smoke.mjs
```

Record `CORTEX_REGISTRY_ADDRESS` and `CORTEX_MERGE_BONUS_ADDRESS` in `.env`.

## 7. Run the E2E suite

```bash
npm run test:e2e
```

Phase-scoped: `npm run test:e2e -- --filter phase-3`. CI runs every phase tag plus an aggregate `e2e:all` gate.

The litmus test for this section: a senior engineer who has never seen this repo runs every command above on a fresh box and reaches a green `/healthz` plus a successful scripted-miner roundtrip without asking a single question.

## 8. Start cortex-server `(P5)`

systemd unit:

```ini
[Unit]
Description=Botcoin Cortex Server
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/cortex/cortex.env
ExecStart=/usr/bin/node /opt/cortex/packages/cortex-server/dist/index.js
Restart=on-failure
RestartSec=5
User=cortex
Group=cortex

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cortex-server
curl -fsS http://127.0.0.1:8081/healthz
```

Then run the scripted-miner roundtrip:

```bash
node scripts/scripted-miner.mjs --base $COORDINATOR_BASE
```

## 9. Operations

See [`ops/runbook.md`](./ops/runbook.md) for incident, pause, unpause, audit-window revert (multisig), key rotation, log locations, and the metrics dashboard URL.

Multisig override procedure: [`ops/multisig.md`](./ops/multisig.md). Operator key set is published there before the first reward epoch.

## 10. Rollback

To disable the lane cleanly without affecting SWCP:

```bash
sudo systemctl stop cortex-server
# Remove the include snippet from nginx
sudo nginx -t && sudo systemctl reload nginx
```

State that survives:

- All on-chain headers, accepted-patch events, and snapshots remain in `CortexRegistry`.
- The SWCP coordinator and `BotcoinMiningV3` are untouched.
- The cortex SQLite queue is preserved at `$CORTEX_DB_PATH`; restart resumes without duplicate submissions (proven by P5 SQLite crash-recovery test).

If the cortex-server process dies mid-epoch, the SWCP coordinator continues servicing SWCP claims unchanged. The audit-window guard means no merge bonus is ever funded for an un-finalized epoch.
