# CoreTex Final Production E2E Orchestrator Runbook

Status: launch-blocking operational spec for the final AI orchestrator and
sub-agents. This is the end-to-end checklist for the CPU calibration server,
the coordinator wiring pass, and the final real on-chain audit pass.

The orchestrator does not stop at partial success. If a prerequisite is
missing, it builds or provisions that prerequisite and continues. If a test
fails, it fixes the failure, reruns the affected gate, reruns the downstream
gates, commits to `/root/cortex`, pushes to `origin/main`, and updates the
handoff docs.

## Non-Negotiable Launch Shape

CoreTex launch is one pinned, publicly reproducible Botcoin CoreTex version:

- One `bundleHash` / `coreVersionHash` pins the evaluator, model manifests,
  corpus root, substrate semantics, replay commands, and calibrated profile.
- The corpus is generated from the coordinator challenge library with
  append-only signed deltas. It is not hand-maintained.
- Difficulty increases through calibrated `minImprovementPpm`, hidden-pack
  size, family quotas, hard-negative density, modifier counts, constraint
  difficulty, and domain-library expansion. CoreTex code does not change for
  ordinary corpus growth.
- The on-chain substrate is always the 1024-word / 32 KB temporal retrieval
  map. Miners improve the substrate by submitting compact patches that improve
  retrieval metrics against hidden query packs.
- Anyone can clone CoreTex, fetch the bundle/corpus/deltas/on-chain logs, and
  reproduce replay without trusting coordinator private state.

## Research Alignment Gate

The orchestrator verifies the benchmark shape before production signing:

- Primary retrieval quality is `nDCG@10`, with `MRR@10`, `MAP`, and `Recall@k`
  reported for audit. This follows BEIR/MTEB/MS MARCO-style retrieval practice.
- Evaluation is query-to-ranked-documents, not event-id slot filling.
- The production scorer uses two-stage retrieval plus reranking: compact
  substrate vectors produce candidates, Qwen3-Reranker-0.6B reranks the
  candidates, and graded qrels score the ranking.
- The corpus has visible/calibration/hidden/canary splits. Hidden/canary
  records stay masked until reveal.
- Qrels are graded, not binary-only, and hard negatives are explicit.
- Memory-specific difficulty includes temporal, multi-hop, entity collision,
  and long-horizon questions.

References checked on 2026-05-10:

- BEIR introduces heterogeneous retrieval evaluation across many datasets and
  retrieval architectures: https://arxiv.org/abs/2104.08663
- MTEB motivates broad, multi-task embedding evaluation rather than one narrow
  dataset: https://arxiv.org/abs/2210.07316
- MS MARCO passage ranking evaluates reranking of candidate passages with MRR:
  https://microsoft.github.io/MSMARCO-Passage-Ranking/
- Sentence Transformers cross-encoder reranking evaluation reports `MRR@10`,
  `NDCG@10`, and `MAP` over query/document rankings:
  https://sbert.net/docs/package_reference/cross_encoder/evaluation.html
- MemReranker identifies memory retrieval failure modes in generic rerankers:
  miscalibration, temporal/causal degradation, and shallow semantic matches
  that miss answer-bearing information:
  https://arxiv.org/html/2605.06132v1
- Recent RAG benchmarking work continues to report `Recall@k`, `MRR`, `nDCG`,
  and paired significance tests for retrieval method comparison:
  https://arxiv.org/abs/2604.01733

## Current Base Mainnet Contracts

Source of record: `docs/contract-addresses-mainnet.md`.

```
Chain: Base mainnet, chainId 8453
CortexState:       0x5d3B9D9b246cf8457F320Bb27f008186B69D555d
BotcoinMiningV4:   0x12ff0B47389AE6d6293d44991B0D6A27394494A4
BotcoinMiningV3:   0xB2fbe0DB5A99B4E2Dd294dE64cEd82740b53A2Ea
BOTCOIN token:     0xA601877977340862Ca67f816eb079958E5bd0BA3
Coordinator signer / owner:
  0x6463f89F102e9f53168ABe557173f53c0bBbF635
```

Relevant functions:

