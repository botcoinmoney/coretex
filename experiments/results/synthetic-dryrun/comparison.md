# Baselines comparison — synthetic dry-run

Seed: 42  Epochs per baseline: 5  Generated: 2026-05-06T08:38:14.969Z

> **Caveat**: scoring is synthetic (StubCorpusLoader). Real scoring requires Phase 4
> corpus + LoCoMo license resolution (issue #4). Use this report to validate harness
> correctness, not to pick a real winner.

| Baseline | Name | Accepted/Total | avgΔ | p50 latency (ms) | Final state root |
|----------|------|---------------:|-----:|-----------------:|------------------|
| A | empty | 0/5 | 0.0000 | 0.01 | 0x7e704f76d61564... |
| B | dense-key | 5/5 | 0.0109 | 136.09 | 0x09386e9d979857... |
| C | binary-key | 5/5 | 0.0108 | 129.54 | 0x8659d604e33f1f... |
| D | late-interaction | 5/5 | 0.0107 | 132.13 | 0x4817b9fdab596e... |
| E | revocation-aware | 5/5 | 0.0106 | 131.39 | 0x19a184e8d8e40d... |


## Placeholder winner

**Baseline E (revocation-aware)** is the placeholder winner per §9 Phase 7. The user runs real iteration with a Phase 4 corpus and `experiments/PHASE_7_USER_ACTIONS.md` to confirm or override.

## Files

- `experiments/results/synthetic-dryrun/{A..E}.json` — per-baseline metrics
- `experiments/results/synthetic-dryrun/comparison.csv` — machine-readable
- `experiments/results/synthetic-dryrun/comparison.md` — this file
