# CoreTex Mainnet Launch Checklist

Last updated: 2026-05-10.

The hardening plan §Phase H sequencing, expanded into a per-step gate.
Each box must be green before the next is started.

## 0. Pre-conditions

- [ ] `docs/CORETEX_LAUNCH_PLAN_v2.md` is the launch-controlling plan,
      with `docs/CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md` retained
      only as design background where non-conflicting.
- [ ] `docs/CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md` has been
      executed end to end by the launch orchestrator and sub-agents.
- [ ] Phase A through G acceptance gates are green (see plan).
- [ ] `docs/CORETEX_SOURCE_DATA_AUDIT.md` outcome is recorded.
- [ ] `docs/CORETEX_MODEL_SELECTION_AUDIT.md` exists and pins the
      production reranker + offline audit/reference reranker.

## 1. Calibration outputs

- [ ] `scripts/calibrate.mjs` ran on ≥3 hardware configurations.
- [ ] `bundle-profile.json` is committed (or staged) and signed by ops.
- [ ] `replayTolerancePpm` ≥ aggregate P99 cross-host diff.
- [ ] `replayTolerancePpm` ≤ `patchAcceptanceFloors.minImprovementPpm`.
- [ ] All composite weights satisfy `w_retrieval ≥ 0.70`,
      `w_structural_sanity ≤ 0.10`, sum to 1.0.
- [ ] All split ratios sum to 100.
- [ ] `relationHopBudget ∈ [1, 6]`.

## 2. Bundle manifest

- [ ] `npm run build:bundle` produces a manifest with
      `schemaVersion: 'coretex.client-bundle.v2'`.
- [ ] `verifyBundleManifest(manifest, repoRoot)` returns `[]`.
- [ ] Manifest pins:
  - [ ] BGE-M3 dense bi-encoder + 40-hex revision + tokenizer revision +
        per-file SHA-256 + retrieval-key layout
  - [ ] Production reranker (Qwen3-Reranker-0.6B or selected) + revision
        + per-file SHA-256
  - [ ] Labeling reranker (separately pinned, stronger model) + revision
        + per-file SHA-256
  - [ ] `acceleratorPolicy: 'cpu_only'`
  - [ ] `runtimePin` (versions + buildFlags)
  - [ ] composite weights, patch acceptance floors, split ratios,
        hidden-pack profile, relation hop budget, abstention threshold,
        reveal grace period
  - [ ] `baseRpcConfig: { chainId: 8453, blockTimeSeconds: 2, targetBlockOffset: 30 }`
        (per-patch eval-seed binding — see
        `CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md` §Seed Formula)
  - [ ] `replayBlockhashLookbackBlocks: 50000` (~28h coverage at 2s blocks)
- [ ] `bundleHash` is the production `coreVersionHash`.

## 3. Determinism check

- [ ] `node scripts/determinism-check.mjs` ran on each calibrated host
      with the pinned bundle manifest + 1000-pair sample.
- [ ] `node scripts/aggregate-determinism.mjs` returned exit 0 with
      P99 ≤ `replayTolerancePpm`.
- [ ] Aggregate report archived in `reports/determinism-aggregate.json`.
- [ ] Seed-derivation golden vectors pass:
      `node --test packages/cortex/test/unit/seed-derivation.test.mjs`
      returns 100% reproduction over 1000-input random property test
      (per `CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md` §Testing Checkpoints).
- [ ] Per-patch QueryPack determinism passes:
      `node scripts/check-per-patch-pack-determinism.mjs --bundle <bundle>
       --corpus <corpus> --patches 50` returns 150/150 byte-identical reproductions,
      0 collisions across 50 triples.

## 3.5 Base RPC verification

- [ ] `node scripts/verify-base-rpc.mjs --rpc-url $BASE_MAINNET_RPC --lookback 50000`
      returns exit 0. `eth_blockNumber` and `eth_getBlockByNumber(latest-50000)`
      both succeed within 10s.
- [ ] RPC tier documented in `reports/base-rpc-tier.json` confirms blockhash
      lookback ≥ `replayBlockhashLookbackBlocks` (50000 ≈ 28h on Base).
- [ ] Independent replay watcher hosts each verified against the same RPC
      tier (different provider acceptable; same lookback floor required).

## 4. Corpus generation

- [ ] `node scripts/estimate-coretex-corpus-capacity.mjs` passes the launch
      gate for the intended epoch cadence. Minimum launch target:
      `seeds-per-domain=512`, `pack-size=128`, `min-months=6`.
- [ ] `node scripts/generate-coretex-retrieval-corpus.mjs --source
      challenge-library` produced a corpus reproducing byte-identically
      across two clean hosts from the same built challenge package.
- [ ] Per-family / per-bucket coverage statistics printed to stdout.
- [ ] Corpus carries embedding payloads matching the bundle's pinned
      bi-encoder.
- [ ] `node scripts/validate-retrieval-corpus.mjs --corpus <path>`
      returns zero errors and writes `reports/corpus-validation.json`.
- [ ] Expansion rehearsal publishes `corpus-delta-N-plus-1.json`, applies
      cleanly, and preserves `previousRoot -> nextRoot` continuity.
- [ ] Per-domain qrel distribution sampled and reported in
      `reports/corpus-qrel-distribution.json`.

## 5. Phase 13 e2e

- [ ] `node test/e2e/phase-13/run.mjs` passes with
      `CORETEX_RERANKER=qwen3 CORTEX_REAL_EVAL=1
      CORETEX_RERANKER_PRODUCTION=1 CORETEX_BIENCODER=pinned`.
