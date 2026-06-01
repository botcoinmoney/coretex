# Historical: Memory IR, Reranker Training Data Export, and Format Validation

**Status**: Archived May 29 2026 (pre-A100 lock)  
**Purpose**: Preserve the exact tools and golden artifacts that defined and validated the Memory IR format (lifecycle from public supersedes structure, subject/entity scopes, public aspectTags, relation paths, etc.) that the current production scorer (retrieval-benchmark.ts + memory-ir-render) still emits and depends on.

## Why These Were Kept (Even Though Superseded)

- `lib/memory-ir.mjs` + `test-memory-ir-render-golden.mjs` were the source of truth during the period when we proved byte-identical render and stable nDCG behavior across IR changes.
- The export scripts (`export-memoryops-training-data.mjs`, `build-reranker-format-traces.mjs`) generated data in the exact shape the reranker training pipeline consumed.
- `validate-memoryops-pipeline.mjs` and the run-reranker probes were used to confirm that the IR design we shipped was correct and stable.
- After reconciliation against the 300k-final scorer path, no contradictions were found — the validated shape here is the one still in use.

## Files Archived Here

- build-reranker-format-traces.mjs
- export-memoryops-training-data.mjs
- run-reranker-epoch-probe.mjs
- run-reranker-flywheel-proof.mjs
- validate-memoryops-pipeline.mjs
- lib/memory-ir.mjs
- test-memory-ir-render-golden.mjs (and related golden data)
- lib/stream-reranker.mjs

## Format Reconciliation Note (May 29 2026)

The lifecycle, subject scoping, public aspectTags, and relation path structures defined and validated in this folder are the ones expected by the canonical 300k production bridge and scorer. The current `memory-ir-render` and `retrieval-benchmark` paths produce compatible output. These files remain valuable as the "we proved this design is correct" record.

Do not delete. Future reranker training or Memory IR schema changes will want this provenance.
