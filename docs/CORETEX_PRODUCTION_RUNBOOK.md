# CoreTex Production Runbook

Last updated: 2026-05-10.

This runbook is the operational counterpart to
`docs/CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md`. It documents the
deploy procedure, replay-watcher topology, escrow operations, retention
policy, rate-limit envelope, kill switches, and bundle rotation procedure
for the mainnet launch.

## 1. Mainnet deploy

There is no migration. Mainnet launch is a fresh deploy to fresh addresses.

### 1.1 Pre-flight

- Calibration outputs frozen into `bundleProfile.json` (run
  `node scripts/calibrate.mjs --bundle-manifest <template> --calibration-corpus <path> --determinism-aggregate <path> --out bundle-profile.json`).
- Determinism harness P99 within the calibrated `replayTolerancePpm` across
  ≥3 hardware configurations (run
  `node scripts/determinism-check.mjs` on each host, then
  `node scripts/aggregate-determinism.mjs --reports './reports/determinism-host-*.json'`).
- Source data audit `docs/CORETEX_SOURCE_DATA_AUDIT.md` exists and the
  outcome (`reject_current_data` for launch) is reflected in the corpus
  build script choice.
- Generated corpus reproduces byte-identical `corpusRoot` on two clean
  hosts (run `node scripts/generate-coretex-retrieval-corpus.mjs` on both
  and compare).
- Corpus validation passes with zero errors:
  `node scripts/validate-retrieval-corpus.mjs --corpus <path> --min-events <N> --min-per-family <N>`.
- Phase 13 e2e (`node test/e2e/phase-13/run.mjs`) passes including the
  adversarial sub-test.
- Bundle manifest verifies (`verifyBundleManifest` returns []).
- Bi-encoder + reranker + labeling reranker model weights cached locally on
  every coordinator + watcher host with the pinned commit SHA-256s.

### 1.2 Deploy contracts

```
forge script /root/botcoin/script/DeployV4.s.sol \
  --rpc-url $BASE_MAINNET_RPC \
  --private-key $DEPLOYER_PK \
  --broadcast \
  --verify \
  -vvv \
  --sig "run(address,bytes32,uint32)" \
    $EXISTING_V3_ADDRESS \
    $CORETEX_CORE_VERSION_HASH \
    $CORETEX_MIN_IMPROVEMENT_PPM
```

Captures (record into `docs/contract-addresses-mainnet.md`):
- `CortexState` address
- `BotcoinMiningV4` address
- deploy block, deploy tx, deployer

### 1.3 Initialize epoch 0

```
cast send $CORTEX_STATE_ADDRESS \
  "initializeEpoch(uint64,uint32,bytes32,bytes32,bytes32,bytes32,uint16,uint32,bytes32)" \
  0 \
  $RULES_VERSION \
  $WORK_POLICY_HASH \
  $CORPUS_ROOT \
  $CORETEX_CORE_VERSION_HASH \
  $GENESIS_STATE_ROOT \
  1024 \
  $CORETEX_MIN_IMPROVEMENT_PPM \
  $EVAL_SEED_COMMIT \
  --private-key $OWNER_PK
```

Then freeze:

```
cast send $CORTEX_STATE_ADDRESS "freezeEpoch(uint64)" 0 --private-key $OWNER_PK
```

### 1.4 Wire reward lane

```
cast send $CORTEX_STATE_ADDRESS "setRewardLane(address)" $V4_ADDRESS \
  --private-key $OWNER_PK
```

### 1.5 Coordinator env

```
CORETEX_ENABLED=true
CORETEX_EXPECTED_BUNDLE_HASH=<bundleHash>
CORETEX_BUNDLE_MANIFEST=/etc/coretex/bundle-manifest.json
CORETEX_CORPUS=/var/lib/coretex/corpus.json
CORETEX_RERANKER=qwen3
CORETEX_RERANKER_PRODUCTION=1
CORTEX_REAL_EVAL=1
CORETEX_BIENCODER=pinned
CORETEX_BIENCODER_REVISION=<bundle.model.biEncoder.revision>
CORTEX_RECEIPT_MODE=v4
CORETEX_EVAL_SEED_HEX=<seed-preimage; rotated per epoch>
CORETEX_EPOCH_ID=<current epoch id>
CORETEX_MULTISIG_ESCROW_ADDR=<escrow contract or oracle address>
CORETEX_RATE_LIMIT_PER_MINER_PER_MIN=20
CORETEX_RATE_LIMIT_GLOBAL_PER_MIN=200
CORETEX_RATE_LIMIT_EVALUATE_GLOBAL_PER_MIN=60
```

GPU env vars must be **unset**: `CORETEX_USE_GPU`, `CUDA_VISIBLE_DEVICES`,
`PYTORCH_USE_MPS`, `ONNXRUNTIME_PROVIDERS` (or set to CPU only).

### 1.6 Replay watchers

Start ≥3 independent replay watchers across distinct hardware/operator
boundaries:

