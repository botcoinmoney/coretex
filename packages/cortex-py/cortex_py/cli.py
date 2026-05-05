"""
cli.py — Command-line interface for cortex_py.

Usage:
  python -m cortex_py merkleize <hex_state_bytes>
      Reads 32768 bytes of hex-encoded state (65536 hex chars, with or without
      0x prefix), prints the 32-byte Merkle root as a hex string.

  python -m cortex_py apply-patch <state_hex> <patch_hex>
      Applies the patch to the state.
      Prints JSON: {"ok": true, "state": "<hex>"} or {"ok": false, "code": "EXX"}

  python -m cortex_py batch-stdin
      Reads newline-delimited JSON from stdin. Each line is:
        {"cmd": "merkleize", "state": "<hex>"}
        {"cmd": "apply-patch", "state": "<hex>", "patch": "<hex>"}
      Writes one JSON response per line to stdout. Used by the cross-impl parity
      test runner for high-throughput comparison.

  python -m cortex_py verify-keccak
      Prints a known keccak256 test vector for implementation verification.
"""
from __future__ import annotations
import sys
import json
from .codec import pack, unpack
from .merkle import merkleize_state, bytes_to_hex, hex_to_bytes
from .patch import decode_patch, apply_patch
from .keccak import keccak256


def _merkleize_hex(state_hex: str) -> str:
    state_bytes = hex_to_bytes(state_hex)
    state = unpack(state_bytes)
    root = merkleize_state(state)
    return bytes_to_hex(root)


def _apply_patch_hex(state_hex: str, patch_hex: str) -> dict:
    state_bytes = hex_to_bytes(state_hex)
    patch_bytes = hex_to_bytes(patch_hex)
    state = unpack(state_bytes)
    patch = decode_patch(patch_bytes)
    result = apply_patch(state, patch)
    if result.ok:
        return {"ok": True, "state": bytes_to_hex(pack(result.state))}
    else:
        return {"ok": False, "code": result.code, "name": result.name}


def _batch_stdin() -> None:
    """High-throughput batch mode: one JSON command per line, one JSON response per line."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            cmd = req.get("cmd", "")
            if cmd == "merkleize":
                root_hex = _merkleize_hex(req["state"])
                print(json.dumps({"ok": True, "root": root_hex}), flush=True)
            elif cmd == "apply-patch":
                result = _apply_patch_hex(req["state"], req["patch"])
                print(json.dumps(result), flush=True)
            elif cmd == "pack-unpack":
                # Round-trip: unpack then pack, return result
                state_bytes = hex_to_bytes(req["state"])
                state = unpack(state_bytes)
                print(json.dumps({"ok": True, "state": bytes_to_hex(pack(state))}), flush=True)
            elif cmd == "encode-decode-patch":
                from .patch import decode_patch, encode_patch
                patch_bytes = hex_to_bytes(req["patch"])
                patch = decode_patch(patch_bytes)
                re_encoded = encode_patch(patch)
                print(json.dumps({"ok": True, "patch": bytes_to_hex(re_encoded)}), flush=True)
            else:
                print(json.dumps({"ok": False, "error": f"unknown cmd: {cmd}"}), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    cmd = args[0]

    if cmd == "merkleize":
        if len(args) != 2:
            print("Usage: cortex_py merkleize <hex_state_bytes>", file=sys.stderr)
            sys.exit(1)
        print(_merkleize_hex(args[1]))

    elif cmd == "apply-patch":
        if len(args) != 3:
            print("Usage: cortex_py apply-patch <state_hex> <patch_hex>", file=sys.stderr)
            sys.exit(1)
        result = _apply_patch_hex(args[1], args[2])
        print(json.dumps(result))

    elif cmd == "batch-stdin":
        _batch_stdin()

    elif cmd == "verify-keccak":
        # Known Ethereum keccak256 test vectors
        empty = keccak256(b"")
        expected = "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
        got = bytes_to_hex(empty)
        status = "PASS" if got == expected else "FAIL"
        print(f"keccak256('') = {got}")
        print(f"expected      = {expected}")
        print(f"status: {status}")
        if status != "PASS":
            sys.exit(1)

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print(__doc__, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
