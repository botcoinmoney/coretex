# CoreTex Calibration Agent Runbook

Purpose: instructions for a standalone calibration AI agent running the full
CoreTex corpus build, pinned-model calibration, determinism checks, and
end-to-end retrieval-mining tests.

For the full launch-blocking orchestration, including Base mainnet contract
interaction and independent replay verification, use
`docs/CORETEX_FINAL_PRODUCTION_E2E_ORCHESTRATOR_RUNBOOK.md` as the controlling
runbook. This file is the calibration sub-agent slice.

This agent does not need coordinator write access. It needs the CoreTex repo,
the built coordinator challenge package, model-cache storage, and enough CPU
time to run BGE-M3 plus Qwen3-Reranker-0.6B. Hard-negative qrels for the
production corpus come from synthesizer categories through the bundle's
`negCategoryRelevanceMap`; MemReranker-4B is an offline audit/reference model,
not a required per-record production labeler.

## Launch Corpus Size Gate

The smoke corpus in `artifacts/coretex` is not the launch corpus. It currently
contains 876 events and exists only to prove plumbing. The launch profile is:

```
domains=companies,quantum_physics,computational_biology,scrna_imputation
seedsPerDomain=512
modifierCounts=0,1,2,3
constraintDifficulties=easy,medium,hard
trapCount=2
hiddenPack.packSize=128
```

Capacity estimate run on 2026-05-10:

```
node scripts/estimate-coretex-corpus-capacity.mjs \
  --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
  --seeds-per-domain 512 \
  --epochs-per-day 3 \
  --pack-size 128 \
  --min-months 6
```

Observed:

```
totalEvents=678910
evalHiddenEvents=101836
noRepeatEpochs=795
noRepeatMonths=8.83 at 3 epochs/day
familyCounts:
  near_collision=380928
  temporal=52222
  long_horizon=220492
  multi_hop_relation=25268
```

This passes the launch gate before any epoch-by-epoch corpus deltas are added.
At 1 epoch/day the same corpus provides 26.5 no-repeat months. The coordinator
still appends new deltas every epoch, so the live corpus should grow faster
than hidden-pack consumption.

## Agent Contract

The calibration agent completes every step below and writes all artifacts. If a
step depends on a missing prerequisite, the agent creates or builds that
prerequisite and continues.

Required outputs:

- `/var/lib/coretex/corpus-epoch-0.json`
- `/var/lib/coretex/reports/corpus-validation.json`
- `/var/lib/coretex/reports/determinism-host-$HOSTNAME.json`
- `/var/lib/coretex/reports/determinism-aggregate.json`
- `/etc/coretex/bundle-profile.json`
- `/etc/coretex/bundle-manifest.json`
- `/var/lib/coretex/reports/phase13-real-reranker.log`
- `/var/lib/coretex/reports/corpus-capacity.json`

## Procedure

> **Note on prior-run evidence.** A complete end-to-end calibration pass
> on 2026-05-10 already validated every step of this runbook against a
> 1,752-event interim corpus (errors=0, determinism 0 ppm, Phase 13 PASS
> with adversarial sub-test rejected per spec). Full evidence at
> `/var/lib/coretex/reports/` and narrative at
> `docs/CORETEX_CALIBRATION_2026-05-10.md`. When re-running against the
> launch corpus, consult `docs/CORETEX_POST_CORPUS_PLAYBOOK.md` for the
> 11-step sequence and prior-run reference numbers to compare against.

1. Build CoreTex and the coordinator challenge package.

```bash
cd /root/cortex
npm ci
npm run build

cd /root/botcoin-coordinator-live/packages/challenges
npm ci
npm run build
```

2. Verify launch corpus capacity.

```bash
cd /root/cortex
node scripts/estimate-coretex-corpus-capacity.mjs \
  --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
  --seeds-per-domain 512 \
  --epochs-per-day 3 \
  --pack-size 128 \
  --min-months 6 \
  --out /var/lib/coretex/reports/corpus-capacity.json
```

3. Generate the production corpus with pinned models.

