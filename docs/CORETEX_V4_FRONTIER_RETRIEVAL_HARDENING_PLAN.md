# CoreTex Frontier Memory Retrieval — Production Hardening Plan

Last updated: 2026-05-10.

This is the canonical design plan for CoreTex's production launch. It is not an upgrade plan. There is no live CoreTex production system to migrate from. The substrate primitives (1024-word state body, compact 1–4 word patches, EIP-712 receipts, replay client, bundle manifest, corpus/delta utilities, coordinator route shim) exist as reusable libraries from prior local hardening work — they are correct and stay. Any code or doc artifact describing a "structural commitment" or "slot-fill" reward law is stale and is removed before launch, not preserved as a historical profile.

Operational counterparts:

- `docs/CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md` — controlling
  end-to-end launch orchestration (calibration host through Base mainnet
  canary and independent replay).
- `docs/CORETEX_PRODUCTION_RUNBOOK.md` — operational reference for deploy,
  replay-watcher topology, escrow, retention, rate-limit envelope, kill
  switches, and bundle rotation.
- `docs/CORETEX_MAINNET_LAUNCH_CHECKLIST.md` — per-step launch gate.

## Non-Negotiable Goal

CoreTex's reward law measures real improvements to a compact on-chain memory retrieval substrate, scored by accepted IR metrics over hidden benchmark queries:

- Given hidden queries drawn from a graded-relevance benchmark, does the substrate's compact index retrieve answer-bearing memories?
- Does it rank them well under `nDCG@10`, `MRR@10`, `Recall@k`?
- Does it correctly suppress stale temporal facts when current ones exist?
- Does it support multi-hop relation traversal to answer-bearing memories?
- Does it abstain (return nothing) when no relevant memory exists?
- Does a candidate patch improve these metrics over the parent substrate by at least the epoch difficulty threshold, reproducibly under the pinned bundle?

Anything less than this is not the production reward law and does not ship.

## Scope of Reuse vs Removal

Reused as production code (no rework):

- `CortexState` and `BotcoinMiningV4` Solidity contracts.
- The 1024-word substrate body, the 1–4 word compact patch wire, the `acceptTransition` mutation invariant, the `evalSeedCommit`/`evalSeed` commit-reveal primitive, EIP-712 work receipts.
- The `replayV4TransitionsFromLogs` client and the `coretex-replay` CLI.
- The bundle manifest framework: deterministic canonical-JSON hashing, file SHA-256 binding, snapshot pinning, model-revision pinning rejection of `'main'`.
- The corpus/delta utility layer: cross-miner distractor mining, `admitCorpusBatch` policy, `buildCorpusDelta`/`applyCorpusDelta` with hash continuity. Existing DACR bridge code is reusable only if it survives the source-data audit below; it is not assumed to be the canonical production bridge.
- The coordinator HTTP route shim (`handleCoreTexCoordinatorRoute`), per-miner JWT auth via the existing V3 HMAC, per-miner + global rate limiter, `assertBundleBindingAtStartup`.
- The plan §7 difficulty calculator skeleton (`nextMinImprovementPpm` with bounded ramp/decay) — applied to retrieval deltas, not slot deltas.

Removed before launch (these are stale code paths, not features):

- `eval/corpus.ts:scoreProductionState` and `eval/corpus.ts:eventIdToKey128` / `eventIdToMem128`. The structural-commitment scorer in any form. Salting it with an epoch seed does not redeem it; the entire scorer is replaced.
- `eval/reranker-eval.ts:evaluateStateWithReranker` and `evaluatePatchWithReranker` in their current shape. They scored "is the reranker confident on documents whose ids the substrate already structurally selected" — that's the wrong loop. They are replaced by a retrieval scorer that scores "given a hidden query, what does the substrate retrieve, and is it answer-bearing."
- `bundle/index.ts:DEFAULT_PROFILE` with legacy structural family weights. Replaced by `primaryMetric: 'ndcg@10'` and a retrieval-dominant composite (specific weights calibrated; see below).
- `eval/corpus.ts:ProductionCorpusEvent` field set, where it carries fields that only made sense for the structural scorer (`expectedStateRegions`, `noveltyBucket`-as-decoration, `hardnessSignal` as currently computed). Replaced by graded-qrel record fields tied to the retrieval task.
- The `substrate/slot-policy.ts` "active count" semantics. Slot occupancy is not a metric in production; it is a substrate state.

Documentation artifacts that describe the legacy slot-fill scorer are deleted or rewritten before launch. They describe a design that is not shipping.

## Pinned Models

The bi-encoder and cross-encoder are model-level commitments. Both bind into the bundle manifest with revision + per-file SHA-256 + tokenizer pin + named runtime + named quantization.

**Bi-encoder for candidate retrieval** — `BAAI/bge-m3` (dense mode). This is the model the MemReranker paper uses for candidate generation (BGE-M3 Top-100 for LOCOMO; Top-50 for LongMemEval). Multilingual, 568M parameters, runnable on multi-core CPU. The bundle manifest pins:

- `provider: huggingface`
- `modelId: BAAI/bge-m3`
- `revision: <pinned commit, set during calibration phase>`
- `mode: dense` (single dense vector per input)
- `outputDim: <calibrated to fit substrate slot budget — see §Calibration>`
- `tokenizerRevision: <pinned commit>`
- `runtime: <named runtime + version, see Determinism>`
- `quantization: <named quantization scheme, see Determinism>`
- per-file SHA-256 covers config, tokenizer, weights

**Cross-encoder reranker** — the orchestrator discovers, pins, and validates the strongest available memory-retrieval reranker before launch. The launch candidate set is:

- `Qwen/Qwen3-Reranker-0.6B`
- MemReranker-0.6B if a public artifact exists and can be pinned with per-file hashes
- MemReranker-4B or another stronger memory reranker for labeling/calibration if a public artifact exists and can be pinned

