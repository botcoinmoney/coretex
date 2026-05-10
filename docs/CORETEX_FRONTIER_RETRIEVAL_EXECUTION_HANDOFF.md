# CoreTex Frontier Retrieval Execution Handoff

Last updated: 2026-05-10.

This is the file-of-record for the frontier retrieval hardening work landed
after `coretex: harden retrieval launch plan`. It is written for the next
orchestrator, auditor, or deployment agent.

## What Changed

- The reward scorer no longer injects a query's truth documents into the
  candidate list. nDCG credit is earned only when the substrate retrieves a
  candidate document through retrieval-key and memory-index slots.
- BGE-M3, Qwen3-Reranker-0.6B, and MemReranker-4B are pinned in the bundle
  manifest with 40-hex revisions and per-file SHA-256 metadata.
- The canonical evaluator path is CPU-only. The Qwen-style reranker wrapper now
  refuses GPU env vars and moves model/input tensors to CPU.
- The BGE-M3 retrieval-key layout is `dim=243`, `int8`, `headerBytes=9`, so the
  4-byte int8 scale plus vector bytes fit inside the 256-byte retrieval-key slot.
- The state reserved-bit validator now permits the retrieval-benchmark substrate
  payload semantics in MemoryIndex, RetrievalKeys, Relations, and Codebook
  regions. Malformed payloads are rejected by `retrieval-decoder.ts`.
- Corpus generation now builds answer-bearing qrels by construction, caps hard
  negatives at relevance `0.4`, removes placeholder distractors, creates
  real multi-hop target annotations, and refuses deterministic labeling in
  production mode.
- Corpus expansion now supports `--previous-corpus`, `--seed-offset`, and
  `--delta-out`; `CorpusDelta` has disk serialization/parsing helpers so replay
  watchers can apply embedding-bearing deltas.
- `scripts/validate-retrieval-corpus.mjs` validates corpus root, splits,
  graded qrels, embedding payload lengths, temporal annotations, multi-hop
  relation targets, and family/split coverage.
- `scripts/build-coretex-bundle.mjs` plus `npm run build:bundle` produce a
  verified client bundle manifest from a corpus file and optional calibrated
  profile.
- Calibration now derives hidden-pack quotas from `eval_hidden`, keeps
  `replayTolerancePpm <= minImprovementPpm`, and defaults the replay tolerance
  floor to 250 ppm.
- Phase 13 now requires actual state advances and its adversarial test rejects
  correct IDs with bad or missing retrieval signal.

## Coordinator Dataset Audit Result

The local coordinator clone at `/root/botcoin-coordinator-live` was inspected at
the code-layout level. Its `dataset/v2` format is challenge/session/attempt
oriented and does not directly contain CoreTex retrieval-benchmark records:
graded qrels, hidden query splits, answer-bearing docs, hard-negative pools,
temporal current/stale labels, or cross-document relation labels.

Launch corpus generation therefore follows the `reject_current_data` branch:
generate retrieval-shaped records from challenge primitives, label qrels with
the separately pinned labeling reranker, and publish signed embedding-bearing
corpus deltas for every epoch.

See `docs/CORETEX_SOURCE_DATA_AUDIT.md`.

## Challenge-Library Corpus Source

`scripts/generate-coretex-retrieval-corpus.mjs` now defaults to
`--source challenge-library`. This imports the built coordinator challenge
package and generates records from
`generateInterchangeableChallenge(domain, seed, modifierCount,
constraintDifficulty)`.

This is the production corpus source. It is materially different from the old
CoreTex template fallback:

- each world is a deterministic challenge-library world with 20 structured
  entities and domain JSON attributes;
- qrels are built around computed challenge answers, direct entity profiles,
  silent-trap hard negatives, and modifier/trap temporal current-stale pairs;
- multi-hop records point at answer entity profile records through relation
  annotations;
- expansion is append-only through new `(seed, modifierCount,
  constraintDifficulty, domain)` tuples and signed `CorpusDelta` files;
- the old template generator remains only behind `--source synthetic` for
  offline fallback and is not the launch corpus path.

