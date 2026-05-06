# Baselines comparison — CortexBench V0 (phase7-stability/seed-99)

Seed: 99  Epochs per baseline: 60  Generated: 2026-05-06T09:35:20.293Z

> Scorer: real CortexBench V0 (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.2588 | 0.2588 | 11/60 | 0.04 | 0x583256b19c0f91... |
| B | dense-key | 0.0000 | 0.2118 | 0.2118 | 33/60 | 132.65 | 0x8ed92f20043d40... |
| C | binary-key | 0.0000 | 0.2118 | 0.2118 | 33/60 | 131.71 | 0xe6069c71868553... |
| D | late-interaction | 0.0000 | 0.0529 | 0.0529 | 6/60 | 131.66 | 0xd429c3a0887fac... |
| E | revocation-aware | 0.0000 | 0.1179 | 0.1179 | 11/60 | 0.04 | 0x0897acfaed8ecb... |

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

- `experiments/results/phase7-stability/seed-99/{A..E}.json` — per-baseline metrics
- `experiments/results/phase7-stability/seed-99/comparison.csv` — machine-readable
- `experiments/results/phase7-stability/seed-99/comparison.md` — this file
