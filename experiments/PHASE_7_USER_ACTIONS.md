# Phase 7 — User Actions (DONE)

Per `ORGANISM_CORTEX_STATE_PLAN.md §9 Phase 7`. This file used to be a
checklist for the user; the steps have been completed in-repo on
2026-05-06 by the real-corpus iteration pass.

## Result

- **Winner**: **Baseline A (empty)**.
- **`coreVersionHash`**: `0xe1a957805f855828338a2a9d1f90c46eb78c378d85f10c8d8c83a1ce6eb388d3`
- **`genesisStateRoot`**: `0x7e704f76d6156405800141206cec1e6d7804daa8bf4e7da1542a1e431958504e`

Source of truth: `ops/v0-frozen.json`. Both values are mirrored into
`docs/contract-addresses.md`.

## How the iteration ran

```bash
# 1. Real corpus comparison (5 baselines, 5 seeds × 60 epochs each)
for SEED in 1 7 42 99 1234; do
  node experiments/harness/compareBaselines.mjs \
    --epochs 60 --seed "$SEED" --label phase7-stability/seed-$SEED
done

# 2. Headline run that the report references (seed 42, 30 epochs)
node experiments/harness/compareBaselines.mjs --epochs 30 --seed 42 --label phase7-real-30

# 3. 1M-patch adversarial fuzz (Phase 7 T5)
EXTENDED_FUZZ=1 node test/e2e/phase-7/run.mjs

# 4. Freeze coreVersionHash + genesisStateRoot from the winning baseline
node scripts/freeze-core-version.mjs --baseline A
```

All 5 stability seeds picked Baseline A with identical final composite
0.2588. Adversarial fuzz at 1M passed clean (0 panics, 0 nondeterminism).
Phase 7 E2E gate is green (7/7 PASS).

## Reports

- `experiments/results/phase7-real-30/comparison.md` — per-baseline metrics
- `experiments/results/phase7-real-30/comparison.csv` — machine-readable
- `experiments/results/phase7-real-30/patch-sensitivity-report.md` — §9 step 9
- `experiments/results/phase7-real-30/adversarial-report.md` — §9 step 10
- `experiments/results/phase7-stability/seed-{1,7,42,99,1234}/` — stability runs

## What changed vs the original plan

- The harness no longer uses `StubCorpusLoader` / synthetic SEED-XOR scoring.
  It reads the real Phase 4 fixtures from `benchmark/fixtures/*` and the
  Apache-2.0 SyntheticTemporalLoader (LoCoMo Path B), then scores via
  `experiments/harness/cortex-bench-eval.mjs`.
- Each baseline's `mineCandidatePatch` is now corpus-aware: given the
  loaded corpus it targets the next uncovered event in its specialty
  family using the full 4-word patch budget.
- The expected placeholder winner was Baseline E. The real evaluator
  picks Baseline A because long-horizon compression carries the highest
  single-family weight (60% of family weighting).

## End-to-end mining flow (verified)

`node scripts/e2e-real-improvement.mjs` spins up Anvil, deploys
`CortexRegistry`, then mines + submits two non-overlapping live-mid-epoch
improvements, exercises the stale-parent defence on chain, and confirms a
no-improvement candidate cannot extract credits. Latest run: **15/15
PASS**.
