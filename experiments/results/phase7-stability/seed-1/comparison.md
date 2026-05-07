# Baselines comparison — CortexBench V0 (phase7-stability/seed-1)

Seed: 1  Epochs per baseline: 60  Generated: 2026-05-07T00:25:17.127Z

> Scorer: real CortexBench V0 (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.2588 | 0.2588 | 11/60 | 0.03 | 0x1ac363fb41d784... |
| B | dense-key | 0.0000 | 0.2308 | 0.2308 | 19/60 | 138.34 | 0x16caef1cb28f6f... |
| C | binary-key | 0.0000 | 0.2308 | 0.2308 | 19/60 | 138.12 | 0x8c7aa855f153cd... |
| D | late-interaction | 0.0000 | 0.0692 | 0.0692 | 5/60 | 137.43 | 0xcb93afc3a5575a... |
| E | revocation-aware | 0.0000 | 0.1179 | 0.1179 | 11/60 | 0.03 | 0xe31f6a75d13f07... |

## Winner

**Baseline A (empty)** — final composite 0.258824.

## Component breakdown (final state)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.769 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.769 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.231 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.400 | 0.386 | 0.000 | 0.000 |

## Family contribution (sum of accepted Δ per family)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.769 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.769 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.231 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.400 | 0.386 | 0.000 | 0.000 |

## Files

- `experiments/results/phase7-stability/seed-1/{A..E}.json` — per-baseline metrics
- `experiments/results/phase7-stability/seed-1/comparison.csv` — machine-readable
- `experiments/results/phase7-stability/seed-1/comparison.md` — this file
