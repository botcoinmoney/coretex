# Baselines comparison — CortexBench V0 (phase7-stability/seed-7)

Seed: 7  Epochs per baseline: 60  Generated: 2026-05-06T09:33:44.397Z

> Scorer: real CortexBench V0 (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.2588 | 0.2588 | 11/60 | 0.04 | 0xc5ea19d40fdd6d... |
| B | dense-key | 0.0000 | 0.2118 | 0.2118 | 33/60 | 133.21 | 0xe70e35bee93e87... |
| C | binary-key | 0.0000 | 0.2118 | 0.2118 | 33/60 | 132.95 | 0xd55d7bb39ab782... |
| D | late-interaction | 0.0000 | 0.0529 | 0.0529 | 6/60 | 133.82 | 0xf5c65f38b40259... |
| E | revocation-aware | 0.0000 | 0.1178 | 0.1178 | 11/60 | 0.04 | 0xbc7680cbabc3c6... |

## Winner

**Baseline A (empty)** — final composite 0.258824.

## Component breakdown (final state)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.706 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.706 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.176 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.382 | 0.404 | 0.000 | 0.000 |

## Family contribution (sum of accepted Δ per family)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.706 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.706 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.176 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.382 | 0.404 | 0.000 | 0.000 |

## Files

- `experiments/results/phase7-stability/seed-7/{A..E}.json` — per-baseline metrics
- `experiments/results/phase7-stability/seed-7/comparison.csv` — machine-readable
- `experiments/results/phase7-stability/seed-7/comparison.md` — this file
