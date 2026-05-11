# CoreTex V4 — Indefinite Scalability Hardening Plan (Surgical, Baseline-Normalized)

Last updated: 2026-05-10 (post Phase-13 / anvil e2e; revised to remove corpus-hardness abstraction entirely).

Status: pre-launch refinement. This plan is **additive only** to the controlling `CORETEX_LAUNCH_PLAN_v2.md` and `CORETEX_V4_FRONTIER_RETRIEVAL_HARDENING_PLAN.md`. It hardens long-term scaling by making difficulty emerge naturally from corpus growth against the fixed 1024-word substrate, scored by the same pinned evaluator, with baseline re-evaluation per corpus root. No new meta-knobs, no credit-based gating, no operator-controlled hardness levers.

Non-negotiables preserved:
- 24-hour epochs (V3 finalize cron unchanged).
- Credit/BPS system (`coretexCredits`, screener lane + state-advance tiers in `work-units.ts`) remains the sole economic differentiator.
- Substrate remains fixed 1024-word body; miners compete on retrieval compression into that fixed capacity.
- Difficulty levers remain `minImprovementPpm` ramp/decay + pack size + strata quotas (never structural-commitment or slot-count).
- Replay determinism (`replayTolerancePpm`) and `bundleHash` binding unchanged.
- Small/API-only miners retain viable persistence path via screener credits + tiered BPS.

Goal: as the corpus expands (more records, domains, temporal revisions, relation depth, distractors, hidden queries), the same 1024-word substrate must compress more useful retrieval structure. Improvement becomes naturally harder. Difficulty scales because the benchmark task scales, not because a second system says “hardness went up.”

## Core Design Principle (User-Corrected)

Difficulty must emerge from the benchmark distribution + fixed substrate constraint, not from an extra meta-score.

The scalable loop is:
1. Corpus expands with richer structure.
2. Same pinned evaluator scores the current parent substrate against the new hidden pack.
3. Canonical baselines (empty, previous-epoch, frequency/coverage, visible-split) are re-evaluated on the same pack.
4. Miner patches are accepted only if they improve the parent substrate by `minImprovementPpm` calibrated against baseline variance + replay tolerance.
5. As corpus richness grows, the fixed 1024-word capacity forces better compression; raw improvement becomes harder while the comparison baseline stays fair.

**We do not implement any CorpusHardnessIndex or hardness knob.** Such a knob would be operator-controlled over-engineering that risks cliffs, false signals, and unnecessary complexity. The correct mechanism is baseline re-evaluation + direct benchmark controls (pack size, strata depth, distractor density, protected floors, fixed capacity).

## Identified Scaling Risks (Corrected Scope)

1. **Difficulty calculator is miner-output-only** (`rewards/difficulty.ts`). Large corpus deltas can shift raw score distributions. A +2500 ppm improvement on yesterday’s corpus may not mean the same thing on tomorrow’s richer corpus. Without baseline re-evaluation, we risk either false easing (decay when the task got harder) or zero-advance cliffs (threshold stays high while baseline scores dropped). The fix is not a hardness knob; the fix is to re-run the baseline suite on every new corpus root / hidden pack and normalize acceptance against observed baseline variance.

2. **Hidden-pack stratification lacks explicit depth / causal / temporal pressure** (`eval/hidden-query-pack.ts`). Current `stratumOf` returns a single exact string (`family=...,bucket=...`). Deep causal chains, long relation paths, and high temporal churn can be under-sampled. Miners will naturally optimize the easier high-frequency strata. The fix is `strataOf(event): string[]` + synthesis-time `causalDepth` / `relationHopDepth` metadata + dynamic runway-based quotas so the benchmark samples the intended skills at scale.

3. **Coordinator rate-limit envelope and delta handling are static**. Large deltas or sudden miner floods can create head-of-line blocking. We need a one-epoch “major delta grace” guard (re-evaluate baselines before allowing any threshold movement) and abuse-only rate limits (flat per-miner ceilings + global backpressure). No credit math.

**We explicitly reject any credit-based or “rich get richer” rate-limit policy.** Rate limits exist solely to prevent abuse. The credit/BPS tier system already provides economic differentiation. Adding credit multipliers, weighted fair queues, or reserved lanes adds complexity with zero abuse-model benefit and risks starving the very miners the tiered BPS is meant to protect. Flat ceilings + backpressure are sufficient.

