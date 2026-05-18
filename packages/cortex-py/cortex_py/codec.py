"""
codec.py — Pack/unpack (1024 × 32-byte big-endian) and sub-word bit helpers.

Spec: specs/packing_spec.md

Pack:
  Each word i (uint256) serialises as 32 big-endian bytes at offset 32*i.
  Total: 32 768 bytes.

Unpack:
  Read 32 bytes at 32*i as a big-endian unsigned integer → words[i].

Sub-word field extraction at (word_index, bits_hi, bits_lo):
  Both bits_hi and bits_lo are inclusive; bit 255 = MSB, bit 0 = LSB.
  mask  = (1 << (bits_hi - bits_lo + 1)) - 1
  value = (words[word_index] >> bits_lo) & mask

Sub-word field set:
  mask    = (1 << (bits_hi - bits_lo + 1)) - 1
  cleared = words[word_index] & ~(mask << bits_lo)
  words[word_index] = cleared | ((value & mask) << bits_lo)
"""
from __future__ import annotations
from .types import CortexState

PACKED_SIZE: int = 32_768  # 1024 * 32


def pack(state: CortexState) -> bytes:
    """Serialise CortexState → 32 768 bytes (1024 × 32 big-endian uint256)."""
    out = bytearray(PACKED_SIZE)
    for i, word in enumerate(state.words):
        # Each word is a non-negative integer ≤ 2**256 - 1
        word_bytes = word.to_bytes(32, byteorder="big")
        out[32 * i: 32 * i + 32] = word_bytes
    return bytes(out)


def unpack(data: bytes) -> CortexState:
    """Deserialise 32 768 bytes → CortexState. Raises ValueError on wrong length."""
    if len(data) != PACKED_SIZE:
        raise ValueError(f"Expected {PACKED_SIZE} bytes, got {len(data)}")
    words = [0] * 1024
    for i in range(1024):
        words[i] = int.from_bytes(data[32 * i: 32 * i + 32], byteorder="big")
    return CortexState(words=words)


def get_field(words: list[int], word_index: int, bits_hi: int, bits_lo: int) -> int:
    """
    Extract a sub-word field from words[word_index].

    bits_hi and bits_lo are both inclusive, with 255 = MSB and 0 = LSB.
    """
    width = bits_hi - bits_lo + 1
    mask = (1 << width) - 1
    return (words[word_index] >> bits_lo) & mask


def set_field(words: list[int], word_index: int, bits_hi: int, bits_lo: int, value: int) -> None:
    """
    Write a sub-word field into words[word_index] in-place.

    bits_hi and bits_lo are both inclusive.
    value is masked to fit the field width.
    """
    width = bits_hi - bits_lo + 1
    mask = (1 << width) - 1
    cleared = words[word_index] & ~(mask << bits_lo)
    words[word_index] = cleared | ((value & mask) << bits_lo)
