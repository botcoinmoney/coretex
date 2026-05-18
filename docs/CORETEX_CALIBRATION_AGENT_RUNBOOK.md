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
