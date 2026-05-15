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

### Stage 1 — `firstStageCandidates(queryVec, publicIndex, K)` — substrate-agnostic and label-free by type

Pure cosine over a label-free index of `corpus` doc embeddings. Returns the Top-K docs by raw BGE-M3 similarity. Identical output for every miner against a given query, including a miner who has submitted no patch at all. K is calibrated; pinned in the bundle profile as `firstStageTopK`.

**Hard constraints on stage 1 — enforced by type system, not by comment.** CoreTex ships as the canonical open-source replay validator, so the package must continue to contain both labels (for scoring) and unlabeled doc text (for retrieval). The fix is a hard type boundary that keeps stage 1 in a separate module with no label fields exported:

```ts
// packages/cortex/src/eval/public-corpus-index.ts
export interface PublicCorpusDoc {
  readonly id: string;          // canonical doc id (deduped across events)
  readonly eventId: string;     // the corpus event this doc belongs to
  readonly embedding: Uint8Array; // int8-quantized BGE-M3 vector
  // No qrels. No truthDocuments-as-answer-set. No relevance labels.
}

export interface PublicCorpusIndex {
  readonly biEncoderModelId: string;
  readonly biEncoderRevision: string;
  readonly layout: RetrievalKeyLayout;
  readonly docs: readonly PublicCorpusDoc[];   // deduped by id
}

export function buildPublicCorpusIndex(corpus: ProductionCorpus): PublicCorpusIndex;
```

The retriever signature:

```ts
export function firstStageCandidates(
  queryVec: Float32Array,
  index: PublicCorpusIndex,
  k: number,
): readonly PublicCorpusDoc[];
```

`firstStageCandidates` cannot take a `ProductionCorpus` at all. Any caller that tries to pass the labeled corpus type fails type-check at compile time. Labels enter only the scoring layer (`scoreRankedList(rankedDocs, labeledQuery)`), which runs *after* the rerank step. The boundary is therefore non-negotiable in code, not in a comment.

**Doc-id deduplication.** `buildPublicCorpusIndex` deduplicates docs by canonical id during construction — a doc that appears as a hard negative in N events appears once in the index, not N times. Without dedupe, frequently-reused negatives get artificially weighted Top-K coverage and become a gameable surface. Dedupe rule pinned in the bundle profile as `corpusDocDedupe: 'canonical-doc-id'`; auditors verify by re-indexing.

**Determinism.** Same `(queryVec, publicIndex, K)` → byte-identical Top-K doc id list across hosts. Cross-system reproducibility proof (`CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md`) carries forward unchanged.

**Linear scan is the determinism contract, not a v1 shortcut.** ANN libraries (HNSW, IVF, PQ) are almost never byte-identical across CPU dispatch paths. Cross-system replay tolerance requires byte-identical Top-K, so linear scan over the full index is the only viable implementation under the current contract. At 678 k events × ~5 docs/event deduped to ~3.4 M unique docs × 243-byte int8 embeddings, a single query is ~30-100 ms on one core. This cost is baseline-budgeted (see §7 Test I) and amortized via the pack-level cache (§6.7). When linear scan eventually becomes infeasible at corpus growth, the fallback is a deterministic-PQ index pinned in the bundle — flagged in §11.

### Stage 2 — substrate as routing-policy bias (deterministic formula pinned)

Stage 2 takes the stage-1 pool and applies four substrate-driven modulations. The bonus → final-rank formula is pinned in the spec and tests so two implementations produce byte-identical rankings.

**Pinned formula.** For each candidate doc `d` produced by stage 1 (or added by relation expansion below):

```
substrateBonus(d) = lensBonus(d) + anchorBonus(d) + temporalBonus(d)
finalReorderingScore(d) = rerankerScore(d) + substrateBonus(d)
```

Stage 2 contributions:

