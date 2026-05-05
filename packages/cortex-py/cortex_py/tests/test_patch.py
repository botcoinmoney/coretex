"""
Tests for cortex_py.patch — LEB128, encode/decode, apply_patch with E01..E05.
"""
import pytest
import random
from cortex_py.patch import (
    encode_leb128, decode_leb128,
    encode_patch, decode_patch,
    apply_patch,
)
from cortex_py.types import CortexState, Patch, RANGES, PATCH_TYPE
from cortex_py.merkle import merkleize_state


# ---------------------------------------------------------------------------
# LEB128
# ---------------------------------------------------------------------------

def test_leb128_zero():
    assert encode_leb128(0) == bytes([0])
    val, br = decode_leb128(bytes([0]))
    assert val == 0 and br == 1


def test_leb128_127():
    """127 fits in one byte."""
    enc = encode_leb128(127)
    assert enc == bytes([127])
    val, br = decode_leb128(enc)
    assert val == 127 and br == 1


def test_leb128_128():
    """128 requires two bytes: 0x80 0x01."""
    enc = encode_leb128(128)
    assert enc == bytes([0x80, 0x01])
    val, br = decode_leb128(enc)
    assert val == 128 and br == 2


def test_leb128_1023():
    """Max word index 1023 = 0b1_1111111 → two bytes: 0xFF 0x07."""
    enc = encode_leb128(1023)
    assert len(enc) == 2
    val, br = decode_leb128(enc)
    assert val == 1023 and br == 2


def test_leb128_roundtrip_range():
    for n in range(1024):
        enc = encode_leb128(n)
        val, _ = decode_leb128(enc)
        assert val == n, f"Roundtrip failed for n={n}"


def test_leb128_large_value():
    # 0x3FFF = 16383 = 11_1111111111111b (14 bits) → ceil(14/7) = 2 LEB128 bytes
    n = 0x3FFF
    enc = encode_leb128(n)
    assert len(enc) == 2
    val, br = decode_leb128(enc)
    assert val == n and br == 2

    # 0x1FFFFF = 2097151 = 21 bits → ceil(21/7) = 3 LEB128 bytes
    n3 = 0x1FFFFF
    enc3 = encode_leb128(n3)
    assert len(enc3) == 3
    val3, br3 = decode_leb128(enc3)
    assert val3 == n3 and br3 == 3


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rng_uint256(rng: random.Random) -> int:
    return rng.randrange(0, 1 << 256)


def _make_valid_state(rng: random.Random) -> CortexState:
    """Make a state with valid header and random-but-valid payload."""
    words = [0] * 1024
    # Header word 0: MAGIC, WORD_COUNT
    words[0] = (0xC07E << 240) | (1024 << 208)

    # MemoryIndex slots — only fill non-reserved fields
    for slot in range(44):
        base = 32 + slot * 8
        event_id = rng.randrange(0, 1 << 128)
        domain = rng.randrange(0, 1 << 32)
        obj_type = 0x0001
        # validity bits 0-2 only
        validity = rng.randrange(0, 8)
        words[base] = (event_id << 128) | (domain << 96) | (obj_type << 80) | (validity << 64)
        checksum = rng.randrange(0, 1 << 128)
        corpus_epoch = rng.randrange(0, 1 << 64)
        expiry_epoch = rng.randrange(0, 1 << 64)
        words[base + 1] = (checksum << 128) | (corpus_epoch << 64) | expiry_epoch
        for sw in range(2, 8):
            words[base + sw] = _rng_uint256(rng)

    # RetrievalKeys slots
    for slot in range(36):
        base = 384 + slot * 8
        key_id = rng.randrange(0, 1 << 128)
        key_type = 0x0001
        key_dim = rng.randrange(0, 1 << 16)
        key_flags = 1  # bit 0 only
        words[base] = (key_id << 128) | (key_type << 112) | (key_dim << 96) | (key_flags << 80)
        for sw in range(1, 8):
            words[base + sw] = _rng_uint256(rng)

    # Relations
    for i in range(128):
        src = rng.randrange(0, 1 << 16)
        dst = rng.randrange(0, 1 << 16)
        rt = 0x0001
        wt = rng.randrange(0, 1 << 16)
        words[672 + i] = (src << 240) | (dst << 224) | (rt << 208) | (wt << 192)

    # Temporal
    for i in range(96):
        mem_idx = rng.randrange(0, 1 << 16)
        valid_from = rng.randrange(0, 1 << 64)
        valid_until = rng.randrange(0, 1 << 64)
        revoke = rng.randrange(0, 1 << 64)
        t_flags = rng.randrange(0, 2)  # bit 0 only
        words[800 + i] = (
            (mem_idx << 240)
            | (valid_from << 176)
            | (valid_until << 112)
            | (revoke << 48)
            | (t_flags << 32)
        )

    # Codebook
    for slot in range(48):
        base = 896 + slot * 2
        code = rng.randrange(0, 1 << 16)
        code_type = 0x0001
        code_flags = 1  # bit 0 only
        words[base] = (code << 240) | (code_type << 224) | (code_flags << 208)
        words[base + 1] = _rng_uint256(rng)

    return CortexState(words=words)


