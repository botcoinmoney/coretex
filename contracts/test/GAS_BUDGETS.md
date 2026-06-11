# Phase 2 Gas Ceilings

Measured on Solc 0.8.26 optimizer_runs=200, warm storage (second call after state initialisation).
CI fails (`GasBudget.t.sol`) if any function exceeds its ceiling.

| Function | Gas ceiling | Rationale |
|---|---|---|
| `submitPatchAccepted` | 90,000 | ~1 SSTORE (patchCount) + event with calldata payload |
| `finalizeEpoch` | 250,000 | header/timestamp/finalized writes + event + ReentrancyGuard |
| `emitSnapshot` (32 KB calldata) | 600,000 | 32 768 bytes × ~16 gas/byte calldata + event overhead |
| `claimMergeBonus` (per epoch) | 100,000 | 1 SSTORE (claimed flag) + Merkle verify + ERC20 transfer |

## Methodology

`GasBudget.t.sol` uses `gasleft()` bracketing on warm-storage calls (a prior warm-up call populates cold slots).
Fork tests may show slightly higher values due to Base L1-DA surcharges — these are not gated here;
the ceilings cover pure L2 execution gas.

## Notes

- `emitSnapshot` ceiling is generous because it emits 32 768 bytes in a single event.
  Calldata gas is ~16 gas/byte, making the raw calldata cost alone ~524 K gas.
  This is by design — the spec requires full 1024-word raw state in the event for data availability.
- If Base L2 calldata pricing changes materially, update this table and the test ceiling.
- Per-epoch batch claim gas scales linearly; the ceiling above is per-epoch (×N for N epochs).