The selected production reranker and labeling reranker are recorded in the bundle manifest with model id, revision, file hashes, runtime, quantization, and calibration outputs. When a candidate model fails pinning or deterministic CPU execution, the orchestrator selects the next strongest candidate and records the failed candidate in `docs/CORETEX_MODEL_SELECTION_AUDIT.md`; the work continues until a pinned deterministic launch pair exists.

The bundle manifest pins both models. A bundle whose `bundleHash` does not match the on-chain `coreVersionHash` for the current epoch refuses replay and refuses startup at the coordinator.

### Determinism

The reward signal must be reproducible by anyone running the pinned bundle. fp16 inference and CUDA/MPS kernels are not bitwise reproducible across hardware. Production therefore commits to:

- **CPU-only inference** for both bi-encoder and reranker on the canonical scoring path (coordinator and watchers).
- A **named runtime** with a pinned major.minor (e.g., `transformers==X.Y.*` plus `torch==A.B.* (CPU-only build)`, OR `onnxruntime==C.D.* (CPU)` — chosen during the calibration phase based on which path produces tightest cross-host agreement). The runtime version + build flags bind into the bundle manifest.
- A **named quantization scheme** for the bi-encoder. Either:
  - int8 weight quantization with fp32 accumulation (deterministic across CPUs that follow IEEE 754), or
  - bfloat16 with explicit denormal-flush flags,
  with the choice locked during calibration based on observed cross-host score spread.

The combined runtime + quantization choice produces a single number — `replayTolerancePpm` — pinned in the bundle profile. Replay watchers alarm when their recomputed `nDCG@10` differs from the coordinator's signed `scoreAfterPpm` by more than this tolerance. The tolerance value is a calibration output (see §Calibration), not a hardcoded guess.

GPU/accelerated inference is not allowed on the canonical scoring path. Coordinators and watchers running on GPU produce non-canonical scores that disagree with the chain. The bundle profile carries an explicit `acceleratorPolicy: 'cpu_only'` flag and the coordinator's startup assertion refuses to run if `process.env.CORETEX_USE_GPU` or equivalent is set.

## Substrate Semantics

The substrate is a 1024 uint256 word body. Word ranges are unchanged from the existing contract (the Solidity does not need to know what bytes mean). What changes is the off-chain interpretation, which is what the production scorer reads.

`MemoryIndex` (words 32..383, 44 slots × 8 words each):
- Each slot stores a memory record pointer: corpus record id (low 128 bits), family/domain bits, temporal-validity flags (current/stale), protection flag, expiry epoch, and a pointer (slot index) into `RetrievalKeys` for the dense vector.
- A slot with non-zero record id and the `valid` flag is "active." A slot with `valid` and `revoked` flags is "revoked" (used for stale-truth records).
- Decoder: deterministic mapping from packed words to `{recordId, familyBits, temporalFlags, retrievalSlot, expiryEpoch}`. Decode failures (reserved bits set, invalid pointer) zero the slot during scoring; the patch was structurally invalid and earns nothing.

`RetrievalKeys` (words 384..671, 36 slots × 8 words each, 256 bytes/slot):
- Each slot stores a compact dense retrieval vector + small header.
- Dense vector layout = `<calibrated_dim> × <calibrated_quantization>` chosen during calibration to fit within `256 - headerBytes`. Layout is bound into the bundle manifest as `retrievalKeyLayout: { dim: int, quantization: string, headerBytes: int }`.
- Header carries: bi-encoder model identifier (4-byte hash of `(modelId, revision, mode)`), the embedding's L2 norm (for cosine reconstruction), a 1-byte version tag.
- Decoder: deterministic dequantization from packed words to a `{vector: float[dim], norm: float, modelId: bytes32}`. Failure modes (header model id mismatch, vector norm zero, reserved bits set) zero the slot.

`Relations` (words 672..799, 128 words):
- Each word stores a typed edge: `(sourceMemorySlot, targetMemorySlot, edgeType, weight)` packed into 256 bits.
- Edge types: `supports`, `supersedes`, `coreference_of`, `causes`, `derived_from`, `co_occurs_with`. Pinned in the bundle's `relationEdgeTypes`.
- Decoder maps the 128 word body to a directed labeled graph over the active `MemoryIndex` slots.

`Temporal` (words 800..895, 96 words, 12 records × 8 words):
- Each record stores a temporal interval: `(memorySlot, validFromEpoch, validUntilEpoch, supersededBy_memorySlot, currentStaleFlag)`.
- Decoder validates against `MemoryIndex` consistency (a temporal record referencing an inactive memory slot is malformed and zeroed during scoring).

`Codebook` (words 896..991, 48 slots × 2 words):
- Stores the active codebook entries used by the bi-encoder's quantization scheme (e.g., int8 scale/zero-point per dim group, or PQ codeword references).
- Decoded codebook + `RetrievalKeys` together produce the float vectors used for similarity. Codebook contents must be consistent with the bi-encoder's pinned quantization config; mismatch zeroes the slot.

Reserved (words 992..1023): unchanged from current; substrate writes are forbidden by the contract.

Header (words 0..31): unchanged from current; carries epoch metadata, version flags, and the corpus root binding for the active substrate snapshot.

## Corpus Shape

The corpus is a graded-relevance retrieval benchmark, not an event ledger.

Each admitted corpus record carries:

