# User Actions — Mainnet Launch

This is the launch checklist for Botcoin Cortex V0 on Base mainnet. Each numbered step is a user action; the in-repo deliverable that supports it is in italics.

## Pre-launch readiness

- [ ] **0. Resolve open V0 blockers**
  - [Issue #4](../../issues/4) — LoCoMo CC-BY-NC-4.0: pick A (Snap commercial license) / B (replace with permissive alt) / C (synthetic Apache-2.0). Phase 4 follow-up PR enables the chosen path.
  - [Issue #8](../../issues/8) — Phase 3 eval perf incremental Merkle update. Required for production miners to hit p50 < 10 ms / p99 < 50 ms.

- [ ] **1. Run Phase 7 baseline iteration**
  - *Deliverable*: `experiments/baselines/{a..e}` — five baselines with `genesisState()` and `mineCandidatePatch()`.
  - *Action*: `node experiments/harness/compareBaselines.ts` against a real corpus. Pick the winner (likely E). Record metrics in `experiments/results/`.
  - *Output*: chosen baseline → freeze `coreVersionHash` (keccak256 of pinned `packages/cortex/dist/`), freeze `genesisStateRoot` (Merkle root of winner's encoded state).
  - *Commit*: those two values into `docs/contract-addresses.md` and `packages/cortex/src/eval/index.ts` constants.
  - *Re-run*: `npm run test:e2e -- --filter phase-7` with real (not placeholder) `genesisStateRoot`. CI gate becomes authoritative.

- [ ] **2. Run Phase 8 testnet for ≥100 epochs / ≥1k patches**
  - *Deliverables*: `contracts/script/DeployTestnet.s.sol`, `scripts/testnet/*`, `test/e2e/phase-8/run.mjs` (golden fixture).
  - *Actions*: deploy to testnet, run synthetic miners via `scripts/testnet/feed-synthetic-traffic.mjs`, verify ≥10 finalized epochs reproduce via `scripts/testnet/auditor-reproduce.mjs`, run latch/unlatch rehearsals × 2.
  - *Pass criteria*: golden e2e fixture green; saturation alarm fires on synthetic flat sequence; multiplier-distribution gate (no single miner > 25% of merge bonus); pass-rate band hold.

- [ ] **3. Publish operator multisig key set**
  - *Deliverable*: `docs/multisig-key-set.md` (template).
  - *Actions*: assemble ≥3 operators. Each signs a no-op test multisig transaction via their own wallet. Record the signing tx hashes in the operator table. Replace all `<TBD>` placeholders.
  - *Commit*: filled `docs/multisig-key-set.md` to main.

## Mainnet deploy

- [ ] **4. Mainnet deploy of `CortexRegistry` + `CortexMergeBonus`**
  ```bash
  MAINNET_CONFIRM=I-UNDERSTAND \
  MULTISIG_OPERATOR_ADDRESSES=0xaaa...,0xbbb...,0xccc... \
  BOTCOIN_TOKEN_ADDRESS=0x... \
  CHALLENGE_WINDOW_SECONDS=21600 \
  SNAPSHOT_EPOCH_INTERVAL=100 \
  MERGE_MULTIPLIER_BPS=15000 \
  forge script contracts/script/DeployMainnet.s.sol \
    --rpc-url $BASE_RPC_URL --broadcast --verify
  ```
  - Record `CortexRegistry` and `CortexMergeBonus` addresses in `docs/contract-addresses.md` (replace `<TBD>`).
  - Run `node scripts/post-deploy-smoke.mjs` to verify bytecode + selectors.

- [ ] **5. Mainnet dry-run epoch (zero merge-bonus funding)**
  ```bash
  CORTEX_REGISTRY_ADDRESS=0x... \
  CORTEX_MERGE_BONUS_ADDRESS=0x... \
  COORDINATOR_BASE=https://coordinator.agentmoney.net \
  DRY_RUN_MINER_ADDRESS=0x... \
  node scripts/mainnet/dry-run-epoch.mjs
  ```
  - Confirm `CortexEpochFinalized` is emitted for the dry-run epoch.
  - Confirm `EpochFunded` is **NOT** emitted (lane disabled before audit window closes).
  - Disable lane: `sudo systemctl stop cortex-server`, remove nginx include, reload.

- [ ] **6. Multisig revert rehearsal**
  - Operators announce a synthetic divergence ≥24h in advance.
  ```bash
  MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL \
  CORTEX_REGISTRY_ADDRESS=0x... \
  node scripts/mainnet/multisig-revert-rehearsal.mjs
  ```
  - Verify 2-of-N revert succeeds; bonus funding for that epoch is blocked.
  - Public post-mortem within 72h.

- [ ] **7. Emergency disable rehearsal**
  ```bash
  MAINNET_CONFIRM=I-UNDERSTAND-THIS-IS-MAINNET-DRILL \
  CORTEX_REGISTRY_ADDRESS=0x... \
  node scripts/mainnet/emergency-disable-rehearsal.mjs
  ```
  - Pause `CortexRegistry`, run a SWCP claim transaction, confirm SWCP unaffected.
  - Unpause; verify Cortex finalize resumes on next epoch.

## Go-live

- [ ] **8. Re-enable cortex-server + first reward epoch**
  - Restart `cortex-server`; restore nginx upstream.
  - Allow the first paying epoch to finalize. After audit window closes, the coordinator funds `CortexMergeBonus` for that epoch.

- [ ] **9. Publish first-reward audit trail**
  ```bash
  CORTEX_REGISTRY_ADDRESS=0x... \
  CORTEX_MERGE_BONUS_ADDRESS=0x... \
  FIRST_REWARD_EPOCH=<n> \
  node scripts/mainnet/first-reward-audit-trail.mjs
  ```
  - Output: `out/first-reward-audit/<n>.md` + `.json`.
  - Publish the report to a public location (this repo's wiki or releases).
  - Anyone can re-run the same script and produce a byte-identical report.

## Post-launch monitoring

- [ ] **10. Saturation alarm + dashboard**
  - Watch `ops/testnet/dashboard.json` (Grafana template) translated to mainnet metrics. Saturation alarm fires on median score-delta < 1% over 10 epochs.
  - Pass-rate band hold (per tier ±5%).
  - Multiplier distribution (no single miner > 25% of total merge bonus across the run).

## What to do if something goes wrong

- **Divergence within audit window** → see [`../docs/multisig-key-set.md`](../docs/multisig-key-set.md) revert procedure.
- **Bug in cortex-server only** → pause `CortexRegistry`, fix, redeploy, unpause.
- **Bug in SWCP integration** → stop cortex-server (latch), fix in `/internal/*` shim, restart cortex-server.
- **Disclosed audit-window trust assumption proven costly** → V1 path: bond-based or ZK fraud proofs. See [`../docs/v1-roadmap.md`](../docs/v1-roadmap.md).

---

A green Phase 8 testnet run + clean rehearsals (steps 6 + 7) + filled multisig key set are the **pre-conditions** for step 8 (go-live). Do not proceed without all three.