## Local Verification Run

Commands run on 2026-05-10:

```bash
npm run build --workspace @botcoin/cortex
npm run build
npm run test:unit
npm run typecheck
```

All passed. `npm run test:unit` reports `224` passing `@botcoin/cortex` unit
tests; handler/server workspaces currently have no unit-test directories and
their scripts now exit cleanly with an explicit message.

Corpus and bundle smoke:

```bash
CORETEX_BIENCODER=deterministic CORETEX_LABELER=deterministic \
  node scripts/generate-coretex-retrieval-corpus.mjs \
    --source challenge-library \
    --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
    --bundle-manifest /tmp/coretex-template-bundle.json \
    --domains companies,quantum_physics,computational_biology,scrna_imputation \
    --seeds-per-domain 4 \
    --corpus-epoch 0 \
    --out artifacts/coretex/corpus-smoke-epoch0.json

node scripts/validate-retrieval-corpus.mjs \
  --corpus artifacts/coretex/corpus-smoke-epoch0.json \
  --min-events 100 \
  --min-per-family 20

CORETEX_BIENCODER=deterministic CORETEX_LABELER=deterministic \
  node scripts/generate-coretex-retrieval-corpus.mjs \
    --source challenge-library \
    --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
    --bundle-manifest /tmp/coretex-template-bundle.json \
    --previous-corpus artifacts/coretex/corpus-smoke-epoch0.json \
    --seed-offset 4 \
    --seeds-per-domain 2 \
    --corpus-epoch 0 \
    --epoch 1 \
    --out artifacts/coretex/corpus-smoke-epoch1.json \
    --delta-out artifacts/coretex/corpus-delta-smoke-epoch1.json

node scripts/validate-retrieval-corpus.mjs \
  --corpus artifacts/coretex/corpus-smoke-epoch1.json \
  --min-events 180 \
  --min-per-family 35

npm run build:bundle -- \
  --corpus artifacts/coretex/corpus-smoke-epoch1.json \
  --profile artifacts/coretex/bundle-profile-smoke.json \
  --out artifacts/coretex/coretex-bundle-smoke.json

CORETEX_BUNDLE_MANIFEST=artifacts/coretex/coretex-bundle-smoke.json \
CORETEX_CORPUS=artifacts/coretex/corpus-smoke-epoch1.json \
CORETEX_BIENCODER=deterministic \
CORETEX_RERANKER=deterministic \
ITERATIONS=2 \
  node test/e2e/phase-13/run.mjs
```

Challenge-library corpus hardening smoke run:

```bash
CORETEX_BIENCODER=deterministic CORETEX_LABELER=deterministic \
  node scripts/generate-coretex-retrieval-corpus.mjs \
    --source challenge-library \
    --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
    --bundle-manifest artifacts/coretex/coretex-bundle-smoke-template.json \
    --domains companies,quantum_physics,computational_biology,scrna_imputation \
    --seeds-per-domain 1 \
    --modifier-counts 0,1 \
    --constraint-difficulties easy,hard \
    --corpus-epoch 0 \
    --out artifacts/coretex/challenge-library-corpus-smoke-epoch0.json

node scripts/validate-retrieval-corpus.mjs \
  --corpus artifacts/coretex/challenge-library-corpus-smoke-epoch0.json \
  --min-events 400 \
  --min-per-family 15 \
  --min-hard-negatives 3

CORETEX_BIENCODER=deterministic CORETEX_LABELER=deterministic \
  node scripts/generate-coretex-retrieval-corpus.mjs \
    --source challenge-library \
    --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
    --bundle-manifest artifacts/coretex/coretex-bundle-smoke-template.json \
    --previous-corpus artifacts/coretex/challenge-library-corpus-smoke-epoch0.json \
    --domains companies,quantum_physics,computational_biology,scrna_imputation \
    --seed-offset 1 \
    --seeds-per-domain 1 \
    --modifier-counts 0,1 \
    --constraint-difficulties easy,hard \
    --corpus-epoch 0 \
    --epoch 1 \
    --out artifacts/coretex/challenge-library-corpus-smoke-epoch1.json \
    --delta-out artifacts/coretex/challenge-library-delta-smoke-epoch1.json
```

