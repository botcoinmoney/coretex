# Historical: Phase 2–4 Response Surface, Controller Sweeps, and Monte Carlo Long-Horizon Simulation

**Status**: Archived May 29 2026 (pre-A100 lock)  
**Purpose of this folder**: Preserve the exact tools and artifacts that produced critical controller and longevity findings used in the final 300k launch profile, while removing them from the active `scripts/` root to reduce future confusion and accidental reuse.

## Key Discoveries Enabled by These Tools

- Finite-headroom depletion model (longevity realism): the substrate has a finite supply of distinct honest improvements per family. This directly informed the C3 controller choice and the "smallDriftRatio" + qualityHighThresholdMult behavior pinned in the 300k profile.
- Honest temporal/mixed levers for the 4-word patch budget (e17da25 lineage) — established the calibration-derived patch shapes that later became the basis for MIXED support in r5.
- Phase 6 family-exhaustion testing: showed that when one family’s honest signal is exhausted, the other families must still keep the runway alive.
- Broad controller parameter sweeps (Phase 2) that selected the final C3 parameters (rampUpMaxRatio 1.1, decay 0.8, smallDrift 1.05, qualityHighThresholdMult 1) that are now the launch defaults.
- Monte Carlo long-horizon simulation (500–2000 epochs) that stress-tested the controller under realistic honest/random/hillclimb mixes without burning A100 time.

These were the primary instruments used during the 2026-05-27 through 2026-05-29 reconciliation window to turn raw response-surface data into the pinned launch controller and difficulty policy.

## Files Archived Here

- montecarlo-v2-longhorizon.mjs (Phase 4 / Phase 6 long-horizon simulator)
- measure-v2-response-surface.mjs (Phase 3 real-Qwen response surface measurement)
- sweep-v2-controller.mjs (Phase 2 broad controller sweep driver)
- lib/v2-controller-sim.mjs (shared controller-dynamics core, still imports the real dist controller)
- simulate-v2-difficulty.mjs
- simulate-v2-runway-ratematch.mjs
- simulate-v2-long-horizon.mjs
- calc-max-sustainable-target.mjs

All of these drove or consumed the actual V2 response curves and the real protocol controller (`nextMinImprovementPpm`, `isMajorDelta` from the canonical package).

## Retention Note

Do not delete. These contain the provenance for the exact controller parameters and finite-headroom model that are active in the 300k launch candidate. Future auditors or reranker epoch work may need to re-derive similar curves.

Last substantive updates: late May 2026 (60099c7, e17da25, b4b91f3, etc.).