```
CortexState.getEpoch(uint64)
CortexState.initializeEpoch(uint64,uint32,bytes32,bytes32,bytes32,bytes32,uint16,bytes32,uint32,bytes32)
CortexState.freezeEpoch(uint64)
CortexState.revealEvalSeed(uint64,bytes32)
CortexState.setRewardLane(address)

BotcoinMiningV4.submitWorkReceipt(
  uint64 epochId,
  uint64 solveIndex,
  bytes32 prevReceiptHash,
  uint8 lane,
  uint8 outcome,
  bytes32 challengeId,
  bytes32 parentStateRoot,
  bytes32 newStateRoot,
  bytes32 experienceCorpusRoot,
  bytes32 coreVersionHash,
  bytes32 evalReportHash,
  bytes32 patchHash,
  bytes32 artifactHash,
  uint128 worldSeed,
  uint32 rulesVersion,
  bytes32 workPolicyHash,
  uint256 workUnitsBps,
  uint16 stateWordCount,
  uint32 scoreBeforePpm,
  uint32 scoreAfterPpm,
  uint64 issuedAt,
  uint64 expiresAt,
  bytes compactPatchBytes,
  bytes signature
)
```

Relevant events:

```
BotcoinMiningV4.CoretexPatchBytes(uint64,address,bytes32,bytes32,bytes)
BotcoinMiningV4.WorkCreditAccepted(...)
CortexState.CortexStateAdvanced(uint64,uint64,bytes32,bytes32,bytes32,bytes32,uint16)
CortexState.CortexEpochSeedRevealed(uint64,bytes32)
```

## Sub-Agent Work Split

The orchestrator may run these in parallel. Each sub-agent writes a short report
under `/var/lib/coretex/reports/` and returns exact commands, artifacts, hashes,
and pass/fail status.

- Corpus agent: capacity, corpus generation, corpus validation, delta rehearsal.
- Model agent: model download, SHA-256 verification, deterministic CPU runtime,
  determinism reports.
- Scorer agent: calibration, hidden-pack quotas, metric sanity, adversarial
  retrieval tests.
- Chain agent: Base fork rehearsal, mainnet read checks, controlled mainnet
  canary receipt, replay watcher.
- Coordinator agent: route mount, startup binding, auth/rate limits, public
  verification endpoints.
- Auditor agent: research alignment, source/diff review, no-secrets check,
  reproduction from fresh clone.

## Environment

Required directories:

```
/root/cortex
/root/botcoin
/root/botcoin-coordinator-live
/var/lib/coretex
/var/lib/coretex/reports
/var/lib/coretex/deltas
/var/lib/coretex/bundles
/etc/coretex
```

Required env variables:

```
BASE_RPC_URL=<authenticated Base RPC>
OWNER_PK=<owner/coordinator key from secure secret store>
CORETEX_CHALLENGE_LIB_ROOT=/root/botcoin-coordinator-live/packages/challenges
CORETEX_BIENCODER=pinned
CORETEX_RERANKER=qwen3
CORETEX_RERANKER_PRODUCTION=1
CORTEX_REAL_EVAL=1
CORETEX_CORPUS_PRODUCTION=1
CORTEX_LOCAL_MODEL_CACHE=/var/lib/coretex/model-cache
CORTEX_STATE_ADDRESS=0x5d3B9D9b246cf8457F320Bb27f008186B69D555d
BOTCOIN_MINING_V4_ADDRESS=0x12ff0B47389AE6d6293d44991B0D6A27394494A4
```

Never commit `.env`, private keys, model weights, RPC credentials, seed
preimages, or unredacted logs.

## Phase 0 - Fresh Build And Git Hygiene

```bash
cd /root/cortex
git fetch origin
git status --short
npm ci
npm run build
npm run typecheck
npm run test:unit --workspace @botcoin/cortex

cd /root/botcoin
forge build
forge test -vvv

cd /root/botcoin-coordinator-live/packages/challenges
npm ci
npm run build
```

Pass criteria:

- `/root/cortex` is clean except intentional changes.
- CoreTex unit tests pass.
- Botcoin contracts build and tests pass.
- Coordinator challenge package exports `generateInterchangeableChallenge`.

## Phase 1 - Capacity And Corpus Launch Build

Capacity:

```bash
cd /root/cortex
node scripts/estimate-coretex-corpus-capacity.mjs \
  --challenge-lib-root $CORETEX_CHALLENGE_LIB_ROOT \
  --domains companies,quantum_physics,computational_biology,scrna_imputation \
  --seeds-per-domain 512 \
  --modifier-counts 0,1,2,3 \
  --constraint-difficulties easy,medium,hard \
  --trap-count 2 \
  --epochs-per-day 3 \
  --pack-size 128 \
  --min-months 6 \
  --out /var/lib/coretex/reports/corpus-capacity.json
```