```bash
CORETEX_CORPUS_PRODUCTION=1 \
CORETEX_BIENCODER=pinned \
CORTEX_REAL_EVAL=1 \
CORETEX_RERANKER=qwen3 \
CORETEX_RERANKER_PRODUCTION=1 \
node scripts/generate-coretex-retrieval-corpus.mjs \
  --source challenge-library \
  --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --domains companies,quantum_physics,computational_biology,scrna_imputation \
  --seeds-per-domain 512 \
  --modifier-counts 0,1,2,3 \
  --constraint-difficulties easy,medium,hard \
  --trap-count 2 \
  --corpus-epoch 0 \
  --out /var/lib/coretex/corpus-epoch-0.json
```

4. Validate corpus shape.

```bash
node scripts/validate-retrieval-corpus.mjs \
  --corpus /var/lib/coretex/corpus-epoch-0.json \
  --min-events 650000 \
  --min-per-family 25000 \
  --min-hard-negatives 3 \
  --out /var/lib/coretex/reports/corpus-validation.json
```

5. Run determinism on each calibration host.

```bash
node scripts/determinism-check.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --pairs /var/lib/coretex/determinism-1k-pairs.json \
  --max-tolerance-ppm 250 \
  --report /var/lib/coretex/reports/determinism-host-$HOSTNAME.json
```

6. Aggregate determinism reports.

```bash
node scripts/aggregate-determinism.mjs \
  --reports '/var/lib/coretex/reports/determinism-host-*.json' \
  --max-tolerance-ppm 250 \
  --out /var/lib/coretex/reports/determinism-aggregate.json
```

7. Calibrate the bundle profile.

```bash
node scripts/calibrate.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --calibration-corpus /var/lib/coretex/corpus-epoch-0.json \
  --determinism-aggregate /var/lib/coretex/reports/determinism-aggregate.json \
  --pack-size 128 \
  --min-improvement-ppm 2500 \
  --out /etc/coretex/bundle-profile.json
```

8. Build the final bundle manifest.

```bash
npm run build:bundle -- \
  --corpus /var/lib/coretex/corpus-epoch-0.json \
  --profile /etc/coretex/bundle-profile.json \
  --out /etc/coretex/bundle-manifest.json
```

9. Run Phase 13 with real models.

```bash
CORETEX_BUNDLE_MANIFEST=/etc/coretex/bundle-manifest.json \
CORETEX_CORPUS=/var/lib/coretex/corpus-epoch-0.json \
CORETEX_BIENCODER=pinned \
CORETEX_RERANKER=qwen3 \
CORTEX_REAL_EVAL=1 \
CORETEX_RERANKER_PRODUCTION=1 \
ITERATIONS=25 \
node test/e2e/phase-13/run.mjs \
  2>&1 | tee /var/lib/coretex/reports/phase13-real-reranker.log
```

10. Rehearse an epoch-1 corpus delta.

```bash
CORETEX_CORPUS_PRODUCTION=1 \
CORETEX_BIENCODER=pinned \
node scripts/generate-coretex-retrieval-corpus.mjs \
  --source challenge-library \
  --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
  --bundle-manifest /etc/coretex/bundle-manifest.json \
  --previous-corpus /var/lib/coretex/corpus-epoch-0.json \
  --domains companies,quantum_physics,computational_biology,scrna_imputation \
  --seed-offset 512 \
  --seeds-per-domain 16 \
  --modifier-counts 0,1,2,3 \
  --constraint-difficulties easy,medium,hard \
  --trap-count 2 \
  --corpus-epoch 0 \
  --epoch 1 \
  --out /var/lib/coretex/corpus-epoch-1.json \
  --delta-out /var/lib/coretex/deltas/corpus-delta-1.json
```

## Pass Criteria

- Capacity gate passes for `minMonths >= 6` at the intended epoch cadence.
- Corpus validation has zero errors.
- Determinism aggregate P99 is `<= replayTolerancePpm`.
- Calibrated `replayTolerancePpm < minImprovementPpm`.
- Bundle manifest verification succeeds.
- Phase 13 accepts real retrieval improvements and rejects the adversarial
  `no_retrieval_improvement` patch.
- Epoch-1 delta preserves `previousRoot -> nextRoot` continuity.

## Orchestrator Operating Contract

Pre-launch system. Treat live code as the source of truth; docs may be stale
unless verified against current implementation, bundle profile, scripts, and
generated artifacts. **Never** call CoreTex V0 or legacy — there is no public
legacy path. Evaluate as the current launch candidate.

