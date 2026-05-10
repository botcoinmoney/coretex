#!/usr/bin/env python3
"""CPU-only reranker subprocess runner with one-shot and streaming modes.

Used for both:
    - production reranker (Qwen/Qwen3-Reranker-0.6B) on the inference path
    - labeling reranker (e.g. IAAR-Shanghai/MemReranker-4B) on the corpus
      generation / qrel path

Both share the same chat-template + logit(yes) - logit(no) sigmoid scoring
described in eval/reranker.ts:71-79.

Modes:

ONE-SHOT (default): reads one JSON request from stdin and emits scores on
stdout, then exits. Same wire format used by the existing per-batch spawn
caller in reranker.ts:184. Preserved for backward compatibility.

STREAM (--stream): loads the pinned model once, then reads NDJSON requests
from stdin and writes NDJSON responses to stdout until EOF. Required for
launch-scale corpus generation: a 4B reranker takes 30-60s to load on CPU,
so per-batch spawn is unusable past a few hundred pairs. Pin is supplied
via env CORETEX_RERANKER_STREAM_MODEL_ID and CORETEX_RERANKER_STREAM_REVISION.

CPU-only enforcement (both modes):
    - CUDA / MPS / ONNXRUNTIME GPU providers refused before torch import
    - aborts if torch.cuda.is_available() or MPS detected
    - torch threads pinned to RERANKER_NUM_THREADS (default = available cores)
    - tokenizer truncation to RERANKER_MAX_SEQ_LEN (default 2048)

Wire format:

ONE-SHOT request:
    { "model": "...", "revision": "...", "pairs": [
      { "query": "...", "document": "...", "prompt": "..." }, ... ] }
ONE-SHOT response:
    { "scores": [ <float in [0,1]>, ... ] }

STREAM ready signal (emitted once after model load):
    { "ready": true, "modelId": "...", "revision": "..." }
STREAM request line:
    { "id": <int>, "pairs": [ { "prompt": "..." }, ... ] }
STREAM response line:
    { "id": <int>, "scores": [ ... ] }   or   { "id": <int>, "error": "..." }
"""
from __future__ import annotations

import json
import math
import os
import sys
from typing import Any, List

# CPU-only enforcement BEFORE any ML imports.
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("ONNXRUNTIME_PROVIDERS", "CPUExecutionProvider")
if os.environ.get("CORETEX_USE_GPU") == "1":
    print(json.dumps({"error": "CORETEX_USE_GPU=1 not allowed"}), file=sys.stdout)
    sys.exit(2)
if os.environ.get("PYTORCH_USE_MPS") == "1":
    print(json.dumps({"error": "PYTORCH_USE_MPS=1 not allowed"}), file=sys.stdout)
    sys.exit(2)


def fail(msg: str, code: int = 1) -> None:
    print(json.dumps({"error": msg}), file=sys.stdout)
    sys.exit(code)


def _build_qwen3_prompt(query: str, document: str) -> str:
    return (
        "<|im_start|>system\nYou are a relevance judge.\n<|im_end|>\n"
        "<|im_start|>user\n"
        f"Query: {query}\nDocument: {document}\n"
        "Is the document relevant? Answer yes or no."
        "<|im_end|>\n"
        "<|im_start|>assistant\n"
    )


def _load_model(model_id: str, revision: str):
    try:
        import torch  # type: ignore
        from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
    except Exception as exc:
        fail(
            "missing Python dependencies for reranker: install torch and transformers; "
            + str(exc)
        )
    if torch.cuda.is_available():
        fail("torch detected CUDA; refuse to run on canonical scoring path")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        fail("torch detected MPS; refuse to run on canonical scoring path")

    num_threads = int(os.environ.get("RERANKER_NUM_THREADS", str(os.cpu_count() or 1)))
    torch.set_num_threads(num_threads)
    torch.set_num_interop_threads(1)

    tokenizer = AutoTokenizer.from_pretrained(model_id, revision=revision, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_id,
        revision=revision,
        trust_remote_code=True,
        torch_dtype=torch.float32,
    )
    model.to("cpu")
    model.eval()

    yes_ids = tokenizer.encode("yes", add_special_tokens=False)
    no_ids = tokenizer.encode("no", add_special_tokens=False)
    if not yes_ids or not no_ids:
        fail("could not resolve yes/no token ids")
    yes_id = yes_ids[-1]
    no_id = no_ids[-1]
    return torch, tokenizer, model, yes_id, no_id


