"""
patch.py — Patch wire format encode/decode and apply algorithm.

Spec: specs/patch_format_v0.md

Wire format:
  [PATCH_TYPE: 1 byte]
  [WORD_COUNT: 1 byte]        — 1–4
  [SCORE_DELTA_HI: 4 bytes]   — big-endian uint32, high word of int64
  [SCORE_DELTA_LO: 4 bytes]   — big-endian uint32, low word of int64
  [PARENT_STATE_ROOT: 32 bytes]
  [for each word: INDEX (LEB128 1–2 bytes) + NEW_WORD (32 bytes)]

LEB128 unsigned varint (little-endian base-128), same as WASM/protobuf.

Apply algorithm (from spec):
  1. Budget check: word_count 1..4 else E03.
  2. Parent-root check: merkleize(state) == patch.parent_state_root else E01.
  3. No-op check: all words unchanged → E05.
  4. Apply words; reserved-range check (992–1023) → E02.
  5. Reserved-bit check on resulting state → E04.
"""
from __future__ import annotations
import struct
from .types import CortexState, Patch, PatchError, PatchSuccess, PatchResult, RANGES
from .merkle import merkleize_state
from .validate import has_non_zero_reserved_bits

# ---------------------------------------------------------------------------
# LEB128
# ---------------------------------------------------------------------------

def encode_leb128(n: int) -> bytes:
    """Encode a non-negative integer as unsigned LEB128."""
    if n < 0:
        raise ValueError(f"encode_leb128: n must be non-negative, got {n}")
    result = []
    while True:
        b = n & 0x7F
        n >>= 7
        if n != 0:
            b |= 0x80  # more bytes follow
        result.append(b)
        if n == 0:
            break
    return bytes(result)


def decode_leb128(data: bytes, offset: int = 0) -> tuple[int, int]:
    """
    Decode an unsigned LEB128 integer from *data* starting at *offset*.

    Returns (value, bytes_read).
    """
    result = 0
    shift = 0
    bytes_read = 0
    while True:
        if offset >= len(data):
            raise ValueError("decode_leb128: unexpected end of data")
        b = data[offset]
        offset += 1
        bytes_read += 1
        result |= (b & 0x7F) << shift
        shift += 7
        if (b & 0x80) == 0:
            break
    return result, bytes_read


# ---------------------------------------------------------------------------
# Encode / Decode
# ---------------------------------------------------------------------------

def encode_patch(patch: Patch) -> bytes:
    """
    Serialise a Patch to the V0 wire format.

    Wire = PATCH_TYPE(1) + WORD_COUNT(1) + SCORE_DELTA_HI(4) + SCORE_DELTA_LO(4)
         + PARENT_STATE_ROOT(32) + [INDEX(leb128) + NEW_WORD(32)] × word_count
    """
    out = bytearray()

    out.append(patch.patch_type & 0xFF)
    out.append(patch.word_count & 0xFF)

    # score_delta is int64; split into two uint32 big-endian words
    # Treat as unsigned 64-bit for wire encoding
    delta_u64 = patch.score_delta & 0xFFFF_FFFF_FFFF_FFFF
    hi = (delta_u64 >> 32) & 0xFFFF_FFFF
    lo = delta_u64 & 0xFFFF_FFFF
    out += struct.pack(">II", hi, lo)

    # Parent state root: 32 bytes
    psr = patch.parent_state_root
    if isinstance(psr, (bytes, bytearray)):
        if len(psr) != 32:
            raise ValueError(f"parent_state_root must be 32 bytes, got {len(psr)}")
        out += bytes(psr)
    else:
        raise TypeError("parent_state_root must be bytes")

    # Per-word: LEB128 index + 32-byte new word
    for k in range(patch.word_count):
        out += encode_leb128(patch.indices[k])
        out += patch.new_words[k].to_bytes(32, byteorder="big")

    return bytes(out)


def decode_patch(data: bytes) -> Patch:
    """
    Deserialise a Patch from the V0 wire format.

    Raises ValueError on malformed input.
    """
    if len(data) < 42:
        raise ValueError(f"Patch too short: {len(data)} bytes (minimum 42)")

    offset = 0
    patch_type = data[offset]; offset += 1
    word_count = data[offset]; offset += 1

    hi, lo = struct.unpack_from(">II", data, offset); offset += 8
    delta_u64 = (hi << 32) | lo
    # Reinterpret as signed int64
    if delta_u64 >= (1 << 63):
        score_delta = delta_u64 - (1 << 64)
    else:
        score_delta = delta_u64

    parent_state_root = bytes(data[offset: offset + 32]); offset += 32

    indices = []
    new_words = []
    for _ in range(word_count):
        idx, br = decode_leb128(data, offset)
        offset += br
        if offset + 32 > len(data):
            raise ValueError("Patch data truncated reading new_word")
        word_val = int.from_bytes(data[offset: offset + 32], byteorder="big")
        offset += 32
        indices.append(idx)
        new_words.append(word_val)

    return Patch(
        patch_type=patch_type,
        word_count=word_count,
        score_delta=score_delta,
        parent_state_root=parent_state_root,
        indices=indices,
        new_words=new_words,
    )


# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------

def apply_patch(state: CortexState, patch: Patch) -> PatchResult:
    """
    Apply *patch* to *state* following the V0 algorithm from specs/patch_format_v0.md.

    Returns PatchSuccess(ok=True, state=new_state) or PatchError(ok=False, code=EXX).
    """
    # Step 1: Budget check
    if patch.word_count < 1 or patch.word_count > 4:
        return PatchError(ok=False, code="E03", name="OVER_BUDGET")

    # Step 2: Parent-root check
    current_root = merkleize_state(state)
    if current_root != bytes(patch.parent_state_root):
        return PatchError(ok=False, code="E01", name="WRONG_PARENT_ROOT")

    # Step 3: No-op check
    all_noop = True
    for k in range(patch.word_count):
        if state.words[patch.indices[k]] != patch.new_words[k]:
            all_noop = False
            break
    if all_noop:
        return PatchError(ok=False, code="E05", name="NOOP_PATCH")

    # Step 4: Apply words (with range check)
    new_words = list(state.words)
    for k in range(patch.word_count):
        idx = patch.indices[k]
        # Reserved range (992–1023) is forbidden
        if RANGES.RESERVED_START <= idx <= RANGES.RESERVED_END:
            return PatchError(ok=False, code="E02", name="WRONG_TYPE_FIELD")
        new_words[idx] = patch.new_words[k]

    # Step 5: Reserved-bit check on resulting state
    new_state = CortexState(words=new_words)
    if has_non_zero_reserved_bits(new_state):
        return PatchError(ok=False, code="E04", name="RESERVED_BIT_SET")

    return PatchSuccess(ok=True, state=new_state)
