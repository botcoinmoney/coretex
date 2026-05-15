# CoreTex Substrate Expansion & Hardening

> **Status:** launch-blocking. Drafted 2026-05-15 after external auditor review surfaced a substantive gap in the scoring pipeline. The launch corpus is good. The substrate spec is good. The bundle calibration framework is good. The piece that's broken is the **scorer's candidate-generation step** — it never invokes BGE-M3 against the corpus.
>
> **Outcome:** the substrate becomes a real retrieval-routing policy over the full 678 k-event corpus rather than a 36-slot bookmark cache. Anti-cheat invariants are preserved. No corpus regeneration required. One concentrated PR plus one new calibration pass produces the launch bundle.

## 1. The gap, stated precisely

The scorer at `packages/cortex/src/eval/retrieval-benchmark.ts` lines 140-219 (`scoreSubstrateAgainstQuery`) implements **only** this candidate path:

1. Take the query's precomputed BGE-M3 embedding (line 150) — substrate-agnostic, fine.
2. Iterate the substrate's 36 `RetrievalKey` slots (line 152). Dequantise each. Cosine-compare to the query vector.
3. For each retrieval key, find the one `MemoryIndex` slot whose `retrievalSlot === s` (lines 159-168) — that gives a `recordId`.
4. Sort by cosine, take Top-K (line 173); K = `retrievalKeyTopK` is capped at 36 because that is all the retrieval keys you have.
5. `resolveCorpusDocsForRecordId(recordId, corpus)` (line 221) returns **only the truth docs + hard negatives of the one corpus event** whose `keccak256(id)` low-128 matches that recordId.
6. Pool those docs. Pass them to Qwen3-Reranker. Rank. Compute nDCG@10 against `qrels`.

There is **no first-stage retrieval over the corpus.** The candidate document pool per query is bounded by the substrate's currently-active bookmark set — at most 36 events × 5 docs/event = ~180 candidate docs, drawn from 678,910 events.

A corpus event that the substrate hasn't bookmarked is invisible to the reranker for that query.

The composite-score weights make this load-bearing: `w_retrieval = 0.75` (bundle `DEFAULT_PROFILE.compositeWeights`). Three-quarters of the score is gated by the bookmark path described above. The remaining 25%:

- `w_temporal = 0.08` — re-checks current/stale ordering of docs already in the substrate-bounded ranked list (no candidate expansion).
- `w_relation_recall = 0.07` — BFS-reachability audit of bookmarked anchors (no candidate expansion; see `ir-metrics.ts:133-152`).
- `w_abstention = 0.05` — top-1 score threshold check.
- `w_structural_sanity = 0.05` — substrate-format invariants only.

