# Baselines comparison — CortexBench V0 (phase7-stability/seed-1234)

Seed: 1234  Epochs per baseline: 60  Generated: 2026-05-06T09:36:08.040Z

> Scorer: real CortexBench V0 (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.2588 | 0.2588 | 11/60 | 0.04 | 0xffbba48b40b347... |
| B | dense-key | 0.0000 | 0.2118 | 0.2118 | 33/60 | 131.86 | 0xbcc4016de4bba1... |
| C | binary-key | 0.0000 | 0.2118 | 0.2118 | 33/60 | 131.54 | 0x8b35cd07d242be... |
| D | late-interaction | 0.0000 | 0.0529 | 0.0529 | 6/60 | 132.45 | 0xc893aeb4a26e3b... |
| E | revocation-aware | 0.0000 | 0.1179 | 0.1179 | 11/60 | 0.04 | 0xb75a3aeaaeff5f... |

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

- `experiments/results/phase7-stability/seed-1234/{A..E}.json` — per-baseline metrics
- `experiments/results/phase7-stability/seed-1234/comparison.csv` — machine-readable
- `experiments/results/phase7-stability/seed-1234/comparison.md` — this file
