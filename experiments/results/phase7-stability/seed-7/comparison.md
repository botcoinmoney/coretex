# Baselines comparison — CortexBench V0 (phase7-stability/seed-7)

Seed: 7  Epochs per baseline: 60  Generated: 2026-05-07T00:26:07.316Z

> Scorer: real CortexBench V0 (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.2588 | 0.2588 | 11/60 | 0.03 | 0xc5ea19d40fdd6d... |
| B | dense-key | 0.0000 | 0.2308 | 0.2308 | 19/60 | 138.06 | 0x7ee4a00b73c554... |
| C | binary-key | 0.0000 | 0.2308 | 0.2308 | 19/60 | 137.32 | 0xece040c71c611c... |
| D | late-interaction | 0.0000 | 0.0808 | 0.0808 | 6/60 | 138.82 | 0x1f8426c958be17... |
| E | revocation-aware | 0.0000 | 0.1178 | 0.1178 | 11/60 | 0.03 | 0xbc7680cbabc3c6... |

## Winner

**Baseline A (empty)** — final composite 0.258824.

## Component breakdown (final state)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.769 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.769 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.269 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.382 | 0.404 | 0.000 | 0.000 |

## Family contribution (sum of accepted Δ per family)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.863 | 0.000 |
| B | 0.769 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.769 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.269 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.382 | 0.404 | 0.000 | 0.000 |

## Files

- `experiments/results/phase7-stability/seed-7/{A..E}.json` — per-baseline metrics
- `experiments/results/phase7-stability/seed-7/comparison.csv` — machine-readable
- `experiments/results/phase7-stability/seed-7/comparison.md` — this file
