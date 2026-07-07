# A2 unbrick bundle (`liveeval12-allfam-age32`) — arming procedure notes

Bundle: `release/calibration/2026-06-04-memory-atom-v16/bundle-manifest-v2-dgen1-policy-r5-atom-v16-300k-enabled-mirfull-temporal-conflict-motif-liveeval12-allfam-age32.json`
bundleHash `0xa3c1d470450ac445522817e4975f88de1af0b3e31a339e4bc291f9f398c6374b`.
Built + attested on branch `coretex-a2-unbrick`. NOT PINNED, NOT ARMED. Arming is an
operator decision outside the vNext program (handoff §4 A2); this document is the
REQUIRED procedure for that decision.

## Units: retirement runs per EVOLVE, not per epoch

`stepEpoch` executes only inside real evolves (`scripts/coretex-epoch-evolve.mjs`
`makeFrontier`); no-op epoch transitions carry the frontier forward unchanged
(coordinator `coretex-cutover-adapters.ts`). All frontier budgets
(`maxRootDeltaPerEpoch = 24`) are therefore spent per EVOLVE. At the A1 forced
cadence of 8 epochs/evolve, 24 rows/evolve = 3 rows/epoch equivalent. Every number
below states its cadence assumption.

## Code prerequisites (arm ONLY with these — revendor from this branch or its merge)

1. **Bounded aged drain** (`epoch-frontier.ts`): finite `maxAge` retires oldest-first,
   capped at `maxRootDeltaPerEpoch`, sharing the budget with churn. Without it, the
   live frontier state (9300/9319 active rows at activation epoch 0, reserve empty)
   mass-retires at the FIRST post-arm evolve (measured: active 9319 → 19, delta 387×
   the bound). Evidence: coordinator repo
   `.ops/bmu-evidence/track-a2/g-a4-retirement-sim-unpatched-code-live-state-maxage32.json`.
2. **Prune headroom + prune backfill** (`epoch-frontier.ts` + `scripts/coretex-epoch-evolve.mjs`):
   the runner's defense-in-depth check refuses a rotation when
   `max(activated, retired + prunedActive) > maxRootDeltaPerEpoch`. A saturated aged
   drain used to spend the whole budget, so ANY evolve that force-prunes even one
   active eval_hidden id (corpus removals; `evolveMaxRemovals` is wired) would
   hard-fail the cutover for the entire drain. `stepEpoch` now accepts the pruned
   count, leaves it headroom, AND backfills pruned actives from the reserve —
   closing a pre-existing prune-to-empty hole where pruning the whole active window
   left the frontier permanently empty despite a full reserve. Evidence:
   `g-a4-retirement-sim-rework-v2-prune-headroom-live.json` (12 evolves, 1 prune each:
   retired 23, runner delta exactly 24, all pass).
3. **Empty-active-frontier guards** (two layers, closing the G-A4 empty-set condition):
   (a) `scripts/coretex-epoch-evolve.mjs` `makeFrontier` REFUSES to publish any rotation
   whose post-step active eval_hidden count is 0 — defense-in-depth against an explicit
   `--min-fresh-eval-hidden 0` operator override (the default mint-floor quota of 8
   already makes this unreachable otherwise); the refused rotation leaves stable state
   untouched. (b) `scripts/arm-liveeval-bundle.mjs` REFUSES to generate a bundle pinning
   finite `maxAge` when the profile pins `evolve.minFreshEvalHiddenPerEpoch < 1`
   (finite maxAge + a zero fresh-mint floor = guaranteed eventually-empty active set;
   loaders fail closed).

## REQUIRED at arm: genesis frontier-state rewrite

Without mitigation, arming finite `maxAge` against the live state queues a
9300-row aged backlog draining at ≤ 24 rows/EVOLVE:
**388 evolves ≈ 3,104 production epochs ≈ 8.5 years at daily epochs / cadence 8**
(measured: genesis flush completes at evolve 388, minted rows queue behind it up to
age 3,096 epochs — `g-a4-retirement-sim-rework-v2-unmitigated-live-state.json`).
That makes `maxAge: 32` meaningless on any real horizon.

