# CoreTex V4 Frontier Retrieval Hardening Plan

Last updated: 2026-05-10.

## Non-Negotiable Goal

CoreTex is not a toy simulation and not a slot-fill game. The production reward law must measure real improvements to a compact on-chain memory retrieval substrate:

- Given hidden benchmark queries, does the substrate retrieve answer-bearing memories?
- Does it rank those memories well under accepted IR metrics?
- Does it handle stale/current temporal facts, multi-hop relations, compression, and abstention?
- Does a patch improve retrieval quality over the live parent state by more than the epoch difficulty threshold?

The current V4 primitives are valuable, but the current default reward law is not yet the final production retrieval benchmark.

## Current Truth

What is strong and should be kept:

- `CortexState` 1024-word / 32 KB substrate.
- Compact 1-4 word patches and deterministic state roots.
- EIP-712 coordinator receipts and replayable chain events.
- Bundle hash binding specs, implementation, corpus, evaluator, model manifest, and replay code.
- DACR corpus ingestion, session/bookend bridging, cross-miner distractors, self-contained corpus deltas, epoch rotation manifests, and adaptive difficulty calculator.
- Pinned Qwen3-Reranker-0.6B path and production refusal of deterministic rerankers.
- Coordinator `/coretex/*` reference mount, auth/rate-limit hooks, and artifact surface.

What is not acceptable as the final reward law:

- `scoreProductionState` is dominated by structural commitment: active/revoked salted IDs in `MemoryIndex` / `RetrievalKeys`, relation word occupancy, and codebook occupancy.
- `evaluateStateWithReranker` still scores active event documents after structural selection; it does not perform query -> substrate top-k retrieval as the primary task.
- The default launch profile is still `primaryMetric: composite`, not `ndcg@10`.
- Phase-10/11 correctness harnesses prove state advancement and replay, not frontier retrieval quality.

Therefore current V4 is production-grade infrastructure for verifiable state transition and replay, but it must be hardened before being called production-ready as a frontier memory retrieval benchmark.

## Research-Aligned Target

The final CoreTex V4 reward law must be shaped like accepted retrieval benchmarks:

- Primary metric: `nDCG@10`.
- Secondary metrics: `MRR@10`, `Recall@5`, `Recall@10`, temporal stale-suppression accuracy, multi-hop path recall, and abstention/negative rejection.
- Evaluation loop: hidden query pack -> substrate top-k candidate retrieval -> Qwen3 reranking / graded relevance -> metric aggregation -> parent/candidate delta.
- Weighting: at least 80% retrieval quality, at most 20% structural/compression sanity.

The final benchmark should resemble BEIR/MTEB retrieval and reranking methodology, extended for long-term memory concerns surfaced by LongMemEval, LoCoMo-style memory reranking, and memory-structure benchmarks.

## V4.1 Architecture

### 1. Substrate Semantics

Keep the 1024-word state body, but reinterpret retrieval regions as a real compact index.

`MemoryIndex`:

- Stores memory/document pointers, corpus record ids, family/domain bits, temporal validity, protection flags, and pointer(s) into retrieval vector slots.
- Stores current/stale status for temporal records.
- Never scores merely because a corpus id exists in the slot.

`RetrievalKeys`:

- Stores compact retrieval vectors, not event-id hashes.
- Baseline format: each 8-word slot is 256 bytes.
- Use either:
  - `112 x fp16` vector dimensions plus header metadata, or
  - product-quantized codes with codebooks in `Codebook`.
- Must expose a deterministic decoder from packed state -> active retrieval vectors.

`Relations`:

- Stores typed edges between memory records.
- Multi-hop score must evaluate whether graph traversal from retrieved seed memories reaches answer-bearing memories within a bounded hop count.
- Occupancy alone is not a score.

`Temporal`:

- Stores current/stale intervals, supersession edges, and revocation facts.
- Temporal score must penalize retrieving stale truths when a current truth exists.

`Codebook`:

- Stores quantization/codebook metadata used to reconstruct compact vectors.
- Codebook score is compression quality / reconstruction validity, not active-slot count.

### 2. Corpus Shape

The corpus must become a retrieval benchmark, not just a list of events.

Every production record needs:

- `queryText`
- positive answer-bearing document(s)
- hard negatives / distractors
- graded relevance labels, not only binary labels
- family/domain/difficulty metadata
- temporal current/stale labels where applicable
- relation graph labels where applicable
- embedding payloads or deterministic pointers to pinned embedding artifacts
- split: `train_visible`, `eval_hidden`, `calibration`, or `canary`

Corpus expansion remains epoch-based:

- New DACR/V3 records are appended through `CorpusDelta`.
- Splits are stable by challenge/session/bookend id, not random per run.
- Eval-hidden rows are never used as miner-visible examples for the same epoch.
- Each epoch publishes a signed manifest binding previous root, next root, delta hash, challenge book hash, bundle hash, difficulty, and split statistics.

### 3. Hidden Query Pack

At epoch initialization:

- Coordinator commits to `evalSeedCommit`.
- The seed selects a hidden query pack from the eval split.
- Miners see the corpus distribution and visible training/calibration records, but not the exact query pack.

During the epoch:

- Coordinator/evaluator can score candidate patches against the hidden pack and sign receipts.
- Miners cannot optimize for exact query ids; they must improve general compact retrieval.

After epoch finalization:

- Seed and query-pack manifest are revealed.
- `coretex-replay watch` recomputes metrics against the same pack and alerts on disagreement.

### 4. Retrieval Scorer

Add a new evaluator module, tentatively:

- `packages/cortex/src/eval/retrieval-benchmark.ts`

