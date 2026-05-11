# CoreTex Production Runbook

Last updated: 2026-05-10.

This runbook is the operational counterpart to
`docs/CORETEX_LAUNCH_PLAN_v2.md` and
`docs/CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md`. It documents the
deploy procedure, replay-watcher topology, escrow operations, retention
policy, rate-limit envelope, kill switches, and bundle rotation procedure
for the mainnet launch.

The controlling end-to-end orchestration runbook is
`docs/CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md`. The launch
orchestrator must execute that runbook end-to-end. This document is the
operations reference for §1.5 (coordinator env), §3 (replay-watcher
topology), §4 (escrow), §5 (retention), §6 (rate-limit envelope),
§7 (kill switches), and §8 (bundle rotation).

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
- Corpus capacity gate passes:
  `node scripts/estimate-coretex-corpus-capacity.mjs --seeds-per-domain 512 --pack-size 128 --epochs-per-day <cadence> --min-months 6`.
- Generated corpus reproduces byte-identical `corpusRoot` on two clean
  hosts (run `node scripts/generate-coretex-retrieval-corpus.mjs --source
  challenge-library` on both with the same built challenge package and model
  cache, then compare).
- Corpus validation passes with zero errors:
  `node scripts/validate-retrieval-corpus.mjs --corpus <path> --min-events <N> --min-per-family <N>`.
- Phase 13 e2e (`node test/e2e/phase-13/run.mjs`) passes including the
  adversarial sub-test.
- Bundle manifest verifies (`verifyBundleManifest` returns []).
- Bi-encoder + production reranker model weights cached locally on every
  coordinator + watcher host with the pinned commit SHA-256s. MemReranker-4B
  is cached only on hosts running offline qrel audits.

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
miner-side workflow is documented in `docs/CORETEX_MINER_QUICKSTART.md`.

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
CORETEX_CORPUS_PRODUCTION=1 CORETEX_BIENCODER=pinned \
node scripts/generate-coretex-retrieval-corpus.mjs \
  --source challenge-library \
  --challenge-lib-root /opt/botcoin-coordinator-live/packages/challenges \
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

## 8.2 Major-delta grace and baseline re-evaluation

When a `CorpusDelta` adds a large number of new `eval_hidden` events
(empirically ≥ 5% of the prior eval_hidden population, threshold pinned
in `manifest.evaluator.profile.majorDeltaThreshold`), the difficulty
calculator's miner-output signal from the prior epoch is no longer a
reliable estimate of "is the threshold right" — the underlying score
distribution has shifted under the substrate. Without the major-delta
grace, the threshold could ramp up on stale signal (decay when the task
got harder) or freeze when baselines actually moved. Phase H1/H2 of
`docs/CORETEX_V4_INDEFINITE_SCALABILITY_HARDENING_PLAN.md` adds a
one-cycle grace that prevents this without introducing any new operator
knob.

Operational ritual on a major delta day (in addition to §8.1):

```bash
# 1. The coordinator computes the delta size and decides whether to enter
#    grace. Pure predicate, no model work:
node -e "
import('@botcoin/cortex').then(({ isMajorDelta }) => {
  const isMajor = isMajorDelta(NEW_EVAL_HIDDEN, PREV_EVAL_HIDDEN, MAJOR_DELTA_THRESHOLD);
  console.log(JSON.stringify({ isMajor }));
});
"

# 2. If major: hand off to the calibration host to re-pin the baseline
#    against the new corpus root + a fresh eval seed for the next epoch.
#    Outputs a new bundle-manifest with baselineParentScorePpm + variancePpm
#    populated, plus an updated bundleHash.
EVAL_SEED_NEXT=0x$(openssl rand -hex 32)
node scripts/pin-baseline-into-bundle.mjs \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --corpus /var/lib/coretex/corpus-epoch-N-plus-1.json \
  --eval-seed-hex $EVAL_SEED_NEXT \
  --epoch-id $NEXT_CHAIN_EPOCH \
  --samples 1 \
  --out /etc/coretex/bundle-manifest.epoch-N-plus-1.json

# 3. Publish the new BaselineScores + grace flag in the signed epoch
#    rotation manifest the coordinator already writes for §3 reveal flow.
#    Any independent watcher reproduces the baseline from
#    (bundle, corpus, baselineEvalSeedHex) — no coordinator-private state.

# 4. Pass majorDeltaActive=true to nextMinImprovementPpm for this one
#    cycle so the threshold freezes at `current` and decay is suppressed
#    while operators absorb the new baseline. After one cycle the rule
#    resumes normal ramp/decay/drift against the new BaselineScores.
```

