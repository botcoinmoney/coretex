# User Actions — Mainnet Launch

This is the launch checklist for Botcoin Cortex V0 on Base mainnet. Each numbered step is a user action; the in-repo deliverable that supports it is in italics.

## Pre-launch readiness

- [x] **0. Resolve open V0 blockers**
  - Issue #4 closed via LoCoMo Path B.
  - Issue #8 closed via incremental Merkle update; Phase 3 perf is below the p50 < 10 ms / p99 < 50 ms gate.

- [x] **1. Run Phase 7 baseline iteration**
  - Completed 2026-05-06. Winner: Baseline A.
  - Frozen `coreVersionHash` + `genesisStateRoot` live in `ops/v0-frozen.json` and `docs/contract-addresses.md`.
  - `EXTENDED_FUZZ=1 node test/e2e/phase-7/run.mjs` passed the 1M-patch fuzz gate.
  - Current Phase 7 gate uses the real CortexBench scorer and frozen Baseline A genesis.
  - Local model-assisted merge gate calibrated 2026-05-07: `node scripts/local-model-calibration.mjs` passes with `Xenova/multi-qa-MiniLM-L6-cos-v1` across long-horizon, near-collision, and temporal known-good patches.

- [ ] **2. Run Phase 8 testnet for ≥100 epochs / ≥1k patches**
  - *Deliverables*: `contracts/script/DeployTestnet.s.sol`, `scripts/testnet/*`, `test/e2e/phase-8/run.mjs` (golden fixture).
  - *Actions*: deploy to testnet, run synthetic miners via `scripts/testnet/feed-synthetic-traffic.mjs`, verify ≥10 finalized epochs reproduce via `scripts/testnet/auditor-reproduce.mjs`, run latch/unlatch rehearsals × 2.
  - *Pass criteria*: golden e2e fixture green; saturation alarm fires on synthetic flat sequence; live state-advance distribution gate (no single miner > 25% of state-advance credits); pass-rate band hold.

- [ ] **3. ~~Publish operator multisig key set~~** — **DEFERRED to V1.**
  V0 ships with a single-owner audit-window override (`ownerRevertEpoch`).
  The multisig wiring (`voteRevertEpoch`) remains in the contract for V1
  reactivation. Until then, the V0 owner alone calls `ownerRevertEpoch`
  within `CHALLENGE_WINDOW_SECONDS`. See `ops/multisig.md` for the
  V1 plan; `docs/multisig-key-set.md` template is dormant until V1.

## Mainnet deploy

- [ ] **4. Mainnet deploy of `CortexRegistry` + legacy `CortexMergeBonus`**
  ```bash
  MAINNET_CONFIRM=I-UNDERSTAND \
  OWNER_ADDRESS=0x...                 # V0 single-owner revert authority
  COORDINATOR_ADDRESS=0x...           # existing SWCP coordinator EOA
  BOTCOIN_TOKEN_ADDRESS=0x... \
  forge script contracts/script/DeployMainnet.s.sol \
    --rpc-url $BASE_RPC_URL --broadcast --verify
  ```
  `MERGE_MULTIPLIER_BPS` (`10000`, no separate uplift), `CHALLENGE_WINDOW_SECONDS` (`21600`),
  and `SNAPSHOT_EPOCH_INTERVAL` (`100`) are compile-time constants in the
  contracts — change in source + redeploy if a different value is required.
  - Record `CortexRegistry` and `CortexMergeBonus` addresses in `docs/contract-addresses.md` (replace `<TBD>`).
  - Run `node scripts/post-deploy-smoke.mjs` to verify bytecode + selectors.

- [ ] **5. Mainnet dry-run epoch (zero legacy-bonus funding)**
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

- [ ] **6. Owner-revert rehearsal (V0)**
  - Announce a synthetic divergence ≥24h in advance.
  ```bash
  CORTEX_REGISTRY_ADDRESS=0x... \
  OWNER_PK=0x... \
  cast send $CORTEX_REGISTRY_ADDRESS "ownerRevertEpoch(uint64)" $TEST_EPOCH \
    --rpc-url $BASE_RPC_URL --private-key $OWNER_PK
  ```
  - Verify the targeted epoch is reverted (`epochReverted[epoch] == true`,
    `epochFinalized[epoch] == false`); bonus funding for that epoch is blocked.
  - Public post-mortem within 72h.
  - V1: replace this step with the `voteRevertEpoch` 2-of-N rehearsal once the
    multisig key set is published.

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
  - Confirm production env has `CORTEX_REAL_EVAL=1`, `CORTEX_LOCAL_MODEL_EVAL=1`, and `CORTEX_LOCAL_MODEL_PREWARM=1`.
  - Run `node scripts/local-model-calibration.mjs` on the deployment host before opening the lane.
  - Allow the first paying epoch to finalize. No V0 legacy merge-bonus funding is expected; state-advance credits settle through the normal receipt path.

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
  - State-advance distribution (no single miner > 25% of total state-advance credits across the run).

## What to do if something goes wrong

- **Divergence within audit window** → see [`../docs/multisig-key-set.md`](../docs/multisig-key-set.md) revert procedure.
- **Bug in cortex-server only** → pause `CortexRegistry`, fix, redeploy, unpause.
- **Bug in SWCP integration** → stop cortex-server (latch), fix in `/internal/*` shim, restart cortex-server.
- **Disclosed audit-window trust assumption proven costly** → V1 path: bond-based or ZK fraud proofs. See [`../docs/v1-roadmap.md`](../docs/v1-roadmap.md).

---

A green Phase 8 testnet run + clean rehearsals (steps 6 + 7) are the **pre-conditions** for step 8 (go-live). The multisig key set is **deferred to V1**; V0 ships with single-owner revert.
