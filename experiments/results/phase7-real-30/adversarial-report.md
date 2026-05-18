# Phase 7 — Adversarial report (CoreTex pre-launch)

Generated 2026-05-06.

## Failure modes evaluated

| Failure mode | Defence | Verified by |
|--------------|---------|-------------|
| Patch encoding panic | wire format frozen, encode/decode round-trip | Phase 7 T5 fuzz (1M patches, 0 panics) |
| Patch encoding nondeterminism | LEB128 + big-endian uint256 fields | Phase 7 T5 fuzz (0 nondeterminism) |
| Reserved-bit smuggling | `RESERVED_MASKS` per-word + `validateReservedBits` | Phase 1 unit tests + applyPatch E04 |
| Stale-parent submission | `parentStateRoot` check in `applyPatch` (E01) + `submitStateAdvance` (`LiveStateRootMismatch`) | Phase 7 T7 + e2e-real-improvement.mjs |
| Bogus screener-pass | live-epoch `marginalEvaluator(currentState, patch)` returns 0 ⇒ `L01_NOT_IMPROVEMENT` ⇒ no submission | Phase 7 T7 + e2e-real-improvement.mjs |
| Withholding a "merge multiplier" | merge multiplier removed (`MERGE_MULTIPLIER_BPS = 10000`) — no incentive to withhold | Phase 6 no-uplift gate |
| Replay of historical patch | parent-root rebase requirement: an old patch's parent root no longer equals `liveStateRoot` ⇒ rejected | live-epoch.ts `R03_WRONG_PARENT_ROOT` + Phase 7 T7 + e2e step 3 |
| Target-overlap conflict | reducer overlaps tracked, `R01_TARGET_OVERLAP` | Phase 6 reducer tests |
| Reserved-bit set in result | `applyPatchOntoCurrent` validates after writes (E04) | Phase 1 unit tests |
| Non-monotone economics ("save bonus for later") | merge bonus disabled in CoreTex; epoch credits paid the moment a verified improvement lands | live-epoch.ts (creditUnits = marginalGain) |
| Patch-size budget abuse | `wordCount ∈ [1, 4]` enforced at decode + apply (E03) | Phase 1 unit tests + 1M fuzz |
| Protected regression | hard-veto on protected-anchor regression in score formula | benchmark/score.ts assessVeto + Phase 4 E2E |

## Live-mid-epoch advance behaviour

When two miners propose non-overlapping improvements during the same
24-hour epoch:

1. Miner A submits patch p1 with `parentStateRoot = liveStateRoot` (initially
   the genesis root). Live evaluator returns positive marginalGain.
   Coordinator calls `submitStateAdvance(...)`. `liveStateRoot` updates.
2. Miner B mines patch p2 against the *new* `liveStateRoot`. Same evaluator
   returns positive marginalGain. Submit, `liveStateRoot` updates again.
3. A miner who tried to submit a patch built against the old genesis root
   would revert with `LiveStateRootMismatch` on chain (stale-parent
   defence). They must rebase and remine.

A miner who submits a "screener-passes-but-doesn't-improve" patch earns
nothing: the live evaluator returns 0, the patch never reaches
`submitStateAdvance`, and credits never accrue. There is no separate
merge-bonus rail to game (CoreTex disabled).

## End-to-end verification

`scripts/e2e-real-improvement.mjs` exercises the full path on a fresh
Anvil chain with the deployed `CortexRegistry`:

1. Deploy CortexRegistry, build baseline-A genesis state.
2. Mine real-corpus patch 1 → marginalGain > 0 → submit → `liveStateRoot`
   updates → `advanceCount = 1`.
3. Mine non-overlapping patch 2 against the new live root → submit →
   `liveStateRoot` updates → `advanceCount = 2`.
4. Replay stale-parent patch 1 → contract reverts (stale-parent rejection).
5. No-improvement candidate → marginalGain == 0 → live reducer rejects
   `L01_NOT_IMPROVEMENT` → never submitted.
6. Reducer replay over (p1, p2) reproduces the live root byte-for-byte.
7. `finalizeEpoch(...)` seals the live root unchanged.

Result: **15/15 PASS** on the latest run. Run yourself with
`node scripts/e2e-real-improvement.mjs`.