### Primary Objectives

Optimize for: maximum long-term substrate runway · minimal plateau risk ·
correct dynamic difficulty · robust corpus scaling · low random-patch false
acceptance · resistance to pretesting/gaming/scorer exploitation · faithful
alignment between calibration findings, signed bundle pins, and runtime
evaluator behavior.

### Non-Negotiable Method

- Do **not** infer health from tail logs or "still running." Compute the gate
  metric.
- If a run/script/dep/model/artifact is missing or broken, **fix the correct
  path.** Do not bypass, downshift silently, or substitute easier approximations
  unless explicitly labeled non-gating diagnostic.
- On error: inspect the specific code path, inputs, profile values, bundle
  pins, and generated output **before** changing approach.

### Calibration → Runtime Contract

Every finding must have a clear path into live behavior:

- Scorer parameter → pinned in signed bundle profile.
- Patch acceptance → flows through `computeAcceptanceThresholdPpm` or the
  explicit production threshold.
- Per-patch eval → verified through the real evaluator path.
- Difficulty → reflected in `nextMinImprovementPpm`.
- Corpus growth → interacts correctly with `isMajorDelta` + grace-cycle
  behavior.
- Anti-gaming → tested against random probes, dual-pack scoring, blockhash-bound
  evaluation where applicable.

**Required provenance on every accepted artifact**: git SHA · dist hash · git
cleanliness · bundle hash · corpus root · profile values actually used ·
model IDs + revisions · relevant env vars · output artifact path.

### Bundle/Profile Discipline

Scripts must unwrap correctly:

```js
const raw = JSON.parse(...);
const profile = raw.profile ?? raw;
```

Silent fallback to `DEFAULT_PROFILE` when a wrapped launch profile is supplied
is a blocking bug.

Critical pins to verify: `pipelineVersion`, `firstStageTopK`,
`rerankerInputTopK`, `rerankerTopK`, `retrievalKeyTopK`, `lensWeight`,
`anchorWeight`, `relationExpansionBudget`, `lensTopK`, `lensDiversityFloor`,
`minImprovementPpm`, `baselineVariancePpm`, `majorDeltaThreshold`, hidden-pack
profile + quotas.

### Scorer Correctness

- Reranker scores map to candidates by **docId**, not array index
  (anchor-mandatory candidates reorder the reranker pool).
- Patch acceptance uses the **full** threshold in production:
  `acceptanceThresholdPpm = minImprovementPpm + replayTolerancePpm + baselineVariancePpm`.
- Controller-only stress sims using `currentMinImprovement` alone are
  acceptable **only if explicitly documented** as a stricter anti-cheat stress
  condition — never confused with production acceptance.

### Long-Horizon Simulation Regimes

Test all three separately:

1. **Bootstrap / no-advance pressure** — random patches fail; difficulty
   decays gracefully when no valid advances occur; corpus-growth grace
   handled. (Random probes drive `observedAdvances`.)
2. **Steady-state target pressure** — realistic target advancement counts.
3. **Early high-throughput stress** (required before launch) — aggressive
   early miner activity, `targetAdvances=50` or burst schedule; verify
   difficulty ramps without overshoot / oscillation / choking.

`--scenario` does **not** affect observed advances when
`--probe-random-patches-per-epoch > 0` — in that mode, `observedAdvances` is
set from accepted random probes.

Recommended stress matrix:

| Regime | `targetAdvances` | Probes | Purpose |
| --- | --- | --- | --- |
| Bootstrap random-probe | 10 | on | anti-cheat, no-advance decay, corpus grace |
| Steady-state | 5 (or launch target) | off | normal pressure |
| Early high-throughput | 50 | retained for false-accept evidence | difficulty ramp + scaling under frequent early advances |

### Watcher Gates

Watcher must compute and report:

- Random-patch false accept rate.
- Growth transitions and whether `majorDeltaActive` triggered grace.
- Difficulty trajectory + oscillation.
- Controller stuck windows.
- Plateau risk via `|medianDeltaPpm|`:
  - Near-zero deltas over consecutive epochs = loss of discrimination.
  - Large negative deltas ≠ plateau; random patches still materially affect
    score, just harmfully.

Do not call a run healthy unless the watcher reports gates green.

### Plateau Interpretation

Plateau is **not** "random patches are rejected" — that is expected.

