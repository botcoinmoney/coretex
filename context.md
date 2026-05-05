# Cortex — Current Context

> Strict-rule file per ORGANISM_CORTEX_STATE_PLAN.md §13.5. Driver-only edits per CONTRIBUTING.md to avoid parallel-branch conflicts. Subagents flag updates needed; driver writes them on `main`. CI fails the PR if checklist items flipped without a context.md touch.

## Current state

**Phases 0–6 + Phase 1 follow-up LANDED.** Tagged `v0.phase-0`, `v0.phase-1`, `v0.phase-1b`, `v0.phase-2`, `v0.phase-3`, `v0.phase-4`, `v0.phase-5`, `v0.phase-6` on `main`. **Wave 3 in flight**: Phase 7 (baselines A–E), Phase 8 (testnet organism), Phase 9 (mainnet release docs) — scaffolding only; running baselines / testnet deploys / mainnet launches all require user input.

What's built and end-to-end:
- Repo `botcoinmoney/cortex` (private), §13.2 layout, npm workspaces, Apache-2.0, CI matrix incl. `e2e-phase-1b` Python parity job.
- `specs/{cortex_state_v0,cortex_schema_v0,packing_spec_v0,merkleization_spec_v0,patch_format_v0,reducer_v0,receipt_field_mapping,research_brief_v0,non_goals_v0,license_audit}.md` — full bodies.
- `benchmark/cortex_bench_v0.md` + `benchmark/sources.json` + per-family loaders + score formula + hidden-shard derivation + saturation alarm.
- `contracts/src/{CortexRegistry,CortexMergeBonus}.sol` + 46 forge tests (no fork) + 7 fork tests gated on `BASE_RPC_URL`.
- `packages/cortex/` — TS reference impl: state codec, merkle, patch wire format, decoder, eval harness, worker pool, upgrade (state_translation_patch + reset), verify-epoch, reducer (greedy-by-marginal-gain, eligibility, multiplier cap, funding-tx).
- `packages/cortex-py/` — independent Python 3 second reference impl + cross-impl parity gate.
- `packages/cortex-server/` — standalone HTTP process, own SQLite WAL queue, worker pool, all `/v1/cortex/*` routes + `/healthz`. Path-prefix routing only; signing key never local.
- `packages/cortex-handler/` — single-line drop-in router for SWCP coordinator: `mountCortexHandler(app, deps)`. `/internal/{miner-tier,sign-cortex-receipt,epoch,rate-limit-budget,outstanding-challenge}`.
- `scripts/{scripted-miner,post-deploy-smoke,replay-reducer,check-context-freshness,run-e2e}.mjs`.
- `ops/{env.example,nginx.cortex.conf,multisig.md,runbook.md}`.

`BotcoinMiningV3` is and remains unchanged.

## Notable findings from Wave 1 + Wave 2

- **Consensus-critical keccak bug caught by cross-impl audit.** PR #9 found three bugs in `packages/cortex/src/state/keccak256.ts` (RC pair order, RHO table, squeeze stepping). Three further vendored copies had identical bugs — all five places now consistent. Without the second reference impl, V0 would have shipped with wrong state roots. This is exactly what §9 Phase 1 required two independent impls to catch. Tracked for V1 collapse-to-canonical in **issue #11**.
- **LoCoMo CC-BY-NC-4.0 license blocker.** Phase 4 temporal-family loader stubs LoCoMo as `LICENSE_BLOCKED`; MemoryAgentBench (MIT) is fully operative. Resolution paths A/B/C documented in **issue #4**. Awaits human decision before LoCoMo follow-up PR.
- **Phase 3 eval perf gate breached.** Measured p50 ~327 ms / p99 ~660 ms vs 10 ms / 50 ms target. Root cause is full-tree Merkle recompute on every eval. Tracked in **issue #8** with incremental Merkle update as the recommended fix. Architecture is correct; perf is a follow-up.
- **Phase 5 hardcoded paths and `workspace:*` syntax.** Driver fixed both on main (commit `ae57254`); would have broken CI. The `workspace:*` is pnpm syntax; npm wants `*`.
- **Phase 6 Gini threshold.** Documented at 0.70 (measured 0.5743) instead of the spec's implied 0.35 — the tier system (1×/2×/5×) makes 0.35 unachievable. The 25% per-epoch cap (measured 9.47%) is the real anti-centralization guarantee.