- [ ] Adversarial sub-test rejects "correct ids + bad vectors" patch.
- [ ] Replay watcher reproduces every signed `scoreAfterPpm` within
      `replayTolerancePpm`.
- [ ] `node test/e2e/phase-13/run.mjs` refuses to run with
      `CORETEX_RERANKER=deterministic` in production mode.
- [ ] Mining loop uses mock Base RPC with deterministic blockhash
      schedule; per-patch eval-seed reproduces byte-identically on
      replay (per `CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md` §Testing
      Checkpoints #3).
- [ ] Adversarial epoch-secret sub-test: replay with wrong epochSecret
      rejects 5/5 receipt signatures.

## 6. Contract deploy

- [ ] `forge script /root/botcoin/script/DeployV4.s.sol` deployed
      `CortexState` + `BotcoinMiningV4` to Base mainnet.
- [ ] Deploy uses production constants:
  - [ ] `EXISTING_V3 = <live V3 address>`
  - [ ] `CORETEX_CORE_VERSION_HASH = <bundleHash>`
  - [ ] `CORETEX_MIN_IMPROVEMENT_PPM = <calibrated>`
- [ ] Contracts verified on Basescan (`--verify`).
- [ ] `docs/contract-addresses-mainnet.md` updated with deploy block,
      tx, deployer.

## 7. Epoch 0 init

- [ ] `cast send $CORTEX_STATE_ADDRESS initializeEpoch(...)` called.
- [ ] `getEpoch(0)` returns the expected
      `(parentStateRoot, corpusRoot, coreVersionHash, minImprovementPpm,
        evalSeedCommit, …)`.
- [ ] `freezeEpoch(0)` called.
- [ ] `evalSeed` preimage stored in multisig escrow with signed receipt.

## 8. Reward lane

- [ ] `cast send $CORTEX_STATE_ADDRESS setRewardLane(...)` set to
      `BotcoinMiningV4` address.
- [ ] `rewardLane()` view returns the V4 address.

## 9. Coordinator config

- [ ] Coordinator env populated per
      `docs/CORETEX_PRODUCTION_RUNBOOK.md` §1.5.
- [ ] No GPU env vars set.
- [ ] Python venv versions match `runtimePin`.
- [ ] `assertBundleBindingAtStartup` passes.

## 10. Replay watchers

- [ ] ≥3 independent watchers started across hardware/operator
      boundaries.
- [ ] Each watcher's `--bundle-manifest` matches the production manifest.
- [ ] Each watcher's `--core-version-hash` matches the on-chain value.
- [ ] Alarm webhooks wired to PagerDuty + Slack.

## 11. First miner go-live

- [ ] Botcoin core team performs the on-chain-reads-only mining cycle
      end-to-end:
  - [ ] read `getEpoch(0)`
  - [ ] `GET /coretex/status` (cross-check epochId, bundleHash, corpusRoot)
  - [ ] `GET /coretex/challenge` returns a packet with parentStateRoot
  - [ ] `GET /coretex/substrate/<stateRoot>` returns the substrate snapshot
  - [ ] `POST /coretex/submit` returns either
        `{status:'accepted', patchHash, evalReportHash?, receipt?}` or an
        opaque `{status:'rejected', code:'rejected', patchHash?}` envelope
  - [ ] accepted receipt submission to
        `BotcoinMiningV4.submitWorkReceipt(...)` succeeds
  - [ ] `GET /coretex/patch-received/<patchHash>` returns the strict-shape
        notice for the accepted patch
  - [ ] on-chain state advances; `coretexCredits[miner]` increases

## 12. Post-launch monitoring

- [ ] Replay watcher heartbeat dashboard online.
- [ ] Coordinator queue-depth dashboard online.
- [ ] Per-miner + global rate-limit dashboard online.
- [ ] Eval-report retention pipeline writing to S3 (`cortex-eval-reports`).
- [ ] Corpus-delta retention pipeline writing to S3 (`cortex-corpus-deltas`).
- [ ] Audit canary watchdog: every published score on a `canary` query
      reproduces against the bundled qrels (deterministic, no model needed).

## 13. Acceptance criteria — production-ready (plan §Acceptance Criteria)

- [ ] Reward law is `nDCG@10` over hidden query packs; retrieval ≥ 70%
      of composite weight; structural validity ≤ 10% sanity-only.
- [ ] Bi-encoder is BAAI/bge-m3 pinned + CPU-only.
- [ ] Cross-encoder reranker is the strongest deterministic 0.6B-class
      memory/retrieval reranker selected by the model-selection audit.
- [ ] Labeling model is separately pinned, never the production reranker.
- [ ] Corpus carries graded qrels, hidden splits, embedding payloads in
      deltas; reproducible byte-identically.
- [ ] Hidden query packs deterministic from seed; sampling auditable;
      seed escrow with multisig + `revealGracePeriod`.
- [ ] Phase 13 cycle passes incl. adversarial sub-test.
- [ ] Replay watchers reproduce signed `scoreAfterPpm` within
      `replayTolerancePpm` across ≥3 CPU configurations.
- [ ] Production env refuses to run with deterministic reranker, with
      `'main'` revision, with mismatched bundle hash, with GPU
      acceleration on the canonical scoring path, with missing escrow.
- [ ] Miner workflow exercised end-to-end without local CoreTex.
- [ ] All stale code paths from prior structural-commitment work are
      deleted; the repository compiles and tests pass without them.