Plateau risk means patches stop producing meaningful score movement,
especially when median `|delta|` collapses toward zero, score-delta range
narrows, valid improvements disappear, difficulty falls toward floor, or the
controller cannot maintain target advances despite corpus growth.

A growing corpus should create fresh routing surface. If corpus grows but
score deltas collapse, investigate substrate capacity, anchor coverage,
relation expansion, reranker cap, and baseline staleness.

### Corpus Scaling

Verify on transitions: active corpus root changes are intentional ·
`activeEvalHiddenFraction` transitions recorded · `majorDeltaActive=true` on
transition epochs · difficulty freezes / behaves as expected during grace ·
baseline recomputation cadence documented.

**Missing pre-launch automation**: daily or epoch-based baseline recomputation
+ safe bundle/profile update flow.

### Anti-Gaming

Maintain and verify: hidden-pack derivation from pinned profile · dual-pack
evaluation path · blockhash-bound or future-seed evaluation for live
submissions · random-patch false accept threshold · lens-diversity floor ·
structural / protected / family-catastrophic floors · no reuse of visible-only
calibration as acceptance proof.

Every anti-gaming claim is backed by a run artifact, not intuition.

### Artifact Hygiene

Never mix invalidated artifacts with current gating artifacts. On
scorer/profile-loading/path/bundle-pin bug discovery: mark prior artifacts
invalidated, preserve them for provenance, move them out of accidental reuse
paths, rerun affected calibration gates.

### Launch Bias

Prefer conservative launch parameters when uncertainty remains. Higher early
target-advance stress tests are good. Full production reranker/profile
fidelity is required for gating. Static scorer constants change only through
a new signed bundle. Dynamic difficulty handles routine adjustment
automatically. Operator monitoring is expected early; the system should not
require manual constant tuning to remain healthy.

### Reporting Standard

Every status update distinguishes:

- What was actually **verified**.
- What is still **running**.
- What is **inferred but not yet proven**.
- Which **artifact** proves the claim.
- Whether the result is **launch-gating or diagnostic only**.

Avoid "looks good." Report measured gate values.

## Production Throughput Levers (separate from per-eval correctness)

Per-patch evaluation correctness and coordinator throughput are independent
problems. A correctness-passing evaluator can still be production-infeasible
if it can't keep up with realistic miner submit cadence. The throughput
levers, in order of leverage:

1. **Screener-first admission.** Cheap structural / dedup / per-miner-cap
   gates run before any full hidden eval. Most non-screener-passing patches
   never enter the Qwen3 path. Audit any new gate against the screener
   layer first.
2. **Bounded full-eval worker queue at the coordinator.** Many parallel
   screeners feed a smaller fixed pool of full-eval workers. Coordinator
   absorbs bursts; full-eval pool runs at a sustainable rate.
3. **Reranker score cache.** `withRerankerCache` (LRU keyed by
   `(query, document)`, sized via `CORETEX_RERANKER_CACHE_SIZE`,
   default 100k entries ≈ 20MB). Within a single per-patch eval, the
   parent and child scores share a hidden pack — reuse is high. Across
   patches the gain is bounded by `(query, doc)` overlap because the live
   per-patch seed includes `patchHash`, so every patch's hidden pack is
   distinct. Cache is necessary, not the silver bullet.
4. **Replay-validator separation.** Replay validators only replay accepted
   patches and run asynchronously. They do not need to keep up with the
   live submit firehose; a lower-tier host is acceptable for them.
5. **Stage-1 caching by (corpus, query, K).** Already in place
   (`packages/cortex/src/eval/retrieval-benchmark.ts` §6.7). Survives
   across epochs in the same process; coordinator invalidates on epoch
   transitions.

The CPU-only Run 4 dead-end documented in `release/calibration/CALIBRATION_FIDELITY.md`
under "Operational limit surfaced" is a symptom of lever (3) being the
only one applied. Coordinator launch requires (1)+(2)+(3); a CPU host
without (1)+(2) cannot service the production submit path even with
the cache in place.

## Cache Scoping Invariant

`withRerankerCache` lives inside each reranker factory (`createQwen3Reranker`,
`createStreamingQwen3Reranker`, `createMiniLMReranker`). Each
`rerankerFromEnv()` call produces an instance with its OWN cache —
different `(model, revision, prompt template, max-seq)` configurations
are physically isolated. Cache keys encode only `(query, document)`
because the isolation invariant already prevents cross-model collision.