Corpus build (single worker; persistent BGE-M3 subprocess pipeline,
synthesizer-category qrels):

```bash
CORETEX_CORPUS_PRODUCTION=1 \
CORETEX_BIENCODER=pinned \
CORTEX_REAL_EVAL=1 \
CORETEX_BIENCODER_PYTHON=/root/cortex/.venv/bin/python \
CORETEX_RERANKER_PYTHON=/root/cortex/.venv/bin/python \
CORTEX_LOCAL_MODEL_CACHE=/var/lib/coretex/model-cache \
HF_HUB_CACHE=/var/lib/coretex/model-cache \
HF_HUB_OFFLINE=1 \
BIENCODER_NUM_THREADS=16 BIENCODER_INNER_BATCH=64 \
RERANKER_NUM_THREADS=16 RERANKER_INNER_BATCH=16 \
node scripts/generate-coretex-retrieval-corpus.mjs \
  --source challenge-library \
  --challenge-lib-root $CORETEX_CHALLENGE_LIB_ROOT \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --domains companies,quantum_physics,computational_biology,scrna_imputation \
  --seeds-per-domain 512 \
  --modifier-counts 0,1,2,3 \
  --constraint-difficulties easy,medium,hard \
  --trap-count 2 \
  --corpus-epoch 0 \
  --out /var/lib/coretex/corpus-epoch-0.json
```

Production-mode generation refuses a non-pinned bi-encoder and refuses any
source other than `--source challenge-library`. Hard-negative qrels are
resolved from the synthesizer's structural negative category through the
bundle's `negCategoryRelevanceMap`; the launch corpus does not require a
4B labeler call per event. The script spawns a persistent Python BGE-M3 child
(loaded exactly once) and services NDJSON requests over stdin/stdout — the
legacy per-call spawn variant pays the model-load cost on every encode and is
unusable past a few hundred events on a CPU host.

For multi-shard parallel generation, the parallel driver dispatches
disjoint seed-offset shards and merges them deterministically:

```bash
node scripts/generate-coretex-retrieval-corpus-parallel.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --challenge-lib-root $CORETEX_CHALLENGE_LIB_ROOT \
  --domains companies,quantum_physics,computational_biology,scrna_imputation \
  --seeds-per-domain 512 --workers 4 \
  --modifier-counts 0,1,2,3 \
  --constraint-difficulties easy,medium,hard \
  --trap-count 2 \
  --corpus-epoch 0 \
  --num-threads-per-worker 8 \
  --inner-batch-biencoder 64 \
  --inner-batch-reranker 16 \
  --shard-dir /var/lib/coretex/corpus-shards \
  --out /var/lib/coretex/corpus-epoch-0.json
```

CPU runtime is dominated by BGE-M3 embedding, not online 4B labeling. The
launch corpus (`seeds-per-domain=512`, about 679k events before deltas) should
be generated with the parallel shard driver when the host has spare cores and
memory bandwidth. MemReranker-4B remains pinned for offline audit/reference
checks, but it is not in the corpus-generation hot path.

Validation:

```bash
node scripts/validate-retrieval-corpus.mjs \
  --corpus /var/lib/coretex/corpus-epoch-0.json \
  --min-events 650000 \
  --min-per-family 25000 \
  --min-hard-negatives 3 \
  --out /var/lib/coretex/reports/corpus-validation.json
```

Pass criteria:

- Capacity gate gives at least 6 no-repeat months at intended epoch cadence.
- Corpus validation has zero errors.
- All four families are present at launch scale.
- Hidden/canary splits are non-empty and masked through the data source.

## Phase 2 - Pinned Model Determinism And Calibration

Run model determinism on every CPU calibration host:

```bash
node scripts/determinism-check.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --pairs /var/lib/coretex/determinism-1k-pairs.json \
  --max-tolerance-ppm 250 \
  --report /var/lib/coretex/reports/determinism-host-$HOSTNAME.json
```

Aggregate:

```bash
node scripts/aggregate-determinism.mjs \
  --reports '/var/lib/coretex/reports/determinism-host-*.json' \
  --max-tolerance-ppm 250 \
  --out /var/lib/coretex/reports/determinism-aggregate.json
```