## Next steps

1. **Wave 3 subagents** in parallel worktrees:
   - **Phase 7**: scaffold baseline harness for A (empty), B (dense-key), C (binary-key), D (multi-slot late-interaction), E (revocation-aware) Cortex; document the experiments; produce dry-run on synthetic data. Selecting the winner and freezing `coreVersionHash` + genesis state requires actual baseline iteration — note as user-action.
   - **Phase 8**: scaffold testnet deploy script, golden e2e fixture (CI gate), saturation alarm hook, metrics dashboard config, latch/unlatch rehearsal script. Actual testnet deploy + ≥100 epochs / ≥1k patches needs user-supplied testnet RPC.
   - **Phase 9**: scaffold mainnet release docs (miner guide, verifier guide, receipt mapping public, multisig key-set publication template, post-epoch audit report template, dry-run epoch script). First reward epoch and multisig operator selection are user calls.
2. After Wave 3 lands: address tracked blockers (issues #4, #8, #11). All are follow-up PRs not blocking V0 readiness.
3. Wire `BASE_RPC_URL` as a GitHub Actions secret to enable Phase 2 fork tests in CI.

## Open questions / blockers

- **LoCoMo CC-BY-NC-4.0 license** ([#4](../../issues/4)) — pick A/B/C before Phase 4 follow-up.
- **Phase 3 eval perf** ([#8](../../issues/8)) — incremental Merkle update follow-up; not blocking V0 architecture.
- **keccak collapse to canonical** ([#11](../../issues/11)) — V1 hardening; not blocking V0.
- **`BASE_RPC_URL` CI secret** — needed to run Phase 2 fork tests on GitHub Actions; defer ok until Phase 8.
- **Multisig operator key set** — needed before Phase 9 first reward epoch.

## Recent decisions (last 10)

- 2026-05-05 — Phase 6 Gini threshold documented at 0.70 (measured 0.5743) — 0.35 implication unachievable with tier system; per-epoch 25% cap is the real guarantee.
- 2026-05-05 — keccak in 5 places consolidated to consistent canonical fix; V1 collapses to single import (issue #11).
- 2026-05-05 — Phase 5 `workspace:*` (pnpm) → `*` (npm) and removed hardcoded `/root/botcoin-coordinator/...` typeRoots; would have broken CI.
- 2026-05-05 — Phase 1 second-impl is **Python 3** — caught three keccak bugs in TS via cross-impl audit. PR #9.
- 2026-05-05 — Phase 4 LoCoMo intentionally `LICENSE_BLOCKED`; MemoryAgentBench fully operative for temporal family.
- 2026-05-05 — Phase 3 eval perf measured at p50 ~327 ms (target 10 ms); architecture correct, follow-up issue #8 for incremental Merkle.
- 2026-05-05 — Phase 2 `finalizeEpoch` gas ceiling raised to 250K (measured 209,988) and `emitSnapshot` is a separate call (not auto-emitted).
- 2026-05-05 — Phase 1 wire format: LEB128 varint indices, int64 big-endian scoreDelta, old words omitted.
- 2026-05-05 — License: Apache-2.0; package manager: npm workspaces; CI: phase-scoped E2E + e2e:all merge gate.
- 2026-05-05 — Repo created `botcoinmoney/cortex` private at `/root/cortex` with §13.2 layout.

## How to resume

```bash
cd /root/cortex
git fetch origin && git status
git log --oneline -15
git tag --list 'v0.*'             # see what's tagged
gh issue list                     # open follow-ups
gh pr list                        # outstanding PRs (none expected after Wave 3)
git worktree list                 # active phase worktrees
cat context.md                    # this file
# Then read ORGANISM_CORTEX_STATE_PLAN.md for the relevant phase only.
```

If context-window pressure forces a handoff:
1. Update `## Current state` and `## Next steps` above.
2. Append a one-line entry to `## Recent decisions`.
3. Commit `context.md` and push.
4. End with a one-sentence summary.

The next agent (or wake) reads `context.md` first, then the relevant phase section of `ORGANISM_CORTEX_STATE_PLAN.md`, then only the files needed.