These are the only gaps. The architecture already supports indefinite scaling once baseline re-evaluation and proper strata sampling are wired in.

## Surgical Changes (minimal, additive, existing paths only)

All changes are pure extensions or one-line wirings. No removal of existing logic, no new reward law, no GPU path, no change to 1024-word layout or epoch length.

### Change Set A — Baseline Re-Evaluation + Major-Delta Grace (addresses risk #1)

**No CorpusHardnessIndex or hardness knob is added.** Difficulty emerges from corpus growth + fixed 1024-word substrate + same pinned evaluator.

**A.1** New small pure helper `evaluateBaselines` in `rewards/baseline.ts` (or append to `difficulty.ts`):

```ts
export interface BaselineScores {
  readonly emptySubstrate: number;
  readonly previousEpoch: number;
  readonly frequencyBaseline: number;
  readonly visibleSplitBaseline: number;
  readonly variancePpm: number;
}

export function evaluateBaselines(
  queryPack: QueryPack,
  corpus: ProductionCorpus,
  biEncoder: BiEncoder,
  reranker: CrossEncoderReranker
): BaselineScores;
```

This re-runs the existing `evaluateRetrievalBenchmarkState` on four canonical substrates. Deterministic, CPU-only, cheap relative to the full pack.

**A.2** In `nextMinImprovementPpm`, add one guard (no new ratio branch):

- If the just-applied `CorpusDelta` is large (new eval-hidden count > calibrated majorDeltaThreshold), set `reason = 'major_delta_grace'` and:
  - Freeze `minImprovementPpm` at the prior value (no upward movement).
  - Suppress decay (do not ease).
- Grace lasts exactly one epoch. During grace the coordinator must re-run the baseline suite and publish new baseline scores + observed variance before the next `initializeEpoch`.
- After grace, `minImprovementPpm` may move only if observed ability to beat the parent substrate (relative to baseline variance + replay tolerance) supports it.

Existing ramp/decay on pure miner-output signals remain unchanged.

**A.3** Wiring (one call site):
- After `applyCorpusDelta`, if delta is major, mark grace flag and require baseline re-evaluation before next epoch freeze.
- Baseline scores recorded in epoch metadata (off-chain, signed, reproducible by watchers).

**A.4** Reporting:
- Every signed receipt includes (or links to) the four baseline scores for that epoch’s hidden pack.
- Miners/watchers see exact headroom above the strongest baseline.

This solves score-shift across corpus growth without any external hardness lever. Improvement is always relative to the actual parent substrate on the actual current corpus distribution.

### Change Set B — Causal-Depth Stratification in Hidden Packs (addresses risk #2)

**B.1** Replace `stratumOf(event)` with `strataOf(event): string[]` in `eval/hidden-query-pack.ts`. An event can now satisfy multiple overlapping strata simultaneously (family, bucket, depth predicates). This is a one-function change; the quota matcher in `buildQueryPack` is updated to accept predicate-style quota strings such as `depth>=2` or `family=multi_hop_relation,depth>=3`.

**B.2** Add two first-class numeric fields to `ProductionCorpusEvent` (and the synthesizer output schema):

- `causalDepth: number` — explicit depth of the longest causal / temporal / derivation chain leading to this record (computed by the challenge-library bridge at synthesis time from the session-pair / bookend structure).
- `relationHopDepth: number` — maximum relation-graph distance from any truth document to the query (also synthesis-time).

These are **not** inferred post-hoc from edge count. The corpus generator (already the source of truth for families and qrels) now emits them. Old records default to 1.

**B.3** `HiddenPackProfile` quotas remain `PackQuota[]` but the calibrator (`scripts/calibrate.mjs`) now **computes** the minCount values dynamically from:

- current availability of each stratum in eval_hidden
- desired per-stratum runway (epochs until exhaustion under current pack size K and cadence)

Hardcoded examples like `depth=2 min 8` are removed. The bundle profile records the computed quotas + the runway target; replay uses the same deterministic computation from the pinned corpus.

