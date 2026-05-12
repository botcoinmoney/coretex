# Cortex State V0

## Overview

The active CortexState is **1024 uint256 words = 32 768 bytes**. Words are indexed 0–1023 (inclusive). All words are big-endian 256-bit unsigned integers when serialised to / from bytes.

Each word is a packed bit field: sub-word fields are extracted by masking and shifting, MSB-first. Reserved bits inside any word MUST be zero; any state containing a non-zero reserved bit is rejected by both reference implementations with error code `RESERVED_BIT_SET`.

---

## Word-range layout

| Range          | Words (inclusive) | Count | Purpose                                               |
|----------------|-------------------|-------|-------------------------------------------------------|
| Header         | 0 – 31            | 32    | Protocol header, schema hash fragments, score counters, epoch metadata |
| MemoryIndex    | 32 – 383          | 352   | Memory-object index slots: event IDs, type, validity, domain code, checksum |
| RetrievalKeys  | 384 – 671         | 288   | Binary / multi-vector retrieval keys                  |
| Relations      | 672 – 799         | 128   | Relation and routing weights                          |
| Temporal       | 800 – 895         | 96    | Temporal validity / revocation map                    |
| Codebook       | 896 – 991         | 96    | Codebook / operator table                             |
| Reserved       | 992 – 1023        | 32    | Reserved / experimental / future compatibility        |

---

## Per-range packed bit-field definitions

### Range A: Header (words 0–31)

Each word in this range has dedicated semantics. Unused bit positions within each word are reserved and MUST be zero.

| Word | Field name            | Bits       | Type              | Description                                          |
|------|-----------------------|------------|-------------------|------------------------------------------------------|
| 0    | MAGIC                 | 255:240    | uint16            | Fixed value `0xC07E` — "cortex" sentinel             |
| 0    | SCHEMA_VERSION        | 239:224    | uint16            | Schema version; V0 = `0x0000`                        |
| 0    | WORD_COUNT            | 223:208    | uint16            | Must equal `1024`                                    |
| 0    | FLAGS                 | 207:192    | uint16            | Bit 0: genesis state. Bits 1–15: reserved            |
| 0    | reserved_0            | 191:0      | —                 | Reserved; MUST be zero                               |
| 1    | EPOCH                 | 255:192    | uint64            | Current epoch number                                 |
| 1    | EPOCH_START_TIMESTAMP | 191:128    | uint64            | Unix timestamp (seconds) at epoch start              |
| 1    | reserved_1            | 127:0      | —                 | Reserved; MUST be zero                               |
| 2    | STATE_ROOT_PREV       | 255:0      | bytes32           | State root of the parent state (all 256 bits)        |
| 3    | CORE_VERSION_HASH     | 255:0      | bytes32           | keccak256 of the Core decoder version string         |
| 4    | SCHEMA_HASH_LO        | 255:0      | bytes32           | Low 256 bits of schema hash (keccak256 of schema JSON)|
| 5    | EXPERIENCE_CORPUS_ROOT| 255:0      | bytes32           | Merkle root of the current experience corpus         |
| 6    | BENCHMARK_COMMITMENT  | 255:0      | bytes32           | keccak256 commitment to the benchmark parameters      |
| 7    | SCORE_ACCUMULATOR     | 255:192    | uint64            | Accumulated composite score × 1e6, saturating        |
| 7    | SCORE_EPOCH_BASELINE  | 191:128    | uint64            | Baseline score for this epoch × 1e6                  |
| 7    | PATCH_COUNT_EPOCH     | 127:64     | uint64            | Accepted patches this epoch                          |
| 7    | PATCH_COUNT_TOTAL     | 63:0       | uint64            | Accepted patches all-time                            |
| 8    | LAST_SNAPSHOT_EPOCH   | 255:192    | uint64            | Epoch of last full-state snapshot                    |
| 8    | SNAPSHOT_INTERVAL     | 191:128    | uint64            | Snapshot cadence (default 100)                       |
| 8    | REDUCER_NONCE         | 127:64     | uint64            | Monotonically increasing reducer invocation nonce    |
| 8    | reserved_8            | 63:0       | —                 | Reserved; MUST be zero                               |
| 9    | PATCH_SET_ROOT        | 255:0      | bytes32           | Merkle root of accepted patch set this epoch         |
| 10   | SCORE_ROOT            | 255:0      | bytes32           | Merkle root of per-miner score ledger                |
| 11–31| reserved_11_31        | 255:0      | —                 | Reserved; MUST be zero                               |

### Range B: MemoryIndex (words 32–383)

352 words = 44 memory-object slots × 8 words each.

**Slot layout** (8 words per slot, slot `k` occupies words `32 + 8k` through `32 + 8k + 7`, for `k` ∈ [0, 43]):

