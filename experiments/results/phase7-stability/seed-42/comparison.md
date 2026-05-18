# Baselines comparison — CoreTex pre-launch (phase7-stability/seed-42)

Seed: 42  Epochs per baseline: 60  Generated: 2026-05-07T00:26:57.931Z

> Scorer: real CoreTex pre-launch (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.2588 | 0.2588 | 11/60 | 0.03 | 0x689288f235004d... |
| B | dense-key | 0.0000 | 0.2423 | 0.2423 | 20/60 | 140.30 | 0xcb5b5bc04e8a62... |
| C | binary-key | 0.0000 | 0.2423 | 0.2423 | 20/60 | 137.42 | 0xeb2cf8f2b851ee... |
| D | late-interaction | 0.0000 | 0.0692 | 0.0692 | 5/60 | 137.89 | 0x0f5d201740d762... |
| E | revocation-aware | 0.0000 | 0.1178 | 0.1178 | 11/60 | 0.04 | 0x4254c290d996d4... |

## Winner

**Baseline A (empty)** — final composite 0.258824.

## Component breakdown (final state)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.808 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.808 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.231 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.382 | 0.404 | 0.000 | 0.000 |

## Family contribution (sum of accepted Δ per family)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.808 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.808 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.231 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.382 | 0.404 | 0.000 | 0.000 |

## Files

- `experiments/results/phase7-stability/seed-42/{A..E}.json` — per-baseline metrics
- `experiments/results/phase7-stability/seed-42/comparison.csv` — machine-readable
- `experiments/results/phase7-stability/seed-42/comparison.md` — this file