Hit/miss telemetry exposed via `getRerankerCacheStats(reranker)`. Report
hit rate alongside calibration artifacts; a hit rate below ~50% on a
fixed-seed calibration run signals either oversized eviction or a wrap
regression.

## Substrate Pin Discipline

Two distinct decisions are routinely conflated; they must be separated
before any bundle re-pin:

1. **Is the channel load-bearing?** Determined by the dense ablation
   matrix (`substrate-ablation-launchcorp-v3.json`). Anchor-only is
   currently strongest, lens adds zero on top of anchor, relation is
   net-harmful at `relationExpansionBudget=12` under the all-on
   engineered substrate.
2. **Is the dense-substrate result robust to typical miner sparsity?**
   Determined by the substrate-sparsity ablation
   (`scripts/calibrate-substrate-sparsity.mjs`). If anchor-only
   degrades smoothly with sparsity, the pin is robust. If it collapses
   or reverses ordering vs lens at low anchor coverage, the dense
   finding is an artifact.

A bundle re-pin should only happen after BOTH have been measured on the
launch corpus with the production reranker. The current launch-v3 pins
(`lensWeight=0.4`, `anchorWeight=0.6`, `relationExpansionBudget=12`)
are pre-fix and survive into the new evidence set only because they are
"not harmful" at the dense substrate — not because they are
empirically optimal. `relationExpansionBudget=0` is a serious candidate
pending the sparsity matrix; do not assume the existing pin is correct
forward.

Per-family relation diagnostics are also required before fully writing
off relations: relations may hurt aggregate MRR while helping
`multi_hop_relation` or `long_horizon` specifically. The sparsity script
captures composite + nDCG + MRR + Recall; a follow-up that splits these
by family is the next diagnostic to add when launch evidence demands it.

## Substrate Size Forward Note

The current substrate is 1024 words (`RANGES.WORD_COUNT=1024`). MemoryIndex
gets 44 anchor slots (32→383 inclusive ÷ 8 words/slot). If relation /
category-lens routing is ultimately dropped or pinned at zero, early-launch
runway depends primarily on those 44 anchors + RetrievalKeys lens vectors.
That may be sufficient for launch, but the architectural redesign options
should remain explicit:

- **1024 → 2048 word substrate** — straightforward header-version bump,
  doubles every region. More anchor slots, more lens slots, more relation
  capacity. Pinpointed by `SCHEMA_VERSION_CoreTex` so a clean migration is
  possible. Cost: every CortexState in flight at migration needs reduction
  through a delta-bridge or coordinator-driven rollover.
- **Category-lens redesign** — keep 1024 but rework how Phase B BFS
  consumes category-lens entries so it injects helpful candidates without
  the current MRR penalty. Lower-risk migration; same substrate format.
- **Hybrid: keep 1024, sharpen anchor expressiveness** — e.g., per-anchor
  bias weight in the slot header so reranker bonus is anchor-specific
  rather than global `anchorWeight`. Smaller surgery; preserves substrate
  format.

Pick the path based on what the launch evidence demands. Don't commit to
2048 unless the sparsity ablation shows anchor capacity is the binding
constraint at the corpus scale we expect six months in.

## Evidence-Driven Calibration Loop

The pre-launch sequence is **not a linear queue**. Each completed run feeds
back into harness/profile/controller tuning before the next run is chosen.
The orchestrator's job is to look at the result, decide what it changes,
and only then dispatch the next run. The decision table below is the
default policy; deviate when the evidence demands.