```
coretex-replay watch \
  --rpc $BASE_MAINNET_RPC \
  --v4 $V4_ADDRESS \
  --cortex-state $CORTEX_STATE_ADDRESS \
  --from-block $DEPLOY_BLOCK \
  --parent-state /var/lib/coretex/genesis.bin \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --core-version-hash $CORETEX_CORE_VERSION_HASH \
  --poll-interval-ms 12000
```

Watchers MUST run on CPU-only hardware matching one of the calibrated
configurations. Disagreement larger than `replayTolerancePpm` triggers a
PagerDuty + Slack alarm via the watcher's `--alarm-webhook` flag.

### 1.7 First-miner go-live

The first miner uses only on-chain reads + REST: `cast call` against
`CortexState.getEpoch(0)` to read `evalSeedCommit` etc., then `curl
$COORDINATOR/coretex/substrate/current` and `curl
$COORDINATOR/coretex/corpus/<id>/embedding` to construct a candidate
patch, then `POST /coretex/screen` and `POST /coretex/evaluate`. The
miner-side workflow is documented in `docs/miner-guide.md`.

## 2. Replay watcher topology

| Role | Operator | Hardware | Region |
|---|---|---|---|
| Primary watcher | Botcoin core | bare-metal AMD EPYC 7763 (PD) | us-east |
| Independent watcher 1 | Audit firm A | bare-metal Intel Xeon 6248 | eu-west |
| Independent watcher 2 | Audit firm B | bare-metal Ampere Altra | apac |

Each watcher reports a heartbeat to the coordinator's
`/coretex/health` endpoint. Watcher silence > 30 minutes triggers an
operator alarm.

## 3. Multisig seed-escrow procedure

### 3.1 Commit time (epoch init)

1. Coordinator generates `evalSeed = secureRandomBytes(32)`.
2. Coordinator computes `evalSeedCommit = keccak256(evalSeed)`.
3. Coordinator submits `CortexState.initializeEpoch(...)` with `evalSeedCommit`.
4. Coordinator immediately forwards `evalSeed` to the multisig escrow
   service (M-of-N = 3-of-5):
   - encrypted to each signer's public key
   - stored in shared HSM-backed vault
   - signed escrow receipt naming the M-of-N signer set is logged
     off-chain (`/var/lib/coretex/escrow/epoch-N.signed-receipt.json`)

### 3.2 Reveal time (epoch close)

1. Coordinator calls `CortexState.revealEvalSeed(epochId, evalSeed)`.
2. Coordinator publishes the seed in the `/coretex/eval-report/*`
   endpoints and `coretex/challenge-book/*`.

### 3.3 Reveal-grace-period escalation

If the epoch closes and `revealEvalSeed` is not called within
`revealGracePeriodSeconds` (calibrated; default 6h), the multisig escrow
holders are obligated to reconstitute and publish the seed. This
publication unfreezes replay and triggers the operator post-mortem.

## 4. Per-artifact retention

| Artifact | Retention | Storage |
|---|---|---|
| Substrate snapshots (full state every 100 epochs) | forever | S3 (read-only after epoch close) |
| Patch wire bytes | forever | chain events |
| Eval reports (signed) | ≥ 90 days | S3 (cortex-eval-reports) |
| Challenge books | ≥ 365 days | S3 (cortex-challenge-books) |
| Corpus deltas (signed, with embeddings) | forever | S3 (cortex-corpus-deltas) |
| Bundle manifests | forever | S3 + chain events |
| Determinism-check reports | ≥ 90 days | S3 (cortex-determinism) |
| Audit-trail signing logs | ≥ 365 days | append-only, off-chain |

## 5. Coordinator startup checks (refusal modes)

The coordinator refuses to start if any of:

1. `bundleManifest.bundleHash != onChainCoreVersionHash`
2. `acceleratorPolicy != cpu_only`
3. Any GPU env var set
4. `CORETEX_RERANKER_PRODUCTION=1` and `CORETEX_RERANKER=deterministic`
5. `model.reranker.modelId == model.labelingReranker.modelId &&
    model.reranker.revision == model.labelingReranker.revision`
6. Any model revision is `'main'`, `'master'`, `'latest'`, `'head'`,
   `'placeholder'`, `'todo'`, or fails the 40-hex commit-sha shape check
7. Installed Python venv versions do not match `runtimePin.versions`
8. `CORETEX_MULTISIG_ESCROW_ADDR` unset in production mode

## 6. Per-evaluator GPU/CPU saturation guard

The evaluate endpoint's worker pool exposes a queue-depth probe:

- Soft watermark: queue depth > 50 → return `503 retry-after`
- Hard watermark: queue depth > 200 → reject with `{ error: 'evaluator_overloaded' }`

Per-miner rate limiter (token bucket; `CORETEX_RATE_LIMIT_PER_MINER_PER_MIN`)
applied before the evaluator is consulted. Global rate limit
(`CORETEX_RATE_LIMIT_GLOBAL_PER_MIN`) protects the worker pool from
collective DoS.

