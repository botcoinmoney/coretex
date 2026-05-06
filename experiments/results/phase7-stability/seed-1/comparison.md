# Baselines comparison — CortexBench V0 (phase7-stability/seed-1)

Seed: 1  Epochs per baseline: 60  Generated: 2026-05-06T09:32:56.358Z

> Scorer: real CortexBench V0 (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.2588 | 0.2588 | 11/60 | 0.04 | 0x1ac363fb41d784... |
| B | dense-key | 0.0000 | 0.2118 | 0.2118 | 33/60 | 132.47 | 0x2896c2346c2a41... |
| C | binary-key | 0.0000 | 0.2118 | 0.2118 | 33/60 | 133.44 | 0xc3f0b3fe79c0f5... |
| D | late-interaction | 0.0000 | 0.0529 | 0.0529 | 6/60 | 137.42 | 0xe2b6e409a0a83f... |
| E | revocation-aware | 0.0000 | 0.1179 | 0.1179 | 11/60 | 0.04 | 0xe31f6a75d13f07... |

## Winner

**Baseline A (empty)** — final composite 0.258824.

## Component breakdown (final state)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.706 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.706 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.176 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.400 | 0.386 | 0.000 | 0.000 |

## Family contribution (sum of accepted Δ per family)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.706 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.706 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.176 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.400 | 0.386 | 0.000 | 0.000 |

## Files

- `experiments/results/phase7-stability/seed-1/{A..E}.json` — per-baseline metrics
- `experiments/results/phase7-stability/seed-1/comparison.csv` — machine-readable
- `experiments/results/phase7-stability/seed-1/comparison.md` — this file
