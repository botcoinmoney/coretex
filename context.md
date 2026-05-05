# Cortex — Current Context

> Strict-rule file per ORGANISM_CORTEX_STATE_PLAN.md §13.5. Every agent updates this before pushing meaningful work. CI fails the PR if checklist items flipped without a context.md touch.

## Current state

**Phase 2 — CortexRegistry + CortexMergeBonus** COMPLETE on branch `phase-2/contracts`.

Both contracts are fully implemented, compiled (Solc 0.8.26, no errors), and tested:
- `contracts/src/CortexRegistry.sol` — full implementation: header storage, patch submission, finalization, snapshot emission, 2-of-N multisig audit-window revert, emergency pause, shard commit/reveal.
- `contracts/src/CortexMergeBonus.sol` — full implementation: Merkle-root funded epochs, `claimMergeBonus`, pool-mode `triggerMergeBonusClaim`, audit-window enforcement via ICortexRegistry, per-miner cap enforcement, emergency pause.
- `contracts/script/DeployCortex.s.sol` — Forge deploy script.
- `contracts/test/CortexPhase2.t.sol` — 42 tests (all pass), 2 fuzz tests.
- `contracts/test/CortexFork.t.sol` — 7 fork tests (skipped when BASE_RPC_URL absent; live on Base mainnet fork when set).
- `contracts/test/GasBudget.t.sol` — 4 gas ceiling gate tests (all pass).
- `contracts/test/GAS_BUDGETS.md` — documented gas ceilings.
- `test/e2e/phase-2/run.mjs` — updated to invoke `forge test --root contracts`.

46 tests pass, 0 fail, 7 fork tests skipped (need BASE_RPC_URL). `BotcoinMiningV3` untouched.

Phase 0 (Research) and Phase 1 (Protocol) are still in progress as background subagents.

## Next steps

1. Wire `BASE_RPC_URL` as a CI secret so fork tests run in GitHub Actions.
2. Spawn Phase 0 (Research) subagent — `specs/research_brief_v0.md`, benchmark license/weight lock.
3. Spawn Phase 1 (Protocol) subagent — five state-spec docs + TS reference impl.
4. Phase 3 (Core decoder) — `botcoin-cortex verify-epoch` needed to unlock the log-replay E2E gate.
5. Add multisig operator key addresses to `ops/multisig.md` before Phase 9 first reward epoch.

## Open questions / blockers

- **BASE_RPC_URL**: must be set as a GitHub Actions secret for fork tests to run. Documented in PR.
- **Multisig operator keys**: TBD — needed before Phase 9 first reward epoch (not Phase 2 blocker).
- **Log-replay test** (`test_fork_SKIP_logReplayReconstruction`): skipped — requires Phase 3 Core decoder. Placeholder in CortexFork.t.sol.
- **License**: Apache-2.0 (set earlier).
- **Package manager**: npm workspaces (not pnpm).

## Open questions / blockers

- **License**: defaulted to **Apache-2.0** (open source, patent grant). Override by replacing `LICENSE` and noting in this file.
- **Package manager**: defaulted to **npm workspaces** (no pnpm available on this host). All `pnpm` references in the plan map to `npm run`.
- **Open**: §6 receipt field mapping reuses `BotcoinMining` EIP-712 domain with `rulesVersion = 0xC0`. V1 path tracked: sister `submitCortexReceipt(...)` function. No human decision required for V0.
- **Open**: Multisig operator key set — needs human input before P9 first reward epoch. Captured as a gate, not a blocker for P0–P7.

## Recent decisions (last 10)

- 2026-05-05 — Repo created `botcoinmoney/cortex` private, cloned to `/root/cortex`, branch `main` — confirmed by user.
- 2026-05-05 — License: Apache-2.0 — open-source default with patent grant; user said "open source license" without specifying.
- 2026-05-05 — Package manager: npm workspaces (not pnpm) — pnpm install was blocked by user permission denial; npm workspaces is the on-host equivalent. All plan references to `pnpm` map to `npm run`.
- 2026-05-05 — CI matrix: phase-scoped E2E jobs `e2e-phase-{1..5}` + an aggregate `e2e-all` merge gate, mirroring §13.6 — implemented as GitHub Actions matrix in `.github/workflows/ci.yml`.
- 2026-05-05 — `scripts/check-context-freshness.mjs` enforces §13.5 "checklist flipped → context.md touched" rule on PRs.
- 2026-05-05 — Phase 2 complete: CortexRegistry + CortexMergeBonus fully implemented, 46/46 non-fork tests pass, 7 fork tests gate on BASE_RPC_URL. Gas ceilings measured and documented. Log-replay test marked SKIP (Phase 3 dependency).
- 2026-05-05 — Merkle leaf encoding: keccak256(abi.encodePacked(miner, bonusBOTCOIN, capBOTCOIN)) — cap enforced as bonusAmt ≤ capAmt in CortexMergeBonus.claimMergeBonus.
- 2026-05-05 — fundEpoch checks epochReverted before epochFinalized — revert unsets epochFinalized, so order matters for correct error propagation.
- 2026-05-05 — finalizeEpoch gas ceiling set to 250K (measured 210K warm) — 7 SSTOREs for CortexHeader struct + flags + ReentrancyGuard overhead.

## How to resume

```bash
cd /root/cortex-p2                # Phase 2 worktree (branch: phase-2/contracts)
git status
git log --oneline -10
# Run tests to confirm green baseline:
forge test --root contracts -vv
# Then read ORGANISM_CORTEX_STATE_PLAN.md §9 Phase 3 for next deliverable.
```

If context-window pressure forces a handoff:
1. Update `## Current state` and `## Next steps` above.
2. Append a single-line entry to `## Recent decisions`.
3. Commit `context.md` and push.
4. End the session with a one-sentence summary.

The next agent (or the user resuming a wake) reads `context.md` first, then the relevant phase section of `ORGANISM_CORTEX_STATE_PLAN.md`, then only the files needed.
