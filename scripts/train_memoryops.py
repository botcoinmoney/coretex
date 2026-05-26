#!/usr/bin/env python3
"""MemReranker-lite pointwise BCE trainer on MemoryOps examples (Phase 5 plumbing probe).

Consumes the MemoryOps JSONL (export-memoryops-training-data.mjs): {query, candidate_text, memory_ir,
label (soft 0..1), split, family, state_source}. The trainable document = the candidate rendered with the
GATED resolved Memory-IR header (lifecycle!=none → "[lifecycle=X | subject=Y] text", else raw text) —
EXACTLY the scorer's serve-time rerankerMemoryIRSource='resolved' render, so train==serve.

E0 = frozen pinned reranker. E1 = LoRA adapter on a fresh copy (base never written). BCE pointwise on the
soft label. This is a PLUMBING probe (does training run, adapter save, eval run) — NOT a tuning competition.

Usage: python3 scripts/train_memoryops.py --data <memoryops.jsonl> --out <metrics.json> --adapter-dir <dir> [--epochs 2] [--max-train N] [--smoke]
"""
import argparse, json, random

MODEL_ID = "Qwen/Qwen3-Reranker-0.6B"
REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"


def build_prompt(query, document):
    instruction = "Given a web search query, retrieve relevant passages that answer the query"
    return ("<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the "
            "Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n<|im_start|>user\n"
            f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}<|im_end|>\n"
            "<|im_start|>assistant\n<think>\n\n</think>\n\n")


def render(ex):
    """GATED resolved-IR render — identical to the scorer's mirDoc (lifecycle!=none only)."""
    ir = ex["memory_ir"]; lc = ir.get("lifecycle", "none")
    if lc == "none":
        return ex["candidate_text"]
    return f"[lifecycle={lc} | subject={ir.get('subject_scope','?')}] {ex['candidate_text']}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--adapter-dir", default="/workspace/run/scratch/e1-memoryops")
    ap.add_argument("--epochs", type=int, default=2)
    ap.add_argument("--max-train", type=int, default=4000)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--seed", type=int, default=20260526)
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()
    random.seed(args.seed)
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import LoraConfig, get_peft_model
    torch.manual_seed(args.seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[memops-train] device={dev}", flush=True)

    rows = [json.loads(l) for l in open(args.data) if l.strip()]
    train = [r for r in rows if r.get("split") == "train"]
    ev = [r for r in rows if r.get("split") == "validation"]
    if args.smoke:
        train, ev, args.epochs = train[:8], ev[:8], 1
    random.shuffle(train)
    train = train[:args.max_train]
    print(f"[memops-train] train={len(train)} eval={len(ev)} (of {len(rows)} total)", flush=True)

    tok = AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION, trust_remote_code=True)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    yes_id, no_id = tok.convert_tokens_to_ids("yes"), tok.convert_tokens_to_ids("no")

    def load():
        m = AutoModelForCausalLM.from_pretrained(MODEL_ID, revision=REVISION, trust_remote_code=True, torch_dtype=torch.float32)
        return m.to(dev).eval()

    def logit_diff(model, q, d):
        enc = tok(build_prompt(q, d), return_tensors="pt", truncation=True, max_length=2048)
        enc = {k: v.to(dev) for k, v in enc.items()}
        logits = model(**enc).logits
        last = int(enc["attention_mask"].sum().item()) - 1
        return logits[0, last][yes_id] - logits[0, last][no_id]

    # pairwise eval on held-out queries: per query, does the highest-label candidate outrank the lowest?
    def pairwise_eval(model, items):
        from collections import defaultdict
        byq = defaultdict(list)
        for r in items:
            byq[r["query"]].append(r)
        correct, n = 0, 0
        model.eval()
        with torch.no_grad():
            for q, cs in byq.items():
                if len(cs) < 2:
                    continue
                pos = max(cs, key=lambda r: r["label"]); neg = min(cs, key=lambda r: r["label"])
                if pos["label"] <= neg["label"]:
                    continue
                sp = torch.sigmoid(logit_diff(model, q, render(pos))).item()
                sn = torch.sigmoid(logit_diff(model, q, render(neg))).item()
                n += 1
                if sp > sn:
                    correct += 1
        return {"pairwise_acc": correct / max(1, n), "n": n}

    e0 = load(); e0_eval = pairwise_eval(e0, ev)
    print(f"[memops-train] E0 eval={e0_eval}", flush=True)
    base = load()
    e1 = get_peft_model(base, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.0, target_modules=["q_proj", "k_proj", "v_proj", "o_proj"], task_type="CAUSAL_LM"))
    opt = torch.optim.AdamW([p for p in e1.parameters() if p.requires_grad], lr=args.lr)
    bce = torch.nn.BCEWithLogitsLoss()
    for epoch in range(args.epochs):
        e1.train(); random.shuffle(train); tot = 0.0
        for r in train:
            opt.zero_grad()
            diff = logit_diff(e1, r["query"], render(r))
            loss = bce(diff.unsqueeze(0), torch.tensor([float(r["label"])], device=dev))
            loss.backward(); opt.step(); tot += float(loss.item())
        print(f"[memops-train] E1 epoch {epoch+1}/{args.epochs} loss={tot/max(1,len(train)):.4f}", flush=True)
    e1_eval = pairwise_eval(e1, ev)
    print(f"[memops-train] E1 eval={e1_eval}", flush=True)
    import os
    os.makedirs(args.adapter_dir, exist_ok=True)
    e1.save_pretrained(args.adapter_dir)
    metrics = {"model": MODEL_ID, "device": dev, "n_train": len(train), "n_eval_queries": e1_eval["n"],
               "E0_pairwise": e0_eval["pairwise_acc"], "E1_pairwise": e1_eval["pairwise_acc"],
               "tuning_lift_pairwise": e1_eval["pairwise_acc"] - e0_eval["pairwise_acc"], "adapter_dir": args.adapter_dir}
    json.dump(metrics, open(args.out, "w"), indent=1)
    print("[memops-train] METRICS:\n" + json.dumps(metrics, indent=1), flush=True)


if __name__ == "__main__":
    main()
