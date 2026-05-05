"""
Tests for cortex_py.validate — reserved-bit enforcement.
"""
import pytest
from cortex_py.validate import has_non_zero_reserved_bits, RESERVED_MASKS
from cortex_py.types import CortexState, RANGES


def _valid_header_word0() -> int:
    """Build a valid word 0: MAGIC=0xC07E, SCHEMA_VERSION=0, WORD_COUNT=1024, FLAGS=0."""
    return (0xC07E << 240) | (0x0000 << 224) | (1024 << 208)


def _make_minimal_valid_state() -> CortexState:
    """Minimal state with correct header word 0, all others zero."""
    words = [0] * 1024
    words[0] = _valid_header_word0()
    return CortexState(words=words)


def test_zero_state_has_reserved_bits_set():
    """
    The all-zero state has reserved bits non-zero in words 0: FLAGS sub-reserved
    and header magic zeros — actually the all-zero state is valid for reserved bits
    since reserved means must-be-zero; zero IS zero.
    """
    # All zeros: every reserved bit IS zero → no violation
    state = CortexState(words=[0] * 1024)
    assert not has_non_zero_reserved_bits(state)


def test_valid_minimal_state():
    state = _make_minimal_valid_state()
    # Word 0 fields all set correctly, no reserved bits violated
    assert not has_non_zero_reserved_bits(state)


def test_reserved_range_words_must_be_zero():
    """Words 992–1023 are entirely reserved; any non-zero bit → violation."""
    for word_idx in [992, 1000, 1023]:
        state = CortexState(words=[0] * 1024)
        state.words[word_idx] = 1
        assert has_non_zero_reserved_bits(state), \
            f"Word {word_idx} non-zero not caught"


def test_word0_reserved_bits():
    """Bits 191:0 of word 0 are reserved."""
    state = CortexState(words=[0] * 1024)
    state.words[0] = _valid_header_word0()
    # Set a reserved bit: bit 0 of word 0 (falls in bits 191:0 reserved zone)
    state.words[0] |= 1
    assert has_non_zero_reserved_bits(state)


def test_word1_reserved_bits():
    """Bits 127:0 of word 1 are reserved."""
    state = CortexState(words=[0] * 1024)
    state.words[1] = 1  # bit 0 is in reserved area 127:0
    assert has_non_zero_reserved_bits(state)


def test_word8_reserved_bits():
    """Bits 63:0 of word 8 are reserved."""
    state = CortexState(words=[0] * 1024)
    state.words[8] = 1  # bit 0 is in reserved area
    assert has_non_zero_reserved_bits(state)


def test_words_11_to_31_reserved():
    """Words 11–31 are entirely reserved (must all be zero)."""
    for i in range(11, 32):
        state = CortexState(words=[0] * 1024)
        state.words[i] = 1
        assert has_non_zero_reserved_bits(state), f"Word {i} not caught"


def test_memory_index_slot0_reserved_lower_64():
    """Bits 63:0 of each MemoryIndex slot-word 0 are reserved."""
    # Slot 0, word 0 = index 32
    state = CortexState(words=[0] * 1024)
    state.words[32] = 1  # bit 0 is in reserved_slot0[63:0]
    assert has_non_zero_reserved_bits(state)


def test_memory_index_validity_flags_reserved():
    """VALIDITY_FLAGS bits 3–15 (word bits 67–79) of slot-word 0 are reserved."""
    state = CortexState(words=[0] * 1024)
    # Set bit 67 (= VALIDITY_FLAGS bit 3) of word 32
    state.words[32] = 1 << 67
    assert has_non_zero_reserved_bits(state)


def test_retrieval_keys_flags_reserved():
    """KEY_FLAGS bits 1–15 (word bits 81–95) of slot-word 0 are reserved."""
    state = CortexState(words=[0] * 1024)
    # Word 384, bit 81 (= KEY_FLAGS bit 1)
    state.words[384] = 1 << 81
    assert has_non_zero_reserved_bits(state)


def test_relations_reserved_lower_192():
    """Bits 191:0 of each Relations word are reserved."""
    state = CortexState(words=[0] * 1024)
    state.words[672] = 1  # bit 0 is in reserved_rel[191:0]
    assert has_non_zero_reserved_bits(state)


def test_temporal_reserved_lower_32():
    """Bits 31:0 of each Temporal word are reserved."""
    state = CortexState(words=[0] * 1024)
    state.words[800] = 1  # bit 0 is in reserved_tmp[31:0]
    assert has_non_zero_reserved_bits(state)


def test_temporal_flags_reserved_bits():
    """TEMPORAL_FLAGS bits 1–15 (word bits 33–47) are reserved."""
    state = CortexState(words=[0] * 1024)
    state.words[800] = 1 << 33  # bit 33 = TEMPORAL_FLAGS bit 1
    assert has_non_zero_reserved_bits(state)


def test_codebook_reserved_lower_207():
    """Bits 207:0 of each Codebook entry word 0 are reserved (except bit 208)."""
    state = CortexState(words=[0] * 1024)
    state.words[896] = 1  # bit 0 is in reserved_cb0
    assert has_non_zero_reserved_bits(state)


def test_codebook_code_flags_reserved():
    """CODE_FLAGS bits 1–15 (word bits 209–223) of codebook word 0 are reserved."""
    state = CortexState(words=[0] * 1024)
    state.words[896] = 1 << 209  # CODE_FLAGS bit 1
    assert has_non_zero_reserved_bits(state)


def test_reserved_masks_count():
    """
    RESERVED_MASKS should have entries for many words.
    At minimum: words 0-1, 8, 11-31, 32-383 (partial), 384-671 (partial),
    672-799, 800-895, 896-991 (partial), 992-1023.
    """
    assert len(RESERVED_MASKS) > 100, f"Expected >100 entries, got {len(RESERVED_MASKS)}"


def test_clean_state_passes():
    """A clean state (only valid fields set) passes."""
    state = CortexState(words=[0] * 1024)
    # Set valid header fields
    state.words[0] = (0xC07E << 240) | (1024 << 208)
    # Set EPOCH in word 1
    state.words[1] = 42 << 192
    assert not has_non_zero_reserved_bits(state)