**B.4** No change to `multiHopRelationRecallAtK`, `ir-metrics.ts`, or composite weights. The existing sub-metric already rewards reachability within the calibrated hop budget. The new strata simply guarantee that deep causal / temporal / multi-hop memory is sampled at a rate proportional to its growing importance in the corpus.

This makes the v3-style causal reasoning challenges first-class, satisfiable, and non-brittle inside the retrieval benchmark without altering the reward law or creating unsatisfiable quotas.

### Change Set C — Major-Delta Grace + Abuse-Only Rate Limits (addresses risk #3)

**C.1** Add `deltaEventCount` and `isMajorDelta` to the epoch snapshot (already computed during delta application).

**C.2** "Major delta grace" rule (one paragraph in difficulty logic and production runbook): after a corpus delta whose new eval-hidden count exceeds the calibrated majorDeltaThreshold, the next epoch freezes `minImprovementPpm` and suppresses decay. The coordinator must re-run the baseline suite before the following `initializeEpoch`. Grace lasts exactly one 24 h cycle. The grace flag is recorded in epoch metadata for replay.

**C.3** Rate limits remain flat per-miner ceilings + global backpressure (503 on queue saturation). No credit math, no weighted queuing, no reserved lanes. Abuse prevention only.

This is the minimal guard that prevents one-epoch cliffs after large corpus expansions while keeping the difficulty signal clean.

## Implementation Phases (sequential, each with green gate before next)

### Phase S1 — Spec & Type Extensions
- Add `evaluateBaselines` helper + `BaselineScores` type (new file or append to `rewards/difficulty.ts`).
- Replace `stratumOf` with `strataOf(event): string[]`, add `causalDepth` / `relationHopDepth` to `ProductionCorpusEvent`.
- Update `specs/hidden_query_pack_v0.md` and `specs/retrieval_benchmark_v0.md` (one paragraph each on baseline re-evaluation and dynamic quota computation).
- Acceptance gate: `npm run typecheck && npm test -- rewards/difficulty.test.ts hidden-query-pack.test.ts` (new tests pass; no hardness or credit code).

### Phase S2 — Difficulty Module Hardening
- Implement the major-delta grace guard in `nextMinImprovementPpm` (freeze + no-decay for one epoch after large delta; require baseline re-run before next movement).
- Add unit tests: "large delta triggers grace and freezes threshold"; "baseline variance is published and used for acceptance".
- Re-run existing difficulty histogram (identical output when no major delta).
- Gate: `node scripts/difficulty-sweep.mjs --with-baseline-grace` passes; no regression.

### Phase S3 — Pack Stratification + Dynamic Causal Quotas
- Implement `strataOf` + predicate quota matcher in `hidden-query-pack.ts`.
- Add `causalDepth` / `relationHopDepth` emission to the corpus generator (challenge-library bridge at synthesis time).
- Update calibrator to compute stratum quotas from availability + desired runway (no hardcoded examples).
- Gate: Phase-13 e2e re-run with corpus containing explicit depth≥3 causal records; deep-causal strata are proportionally represented and contribute to `multiHopRelationRecallAtK`.

### Phase S4 — Baseline Re-Evaluation + Major-Grace Wiring + Abuse-Only Limits
- Wire `evaluateBaselines` call after every major delta (one call site in epoch-close reducer).
- Implement grace flag + baseline publication in coordinator finalize path.
- Confirm flat per-miner ceilings + global backpressure in endpoints (no credit math anywhere).
- Update production runbook §6 with grace rule, baseline reporting, and "abuse-prevention only" rate-limit policy.
- Gate: anvil e2e with 5k-event delta; baselines re-evaluated, grace applied correctly, no zero-advance cliff, replay matches.

### Phase S5 — Full Validation & Bundle Pin
- Re-run full calibration + determinism + Phase 13 on the launch corpus (v2 Phase 4) with baseline re-evaluation and dynamic strata.
- Run `validate-retrieval-corpus.mjs` + capacity estimator with projected daily deltas.
- Gate: all acceptance criteria from the frontier retrieval hardening plan remain green; new scalability tests (baseline normalization, deep causal strata satisfiable, no credit gating, no hardness knob) pass.

