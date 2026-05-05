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

- `candidateScore > baselineScore + 0.005` (threshold).
- `protectedRegressionCount === 0`.
- `patchSize ≤ 4` words.
- Evaluation reproducible byte-identically on a clean machine.

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
- **At merge**: evaluated on the FULL set (hard veto). A patch that drops any single protected anchor is rejected regardless of weighted score.

The screener-vs-merge subset trick is the mechanism that prevents protected-regression exploitation: the screener subset is not known to the miner before evaluation.

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
