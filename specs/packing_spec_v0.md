# Cortex Packing Spec V0

> Phase 1 deliverable. Skeleton.

Defines the byte-level packing of typed fields inside each 1024-word range. Reserved bits = zero. Round-trip required: `pack(unpack(state)) === state`. Two independent reference implementations (TS + a second, e.g. Rust) must produce byte-identical packings.
