# Cortex State V0

> Phase 1 deliverable. Skeleton — body lands in Phase 1 implementation.

The active CortexState is **1024 uint256 words = 32 KB**. Word ranges per ORGANISM_CORTEX_STATE_PLAN.md §3:

| Range          | Purpose                                                              |
|----------------|----------------------------------------------------------------------|
| Words 0–31     | Protocol header, schema hash fragments, score counters, epoch meta    |
| Words 32–383   | Memory-object index slots (event ids, type, validity, domain, checksum) |
| Words 384–671  | Binary / multi-vector retrieval keys                                  |
| Words 672–799  | Relation and routing weights                                          |
| Words 800–895  | Temporal validity / revocation map                                    |
| Words 896–991  | Codebook / operator table                                             |
| Words 992–1023 | Reserved / experimental / future compatibility                        |

Reserved bits MUST be zero; both reference implementations reject any non-zero reserved bit.

State root = Merkle root over 1024 leaves (algorithm in `merkleization_spec_v0.md`).

Genesis state seeded from Phase 7 baseline E winner (revocation-aware), **not all-zero**.

See also: `cortex_schema_v0.json`, `packing_spec_v0.md`, `merkleization_spec_v0.md`, `patch_format_v0.md`.
