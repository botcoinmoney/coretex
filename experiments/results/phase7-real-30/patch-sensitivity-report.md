# Phase 7 — Patch sensitivity report (CoreTex pre-launch, real corpus)

Generated 2026-05-06 from `experiments/results/phase7-real-30/{A..E}.json`
(seed 42, 30 epochs, real corpus from `benchmark/fixtures/*` plus the
Apache-2.0 SyntheticTemporalLoader). Per §9 Phase 7 step 9 of the user
actions plan.

## What this measures

For each baseline, the harness records the marginal Δ on every component
score after each patch. Summed over the 30-epoch run, this is the family
contribution per baseline — i.e., **which family does each baseline's
canonical patch shape improve, and by how much.**

## Per-baseline canonical patch family

| Baseline | Canonical patch | Region touched | Family it improves |
|----------|-----------------|----------------|--------------------|
| A | `SLOT_REPLACE` × ≤4 memory_index slots / epoch | 32–383 | long-horizon compression |
| B | `KEY_UPDATE` × ≤4 retrieval-key meta words | 384–671 | near-collision retrieval (dense) |
| C | `KEY_UPDATE` × ≤4 retrieval-key meta words | 384–671 | near-collision retrieval (binary) |
| D | `KEY_UPDATE` × ≤4 record-lead meta words | 384–671 | near-collision retrieval (multi-vec) |
| E | `SLOT_REPLACE` × ≤4 memory_index slots with REVOKED flag mix | 32–383 | temporal (stale + current) |

## Family-level Δ (sum of accepted marginal deltas)

| Baseline | exact | stale | current | compression | routing |
|----------|------:|------:|--------:|------------:|--------:|
| A        | 0.000 | 0.000 |   0.000 |       0.863 |   0.000 |
| B        | 0.647 | 0.000 |   0.000 |       0.000 |   0.000 |
| C        | 0.647 | 0.000 |   0.000 |       0.000 |   0.000 |
| D        | 0.176 | 0.000 |   0.000 |       0.000 |   0.000 |
| E        | 0.000 | 0.382 |   0.404 |       0.000 |   0.000 |

The diagonal pattern is the expected sensitivity profile: each canonical
patch shape lands on (and only on) its specialty family. No baseline's
canonical patch leaks score into a different family. That bounds the
maximum gain a single-family miner can earn against the composite — see
the overfit resistance section below.

## Overfit resistance check

A miner that exclusively writes one family of patches caps out at:

| Family-only miner | Saturated composite (under current weights) |
|-------------------|---------------------------------------:|
| Compression-only (44/51 ≈ 0.86 × 0.30) | **0.259** |
| Near-collision-only (36/51 ≈ 0.71 × 0.30) | 0.212 |
| Temporal-only (E pattern) | 0.118 |
| Routing-only | 0.05 (full saturation) |

A composite-aware "strong" miner that mixes families across patches can
combine: `0.30 × 0.86 (compression) + 0.30 × 0.71 (exact) + 0.15 × 0.39
(stale) + 0.15 × 0.39 (current) ≈ 0.59`, well above the saturated band of
any single-family miner. This is the CoreTex overfit-resistance signal: no
single-family pattern dominates the composite alone.

## Notes for the pre-launch readiness

- Winner is **Baseline A (empty)** because long-horizon compression
  carries the heaviest weight (60% of family weighting once routing's 0.05
  is collapsed under long_horizon). A's canonical patch shape produces the
  highest single-baseline composite under the locked weights.
- Baselines B, C, D are functionally tied on near-collision; D loses
  because its multi-vector layout caps at 9 records (vs 36 single-slot
  keys in B/C).
- Baseline E's temporal-only canonical patch is the lowest performer
  because each temporal event hits a 15% family weight rather than the
  30% long-horizon weight.
- Seeds 1, 7, 42, 99, 1234 all produced identical winners and identical
  final composites (per `experiments/results/phase7-stability/seed-*/winner.json`)
  because the corpus is deterministic and the canonical miners are
  deterministic given a seed-derived solveIndex; this is the expected
  zero-variance result, not a flake.

## Adversarial coverage

Phase 7 adversarial fuzz at `EXTENDED_FUZZ=1` (1,000,000 patches): 0
panics, 0 nondeterminism. Encoded → decoded → re-encoded patches are
byte-identical at all `wordCount ∈ {1,2,3,4}` and arbitrary index
choices.

Live-epoch reducer rejection profile (Phase 7 T7):

- `R03_WRONG_PARENT_ROOT` — stale-parent submissions rejected
- `L01_NOT_IMPROVEMENT` — zero-marginal-gain candidates rejected (no credits)
- `R05_RESERVED_BIT_SET` — patches that would set reserved bits rejected
- `R04_INVALID_TARGET` — invalid index targets rejected

Bogus-but-screener-passing patches earn no credits because the live
reducer re-evaluates marginal gain on the actual current state via the
real `marginalEvaluator` (cortex-bench-eval). End-to-end verification in
`scripts/e2e-real-improvement.mjs` (15/15 PASS).