1. **Lens-vector bonuses (`RetrievalKey` slots).** `lensBonus(d) = lensWeight × maxOverActiveLenses(cos(d.embedding, lens_k))` — i.e., the strongest active lens vector that "agrees" with the doc embedding. The retrieval keys stop being bookmark pointers and become *lens vectors* — directions in the BGE-M3 embedding space that the substrate has learned to favour. Multiple lenses → mixture-of-experts routing. `max` rather than `sum` so a miner cannot win by stacking 36 colinear lenses (see §6.4 lens-diversity floor for the structural guard against collapse).
2. **Anchor-exemplar bonuses (`MemoryIndex` slots).** `anchorBonus(d) = anchorWeight × maxOverActiveAnchors(cos(d.embedding, anchorTruthEmb_k))`. A MemoryIndex slot whose `recordId` resolves to a corpus event acts as an *exemplar anchor*; the anchor's truth doc embedding is the reference point. Same on-disk slot shape, reinterpreted role.
3. **Relation expansion (`Relations` region).** For each MemoryIndex anchor, BFS through the 128 relation entries up to `relationHopBudget` (default 2 hops). Add the truth docs of neighbouring corpus events to the candidate pool, capped at `relationExpansionBudget` docs per query (default 50). BFS edge ordering is fixed by relation-entry index — deterministic across hosts. **A relation edge survives decode only if its source and target MemoryIndex slots share `domainBits` (§6.4)** — closes the bridge-edge poisoning attack where a miner crafts arbitrary cross-domain edges to flood the pool with off-topic candidates.
4. **Temporal modulation (`Temporal` region).** When the query family is `temporal`, `temporalBonus(d) = +temporalCurrentBoost` if `d` is a current truth, `−temporalStaleSuppression` if `d` is a stale truth labelled by the substrate's Temporal records, else `0`. On non-temporal families, `temporalBonus = 0`.

After applying the formula, sort by `finalReorderingScore` descending. Ties broken by `(rerankerScore, docId)` lexicographically. This ordering is pinned by Test D (full-pipeline determinism).