| Slot-word | Field           | Bits    | Type    | Description                                           |
|-----------|-----------------|---------|---------|-------------------------------------------------------|
| 0         | EVENT_ID        | 255:128 | uint128 | 128-bit opaque event identifier                       |
| 0         | DOMAIN_CODE     | 127:96  | uint32  | Domain classifier (0 = unset)                         |
| 0         | OBJ_TYPE        | 95:80   | uint16  | Object type enum (see below)                          |
| 0         | VALIDITY_FLAGS  | 79:64   | uint16  | Bit 0: active. Bit 1: stale. Bit 2: revoked. Bits 3–15: reserved |
| 0         | reserved_slot0  | 63:0    | —       | Reserved; MUST be zero                                |
| 1         | CHECKSUM        | 255:128 | uint128 | Truncated keccak256 of the object bytes               |
| 1         | CORPUS_EPOCH    | 127:64  | uint64  | Epoch in which this object was first admitted         |
| 1         | EXPIRY_EPOCH    | 63:0    | uint64  | Epoch after which object is expired (0 = never)       |
| 2–7       | PAYLOAD_WORDS   | 255:0   | bytes32 | Six arbitrary-use payload words for this slot         |

**OBJ_TYPE enum**:

| Value  | Name        |
|--------|-------------|
| 0x0000 | UNSET       |
| 0x0001 | MEMORY_EVENT|
| 0x0002 | SKILL_ENTRY |
| 0x0003 | RULE_ENTRY  |
| 0x0004 | SUMMARY     |
| 0x0005–0xFFFE | Reserved |
| 0xFFFF | TOMBSTONE   |

VALIDITY_FLAGS reserved bits 3–15 MUST be zero.

### Range C: RetrievalKeys (words 384–671)

288 words = 36 key-slots × 8 words each.

**Key-slot layout** (8 words, slot `k` at words `384 + 8k` through `384 + 8k + 7`, for `k` ∈ [0, 35]):

| Slot-word | Field       | Bits    | Type    | Description                                           |
|-----------|-------------|---------|---------|-------------------------------------------------------|
| 0         | KEY_ID      | 255:128 | uint128 | Key identifier (matches an EVENT_ID in MemoryIndex)   |
| 0         | KEY_TYPE    | 127:112 | uint16  | 0x0001 = binary key, 0x0002 = dense key, others reserved |
| 0         | KEY_DIM     | 111:96  | uint16  | Dimensionality (bits for binary; floats for dense)    |
| 0         | KEY_FLAGS   | 95:80   | uint16  | Bit 0: active. Bits 1–15: reserved MUST be zero       |
| 0         | reserved_rk0| 79:0    | —       | Reserved; MUST be zero                                |
| 1–7       | KEY_VECTOR  | 255:0   | bytes32 | Seven words of key data (224 bytes); for binary keys MSB-first bit packed |

KEY_FLAGS reserved bits 1–15 MUST be zero.

### Range D: Relations (words 672–799)

128 words = 128 relation-weight entries × 1 word each.

**Entry layout** (1 word per entry, entry `k` at word `672 + k`, for `k` ∈ [0, 127]):

| Field          | Bits    | Type    | Description                                          |
|----------------|---------|---------|------------------------------------------------------|
| SRC_IDX        | 255:240 | uint16  | Source slot index in MemoryIndex (0–43) or 0xFFFF = unset |
| DST_IDX        | 239:224 | uint16  | Destination slot index in MemoryIndex (0–43) or 0xFFFF = unset |
| REL_TYPE       | 223:208 | uint16  | Relation type: 0x0001 = RELATES_TO, 0x0002 = SUPERSEDES, 0x0003 = ROUTES_TO, others reserved |
| WEIGHT         | 207:192 | uint16  | Routing weight, fixed-point Q8.8 (value = raw/256)   |
| reserved_rel   | 191:0   | —       | Reserved; MUST be zero                               |

### Range E: Temporal (words 800–895)

96 words = 12 temporal records × 8 words each. The canonical decoder
(`packages/cortex/src/substrate/retrieval-decoder.ts:decodeTemporal`)
and `substrate_retrieval_semantics_v0.md §Temporal records` are
authoritative for the per-record layout; the earlier "96 entries × 1
word" framing was a planning sketch and is superseded — miners who
follow it will produce patches the decoder drops.

**Per-record layout** (8 words per record, record `k` occupies words
`800 + k*8 .. 800 + k*8 + 7`, for `k` ∈ [0, 11]). Only word 0 carries
data; words 1..7 MUST be zero.

Word 0 fields:

