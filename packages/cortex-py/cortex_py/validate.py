"""
validate.py — Reserved-bit enforcement for CoreTex state.

Spec: specs/packing_spec.md §Reserved-bit enforcement
      specs/cortex_state.md (per-range reserved-bit definitions)

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

# ---- MemoryIndex range (words 32–383): 352 stride-1 launch slots ----
# Every word is a canonical MemoryIndex slot word. Semantic validation
# (family/flags/retrievalSlot/expiry) lives in the substrate decoder; the
# reserved-bit validator must not apply any pre-Tier-2 object mask here.
for _w in range(32, 384):
    _mark(_w, 255, 0)

# ---- RetrievalKeys range (words 384–671): 36 slots × 8 words ----
# r4 reads these as RetrievalKeys; r5 reads 384–671 as typed PolicyAtoms.
# Decode-level grammar, not reserved-bit masking, decides whether a word is
# structurally valid for the active pipeline version.
for _w in range(384, 672):
    _mark(_w, 255, 0)

# ---- Relations range (words 672–799): 128 entries × 1 word ----
for _w in range(672, 800):
    _mark(_w, 255, 0)

# ---- Temporal range (words 800–895): 96 entries × 1 word ----
for _i in range(96):
    _w = 800 + _i
    # memorySlot[255:248], supersededBy[247:240], validFrom[239:200],
    # validUntil[199:160], flags[159:152]; bits 151:0 are reserved.
    _mark(_w, 255, 152)

# ---- Codebook range (words 896–991): 48 entries × 2 words ----
# r4-compatible mask: codebook payload bits are meaningful in r4 and 896–991
# is reserved-zero only under r5 policy validation. Keep this mask permissive;
# the active pipeline's decoder/validator owns grammar enforcement.
for _w in range(896, 992):
    _mark(_w, 255, 0)

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
del _w, _i, _named, _FULL_256


# ---------------------------------------------------------------------------
# Validation function
# ---------------------------------------------------------------------------

def has_non_zero_reserved_bits(state: CortexState) -> bool:
    """
    Return True if any reserved bit in the state is non-zero.

    Per spec packing_spec.md: any violation → reject with E04.
    """
    for word_idx, mask in RESERVED_MASKS.items():
        if state.words[word_idx] & mask:
            return True
    return False
