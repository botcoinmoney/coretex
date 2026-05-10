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