| Field                      | Bits      | Type    | Description                                            |
|----------------------------|-----------|---------|--------------------------------------------------------|
| memorySlot                 | 255:248   | uint8   | Target MemoryIndex slot (0–43)                         |
| supersededBy_memorySlot    | 247:240   | uint8   | Slot that supersedes this one; `0xFF` = none           |
| validFromEpoch             | 239:200   | uint40  | First epoch for which this record is valid             |
| validUntilEpoch            | 199:160   | uint40  | Last epoch (inclusive); 0 = unbounded                  |
| flags                      | 159:152   | uint8   | Bit 0 `currentStaleFlag`; bits 1–7 reserved MUST zero  |
| reserved_tmp               | 151:0     | —       | Reserved; MUST be zero                                 |

Decoder failure modes (record dropped silently):
- `memorySlot >= 44`
- `validFromEpoch > validUntilEpoch`
- non-zero reserved bits in word 0 or non-zero words 1..7
- `currentStaleFlag` set without the referenced MemoryIndex slot's
  `revoked` bit also set

### Range F: Codebook (words 896–991)

96 words = 48 codebook-entries × 2 words each.

**Entry layout** (2 words per entry, entry `k` at words `896 + 2k` and `896 + 2k + 1`, for `k` ∈ [0, 47]):

| Word | Field        | Bits    | Type    | Description                                         |
|------|--------------|---------|---------|-----------------------------------------------------|
| 0    | CODE         | 255:240 | uint16  | Codebook code (0 = unset)                           |
| 0    | CODE_TYPE    | 239:224 | uint16  | 0x0001 = operator, 0x0002 = token, others reserved  |
| 0    | CODE_FLAGS   | 223:208 | uint16  | Bit 0: active. Bits 1–15: reserved MUST zero        |
| 0    | reserved_cb0 | 207:0   | —       | Reserved; MUST be zero                              |
| 1    | CODE_DATA    | 255:0   | bytes32 | Arbitrary operator / token data                     |

### Range G: Reserved (words 992–1023)

All 32 words × 256 bits = entirely reserved. **Every bit in this range MUST be zero.**

---

## Reserved-bit rule

> Any word where any reserved-bit position (as specified per range above) is non-zero MUST cause both reference implementations to reject the state with error `RESERVED_BIT_SET`.

This is a hard rejection rule. It is not a warning and not a conditional skip.

---

## Genesis state

The genesis state is seeded from the Phase 7 baseline E winner (revocation-aware encoding). It is **not all-zero**. The genesis `MAGIC`, `SCHEMA_VERSION`, `WORD_COUNT`, and `EPOCH` fields are set; all reserved bits are zero. The published genesis state root is the canonical starting point committed in `CortexRegistry`.

---

## Future ladder step: 1024 → 2048 (informational)

The launch substrate is fixed at 1024 words. A future widening to 2048
is reserved as a single ladder step, not a recurring schedule. The
mechanism is intentionally minimal:

- **Wire path already supports it.** `CortexState.initializeEpoch` takes
  `uint16 wordCount` as an argument. Switching to 2048 is a parameter
  change at epoch init plus a new pinned bundle, not a contract migration.
  Merkle tree depth grows from 10 → 11 levels; pack/unpack already
  parameterizes on `wordCount`.
- **Region layout doubles where it helps, dead-pads where it doesn't.**
  Indicative shape: MemoryIndex 44→88 slots, RetrievalKeys 36→72 slots,
  Relations 128→256 entries, Temporal 12→24 records, Codebook 48→96
  entries, plus a reserved region for further ladder steps. Concrete
  ranges land in the spec when the ladder triggers — not before.
- **Trigger is governance-on-data, not preemptive.** The launch design
  publishes a per-epoch dead-slot count (Definition A: slots whose bytes
  are structurally zero — cheap, observable, in the epoch rotation
  manifest, NEVER an input to miner reward). When dead-slot count trends
  toward zero over many epochs while retrieval headroom flattens,
  governance has visible data to authorize the ladder rotation. Until
  then, 1024 stays.
- **Replay stays clean.** Bundle hash changes on the rotation (different
  `wordCount` + region layout + spec hash), so the pre-rotation and
  post-rotation epochs anchor to distinct `coreVersionHash` values.
  Watchers verify each epoch against its own bundle.

The protocol explicitly does NOT reward "more substrate used", does NOT
gate the ladder on a vote, and does NOT preemptively allocate 2048.
Dead-slot count is published as a diagnostic; everything else flows
from miner competition under retrieval-native scoring. See
`docs/CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md` §"Auditor Follow-Ups" for
the dead-slot-metric implementation, which lands as part of task #38
alongside the epoch rotation manifest changes.

---

## See also

- `cortex_schema_v0.json` — machine-readable field registry
- `packing_spec_v0.md` — byte-level pack/unpack rules
- `merkleization_spec_v0.md` — Merkle tree shape and leaf encoding
- `patch_format_v0.md` — wire format for patches
