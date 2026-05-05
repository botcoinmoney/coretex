# CortexBench V0

> Phase 4 deliverable. Skeleton — Benchmark subagent fills in §§ 2–6.

## 1. Anchored sources

| Family                                | Anchored on                                                                |
|---------------------------------------|----------------------------------------------------------------------------|
| Long-horizon compression (60%)        | MemoryArena (multi-session loops) + synthetic stream-and-evict generator    |
| Near-collision retrieval (20%)        | LIMIT + MTEB Retrieval / BEIR subsets                                       |
| Temporal update / revocation (20%)    | LoCoMo + MemoryAgentBench temporal subset                                   |

Each loader produces an `experienceCorpusRoot` that re-derives byte-identically from the published source files; CI fetches sources via pinned hashes.

## 2. Score formula

```
+ exact retrieval                w = 0.30
+ stale-memory rejection         w = 0.15
+ temporal update correctness    w = 0.15
+ compression survival           w = 0.30
+ routing accuracy               w = 0.05
- latency penalty                w = 0.025  (subtracted)
state-size compliance            hard veto, not weighted
protected-regression set         hard veto on any drop in the protected anchors
```

Patch valid iff:
- `candidateScore > baselineScore + threshold`
- `protectedRegression == 0` on the protected anchor set
- `patchSize <= budget`
- evaluation reproducible byte-identically on a clean machine

## 3. Hidden shards (commit/reveal)

Per-epoch hidden seed `H_e` committed on-chain at epoch start (mirrors `setEpochCommit` in `epoch.ts:168`). Miner's assigned shard = `keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot)`, derived through the existing `deriveWorldSeedU128(...)` (`epoch.ts:257`). `H_e` revealed at epoch end (mirrors `revealEpochSecret`).

## 4. Protected-regression set

~50 anchored items per family, frozen at corpus snapshot. Evaluated **fully only at merge**; at screener, evaluated on a small random subset. Public-replay equivalence preserved because the merge-time evaluation is canonical.

## 5. Pass-rate targets

| Mix     | Target    |
|---------|-----------|
| random  | ~0%       |
| weak    | 5–10%     |
| strong  | 20–30%    |

CI fails outside ±3% of bounds on a synthetic miner mix.

## 6. Saturation alarm

Median score-delta < 1% for K=10 consecutive epochs triggers the alarm. Difficulty bump or family-weight adjustment follows.
