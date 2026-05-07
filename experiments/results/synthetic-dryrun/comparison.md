# Baselines comparison — CortexBench V0 (synthetic-dryrun)

Seed: 42  Epochs per baseline: 5  Generated: 2026-05-07T00:22:30.486Z

> Scorer: real CortexBench V0 (`experiments/harness/cortex-bench-eval.mjs`)
> driven by Phase 4 fixtures + the Apache-2.0 SyntheticTemporalLoader.
> See `experiments/PHASE_7_USER_ACTIONS.md` for the freeze procedure.

| Baseline | Name | Genesis | Final | Net Δ | Accepted/Total | p50 latency (ms) | Final state root |
|----------|------|--------:|------:|------:|---------------:|-----------------:|------------------|
| A ★ | empty | 0.0000 | 0.1176 | 0.1176 | 5/5 | 133.03 | 0x755c8ee973dedf... |
| B | dense-key | 0.0000 | 0.0462 | 0.0462 | 3/5 | 133.94 | 0xda712cc9ea32b0... |
| C | binary-key | 0.0000 | 0.0462 | 0.0462 | 3/5 | 133.09 | 0x30ba3ec84214b7... |
| D | late-interaction | 0.0000 | 0.0462 | 0.0462 | 3/5 | 133.36 | 0x46cbf055e67fab... |
| E | revocation-aware | 0.0000 | 0.0535 | 0.0535 | 5/5 | 132.78 | 0x613980c9bb41ad... |

## Winner

**Baseline A (empty)** — final composite 0.117647.

## Component breakdown (final state)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.392 | 0.000 |
| B | 0.154 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.154 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.154 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.164 | 0.193 | 0.000 | 0.000 |

## Family contribution (sum of accepted Δ per family)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A | 0.000 | 0.000 | 0.000 | 0.392 | 0.000 |
| B | 0.154 | 0.000 | 0.000 | 0.000 | 0.000 |
| C | 0.154 | 0.000 | 0.000 | 0.000 | 0.000 |
| D | 0.154 | 0.000 | 0.000 | 0.000 | 0.000 |
| E | 0.000 | 0.164 | 0.193 | 0.000 | 0.000 |

## Files

- `experiments/results/synthetic-dryrun/{A..E}.json` — per-baseline metrics
- `experiments/results/synthetic-dryrun/comparison.csv` — machine-readable
- `experiments/results/synthetic-dryrun/comparison.md` — this file
