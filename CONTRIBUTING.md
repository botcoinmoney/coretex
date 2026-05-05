# Contributing to Botcoin Cortex

This file codifies the strict process discipline from [`ORGANISM_CORTEX_STATE_PLAN.md`](./ORGANISM_CORTEX_STATE_PLAN.md) §13.3, §13.5, §13.6.

## Branching

- Default branch: `main`. PRs only — no direct pushes (enforced by branch protection).
- Phase work branches: `phase-N/<short-name>` (e.g. `phase-1/state-spec`).
- Cross-cutting work: `chore/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.

## Commit cadence (§13.3)

- **One commit per completed checklist item** at minimum. Larger work splits into atomic commits.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `chore:`, `spec:`, `bench:`, `ops:`, `feat(contracts):`, `test(contracts):`, etc.
- Push at least once per working session — do not let local commits sit overnight.
- AI-assisted commits MUST carry a `Co-Authored-By:` trailer attributing the agent.
- No `--no-verify`. No force-push to `main`.
- PRs land squashed; PR title is the deliverable, not the file list.

## `context.md` discipline (§13.5)

- `context.md` is the single source of truth for "where the project is right now."
- Updated **before every git push** that closes a meaningful unit of work.
- New entries append. Outdated entries are crossed out with a date and reason — never erased. Older entries (>10 in `Recent decisions`) move to `context-archive.md`.
- CI fails the PR if a checklist item flipped without a `context.md` touch (heuristic in `scripts/check-context-freshness.mjs`).
- Required sections: Current state · Next steps · Open questions / blockers · Recent decisions · How to resume.
- If `context.md` and `ORGANISM_CORTEX_STATE_PLAN.md` disagree on phase status, the plan is canonical. Reconcile in the next commit.

## Phase tags

Tag at every phase boundary: `v0.phase-1`, `v0.phase-2`, … `v0.mainnet`. Phase tags are immutable handoff anchors. Created by the driver after the phase E2E gate is green and the merge to `main` lands.

## CI gates (§13.6)

In order: lint → type → unit → contract (forge) → integration → phase-scoped E2E. Phase-scoped suites are tagged `e2e:phase-N`; run in isolation via `npm run test:e2e -- --filter phase-N`. The aggregate `e2e:all` is the gate for `main`.

A green `e2e:all` plus a current `context.md` is the precondition for every merge into `main`.

## Subagent / multi-author workflow

1. Driver creates phase work branches (`git worktree add /root/cortex-pN -b phase-N/...`).
2. Subagent opens a PR from its branch via `gh pr create`. PR body lists which §9 Phase-N checklist items the PR satisfies and any blockers.
3. Driver reviews, requests changes if needed, merges with squash.
4. Driver updates `context.md` on `main` after each merge — **only the driver touches `context.md`** to avoid merge-conflict thrash across parallel branches.
5. Driver tags `v0.phase-N` after the phase E2E gate is green and the PR lands on `main`.

## License & attribution

All contributions Apache-2.0. Co-Authored-By trailers on AI-assisted commits.