Calibrate:

```bash
node scripts/calibrate.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --calibration-corpus /var/lib/coretex/corpus-epoch-0.json \
  --determinism-aggregate /var/lib/coretex/reports/determinism-aggregate.json \
  --pack-size 128 \
  --min-improvement-ppm 2500 \
  --out /etc/coretex/bundle-profile.json
```

Build final bundle:

```bash
npm run build:bundle -- \
  --corpus /var/lib/coretex/corpus-epoch-0.json \
  --profile /etc/coretex/bundle-profile.json \
  --out /etc/coretex/bundle-manifest.json
```

Pass criteria:

- Model manifest revisions are immutable 40-hex revisions with per-file SHA-256.
- CPU-only runtime is enforced.
- `replayTolerancePpm < minImprovementPpm`.
- Hidden-pack quotas are derived from the actual launch corpus.
- `bundleHash` is recorded as `CORETEX_CORE_VERSION_HASH`.

## Phase 3 - Exhaustive Local And Fuzz Gates

```bash
cd /root/cortex
node --check scripts/generate-coretex-retrieval-corpus.mjs
node --check scripts/estimate-coretex-corpus-capacity.mjs
npm run build
npm run typecheck
npm run test:unit --workspace @botcoin/cortex

CORETEX_BUNDLE_MANIFEST=/etc/coretex/bundle-manifest.json \
CORETEX_CORPUS=/var/lib/coretex/corpus-epoch-0.json \
CORETEX_BIENCODER=pinned \
CORETEX_RERANKER=qwen3 \
CORTEX_REAL_EVAL=1 \
CORETEX_RERANKER_PRODUCTION=1 \
ITERATIONS=25 \
node test/e2e/phase-13/run.mjs \
  2>&1 | tee /var/lib/coretex/reports/phase13-real-reranker.log
```

Botcoin contract gates:

```bash
cd /root/botcoin
forge test -vvv
BASE_RPC_URL=$BASE_RPC_URL forge test --match-path test/CoreTexBaseFork.t.sol -vvv
```

Pass criteria:

- Typecheck and unit suites pass.
- Decoder property fuzz tests pass.
- Patch wire and reserved-bit tests pass.
- Phase 13 real-reranker e2e accepts real retrieval improvements and rejects
  the adversarial no-retrieval-improvement patch.
- Base fork tests pass against real mainnet state.

## Phase 4 - Coordinator Mount

Mount CoreTex exactly as described in
`docs/CORETEX_COORDINATOR_INTEGRATION_RUNBOOK.md`.

Startup must assert:

```bash
cast call --rpc-url "$BASE_RPC_URL" $CORTEX_STATE_ADDRESS \
  'getEpoch(uint64)(bool,bool,uint32,bytes32,bytes32,bytes32,bytes32,uint16,uint64,bytes32,uint32,bytes32,bytes32)' \
  $CORETEX_EPOCH_ID
```

The returned `corpusRoot`, `coreVersionHash`, `stateRoot`,
`minImprovementPpm`, and `evalSeedCommit` must match the local
`/etc/coretex/bundle-manifest.json`, `/var/lib/coretex/corpus-epoch-N.json`,
and coordinator epoch config.

Route smoke:

```bash
curl -fsS http://127.0.0.1:8080/coretex/health
curl -fsS http://127.0.0.1:8080/coretex/bundle/$CORETEX_BUNDLE_HASH
curl -fsS http://127.0.0.1:8080/coretex/substrate/current
curl -fsS http://127.0.0.1:8080/coretex/coverage-hints
```

Hidden split masking:

```bash
node scripts/validate-retrieval-corpus.mjs \
  --corpus /var/lib/coretex/corpus-epoch-0.json \
  --out /var/lib/coretex/reports/corpus-validation-post-mount.json
```

Then fetch representative hidden/canary records through the coordinator and
confirm they return hidden/restricted responses before reveal.

## Phase 5 - Daily V3 24-Hour Epoch Ritual

CoreTex rides the existing V3 24-hour epoch cycle. Reward distribution
and credit accumulation are unchanged: V4's `coretexCredits` accrue as
miners call `submitWorkReceipt` during the epoch, and at epoch end the
V4 reward lane distributes the CoreTex reward share pro-rata over those
credits — same shape as V3.