Required flow:

1. Decode parent and candidate substrates.
2. Reconstruct active memory docs, retrieval vectors, temporal labels, relation graph, and codebook.
3. For each hidden query, compute/query-load the pinned query embedding.
4. Compute similarity against active substrate vectors.
5. Select top-k candidate memories from the substrate.
6. Run Qwen3-Reranker-0.6B over `(query, candidate_document)` pairs for top-k.
7. Convert reranker outputs + corpus qrels into graded relevance.
8. Compute `nDCG@10`, `MRR@10`, `Recall@5`, `Recall@10`.
9. Compute temporal and relation sub-metrics.
10. Score candidate minus parent.

Patch acceptance:

- `deltaNdcgPpm >= epoch.minImprovementPpm`
- no protected-regression veto
- no family-level catastrophic regression
- score reproducible within `replayTolerancePpm`

### 5. Production Profile

The V4.1 bundle profile must change from:

- `primaryMetric: composite`
- 20/20/20/20/10/10 structural composite

to:

- `primaryMetric: ndcg@10`
- `retrievalNdcg@10`: 70-80%
- `temporalCurrentStale`: 10%
- `multiHopRelationRecall`: 5-10%
- `structuralValidity`: 5%
- `compression/codebook`: 5%

The exact default should be chosen after calibration, but retrieval must dominate.

### 6. Difficulty Progression

Difficulty must apply to retrieval deltas, not structural deltas.

Epoch rotation computes:

- observed accepted retrieval advances
- quality attempts scored by real Qwen3
- median and p90 replay noise in ppm
- next `minImprovementPpm`

Difficulty can increase by:

- higher minimum `deltaNdcgPpm`
- larger hidden query packs
- more hard-negative-heavy query packs
- higher temporal/multi-hop mix
- stricter no-regression thresholds

Difficulty must not increase by rewarding arbitrary slot occupancy.

### 7. End-to-End Tests That Count

The following must pass before calling this production-ready as a retrieval benchmark:

- Real Qwen3 full mining loop, not deterministic reranker.
- Candidate patch improves `nDCG@10` over parent on a hidden query pack.
- Bad patch that merely writes correct event ids but bad vectors fails.
- Patch that improves near-collision retrieval but regresses temporal current/stale fails under protected-regression veto.
- Replay recomputes the exact same metrics from parent state, patch bytes, corpus bundle, query-pack reveal, and model manifest.
- Sparse-domain and session/bookend corpora produce stable qrels and non-trivial hard negatives.
- Calibration run quantifies Qwen3 score distribution, replay tolerance, and threshold margins.

### 8. Mainnet Activation Shape

No contract redeploy should be required if receipt fields and `coreVersionHash` are enough.

Activation sequence:

1. Freeze current V4 composite profile as historical `coretex-v4-commitment`.
2. Add V4.1 retrieval profile as new bundle and new `coreVersionHash`.
3. Publish corpus root with retrieval qrels, embeddings, and hidden split metadata.
4. Start evaluator with `CORTEX_REAL_EVAL=1`, `CORETEX_RERANKER=qwen3`, expected bundle hash, and calibrated profile.
5. Initialize next epoch with V4.1 `coreVersionHash`, `corpusRoot`, `evalSeedCommit`, and retrieval-delta difficulty.
6. Run watchers with revealed query-pack manifests after finalization.

## Implementation Workplan

### Phase A: Spec Lock

- Add `specs/retrieval_benchmark_v1.md`.
- Add `specs/substrate_retrieval_semantics_v1.md`.
- Mark existing composite scorer as `commitment_profile`, not production retrieval law.

### Phase B: Corpus/Qrels

- Extend `ProductionCorpusEvent` to support graded qrels and split labels.
- Add embedding generation/pinning pipeline.
- Add hard-negative audit reports per domain/family.
- Build `CortexBench-v1` fixture from DACR/V3 with train/calibration/eval-hidden splits.

### Phase C: Substrate Decoder

- Add retrieval-vector decoder for `RetrievalKeys`.
- Add memory pointer decoder for `MemoryIndex`.
- Add relation traversal decoder.
- Add temporal supersession decoder.

### Phase D: Retrieval Evaluator

- Implement `evaluateRetrievalBenchmarkState`.
- Implement `evaluateRetrievalBenchmarkPatch`.
- Implement `ndcgAtK`, `mrrAtK`, `recallAtK`.
- Integrate Qwen3 reranker as mandatory production reranker.

### Phase E: Coordinator Integration

- Replace production signing path from composite scorer to retrieval benchmark scorer.
- Persist signed eval reports containing query-pack id, metric breakdown, top-k candidates, and model hash.
- Keep structural scorer only as a sanity gate.

### Phase F: E2E Proof

- Add phase-13 real Qwen3 retrieval-mining e2e.
- Run reduced query-pack mode for CI and full query-pack mode for release.
- Add negative tests where structural slot fill passes old scorer but fails retrieval scorer.

### Phase G: Deployment

- Rotate bundle/coreVersionHash.
- Publish migration runbook.
- Deploy coordinator/evaluator.
- Start replay watchers.
- Run Base fork rehearsal against exact deployment addresses.

## Acceptance Criteria

CoreTex V4.1 is production-ready only when:

- Primary accepted metric is `nDCG@10` over hidden query packs.
- Real Qwen3 participates in the full mining loop.
- Miners cannot win by writing salted event ids without useful retrieval vectors.
- Replay independently recomputes the same retrieval metrics.
- Corpus expansion, hidden query sampling, and difficulty rotation run every epoch.
- All production envs fail closed if deterministic reranker or unverified bundle is configured.

