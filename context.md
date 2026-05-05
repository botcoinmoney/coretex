# Cortex — Current Context

> Strict-rule file per ORGANISM_CORTEX_STATE_PLAN.md §13.5. Driver-only edits per CONTRIBUTING.md.

## Current state

**ALL 9 PHASES + Phase 1 follow-up + V0 POLICY DECISIONS LANDED.** Tags on `main`:

- `v0.bootstrap`, `v0.phase-{0,1,1b,2,3,4,5,6,7,8,9}` — every §9 phase scaffolded.
- HEAD is past the 2026-05-05 V0 policy decisions:
  - **LoCoMo Path B applied** — LoCoMo removed; `SyntheticTemporalLoader` (Apache-2.0) + `MemoryAgentBenchLoader` (MIT) cover the temporal family. Issue #4 CLOSED.
  - **Multisig deferred to V1** — `CortexRegistry.ownerRevertEpoch(uint64)` is the V0 audit-window override (single owner). `voteRevertEpoch` 2-of-N wiring retained for V1 reactivation.
  - **`MERGE_MULTIPLIER_BPS = 20000` (2.0×)** — was 1.5×.
  - **License: Apache-2.0** confirmed (patent grant matters for crypto/ML; ethos preserves redistribution rights).
  - **Repo: private** (per §13.1; reconsider at V0 launch).

## V0 validation completed in this session

| What | Result |
|------|--------|
| `forge test` (no-fork): `CortexPhase2` + `GasBudget` | **50/50 pass** (46 + 4) |
| `forge test --fork-url $BASE_RPC_URL` (real Base mainnet fork) | **6/7 pass, 1 SKIP** (Phase-3-dep log-replay) |
| Anvil-fork-of-mainnet deploy via `forge create` | Both contracts deployed; bytecode verified |
| Full lifecycle (commit→submit→finalize→reveal) on fork | All 5 transactions succeed; events emit |
| `ownerRevertEpoch(uint64)` on fork | Flips `epochFinalized` true→false, `epochReverted` false→true |
| Pause matrix on fork | Registry pause does NOT pause bonus (independent ✓) |
| SWCP non-interference: BOTCOIN reads on the same fork | `totalSupply=1e29`, `symbol="BOTCOIN"`, `decimals=18` ✓ |
| `scripts/post-deploy-smoke.mjs` | OK |

Records in `ops/V0_VALIDATION_LOG.md`. The anvil-fork-mainnet run is strictly more thorough than a Base Sepolia deploy because Sepolia has none of the real upstream contracts; the fork has all of them.

## Open follow-ups (not blocking V0 architecture)

| # | What | Severity |
|---|------|----------|
| [#8](../../issues/8) | Phase 3 eval perf — incremental Merkle update (327 ms p50 vs 10 ms target) | **Hard blocker** for production miner viability |
| [#11](../../issues/11) | V1: collapse 5 vendored keccak copies to one canonical | Soft hardening |
| BASE_RPC_URL CI secret | Wire to GitHub Actions secrets so fork tests run on every PR | Operator action |
| Real Phase 7 baseline iteration | Pick winner, freeze `coreVersionHash` + `genesisStateRoot`, ≥1M fuzz | User research task |
| Real Phase 8 testnet run | ≥100 epochs / ≥1k patches / ≥10 auditor reproductions / latch-unlatch ×2 | User operator task |
| Mainnet deploy (Phase 9) | Operator-only; `ops/USER_ACTIONS_MAINNET.md` 11-step checklist | User operator task |

## Resolved / closed in this session

- Issue #4 — LoCoMo CC-BY-NC-4.0 (Path B). Closed.

## Recent decisions (last 10)

- 2026-05-05 — V0 policy: LoCoMo Path B, multisig deferred, 2.0× multiplier, Apache-2.0 license, repo private. Confirmed by user.
- 2026-05-05 — Anvil-fork-of-Base-mainnet validation: full lifecycle works end-to-end against real upstream chain state.
- 2026-05-05 — Forge fork tests now run with the public Base RPC (`https://mainnet.base.org`); user's Infura URL has unencoded `/+=` in basic-auth that broke Foundry parser. Public RPC sufficient for read-only fork tests.
- 2026-05-05 — All 9 phases + Phase 1 follow-up tagged on main.
- 2026-05-05 — Phase 8 golden e2e fixture is the CI merge gate; runs in-process (no testnet RPC needed).
- 2026-05-05 — Phase 9 mainnet scripts produce calldata only — never broadcast for the user.
- 2026-05-05 — keccak in 5 places consolidated to consistent canonical fix; V1 collapses to single import (issue #11).
- 2026-05-05 — Phase 5 hardcoded paths + `workspace:*` (pnpm) syntax fixed by driver.
- 2026-05-05 — Phase 1 second-impl is **Python 3** — caught three keccak bugs via cross-impl audit (PR #9).
- 2026-05-05 — Phase 3 eval perf measured at p50 ~327 ms (target 10 ms); architecture correct, follow-up issue #8.

## How to resume

```bash
cd /root/cortex
git fetch origin && git status
git tag --list 'v0.*'
gh issue list                     # 2 open: #8 perf, #11 keccak collapse
cat context.md                    # this file
cat ops/V0_VALIDATION_LOG.md      # what's been validated
```

For the next operator session:
1. Address [#8](../../issues/8) — incremental Merkle update so eval perf hits §9 budget.
2. Run Phase 7 real baseline iteration (`experiments/PHASE_7_USER_ACTIONS.md`).
3. Phase 8 testnet (`ops/testnet/USER_ACTIONS.md`).
4. Phase 9 mainnet (`ops/USER_ACTIONS_MAINNET.md`).
