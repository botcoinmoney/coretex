# Baselines comparison — CoreTex pre-launch (phase7-stability/seed-99)

Seed: 99  Epochs per baseline: 60  Generated: 2026-05-07T00:27:48.744Z

> Scorer: real CoreTex pre-launch (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.2588 | 0.2588 | 11/60 | 0.04 | 0x583256b19c0f91... |
| B | dense-key | 0.0000 | 0.2308 | 0.2308 | 19/60 | 141.28 | 0x8692c5dfbd571f... |
| C | binary-key | 0.0000 | 0.2308 | 0.2308 | 19/60 | 139.69 | 0xe77fa7679a6c47... |
| D | late-interaction | 0.0000 | 0.0692 | 0.0692 | 5/60 | 140.19 | 0x1912fdcf02a8b8... |
| E | revocation-aware | 0.0000 | 0.1179 | 0.1179 | 11/60 | 0.04 | 0x0897acfaed8ecb... |

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

- `experiments/results/phase7-stability/seed-99/{A..E}.json` — per-baseline metrics
- `experiments/results/phase7-stability/seed-99/comparison.csv` — machine-readable
- `experiments/results/phase7-stability/seed-99/comparison.md` — this file
