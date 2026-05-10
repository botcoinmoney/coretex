# CortexBench V0 — Public Summary

High-level summary for external readers. Canonical: [`../benchmark/cortex_bench_v0.md`](../benchmark/cortex_bench_v0.md).

## Anchored sources

CortexBench V0 is anchored to **published, license-verified benchmarks**. We do not invent task families.

| Family                                | Weight | Sources                                                             |
|---------------------------------------|--------|---------------------------------------------------------------------|
| Long-horizon compression              | 60%    | MemoryArena (CC-BY-4.0) + synthetic stream-and-evict generator      |
| Near-collision retrieval              | 20%    | LIMIT (CC-BY-4.0) + BEIR/NQ (Apache-2.0) + BEIR/HotpotQA (CC-BY-SA-4.0) |
| Temporal update / revocation          | 20%    | MemoryAgentBench (MIT). LoCoMo deferred — see issue #4.             |

License audit: [`../specs/license_audit.md`](../specs/license_audit.md).

## Score formula

Per-component scores ∈ [0, 1]; composite is a weighted sum minus a latency penalty:

```
S = 0.30 · exact_retrieval
  + 0.15 · stale_memory_rejection
  + 0.15 · temporal_update_correctness
  + 0.30 · compression_survival
  + 0.05 · routing_accuracy
  - latency_penalty(latency_ms, p50=10, p99=50)

Hard vetoes (override S): state-size violation; protected-regression drop.
```

A patch is accepted iff:

- `scoreDelta >= adaptiveThreshold`, where `adaptiveThreshold` is derived from current baseline score, remaining headroom, and the recent noise floor.
- `protectedRegressionCount === 0`.
- `patchSize ≤ 4` words.
- Evaluation reproducible byte-identically on a clean machine.

## Local model-assisted eval for elevated proposals

The deterministic score above is the consensus-safe structural gate: it checks
whether CortexState encodes the right memory handles for the committed corpus.
For elevated production proposals, operators may enable an additional empirical
gate:

```bash
CORTEX_LOCAL_MODEL_EVAL=1
CORTEX_LOCAL_MODEL=Xenova/multi-qa-MiniLM-L6-cos-v1
```

This runs a small local open-weight embedding model through
`@huggingface/transformers`. The evaluator converts active CortexState memory
handles back into candidate corpus texts, embeds each benchmark query and
candidate memory text, and counts a hit when the correct memory ranks first.

This layer answers the question the structural gate intentionally avoids:
does the improved memory index make the right memory content more retrievable
for an actual model? It is not a replacement for deterministic replay; it is a
fast sidecar gate for proposals that already passed the consensus-safe scorer.

In production the local model gate is on by default. Set
`CORTEX_LOCAL_MODEL_EVAL=0` only for operator drills where no rewards can be
issued. A production state advance must:

- pass the deterministic structural CortexBench scorer;
- pass the MiniLM no-regression gate across model-facing components;
- satisfy `CORTEX_LOCAL_MODEL_MIN_DELTA` (default `0`, meaning equality is
  acceptable and any positive improvement is accepted);
- emit credits through the normal BOTCOIN receipt path only after both gates
  pass.

## Patch budget rationale

V0 keeps the patch budget at **1-4 words**. This does limit the size of a
single improvement, but that is intentional for production:

- small patches make attribution clean: one state advance, one miner, one
  measured delta;
- small patches keep calldata, replay, and Merkle updates cheap;
- small patches reduce scorer gaming by forcing miners to expose incremental
  improvements instead of bundling many unrelated changes;
- small patches reduce conflict and make stale-parent rebasing simple;
- miners can still submit multiple improvements across the 24-hour epoch,
  because live state advances happen mid-epoch.

Larger "macro patches" should be a V1 feature only after testnet data shows
the model gate remains reliable at larger word counts. The expected design is
not simply "raise 4 to 16"; it is a separate macro-patch lane with stronger
model eval, stricter non-regression, higher calldata limits, and separate
attribution rules.

## Pass-rate targets

| Miner type     | Target |
|----------------|--------|
| Random / no-op | ~0%    |
| Weak heuristic | 5–10%  |
| Strong         | 20–30% |

CI fails outside ±3% of bounds on the synthetic miner mix.

## Hidden shards (commit/reveal)

Each epoch's hidden seed `H_e` is committed on-chain at epoch start (mirrors `setEpochCommit`). Miner shards are derived as:

```
shardId = lower 128 bits of keccak(H_e ‖ miner ‖ epochId ‖ solveIndex ‖ parentStateRoot ‖ rulesVersion)
```

with `rulesVersion = 0xC0`. `H_e` is revealed at epoch end. Auditors then re-derive every shard.

## Protected-regression set

~50 anchored items per family, frozen at corpus snapshot.

- **At screener**: evaluated on a small RANDOM subset (cost optimization). The random subset is drawn deterministically from the epoch seed.
- **At live state advance**: evaluated on the FULL set (hard veto). A patch that drops any single protected anchor is rejected regardless of weighted score.

The screener-vs-state-advance subset trick is the mechanism that prevents protected-regression exploitation: the screener subset is not known to the miner before evaluation.

## Saturation alarm

Median score-delta `< 1%` for `K=10` consecutive epochs triggers the alarm. Response: difficulty bump (tighten threshold, raise protected-regression strictness, shrink patch budget) or family-weight adjustment (governance decision; published in a new `cortex_bench_v0.md` revision).

## License caveats

- **LoCoMo**: CC-BY-NC-4.0 — incompatible with commercial mining. Deferred. See [issue #4](../../issues/4).
- **BEIR/MSMARCO** and **BEIR/TREC-COVID**: commercial-use license review pending. V0 uses NQ (Apache-2.0) and HotpotQA (CC-BY-SA-4.0) only.
- **MemoryArena**: HuggingFace dataset (CC-BY-4.0) confirmed; code repo URL pending upstream confirmation.

## Why the benchmark is the whole game

A bad benchmark creates a bad organism. CortexBench is anchored to LIMIT / MTEB / LoCoMo / MemoryAgentBench / MemoryArena because each tests a distinct property that cannot be faked:

- Near-collision retrieval tests whether keys discriminate similar-but-distinct items.
- Temporal update tests whether the codec tracks what is stale.
- Long-horizon compression tests whether the codec survives capacity pressure over many sessions — and crucially, **does not saturate** as the codec improves. That is why it carries the dominant 60% weight.