**The budget math cannot be closed by stagger at ANY maxAge:** drain horizon =
`N × cadence / perEvolveBudget` epochs, independent of maxAge (maxAge only shifts
when the drain starts). With budget 24 − 12 (steady-state minted-row aging) − 2
(prune headroom) = 10 genesis rows/evolve: 930 evolves ≈ 7,440 epochs ≈ 20 years.

**Recommended procedure — retire-genesis at arm:**

```bash
# offline copy of the live state; NEVER point --in/--out at /var/lib/coretex
node scripts/coretex-stagger-frontier-activation.mjs \
  --in <copy-of-frontier-state.json> --out <rewritten-state.json> \
  --mode retire-genesis --arm-epoch <armEpoch> --max-age 32
```

Moves the epoch-0 rows into the retired set (deterministic, order[]-position
ordered; prints old/new `activeFrontierRoot` + writes a `.meta.json` sibling).
**The rewrite MUST be re-run at arm time on the THEN-CURRENT live frontier state,
and the fresh `.meta.json` roots used for the repin.** Any roots quoted in this
program's evidence (e.g. old `0xd00a3f32…` -> new `0x2edb5d12…`) are valid ONLY for
the epoch-136 snapshot they were computed from — the live state advances with every
evolve, so a stale rewrite output would fail the root-verified loaders at arm.
Genesis rows are non-`zz_e` and can never enter scored packs via the liveEvalPack
overlay anyway; base broad packs sample ALL eval_hidden rows regardless of active
status — the rewrite changes only overlay bookkeeping and the pinned root. Apply as
part of the ATOMIC arming transition: repin the new root together with the bundle
transition + two-pass GPU rebaseline (G-A5), BEFORE the first post-arm evolve.

Measured post-rewrite behavior (80 evolves, cadence 8, 12 mints/evolve, dead lane —
`g-a4-retirement-sim-rework-v2-retire-genesis.json`): every evolve ≤ 24 root delta
(max 12); minted rows rotate out after 8–16 epochs (1–2 evolves) via pre-existing C3
churn; `maxAge` acts as the anti-stall backstop — with minting stopped, rows retire
at the first evolve past age 32 (measured ages 33–36; worst case
maxAge + cadence − 1 = 39 epochs — `…-retire-genesis-nomints.json`).

**Alternative (audit only) — budget-derived stagger:** `--mode stagger` rewrites
genesis activation epochs so age-eligibility flows at
`maxRootDelta − mintPerEvolve − pruneHeadroom` rows/evolve, staying budget-legal
including prune headroom (measured: runner delta ≤ 24 every evolve with 2
prunes/evolve — `…-staggered-b10.json`). Horizon ≈ 930 evolves ≈ 7,440 epochs ≈ 20
years at daily epochs: legal but NOT meaningful; use only if a slow bookkeeping
drain is explicitly wanted.

## Operator caveats

- **Empty-set edge:** maxAge + a stalled mint lane can empty the active set (measured
  at evolve 5 with zero mints post-rewrite); `loadActiveFrontierIds` fail-closes on an
  empty set. The runner now REFUSES to publish such a rotation at the source (guard 3a
  above), so the failure surfaces at the evolve, not downstream at loaders — but the
  evolve still stalls until fresh rows mint. A1's forced evolves mint on every real
  evolve; confirm additions are nonzero before arming and monitor
  `activeEvalHiddenCount` after.
- **Rebaseline cadence:** `baselineRecompute: activeRootChanged` fires the two-pass GPU
  rebaseline at every EVOLVE whose root moves (post-rewrite: every evolve with churn or
  aged retirement — i.e., effectively every forced evolve), not every epoch.
- **Shortened evolve cadence** (`maxEpochsBetweenEvolves` < 8) proportionally tightens
  the effective retirement latency in epochs (worst case maxAge + cadence − 1) and
  raises GPU rebaseline frequency; it does NOT change per-evolve budgets.
- Rebaseline under the new pack law is REQUIRED before pinning: the bundle still
  carries the source baseline (`baselineParentScorePpm` 288438).