The `majorDeltaThreshold`, `baselineParentScorePpm`, `baselineVariancePpm`,
`baselineSamples`, and `baselineEvalSeedHex` fields on the bundle profile
are validated **all-or-nothing** by `verifyBundleManifest`: if any one
of the baseline-* group is set, all four must be set and consistent
(`baselineParentScorePpm` non-negative, `baselineVariancePpm` non-negative,
`baselineSamples` ≥ 1, `baselineEvalSeedHex` exactly `0x` + 64 hex).
This prevents a half-pinned bundle from silently invalidating the
acceptance normalization. Bundles that predate the hardening (no
baseline-* fields, no `majorDeltaThreshold`) verify clean and the
coordinator falls back to the pre-grace difficulty rule.

Rate limits remain flat per-miner ceilings + global backpressure (503
on queue saturation). **Never** credit-aware. The credit/BPS tier
system is the sole economic differentiator.

## 8.3 Sealed evaluation lifecycle (S0 / S1 / S2 cortex side)

`POST /coretex/evaluate` is sealed during the active mining window
(Phase S0): the route shim short-circuits to
`403 coretex-hidden-eval-sealed` before the host's evaluate callback
ever runs. The miner-facing path during commit window is the new
sealed-eval surface added by Phase S1:

```
POST /coretex/commit                 → commit a patch hash + salt
POST /coretex/reveal                 → open the commitment after close
GET  /coretex/commit/:commitmentHash → read commit ledger entry
GET  /coretex/epoch/:epochId/status  → poll the epoch seal status
```

The host wires these to its own commit-ledger storage and on-chain
anchoring via the `submitCommit`, `submitReveal`, `getCommit`,
`getEpochStatus` callbacks on `CoreTexCoordinatorDataSource`. The
canonical wire shape (hashing, duplicate-key, commitmentRoot
Merkleization) is provided as pure functions by `@botcoin/cortex` —
no host arithmetic, no off-by-one risk:

```ts
import {
  computePatchCommitmentHash,
  buildPatchCommitment,
  verifyPatchReveal,
  computeDuplicateKey,
  computeCommitmentRoot,
  deriveCoretexEvalSeed,
  deriveGateSeed,
  deriveConfirmSeed,
} from '@botcoin/cortex';
```

At commit close the operator runs:

```text
commitmentRoot = computeCommitmentRoot(allAcceptedCommitmentHashes)
                                              # sort + dedupe + Merkle
anchor commitmentRoot on chain                # before revealing the seed
reveal epochSecret                            # multisig escrow output
fetch futureBlockHash for the pinned future block height
                                              # block must be AFTER commit close
optionalDrandRoundHash = fetch from drand     # recommended, optional

coretexEvalSeed = deriveCoretexEvalSeed({
  epochId, epochParentRoot, corpusRoot, bundleHash,
  commitmentRoot, epochSecret, futureBlockHash,
  optionalDrandRoundHash,
})
gateSeed    = deriveGateSeed(coretexEvalSeed)
confirmSeed = deriveConfirmSeed(coretexEvalSeed)
```

`deriveCoretexEvalSeed` REFUSES a zero `futureBlockHash` (would
collapse to coordinator-only randomness — explicitly forbidden by the
hardening plan rule 5). A zero futureBlockHash means "block not yet
observed" and the seed derivation must wait, not silently degrade.

The legacy `POST /v1/cortex/submit` interactive screener is now
disabled by default. Hosts that intentionally want the pre-sealed-eval
flow (local dev, staging without an active hidden pack) opt in by
setting `CORETEX_LEGACY_SUBMIT_ENABLED=1` in the coordinator env.
Default (env unset) returns `410 coretex-legacy-submit-disabled` so a
stale deployment cannot accidentally accept active hidden-pack
screener submissions over the sealed-eval window.

Coordinator-affiliated wallets (coordinator owner/signing, calibration
host, operator staff, privileged infra) MUST be excluded from mining.
This is simpler than trying to prove privileged actors did not
inspect hidden material before committing; the disqualification list
is auditable from on-chain stake/account records.

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
