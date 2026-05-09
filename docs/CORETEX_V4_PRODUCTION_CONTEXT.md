# CoreTex V4 Production Context

Last updated: 2026-05-09.

## Current Head

- `e1dfa5d coretex: complete DACR corpus rotation and reranker gates`
- `d2830bd coretex: enforce production provenance gates`

## What Changed

- Bundle provenance now fails closed:
  - Qwen3-Reranker-0.6B is pinned to Hugging Face commit `e61197ed45024b0ed8a2d74b80b4d909f1255473`.
  - The default model manifest includes per-file SHA-256 and byte counts.
  - Placeholder or mutable revisions (`main`, `latest`, `HEAD`, `v0.1.0`, tags for Qwen3) are rejected.
  - Bundle hash now covers reranker eval, DACR bridge, admission, deltas, epoch rotation, difficulty, coordinator endpoint contract, and replay code.

- Replay/watch is canonical by default:
  - `coretex-replay watch` requires `--bundle-manifest` and `--expected-bundle-hash` or `--core-version-hash`.
  - `--allow-unverified-bundle` is the explicit local-dev escape hatch.

- Patch encoding and apply paths now validate patch type/range consistency:
  - `KEY_UPDATE` targets retrieval keys only.
  - `SLOT_REPLACE` targets memory index only.
  - Temporal, relation, codebook, and header updates target their declared ranges.
  - `MIXED` permits valid non-reserved ranges.

- DACR corpus bridge is production-expanded:
  - Cross-miner distractor mining fills sparse trap records.
  - `question_metadata[i].coretex_family` overrides heuristic routing.
  - Session trajectories emit long-horizon events with multi-step relations.
  - Bookend pairs emit current/stale temporal pairs.
  - Corpus deltas now carry `addedRecords`, so they are independently publishable/replayable.

- Epoch rotation is publishable:
  - `buildEpochRotationManifest` binds previous/next corpus root, delta hash, challenge-book hash, bundle hash, next `minImprovementPpm`, observed advances, and quality attempts.
  - `signEpochRotationManifest` / `verifyEpochRotationManifestSignature` support signed cron output.
  - `scripts/build-corpus-delta-from-dacr.mjs` is the coordinator cron entrypoint.

- Reranker evaluation is enforced:
  - `rerankerFromEnv` refuses deterministic mode when `CORTEX_REAL_EVAL=1` unless explicitly overridden for local development.
  - `createQwen3Reranker` uses the native Python Hugging Face `transformers`/`torch` runner for `Qwen/Qwen3-Reranker-0.6B`; Transformers.js is intentionally not used for Qwen3 because the pinned model revision does not publish ONNX weights.
  - `cortex-server` real eval path uses `evaluatePatchWithReranker`, the production corpus root, optional expected bundle hash, and a configurable reranker threshold.
  - Phase-11 gates every iteration on reranker score instead of merely logging it.

- Coordinator route contract is hardened:
  - `CoreTexCoordinatorDataSource` has `authorize` and `rateLimit` hooks.
  - The cloned live coordinator at `/root/botcoin-coordinator-live` has a reference `/coretex/*` mount in `packages/coordinator/src/coretex-live.ts` and `server.ts`.
  - The mount is additive and only parses POST bodies inside the `/coretex/` guard, so `/v1/submit` remains untouched.

- Substrate slot rotation is deterministic:
  - `selectSubstrateSlot` maps near-collision events to retrieval keys and temporal/long-horizon events to memory index slots.
  - Retrieval-key slots wrap after 36 advances and memory-index slots wrap after 44 advances.
  - Callers can mark protected slots; the policy skips them and fails closed if a region has no writable slot.
  - Phase-11 now uses this policy instead of raw sequential slot math.

## Coordinator Env Contract

Live coordinator reference envs:

- `CORETEX_ENABLED=true`
- `CORETEX_MODULE_PATH=/root/cortex/packages/cortex/dist/index.js`
- `CORETEX_REQUIRE_AUTH=true`
- `CORETEX_API_TOKEN=...`
- `CORETEX_RATE_LIMIT_PER_MINUTE=120`
- `CORETEX_ARTIFACT_DIR=/app/packages/data/coretex`
- `CORETEX_STATE_PACKED_PATH=/app/packages/data/coretex/current-state.bin`
- `CORETEX_EVALUATOR_URL=http://127.0.0.1:8787`
- `CORETEX_BUNDLE_MANIFEST_PATH=/app/packages/data/coretex/client-bundle.json`
- `CORETEX_EXPECTED_BUNDLE_HASH=0x...`

## Verification Record

Focused tests passed during implementation:

- `npm run build --workspace @botcoin/cortex`
- `npm run build --workspaces --if-present`
- `node --test packages/cortex/test/unit/bundle.test.mjs packages/cortex/test/unit/patch.test.mjs packages/cortex/test/unit/replay-cli.test.mjs packages/cortex/test/unit/coordinator-endpoints.test.mjs`
- `node --test packages/cortex/test/unit/dacr-bridge.test.mjs packages/cortex/test/unit/corpus-pipeline.test.mjs packages/cortex/test/unit/epoch-rotation.test.mjs packages/cortex/test/unit/bundle.test.mjs`
- `node --test packages/cortex/test/unit/reranker.test.mjs`
- `/root/botcoin-coordinator-live`: `tsc` direct check of `packages/coordinator/src/coretex-live.ts`

Final validation sweep completed on 2026-05-09:

- `npm run build --workspace @botcoin/cortex` passed.
- `npm run build --workspaces --if-present` passed.
- `npm run test:unit --workspace @botcoin/cortex` passed: 275 tests / 58 suites.
- `node test/e2e/phase-10/run.mjs` passed the deploy -> screen -> state advance -> log replay loop against Anvil.
- `node test/e2e/phase-11/run.mjs` passed the 5-iteration live miner loop with reranker gating, deterministic slot rotation, and replay reproduction.
- DACR production-content build for `quantum_physics,companies` emitted 5,850 candidate events, admitted 5,815 records, rejected 35 for `hardness_signal_too_low`, and rejected 0 for `insufficient_distractors`.
- Sparse DACR production-content build for `computational_biology,scrna_imputation` emitted 10,447 candidate events, admitted 10,293 records, rejected 154 for `hardness_signal_too_low`, and rejected 0 for `insufficient_distractors`.
- `scripts/build-corpus-delta-from-dacr.mjs` produced a self-contained epoch-rotation delta with 435 additions and `nextMinImprovementPpm = 2625`.
- Actual pinned Qwen3-Reranker-0.6B smoke passed via `CORETEX_RERANKER=qwen3`: model `Qwen/Qwen3-Reranker-0.6B@e61197ed45024b0ed8a2d74b80b4d909f1255473`, relevant score `0.006852287274893826`, unrelated score `0.0002810586032528734`.
- `/root/botcoin-coordinator-live` CoreTex mount typecheck passed in isolation; a filtered coordinator package build reported no CoreTex errors.

Phase-10/11 Anvil scripts now use default automine. The previous one-second interval mining mode could stall Forge receipt polling in this local harness even though the contract path was correct.