Net: the substrate is functioning as a 44-slot bookmark cache with cosine routing. The frontier-retrieval design that `docs/CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md` line 69 explicitly commits to — *"BGE-M3 ... is the model the MemReranker paper uses for candidate generation (BGE-M3 Top-100 for LOCOMO; Top-50 for LongMemEval)"* — is unimplemented. The corpus side is fully built (`event.embeddings.perTruth` + `perNegative` carry every doc's pinned BGE-M3 vector — see `retrieval-corpus.ts:84-94` and the 678,910 events × ~5 docs/event = ~3.4 M doc vectors that already live in the launch corpus). The consumer side never reads them.

## 2. Why the gap exists

The author of `scoreSubstrateAgainstQuery` deliberately closed off one specific oracle-cheat path. The comment at line 186-189 is explicit:

> *"Do not inject the query's own truth documents here. The ranked list must be composed only of documents reachable through substrate retrieval keys; otherwise an empty or wrong substrate can receive oracle-fed nDCG credit."*

That intent is correct. The fix was over-broad. The forbidden thing is *the scorer reading `query.truthDocuments` (a private answer key) to populate candidates*. A blind first-stage BGE-M3 cosine retrieval over the public corpus doc embeddings is **not** oracle injection — the retriever doesn't read qrels, doesn't read the per-event `truthDocuments` field as an answer set; it just returns the K docs whose pinned embedding is nearest the query vector. Some happen to be truth docs; many won't be. On hard temporal / multi-hop / near-collision queries, blind BGE-M3 retrieval alone is mediocre by construction — that is exactly the room the substrate is supposed to occupy.

The over-correction conflated *"don't read qrels"* with *"don't reach into the corpus at all"*, and removed the first-stage retriever entirely. The substrate then had to do the first-stage retriever's job using a 36-key cache, which it cannot do at corpus scale.

## 3. The fix: two-stage retrieval, substrate is the bias not the gate

Replace `scoreSubstrateAgainstQuery` with a two-stage pipeline:

### Stage 1 — `firstStageCandidates(queryVec, corpus, K)` — substrate-agnostic

Pure cosine over `corpus.events[*].embeddings.{perTruth,perNegative}`. Returns the Top-K docs by raw BGE-M3 similarity. Identical output for every miner against a given query, including a miner who has submitted no patch at all. K is calibrated; pinned in the bundle profile as `firstStageTopK`.

**Hard constraints on stage 1:**

- May read only the public doc embeddings keyed by doc id. May not read `query.qrels`, `query.truthDocuments` *as an answer set*, or any field that encodes ground-truth relevance.
- Substrate-agnostic by construction: takes `queryVec` and `corpus`; does not take the decoded substrate. (Encoded in the type signature.)
- Deterministic. Same `(queryVec, corpus, K)` → same Top-K doc id list. The replay watcher verifies this.

### Stage 2 — substrate as routing-policy bias

Stage 2 takes the stage-1 pool and applies four substrate-driven modulations:

1. **Lens-vector bonuses (`RetrievalKey` slots).** Each active retrieval key contributes a per-candidate bonus proportional to `cos(candidate_emb, lens) × lens_weight`. The retrieval keys stop being bookmark pointers and become *lens vectors* — directions in the BGE-M3 embedding space that the substrate has learned to favour. Multiple lenses → mixture-of-experts routing.
2. **Anchor-exemplar bonuses (`MemoryIndex` slots).** A MemoryIndex slot whose `recordId` resolves to a corpus event acts as an *exemplar anchor*. Candidate docs that are embedding-similar to the anchor's truth doc get a bonus. Same on-disk slot shape, reinterpreted role.
3. **Relation expansion (`Relations` region).** For each anchor slot, BFS through the 128 relation entries up to `relationHopBudget` and *add the truth docs of neighbouring corpus events to the candidate pool*. This is the only substrate-driven candidate expansion; it is the substrate's most expressive lever and the part of the design that makes the 128-entry relations region pay its bytes.
4. **Temporal modulation (`Temporal` region).** Re-weight stage-1 candidates by current/stale flags when the query family is temporal. Boost current truth docs, suppress stale ones, abstain when no current truth exists in the pool.

### Anti-cheat invariant

> `score(empty_substrate)` = `score(stage1 alone)` — the BGE-M3 baseline. No free oracle credit.

An empty substrate sits at whatever blind BGE-M3 retrieval deserves on each query family. On hard families (temporal, multi-hop, near-collision) that baseline is mediocre — by design, that's where the substrate must contribute. A good substrate must measurably beat this baseline.

The acceptance rule (`composite(after) - composite(before) ≥ minImprovementPpm`) automatically does the right thing because both substrates are evaluated against the *same* stage-1 pool per query. The patch is paid only if its routing/lensing/expansion produces a real composite lift over the parent's routing against the identical stage-1 baseline.

**Two trivial structural checks** the scorer must enforce (to keep auditors honest the next time someone reviews this):

1. The `firstStageCandidates` function signature does not accept `corpus.events[*].qrels` or `corpus.events[*].truthDocuments` as an answer set. (Compile-time enforced by a typed wrapper that exposes only `{ id, embedding }` pairs.)
2. Stage 2 expansion may only add docs that already exist in the public corpus, reachable via a neighbouring event's pinned embedding. The substrate cannot manufacture a doc id from thin air.

These two checks together close the *original* leakage path that motivated the over-correction, while reopening corpus-scale retrieval.

## 4. Why this is not a "lose all calibration work" change

The fix is concentrated in **one function** (`scoreSubstrateAgainstQuery`) plus a new helper (`firstStageCandidates`). The following remain untouched:

| Artifact | Status |
|---|---|
| 678 k-event launch corpus + corpusRoot `0x4cfa8594…` | unchanged |
| Bi-encoder pin (BAAI/bge-m3 rev `5617a9f6…`) | unchanged |
| Cross-encoder pin (Qwen3-Reranker-0.6B) | unchanged |
| Substrate decoder (`packages/cortex/src/substrate/retrieval-decoder.ts`) | unchanged |
| 1024-word substrate layout, 6 region geometry | unchanged |
| Patch verifier + dual-pack acceptance + per-family floors | unchanged |
| On-chain pipeline (`BotcoinMiningV4`, `CortexState`, replay watcher) | unchanged |
| Corpus generator + cross-system reproducibility proof | unchanged |
| Determinism check, aggregator, replay tolerance criterion | unchanged |
| Calibration framework (`calibrate.mjs`, `pin-baseline-into-bundle.mjs`) | unchanged structure; recalibrates against the new pipeline |
| Bundle manifest framework | unchanged; new `firstStageTopK` pin enters the profile |

What needs to move:

- `scoreSubstrateAgainstQuery` rewritten as the two-stage pipeline above.
- New helper `firstStageCandidates` + a typed `PublicCorpusEmbeddings` view that prevents qrel access.
- `EvaluatorProfile` gains `firstStageTopK: number` (calibrated).
- `bundleHash` will move once because the pipeline definition enters the pinned profile. This is a one-shot bundle bump.
- `baselineVariancePpm` recalibrated under the new pipeline (the value from the May 15 calibration pass is wrong for this pipeline).

## 5. Calibration runs required (in order)

Each run produces a single deterministic artifact under `/var/lib/coretex/reports/`; together they pick the new `firstStageTopK` and re-pin the acceptance thresholds.

### Run 1 — `firstStageTopK` sweep

Compute stage-1 recall@K on the calibration split for K ∈ {50, 100, 200, 400, 800, 1600}. For each query in the split, count how many of its `truthDocuments` appear in the stage-1 Top-K. Pick the smallest K where recall@K ≥ 0.95 (matching `CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md` line 366's pinned recipe).

Expected outcome: K is in the 100-400 range for BGE-M3 on this corpus shape; smaller would underserve hard families, larger wastes reranker compute.

Output: `reports/first-stage-topk-sweep.json`. Pinned into the bundle profile.

### Run 2 — Baseline-noise sanity under the new pipeline

Run the new scorer end-to-end on the calibration split with an **empty substrate** (all slots zero except mandatory header). Repeat across N=10 independently-seeded hidden packs. Measure σ of composite. This is the new `baselineVariancePpm` — the floor of "noise the acceptance rule must clear."

Compare against the May 15 value (`baselineVariancePpm` written by `calibrate.mjs` step 5) — that was measured against the bookmark scorer, and will be larger or smaller than the new pipeline's noise floor. Almost certainly the new noise floor is *smaller* because stage-1 is corpus-stable across pack draws.

Output: `reports/baseline-variance-new-pipeline.json`. Updates `bundle-profile.json`.

### Run 3 — Per-family lift curve

For each query family (near_collision, temporal, long_horizon, multi_hop_relation), measure the composite score gap between `empty_substrate` and an `oracle_substrate` (a synthesized substrate that has every truth doc as an anchor). This gives the per-family *headroom* the substrate is supposed to fill.

If any family's headroom is < 2 × `baselineVariancePpm`, the family weight is too small relative to noise — the lift signal will be drowned by pack variance and the per-family floors will reject too aggressively. Recalibrate the family weights only if this triggers.

Output: `reports/per-family-headroom.json`. May trigger a one-time `compositeWeights` adjustment.

### Run 4 — `minImprovementPpm` floor recalibration

Take the current `minImprovementPpm = 2500` and stress-test it under the new pipeline. Generate 100 random one-slot patches against a non-empty baseline substrate. Measure the false-accept rate (patches that should not have advanced but did) and false-reject rate (patches that genuinely move composite but get rejected). Sweep `minImprovementPpm ∈ {500, 1000, 2500, 5000}` for the same patch set.

Pick the smallest threshold whose false-accept rate is ≤ 1% on adversarial patches. This is the new pinned `minImprovementPpm`.

Output: `reports/min-improvement-sweep.json`.

### Run 5 — Optional: dual-pack vs k-of-N study

If after Run 4 the false-reject rate at acceptable thresholds is still too high, switch the acceptance function from AND-of-2 to **median-of-4 ≥ T** or **k-of-N** (specifically: N=4 packs, accept if ≥3 of 4 clear `minImprovementPpm + replayTolerancePpm`). Cost: 4× per-patch eval, paid by the coordinator. Per-family catastrophic floors stay per-pack AND — a patch that destroys multi-hop on 1 of 4 packs is still a regression.

**Do not move to mean-of-N as the production rule.** Mean is too forgiving of outlier packs and obscures regression signals. Median or k-of-N preserves the regression guards.

This run is conditional. If Run 4 produces an acceptable threshold under AND-of-2, skip Run 5.

Output (conditional): `reports/acceptance-rule-study.json` + a bundle-profile change to `acceptanceRule = "k-of-N"` with `N=4`, `k=3`.

## 6. Code changes (concentrated PR)

### 6.1 New: `firstStageCandidates` helper (substrate-agnostic, typed)

```ts
// packages/cortex/src/eval/first-stage-retrieval.ts
import type { ProductionCorpus } from './retrieval-corpus.js';

export interface PublicCorpusDoc {
  readonly id: string;
  readonly eventId: string;
  readonly embedding: Uint8Array; // int8-quantized BGE-M3
}

export function firstStageCandidates(
  queryVec: Float32Array,
  corpus: ProductionCorpus,
  k: number,
): readonly PublicCorpusDoc[];
```

Implementation: linear-scan cosine over `(perTruth, perNegative)` from every event, partial-sort to Top-K, return doc-id + embedding. No `qrels`, no `truthDocuments`-as-answer-set in the signature. Replay watcher verifies identical output across hosts.

Performance: 679 k events × ~5 docs × 243-dim int8 cosine = ~3.4 M cosines per query. ~30-100 ms per query on a single core; small per-pack cost (pack size 128 → ~5-15 s per pack). If profiling demands it, build a `Float32Array`-of-all-doc-vectors once at corpus-load time and run the cosine sweep over the flattened array; further: ANN index (HNSW or PQ) can be precomputed and pinned in the bundle if the linear scan becomes a coordinator bottleneck. Linear scan is fine for v1.

### 6.2 Rewrite: `scoreSubstrateAgainstQuery`

Same file, same signature, new body:

```ts
// Stage 1
const queryVec = dequantize(query.embeddings.query, opts.retrievalKeyLayout);
const stage1 = firstStageCandidates(queryVec, corpus, opts.firstStageTopK);

// Stage 2 — substrate bias
const lensBonuses = applyLensBonuses(stage1, decoded.retrievalKeys, opts);
const anchorBonuses = applyAnchorBonuses(stage1, decoded.memoryIndex, corpus, opts);
const expanded = expandViaRelations(stage1, decoded, corpus, opts);
const temporalAdjusted = applyTemporalModulation(expanded, decoded.temporal, query);

// Dedupe by docId; merge bonuses
const candidatePool = mergeCandidatePool(stage1, expanded, lensBonuses, anchorBonuses, temporalAdjusted);

// Rerank with Qwen3 unchanged
const scores = await opts.reranker.score(candidatePool.map((d) => ({ query: query.queryText, document: d.text })));
// ... same fail-closed + qrel-attach + sort logic as today
```

The compile-time invariant: `firstStageCandidates`'s typed signature ensures nobody slips qrel access in.

### 6.3 New scoring config in `EvaluatorProfile`

```ts
// packages/cortex/src/bundle/index.ts
interface EvaluatorProfile {
  ...
  readonly firstStageTopK: number;            // NEW — calibrated, default ~200
  readonly lensWeight: number;                 // NEW — per-lens contribution scale
  readonly anchorWeight: number;               // NEW — per-anchor contribution scale
  readonly relationExpansionBudget: number;    // NEW — max docs added per anchor via relations
  // existing fields unchanged
}
```

`scoreSubstrateAgainstQuery` consumes all four via `ScoringOptions`.

### 6.4 `retrievalKeyTopK` semantics change

In the new pipeline, `retrievalKeyTopK` no longer caps candidate events — stage 1 picks K candidate docs from the full corpus regardless of substrate state. `retrievalKeyTopK` instead caps how many lens vectors contribute to stage-2 reweighting per query. Remove it from the bundle profile or rename to `lensTopK` to make the semantics clear.

### 6.5 Bundle pipeline-definition pin

`EvaluatorProfile` gains `pipelineVersion: 'coretex-retrieval-v1' | 'coretex-retrieval-v2-lens'`. The v2 pipeline is the new one; v1 is preserved only for replaying historical state (not used post-launch). `bundleHash` moves once; downstream replay watchers consume `pipelineVersion` to select the matching code path.

### 6.6 Miner self-eval harness

Add `scripts/coretex-eval.mjs` (or extend `mining-flow-e2e.mjs --mode self-eval`) that runs the full pipeline against the **visible split** with a candidate patch:

```bash
node scripts/coretex-eval.mjs \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
  --parent-state-root 0x... \
  --patch ./candidate.json \
  --split visible
```

Output: full composite breakdown (nDCG, per-family delta, structural validity, expected envelope class). This is how miners author targeted patches without learning anything about the hidden pack — they self-diagnose against public data using the same code path the coordinator runs. The asymmetry is by design: anything miners need to learn is learnable from public corpus + visible split.

This is **not** a rejection-envelope change. The HTTP shim's opaque rejection envelope stays. The two narrow exceptions already in `live-eval-admission.ts` (`structurally-invalid`, `malformed-input`) are not score gradients — keep them in the wire response. Everything score-correlated collapses to `code: 'rejected'`.

## 7. Final validation tests (gap-closure proof)

These tests prove the gap is actually closed and CoreTex still runs correctly under the new substrate layout + bi-encoder integration. Each one writes a single deterministic report into `/var/lib/coretex/reports/`.

### Test A — `score(empty_substrate)` is the BGE-M3 baseline

For 100 random queries across all families, compute composite with substrate fully zeroed except header. Compare against composite computed by running stage 1 alone with no stage 2. The two numbers must match to within `replayTolerancePpm = 250`. If they don't match, stage 2 is leaking value into the empty case (e.g., zero substrate is being interpreted as a non-trivial lens).

### Test B — `score(empty_substrate) < score(non_empty)` on hard families

For each family, generate a hand-crafted reasonable substrate (anchor exemplars + lens vectors + relation edges that match the family's structure). Composite must exceed the empty-substrate baseline by at least 2 × `baselineVariancePpm` on that family. If a family's headroom is < 2σ, the substrate has no measurable effect there — design issue, not test issue, surface to operator.

### Test C — Stage 1 never reads qrels

Static check: grep `firstStageCandidates` callsite to confirm only `{ queryVec, corpus, K }` arguments. Runtime check: instrument `corpus.events[*].qrels` access during a stage-1-only run, assert zero reads.

### Test D — Replay watcher reproduces stage 1 byte-identically

For a fixed `(queryVec, corpus, K)`, the stage-1 Top-K doc id list must be deterministic across hosts. Run on host A, run on host B (or simulated cross-CPU), assert identical doc-id list. This is the cross-system reproducibility invariant carried forward.

### Test E — Patch incentive structure

Generate 100 candidate patches via random search. Run them through the new scorer against the launch bundle + visible split. Measure: how many produce composite > minImprovementPpm? What fraction of patches that pass the visible split also pass the hidden pack (true-positive rate)? What fraction pass the visible split but fail the hidden pack (over-fit to visible)?

Acceptance: true-positive rate ≥ 90%, over-fit rate ≤ 10%. If over-fit is high, the visible/hidden split sampling needs work or the substrate is encoding visible-pack-specific patterns rather than generalizable retrieval policy.

### Test F — Full Phase 13 against new pipeline, 25 iterations

Re-run `test/e2e/phase-13/run.mjs --iterations 25` against the new bundle. Same acceptance criteria as today: mix of accepts (deltaPpm > minImprovementPpm) and rejects (no_retrieval_improvement, family_catastrophic, etc.). Compare the accept/reject ratio to the May 10 Phase 13 (3/5 accepts on the calibration corpus). The new pipeline should show a similar shape — most random patches reject, a few engineered patches accept.

### Test G — Mining-flow e2e produces all three buckets

Re-run `scripts/mining-flow-e2e.mjs --mode live` against the new bundle. Confirm:
- `screener_reject` observed (opaque envelope)
- `screener_pass_no_advance` observed (accepted but no on-chain receipt)
- `state_advance` observed (accepted + receipt)

Persist fixtures, run replay mode, assert byte-identical envelopes.

### Test H — Base fork rehearsal

`scripts/base-fork-rehearsal.mjs --bundle-manifest <new bundle> --fixtures <new fixtures>` spins anvil on a Base mainnet fork at the pinned addresses, impersonates the coordinator signer, submits `BotcoinMiningV4.submitWorkReceipt` from a `state_advance` fixture. Confirms the on-chain integration shape is unaffected by the scorer refactor.

## 8. Order of operations

1. **Land Phase A (Section 6.1-6.5).** New scorer code + bundle profile fields + pipeline-version pin. Unit tests for the new helper + the scorer. Existing 382 unit tests must still pass.
2. **Calibration runs 1, 2.** Pin `firstStageTopK` and `baselineVariancePpm` under the new pipeline.
3. **Calibration runs 3, 4.** Per-family headroom + `minImprovementPpm` recalibration. Update `bundle-profile.json`.
4. **Conditional run 5.** Only if step 4 leaves false-reject too high.
5. **Land Phase B (Section 6.6).** Miner self-eval harness + docs.
6. **Validation tests A-H.** Each produces a committed report; failures block launch.
7. **Resume the post-corpus playbook** from step 5 (calibrate) with the new scorer wired in. Phase 13 (playbook step 10) is the integration gate.
8. **Bundle bump.** Single `bundleHash` move with `pipelineVersion: 'coretex-retrieval-v2-lens'`. Pinned in the calibration write-down doc.
9. **Mainnet canary** per Post-Corpus Playbook step 16 (operator-gated, unchanged).

## 9. What this is not

- **Not** a corpus regeneration. The 678 k events stay; their pinned embeddings start carrying their weight.
- **Not** a substrate layout change. The 1024 words, 36+44+128+12+48 slot inventory, all unchanged.
- **Not** a bi-encoder / cross-encoder swap. Same BGE-M3 + Qwen3-Reranker-0.6B pins.
- **Not** a rejection-envelope rewrite. The opaque envelope is correct policy; the miner self-eval harness is the missing piece.
- **Not** a multi-pack switch. Calibrate variance first; multi-pack is a fallback if k-of-N at N=4 turns out to be needed.
- **Not** an "indefinite scalability" change. The 1024→2048 ladder remains a separate post-launch lever and is not in scope here.

## 10. References

- Auditor session, 2026-05-15 — *"the substrate has currently doing the bi-encoder's job, badly, against 36 prequantized vectors that miners must inscribe one event at a time."*
- `packages/cortex/src/eval/retrieval-benchmark.ts:140-219` — current `scoreSubstrateAgainstQuery` (the function being replaced).
- `packages/cortex/src/eval/retrieval-benchmark.ts:186-189` — the over-correction comment that motivated this gap.
- `docs/CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md:69` — the pin to MemReranker semantics (BGE-M3 Top-50/100 first-stage), which is the design this hardening restores.
- `specs/cortex_state_v0.md` — the substrate layout (unchanged by this plan).
- `docs/CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md` — cross-CPU determinism guarantees that stage 1 inherits.
- MemReranker paper (`https://arxiv.org/html/2605.06132v1`) — the architectural prior this hardening aligns the scorer with.