def _score_pairs(torch, tokenizer, model, yes_id: int, no_id: int, prompts: "List[str]") -> "List[float]":
    """Batched padded forward pass for chat-template rerankers.

    For each prompt we read logits at the actual last non-pad position of
    that sequence (computed via attention_mask.sum() - 1). This makes the
    batched score per pair invariant to batch composition: padding tokens
    on the right don't contribute logits at the position we read, and the
    attention mask prevents non-padded tokens from attending to pads.
    """
    max_seq = int(os.environ.get("RERANKER_MAX_SEQ_LEN", "2048"))
    inner_batch = int(os.environ.get("RERANKER_INNER_BATCH", "8"))
    scores: List[float] = []
    if not prompts:
        return scores
    # Need a pad token; chat-template reranker tokenizers may not define one
    # by default. Use the EOS token for padding, which is a documented Qwen3
    # convention and does not change the right-padded last-real-token logic.
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token = tokenizer.eos_token
    with torch.no_grad():
        for start in range(0, len(prompts), inner_batch):
            chunk = prompts[start : start + inner_batch]
            encoded = tokenizer(
                chunk,
                return_tensors="pt",
                truncation=True,
                max_length=max_seq,
                padding=True,
            )
            encoded = {k: v.to("cpu") for k, v in encoded.items()}
            logits = model(**encoded).logits  # [batch, seq, vocab]
            attn = encoded["attention_mask"]
            # Last real token index per sequence: sum of mask - 1.
            last_idx = attn.sum(dim=1) - 1
            for i in range(logits.shape[0]):
                idx = int(last_idx[i].item())
                if idx < 0:
                    idx = 0
                row = logits[i, idx]
                diff = float((row[yes_id] - row[no_id]).detach().cpu())
                score = 1.0 / (1.0 + math.exp(-diff))
                if score < 0.0:
                    score = 0.0
                elif score > 1.0:
                    score = 1.0
                scores.append(score)
    return scores


def _resolve_prompts(pairs: "List[dict]") -> "List[str]":
    prompts: List[str] = []
    for pair in pairs:
        if "prompt" in pair and pair["prompt"]:
            prompts.append(str(pair["prompt"]))
        else:
            prompts.append(_build_qwen3_prompt(str(pair.get("query", "")), str(pair.get("document", ""))))
    return prompts


def _run_one_shot() -> None:
    raw = sys.stdin.read()
    if not raw:
        fail("empty stdin")
    try:
        payload = json.loads(raw)
    except Exception as e:
        fail(f"invalid stdin JSON: {e}")

    model_id = payload["model"]
    revision = payload["revision"]
    pairs = payload.get("pairs", [])
    torch, tokenizer, model, yes_id, no_id = _load_model(model_id, revision)
    prompts = _resolve_prompts(pairs)
    scores = _score_pairs(torch, tokenizer, model, yes_id, no_id, prompts)
    print(json.dumps({"scores": scores}))


def _run_stream() -> None:
    model_id = os.environ.get("CORETEX_RERANKER_STREAM_MODEL_ID")
    revision = os.environ.get("CORETEX_RERANKER_STREAM_REVISION")
    if not model_id or not revision:
        fail(
            "stream mode requires CORETEX_RERANKER_STREAM_MODEL_ID and "
            "CORETEX_RERANKER_STREAM_REVISION",
            code=2,
        )
    torch, tokenizer, model, yes_id, no_id = _load_model(model_id, revision)
    print(json.dumps({"ready": True, "modelId": model_id, "revision": revision}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            print(json.dumps({"error": f"invalid request JSON: {e}"}), flush=True)
            continue
        corr_id = req.get("id")
        try:
            pairs = req.get("pairs", [])
            prompts = _resolve_prompts(pairs)
            scores = _score_pairs(torch, tokenizer, model, yes_id, no_id, prompts)
            resp = {"scores": scores}
            if corr_id is not None:
                resp["id"] = corr_id
            print(json.dumps(resp), flush=True)
        except Exception as e:
            resp = {"error": str(e)}
            if corr_id is not None:
                resp["id"] = corr_id
            print(json.dumps(resp), flush=True)


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "--stream":
        _run_stream()
        return
    _run_one_shot()


if __name__ == "__main__":
    main()
