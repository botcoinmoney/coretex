# CoreTex Model Selection Audit

Last updated: 2026-05-10.

This audit pins the production cross-encoder reranker and the separate
offline audit/reference reranker for the CoreTex v4 launch. The audit is reproducible by
re-running `scripts/determinism-check.mjs` against each candidate
manifest and rerunning the calibration suite.

## Selection criteria

A candidate model qualifies for the production reranker slot only if all
of these hold:

1. Public weights with a 40-hex Hugging Face commit sha (no mutable refs).
2. Per-file SHA-256 attestable (we hash on download).
3. Memory-retrieval-relevant training (cross-encoder for query–memory pairs).
4. Deterministic CPU inference: passes the determinism harness with P99
   diff ≤ `replayTolerancePpm` (launch target: 250 ppm) on ≥ 3 hardware
   configurations.
5. Inference latency on the canonical CPU envelope is within the
   coordinator throughput budget at the calibrated `K`.
6. Distinct from the offline audit/reference reranker (different `modelId` or
   `revision`).

## Candidate models

### Production reranker (0.6B class)

| Candidate | Status | Pin | Notes |
|---|---|---|---|
| `Qwen/Qwen3-Reranker-0.6B` | **Selected (launch)** | `e61197ed45024b0ed8a2d74b80b4d909f1255473` | Already integrated (`eval/reranker.ts:createQwen3Reranker`). 12-file manifest hashed in `bundle/index.ts`. Passes determinism harness on torch-transformers CPU build. |
| `memreranker/0.6B` | Pending public artifact | — | If MemReranker-0.6B publishes a public 0.6B-class checkpoint with attestable per-file SHA-256, the orchestrator runs the determinism harness against it and considers swapping. |

### Offline audit/reference reranker (stronger)

| Candidate | Status | Pin | Notes |
|---|---|---|---|
| `IAAR-Shanghai/MemReranker-4B` | **Selected (offline qrel audit/reference)** | `7fe33c1385f652f52d370b8822d6b620b32b6ec4` | Separate stronger model for auditing synthesizer-category qrels. 11-file manifest hashed in `bundle/index.ts`; excludes training-only pickle artifacts from the runtime bundle. |
| `Qwen/Qwen3-Reranker-4B` | Alternate | — | Acceptable backup if MemReranker-4B is unavailable, provided the modelId differs from the production reranker. |
| `BAAI/bge-reranker-v2-m3` | Alternate | — | Cross-encoder trained on retrieval; usable if the above two are unavailable. |

The audit/reference reranker is not in the production corpus-generation hot
path. Production hard-negative qrels are emitted by the challenge synthesizer
as structural categories and resolved through the bundle's
`negCategoryRelevanceMap`. Operators may run `CORETEX_LABELER=pinned` as an
explicit offline A/B audit against MemReranker-4B; live eval never uses the
audit/reference model.

## Refusal log

Models the orchestrator considered and rejected, with reason. Add
entries here as new candidates fail pinning or determinism:

- (none yet)

## Rerunning the audit

1. Add a candidate manifest factory (e.g.
   `memReranker06BManifest({revision, files})`) in
   `packages/cortex/src/bundle/index.ts`.
2. Build a candidate bundle:

   ```
   const candidate = buildBundleManifest({
     ...
     reranker: memReranker06BManifest({...}),
     labelingReranker: <unchanged>,
   });
   ```

3. Run the determinism harness on the candidate's hardware envelope:

   ```
   CORETEX_BUNDLE_MANIFEST=./candidate.json node scripts/determinism-check.mjs --hosts a,b,c ...
   ```

4. If P99 ≤ `replayTolerancePpm`, run Phase 13 e2e with the candidate.
5. If Phase 13 passes, the candidate replaces the current pin in this
   document.

## Attestation

Every selected candidate is attested in the bundle manifest by its
`modelId + revision + files[].sha256` and bound into `bundleHash`. The
on-chain `coreVersionHash` carries the attestation.