The CortexState contract just records four constants per V3 epoch:
`bundleHash` (= `coreVersionHash`), `corpusRoot`, `minImprovementPpm`,
and a fresh `evalSeedCommit`. The first three stay **identical across
most epochs** — they only change when ops publishes a new corpus delta
or a new bundle. The `evalSeedCommit` is fresh every epoch so the
hidden pack derives deterministically from a per-epoch seed that is
revealed at epoch close.

The launch transition is just the first 24h cycle in which
`bundleHash` is set to the production CoreTex bundle and `rewardLane`
is set to V4 (already done). After that, the same three on-chain calls
fire every 24h indefinitely, and the values are constant unless ops
deliberately bumps them.

Compute seed commitment (per-epoch):

```bash
openssl rand -hex 32 > /var/lib/coretex/eval-seed-epoch-$NEXT_CHAIN_EPOCH.secret
EVAL_SEED=0x$(cat /var/lib/coretex/eval-seed-epoch-$NEXT_CHAIN_EPOCH.secret)
EVAL_SEED_COMMIT=$(cast keccak "$EVAL_SEED")
```

Initialize and freeze:

```bash
CORPUS_ROOT=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/var/lib/coretex/corpus-epoch-0.json')).corpusRoot)")
BUNDLE_HASH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/etc/coretex/bundle-manifest.json')).bundleHash)")
STATE_ROOT=$(cast call --rpc-url "$BASE_RPC_URL" $CORTEX_STATE_ADDRESS \
  'getEpoch(uint64)(bool,bool,uint32,bytes32,bytes32,bytes32,bytes32,uint16,uint64,bytes32,uint32,bytes32,bytes32)' \
  $PRIOR_CORETEX_EPOCH | awk '{print $7}')

cast send --rpc-url "$BASE_RPC_URL" --private-key "$OWNER_PK" $CORTEX_STATE_ADDRESS \
  'initializeEpoch(uint64,uint32,bytes32,bytes32,bytes32,bytes32,uint16,bytes32,uint32,bytes32)' \
  $NEXT_CHAIN_EPOCH \
  192 \
  0xd5bc0e0ce151f289f9cc46a3852b2154816d741c4a0adc1cd33f5e974dbbb774 \
  $CORPUS_ROOT \
  $BUNDLE_HASH \
  $STATE_ROOT \
  1024 \
  $PARENT_CORPUS_ROOT \
  $MIN_IMPROVEMENT_PPM \
  $EVAL_SEED_COMMIT

cast send --rpc-url "$BASE_RPC_URL" --private-key "$OWNER_PK" $CORTEX_STATE_ADDRESS \
  'freezeEpoch(uint64)' $NEXT_CHAIN_EPOCH
```

Verify:

```bash
cast call --rpc-url "$BASE_RPC_URL" $CORTEX_STATE_ADDRESS \
  'getEpoch(uint64)(bool,bool,uint32,bytes32,bytes32,bytes32,bytes32,uint16,uint64,bytes32,uint32,bytes32,bytes32)' \
  $NEXT_CHAIN_EPOCH
```

At cycle close (24h later), reveal the seed before the V3 reward
finalization runs:

```bash
cast send --rpc-url "$BASE_RPC_URL" --private-key "$OWNER_PK" $CORTEX_STATE_ADDRESS \
  'revealEvalSeed(uint64,bytes32)' $CURRENT_CHAIN_EPOCH $EVAL_SEED
```

These three calls (`initializeEpoch` + `freezeEpoch` at start,
`revealEvalSeed` at end) are added to the coordinator's existing
24h V3 finalize cron — see `docs/CORETEX_COORDINATOR_QUICKSTART.md`
§4 for the wiring.

Pass criteria:

- The on-chain epoch pins the final `corpusRoot` and `bundleHash`.
- `rewardLane()` is `0x12ff0B47389AE6d6293d44991B0D6A27394494A4`.
- Epoch is frozen before any receipt is signed.

## Phase 6 - Real On-Chain State Change Canary

The canary uses the real coordinator, real pinned evaluator, real V4 address,
and real `submitWorkReceipt`.

Preflight:

```bash
cast call --rpc-url "$BASE_RPC_URL" $BOTCOIN_MINING_V4_ADDRESS 'currentEpoch()(uint64)'
cast call --rpc-url "$BASE_RPC_URL" $BOTCOIN_MINING_V4_ADDRESS 'stakeSource()(address)'
cast call --rpc-url "$BASE_RPC_URL" $BOTCOIN_MINING_V4_ADDRESS 'cortexState()(address)'
cast call --rpc-url "$BASE_RPC_URL" $CORTEX_STATE_ADDRESS 'rewardLane()(address)'
```