Observed output: epoch 0 generated 438 events; epoch 1 appended 438 events for
876 total with family coverage `near_collision=496`, `temporal=60`,
`long_horizon=288`, `multi_hop_relation=32`; validation returned zero errors.
After recalibrating the bundle profile from that corpus, Phase 13 passed with
the deterministic scorer and adversarial `no_retrieval_improvement` rejection.

Phase 13 accepted `2/2` retrieval-state advances and the adversarial sub-test
returned `accepted=false reason=no_retrieval_improvement`.

Production refusal checks:

```bash
CORETEX_CORPUS_PRODUCTION=1 CORETEX_LABELER=deterministic \
  node scripts/generate-coretex-retrieval-corpus.mjs \
    --source challenge-library \
    --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
    --bundle-manifest /etc/coretex/template-bundle.json
# exits 2

CORETEX_RERANKER_PRODUCTION=1 CORETEX_RERANKER=deterministic \
  node test/e2e/phase-13/run.mjs
# exits 1
```

## Server Calibration Path

The repo is ready to port to the calibration host without code edits:

```bash
CORETEX_CORPUS_PRODUCTION=1 \
CORETEX_BIENCODER=pinned \
CORETEX_LABELER=pinned \
CORTEX_REAL_EVAL=1 \
CORETEX_RERANKER=qwen3 \
CORETEX_RERANKER_PRODUCTION=1 \
  node scripts/generate-coretex-retrieval-corpus.mjs \
    --source challenge-library \
    --challenge-lib-root /root/botcoin-coordinator-live/packages/challenges \
    --bundle-manifest /etc/coretex/template-bundle.json \
    --domains companies,quantum_physics,computational_biology,scrna_imputation \
    --seeds-per-domain $SEEDS_PER_DOMAIN \
    --corpus-epoch $CORPUS_EPOCH \
    --out /var/lib/coretex/corpus-epoch-0.json

node scripts/validate-retrieval-corpus.mjs \
  --corpus /var/lib/coretex/corpus-epoch-0.json \
  --min-events $MIN_CORPUS_EVENTS \
  --min-per-family $MIN_PER_FAMILY

node scripts/determinism-check.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --pairs /var/lib/coretex/determinism-1k-pairs.json \
  --max-tolerance-ppm 250 \
  --report /var/lib/coretex/reports/determinism-host-$HOSTNAME.json

node scripts/aggregate-determinism.mjs \
  --reports '/var/lib/coretex/reports/determinism-host-*.json' \
  --max-tolerance-ppm 250 \
  --out /var/lib/coretex/reports/determinism-aggregate.json

node scripts/calibrate.mjs \
  --bundle-manifest /etc/coretex/template-bundle.json \
  --calibration-corpus /var/lib/coretex/corpus-epoch-0.json \
  --determinism-aggregate /var/lib/coretex/reports/determinism-aggregate.json \
  --out /etc/coretex/bundle-profile.json

npm run build:bundle -- \
  --corpus /var/lib/coretex/corpus-epoch-0.json \
  --profile /etc/coretex/bundle-profile.json \
  --out /etc/coretex/bundle-manifest.json
```

Then run Phase 13 with pinned models:

```bash
CORETEX_BUNDLE_MANIFEST=/etc/coretex/bundle-manifest.json \
CORETEX_CORPUS=/var/lib/coretex/corpus-epoch-0.json \
CORETEX_BIENCODER=pinned \
CORETEX_RERANKER=qwen3 \
CORTEX_REAL_EVAL=1 \
CORETEX_RERANKER_PRODUCTION=1 \
ITERATIONS=5 \
  node test/e2e/phase-13/run.mjs
```

## Commit Notes

Commit the current CoreTex working tree after review under a coherent message
such as:

```bash
git add .
git commit -m "coretex: harden frontier retrieval corpus launch path"
```
