"""
merkle.py — Keccak-256 binary Merkle tree over the 1024-word CortexState.

Spec: specs/merkleization_spec_v0.md

Algorithm:
  1. Compute 1024 leaves: leaf[i] = keccak256(bigEndian32(words[i]))
  2. Build a perfect binary tree bottom-up (1024 = 2^10, depth 10).
     Internal node: keccak256(left_child || right_child)  — 64-byte input.
     Children are NOT sorted; position is fixed.
  3. Return the single root (32 bytes).

Determinism requirements from spec:
  - Same 1024-word state → same root on every platform and language.
  - Big-endian word encoding mandatory.
  - keccak256 must match Ethereum's on-chain variant (Keccak, not NIST SHA-3).
  - No randomness, no timestamps.
"""
from __future__ import annotations
from .types import CortexState
from .keccak import keccak256


def _leaf(word: int) -> bytes:
    """Compute leaf hash: keccak256(big-endian 32-byte encoding of word)."""
    return keccak256(word.to_bytes(32, byteorder="big"))


def merkleize_state(state: CortexState) -> bytes:
    """
    Compute the Merkle root of a 1024-word CortexState.

    Returns 32 bytes (the root hash).
    """
    # Level 0: 1024 leaves
    level: list[bytes] = [_leaf(w) for w in state.words]

    # Bottom-up reduction: 10 rounds halve the level each time
    while len(level) > 1:
        next_level: list[bytes] = []
        for i in range(0, len(level), 2):
            next_level.append(keccak256(level[i] + level[i + 1]))
        level = next_level

    return level[0]


# ---------------------------------------------------------------------------
# Hex helpers (used by CLI and cross-impl tests)
# ---------------------------------------------------------------------------

def bytes_to_hex(data: bytes) -> str:
    """Return lowercase hex string without 0x prefix."""
    return data.hex()


def hex_to_bytes(s: str) -> bytes:
    """Parse a hex string (with or without 0x prefix) to bytes."""
    s = s.strip()
    if s.startswith("0x") or s.startswith("0X"):
        s = s[2:]
    return bytes.fromhex(s)