**The reranker still runs.** Stage 2 does not pre-filter stage-1 output (which would discard candidates the substrate hadn't favoured); it adds substrate-driven candidates from relation expansion to the pool, then biases the rerank-output ranking via additive bonuses. Reranker is the dominant signal; the substrate is the policy steering it.

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

Each run produces a single deterministic artifact under `/var/lib/coretex/reports/`; together they pick the new `firstStageTopK`, the stage-2 weight scalars, and re-pin the acceptance thresholds. Sample sizes are sized for launch-pinned thresholds, not exploratory smoke.

### Run 0 — Stage-2 scalar sensitivity sweep (NEW)

Pick `lensWeight`, `anchorWeight`, and `relationExpansionBudget` before fixing K. Sweep each scalar across `{0, 0.25×default, default, 4×default}` against a fixed adversarial-and-honest patch mix on the calibration split. The empty-vs-engineered substrate gap (a proxy for §Run 3's headroom) must monotonically increase with scalar, then plateau. Pick the scalar at the elbow — beyond it, substrate dominates and overfits to visible split; below it, substrate barely matters.

Output: `reports/stage2-scalar-sweep.json`. Pins `lensWeight`, `anchorWeight`, `relationExpansionBudget` in the bundle profile.

### Run 1 — `firstStageTopK` sweep — per-stratum, worst-case bound

Compute stage-1 recall@K on the calibration split for K ∈ {50, 100, 200, 400, 800, 1600, 3200}. Critically, report recall@K **broken down by (family × causalDepth × relationHopDepth) stratum**, not just the global average — a global recall@K = 0.95 can hide a long-horizon-depth-3 stratum at recall = 0.6.

**Selection rule:** pick the smallest K where the **worst stratum** (with population ≥ 100 events) has recall@K ≥ 0.90. The global average follows for free.

Expected outcome: K is in the 200-800 range for BGE-M3 on this corpus shape; worst-stratum coverage may push K up by a factor of 4-8× over what global-average selection would have chosen. That cost is real and budgeted in Test I — better to know it now than discover it on launch when miners with corpus-rare-stratum patches systematically fail to gain credit.

Output: `reports/first-stage-topk-sweep.json` with full per-stratum recall@K matrix. Pinned `firstStageTopK` enters the bundle profile.

### Run 2 — Baseline-noise sanity under the new pipeline

Run the new scorer end-to-end on the calibration split with an **empty substrate** (all slots zero except mandatory header). Repeat across **N ≥ 50 independently-seeded hidden packs** — the value pinned as `baselineVariancePpm` is the launch acceptance floor, so its confidence interval must be tight (N=10 produces ±20% CI on σ — too loose).

Measure σ of composite. Compare against the May 15 value written by `calibrate.mjs` step 5 (which was measured against the bookmark scorer and is incorrect for the new pipeline).

Output: `reports/baseline-variance-new-pipeline.json` with the σ distribution and 95% CI. Updates `bundle-profile.json`.

### Run 3 — Per-family lift curve (feasible upper bound)

For each query family (`near_collision`, `temporal`, `long_horizon`, `multi_hop_relation`), measure the composite score gap between `empty_substrate` and a `feasible_upper_bound_substrate`. The upper bound is **constrained by actual slot geometry** — 44 MemoryIndex slots, 36 RetrievalKey slots, 128 relation entries, 12 Temporal records — not "every truth doc as an anchor" (which is infeasible at 44 slots and would produce a misleading lift number).

Construct the feasible upper bound by solving: maximise composite over substrates that satisfy the slot inventory, given a candidate pool of (event-id, anchor-truth-emb) pairs drawn from the calibration split. A simple greedy is fine for the upper bound; perfection isn't needed, only "the most a substrate can plausibly do within slot budget."

If any family's headroom is < 2 × `baselineVariancePpm`, the family weight is too small relative to noise. Note the constraint: `assertValidWeights` enforces `w_retrieval ≥ 0.7` and `sum = 1.0`. If multiple families have low headroom, the available weight to redistribute is bounded — surface to operator and re-think rather than auto-tune.

Output: `reports/per-family-headroom.json`. May trigger a one-time `compositeWeights` adjustment.

### Run 4 — `minImprovementPpm` floor recalibration (1000+ patches, varied surface)

Take the current `minImprovementPpm = 2500` and stress-test under the new pipeline. Generate **N ≥ 1,000 patches** across four patch-surface buckets (lens-only, anchor-only, relation-only, mixed) × four parent-substrate buckets (empty, calibration-pinned, evolved, adversarial). Measure false-accept rate (patches that should not have advanced but did) and false-reject rate (patches that genuinely move composite but get rejected). Sweep `minImprovementPpm ∈ {500, 1000, 2500, 5000}` for the same patch set.

**Include adaptive adversarial patches** — not just random. For each parent-substrate bucket, run 100-step hill-climbing search over patches with the objective `maximize composite(visible_split)`. Measure how well those hill-climbed patches generalize to the hidden split. Patches that overfit visible → fail hidden test reveal the *gameability* dimension of the threshold choice. Pick the smallest threshold whose false-accept rate on hill-climbed patches is ≤ 1%, not just on random patches.

Output: `reports/min-improvement-sweep.json` with both random and hill-climbed acceptance curves.

### Run 5 — Optional: dual-pack vs k-of-N study

If after Run 4 the false-reject rate at acceptable thresholds is still too high, switch the acceptance function from AND-of-2 to **median-of-4 ≥ T** or **k-of-N** (specifically: N=4 packs, accept if ≥3 of 4 clear `minImprovementPpm + replayTolerancePpm`). Cost: 4× per-patch eval, paid by the coordinator. Per-family catastrophic floors stay per-pack AND — a patch that destroys multi-hop on 1 of 4 packs is still a regression.

**Do not move to mean-of-N as the production rule.** Mean is too forgiving of outlier packs and obscures regression signals. Median or k-of-N preserves the regression guards.

This run is conditional. If Run 4 produces an acceptable threshold under AND-of-2, skip Run 5.

Output (conditional): `reports/acceptance-rule-study.json` + a bundle-profile change to `acceptanceRule = "k-of-N"` with `N=4`, `k=3`.

### Calibration threat model (one paragraph)

The pinned scalars (`firstStageTopK`, `baselineVariancePpm`, `lensWeight`, `anchorWeight`, `relationExpansionBudget`, `minImprovementPpm`) leak some corpus structure: a low K signals an "easy" corpus where truths are clustered, a low σ signals stable stage-1 retrieval, etc. This leakage is bounded — single-scalar summaries of distributions, not individual queries or qrels. Document the leak in the calibration write-down and confirm no scalar leaks individual hidden-pack content.

## 6. Code changes (concentrated PR)

### 6.1 New: `PublicCorpusIndex` + `firstStageCandidates` (type-separated, label-free)

```ts
// packages/cortex/src/eval/public-corpus-index.ts
import type { ProductionCorpus, RetrievalKeyLayout } from './retrieval-corpus.js';

export interface PublicCorpusDoc {
  readonly id: string;          // canonical doc id (deduped)
  readonly eventId: string;
  readonly embedding: Uint8Array;
}

export interface PublicCorpusIndex {
  readonly biEncoderModelId: string;
  readonly biEncoderRevision: string;
  readonly layout: RetrievalKeyLayout;
  readonly docs: readonly PublicCorpusDoc[];   // sorted by canonical id
}

export function buildPublicCorpusIndex(corpus: ProductionCorpus): PublicCorpusIndex;

export function firstStageCandidates(
  queryVec: Float32Array,
  index: PublicCorpusIndex,
  k: number,
): readonly PublicCorpusDoc[];
```

Implementation:
- `buildPublicCorpusIndex` iterates `corpus.events[*].embeddings.{perTruth,perNegative}`, deduplicates by canonical doc id (a doc id reused as hard negative across events appears once), pins `eventId = first event id that referenced this doc in deterministic event-iteration order`. Returns a sorted `PublicCorpusDoc[]` so cross-host indexing is byte-identical.
- `firstStageCandidates` linear-scans the index, partial-sorts to Top-K by cosine.
- The label-free signature is enforced at compile time: the retriever cannot import `corpus.events[*].qrels` or `corpus.events[*].truthDocuments` because it never sees the `ProductionCorpus` type. Replay validator code can still load both `ProductionCorpus` (for scoring labels) and `PublicCorpusIndex` (for retrieval); they coexist via different APIs.

Performance: 679 k events deduped to ~3 M unique docs × 243-byte int8 cosine = ~3 M cosines per query at ~30-50 ms per query single-core. Pack-level cache (§6.7) amortizes; per-submit cost is dominated by reranker, not stage 1.

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
  readonly pipelineVersion: 'coretex-retrieval-v2-lens';  // NEW — pin pipeline shape
  readonly firstStageTopK: number;                         // NEW — calibrated per-stratum
  readonly lensWeight: number;                             // NEW — calibrated by Run 0
  readonly anchorWeight: number;                           // NEW — calibrated by Run 0
  readonly relationExpansionBudget: number;                // NEW — calibrated by Run 0
  readonly relationHopBudget: number;                      // NEW — default 2
  readonly lensDiversityFloor: number;                     // NEW — see §6.4
  readonly temporalCurrentBoost: number;                   // NEW — calibrated
  readonly temporalStaleSuppression: number;               // NEW — calibrated
  readonly corpusDocDedupe: 'canonical-doc-id';            // NEW — pinned algorithm
  // existing fields unchanged
}
```

All values pinned by calibration Run 0 + Run 1. `scoreSubstrateAgainstQuery` consumes them via `ScoringOptions`. `pipelineVersion` enters the canonical bundle JSON so replay watchers route to the matching code path.

### 6.4 Substrate-level structural guards (lens diversity + relation domain-sharing)

Both fixes close attacks the new continuous pipeline opens that the bookmark scorer didn't.

**Lens-vector collapse guard.** A miner can set all 36 RetrievalKey lens vectors to the same direction (the average visible-query BGE-M3 embedding) — a degenerate local optimum that collapses the mixture-of-lenses into a single bias direction. To prevent this becoming an early dominant strategy:

```ts
// during decode, in retrieval-decoder.ts
function checkLensDiversity(retrievalKeys: DecodedRetrievalKey[], floor: number): boolean {
  const active = retrievalKeys.filter(k => k && k.active);
  if (active.length < 2) return true;
  let pairs = 0; let sum = 0;
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      sum += cosineSimilarity(active[i].vec, active[j].vec);
      pairs++;
    }
  }
  return (sum / pairs) <= floor;     // mean pairwise cosine below floor
}
```

A substrate that violates this floor fails structural-validity at decode time → `code: 'rejected'` opaque envelope (no score-correlated leakage). `lensDiversityFloor` calibrated by Run 0 against the per-family headroom; typical value ~0.7.

**Relation edge domain-share predicate.** A relation edge survives decode only if its source and target MemoryIndex slots share `domainBits` (the 60-bit domain marker already encoded in `MemoryIndexSlot`):

```ts
// during decode, in retrieval-decoder.ts:decodeRelations
function relationEdgeValid(edge: RelationEntry, memoryIndex: DecodedMemoryIndex[]): boolean {
  const src = memoryIndex[edge.sourceMemorySlot];
  const tgt = memoryIndex[edge.targetMemorySlot];
  if (!src || !tgt) return false;
  return (src.domainBits & tgt.domainBits) !== 0n;   // at least one domain shared
}
```

Edges that fail the predicate are dropped during decode rather than causing rejection — the substrate is otherwise valid; the offending edge simply doesn't contribute to BFS expansion. This closes the bridge-edge poisoning attack (miner declares anchors from unrelated domains as "neighbours" to flood the reranker with off-topic candidates).

Both guards are substrate-level invariants, not score gradients. Miners learn from a structural-rejection (the one wire-level diagnostic the design already allows) that their substrate has lens-collapse or invalid edges; they get no information about the hidden pack.

### 6.5 `retrievalKeyTopK` rename to `lensTopK`

In the new pipeline, `retrievalKeyTopK` no longer caps candidate events — stage 1 picks K candidate docs from the full corpus regardless of substrate state. Rename to `lensTopK` to make the semantics clear: it caps how many lens vectors contribute to stage-2 reweighting per query.

### 6.6 Pipeline-version pin: v2 only, v1 dropped

`EvaluatorProfile.pipelineVersion = 'coretex-retrieval-v2-lens'`. The bookmark-cache v1 is dropped entirely from production — pre-launch there are no historical state advances to replay, so v1 has no preservation value. Single code path, single bundle, single replay shape. Cleaner audit.

### 6.7 Pack-level stage-1 cache (mandatory)

Stage-1 Top-K depends only on `(queryVec, publicIndex, K)` — substrate-agnostic. The coordinator MUST cache stage-1 results per `(epochId, packId, queryId)` so dual-pack scoring of N candidate patches under the same parent reuses the same Top-K rather than recomputing 3 M cosines × 128 queries × N patches.

```ts
// packages/cortex/src/coordinator/stage1-cache.ts
export interface Stage1Cache {
  get(epochId: number, packId: string, queryId: string): PublicCorpusDoc[] | undefined;
  set(epochId: number, packId: string, queryId: string, docs: readonly PublicCorpusDoc[]): void;
  invalidate(epochId: number): void;   // call on epoch transition
}
```

Without this cache, per-`/coretex/submit` CPU explodes and the coordinator becomes the DoS surface. With it, only the *first* submit in a pack pays the 3-M-cosine cost; subsequent submits reuse the Top-K. Cache invalidation is bound to epoch transitions (when `packId` changes deterministically via the future blockhash). Cache size is bounded: 2 packs × 128 queries × 200-800 docs/query × ~16 bytes per `PublicCorpusDoc` reference = ~4 MB per epoch. Negligible.

Test I (§7) pins the p99 latency budget against this caching assumption.

### 6.8 Miner self-eval harness — byte-identical to coordinator

Add `scripts/coretex-eval.mjs` (or extend `mining-flow-e2e.mjs --mode self-eval`) that runs the full pipeline against the **visible split** with a candidate patch:

```bash
node scripts/coretex-eval.mjs \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
  --parent-state-root 0x... \
  --patch ./candidate.json \
  --split visible