### Phase S6 — Mainnet Canary + Watcher Fleet
- Same as v2 Phase 6–8, plus one extra watcher alert: "major corpus delta — baseline re-evaluation + grace epoch active".
- After first 7 epochs with real deltas, publish a short addendum confirming difficulty emerges naturally from corpus growth + fixed substrate, baselines are reproducible, and deep causal memory remains incentivized.

## Why These Changes Deliver Indefinite Scaling

- **Difficulty emerges naturally from corpus growth + fixed substrate**: as the corpus expands with richer structure (more domains, deeper causal/temporal chains, higher distractor density), the same 1024-word substrate must compress more useful retrieval information. The same pinned evaluator scores the parent substrate against the new distribution; improvement becomes harder without any external knob.
- **Baseline re-evaluation keeps comparisons fair across corpus deltas**: every major delta triggers a one-epoch grace during which the canonical baseline suite (empty, previous-epoch, frequency, visible-split) is re-run on the new hidden pack. Acceptance is normalized against observed baseline variance + replay tolerance. No score-shift cliffs or false easing.
- **Credit / BPS system remains the sole economic differentiator**: small/API miners retain the screener lane + tiered state-advance BPS. Rate limits are flat abuse-prevention only (no credit math, no weighted queuing).
- **v3 causal reasoning merges cleanly and satisfiably**: synthesis-time `causalDepth` / `relationHopDepth` + `strataOf(event): string[]` + dynamic runway-based quotas guarantee deep causal / temporal / multi-hop memory is proportionally sampled without unsatisfiable strings or post-hoc inference.
- **1024-word substrate as perpetual frontier**: as corpus richness grows, the only way to keep winning advances is better compression and retrieval inside the fixed layout. Future forks can expand the word count; v4 stays on the current 1024-word compression arms race.
- **Operational envelope scales**: major-delta baseline grace + abuse-only rate limits prevent both starvation and one-epoch cliffs. Daily deltas remain cheap (CPU-only BGE-M3 + synthesizer labels) and automatically feed the baseline re-evaluation loop.
- **Replay & determinism untouched**: all new values (baseline scores, strata, grace flags) are deterministic functions of corpus + delta + epoch seed; watchers reproduce them exactly.

## Non-Changes (intentional)

- No modification to `nDCG@10` dominance, composite weights, `replayTolerancePpm`, model pins, or bundleHash semantics.
- No expansion of Relations region or hop budget in v4 (those are calibration outputs; future fork can increase them).
- No new on-chain fields or contract changes (difficulty snapshot stays off-chain, same as current `qualityAttempts`).
- Epoch length, finalize cron, and V3 credit ledger unchanged.

## Acceptance for "indefinitely scalable production system"

After Phase S5:
- `evaluateBaselines` runs on every major corpus delta; baseline scores (empty, previous-epoch, frequency, visible-split) + variance are published and reproducible by watchers.
- Major-delta grace (one-epoch threshold freeze + no decay) prevents both inappropriate easing and zero-advance cliffs after large corpus expansions.
- `strataOf(event): string[]` + synthesis-time `causalDepth` / `relationHopDepth` + dynamic runway-based quotas make deep causal / temporal / multi-hop strata proportionally represented and satisfiable in every hidden pack.
- No credit-based gating, weighted queuing, or hardness knob exists anywhere in the coordinator or difficulty path.
- Historical difficulty histogram + projected 6-month corpus growth shows `minImprovementPpm` tracking real substrate improvement (relative to baselines) without hitting MAX or causing zero-advance epochs.
- All existing Phase-13 / anvil / determinism / replay guarantees remain byte-identical.

This plan closes the only three loops that could have caused difficulty to plateau or small miners to be crowded out, while preserving every non-negotiable of the current v4 architecture. It is the minimal surgical hardening required for the "path to scaling indefinitely in size / difficulty" requirement. Difficulty emerges naturally because the retrieval task grows while the substrate stays fixed at 1024 words. No over-engineering (hardness knobs, credit-aware limits, brittle delta triggers, or post-hoc depth inference) is introduced.

Next step after launch: re-calibrate the exact major-delta threshold, grace duration, baseline variance multiplier for `minImprovementPpm`, and dynamic quota runway targets on the first 30 mainnet epochs (same process as the original calibration phase). The mechanism is already in place; only the numeric pins move.