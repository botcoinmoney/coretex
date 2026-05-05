# Cortex State — Public Summary

This is a high-level summary for external readers. Canonical specs:

- [`../specs/cortex_state_v0.md`](../specs/cortex_state_v0.md) — full 1024-word layout.
- [`../specs/cortex_schema_v0.json`](../specs/cortex_schema_v0.json) — machine-readable field registry.
- [`../specs/packing_spec_v0.md`](../specs/packing_spec_v0.md) — byte-level pack/unpack.
- [`../specs/merkleization_spec_v0.md`](../specs/merkleization_spec_v0.md) — keccak256 binary Merkle.
- [`../specs/patch_format_v0.md`](../specs/patch_format_v0.md) — wire format for patches.

## Shape

The active CortexState is **1024 uint256 words = 32 KB**. Stored as a flat array, indexed 0–1023 inclusive. Big-endian when serialised to bytes.

## Word ranges

| Range          | Words       | Purpose                                                              |
|----------------|-------------|----------------------------------------------------------------------|
| Header         | 0–31        | Protocol header, schema hash fragments, score counters, epoch meta    |
| MemoryIndex    | 32–383      | Memory-object index slots (event ids, type, validity, domain code)    |
| RetrievalKeys  | 384–671     | Binary / multi-vector retrieval keys                                  |
| Relations      | 672–799     | Relation and routing weights                                          |
| Temporal       | 800–895     | Temporal validity / revocation map                                    |
| Codebook       | 896–991     | Codebook / operator table                                             |
| Reserved       | 992–1023    | Reserved / experimental / future compatibility                        |

Reserved bits MUST be zero. Both the TS and Python reference implementations reject any state with a non-zero reserved bit.

## State root

Merkle root over the 1024 words: keccak256, bottom-up binary, exactly 1024 leaves (no padding). Each leaf is `keccak256(bigEndian32(word))`. Internal nodes are `keccak256(left ‖ right)`.

## Patch wire format

A patch is a **1–4 word change**. Wire bytes:

```
PATCH_TYPE        (1 byte)
WORD_COUNT        (1 byte)
SCORE_DELTA_HI    (4 bytes, big-endian uint32)
SCORE_DELTA_LO    (4 bytes, big-endian uint32)
PARENT_STATE_ROOT (32 bytes)
[for each word] INDEX (LEB128 varint, 1–2 bytes) ‖ NEW_WORD (32 bytes)
```

99th-percentile size for a 4-word patch: ≤ 200 bytes.

**Old words are omitted from the wire.** They are reconstructed from the parent state during eval. A matching `parentStateRoot` already implies old-word correctness.

## Patch rejection codes

| Code  | Name              | Meaning                                                                  |
|-------|-------------------|--------------------------------------------------------------------------|
| `E01` | WRONG_PARENT_ROOT | `patch.parentStateRoot` does not match `merkleizeState(currentState)`     |
| `E02` | WRONG_TYPE_FIELD  | A target word index falls in the Reserved range (992–1023)                |
| `E03` | OVER_BUDGET       | `patch.wordCount > 4`                                                     |
| `E04` | RESERVED_BIT_SET  | Applying the patch would produce a state with a non-zero reserved bit     |
| `E05` | NOOP_PATCH        | Every `newWord[i] === currentState.words[index[i]]` — no actual change    |

## Genesis state

The genesis state is **not all-zero**. It is seeded from the Phase 7 baseline winner (revocation-aware encoding). The genesis state root is published in [`contract-addresses.md`](./contract-addresses.md) and committed in `CortexRegistry`.

## Reference implementations

Two independent reference implementations compute byte-identical roots from the same state:

- TypeScript: `packages/cortex/src/state/` (zero external runtime deps).
- Python 3: `packages/cortex-py/cortex_py/` (uses pycryptodome for Keccak-256).

The cross-impl parity gate runs in CI (`e2e-phase-1b`).