- `id`: stable identifier across deltas
- `family`: `near_collision | temporal | long_horizon | multi_hop_relation` (extensible)
- `domain`: from the coordinator source challenge domain (`companies`, `quantum_physics`, `computational_biology`, `scrna_imputation`, ...), if the domain survives source-data suitability checks
- `split`: `train_visible` | `calibration` | `eval_hidden` | `canary`
- `queryText`: the question
- `truthDocuments`: array of answer-bearing document texts (each independently retrievable; multi-target supported)
- `hardNegatives`: array of distractor document texts
- `qrels`: per-document graded relevance labels in the 5-level scale `{0.0, 0.2, 0.4, 0.6, 0.8, 1.0}` (paper's scale: irrelevant → low → partial → highly relevant → direct answer)
- `temporal`: optional `{validFromEpoch, validUntilEpoch, supersedes_id?, superseded_by_id?, currentStaleFlag}` for temporal records
- `relations`: optional array of `(other_id, edgeType)` for relation records
- `provenance`: source ref (`dataset/v2` S3 key, challenge seed, challenge id, attempt/session/pair id, question id, and source hash)
- `embeddings`: bytes — pinned bi-encoder query embedding + per-document embeddings, in the bundle's pinned quantization layout

`embeddings` is the production load-bearing field. Replay watchers require it to recompute scores deterministically.

### Graded qrel labeling

Graded labels are produced by the corpus-build pipeline at delta time, not by the live coordinator at scoring time. The labeling source is a separate **labeling pinned model** (commit reveal: a stronger reranker than the production reranker, run once per delta over `(query, candidate_document)` pairs, output binned to the 5-level scale). The labeling model is bound into the bundle manifest's `labelingModel` field (revision + per-file SHA-256 + runtime + quantization). Labels are deterministic, replayable, and audit-checkable.

The labeling model is NOT the production reranker. Using the same model for labeling and scoring is circular. The labeling model is the strongest separately pinned reranker selected by the model-selection audit. This is the methodology MemReranker uses; CoreTex follows it.

### Splits

`splitForRecord(id, corpusEpoch)` is a deterministic function returning `{train_visible, calibration, eval_hidden, canary}`. Split assignment is stable across corpus deltas (same id → same split forever). Split ratios (e.g., 70/10/15/5) are pinned in the bundle profile after the calibration phase determines what gives stable per-family eval sample sizes.

`canary` records are a small subset (size pinned at calibration time) with publicly-known qrels — used for end-to-end replay verification and watchdog alarms when scoring code drifts.

`eval_hidden` records are not exposed to miners through any API. Coordinator endpoints serving the corpus mask `eval_hidden` rows. Miners learn the eval distribution only after epoch close + seed reveal.

### Embedding payloads in CorpusDelta

`CorpusDelta` (existing primitive) extends to carry embedding bytes. Schema:

```
CorpusDelta {
  previousRoot: bytes32
  nextRoot: bytes32
  addedRecordIds: string[]
  removedRecordIds: string[]
  recordPayloads: Map<id, ProductionCorpusEvent>
  embeddingPayloads: Map<id, BiEncoderEmbedding>
  labelingProvenance: { modelId, revision, runtime, batchHash }
  epoch: uint64
  generatedAt: ISO8601
  signature: bytes  // operator signature over canonical-JSON of all above
}
```

Delta hashing covers all fields including embedding bytes. Delta application asserts hash continuity (`previousRoot == corpus.corpusRoot`), recomputes `nextRoot` deterministically, and verifies the operator signature.

## Hidden Query Pack

At epoch initialization the coordinator commits to `evalSeedCommit = keccak256(evalSeed)` on chain. The seed is a 32-byte secret held by the coordinator until epoch close. From the seed and the post-delta corpus root, the eval query pack is deterministically derived:

```
queryPack(epoch, evalSeed, corpus) = sortedEvalHidden(corpus)[
  uint256(keccak256(evalSeed || epoch || i)) mod len(sortedEvalHidden)
  for i in range(K)
]
```

`sortedEvalHidden(corpus)` is the lex-sorted-by-id list of `eval_hidden` records in the corpus at epoch start (well-defined, identical for everyone with the bundle). `K` is the pack size, **calibrated**, but the formula is fixed.

Hardness stratification: the sampling rule selects `K` records, then the post-sample pack is required to satisfy minimum per-family and minimum per-difficulty-bucket quotas. If the random sample violates a quota, the rule deterministically fills from the underrepresented stratum (algorithm fixed; underrepresented strata draw additional records by `keccak256(evalSeed || epoch || family || j)` until quotas are met). Quotas pinned in bundle profile after calibration.

Adversarial seed selection is prevented by the rule being public and deterministic — anyone with the seed and the bundle can reproduce the pack and check it satisfies quotas. The coordinator gains no degree of freedom from the seed beyond a uniform random sample.

### Seed safekeeping

The coordinator must hold the preimage from epoch init through epoch close. Loss of preimage strands the epoch as un-replayable. Production requires:

- Seed preimage stored in a multisig-controlled secret manager at commit time. The seed's commit transaction includes an off-chain signed escrow receipt naming the multisig signers.
- Reveal at epoch close is an on-chain `revealEvalSeed(epochId, seed)` call by the coordinator; the contract's existing `evalSeed != bytes32(0)` check + `keccak256(seed) == evalSeedCommit` check enforce correctness.
- A seed-disclosure-by-deadline rule: if the epoch closes and the seed is not revealed within `revealGracePeriod` (pinned at calibration), the multisig escrow holders are obligated to publish the seed. After that deadline, replay watchers alarm and the operator playbook is triggered.

### Coordinator-trust window

Between epoch init and seed reveal, only the coordinator can compute scores (because only it knows the seed → only it can derive the pack → only it can run the reranker over the pack and sign receipts with `scoreAfterPpm`). This is a known commit-reveal property. Mitigation:

- Watchers monitor `WorkCreditAccepted` event volume per epoch and per miner. Anomalous concentrations trigger pre-reveal alarms.
- The escrow rule above guarantees worst-case disclosure deadline.
- After reveal, every signed score is independently recomputable by any watcher with the bundle, the corpus + delta history, and the revealed seed.

## Reward Law

`primaryMetric: nDCG@10` over the per-epoch hidden query pack.

The composite weighting is locked to the following structure (specific values are calibration outputs; the structure does not change):

```
composite = w_retrieval        * nDCG@10
          + w_temporal          * temporalCurrentStaleAccuracy
          + w_relation_recall   * multiHopRelationRecall@10
          + w_abstention        * abstentionAccuracy
          + w_structural_sanity * structuralValidity
```

Constraints on the weights:

- `w_retrieval >= 0.70` — retrieval dominates by structure.
- `w_retrieval + w_temporal + w_relation_recall + w_abstention + w_structural_sanity == 1.0` — by construction.
- `w_structural_sanity <= 0.10` — structural validity is a sanity gate, not a reward.
- `w_temporal > 0`, `w_relation_recall > 0`, `w_abstention > 0` — every non-retrieval signal carries non-zero weight so families remain incentivized.

Concrete values are determined during the calibration phase with a target distribution of approximately `w_retrieval ∈ [0.70, 0.80]`. The final values land in the bundle profile and bind via `bundleHash`.

### Sub-metric definitions

**`nDCG@10`** — exponential gain (`gain = 2^relevance - 1`), standard log2 discount, normalized by ideal DCG given the qrels for the query. Per-query, then averaged across the pack.

**`temporalCurrentStaleAccuracy`** — for queries with a temporal current/stale dichotomy in qrels, fraction of queries where the top-1 reranked candidate has the `current` label and no top-3 candidate has the `stale` label.

**`multiHopRelationRecall@10`** — for queries flagged multi-hop in qrels, fraction of queries where the answer-bearing memory is reachable from the top-10 candidates via the substrate's `Relations` graph within `relationHopBudget` (calibrated, typically 2–3) hops.

**`abstentionAccuracy`** — for queries with no answer in the corpus (intentionally inserted negatives), fraction where the top-1 reranked score is below `abstentionThreshold` (calibrated). Penalizes substrates that hallucinate retrievals from negative queries.

**`structuralValidity`** — boolean-clamped to [0,1]: 1.0 if the substrate decodes without errors (no reserved-bit violations, all memory pointers resolve to valid slots, all retrieval-key headers reference the pinned bi-encoder, codebook is consistent, relation graph references valid slots); fractional otherwise based on count of decode failures.

### Patch acceptance

A patch is accepted by the coordinator if and only if:

- The patch wire bytes pass `_validateCompactPatch` on chain (already enforced by V4 contract).
- The candidate substrate (parent + patch) decodes without `structuralValidity < structuralFloor` (calibrated).
- `composite(candidate) - composite(parent) >= epoch.minImprovementPpm / 1e6`.
- No protected-regression veto: for any record with `protected: true` in the corpus, its per-record nDCG drop from parent to candidate must not exceed `protectedRegressionFloor` (calibrated).
- No family-level catastrophic regression: per-family nDCG@10 in the candidate must not drop below `familyCatastrophicFloor * familyNdcgInParent` (calibrated, conservative; e.g., parent 0.6 × floor 0.85 = candidate must stay above 0.51).
- Score reproducible: the coordinator's scoring run is deterministic in the canonical CPU-only runtime; replay watchers confirm within `replayTolerancePpm` after seed reveal.

A receipt accepted by the coordinator triggers EIP-712 signing with `scoreAfterPpm = round(composite(candidate) * 1e6)` and `scoreBeforePpm = round(composite(parent) * 1e6)`.

## Difficulty

The plan §7 difficulty calculator (`nextMinImprovementPpm`) operates on retrieval deltas. Inputs at epoch close:

- `observedAdvances`: count of `OUTCOME_CORETEX_STATE_ADVANCE` receipts in the closing epoch.
- `qualityAttempts`: count of elevated patches the coordinator scored that produced a positive but sub-threshold delta — the coordinator-side ledger captures these.
- `replayNoiseMedianPpm` and `replayNoiseP90Ppm`: empirical distributions of `|coordinatorScore - watcherScore|` measured by a calibration sample of receipts in the closing epoch.

Output: `nextMinImprovementPpm`, clamped to `[MIN_IMPROVEMENT_PPM, MAX_IMPROVEMENT_PPM]`. The minimum is at least `replayNoiseP90Ppm` to ensure deltas are signal, not noise.

Difficulty levers (only tightened by raising `minImprovementPpm`, never by changing what counts as an advance):

- Raised `minImprovementPpm` floor as observed advances exceed target.
- Larger pack `K`.
- Hardness-stratified pack with higher distractor density.
- Tighter `protectedRegressionFloor`.
- Tighter `familyCatastrophicFloor`.

Lever values are calibration outputs and bind into bundle/profile per epoch.

## Miner Workflow

**Miners are not required to run CoreTex.** A miner runs as much or as little of the off-chain stack as they choose. The minimum workflow uses only on-chain reads and the coordinator's public REST API.

What the miner sees:

- On-chain: `cortexState.getEpoch(epochId)` returns `(parentStateRoot, corpusRoot, coreVersionHash, minImprovementPpm, evalSeedCommit, ...)`. `BotcoinMiningV4` events stream `CoretexPatchBytes` and `CortexStateAdvanced` for the prior epoch's accepted advances.
- Coordinator API:
  - `GET /coretex/substrate/current` → packed 32 KB substrate body for the current state root.
  - `GET /coretex/substrate/:stateRoot` → historical bodies.
  - `GET /coretex/corpus/:recordId` → record metadata (query text, family, domain, hardness signal, public qrels for `train_visible` records). Hides `truthDocuments`, `hardNegatives`, and `qrels` for `eval_hidden` and `canary` rows.
  - `GET /coretex/corpus/:recordId/embedding` → the pinned bi-encoder embedding for the record (in the bundle's quantization). For `train_visible` rows it returns the precomputed bytes. For `eval_hidden`, returns 404 until epoch close + reveal.
  - `GET /coretex/bundle/:bundleHash` → the full pinned bundle manifest (read-only). Required for any miner who wants to verify their own patch off-line.
  - `GET /coretex/challenge-book/:epoch` → published per-epoch challenge book covering the visible split.
  - `POST /coretex/screen` → submit a candidate patch for cheap structural screening (returns pass/fail + earns base credits if the screener accepts; never advances state).
  - `POST /coretex/evaluate` → submit a candidate patch for full retrieval evaluation. The coordinator runs the bi-encoder + reranker + composite scorer, returns `(scoreBeforePpm, scoreAfterPpm, deltaPpm, perMetricBreakdown)` and, if the delta clears `minImprovementPpm` and all veto checks pass, returns a signed `WorkReceipt` the miner can submit to the V4 contract.

A miner's optimal strategy without any local model:

1. Read the current packed substrate via `/coretex/substrate/current` and decode active slots (decoder is a small library, no model required).
2. Inspect the visible split to identify which `train_visible` queries the substrate currently answers poorly. Heuristic: queries whose answer-bearing record is not pointed-to by any active `MemoryIndex` slot, or whose pointed-to slot's vector L2-distance from the query vector is large. The coordinator can precompute this and serve it via an optional `GET /coretex/coverage-hints` endpoint as a convenience.
3. Choose a target `eval_hidden`-adjacent improvement: a candidate corpus record (visible) the miner believes is also helpful for the hidden split's distribution. The miner is betting on generalization.
4. Construct a patch:
   - Pick a target `RetrievalKeys` slot (an empty one or one carrying a low-value vector).
   - Fetch the candidate record's precomputed embedding via `/coretex/corpus/:id/embedding`. Bytes copy directly into the patch; no local inference.
   - Fetch the matching `MemoryIndex` slot bytes (record id, family bits, retrieval-slot pointer to the chosen RetrievalKey).
   - Encode as a 1–4 word compact patch.
5. Submit to `POST /coretex/screen` first (cheap pre-validation); if that passes, submit to `POST /coretex/evaluate`. If the coordinator returns a signed receipt, broadcast it to the V4 contract.

A miner who wants more leverage can:

- Run the bundled bi-encoder locally to compute candidate embeddings for records they have local guesses about (uncommon — most records' embeddings are precomputed in the bundle).
- Run their own retrieval simulation on the substrate to predict the coordinator's scoring outcome before submitting.
- Run a private replay watcher on prior epochs to validate the coordinator is honest before trusting it with new submissions.

None of this is required. The patch wire is just bytes; the bytes the miner submits come from the coordinator's API or the published bundle. CoreTex never asks a miner to run a 0.6B model.

The screener path is rate-limited per-miner; the evaluate path is rate-limited per-miner and globally to protect the coordinator's CPU budget.

## Calibration Phase

Several values in this plan are calibration outputs, not design decisions. They are determined empirically during the development/testing process and pinned into the bundle profile before mainnet launch. Once pinned they bind via `bundleHash`.

The calibration process is itself part of the plan. It runs against:

- A held-out internal calibration corpus subset (separate from `eval_hidden`).
- A multi-host CPU rig (≥3 hardware configurations) to measure cross-host score spread.
- The pinned models at their pinned revisions.

Outputs (all bind into bundle profile or bundle manifest):

| Value | Determined by |
|---|---|
| Bi-encoder revision pin | Most recent stable BGE-M3 commit at calibration time |
| Bi-encoder output dim | Smallest dim that produces nDCG@10 within 2% of full 1024-dim baseline on the calibration set |
| Bi-encoder quantization scheme | Choice between int8/bfloat16 that minimizes `replayTolerancePpm` while staying within slot byte budget |
| Reranker revision pin | Strongest deterministic 0.6B-class memory/retrieval reranker selected by the model-selection audit |
| Runtime version pins (transformers/torch or onnxruntime) | The pair with smallest cross-host disagreement on a 1k (query, doc) pair sample |
| `replayTolerancePpm` | P99 of `|coordinator_score - watcher_score|` across the cross-host calibration sweep, rounded up |
| Hidden pack size `K` | Smallest `K` that gives stable per-family per-difficulty subgroup statistics (target σ < 0.02 nDCG points per family on bootstrap resamples) |
| Reranker top-k | Smallest `k` such that recall@k of answer-bearing docs from the bi-encoder candidate set exceeds 0.95 on the calibration corpus |
| Reranker score → graded qrel mapping | Fit on the labeling-model ground truth; isotonic regression or 5-bin quantile mapping (chosen empirically) |
| `abstentionThreshold` | Reranker score below which abstention is correct on calibration negatives |
| Composite weights `w_retrieval, w_temporal, w_relation_recall, w_abstention, w_structural_sanity` | Constrained optimization on the calibration set: maximize MemReranker-style hard-case discrimination subject to `w_retrieval >= 0.70` and weights sum to 1.0 |
| `structuralFloor` | The decode-quality fraction below which the substrate is considered malformed; calibrated to reject obvious garbage but tolerate intentional patch noise |
| `protectedRegressionFloor` | Calibrated against typical patch noise: floor must be larger than measured per-record nDCG variance under no-op patches |
| `familyCatastrophicFloor` | Conservative; calibrated to ensure no single accepted patch can collapse a family's nDCG by more than `1 - familyCatastrophicFloor` |
| `relationHopBudget` | Calibrated on multi-hop family records; smallest hop budget under which the multi-hop sub-metric correlates with end-task answerability |
| Split ratios `train_visible/calibration/eval_hidden/canary` | Calibrated for stable per-epoch eval samples and audit canary coverage |
| Hardness-stratification quotas in pack sampling | Calibrated to match the corpus's empirical hardness distribution |
| Patches-per-epoch target (used for difficulty calc) | Calibrated against observed coordinator scoring throughput in the production-CPU envelope |
| Coordinator throughput envelope | Empirical: `(K, top-k, runtime, hardware)` → average score-and-sign latency; pinned to set realistic `targetAdvances` |
| `minImprovementPpm` initial floor | At least `replayTolerancePpm`; pinned ≥ that |
| `MIN_IMPROVEMENT_PPM` and `MAX_IMPROVEMENT_PPM` bounds | The contract already pins these; the calibration phase confirms `replayTolerancePpm <= MIN_IMPROVEMENT_PPM` |
| `revealGracePeriod` for seed escrow | Operational: longer than the longest plausible coordinator-recovery window, shorter than tolerable replay-watcher silence |

Calibration outputs are not secret. They publish in the bundle manifest, sign in the bundle hash, and a third-party auditor can rerun the calibration script (bundled as `scripts/calibrate.mjs`) and reproduce them within sampling noise.

## Implementation Workplan

Phases run roughly sequentially. Each phase has explicit acceptance gates; the next phase does not start until the prior phase's gates are green.

### Phase A — Spec Lock

Add:
- `specs/retrieval_benchmark_v0.md` — the IR-metric definitions (nDCG@10, MRR@10, recall@k, sub-metrics).
- `specs/substrate_retrieval_semantics_v0.md` — packed-state decoder spec for MemoryIndex / RetrievalKeys / Relations / Temporal / Codebook regions.
- `specs/corpus_retrieval_v0.md` — record schema, qrel grading, splits, embeddings-in-deltas.
- `specs/hidden_query_pack_v0.md` — seeded sampling rule, hardness stratification, escrow.
- `specs/determinism_v0.md` — CPU-only inference contract, runtime pins, quantization choices.

Remove from the repo:
- `eval/corpus.ts:scoreProductionState` and the `eventIdToKey128`/`eventIdToMem128` helpers.
- `eval/reranker-eval.ts:evaluateStateWithReranker` and `evaluatePatchWithReranker` (they get rewritten under the new scorer).
- `bundle/index.ts:DEFAULT_PROFILE`'s `composite`/structural family weights.
- `substrate/slot-policy.ts` slot-fill semantics; the file is rewritten as a structural-validity helper or deleted.
- All unit tests that test the removed scorer (`f1-f2-f3-r1-r2.test.mjs`'s F1/F2 sections, etc.). Failing tests for code being removed are not "regressions"; they are intended deletions.
- All docs sections that describe the removed legacy slot-fill scorer.

Acceptance gate: the test suite passes after the deletion (smaller suite is fine; the unit-test count goes down, not up). The repository contains no reward-law path that scores active slot count, structural occupancy, or corpus-id commitment as retrieval quality.

### Phase B — Models + Determinism

- Pin BGE-M3 in `bundle/index.ts` as `bgeM3DenseManifest({revision, outputDim, quantization, runtime})`. Reject `'main'`. Fail closed without per-file SHA-256.
- Pin Qwen3-Reranker-0.6B (already structurally present); add MemReranker-0.6B/MemReranker-4B factories that all share a `CrossEncoderReranker` interface. The labeling model is a separate slot in the bundle (not the production reranker).
- Implement a bi-encoder runtime under `eval/bi-encoder.ts` (CPU-only, named runtime, named quantization). Output bytes are the substrate-slot wire format.
- Implement determinism harness `scripts/determinism-check.mjs` that runs both models on a 1k-pair sample across configured runtimes, emits a CSV of `|score_a - score_b|` per pair, and exits non-zero if the P99 exceeds `MAX_TOLERANCE_PPM = 5000` before final calibration pins the tighter bundle value.
- Acceptance gate: `npm run determinism-check` passes on ≥3 hardware configurations using the pinned model revisions and runtime version. Output P99 disagreement is recorded.

### Phase C — Substrate Decoder

- Implement `substrate/retrieval-decoder.ts`:
  - `decodeMemoryIndex(state) → MemoryIndexSlot[]`
  - `decodeRetrievalKeys(state, codebook?) → RetrievalKeySlot[]` (returns `{vector: Float32Array, norm: number, modelId: bytes32}`)
  - `decodeRelations(state) → RelationEdge[]`
  - `decodeTemporal(state) → TemporalRecord[]`
  - `decodeCodebook(state) → CodebookEntry[]`
  - `decodeSubstrate(state) → DecodedSubstrate` (composes the above; surfaces `{decodedSlots, decodeFailures}` for `structuralValidity` scoring).
- Round-trip property tests: `decode(encode(slot)) == slot` for fuzzed inputs.
- Acceptance gate: 100% line coverage on the decoder; round-trip property tests pass on 10k random inputs.

### Phase D — Retrieval Scorer

- Implement `eval/retrieval-benchmark.ts`:
  - `scoreSubstrateAgainstQuery(decoded, query, corpus, biEncoder, reranker, opts) → { topK, ndcg10, mrr10, recall5, recall10, perCandidateScores }`
  - `evaluateRetrievalBenchmarkState(state, corpus, queryPack, biEncoder, reranker, opts) → CompositeScore`
  - `evaluateRetrievalBenchmarkPatch(parentState, patch, corpus, queryPack, biEncoder, reranker, opts) → { before, after, delta, accepted, vetoes }`
- Implement IR primitives `eval/ir-metrics.ts`: `ndcgAtK`, `mrrAtK`, `recallAtK`, `temporalCurrentStaleAccuracy`, `multiHopRelationRecall`, `abstentionAccuracy`. Exponential-gain nDCG.
- Wire structural sanity from Phase C decoder.
- Unit tests: known fixtures with hand-computed nDCG, MRR, recall expected to within 1e-9.
- Adversarial unit test: patch that writes correct `MemoryIndex` event ids and **null** retrieval vectors → scorer returns near-zero `nDCG@10` (the structural-fill attack).
- Acceptance gate: unit suite passes; adversarial test produces score < `(structuralFloor × w_structural_sanity)` so the patch is rejected.

### Phase E0 — Coordinator Dataset Source Audit

This phase is mandatory. The orchestrator must not assume the published DACR HF export is the correct production source. It must inspect the exact coordinator clone's dataset output and build the bridge from the real S3 layout. If the data does not support the retrieval benchmark shape, the orchestrator must generate the needed corpus from challenge libraries or design a new data collection/export job; it must not force DACR into an unsuitable shape.

Known coordinator dataset layout from `/root/botcoin-coordinator-live`:

- Context:
  - `dataset/v2/domains/<domain>/seeds/<seed>/context/challenge.json`
  - `dataset/v2/domains/<domain>/seeds/<seed>/context/trap_metadata.json`
- Attempts:
  - `dataset/v2/domains/<domain>/seeds/<seed>/attempts/all/<recordId>.json`
  - `dataset/v2/domains/<domain>/seeds/<seed>/attempts/research-ready/<recordId>.json`
- Sessions:
  - `dataset/v2/domains/<domain>/seeds/<seed>/sessions/all/<challengeId>.json`
  - `dataset/v2/domains/<domain>/seeds/<seed>/sessions/research-ready/<challengeId>.json`
- Session pairs:
  - `dataset/v2/domains/<domain>/seeds/<seed>/pairs/session/sequential/<pairId>.json`
  - `dataset/v2/domains/<domain>/seeds/<seed>/pairs/session/sequential/research-ready/<pairId>.json`
  - `dataset/v2/domains/<domain>/seeds/<seed>/pairs/session/bookend/<pairId>.json`
  - `dataset/v2/domains/<domain>/seeds/<seed>/pairs/session/bookend/research-ready/<pairId>.json`
- HF export prefixes:
  - `dataset/v2/exports/hf/v1/<category>/<domain>/<split>/...`

Known exported categories from the clone:

- `raw_attempts`
- `session_trajectories`
- `process_sft_revision_chain`
- session pair exports from `pairs/session/sequential/research-ready`
- session pair exports from `pairs/session/bookend/research-ready`

Audit tasks:

1. List S3 keys for every configured production bucket/prefix above, per domain.
2. Download a statistically meaningful sample from each category/domain/split.
3. Write `docs/CORETEX_SOURCE_DATA_AUDIT.md` with:
   - exact S3 bucket names masked except account-neutral identifiers
   - key counts by category/domain/split
   - schema samples with field names
   - missing-field rates for document, questions, answers, constraints, trap metadata, trace quality, session attempts, pair chosen/rejected
   - whether the category can produce graded retrieval qrels
   - whether the category can produce hidden eval queries
   - whether the category can produce hard negatives
   - whether the category can produce temporal/current/stale labels
   - whether the category can produce multi-hop relation labels
4. Write `scripts/audit-coordinator-dataset.mjs` so the audit is reproducible.
5. Based on the audit, choose one of three outcomes:
   - `use_dataset_v2_direct`: bridge from coordinator S3 `dataset/v2` records.
   - `use_hf_export`: bridge from HF export only if it is proven lossless enough for retrieval qrels.
   - `reject_current_data`: current data is unsuitable; generate a new CoreTex retrieval corpus from challenge libraries / document stores / newly collected traces before continuing.

Acceptance gate: `docs/CORETEX_SOURCE_DATA_AUDIT.md` exists, the audit script runs against the configured clone/export source, and the chosen outcome is explicit. If outcome is `reject_current_data`, the orchestrator immediately creates the replacement corpus generator and continues.

### Phase E — Corpus Build

- Extend `corpus/v3-bridge.ts`, `corpus/admission.ts`, `corpus/delta.ts` to carry the new fields (graded qrels, splits, embeddings, relations), or replace the bridge module entirely if Phase E0 chooses `reject_current_data`.
- Implement the source-specific builder selected by Phase E0:
  - `scripts/build-corpus-from-coordinator-dataset.mjs` for `dataset/v2` direct S3 records.
  - `scripts/build-corpus-from-hf-export.mjs` for proven-lossless HF export rows.
  - `scripts/generate-coretex-retrieval-corpus.mjs` for a replacement corpus generated from challenge libraries / document stores when current data is unsuitable.
- The selected builder must:
  - ingest context `challenge.json` and `trap_metadata.json`
  - ingest attempts/sessions/session-pairs only if their schemas support retrieval qrels
  - generate or preserve answer-bearing documents, hard negatives, stale/current labels, multi-hop labels, and graded qrels
  - generate graded qrels via the labeling model (pinned in bundle)
  - compute bi-encoder embeddings for query + truthDocuments + hardNegatives
  - split records deterministically
  - write a `CorpusDelta` (or initial corpus snapshot at genesis) with embeddings inlined
- Implement `scripts/calibrate.mjs` that runs every calibration measurement listed in §Calibration and writes the output values into a `bundleProfile.json` file the bundle build picks up.
- Acceptance gate: a fresh corpus build at the pinned models reproduces a byte-identical corpus root across two clean machines (proves determinism). The audit reports per-family qrel distribution, hard-negative density, split sizes, and labeling-model agreement statistics.

### Phase F — Coordinator

- Replace the production scoring path with `evaluateRetrievalBenchmarkPatch` driven by the bundle's pinned models.
- `POST /coretex/screen`: structural validation only — patch wire bytes valid, parent root match, score delta non-negative, decode succeeds on the candidate. Earns base screener credits.
- `POST /coretex/evaluate`: full retrieval scoring; signs receipt only if accepted.
- `GET /coretex/corpus/:id` returns `train_visible` qrels + `truthDocuments` + `hardNegatives`; serves 404 for `eval_hidden` and `canary` until reveal.
- `GET /coretex/corpus/:id/embedding` returns precomputed embedding bytes.
- `GET /coretex/coverage-hints` (optional convenience): per-`train_visible`-query, the substrate's current `nDCG@10` and the per-record contribution to that score. Read-only.
- Coordinator startup asserts the on-chain `coreVersionHash` matches the pinned bundle hash and refuses to run on mismatch (existing primitive).
- Eval reports are persisted: `(epochId, miner, patchHash, queryPackId, perMetricBreakdown, modelHash, timestamp)` — signed by the coordinator and stored for audit. Retention defined by ops policy.
- Acceptance gate: a smoke test against a real anvil + the pinned bundle produces a screener and a state advance using `POST /coretex/screen` and `POST /coretex/evaluate`; on-chain state advances; replay watcher reproduces the score within tolerance.

### Phase G — End-to-End Real Reranker Mining Cycle

`test/e2e/phase-13/run.mjs`:

- Spawns anvil, deploys contracts (using existing forge scripts).
- Builds a small calibration-sized corpus using the Phase E0-selected production source via the Phase E pipeline.
- Initializes an epoch with the calibrated bundle profile + a fresh `evalSeedCommit`.
- Runs `N` iterations (default 5 in CI; configurable up to ≥50 for pre-launch acceptance) where each iteration:
  1. Reads on-chain substrate.
  2. Picks a candidate corpus record (heuristic: greatest predicted nDCG gain on visible queries).
  3. Constructs a patch with the precomputed embedding from the corpus.
  4. POSTs to `POST /coretex/evaluate` (the coordinator runs **the real Qwen3-Reranker-0.6B**, not the deterministic stub).
  5. Submits the signed receipt to V4.
  6. Asserts on-chain state advanced + `coretexCredits[miner]` increased.
- After all iterations, reveals the eval seed; replays every transition with `coretex-replay watch`; asserts every replayed `nDCG@10` is within `replayTolerancePpm` of the coordinator's signed `scoreAfterPpm`.
- Adversarial sub-test: an iteration submits a patch that writes a correct memory-index pointer with a uniform-random retrieval vector. Coordinator's evaluate endpoint must return `{ accepted: false, reason: 'no_retrieval_improvement' }` (or equivalent), and the contract receives no signed receipt for it.
- Acceptance gate: the test passes with `CORETEX_RERANKER=qwen3 CORTEX_REAL_EVAL=1 CORETEX_RERANKER_PRODUCTION=1` and refuses to run with `CORETEX_RERANKER=deterministic` in production mode.

### Phase H — Mainnet Launch

There is no migration. Mainnet launch is a fresh deploy to fresh addresses with the pinned bundle:

1. Pin the calibration outputs (bundle profile values from Phase B/E) into `bundle/index.ts` defaults.
2. Build the bundle: `npm run build:bundle`. Compute `bundleHash`. The hash is the production `coreVersionHash`.
3. Deploy `CortexState` and `BotcoinMiningV4` to Base mainnet with `EXISTING_V3=<live V3 address>` and `CORETEX_CORE_VERSION_HASH=<bundleHash>` and the calibrated `CORETEX_MIN_IMPROVEMENT_PPM`.
4. Initialize epoch 0 with the corpus root from the pinned snapshot, the calibrated `evalSeedCommit`, and freeze the epoch.
5. Set V4 as `cortexState.rewardLane`.
6. Configure the coordinator with the production env (`CORETEX_ENABLED=true`, `CORETEX_EXPECTED_BUNDLE_HASH=<bundleHash>`, `CORETEX_RERANKER=qwen3`, `CORETEX_RERANKER_PRODUCTION=1`, `CORTEX_REAL_EVAL=1`, evaluator URL, multisig escrow contract, rate limit envs).
7. Start replay watchers from epoch 0; alarm channel is wired to ops.
8. First miners go live.

There is no rollback path that preserves chain state. Rollback is "halt the reward lane" (`cortexState.setRewardLane(0x0)`) and disable `/coretex/*` (`CORETEX_ENABLED=false`). The chain state at the failure point is frozen; a fresh deploy follows when the bug is fixed.

## Acceptance Criteria — Production Ready

CoreTex is production-ready as a frontier memory retrieval benchmark only when **every** item below holds:

- The reward law is `nDCG@10` over hidden query packs, with retrieval ≥70% of composite weight and the structural validity ≤10% sanity-only.
- The bi-encoder is `BAAI/bge-m3` at a pinned revision with deterministic CPU-only inference.
- The cross-encoder is the strongest deterministic 0.6B-class memory/retrieval reranker selected by the model-selection audit, at a pinned revision with per-file hashes.
- The labeling model is a separate, stronger pinned reranker — never the production reranker.
- The corpus carries graded qrels, hidden splits, embedding payloads in deltas, and is reproducible byte-identically across machines from the pinned models.
- Hidden query packs are deterministic from the seed; sampling is auditable; seed escrow with a multisig and a `revealGracePeriod`.
- Phase G real-reranker mining cycle passes end-to-end including the "correct ids + bad vectors fails" adversarial sub-test.
- Replay watchers reproduce signed `scoreAfterPpm` within `replayTolerancePpm` across at least 3 different CPU hardware configurations.
- Production env refuses to run with deterministic reranker, with `'main'` model revision, with mismatched bundle hash, with GPU acceleration enabled on the canonical scoring path, with missing escrow configuration.
- Miner workflow is exercised end-to-end without local CoreTex: a miner using only `cast call` + `curl /coretex/*` produces an accepted state advance.
- All stale code paths from prior structural-commitment work are deleted; the repository compiles and tests pass without them.
- The plan in this file contains zero placeholders for the orchestrator to interpret as permission to stop.

## Operational Runbook (post-launch)

Documented in `docs/CORETEX_PRODUCTION_RUNBOOK.md`:

- Replay watcher deployment topology (≥3 independent watchers across hardware/operator boundaries).
- Coordinator startup checks and failure modes.
- Multisig seed-escrow procedure.
- Per-artifact retention policy: substrate snapshots forever (chain-derivable), patch bytes forever (chain events), eval reports ≥90 days, challenge books ≥365 days, corpus deltas forever, bundle manifests forever.
- Per-evaluator GPU/CPU saturation guard (queue depth probe + 503 backpressure).
- Per-miner + global rate limits (calibration outputs).
- Rollback / kill switch: `cortexState.setRewardLane(0x0)` + `CORETEX_ENABLED=false`.
- Bundle rotation procedure for non-emergency model replacements selected by the same model-selection audit process.
- Audit-trail signing scheme.

## What This Plan Is Not

- It is not a migration plan. There is no live CoreTex production instance. Test deployments and prior local-hardening rounds are scratch work.
- It is not phased "first" then "real." Phase A through H is the launch sequence, not a multi-release roadmap.
- It does not describe a slot-fill production scorer. There is no slot-fill scorer in production.
- It does not require miners to run CoreTex. Miners can mine via on-chain reads + coordinator REST. CoreTex is the verifier substrate, not a mining client.
- It does not hardcode K, top-k, replay tolerance, composite weights, quantization, runtime pins, or split ratios. Those are calibration outputs derived from the procedures in §Calibration and bound into the bundle. Pinning them in the plan would be guessing; they are pinned in the bundle after calibration runs.
