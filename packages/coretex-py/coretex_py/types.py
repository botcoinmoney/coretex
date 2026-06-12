"""
types.py — CortexState and Patch dataclasses, range constants, error codes.

All values derived from specs/coretex_state.md and specs/coretex_schema.json.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAGIC: int = 0xC07E          # sentinel — "coretex"
SCHEMA_VERSION_CURRENT: int = 0x0000
WORD_COUNT_VALUE: int = 1024


class RANGES:
    """Word-range boundaries (inclusive), from coretex_state.md."""
    WORD_COUNT: int = 1024

    HEADER_START: int = 0
    HEADER_END: int = 31

    MEMORY_INDEX_START: int = 32
    MEMORY_INDEX_END: int = 383

    RETRIEVAL_KEYS_START: int = 384
    RETRIEVAL_KEYS_END: int = 671

    RELATIONS_START: int = 672
    RELATIONS_END: int = 799

    TEMPORAL_START: int = 800
    TEMPORAL_END: int = 895

    CODEBOOK_START: int = 896
    CODEBOOK_END: int = 991

    RESERVED_START: int = 992
    RESERVED_END: int = 1023

    # r5 PolicyAtom regions (protocol epoch coretex-retrieval-v2-policy-r5).
    # These OVERLAY the reclaimed words: r4 (lens) profiles read 384-671 as
    # RetrievalKeys and 896-991 as Codebook; r5 (policy) profiles read them as
    # typed PolicyAtoms. Mirrors state/types.ts RANGES (TS is the launch
    # reference implementation; coretex-py is the dev-only cross-impl harness).
    POLICY_EVIDENCE_START: int = 384
    POLICY_EVIDENCE_END: int = 511
    POLICY_CONFLICT_START: int = 512
    POLICY_CONFLICT_END: int = 639
    POLICY_ABSTENTION_START: int = 640
    POLICY_ABSTENTION_END: int = 671
    POLICY_RESERVED_START: int = 896
    POLICY_RESERVED_END: int = 991


class PATCH_TYPE:
    """Patch type codes from specs/patch_format.md."""
    KEY_UPDATE: int = 0x01
    SLOT_REPLACE: int = 0x02
    TEMPORAL_UPDATE: int = 0x03
    RELATION_UPDATE: int = 0x04
    CODEBOOK_UPDATE: int = 0x05
    HEADER_UPDATE: int = 0x06
    POLICY_UPDATE: int = 0x07  # r5 typed PolicyAtom write (evidence-bundle / conflict / abstention)
    MIXED: int = 0xFF


class ERROR_CODES:
    """Stable rejection error codes from specs/patch_format.md."""
    E01 = "E01"  # WRONG_PARENT_ROOT
    E02 = "E02"  # WRONG_TYPE_FIELD
    E03 = "E03"  # OVER_BUDGET
    E04 = "E04"  # RESERVED_BIT_SET
    E05 = "E05"  # NOOP_PATCH


# ---------------------------------------------------------------------------
# CortexState
# ---------------------------------------------------------------------------

@dataclass
class CortexState:
    """
    Ordered array of 1024 uint256 words representing the Cortex state.

    words[i] is a Python int (arbitrary precision, treated as unsigned 256-bit).
    Serialised as 1024 × 32 bytes big-endian = 32 768 bytes total.
    """
    words: list[int] = field(default_factory=lambda: [0] * 1024)

    def __post_init__(self) -> None:
        if len(self.words) != 1024:
            raise ValueError(f"CortexState requires exactly 1024 words, got {len(self.words)}")

    def copy(self) -> "CortexState":
        return CortexState(words=list(self.words))


# ---------------------------------------------------------------------------
# Patch
# ---------------------------------------------------------------------------

@dataclass
class Patch:
    """
    A CortexState patch in the current wire format (deserialized).

    Fields:
      patch_type       — advisory routing byte (PATCH_TYPE.*)
      word_count       — number of target words (1–4)
      score_delta      — int64 score change × 1e6
      parent_state_root — 32-byte Merkle root of the parent state
      indices          — list of word indices (length == word_count)
      new_words        — list of new word values (length == word_count)
    """
    patch_type: int
    word_count: int
    score_delta: int  # signed int64
    parent_state_root: bytes  # 32 bytes
    indices: list[int]
    new_words: list[int]  # uint256 each


# ---------------------------------------------------------------------------
# PatchError / PatchResult
# ---------------------------------------------------------------------------

@dataclass
class PatchError:
    ok: bool = False
    code: str = ""   # "E01".."E05"
    name: str = ""


@dataclass
class PatchSuccess:
    ok: bool = True
    state: Optional[CortexState] = None


PatchResult = PatchSuccess | PatchError
