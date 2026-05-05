# Phase 7 Baselines — A through E

Per `ORGANISM_CORTEX_STATE_PLAN.md §9 Phase 7`.

## Overview

Five Cortex state seeds ("baselines") compete on CortexBench V0 to inform the
selection of Core V0. Each baseline defines:

- `genesisState()` — a deterministic state-seed factory that returns a
  `CortexState` with 1024 uint256 words.
- `mineCandidatePatch(state, shardDescriptor)` — a tiny heuristic miner that
  proposes a single candidate patch for the harness to evaluate head-to-head.

The harness (`experiments/harness/`) runs all five over the same seeds and
corpus and emits a comparison report.

**Placeholder winner**: Baseline E (revocation-aware) is designated the
placeholder winner per §9 Phase 7 until the user runs real iteration. See
`experiments/PHASE_7_USER_ACTIONS.md` for what to do next.

## Baselines

| ID | Name | Key feature |
|----|------|-------------|
| A  | Empty Cortex | All-zero state (control / floor) |
| B  | Dense-key Cortex | Header + fully-populated dense retrieval keys |
| C  | Binary-key Cortex | Header + binary-key retrieval keys (bit-level keys) |
| D  | Late-interaction Cortex | Multi-slot WARP-inspired multi-vector retrieval |
| E  | Revocation-aware Cortex | Populated temporal map + revocation bits (placeholder winner) |

## Metrics collected by the harness

For each baseline, per epoch:

- **retrieval accuracy** — fraction of exact-retrieval queries answered correctly
- **stale rejection** — fraction of stale records correctly rejected
- **compression survival** — score on long-horizon compression family
- **latency** — patch-eval wall time (p50 / p99)
- **patch sensitivity** — score delta per canonical patch family
- **overfit resistance** — synthetic single-family miners score below strong-miner band on composite

## Caveat

All baselines use the `StubCorpusLoader` (always returns 0.5) because the
LoCoMo license blocker (issue #4) is unresolved. Replace with a real corpus
loader once that is resolved. Scores in the dry-run are therefore **synthetic**
and reflect harness correctness, not real baseline quality.

## How to run

```bash
# Run all baselines over synthetic corpus, emit comparison report
node experiments/harness/compareBaselines.ts   # (requires ts-node or pre-build)

# Or, via the E2E gate on synthetic data:
node test/e2e/phase-7/run.mjs
```
