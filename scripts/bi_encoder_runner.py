#!/usr/bin/env python3
"""CPU-only bi-encoder subprocess runner.

Reads JSON from stdin:
    {
      "modelId":  "BAAI/bge-m3",
      "revision": "<pinned commit>",
      "mode":     "dense",
      "layout":   { "dim": 247, "quantization": "int8", "headerBytes": 9 },
      "inputs":   [ { "text": "...", "id": "..." }, ... ]
    }

Emits JSON to stdout:
    { "embeddings": [ "<hex>", ... ] }

CPU-only enforcement:
    - sets CUDA_VISIBLE_DEVICES="" before importing torch
    - sets ONNXRUNTIME_PROVIDERS="" before importing onnxruntime
    - aborts if torch.cuda.is_available() is True
    - aborts on macOS MPS detection

Quantization (matches eval/bi-encoder.ts dequantize):
    - int8: 4-byte float32 BE per-vector scale, then dim int8 codes
    - bf16: 2 bytes per scalar (BE)

Determinism:
    - torch threads pinned to BIENCODER_NUM_THREADS (default 1)
    - tokenizer truncation to MAX_SEQ_LEN (default 512)
    - normalization: L2 normalize before quantization
"""

from __future__ import annotations

import json
import os
import struct
import sys
from typing import Any, Iterable, List

# CPU-only enforcement BEFORE any ML imports.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("ONNXRUNTIME_PROVIDERS", "CPUExecutionProvider")
if os.environ.get("CORETEX_USE_GPU") == "1":
    print('{"error": "CORETEX_USE_GPU=1 not allowed"}', file=sys.stdout)
    sys.exit(2)
if os.environ.get("PYTORCH_USE_MPS") == "1":
    print('{"error": "PYTORCH_USE_MPS=1 not allowed"}', file=sys.stdout)
    sys.exit(2)


def fail(msg: str, code: int = 1) -> None:
    print(json.dumps({"error": msg}), file=sys.stdout)
    sys.exit(code)


def quantize_int8(vec: "List[float]", dim: int) -> bytes:
    if not vec:
        fail("quantize_int8: empty vector")
    abs_max = 0.0
    for v in vec:
        a = abs(v)
        if a > abs_max:
            abs_max = a
    if abs_max == 0.0:
        scale = 1.0
    else:
        scale = abs_max / 127.0
    out = bytearray()
    out += struct.pack(">f", scale)
    for i in range(dim):
        v = vec[i] if i < len(vec) else 0.0
        if scale == 0.0:
            q = 0
        else:
            q = int(round(v / scale))
        if q < -128:
            q = -128
        if q > 127:
            q = 127
        out += (q & 0xff).to_bytes(1, "big", signed=False)
    return bytes(out)


def quantize_bf16(vec: "List[float]", dim: int) -> bytes:
    out = bytearray()
    for i in range(dim):
        v = vec[i] if i < len(vec) else 0.0
        # Pack fp32 BE then take top 2 bytes (bf16 is upper half of fp32)
        packed = struct.pack(">f", v)
        out += packed[:2]
    return bytes(out)


def main() -> None:
    raw = sys.stdin.read()
    if not raw:
        fail("empty stdin")
    try:
        payload = json.loads(raw)
    except Exception as e:
        fail(f"invalid stdin JSON: {e}")

    model_id = payload["modelId"]
    revision = payload["revision"]
    mode = payload.get("mode", "dense")
    layout = payload["layout"]
    dim = int(layout["dim"])
    quantization = layout["quantization"]
    inputs = payload["inputs"]

    # Defer heavy imports until after CPU-only env enforcement.
    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
    except Exception as e:
        fail(f"missing transformers/torch: {e}")

    if torch.cuda.is_available():
        fail("torch detected CUDA; refuse to run on canonical scoring path")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        fail("torch detected MPS; refuse to run on canonical scoring path")

    num_threads = int(os.environ.get("BIENCODER_NUM_THREADS", "1"))
    torch.set_num_threads(num_threads)
    torch.set_num_interop_threads(1)

    tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision, use_fast=True)
    model = AutoModel.from_pretrained(model_id, revision=revision, torch_dtype=torch.float32)
    model.eval()

    max_seq = int(os.environ.get("BIENCODER_MAX_SEQ_LEN", "512"))
    texts = [str(x.get("text", "")) for x in inputs]

    embeddings: List[str] = []
    with torch.no_grad():
        for text in texts:
            enc = tokenizer(
                text,
                truncation=True,
                max_length=max_seq,
                padding=False,
                return_tensors="pt",
            )
            out = model(**enc)
            # Dense pooling: BGE-M3 uses [CLS] token (index 0) of last_hidden_state
            cls = out.last_hidden_state[:, 0, :].squeeze(0)
            # L2 normalize
            norm = torch.norm(cls, p=2)
            if float(norm) > 0:
                cls = cls / norm
            vec = cls.tolist()
            # Truncate to dim (BGE-M3 defaults to 1024; bundle pins to layout.dim)
            if quantization == "int8":
                qbytes = quantize_int8(vec, dim)
            elif quantization == "bf16":
                qbytes = quantize_bf16(vec, dim)
            else:
                fail(f"unknown quantization {quantization}")
            embeddings.append(qbytes.hex())

    print(json.dumps({"embeddings": embeddings}))


if __name__ == "__main__":
    main()
