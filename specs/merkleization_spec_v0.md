# Cortex Merkleization Spec V0

> Phase 1 deliverable. Skeleton.

State root = Merkle root over 1024 uint256 leaves. Hash = keccak256. Tree shape, leaf encoding, and pad-to-power-of-two policy land here in Phase 1. Cross-impl parity test: 1k fuzzed (state, patch-set) pairs produce byte-identical roots in TS and the second reference impl.
