"""
validate.py — Reserved-bit enforcement for CortexState V0.

Spec: specs/packing_spec_v0.md §Reserved-bit enforcement
      specs/cortex_state_v0.md (per-range reserved-bit definitions)

Rule: Any word with a non-zero reserved bit causes rejection with E04.

RESERVED_MASKS[i] is the bitmask of ALL reserved bits in word i.
A word is invalid if: words[i] & RESERVED_MASKS[i] != 0.

Words not listed in RESERVED_MASKS have mask 0 (no reserved bits to check),
meaning the entire word is used (bytes32 fields like STATE_ROOT_PREV).
"""
from __future__ import annotations
from .types import CortexState


def _mask(bits_hi: int, bits_lo: int) -> int:
    """Return a bitmask covering bits bits_lo..bits_hi inclusive."""
    width = bits_hi - bits_lo + 1
    return ((1 << width) - 1) << bits_lo


# ---------------------------------------------------------------------------
# Build RESERVED_MASKS for all 1024 words
# ---------------------------------------------------------------------------
# Strategy: start from a full 256-bit mask for each word, subtract the
# bits that are NAMED (used) fields. The remainder is reserved.
# For bytes32 whole-word fields the named bits cover 255:0 → reserved = 0.

_FULL_256 = (1 << 256) - 1

# Start: every word has all bits reserved.
_named: dict[int, int] = {}  # word_index → bitmask of NAMED (used) bits


def _mark(word: int, bits_hi: int, bits_lo: int) -> None:
    _named[word] = _named.get(word, 0) | _mask(bits_hi, bits_lo)


# ---- Header range (words 0–31) ----

# Word 0: MAGIC[255:240] SCHEMA_VERSION[239:224] WORD_COUNT[223:208] FLAGS[207:192]
# FLAGS: bit 0 is named (genesis_state), bits 15:1 are reserved within FLAGS
# → only bit 192 is a named sub-field of FLAGS; bits 207:193 are reserved.
# But the field FLAGS occupies 207:192 (16 bits). Within those 16 bits,
# bit 0 (= word bit 192) is named, bits 1–15 (= word bits 193–207) are reserved.
# Per spec: "Bit 0: genesis state. Bits 1–15: reserved."
# So in the word-level view: named bits of word 0 = 255:208 + bit 192 only.
# Bits 207:193 are reserved (FLAGS sub-reserved), bits 191:0 are reserved.
_mark(0, 255, 240)  # MAGIC
_mark(0, 239, 224)  # SCHEMA_VERSION
_mark(0, 223, 208)  # WORD_COUNT
_mark(0, 192, 192)  # FLAGS bit 0 only (genesis_state); 207:193 stay reserved

# Word 1: EPOCH[255:192] EPOCH_START_TIMESTAMP[191:128]; bits 127:0 reserved
_mark(1, 255, 192)  # EPOCH
_mark(1, 191, 128)  # EPOCH_START_TIMESTAMP

# Words 2–6: full bytes32 fields — all 256 bits are used
for _w in range(2, 7):
    _mark(_w, 255, 0)

# Word 7: four uint64 fields covering all 256 bits → no reserved bits
_mark(7, 255, 0)

# Word 8: three uint64 fields at 255:192, 191:128, 127:64; bits 63:0 reserved
_mark(8, 255, 192)  # LAST_SNAPSHOT_EPOCH
_mark(8, 191, 128)  # SNAPSHOT_INTERVAL
_mark(8, 127, 64)   # REDUCER_NONCE

# Words 9–10: full bytes32 fields
_mark(9, 255, 0)   # PATCH_SET_ROOT
_mark(10, 255, 0)  # SCORE_ROOT

# Words 11–31: entirely reserved (all bits = 0)
# (no _mark calls → _named[11..31] = 0 → reserved = all bits)

# ---- MemoryIndex range (words 32–383): 44 slots × 8 words ----
for _slot in range(44):
    _base = 32 + _slot * 8
    # Slot-word 0:
    #   EVENT_ID[255:128] DOMAIN_CODE[127:96] OBJ_TYPE[95:80]
    #   VALIDITY_FLAGS[79:64] — bit 0 (active), bit 1 (stale), bit 2 (revoked)
    #   named; bits 3–15 of VALIDITY_FLAGS (= word bits 67:64+2 = 79:67) reserved
    #   reserved_slot0[63:0]
    _mark(_base, 255, 128)  # EVENT_ID
    _mark(_base, 127, 96)   # DOMAIN_CODE
    _mark(_base, 95, 80)    # OBJ_TYPE
    # VALIDITY_FLAGS: bits 79:64 total; named sub-bits: bit0=word-bit64,
    # bit1=word-bit65, bit2=word-bit66; bits 3–15 (word bits 79:67) reserved.
    _mark(_base, 66, 64)    # VALIDITY_FLAGS bits 0–2 (active, stale, revoked)
    # bits 79:67 remain reserved
    # reserved_slot0[63:0] — reserved (no mark)

    # Slot-word 1: CHECKSUM[255:128] CORPUS_EPOCH[127:64] EXPIRY_EPOCH[63:0]
    _mark(_base + 1, 255, 0)  # fully named

    # Slot-words 2–7: PAYLOAD_WORDS (bytes32 each) — fully named
    for _sw in range(2, 8):
        _mark(_base + _sw, 255, 0)

