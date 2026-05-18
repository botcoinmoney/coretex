# Substrate Retrieval Semantics — Packed-State Decoder

Status: launch-blocking spec. Pinned by bundle hash.

## Scope

This spec defines how the 1024-uint256 substrate body is decoded into the
typed structures the production retrieval scorer reads. The contract layer
(`CortexState.acceptTransition`) is agnostic to the byte semantics; this
spec is the off-chain source of truth.

Word-range constants are pinned in `packages/cortex/src/state/types.ts`
(`RANGES`).

## Region map

| Region          | Word range  | Slots          |
|-----------------|-------------|----------------|
| Header          | 0..31       | 32 words       |
| MemoryIndex     | 32..383     | 44 × 8 words   |
| RetrievalKeys   | 384..671    | 36 × 8 words   |
| Relations       | 672..799    | 128 × 1 word   |
| Temporal        | 800..895    | 12 × 8 words   |
| Codebook        | 896..991    | 48 × 2 words   |
| Reserved        | 992..1023   | 32 words       |

Header layout is unchanged from `cortex_state.md`.
Reserved-word writes are forbidden by the contract (`E04 RESERVED_BIT_SET`).

## MemoryIndex slots

Each slot occupies 8 contiguous words (`MEMORY_INDEX_START + slotIndex * 8`).

Word 0 (the canonical header word):

| Bit range  | Field           | Semantics                                  |
|------------|-----------------|--------------------------------------------|
| 255..128   | recordId        | 128-bit corpus record id                   |
| 127..64    | familyDomainBits| family (4 bits) + domain (60 bits)         |
| 63..48     | flags           | bit 0 valid, bit 1 revoked, bit 2 protected|
| 47..40     | retrievalSlot   | index into RetrievalKeys (0..35), 8 bits   |
| 39..0      | expiryEpoch     | uint40                                     |

Words 1..7 carry padding/reserved bits (must be zero; non-zero zeroes the
slot during scoring).

A slot is "active" if `recordId != 0`, `valid` flag set, `revoked` clear.
A slot is "revoked" if `valid` and `revoked` both set; revoked slots are
the substrate's expression of stale-truth records and do not retrieve.

`familyDomainBits.family` is a 4-bit enum:

```
0x0 near_collision
0x1 temporal
0x2 long_horizon
0x3 multi_hop_relation
0x4..0xF reserved (zeroes the slot)
```

Decoder failure modes (slot is zeroed during scoring):
- `recordId == 0`
- reserved family value
- `retrievalSlot >= 36`
- non-zero word at indices 1..7

## RetrievalKeys slots

Each slot occupies 8 contiguous words (256 bytes total) at
`RETRIEVAL_KEYS_START + slotIndex * 8`.

Per slot byte layout:

| Byte range | Field                | Semantics                              |
|------------|----------------------|----------------------------------------|
| 0          | versionTag           | bundle-pinned, current 0x01            |
| 1..4       | modelIdHash          | first 4 bytes of keccak256(modelId    \|\| revision \|\| mode) |
| 5..8       | l2NormBits           | float32 BE: pre-quantization L2 norm   |
| 9..(9+H-1) | reserved             | zero                                   |
| H..255     | quantized vector     | layout = `dim × quantization`          |

`H = headerBytes`. `dim` and `quantization` come from the bundle's
`retrievalKeyLayout`. `headerBytes` is bound into `retrievalKeyLayout` and
is at least 9.

Decoder failure modes (slot is zeroed during scoring):
- `modelIdHash` not equal to the bundle-pinned bi-encoder id hash
- `l2NormBits` parses to ≤ 0 or NaN
- `versionTag` not equal to `0x01`
- non-zero reserved bytes
- vector dequantization fails (codebook entry absent)

## Relations entries

Each entry is one word at index `RELATIONS_START + i` for `i ∈ [0, 127]`.

| Bit range | Field           | Semantics                          |
|-----------|-----------------|-----------------------------------|
| 255..240  | weight          | uint16, 0 marks empty entry       |
| 239..224  | edgeType        | uint16 enum (see below)           |
| 223..208  | reserved        | zero                              |
| 207..192  | reserved        | zero                              |
| 191..96   | sourceMemorySlot| 96-bit padded uint8 (top bits 0)  |
| 95..0     | targetMemorySlot| same                              |

Effective slot indices live in the low 8 bits of each 96-bit field.

`edgeType` enum:

```
0x0 unused (entry is empty)
0x1 supports
0x2 supersedes
0x3 coreference_of
0x4 causes
0x5 derived_from
0x6 co_occurs_with
0x7..0xFFFF reserved (entry is zeroed)
```

Decoder failure modes:
- weight 0 with non-empty other fields → zeroed
- source or target slot index ≥ 44 → entry dropped
- non-zero reserved fields → entry dropped

## Temporal records

Each record occupies 8 words at `TEMPORAL_START + recordIndex * 8`,
recordIndex ∈ [0, 11]. Word 0 is the only used word per record:

| Bit range | Field                  | Semantics                       |
|-----------|------------------------|---------------------------------|
| 255..248  | memorySlot             | uint8, target MemoryIndex slot  |
| 247..240  | supersededBy_memorySlot| uint8, 0xFF = none              |
| 239..200  | validFromEpoch         | uint40                          |
| 199..160  | validUntilEpoch        | uint40                          |
| 159..152  | flags                  | bit 0 currentStaleFlag          |
| 151..0    | reserved               | zero                            |

Words 1..7 of each record must be zero.

Decoder failure modes:
- `memorySlot >= 44` → record dropped
- `validFromEpoch > validUntilEpoch` → record dropped
- non-zero reserved bits → record dropped
- `currentStaleFlag` requires the referenced MemoryIndex slot's `revoked`
  bit to be set; mismatch zeroes the record

## Codebook entries

Each entry is 2 words at `CODEBOOK_START + entryIndex * 2`.

Word 0:

| Bit range | Field           | Semantics                            |
|-----------|-----------------|--------------------------------------|
| 255..240  | code            | 16-bit codeword index                |
| 239..224  | codeType        | 1 = int8 scale/zero, 2 = PQ          |
| 223..208  | flags           | bit 0 valid                          |
| 207..0    | payload         | type-dependent encoding              |

Word 1 is type-dependent payload continuation.

Decoder consumers:
- `RetrievalKeys` slot dequantization references codebook by index
- mismatched codebook (codeType not 1 or 2, flags clear, code 0) zeroes
  the codebook slot

## decodeSubstrate result

```
DecodedSubstrate {
  memoryIndex: MemoryIndexSlot[]            // length 44, holes are nulls
  retrievalKeys: RetrievalKeySlot[]         // length 36, holes are nulls
  relations: RelationEdge[]                 // sparse
  temporal: TemporalRecord[]                // sparse
  codebook: CodebookEntry[]                 // length 48, holes are nulls
  decodedSlots: number                      // count successfully decoded
  decodeFailures: number                    // count failed
}
```

`structuralValidity = 1 - decodeFailures / (decodedSlots + decodeFailures)`.

## Round-trip property

The decoder + a write-side encoder satisfy

```
∀ valid slot s : decode(encode(s)) == s
```

This holds for every slot type. The implementation is property-tested with
≥ 10k fuzzed inputs per slot type.