```

Output: full composite breakdown (nDCG, per-family delta, structural validity, expected envelope class). This is how miners author targeted patches without learning anything about the hidden pack — they self-diagnose against public data using the **same code path** the coordinator runs.

**Hard requirement: byte-identical parity with the coordinator's scorer.** The harness is a thin wrapper around the same `evaluateRetrievalBenchmarkState` the coordinator calls. Same `EvaluatorProfile`, same models, same `PublicCorpusIndex`. Test K (§7) asserts byte-identical `CompositeScore` output between the harness and the coordinator on the same `(parent, patch, query)` triple. If the harness ever diverges from the coordinator, miners self-diagnose against the wrong target — that is a launch-blocking class of bug.

This is **not** a rejection-envelope change. The HTTP shim's opaque rejection envelope stays. The two narrow exceptions already in `live-eval-admission.ts` (`structurally-invalid`, `malformed-input`) are not score gradients — keep them in the wire response. Everything score-correlated collapses to `code: 'rejected'`.

## 7. Final validation tests (gap-closure proof)

These tests prove the gap is actually closed and CoreTex still runs correctly under the new substrate layout + bi-encoder integration. Each one writes a single deterministic report into `/var/lib/coretex/reports/`.

### Test A — `score(empty_substrate)` is the BGE-M3 baseline

For 100 random queries across all families, compute composite with substrate fully zeroed except header. Compare against composite computed by running stage 1 alone with no stage 2. The two numbers must match to within `replayTolerancePpm = 250`. If they don't match, stage 2 is leaking value into the empty case (e.g., zero substrate is being interpreted as a non-trivial lens).

### Test B — `score(empty_substrate) < score(non_empty)` on hard families

For each family, generate a hand-crafted reasonable substrate (anchor exemplars + lens vectors + relation edges that match the family's structure). Composite must exceed the empty-substrate baseline by at least 2 × `baselineVariancePpm` on that family. If a family's headroom is < 2σ, the substrate has no measurable effect there — design issue, not test issue, surface to operator.

### Test C — Stage 1 never reads qrels

Static check: grep `firstStageCandidates` callsite to confirm only `{ queryVec, corpus, K }` arguments. Runtime check: instrument `corpus.events[*].qrels` access during a stage-1-only run, assert zero reads.

### Test D — Full-pipeline byte-identical determinism (stage 1 + stage 2)

For a fixed `(queryVec, publicIndex, decoded_substrate, K)`, the **complete pipeline output** (stage-1 Top-K → stage-2 expanded pool → reranker scores → `finalReorderingScore` ranking → composite metrics) must be byte-identical across hosts. Run on host A, run on host B (or simulated AVX-2/AVX-512 dispatch), assert identical output at every stage boundary. Earlier tests covered only stage 1; stage 2's BFS expansion and lens-bonus application must also be deterministic — verify the relation-entry decode order, bonus accumulation order, and tie-break rules are stable.

### Test E — Patch incentive structure under random search

Generate ≥1,000 candidate patches via random search across the four patch-surface buckets (lens-only, anchor-only, relation-only, mixed). Run them through the new scorer against the launch bundle + visible split. Measure: how many produce composite > `minImprovementPpm`? Of those, what fraction also pass the hidden pack (true-positive)? What fraction pass visible but fail hidden (over-fit)?

Acceptance: true-positive rate ≥ 90%, over-fit rate ≤ 10%. If over-fit is high, the visible/hidden split sampling needs work or the substrate is encoding visible-pack-specific patterns rather than generalizable retrieval policy.

### Test E' — Adversarial-patch set (NEW)

Random patches cover the easy case. Real miners use objective-driven search; the test matrix must cover adaptive adversaries explicitly. Construct a fixed adversarial set with deterministic expected outcomes:

| Pattern | Expected outcome |
|---|---|
| Single-direction lens collapse (all 36 lenses colinear) | structural-validity reject (lens-diversity floor) |
| Bridge-edge relation poisoning (cross-domain edges) | edges dropped at decode; composite delta within `replayTolerancePpm` of empty substrate (i.e., poisoning has no effect) |
| High-density anchor stuffing on visible-split-only events | small visible-lift, failure to generalize to hidden pack (composite delta within noise) |
| 100-step hill-climbing on visible split (maximize composite) | the hill-climbed patch must fail the hidden pack at ≥ 50% rate — otherwise visible/hidden split sampling is leaky |
| Zero relations, max anchors | structural valid; small lift; acts as baseline upper bound |
| Max relations, zero anchors | structural valid; small lift; relation-only expansion test |

Each adversarial pattern must produce a deterministic accept/reject (or deterministic small-lift within ±2σ). "Sometimes accepts" outcomes are launch-blockers — they indicate the acceptance rule is too sensitive to pack variance.

### Test F — Full Phase 13 against new pipeline, 25 iterations

Re-run `test/e2e/phase-13/run.mjs --iterations 25` against the new bundle. Same acceptance criteria as today: mix of accepts (deltaPpm > `minImprovementPpm`) and rejects (`no_retrieval_improvement`, `family_catastrophic`, etc.). Compare the accept/reject ratio to the May 10 Phase 13 baseline. The new pipeline should show a similar shape — most random patches reject, engineered patches accept.

### Test G — Mining-flow e2e produces all three buckets

Re-run `scripts/mining-flow-e2e.mjs --mode live` against the new bundle. Confirm:
- `screener_reject` observed (opaque envelope)
- `screener_pass_no_advance` observed (accepted but no on-chain receipt)
- `state_advance` observed (accepted + receipt)

Persist fixtures, run replay mode, assert byte-identical envelopes.

### Test H — Base fork rehearsal

`scripts/base-fork-rehearsal.mjs --bundle-manifest <new bundle> --fixtures <new fixtures>` spins anvil on a Base mainnet fork at the pinned addresses, impersonates the coordinator signer, submits `BotcoinMiningV4.submitWorkReceipt` from a `state_advance` fixture. Confirms the on-chain integration shape is unaffected by the scorer refactor.

### Test I — Per-submit p99 latency budget (NEW)

Mining-flow throughput must hold at expected miner concurrency. Pin a budget:

| Operation | p99 budget | Rationale |
|---|---|---|
| `firstStageCandidates` over the launch index | 100 ms | linear-scan cosine over ~3 M docs |
| `scoreSubstrateAgainstQuery` (cached stage-1) | 250 ms | dominated by Qwen3 reranker |
| Full `/coretex/submit` (one patch, dual pack) | 8 s | 2 packs × 128 queries × 250 ms / parallelism |
| Coordinator capacity under sustained 1 submit/s/miner | ≥ 50 concurrent miners | rate-limit ceiling matches measured capacity |

Test runs 1,000 mining-flow submits with cache warm + cache cold; report p50/p95/p99 across each stage. If p99 exceeds budget, the fallback is one of: smaller `firstStageTopK` (worse retrieval, surface to operator), fewer queries per pack (more variance), or stricter rate limit (fewer concurrent miners). All are launch-affecting; better to know now than at launch.

### Test J — Adversarial gameability stress (NEW)

Run the adversarial set from Test E' against the coordinator with rate-limited submission (production limits). Measure cumulative information leakage over 1,000 sequential submits — can a miner triangulate the hidden pack's embedding centroid from accept/reject signals alone? Acceptance: the inferred centroid's cosine similarity to the true hidden centroid stays below `0.5 + replayTolerancePpm/1e6` after 1,000 submits. Triangulation faster than that exposes the lens-gradient probing surface (see §6.7's cache + rate-limit fallback).

### Test K — Miner-harness parity (NEW)

For 100 random `(parent_substrate, patch, query_event)` triples drawn from the visible split, run both the coordinator's `evaluateRetrievalBenchmarkState` and `scripts/coretex-eval.mjs`. Assert byte-identical `CompositeScore`, per-family deltas, structural-validity flag, and reranker scores. Any divergence is launch-blocking — it means miners self-diagnose against a different target than the coordinator scores against.

## 8. Order of operations

1. **Land Phase A code (§6.1-6.8).** PublicCorpusIndex + firstStageCandidates + scoreSubstrateAgainstQuery rewrite + EvaluatorProfile additions + lens-diversity + relation domain-share predicates + pack-level stage-1 cache + miner harness. Unit tests for each new helper. Existing 382 unit tests must still pass.
2. **Calibration Run 0.** Pin `lensWeight`, `anchorWeight`, `relationExpansionBudget` via the sensitivity sweep.
3. **Calibration Runs 1, 2.** Pin `firstStageTopK` (per-stratum worst-case ≥ 0.90) and `baselineVariancePpm` (N ≥ 50 packs).
4. **Calibration Runs 3, 4.** Per-family headroom (feasible-upper-bound), `minImprovementPpm` recalibration (≥ 1,000 patches, includes hill-climbing adversarial).
5. **Conditional Run 5.** Only if Run 4 leaves false-reject too high → switch acceptance to k-of-N median.
6. **Validation tests A-K.** Each produces a committed report; any failure blocks launch.
7. **Resume the Post-Corpus Playbook** from step 5 (calibrate) with the new scorer wired in; Phase 13 (playbook step 10) is the integration gate.
8. **Bundle bump.** Single `bundleHash` move with `pipelineVersion: 'coretex-retrieval-v2-lens'`. Pinned in the calibration write-down doc.
9. **Mainnet canary** per Post-Corpus Playbook step 16 (operator-gated, unchanged).

## 9. What this is not

- **Not** a corpus regeneration. The 678 k events stay; their pinned embeddings start carrying their weight.
- **Not** a substrate layout change. The 1024 words, 36+44+128+12+48 slot inventory, all unchanged.
- **Not** a bi-encoder / cross-encoder swap. Same BGE-M3 + Qwen3-Reranker-0.6B pins.
- **Not** a rejection-envelope rewrite. The opaque envelope is correct policy; the miner self-eval harness is the missing piece.
- **Not** a multi-pack switch. Calibrate variance first; multi-pack is a fallback if k-of-N at N=4 turns out to be needed.
- **Not** an "indefinite scalability" change. The 1024→2048 ladder remains a separate post-launch lever and is not in scope here.
- **Not** a decoder-semantics rewrite. Phase A keeps the substrate decoder unchanged — RetrievalKey slots are still vectors, MemoryIndex slots still point at recordIds, Relations still encode slot-to-slot edges. The reinterpretation happens entirely in the scorer's stage-2 logic. Phase B (deferred — §10) is where decoder semantics would change if needed.

## 10. Deferred to Phase B (post-launch substrate-reach lever)

Both audits flagged that even after Phase A lands, the substrate's "reach beyond stage 1" is bounded by 44 anchors × 128 relation edges × `relationHopBudget`. At launch with `firstStageTopK` properly per-stratum-calibrated (likely 200-800), this gives the substrate a few thousand reachable candidate docs per query — sufficient for the launch corpus shape (678 k events) and the launch difficulty curve. As corpus grows past 5-10 M events, the 44-anchor cap progressively shrinks the substrate's *fractional* reach into the corpus and the substrate becomes less differentiated from a thin bias over stage 1.

Phase B is the structural lever for that long term — but it is **not launch-blocking** and the calibration data needed to design it correctly only exists after Phase A runs in production:

- **Stage-1 candidates participate in BFS frontier.** Today, BFS expands only from MemoryIndex anchors. Phase B makes stage-1 candidates themselves valid BFS seeds, so the substrate's Relations region can amplify around docs the substrate didn't pre-anchor.
- **Relations as category lens, not slot-to-slot edges.** Today, each `RelationEntry` is `(sourceSlot, targetSlot, edgeType, weight)` — endpoints are MemoryIndex slot indices, capped at 44. Phase B reinterprets the entry as `(sourceSlot OR sourceCategory, edgeTypeFilter, weight)` — the substrate specifies *which categories of relation* to expand, and BFS walks the corpus's native `event.relations` annotation rather than miner-declared slot pairs. This makes Relations a policy over corpus-native graph structure that scales with the corpus rather than with the slot count.

Phase B trigger condition: when worst-stratum recall@K under `firstStageTopK` drops below 0.85 (one notch below the Phase A launch floor of 0.90) on a subsequent corpus-delta epoch. That signal is the substrate exhausting its current expressive ceiling and warrants the decoder-semantics work.

## 11. Corpus-growth recalibration cadence

`firstStageTopK`, `baselineVariancePpm`, and `lensDiversityFloor` are all sensitive to corpus distribution. As corpus deltas land each epoch (per `CORETEX_V4_INDEFINITE_SCALABILITY_HARDENING_PLAN.md`), per-stratum recall@K can shift — a corpus delta that adds many long-horizon events makes the long-horizon stratum's coverage at fixed K *worse*, not better. Three options:

1. **Per-corpus-delta recalibration.** Re-run Run 1 (per-stratum recall) every time the corpus root changes. Update `firstStageTopK` in the bundle when worst-stratum recall@K drops below 0.90. Pinned in the bundle profile as `firstStageTopKByCorpusSize: { '0-1M': 200, '1-3M': 400, '3-10M': 800, '10M+': 1600 }` — a sliding lookup keyed by corpus-event count.
2. **Per-epoch recalibration cadence.** Schedule a daily/weekly job (e.g., the `H3 daily-cron baseline recalibration` already in the backlog at task #22) to re-measure recall@K, σ, and headroom. Bump `firstStageTopK` if any threshold breached.
3. **Both.** Per-delta is the conservative reactive trigger; per-epoch cadence is the proactive baseline. Combined gives launch confidence.

Phase A pins the epoch-0 values. Phase A also pins the recalibration commitment — without it, Phase A is a single point in time that progressively degrades as corpus grows. Treat this as a launch-blocking commitment, not "we'll figure it out later."

## 12. References

- Auditor session, 2026-05-15 — *"the substrate has currently doing the bi-encoder's job, badly, against 36 prequantized vectors that miners must inscribe one event at a time."*
- `packages/cortex/src/eval/retrieval-benchmark.ts:140-219` — current `scoreSubstrateAgainstQuery` (the function being replaced).
- `packages/cortex/src/eval/retrieval-benchmark.ts:186-189` — the over-correction comment that motivated this gap.
- `docs/CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md:69` — the pin to MemReranker semantics (BGE-M3 Top-50/100 first-stage), which is the design this hardening restores.
- `specs/cortex_state_v0.md` — the substrate layout (unchanged by this plan).
- `docs/CORETEX_CROSS_SYSTEM_REPRODUCIBILITY_PROOF.md` — cross-CPU determinism guarantees that stage 1 inherits.
- MemReranker paper (`https://arxiv.org/html/2605.06132v1`) — the architectural prior this hardening aligns the scorer with.