# ---- RetrievalKeys range (words 384–671): 36 slots × 8 words ----
for _slot in range(36):
    _base = 384 + _slot * 8
    # Slot-word 0:
    #   KEY_ID[255:128] KEY_TYPE[127:112] KEY_DIM[111:96]
    #   KEY_FLAGS[95:80] — bit 0 (active); bits 1–15 (word bits 95:81) reserved
    #   reserved_rk0[79:0] — reserved
    _mark(_base, 255, 128)  # KEY_ID
    _mark(_base, 127, 112)  # KEY_TYPE
    _mark(_base, 111, 96)   # KEY_DIM
    _mark(_base, 80, 80)    # KEY_FLAGS bit 0 only
    # bits 95:81 are reserved within KEY_FLAGS; bits 79:0 are reserved_rk0

    # Slot-words 1–7: KEY_VECTOR (bytes32 each) — fully named
    for _sw in range(1, 8):
        _mark(_base + _sw, 255, 0)

# ---- Relations range (words 672–799): 128 entries × 1 word ----
for _i in range(128):
    _w = 672 + _i
    # SRC_IDX[255:240] DST_IDX[239:224] REL_TYPE[223:208] WEIGHT[207:192]
    # reserved_rel[191:0]
    _mark(_w, 255, 240)  # SRC_IDX
    _mark(_w, 239, 224)  # DST_IDX
    _mark(_w, 223, 208)  # REL_TYPE
    _mark(_w, 207, 192)  # WEIGHT
    # bits 191:0 are reserved

# ---- Temporal range (words 800–895): 96 entries × 1 word ----
for _i in range(96):
    _w = 800 + _i
    # MEM_IDX[255:240] VALID_FROM_EPOCH[239:176] VALID_UNTIL_EPOCH[175:112]
    # REVOKE_EPOCH[111:48] TEMPORAL_FLAGS[47:32] reserved_tmp[31:0]
    _mark(_w, 255, 240)  # MEM_IDX
    _mark(_w, 239, 176)  # VALID_FROM_EPOCH
    _mark(_w, 175, 112)  # VALID_UNTIL_EPOCH
    _mark(_w, 111, 48)   # REVOKE_EPOCH
    # TEMPORAL_FLAGS[47:32]: bit 0 (= word bit 32) named; bits 1–15 (47:33) reserved
    _mark(_w, 32, 32)    # TEMPORAL_FLAGS bit 0 only
    # bits 47:33 are reserved within TEMPORAL_FLAGS; bits 31:0 are reserved_tmp

# ---- Codebook range (words 896–991): 48 entries × 2 words ----
for _slot in range(48):
    _base = 896 + _slot * 2
    # Word 0:
    #   CODE[255:240] CODE_TYPE[239:224]
    #   CODE_FLAGS[223:208]: bit 0 (= word bit 208) named; bits 1–15 reserved
    #   reserved_cb0[207:0]
    _mark(_base, 255, 240)  # CODE
    _mark(_base, 239, 224)  # CODE_TYPE
    _mark(_base, 208, 208)  # CODE_FLAGS bit 0 only
    # bits 223:209 are reserved within CODE_FLAGS; bits 207:0 are reserved_cb0

    # Word 1: CODE_DATA (bytes32) — fully named
    _mark(_base + 1, 255, 0)

# Words 992–1023: entirely reserved — no _mark calls


# ---- Build the final RESERVED_MASKS dict ----
RESERVED_MASKS: dict[int, int] = {}
for _i in range(1024):
    named_bits = _named.get(_i, 0)
    reserved = _FULL_256 & ~named_bits
    if reserved != 0:
        RESERVED_MASKS[_i] = reserved
    # If reserved == 0 (e.g. bytes32 full-word fields), no entry needed.

# Cleanup module-level temporaries
del _w, _slot, _base, _sw, _i, _named, _FULL_256


# ---------------------------------------------------------------------------
# Validation function
# ---------------------------------------------------------------------------

def has_non_zero_reserved_bits(state: CortexState) -> bool:
    """
    Return True if any reserved bit in the state is non-zero.

    Per spec packing_spec_v0.md: any violation → reject with E04.
    """
    for word_idx, mask in RESERVED_MASKS.items():
        if state.words[word_idx] & mask:
            return True
    return False
