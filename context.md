# Cortex — Current Context

> Strict-rule file per ORGANISM_CORTEX_STATE_PLAN.md §13.5. Driver-only edits per CONTRIBUTING.md to avoid parallel-branch conflicts. Subagents flag updates needed; driver writes them on `main`. CI fails the PR if checklist items flipped without a context.md touch.

## Current state

**Phases 0, 1, 2 LANDING WAVE 1 of 5.** All three subagents completed work in parallel worktrees and pushed PRs.

- **Phase 0 — Research lock + benchmark anchoring** — MERGED (PR #2). Deliverables: `specs/research_brief_v0.md` (full ~5-page brief, locked thesis + family weights 60/20/20 + pass-rate targets 0%/5–10%/20–30%), `specs/non_goals_v0.md` (12 hard-rejected items + 4 tracked V1 paths), `specs/license_audit.md` (per-source SPDX/redistribution/attribution table), `benchmark/sources.json` (machine-readable manifest for Phase 4 loader). **License blocker surfaced**: LoCoMo is CC-BY-NC-4.0, incompatible with commercial mining use; resolution options listed under "Open questions / blockers" below.
- **Phase 2 — CortexRegistry + CortexMergeBonus** — MERGED (PR #1). Two contracts, full implementation: header storage, accepted-patch events with full `compactPatchBytes`, snapshot every 100 epochs, 2-of-N audit-window multisig revert, pause matrix, on-chain bonus cap from Merkle-leaf-encoded cap, pool-mode wrapper. 46/46 forge tests pass; 7 fork tests skip when `BASE_RPC_URL` absent (CI secret needed). Gas budgets documented in `contracts/test/GAS_BUDGETS.md`. `BotcoinMiningV3` untouched and proven-unaffected via mock-stub + pause matrix tests.
- **Phase 1 — Cortex state spec + TS reference impl** — PR #3 OPEN. Specs (cortex_state_v0.md, cortex_schema_v0.json, packing_spec_v0.md, merkleization_spec_v0.md, patch_format_v0.md) bodies complete. TS impl in `packages/cortex/src/state/` (types, codec, keccak256, merkle, validate, patch). E2E gate at `test/e2e/phase-1/run.mjs` covers all 6 §9 fixtures. Cross-impl Merkle parity (Python second-impl) gated to a follow-up PR — Python chosen because Rust/Go are not on this build host.

`BotcoinMiningV3` is and remains unchanged. Cortex is a parallel lane behind the same coordinator origin.

## Next steps

1. Merge Phase 1 PR #3 once CI is green; then tag `v0.phase-0`, `v0.phase-1`, `v0.phase-2`.
2. Spawn **Wave 2 subagents** in parallel worktrees:
   - **Phase 3 (Core decoder)** — `packages/cortex` decoder/evaluator/CLI; <10 ms p50 / <50 ms p99; worker pool; verify-epoch from chain alone.
   - **Phase 4 (CortexBench)** — anchored loaders driven by `benchmark/sources.json`; hidden-shard derivation; score formula. **Cannot include LoCoMo until license resolved.**
   - **Phase 5 (mining API + cortex-server + cortex-handler)** — full §13.4 single-line drop-in router and the `cortex-server` process.
   - **Phase 6 (reducer + credit mechanics)** — deterministic greedy-by-marginal-gain reducer, separate ScreenerPassed vs PatchMerged events.
   - **Python second-impl (Phase 1 follow-up)** — independent Python 3 impl of pack/unpack/merkle/patch + cross-impl parity fixture in `test/e2e/phase-1/`.
3. Wire `BASE_RPC_URL` as a GitHub Actions secret so Phase 2 fork tests run in CI.
4. Address the **LoCoMo CC-BY-NC-4.0 blocker** before Phase 4 ships its temporal-family loader.

## Open questions / blockers

- **LoCoMo CC-BY-NC-4.0 (BLOCKER for Phase 4 temporal family).** Three resolution paths in `specs/license_audit.md §4`:
  - (A) Contact Snap Research (paper authors) for a commercial license exception.
  - (B) Replace LoCoMo with a permissive alternative (MemoryAgentBench MIT data partially covers the temporal use case; doesn't cover all of LoCoMo's stale-vs-current pairs).
  - (C) Derive synthetic conversational records under Apache-2.0 (loses the LoCoMo realism anchor).
  - **Awaiting human decision before Phase 4 begins temporal-family loader work.**
- **BASE_RPC_URL CI secret.** Needed for Phase 2 fork tests in GitHub Actions; safe to defer to anytime before Phase 8.
- **Multisig operator key set.** Needed before Phase 9 first reward epoch; not blocking Phases 3–8.
- **MSMARCO and TREC-COVID BEIR subsets.** Need commercial-use license review before Phase 4 includes them. NQ (Apache-2.0) and HotpotQA (CC-BY-SA-4.0) are safe.
- **MemoryArena code repo URL.** Unresolved (project website 404). HuggingFace dataset (`ZexueHe/memoryarena`, CC-BY-4.0) is confirmed OK; commit hash cannot be pinned until upstream confirms code repo (contact: zexueh@stanford.edu).

## Recent decisions (last 10)

- 2026-05-05 — Phase 1 second-impl will be **Python 3** — Rust/Go not on this host; Python is the cleanest independence-establishing alternative.
- 2026-05-05 — Phase 2 contract `finalizeEpoch` gas ceiling raised to **250K** (from spec-implied 180K) — measured 209,988 with `ReentrancyGuard` and timestamp storage; documented in `contracts/test/GAS_BUDGETS.md`.
- 2026-05-05 — Phase 2 `emitSnapshot` is a **separate call** (not auto-emitted from `finalizeEpoch`) — the 32 KB payload comes from off-chain coordinator; contract validates `epoch % 100 == 0` and `length == 32768`.
- 2026-05-05 — Phase 1 patch wire format: **LEB128 varint** indices, **int64 big-endian** scoreDelta, **old words omitted from wire** (reconstructed from parent state). Measured p99 patch size for 4-word case fits comfortably under the 200-byte budget.
- 2026-05-05 — Phase 1 Merkle: **bottom-up binary keccak256 over 1024 leaves** (power of two — no padding required); leaves are big-endian uint256 word bytes.
- 2026-05-05 — Repo created `botcoinmoney/cortex` private, cloned to `/root/cortex`, branch `main` — confirmed by user.
- 2026-05-05 — License: **Apache-2.0** — open-source default with patent grant.
- 2026-05-05 — Package manager: **npm workspaces** (not pnpm) — pnpm install was permission-denied; npm workspaces is the on-host equivalent. Plan references to `pnpm` map to `npm run`.
- 2026-05-05 — CI matrix: phase-scoped E2E jobs `e2e-phase-{1..5}` + aggregate `e2e-all` merge gate per §13.6.
- 2026-05-05 — `scripts/check-context-freshness.mjs` enforces §13.5 "checklist flipped → context.md touched" rule on PRs.

## How to resume

```bash
cd /root/cortex
git fetch origin && git status
git log --oneline -10
cat context.md                    # this file
gh pr list                        # outstanding PRs
git worktree list                 # active phase worktrees
# Then read ORGANISM_CORTEX_STATE_PLAN.md for the relevant phase only.
# Do NOT skim the whole repo.
```

If context-window pressure forces a handoff:
1. Update `## Current state` and `## Next steps` above.
2. Append a one-line entry to `## Recent decisions`.
3. Commit `context.md` and push.
4. End with a one-sentence summary.

The next agent (or wake) reads `context.md` first, then the relevant phase section of `ORGANISM_CORTEX_STATE_PLAN.md`, then only the files needed.
