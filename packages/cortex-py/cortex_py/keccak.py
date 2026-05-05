"""
keccak.py — keccak256 wrapper using pycryptodome.

Rationale for pycryptodome:
  Python's standard library hashlib provides SHA-3 (NIST FIPS 202), which uses
  different domain-separation padding from the original Keccak submission.
  pycryptodome's Crypto.Hash.keccak.new(digest_bits=256) implements the
  pre-NIST Keccak-256, which is what Ethereum's on-chain keccak256 uses.

  Verified against the canonical test vector:
    keccak256(b"") == c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470

Spec: specs/merkleization_spec_v0.md §Hash function
"""
from __future__ import annotations
from Crypto.Hash import keccak as _keccak_mod  # type: ignore[import]


def keccak256(data: bytes | bytearray) -> bytes:
    """
    Compute the Keccak-256 hash of *data* and return 32 bytes.

    This matches the Ethereum / Solidity built-in keccak256, NOT Python's
    hashlib sha3_256 (which is NIST SHA-3 with different padding).
    """
    h = _keccak_mod.new(digest_bits=256)
    h.update(bytes(data))
    return h.digest()
