# Cortex Epoch Reducer V0

> Phase 6 deliverable. Skeleton.

Deterministic greedy-by-marginal-gain:

1. Sort screener-pass patches by `(scoreDelta, -patchSize, patchHash)` descending.
2. Apply patches in order against the parent state. Skip any patch whose target indices intersect already-accepted indices, **or** whose evaluated marginal gain on top of currently-accepted patches drops below threshold (semantic conflict).
3. Result: deterministic `patchSetRoot` and `newStateRoot`. Public, replayable.

Public-replay equivalence: an external script consuming only the on-chain reducer input set re-derives the same accepted patch set as the coordinator (P6 E2E gate).
