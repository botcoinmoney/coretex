"""
Tests for coretex_py.merkle — Merkle root derivation.
"""
import pytest
from coretex_py.merkle import merkleize_state, bytes_to_hex, hex_to_bytes
from coretex_py.types import CortexState
from coretex_py.keccak import keccak256


def _make_state(fill: int = 0) -> CortexState:
    return CortexState(words=[fill] * 1024)


def test_root_length():
    """Merkle root is always 32 bytes."""
    root = merkleize_state(_make_state())
    assert len(root) == 32


def test_all_zero_state_deterministic():
    """Same state → same root every call."""
    state = _make_state(0)
    r1 = merkleize_state(state)
    r2 = merkleize_state(state)
    assert r1 == r2


def test_all_zero_root_known_value():
    """
    Compute the expected root for all-zero state independently.

    leaf[i] = keccak256(b"\\x00" * 32) for all i
    Then build the perfect binary tree of depth 10.
    """
    zero_32 = b"\x00" * 32
    leaf = keccak256(zero_32)
    level = [leaf] * 1024
    while len(level) > 1:
        next_level = []
        for i in range(0, len(level), 2):
            next_level.append(keccak256(level[i] + level[i + 1]))
        level = next_level
    expected_root = level[0]

    actual_root = merkleize_state(_make_state(0))
    assert actual_root == expected_root


def test_different_states_different_roots():
    """Any change to a word changes the root."""
    state_a = _make_state(0)
    state_b = CortexState(words=[0] * 1024)
    state_b.words[500] = 1  # flip one word
    root_a = merkleize_state(state_a)
    root_b = merkleize_state(state_b)
    assert root_a != root_b


def test_position_matters():
    """Swapping two words with different values changes the root."""
    words_a = [0] * 1024
    words_a[0] = 1
    words_a[1] = 2
    words_b = list(words_a)
    words_b[0] = 2
    words_b[1] = 1
    root_a = merkleize_state(CortexState(words=words_a))
    root_b = merkleize_state(CortexState(words=words_b))
    assert root_a != root_b, "Tree must be positional (no sorting)"


def test_only_changed_word_affects_root():
    """
    Changing word i should change the root but not affect other paths
    (internal consistency — verify we don't accidentally change another word).
    """
    import random
    rng = random.Random(42)
    words = [rng.randrange(0, 1 << 256) for _ in range(1024)]
    state = CortexState(words=list(words))
    root1 = merkleize_state(state)

    # Change word 300
    words[300] ^= (1 << 100)
    state2 = CortexState(words=list(words))
    root2 = merkleize_state(state2)
    assert root1 != root2

    # Change it back
    words[300] ^= (1 << 100)
    state3 = CortexState(words=list(words))
    root3 = merkleize_state(state3)
    assert root1 == root3


def test_bytes_to_hex():
    assert bytes_to_hex(b"\x00\xff\xab") == "00ffab"


def test_hex_to_bytes():
    assert hex_to_bytes("00ffab") == b"\x00\xff\xab"
    assert hex_to_bytes("0x00ffab") == b"\x00\xff\xab"
    assert hex_to_bytes("0X00FFAB") == b"\x00\xff\xab"


def test_hex_roundtrip():
    root = merkleize_state(_make_state(0))
    assert hex_to_bytes(bytes_to_hex(root)) == root


def test_leaf_encodes_word_big_endian():
    """
    Leaf hash for word=1 should equal keccak256(0x00...0001) — 31 zero bytes + 0x01.
    """
    from coretex_py.merkle import _leaf
    expected = keccak256(b"\x00" * 31 + b"\x01")
    actual = _leaf(1)
    assert actual == expected


def test_self_parity_100_random_states():
    """100 random states: root is the same when computed twice (determinism)."""
    import random
    rng = random.Random(0xDEAD_BEEF)
    for _ in range(100):
        words = [rng.randrange(0, 1 << 256) for _ in range(1024)]
        state = CortexState(words=words)
        r1 = merkleize_state(state)
        r2 = merkleize_state(state)
        assert r1 == r2