Run a single miner canary through coordinator HTTP:

```bash
curl -fsS -X POST http://127.0.0.1:8080/coretex/screen \
  -H "content-type: application/json" \
  -H "authorization: Bearer $CORETEX_OPERATOR_TOKEN" \
  --data @/var/lib/coretex/canary/screen-request.json \
  | tee /var/lib/coretex/reports/mainnet-canary-screen.json

curl -fsS -X POST http://127.0.0.1:8080/coretex/evaluate \
  -H "content-type: application/json" \
  -H "authorization: Bearer $CORETEX_OPERATOR_TOKEN" \
  --data @/var/lib/coretex/canary/evaluate-request.json \
  | tee /var/lib/coretex/reports/mainnet-canary-evaluate.json
```

Submit the signed receipt returned by `/coretex/evaluate` using the miner key:

```bash
cast send --rpc-url "$BASE_RPC_URL" --private-key "$MINER_PK" \
  $BOTCOIN_MINING_V4_ADDRESS \
  'submitWorkReceipt(uint64,uint64,bytes32,uint8,uint8,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint128,uint32,bytes32,uint256,uint16,uint32,uint32,uint64,uint64,bytes,bytes)' \
  $EPOCH_ID \
  $SOLVE_INDEX \
  $PREV_RECEIPT_HASH \
  2 \
  2 \
  $CHALLENGE_ID \
  $PARENT_STATE_ROOT \
  $NEW_STATE_ROOT \
  $CORPUS_ROOT \
  $BUNDLE_HASH \
  $EVAL_REPORT_HASH \
  $PATCH_HASH \
  $ARTIFACT_HASH \
  $WORLD_SEED \
  192 \
  0xd5bc0e0ce151f289f9cc46a3852b2154816d741c4a0adc1cd33f5e974dbbb774 \
  $WORK_UNITS_BPS \
  1024 \
  $SCORE_BEFORE_PPM \
  $SCORE_AFTER_PPM \
  $ISSUED_AT \
  $EXPIRES_AT \
  $COMPACT_PATCH_BYTES \
  $SIGNATURE \
  | tee /var/lib/coretex/reports/mainnet-canary-submit.txt
```

Verify state change:

```bash
cast logs --rpc-url "$BASE_RPC_URL" \
  --address $BOTCOIN_MINING_V4_ADDRESS \
  'CoretexPatchBytes(uint64,address,bytes32,bytes32,bytes)'

cast logs --rpc-url "$BASE_RPC_URL" \
  --address $CORTEX_STATE_ADDRESS \
  'CortexStateAdvanced(uint64,uint64,bytes32,bytes32,bytes32,bytes32,uint16)'

cast call --rpc-url "$BASE_RPC_URL" $CORTEX_STATE_ADDRESS \
  'getEpoch(uint64)(bool,bool,uint32,bytes32,bytes32,bytes32,bytes32,uint16,uint64,bytes32,uint32,bytes32,bytes32)' \
  $EPOCH_ID
```

Pass criteria:

- `CortexStateAdvanced` appears on Base mainnet.
- The new on-chain state root equals the coordinator eval report.
- `coretexCredits(epoch, miner)` increases.
- Replay watcher reproduces the transition from emitted patch bytes.

## Phase 7 - Replay Watchers And Independent Verification

Start canonical watcher:

```bash
coretex-replay watch \
  --rpc "$BASE_RPC_URL" \
  --v4 $BOTCOIN_MINING_V4_ADDRESS \
  --cortex-state $CORTEX_STATE_ADDRESS \
  --from-block $CORETEX_DEPLOY_BLOCK \
  --parent-state /var/lib/coretex/packed-genesis-state.bin \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --expected-bundle-hash $CORETEX_BUNDLE_HASH
```

Independent verifier from fresh clone:

