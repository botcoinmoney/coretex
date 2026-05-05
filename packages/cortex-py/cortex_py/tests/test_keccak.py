"""
Tests for cortex_py.keccak — verifies Ethereum Keccak-256 (not NIST SHA-3).
"""
import pytest
from cortex_py.keccak import keccak256


def test_empty_string_vector():
    """keccak256(b"") == Ethereum's canonical empty-input hash."""
    result = keccak256(b"")
    expected = bytes.fromhex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
    assert result == expected, f"Keccak empty-string mismatch: {result.hex()}"


def test_not_nist_sha3():
    """
    NIST SHA3-256("") == a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a
    Keccak-256("") == c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    These differ; assert we produce the Keccak variant.
    """
    nist_sha3_empty = bytes.fromhex("a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a")
    result = keccak256(b"")
    assert result != nist_sha3_empty, "keccak256 must not match NIST SHA3-256"


def test_known_vector_abc():
    """keccak256(b"abc") — independently computed Ethereum vector."""
    result = keccak256(b"abc")
    # keccak256("abc") per Ethereum: 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
    expected = bytes.fromhex("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
    assert result == expected, f"keccak256('abc') mismatch: {result.hex()}"


def test_output_length():
    """keccak256 always returns exactly 32 bytes."""
    for data in [b"", b"x", b"\x00" * 100, b"\xff" * 32]:
        result = keccak256(data)
        assert len(result) == 32, f"Expected 32 bytes, got {len(result)}"


def test_deterministic():
    """Same input always produces the same output."""
    data = b"cortex-state-v0"
    r1 = keccak256(data)
    r2 = keccak256(data)
    assert r1 == r2


def test_different_inputs_differ():
    """Different inputs produce different outputs (sanity)."""
    assert keccak256(b"a") != keccak256(b"b")
    assert keccak256(b"\x00") != keccak256(b"\x01")