| Finding from a run | Immediate action (before queuing the next run) |
|---|---|
| Run 4 random patches accept at `productionThresholdPpm` | Raise `minImprovementPpm` and re-run Run 4 reduced; if still positive, full Run 4 on GPU |
| Run 4 hill-climbed adversarial accepts at `productionThresholdPpm` | Tighten threshold/floors; inspect which surface won; consider a targeted adversarial generator on that surface |
| Sparsity ablation shows relation still net-harmful | Test a `relationExpansionBudget=0` profile; re-run dense ablation + Run 4 + long-horizon on that profile |
| Per-family ablation shows relation helps one family only | Propose per-family/per-mode relation budget, not global `12` |
| Anchor-only dominant but degrades sharply at low anchor coverage | Open the substrate-size redesign discussion (1024→2048 or category-lens) — anchor capacity is the binding constraint |
| Cache hit rate poor under unique-seed (probe `--unique-seed-patches`) | Coordinator cannot rely on cross-patch reuse; size queue + screener pass-rate accordingly; document GPU fallback option |
| Long-horizon `targetAdvances=50` overshoots / oscillates | Tune `nextMinImprovementPpm` ramp/decay ratios, not just initial threshold |
| Plateau median `|delta|` collapses | Investigate corpus-growth freshness, substrate capacity / expansion budget, baseline staleness, relation/category routing |
| Baseline drift visible between recalibration runs | Implement / enable baseline-recalibration cron (skeleton in `scripts/recalibrate-baseline.mjs`) |

The seed regime per run type:

- **Run 4 (`calibrate-min-improvement.mjs`)** — fixed seed across all
  patches. This is intentional: Run 4's threshold signal is meaningful
  only under a stable hidden pack. Adding `--seed-mode per-patch` to Run
  4 would conflate threshold-evidence with throughput-measurement.
- **Coordinator-throughput probe (`probe-reranker-cache.mjs
  --unique-seed-patches N`)** — each synthetic patch derives its own
  gateSeed and hiddenPack, matching the live submit path. This is the
  only run that produces production-faithful cache hit-rate under
  patch-bound seeds.

## Things that are dynamic vs. things that are static

| Field | Lever | Authority |
|---|---|---|
| `nextMinImprovementPpm` | adaptive controller (observedAdvances vs qualityAttempts) | runtime — must self-adjust |
| Screener threshold | baseline + noise statistics | runtime — must self-adjust |
| `majorDeltaActive` grace | corpus-growth trigger | runtime — must self-adjust |
| Coordinator queue backpressure | full-eval capacity sensor | runtime — must self-adjust |
| `baselineParentScorePpm` | cron/epoch recalibration via `recalibrate-baseline.mjs` | infra cron — auto-adjust |
| `lensWeight`, `anchorWeight`, `relationExpansionBudget`, `lensTopK`, `rerankerInputTopK`, hidden-pack `packSize`/quotas | bundle re-pin only | governance — manual, evidence-backed |

Static bundle pins must NOT auto-wiggle mid-epoch. They change only
through a new signed bundle accompanied by an artifact path + measured
value justifying each move.

## Pre-launch Blockers Checklist

The hammer-down list before recommending a launch profile re-pin and
mainnet activation:

- [ ] **Pack=128 cache probe completes** with COLD/WARM/CHILD speedup
      consistent with pack=8 result (>1000× WARM, >1000× CHILD).
- [ ] **Run 4 with cache active** at reduced N=5: accept rate at exact
      `productionThresholdPpm=37,919` on RANDOM patches ≤ tolerable
      noise floor; accept rate on HILL-CLIMBED adversarial ≤ 1%.
      Cache hit-rate alongside.
- [ ] **Substrate sparsity ablation** on launch corpus + Qwen3:
      anchor-only dominance is robust to anchor coverage ∈ {0.25, 0.5,
      0.75, 1.0} at the launch-v3 baseline scalars, OR a re-pin is
      empirically justified by the matrix.
- [ ] **Relation pin decision** — keep `relationExpansionBudget=12`
      only if per-family decomposition shows a family that benefits;
      otherwise pin to 0 or a very conservative value backed by data.
- [ ] **Long-horizon stress matrix** with post-fix scorer, three
      regimes: bootstrap (targetAdvances=10 + probes), steady-state
      (targetAdvances=5 + probes off), early high-throughput
      (targetAdvances=50). Watcher gates green per the contract above.
- [ ] **Coordinator throughput benchmark** — unique-seed patches/min
      sustainable on the intended coordinator host. Drives the
      screener-first + worker-queue sizing decisions before mainnet.
- [ ] **Baseline recalibration skeleton** — at minimum the cron-driven
      script that recomputes `baselineParentScorePpm` from a rolling
      sample, even if the full bundle/profile update flow lands
      post-launch.

When all checkboxes carry an artifact path + measured value, propose a
launch re-pin against the current evidence. Not before.
