# Cortex — Current Context

> Strict-rule file per ORGANISM_CORTEX_STATE_PLAN.md §13.5. Every agent updates this before pushing meaningful work. CI fails the PR if checklist items flipped without a context.md touch.

## Current state

**Phase 0 — Research lock + benchmark anchoring** (in progress) and **Phase 1 — Cortex state spec** (in progress) running in parallel as background subagents.

Repo created at `botcoinmoney/cortex` (private), cloned to `/root/cortex`, default branch `main`. Top-level scaffold per §13.2 in place: `README.md`, `LICENSE` (Apache-2.0), `instructions.md`, `context.md`, `package.json` (npm workspaces), `tsconfig.base.json`, `.github/workflows/ci.yml` (lint→type→unit→contracts→phase-scoped E2E→e2e:all merge gate), `scripts/run-e2e.mjs` phase aggregator, `scripts/check-context-freshness.mjs` PR gate. `packages/{cortex,cortex-server,cortex-handler}/`, `contracts/{src,script,test}/`, `specs/`, `benchmark/{generators,fixtures}/`, `ops/`, `test/e2e/` directories created. No phase-deliverable code yet.

`BotcoinMiningV3` is and will remain unchanged. Cortex is a parallel lane behind the same coordinator origin.

## Next steps

1. Spawn Phase 0 (Research) subagent — write `specs/research_brief_v0.md`, `specs/non_goals_v0.md`, lock benchmark licenses + family weights + pass-rate targets.
2. Spawn Phase 1 (Protocol) subagent — write the five state-spec docs and stub the TS reference impl in `packages/cortex/src/state/`.
3. Spawn Phase 2 (EVM) subagent — write `contracts/src/CortexRegistry.sol` + `contracts/src/CortexMergeBonus.sol` skeletons with the §9 Phase 2 events and the audit-window/multisig override.
4. Begin `packages/cortex-handler` skeleton (the single-line drop-in router) so §13.4 plug-and-play stays honest from day one.
5. Wire foundry submodules (`forge-std`, `openzeppelin-contracts`) and a Base mainnet fork test harness for P2 E2Es.

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

## How to resume

```bash
cd /root/cortex
git status                       # confirm branch + clean tree
git log --oneline -10            # see recent commits
cat context.md                   # this file (already)
# Then read ORGANISM_CORTEX_STATE_PLAN.md for the relevant phase only.
# Do NOT skim the whole repo — context.md exists to make that unnecessary.
```

If context-window pressure forces a handoff:
1. Update `## Current state` and `## Next steps` above.
2. Append a single-line entry to `## Recent decisions`.
3. Commit `context.md` and push.
4. End the session with a one-sentence summary.

The next agent (or the user resuming a wake) reads `context.md` first, then the relevant phase section of `ORGANISM_CORTEX_STATE_PLAN.md`, then only the files needed.
