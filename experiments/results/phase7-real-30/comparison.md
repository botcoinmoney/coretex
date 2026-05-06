# Baselines comparison — CortexBench V0 (phase7-real-30)

Seed: 42  Epochs per baseline: 30  Generated: 2026-05-06T09:31:28.056Z

> Scorer: real CortexBench V0 (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.2588 | 0.2588 | 11/30 | 0.04 | 0x689288f235004d... |
| B | dense-key | 0.0000 | 0.1941 | 0.1941 | 30/30 | 134.35 | 0x2caa54c6b558c1... |
| C | binary-key | 0.0000 | 0.1941 | 0.1941 | 30/30 | 131.68 | 0x27c16129a298da... |
| D | late-interaction | 0.0000 | 0.0529 | 0.0529 | 6/30 | 132.81 | 0xa6aa8529f26734... |
| E | revocation-aware | 0.0000 | 0.1178 | 0.1178 | 11/30 | 0.04 | 0x4254c290d996d4... |

## Winner

**Baseline A (empty)** — final composite 0.258824.

## Component breakdown (final state)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.647 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.647 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.176 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.382 | 0.404 | 0.000 | 0.000 |

## Family contribution (sum of accepted Δ per family)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.647 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.647 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.176 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.382 | 0.404 | 0.000 | 0.000 |

## Files

- `experiments/results/phase7-real-30/{A..E}.json` — per-baseline metrics
- `experiments/results/phase7-real-30/comparison.csv` — machine-readable
- `experiments/results/phase7-real-30/comparison.md` — this file
