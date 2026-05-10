# Cortex Testnet — Runbook

Phase 8 testnet operations. Companion to [`../runbook.md`](../runbook.md) (general ops) and [`USER_ACTIONS.md`](./USER_ACTIONS.md) (testnet launch checklist).

## Pre-deploy

- Funded testnet deployer EOA (Base Sepolia or other Base testnet).
- A testnet BOTCOIN ERC-20 (mock is fine for testnet).
- ≥3 multisig operator EOAs (for revertEpoch threshold).

## Deploy

```bash
DEPLOYER_PK=0x... \
BASE_TESTNET_RPC_URL=https://... \
COORDINATOR_ADDRESS=0x... \
BOTCOIN_TOKEN=0x... \
MULTISIG_OPERATOR_ADDRESSES=0xaaa,0xbbb,0xccc \
node scripts/testnet/deploy-testnet.mjs
```

Output: `ops/testnet-deployment.json` (gitignored — addresses move per testnet).

## Drive epochs

```bash
COORDINATOR_BASE=https://coordinator-testnet.example \
N_MINERS=20 \
TOTAL_PATCHES=1500 \
node scripts/testnet/feed-synthetic-traffic.mjs
```

Drives ≥1k patches across N miners against the cortex-server.

## Audit

For each finalized epoch e:

```bash
BASE_TESTNET_RPC_URL=$RPC \
CORTEX_REGISTRY_ADDRESS=$REGISTRY \
node scripts/testnet/auditor-reproduce.mjs --epoch <e>
```

Should produce `matchesOnChain: true`. Run for ≥10 finalized epochs, including ≥3 that span a snapshot boundary.

## Latch / unlatch rehearsal

Run twice (per §9 Phase 8):

```bash
node scripts/testnet/latch-unlatch-rehearsal.mjs
```

The rehearsal: stop cortex-server mid-flight, verify SWCP claim parity, restart, verify queue resumes without duplicate submissions.

## Saturation alarm

The synthetic alarm fires on a flat-score sequence — verify the dashboard reflects it. Live response is documented in [`../runbook.md`](../runbook.md).

## Common issues

- **CortexEpochFinalized not emitted** → coordinator hasn't run reducer; check cortex-server logs.
- **Auditor reproduction diverges** → STOP. Don't proceed to mainnet. Open a divergence issue.
- **Latch/unlatch loses queue state** → check WAL journal at `$CORTEX_DB_PATH-wal`; SQLite should recover automatically.
- **Multisig revert drill fails** → check operator addresses match `MULTISIG_OPERATOR_ADDRESSES` env. Threshold is 2-of-N.
