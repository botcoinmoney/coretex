"""
cortex_py — Botcoin Cortex Python 3 second reference implementation.

Phase 1 deliverable: pack/unpack, keccak256 (Ethereum variant), Merkle
root derivation, reserved-bit validation, and patch wire format.

This package is an independent re-implementation of the TypeScript reference
impl at packages/cortex/src/state/. Both derive solely from the specs in
specs/. Independence is the cross-impl parity guarantee.
"""

from .types import (
    CortexState,
    Patch,
    PatchError,
    PatchResult,
    RANGES,
    PATCH_TYPE,
    ERROR_CODES,
    MAGIC,
    SCHEMA_VERSION_CURRENT,
    WORD_COUNT_VALUE,
)
from .codec import pack, unpack, get_field, set_field, PACKED_SIZE
from .keccak import keccak256
from .merkle import merkleize_state, bytes_to_hex, hex_to_bytes
from .validate import has_non_zero_reserved_bits, RESERVED_MASKS
from .patch import (
    encode_leb128,
    decode_leb128,
    encode_patch,
    decode_patch,
    apply_patch,
)

__all__ = [
    "CortexState",
    "Patch",
    "PatchError",
    "PatchResult",
    "RANGES",
    "PATCH_TYPE",
    "ERROR_CODES",
    "MAGIC",
    "SCHEMA_VERSION_CURRENT",
    "WORD_COUNT_VALUE",
    "pack",
    "unpack",
    "get_field",
    "set_field",
    "PACKED_SIZE",
    "keccak256",
    "merkleize_state",
    "bytes_to_hex",
    "hex_to_bytes",
    "has_non_zero_reserved_bits",
    "RESERVED_MASKS",
    "encode_leb128",
    "decode_leb128",
    "encode_patch",
    "decode_patch",
    "apply_patch",
]
