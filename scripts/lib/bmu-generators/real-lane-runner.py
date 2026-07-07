#!/usr/bin/env python3
"""BMU P2 real-embedding lane runner (G-B1/I8, SMALL-SCALE phase; CPU-only).

Consumes the input JSON emitted by real-lane-prep.mjs and produces the
real-lane results JSON merged by certify.mjs --real-lane:

  { params: {biEncoder, biEncoderRevision, reranker, rerankerRevision,
             rerankCandidates, rerankerInputTopK},
    rows: { rowId: { cosine: {docId: float}, rerank: {docId: float} } } }

Pipeline (mirrors the production stage-1/stage-2 shape on a BLANK substrate):
  1. BGE-M3 dense embeddings (sentence-transformers, normalized) — cosine of
     every bank doc against each sampled query (blank-state preRankScore).
  2. Qwen3-Reranker-0.6B logit(yes)-logit(no) sigmoid scores for the top
     `rerankCandidates` cosine candidates per query, via the CANONICAL
     packages/coretex/scripts/reranker_runner.py one-shot subprocess (same
     prompt template as production; CPU-only enforced by the runner itself).
     Skipped (cosine-only results) with --skip-rerank.

Model pins default to the production bundle pins
(packages/coretex/src/bundle/index.ts BGE_M3_DEFAULT_REVISION /
QWEN3_RERANKER_DEFAULT_REVISION).

Usage:
  python3 real-lane-runner.py --input <input.json> --out <results.json> \
      [--reranker-runner <path>] [--python <bin>] [--skip-rerank] [--threads 3]
"""
import argparse
import json
import math
import os
import subprocess
import sys

BGE_M3_MODEL = "BAAI/bge-m3"
BGE_M3_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
QWEN_MODEL = "Qwen/Qwen3-Reranker-0.6B"
QWEN_REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"
RERANKER_INPUT_TOP_K = 64  # live pin, BMU_SPEC §13.2 / §15.8


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--reranker-runner", default=None)
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--skip-rerank", action="store_true")
    ap.add_argument("--threads", type=int, default=3)
    args = ap.parse_args()

    # Cap CPU threads BEFORE torch import (shared prod host courtesy).
    for var in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(var, str(args.threads))

    with open(args.input) as f:
        spec = json.load(f)
    docs = spec["docs"]
    rows = spec["rows"]
    rerank_candidates = int(spec.get("rerankCandidates", 16))

    import torch  # noqa: E402
    torch.set_num_threads(args.threads)
    from sentence_transformers import SentenceTransformer  # noqa: E402

    model = SentenceTransformer(BGE_M3_MODEL, revision=BGE_M3_REVISION, device="cpu")
    doc_ids = [d["id"] for d in docs]
    doc_emb = model.encode([d["text"] for d in docs], normalize_embeddings=True,
                           batch_size=8, show_progress_bar=False)
    q_emb = model.encode([r["query"] for r in rows], normalize_embeddings=True,
                         batch_size=8, show_progress_bar=False)

    out_rows = {}
    pairs = []           # flattened rerank pairs across all rows
    pair_index = []      # (rowId, docId) aligned with pairs
    for qi, row in enumerate(rows):
        sims = doc_emb @ q_emb[qi]
        cosine = {doc_ids[di]: float(sims[di]) for di in range(len(doc_ids))}
        out_rows[row["id"]] = {"cosine": cosine, "rerank": None}
        if not args.skip_rerank:
            # candidate selection mirrors certify.mjs rankDocs (quantized
            # score desc, docId asc) so both sides agree on the admitted head
            ranked = sorted(cosine.items(), key=lambda kv: (-round(kv[1] / 1e-3), kv[0]))
            for doc_id, _ in ranked[:rerank_candidates]:
                pairs.append({"query": row["query"],
                              "document": next(d["text"] for d in docs if d["id"] == doc_id)})
                pair_index.append((row["id"], doc_id))

    if not args.skip_rerank:
        runner = args.reranker_runner or os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "..", "..", "..", "packages", "coretex", "scripts", "reranker_runner.py")
        req = json.dumps({"model": QWEN_MODEL, "revision": QWEN_REVISION, "pairs": pairs})
        env = dict(os.environ)
        env.setdefault("RERANKER_NUM_THREADS", str(args.threads))
        proc = subprocess.run([args.python, runner], input=req.encode(),
                              capture_output=True, env=env, timeout=7200)
        if proc.returncode != 0:
            sys.stderr.write(proc.stderr.decode()[-4000:])
            raise SystemExit(f"reranker_runner failed rc={proc.returncode}")
        scores = json.loads(proc.stdout)["scores"]
        if len(scores) != len(pair_index):
            raise SystemExit(f"score count mismatch: {len(scores)} != {len(pair_index)}")
        for (row_id, doc_id), s in zip(pair_index, scores):
            if out_rows[row_id]["rerank"] is None:
                out_rows[row_id]["rerank"] = {}
            if not (isinstance(s, float) and math.isfinite(s)):
                raise SystemExit(f"non-finite rerank score for {row_id}/{doc_id}")
            out_rows[row_id]["rerank"][doc_id] = s

    result = {
        "kind": "bmu-p2-real-lane-results",
        "family": spec.get("family"),
        "seed": spec.get("seed"),
        "sampledClusters": spec.get("sampledClusters"),
        "params": {
            "biEncoder": BGE_M3_MODEL, "biEncoderRevision": BGE_M3_REVISION,
            "reranker": None if args.skip_rerank else QWEN_MODEL,
            "rerankerRevision": None if args.skip_rerank else QWEN_REVISION,
            "rerankCandidates": rerank_candidates,
            "rerankerInputTopK": RERANKER_INPUT_TOP_K,
            "device": "cpu", "threads": args.threads,
        },
        "rows": out_rows,
    }
    with open(args.out, "w") as f:
        json.dump(result, f, indent=1)
    print(f"real-lane results: {len(out_rows)} rows -> {args.out}")


if __name__ == "__main__":
    main()
