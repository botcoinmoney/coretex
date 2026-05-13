# CoreTex Calibration Scripts Launch-Corpus Audit (2026-05-13)

## Scope

Task #17 audited launch-corpus safety and compatibility for:

1. `scripts/calibrate.mjs`
2. `scripts/build-coretex-bundle.mjs`
3. `scripts/validate-retrieval-corpus.mjs`
4. `scripts/pin-baseline-into-bundle.mjs`
5. `scripts/aggregate-determinism.mjs`

Target concern: launch corpus scale (~679k events / ~2 GB JSON) vs script memory/algorithm assumptions.

## Audit table

| Script | Whole-file load? | O(n^2) risk | Post-pivot fields | Required flags / runtime | Verdict |
|---|---|---|---|---|---|
| `calibrate.mjs` | Yes (`loadProductionCorpus`) | No quadratic nested event loops found | Uses `qrels[].relevance` + `negCategoryRelevanceMap` correctly | Correct CLI is `--calibration-corpus` (not `--corpus`) | **NEEDS PATCH (docs fixed)** |
| `build-coretex-bundle.mjs` | Yes when `--corpus` is provided (`loadProductionCorpus`) | No | Reads `corpusRoot` from canonical loader; post-pivot compatible | Uses `--profile`; no `--template` arg exists | **NEEDS PATCH (docs fixed)** |
| `validate-retrieval-corpus.mjs` | Yes (`JSON.parse(readFileSync(...))` + loader) | No | Uses `qrels[].relevance` and current truth/stale checks | Launch-scale run should include `node --max-old-space-size=8192` | **NEEDS PATCH (comment added)** |
| `pin-baseline-into-bundle.mjs` | Yes (corpus loader) + model inference | No obvious quadratic scan | Uses bundle profile fields directly, post-pivot compatible | Requires `--bundle-manifest`, `--corpus`, `--eval-seed-hex` | **NEEDS PATCH (docs fixed)** |
| `aggregate-determinism.mjs` | Small report JSON files only | No | N/A | Requires Node 22+ (`globSync` import path); Node 20 fails | **RECOMMEND CHANGE (runtime note documented)** |

## Patches applied

### 1) Playbook command corrections

Updated `docs/CORETEX_POST_CORPUS_PLAYBOOK.md`:

- Step 7: `--corpus` -> `--calibration-corpus` for `calibrate.mjs`
- Step 8: removed invalid `--template` flag from `build-coretex-bundle.mjs`
- Step 9: corrected `pin-baseline-into-bundle.mjs` flags to:
  - `--bundle-manifest`
  - `--corpus`
  - `--eval-seed-hex`
  - `--epoch-id`
  - `--samples`

### 2) Launch-memory warning in validator script

Updated `scripts/validate-retrieval-corpus.mjs` header comments to explicitly document:

- whole-file parse behavior
- recommended launch-scale invocation with `--max-old-space-size=8192`

## Retest evidence (calibration corpus)

Retested audited scripts on stable calibration inputs:

- `validate-retrieval-corpus.mjs` -> pass (`errors=[]`)
- `aggregate-determinism.mjs` -> pass (`p99PpmDiff=0`)
- `calibrate.mjs` -> pass (`/tmp/coretex-audit-bundle-profile.json`)
- `build-coretex-bundle.mjs` -> pass (`/tmp/coretex-audit-bundle-manifest.json`)

Runtime note:

- `aggregate-determinism.mjs` fails on Node 20 due to `globSync` ESM export shape.
- Re-run with Node 22 succeeds (`npx -y node@22 ...`), matching repo engine expectations.

## Final verdict

Launch-script logic is broadly compatible with the 678k corpus shape, but command-surface correctness and runtime/memory invocation details were the real blockers. Those blockers are now patched/documented in the post-corpus path.