```bash
mkdir -p /tmp/coretex-verifier
cd /tmp/coretex-verifier
git clone https://github.com/botcoinmoney/cortex.git
cd cortex
npm ci
npm run build
curl -fsS $COORDINATOR_URL/coretex/bundle/$CORETEX_BUNDLE_HASH \
  -o /tmp/coretex-verifier/bundle-manifest.json
curl -fsS $COORDINATOR_URL/coretex/corpus-delta/$EPOCH_ID \
  -o /tmp/coretex-verifier/corpus-delta.json
coretex-replay watch \
  --rpc "$BASE_RPC_URL" \
  --v4 $BOTCOIN_MINING_V4_ADDRESS \
  --cortex-state $CORTEX_STATE_ADDRESS \
  --from-block $CORETEX_DEPLOY_BLOCK \
  --parent-state /var/lib/coretex/packed-genesis-state.bin \
  --bundle-manifest /tmp/coretex-verifier/bundle-manifest.json \
  --expected-bundle-hash $CORETEX_BUNDLE_HASH \
  --once
```

Pass criteria:

- Fresh clone verifies the same bundle hash.
- Replay is deterministic against Base logs.
- Any mismatch pauses coordinator signing and opens a blocker in the handoff.

## Phase 8 - Corpus Expansion And Difficulty Ratchet

Every epoch appends corpus records and raises/lower-bounds difficulty according
to observed advances and quality attempts.

Corpus delta:

```bash
CORETEX_CORPUS_PRODUCTION=1 \
CORETEX_BIENCODER=pinned \
node scripts/generate-coretex-retrieval-corpus.mjs \
  --source challenge-library \
  --challenge-lib-root $CORETEX_CHALLENGE_LIB_ROOT \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --previous-corpus /var/lib/coretex/corpus-epoch-N.json \
  --seed-offset $NEXT_SEED_OFFSET \
  --seeds-per-domain 16 \
  --modifier-counts 0,1,2,3 \
  --constraint-difficulties easy,medium,hard \
  --trap-count 2 \
  --corpus-epoch $CORPUS_EPOCH \
  --epoch $NEXT_CHAIN_EPOCH \
  --out /var/lib/coretex/corpus-epoch-N-plus-1.json \
  --delta-out /var/lib/coretex/deltas/corpus-delta-N-plus-1.json
```

Difficulty:

```bash
node -e "
  const { nextMinImprovementPpm } = require('./packages/cortex/dist/rewards/difficulty.js');
  console.log(nextMinImprovementPpm({
    currentMinImprovementPpm: Number(process.env.CURRENT_MIN_IMPROVEMENT_PPM),
    observedAdvances: Number(process.env.OBSERVED_ADVANCES),
    targetAdvances: Number(process.env.TARGET_ADVANCES),
    qualityAttempts: Number(process.env.QUALITY_ATTEMPTS)
  }));
"
```

Pass criteria:

- Delta validates and applies over the prior corpus root.
- Next epoch manifest binds next corpus root and next difficulty.
- Capacity gate still passes after consumption accounting.
- Hidden-pack quotas remain satisfiable after each delta.

## Phase 9 - Final Audit Artifacts

Write:

```
/var/lib/coretex/reports/final-launch-audit.json
/var/lib/coretex/reports/final-launch-summary.md
/root/cortex/docs/CORETEX_FRONTIER_RETRIEVAL_EXECUTION_HANDOFF.md
/root/cortex/docs/CORETEX_MAINNET_LAUNCH_CHECKLIST.md
```

Final summary must include:

- Git commit hash and pushed remote hash.
- Bundle hash / coreVersionHash.
- Corpus root and event counts.
- Capacity estimate.
- Determinism aggregate.
- Calibration profile.
- Phase 13 real-reranker log path.
- Base fork tx/log evidence.
- Mainnet canary tx hash.
- Replay watcher result.
- Coordinator endpoint health.
- Any audit notes from `/root/cortex/ongoing_audit.md`.

Then:

```bash
cd /root/cortex
git status --short
git add docs scripts packages test specs
git commit -m "coretex: finalize production e2e audit runbook"
git push origin main
```

## Stop Conditions

The orchestrator stops only when every pass criterion above is satisfied and
the final commit is pushed.

Non-final states are not acceptable launch conclusions:

- "local tests pass but real reranker not run" is not complete.
- "real reranker smoke passed but no state advance" is not complete.
- "state advanced locally but no Base fork/mainnet canary" is not complete.
- "coordinator routes exist but startup binding/replay watcher missing" is not
  complete.
- "corpus exists but capacity/delta/difficulty gates not proven" is not
  complete.
- "bundle exists but independent fresh-clone replay not proven" is not
  complete.
