# Cortex — Current Context

> Strict-rule file per ORGANISM_CORTEX_STATE_PLAN.md §13.5. Every agent updates this before pushing meaningful work. CI fails the PR if checklist items flipped without a context.md touch.

## Current state

**Phase 0 — Research lock + benchmark anchoring** (COMPLETE on branch `phase-0/research-lock`, PR open) and **Phase 1 — Cortex state spec** (in progress) running in parallel as background subagents.

Repo created at `botcoinmoney/cortex` (private), cloned to `/root/cortex`, default branch `main`. Top-level scaffold per §13.2 in place. Phase 0 deliverables landed:
- `specs/research_brief_v0.md` — full research brief (~5 pages): one-page thesis, source review for all 8 anchors, locked family weights (60/20/20), locked pass-rate targets (0%/5–10%/20–30%), failure modes, license summary.
- `specs/non_goals_v0.md` — verified + tightened: 12 hard-rejected items with rationale, 4 tracked V1 paths.
- `specs/license_audit.md` — NEW: per-source SPDX, redistribution OK?, attribution, pinned commit hash, Phase 4 status.
- `benchmark/sources.json` — NEW: machine-readable manifest for Phase 4 loader.

**Phase 0 license finding:** LoCoMo is CC-BY-NC-4.0 (NonCommercial) — BLOCKER for Phase 4 data loading in a commercial context. Resolution options documented in license_audit.md §4 and research_brief_v0.md §8.1.

`BotcoinMiningV3` is and will remain unchanged. Cortex is a parallel lane behind the same coordinator origin.

## Next steps

1. Merge Phase 0 PR into `main` after review (confirm LoCoMo blocker resolution path is acceptable).
2. Spawn Phase 1 (Protocol) subagent — write the five state-spec docs and stub the TS reference impl in `packages/cortex/src/state/`.
3. Spawn Phase 2 (EVM) subagent — write `contracts/src/CortexRegistry.sol` + `contracts/src/CortexMergeBonus.sol` skeletons with the §9 Phase 2 events and the audit-window/multisig override.
4. Begin `packages/cortex-handler` skeleton (the single-line drop-in router) so §13.4 plug-and-play stays honest from day one.
5. Resolve LoCoMo CC-BY-NC-4.0 blocker before Phase 4 begins: contact Snap Research OR select a permissive replacement dataset.

## Open questions / blockers

- **LoCoMo CC-BY-NC-4.0** — BLOCKER for Phase 4 data loading (commercial use prohibited). Options: (A) contact Snap Research for commercial license, (B) replace with permissive alternative, (C) derive synthetic equivalent. See `specs/license_audit.md` §4.
- **MemoryArena code repo URL** — project website links to github.com homepage only; no specific repo URL confirmed. Dataset (HF) is fine. Phase 4 must confirm before pinning code hash.
- **BEIR per-subset licenses** — MSMARCO and TREC-COVID require commercial-use review before Phase 4 loads them. NQ and HotpotQA are safe.
- **License**: defaulted to **Apache-2.0** (open source, patent grant). Override by replacing `LICENSE` and noting in this file.
- **Package manager**: defaulted to **npm workspaces** (no pnpm available on this host). All `pnpm` references in the plan map to `npm run`.
- **Open**: §6 receipt field mapping reuses `BotcoinMining` EIP-712 domain with `rulesVersion = 0xC0`. V1 path tracked: sister `submitCortexReceipt(...)` function. No human decision required for V0.
- **Open**: Multisig operator key set — needs human input before P9 first reward epoch. Captured as a gate, not a blocker for P0–P7.

## Recent decisions (last 10)

- 2026-05-05 — Phase 0 complete: research_brief_v0.md, non_goals_v0.md, license_audit.md, benchmark/sources.json written; family weights 60/20/20 and pass-rate targets 0%/5–10%/20–30% locked — Research subagent.
- 2026-05-05 — LoCoMo CC-BY-NC-4.0 flagged as Phase 4 blocker: commercial use prohibited; resolution options documented in license_audit.md §4 — Research subagent.
- 2026-05-05 — ERM documented as design principle, not a separate benchmark dataset; no additional license entry needed — Research subagent.
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