def _make_simple_patch(state: CortexState, idx: int, new_val: int,
                       patch_type: int = PATCH_TYPE.MIXED) -> Patch:
    root = merkleize_state(state)
    return Patch(
        patch_type=patch_type,
        word_count=1,
        score_delta=0,
        parent_state_root=root,
        indices=[idx],
        new_words=[new_val],
    )


# ---------------------------------------------------------------------------
# Encode / Decode round-trip
# ---------------------------------------------------------------------------

def test_encode_decode_1word():
    rng = random.Random(1)
    state = _make_valid_state(rng)
    root = merkleize_state(state)
    patch = Patch(
        patch_type=PATCH_TYPE.SLOT_REPLACE,
        word_count=1,
        score_delta=12345,
        parent_state_root=root,
        indices=[100],
        new_words=[_rng_uint256(rng)],
    )
    wire = encode_patch(patch)
    back = decode_patch(wire)
    assert back.patch_type == patch.patch_type
    assert back.word_count == patch.word_count
    assert back.score_delta == patch.score_delta
    assert back.parent_state_root == patch.parent_state_root
    assert back.indices == patch.indices
    assert back.new_words == patch.new_words


def test_encode_decode_4words():
    rng = random.Random(42)
    state = _make_valid_state(rng)
    root = merkleize_state(state)
    indices = [50, 200, 700, 900]  # indices < 128 and >= 128
    patch = Patch(
        patch_type=PATCH_TYPE.MIXED,
        word_count=4,
        score_delta=-99,
        parent_state_root=root,
        indices=indices,
        new_words=[_rng_uint256(rng) for _ in range(4)],
    )
    wire = encode_patch(patch)
    back = decode_patch(wire)
    assert back.word_count == 4
    assert back.indices == indices
    assert back.new_words == patch.new_words
    assert back.score_delta == -99


def test_encode_decode_roundtrip():
    """encode(decode(x)) == x for all valid patches."""
    rng = random.Random(0xFEED)
    for _ in range(100):
        wc = rng.randint(1, 4)
        indices = sorted(set(rng.randrange(0, 992) for _ in range(wc)))
        while len(indices) < wc:
            indices.append(rng.randrange(0, 992))
        indices = indices[:wc]
        patch = Patch(
            patch_type=PATCH_TYPE.MIXED,
            word_count=wc,
            score_delta=rng.randrange(-(1 << 63), 1 << 63),
            parent_state_root=bytes(rng.randrange(0, 256) for _ in range(32)),
            indices=indices,
            new_words=[_rng_uint256(rng) for _ in range(wc)],
        )
        wire = encode_patch(patch)
        back = decode_patch(wire)
        re_wire = encode_patch(back)
        assert wire == re_wire, "encode(decode(wire)) != wire"


def test_wire_size_budget_p99():
    """99th-pct wire size ≤ 200 bytes for 4-word patches (spec budget)."""
    rng = random.Random(0x99BB22CC)
    sizes = []
    for _ in range(10_000):
        indices_set: set[int] = set()
        while len(indices_set) < 4:
            indices_set.add(rng.randrange(0, 992))
        idx_list = list(indices_set)[:4]
        patch = Patch(
            patch_type=PATCH_TYPE.MIXED,
            word_count=4,
            score_delta=rng.randrange(-(1 << 63), 1 << 63),
            parent_state_root=bytes(rng.randrange(0, 256) for _ in range(32)),
            indices=idx_list,
            new_words=[_rng_uint256(rng) for _ in range(4)],
        )
        sizes.append(len(encode_patch(patch)))
    sizes.sort()
    p99 = sizes[int(len(sizes) * 0.99) - 1]
    p50 = sizes[int(len(sizes) * 0.50)]
    print(f"  p50={p50} p99={p99} max={sizes[-1]}")
    assert p99 <= 200, f"p99 wire size {p99} > 200-byte budget"


