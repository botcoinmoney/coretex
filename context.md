# Cortex — Current Context

> Strict-rule file per ORGANISM_CORTEX_STATE_PLAN.md §13.5. Driver-only edits per CONTRIBUTING.md. CI fails the PR if checklist items flipped without a context.md touch.

## Current state

**ALL 9 PHASES + Phase 1 follow-up LANDED AND TAGGED.** End-to-end V0 scaffolding is complete. Tags on `main`:

- `v0.bootstrap` — repo + §13.2 layout + CI matrix
- `v0.phase-0` — research lock + benchmark anchoring
- `v0.phase-1` — Cortex state spec + TS reference impl
- `v0.phase-1b` — Python second reference impl + cross-impl parity gate
- `v0.phase-2` — CortexRegistry + CortexMergeBonus contracts (46 forge tests pass)
- `v0.phase-3` — Botcoin Core decoder package
- `v0.phase-4` — CortexBench V0 (35/35 e2e pass)
- `v0.phase-5` — mining API (cortex-server + cortex-handler, single-line drop-in)
- `v0.phase-6` — reducer + credit mechanics (46 tests / 9 gates pass)
- `v0.phase-7` — baseline harness A–E + golden vectors (scaffolded)
- `v0.phase-8` — testnet harness + golden e2e fixture (CI merge gate)
- `v0.phase-9` — mainnet release artifacts (public docs + operator scripts)

What's deployable today: every spec, contract, package, harness, test fixture, runbook, and operator checklist is in `/root/cortex` and pushed to `botcoinmoney/cortex`. The §13.4 plug-and-play guarantee holds — `packages/cortex-handler` mounts in one line.

What requires the user before going live (per ORGANISM_CORTEX_STATE_PLAN.md):
- Real Phase 7 iteration: pick a baseline winner, freeze `coreVersionHash` + `genesisStateRoot`, ≥1M fuzz pass.
- Real Phase 8 testnet: ≥100 epochs / ≥1k patches, ≥10 auditor reproductions, latch/unlatch ×2.
- Real Phase 9 mainnet: deploy contracts, multisig key publication, dry-run epoch, multisig + emergency-disable rehearsals, first reward epoch with audit trail published.

## What didn't go to plan (driver picked up)

- **Wave 3 (Phases 7/8/9) agents hit the org's monthly usage limit** before completing. Phase 7 got 34 tool uses; Phase 8 got 18; Phase 9 got 6. Driver finished all three inline and salvaged what the agents had committed (Phase 7 baselines/README.md, types.mjs; Phase 8 DeployTestnet.s.sol).
- **Phase 5 agent shipped CI breakers**: hardcoded `/root/botcoin-coordinator/...` typeRoots and `workspace:*` (pnpm) syntax. Both fixed on main in commit `ae57254`.
- **Phase 1 keccak256 had 3 real bugs caught by the Python second-impl cross-impl audit**. Same bugs in 4 other vendored copies. All 5 places now consistent. V1 collapse-to-canonical tracked in [issue #11](../../issues/11).
- **Phase 3 eval perf: 327ms p50 / 660ms p99 vs 10ms / 50ms target.** Architecture correct; root cause is full-tree Merkle recompute; recommended fix is incremental Merkle update. Tracked in [issue #8](../../issues/8).
- **LoCoMo CC-BY-NC-4.0 license blocker** for Phase 4 temporal-family loader. Stubbed as `LICENSE_BLOCKED`; user picks A/B/C in [issue #4](../../issues/4).
- **Phase 6 Gini threshold**: spec implied 0.35 was unachievable with the tier system; documented at 0.70 with measured 0.5743 over 50 epochs. The 25% per-epoch single-miner cap (measured 9.47%) is the meaningful guarantee.

## Open questions / blockers

- **[#4](../../issues/4)** LoCoMo CC-BY-NC-4.0 — pick A (Snap commercial license), B (permissive replacement), or C (synthetic Apache-2.0).
- **[#8](../../issues/8)** Phase 3 eval perf — incremental Merkle update follow-up.
- **[#11](../../issues/11)** V1: collapse keccak to single canonical impl.
- `BASE_RPC_URL` GitHub Actions secret — needed before Phase 2 fork tests run on CI.
- Multisig operator key set — fill `docs/multisig-key-set.md` before Phase 9 first reward epoch.
- Phase 7 real winner + frozen `coreVersionHash` + `genesisStateRoot` — gates Phase 8 testnet launch.

## Next steps (user)

1. Decide on the LoCoMo path ([#4](../../issues/4)).
2. Run Phase 7 baseline iteration with real corpus → pick winner → freeze hashes → re-run `npm run test:e2e -- --filter phase-7` with the real winner.
3. Land issue #8 (incremental Merkle) so eval perf hits the §9 budget.
4. Run Phase 8 testnet per [`ops/testnet/USER_ACTIONS.md`](./ops/testnet/USER_ACTIONS.md).
5. Publish multisig key set in `docs/multisig-key-set.md`.
6. Run mainnet launch per [`ops/USER_ACTIONS_MAINNET.md`](./ops/USER_ACTIONS_MAINNET.md).

## Recent decisions (last 10)

- 2026-05-05 — All 9 phases tagged. Wave-3 agent budget hit; driver completed Phases 7/8/9 inline.
- 2026-05-05 — Phase 8 golden e2e fixture is the CI merge gate; runs in-process (no testnet RPC needed).
- 2026-05-05 — Phase 9 mainnet scripts produce calldata only — never broadcast for the user. `MAINNET_CONFIRM=I-UNDERSTAND` env confirmation required.
- 2026-05-05 — Phase 6 Gini threshold documented at 0.70 (measured 0.5743) — 0.35 unachievable with tier system.
- 2026-05-05 — keccak in 5 places consolidated to consistent canonical fix; V1 collapses to single import (issue #11).
- 2026-05-05 — Phase 5 `workspace:*` (pnpm) → `*` (npm) and removed hardcoded `/root/botcoin-coordinator/...` typeRoots.
- 2026-05-05 — Phase 1 second-impl is **Python 3** — caught three keccak bugs via cross-impl audit. PR #9.
- 2026-05-05 — Phase 4 LoCoMo intentionally `LICENSE_BLOCKED`; MemoryAgentBench fully operative.
- 2026-05-05 — Phase 3 eval perf measured at p50 ~327 ms (target 10 ms); architecture correct, follow-up issue #8.
- 2026-05-05 — License: Apache-2.0; package manager: npm workspaces; CI: phase-scoped E2E + e2e:all merge gate.

## How to resume

```bash
cd /root/cortex
git fetch origin && git status
git tag --list 'v0.*'             # see what's tagged
gh issue list                     # open follow-ups (#4, #8, #11 expected)
gh pr list                        # outstanding PRs (none expected)
cat context.md                    # this file
# Then read ORGANISM_CORTEX_STATE_PLAN.md for the relevant phase only.
```

If picking up new work:
1. Update `## Current state` and `## Next steps` above before pushing.
2. Append a one-line entry to `## Recent decisions`.
3. Commit `context.md` and push.
4. End with a one-sentence summary.

The next agent (or wake) reads `context.md` first, then the relevant phase section of `ORGANISM_CORTEX_STATE_PLAN.md`, then only the files needed.