## 7. Kill switch / rollback

There is no in-place rollback that preserves chain state. The kill switch
is:

```
cast send $CORTEX_STATE_ADDRESS "setRewardLane(address)" 0x0000000000000000000000000000000000000000 \
  --private-key $OWNER_PK
```

Plus coordinator env: `CORETEX_ENABLED=false`. The chain state at the
failure point is frozen; a fresh deploy with the bug fixed follows.

## 8. Bundle rotation procedure (non-emergency)

When a stronger reranker becomes available or when the bi-encoder is
re-pinned:

1. Run the model-selection audit (`docs/CORETEX_MODEL_SELECTION_AUDIT.md`)
   to choose the new pin.
2. Re-run calibration (`scripts/calibrate.mjs`) on the new model + same
   calibration corpus → produce a new `bundleProfile.json`.
3. Run determinism harness on ≥3 hosts → `replayTolerancePpm` is the
   ceiling-rounded P99.
4. `npm run build:bundle` to compute the new `bundleHash`.
5. Deploy a fresh `CortexState` + `BotcoinMiningV4` to fresh addresses
   with the new `bundleHash`.
6. Initialize epoch 0; freeze.
7. Wire reward lane.
8. Cut over coordinator config + replay watchers.
9. Old chain state remains read-only forever.

## 8.1 Corpus expansion and difficulty scaling

Every epoch may append a signed `CorpusDelta` carrying new graded-qrel
records plus embedding payloads. The coordinator builds the next corpus with:

```
CORETEX_CORPUS_PRODUCTION=1 CORETEX_BIENCODER=pinned CORETEX_LABELER=pinned \
node scripts/generate-coretex-retrieval-corpus.mjs \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --previous-corpus /var/lib/coretex/corpus-epoch-N.json \
  --seed-offset $NEXT_SEED_OFFSET \
  --seeds-per-domain $NEW_SEEDS_PER_DOMAIN \
  --corpus-epoch $CORPUS_EPOCH \
  --epoch $NEXT_CHAIN_EPOCH \
  --out /var/lib/coretex/corpus-epoch-N-plus-1.json \
  --delta-out /var/lib/coretex/deltas/corpus-delta-N-plus-1.json
```

Then run:

```
node scripts/validate-retrieval-corpus.mjs \
  --corpus /var/lib/coretex/corpus-epoch-N-plus-1.json \
  --min-events $MIN_CORPUS_EVENTS \
  --min-per-family $MIN_PER_FAMILY
```

Difficulty rises by tightening the next epoch's `minImprovementPpm`,
increasing hidden-pack `packSize`, increasing hard-negative density, and
raising the per-family coverage floor only after calibration shows replay
determinism within `replayTolerancePpm`. The corpus can grow indefinitely
because each delta preserves `previousRoot -> nextRoot` continuity and embeds
all bytes needed for replay watchers to recompute scores without coordinator
cache trust.

## 9. Audit-trail signing scheme

Every coordinator-issued artifact carries an EIP-712 or ECDSA signature:

- WorkReceipt: EIP-712 over the V4 contract's `WorkReceipt` typed-data
- CorpusDelta: ECDSA over `canonicalJson(delta \ signature)` with the
  operator's RSA-2048 or ECDSA-P256 key
- EpochRotationManifest: same scheme
- Eval report: keccak256(canonical-JSON) signed by the coordinator's
  EIP-712 key

Public keys are pinned in the bundle manifest's `signing` field. Watchers
verify all signatures.

## 10. Incident response — common failure modes

### 10.1 Replay watcher disagreement

Symptom: watcher reports `|coordinatorScore - watcherScore| > replayTolerancePpm`.

Steps:
1. Confirm watcher's installed runtime matches `runtimePin`.
2. Confirm watcher's CPU is in the calibrated set.
3. If yes, escalate: probable reranker non-determinism. Halt accepting
   patches until reproduced.

### 10.2 Eval seed lost before reveal

Symptom: epoch closes without `revealEvalSeed` and multisig escrow can
publish but coordinator cannot.

Steps:
1. Multisig signers reconstitute the seed.
2. Coordinator regains seed; submits `revealEvalSeed`.
3. Replay watchers proceed from reveal.

### 10.3 Coordinator-corpus drift

Symptom: `evaluate` returns `E_CORPUS_ROOT_MISMATCH`.

Steps:
1. Confirm coordinator and miner are both reading the same `corpusRoot`
   on chain.
2. If miner is on stale corpus, instruct to refetch via
   `GET /coretex/corpus-delta/<epoch>`.

### 10.4 Reranker subprocess crash loop

Symptom: `bi-encoder subprocess failed` or `reranker subprocess failed`.

Steps:
1. Check Python venv health (`pip freeze | diff <expected>`).
2. Re-cache pinned model weights; verify per-file SHA-256.
3. If hardware OOM, reduce `BIENCODER_NUM_THREADS`.