# ---------------------------------------------------------------------------
# apply_patch
# ---------------------------------------------------------------------------

def test_apply_patch_success():
    rng = random.Random(100)
    state = _make_valid_state(rng)
    # Change a MemoryIndex payload word (word 34 = slot 0, payload word 2)
    idx = 34
    new_val = _rng_uint256(rng)
    patch = _make_simple_patch(state, idx, new_val)
    result = apply_patch(state, patch)
    assert result.ok, f"Expected success, got {result}"
    assert result.state.words[idx] == new_val
    # Other words unchanged
    for i in range(1024):
        if i != idx:
            assert result.state.words[i] == state.words[i]


def test_apply_patch_e01_wrong_parent_root():
    rng = random.Random(200)
    state = _make_valid_state(rng)
    wrong_root = bytes([0xAA] * 32)
    patch = Patch(
        patch_type=PATCH_TYPE.SLOT_REPLACE,
        word_count=1,
        score_delta=0,
        parent_state_root=wrong_root,
        indices=[50],
        new_words=[123],
    )
    result = apply_patch(state, patch)
    assert not result.ok
    assert result.code == "E01"


def test_apply_patch_e02_reserved_index():
    """Index in 992–1023 → E02."""
    rng = random.Random(300)
    state = _make_valid_state(rng)
    root = merkleize_state(state)
    patch = Patch(
        patch_type=PATCH_TYPE.MIXED,
        word_count=1,
        score_delta=0,
        parent_state_root=root,
        indices=[1000],
        new_words=[123],
    )
    result = apply_patch(state, patch)
    assert not result.ok
    assert result.code == "E02"


def test_apply_patch_e03_over_budget():
    """word_count > 4 → E03."""
    rng = random.Random(400)
    state = _make_valid_state(rng)
    root = merkleize_state(state)
    patch = Patch(
        patch_type=PATCH_TYPE.MIXED,
        word_count=5,
        score_delta=0,
        parent_state_root=root,
        indices=[1, 2, 3, 4, 5],
        new_words=[1, 2, 3, 4, 5],
    )
    result = apply_patch(state, patch)
    assert not result.ok
    assert result.code == "E03"


def test_apply_patch_e04_reserved_bit_set():
    """Setting a reserved bit in the resulting state → E04."""
    rng = random.Random(500)
    state = _make_valid_state(rng)
    root = merkleize_state(state)
    # Word 11 is entirely reserved; setting it to 1 violates reserved-bit rule
    patch = Patch(
        patch_type=PATCH_TYPE.HEADER_UPDATE,
        word_count=1,
        score_delta=0,
        parent_state_root=root,
        indices=[11],
        new_words=[1],
    )
    result = apply_patch(state, patch)
    assert not result.ok
    assert result.code == "E04"


def test_apply_patch_e05_noop():
    """All target words unchanged → E05."""
    rng = random.Random(600)
    state = _make_valid_state(rng)
    root = merkleize_state(state)
    idx = 50
    current_val = state.words[idx]
    patch = Patch(
        patch_type=PATCH_TYPE.SLOT_REPLACE,
        word_count=1,
        score_delta=0,
        parent_state_root=root,
        indices=[idx],
        new_words=[current_val],
    )
    result = apply_patch(state, patch)
    assert not result.ok
    assert result.code == "E05"


def test_apply_patch_e03_zero_count():
    """word_count = 0 → E03 (< 1)."""
    rng = random.Random(700)
    state = _make_valid_state(rng)
    root = merkleize_state(state)
    patch = Patch(
        patch_type=PATCH_TYPE.MIXED,
        word_count=0,
        score_delta=0,
        parent_state_root=root,
        indices=[],
        new_words=[],
    )
    result = apply_patch(state, patch)
    assert not result.ok
    assert result.code == "E03"


def test_apply_patch_multiple_words():
    """4-word patch applies all words."""
    rng = random.Random(800)
    state = _make_valid_state(rng)
    root = merkleize_state(state)
    # Use MemoryIndex payload words (non-reserved, no sub-field restrictions)
    indices = [34, 35, 36, 37]  # slot 0, payload words 2–5
    new_vals = [_rng_uint256(rng) for _ in range(4)]
    patch = Patch(
        patch_type=PATCH_TYPE.SLOT_REPLACE,
        word_count=4,
        score_delta=1000,
        parent_state_root=root,
        indices=indices,
        new_words=new_vals,
    )
    result = apply_patch(state, patch)
    assert result.ok, f"Expected success: {result}"
    for i, idx in enumerate(indices):
        assert result.state.words[idx] == new_vals[i]
