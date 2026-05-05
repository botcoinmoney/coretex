"""
Tests for cortex_py.codec — pack/unpack round-trip and bit field helpers.
"""
import pytest
import random
from cortex_py.codec import pack, unpack, get_field, set_field, PACKED_SIZE
from cortex_py.types import CortexState


def _make_zero_state() -> CortexState:
    return CortexState(words=[0] * 1024)


def test_packed_size_constant():
    assert PACKED_SIZE == 32_768


def test_pack_zero_state():
    state = _make_zero_state()
    packed = pack(state)
    assert len(packed) == 32_768
    assert packed == b"\x00" * 32_768


def test_pack_unpack_zero_roundtrip():
    state = _make_zero_state()
    packed = pack(state)
    back = unpack(packed)
    assert back.words == state.words


def test_pack_unpack_single_word():
    """Word at position i survives pack→unpack."""
    for i in [0, 1, 511, 512, 1023]:
        words = [0] * 1024
        words[i] = (1 << 255)  # MSB set
        state = CortexState(words=words)
        packed = pack(state)
        back = unpack(packed)
        assert back.words[i] == words[i], f"Word {i} mismatch after round-trip"


def test_pack_big_endian_order():
    """The high byte of word i is at byte offset 32*i."""
    words = [0] * 1024
    words[0] = 0x0102_0304_0506_0708_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0000_0001
    state = CortexState(words=words)
    packed = pack(state)
    # Byte 0 of word 0 should be 0x01 (MSB of the word)
    assert packed[0] == 0x01, f"Expected 0x01 at byte 0, got 0x{packed[0]:02x}"
    assert packed[31] == 0x01, f"Expected 0x01 at byte 31 (LSB), got 0x{packed[31]:02x}"


def test_word_placement():
    """Word i is at bytes 32*i through 32*i+31."""
    words = [0] * 1024
    words[5] = (0xFF << 248)  # MSB byte = 0xFF for word 5
    state = CortexState(words=words)
    packed = pack(state)
    assert packed[5 * 32] == 0xFF
    assert packed[5 * 32 + 1] == 0x00


def test_unpack_wrong_length():
    with pytest.raises(ValueError, match="Expected 32768"):
        unpack(b"\x00" * 100)


def test_unpack_wrong_length_too_long():
    with pytest.raises(ValueError):
        unpack(b"\x00" * 32_769)


def test_pack_unpack_roundtrip_random():
    """100 random states survive pack→unpack byte-for-byte."""
    rng = random.Random(0xABCD_1234)
    for _ in range(100):
        words = [rng.randrange(0, 1 << 256) for _ in range(1024)]
        state = CortexState(words=words)
        packed = pack(state)
        back = unpack(packed)
        assert back.words == state.words


def test_max_word_value():
    """All words set to 2**256-1 round-trip correctly."""
    words = [(1 << 256) - 1] * 1024
    state = CortexState(words=words)
    packed = pack(state)
    assert packed == b"\xff" * 32_768
    back = unpack(packed)
    assert back.words == words


# ---- get_field / set_field ----

def test_get_field_msb():
    words = [0] * 1024
    words[0] = (1 << 255)  # bit 255 set
    val = get_field(words, 0, 255, 255)
    assert val == 1


def test_get_field_range():
    words = [0] * 1024
    # Set bits 15:0 to 0xABCD
    words[0] = 0xABCD
    val = get_field(words, 0, 15, 0)
    assert val == 0xABCD


def test_get_field_mid_range():
    words = [0] * 1024
    # Set bits 239:224 to 0x1234
    words[0] = 0x1234 << 224
    val = get_field(words, 0, 239, 224)
    assert val == 0x1234


def test_set_field_and_get_back():
    words = [0] * 1024
    set_field(words, 3, 255, 240, 0xC07E)
    val = get_field(words, 3, 255, 240)
    assert val == 0xC07E


def test_set_field_does_not_clobber_adjacent():
    words = [0] * 1024
    words[0] = (1 << 256) - 1  # all ones
    # Set bits 15:0 to 0x0000
    set_field(words, 0, 15, 0, 0)
    # Bits 255:16 should still be 1
    assert get_field(words, 0, 255, 16) == (1 << 240) - 1
    assert get_field(words, 0, 15, 0) == 0


def test_set_field_masks_value():
    """Values wider than the field are masked down."""
    words = [0] * 1024
    set_field(words, 0, 7, 0, 0xABCD)  # 8-bit field, value=0xABCD → masked to 0xCD
    val = get_field(words, 0, 7, 0)
    assert val == 0xCD
