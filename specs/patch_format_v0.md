# Cortex Patch Wire Format V0

> Phase 1 deliverable. Skeleton.

A patch carries: `parentStateRoot`, target indices (varint-packed), new words, patch type, score delta. **Old words are omitted from the wire** — reconstructed from parent state during eval. A matching `parentStateRoot` already implies old-word correctness.

Realistic budget: ≤ 200 bytes for a 4-word patch (99th percentile on a 10k-sample fuzz; CI fails on regression).

Patch types and encodings land here in Phase 1.
