#!/usr/bin/env python3
"""MemReranker-lite trainer on FULL Memory-IR MemoryOps examples (2026-05-26 correction).

Renders the candidate document with the PROTOCOL-OWNED shared renderer (scripts/lib/memory_ir_render.py) over
the COMPLETE IR (lifecycle/role/path/conflict/scope/evidence/density) — byte-identical to the exporter's
`memory_ir_text` and the scorer's serve-time render. A hard preflight asserts render(ex)==ex["memory_ir_text"]
for a sample (the prior loop's defect — multi-field export but lifecycle-only train/serve — fails here).

Objectives (ranking-aligned, query-grouped — trains on the SAME candidate lists it will rank):
  pointwise BCE on soft labels  +  pairwise logistic (within-query ordered pairs)  +  listwise InfoNCE
  (positive vs in-query negatives). `--objective combined|bce|pairwise|listwise`.

Family-balanced train sampling (`--per-family-cap`) so temporal (already earned by substrate modulation)
does not dominate the gradient — the verdict is non-temporal/multi-family. E0 frozen, E1 LoRA (base never written).

Usage: python3 scripts/train_memoryops.py --data <memoryops.jsonl> --out <metrics.json> --adapter-dir <dir>
       [--epochs 1] [--per-family-cap 6000] [--objective combined] [--max-queries N] [--smoke]
"""
import argparse, json, os, random, sys
from collections import defaultdict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "lib"))
from memory_ir_render import render_memory_ir_doc  # the shared protocol renderer

MODEL_ID = "Qwen/Qwen3-Reranker-0.6B"
REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"


def build_prompt(query, document):
    instruction = "Given a web search query, retrieve relevant passages that answer the query"
    return ("<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the "
            "Instruct provided. Note that the answer can only be \"yes\" or \"no\".<|im_end|>\n<|im_start|>user\n"
            f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}<|im_end|>\n"
            "<|im_start|>assistant\n<think>\n\n</think>\n\n")


def render(ex):
    """FULL multi-field IR render — the shared protocol grammar (== exporter memory_ir_text == scorer)."""
    return render_memory_ir_doc(ex.get("memory_ir"), ex["candidate_text"])


def balanced_train(rows, per_family_cap, seed):
    """Per-family cap so temporal does not swamp the non-temporal MemoryOps signal."""
    rng = random.Random(seed)
    by_fam = defaultdict(list)
    for r in rows:
        by_fam[r.get("family", "?")].append(r)
    out = []
    for fam, arr in by_fam.items():
        rng.shuffle(arr)
        out.extend(arr[:per_family_cap] if per_family_cap > 0 else arr)
    rng.shuffle(out)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--adapter-dir", default="/workspace/run/scratch/e1-memoryops")
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--per-family-cap", type=int, default=6000)
    ap.add_argument("--max-queries", type=int, default=0)        # 0 = all train queries
    ap.add_argument("--max-cands-per-query", type=int, default=24)  # serve-time reranks a bounded pool, not 1000s
    ap.add_argument("--micro-batch", type=int, default=12)       # chunk the per-query forward (activation memory)
    ap.add_argument("--max-len", type=int, default=512)
    ap.add_argument("--objective", choices=["combined", "bce", "pairwise", "listwise"], default="combined")
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
    print(f"[memops-train] device={dev} objective={args.objective}", flush=True)

    rows = [json.loads(l) for l in open(args.data) if l.strip()]
    # HARD PREFLIGHT: trainer render must equal the exporter's memory_ir_text (train==export==serve).
    drift = 0
    for r in rows[:2000]:
        if "memory_ir_text" in r and render(r) != r["memory_ir_text"]:
            drift += 1
            if drift <= 3:
                print(f"[memops-train] RENDER DRIFT:\n  trainer: {render(r)!r}\n  export : {r['memory_ir_text']!r}", flush=True)
    if drift:
        print(f"[memops-train] ABORT — {drift} render-drift mismatches (trainer != exporter). Renderers are NOT byte-identical.", flush=True)
        sys.exit(3)
    print(f"[memops-train] render preflight OK (trainer==exporter on {min(2000,len(rows))} rows)", flush=True)

    train_rows = [r for r in rows if r.get("split") == "train"]
    ev = [r for r in rows if r.get("split") == "validation"]
    train_rows = balanced_train(train_rows, args.per_family_cap, args.seed)
    cap_rng = random.Random(args.seed + 7)

    def cap_group(cs):
        """Bound a query's candidate list to what the reranker ranks at serve time (top-N pool), keeping the
        positive + label diversity (so pairwise/listwise stay well-posed)."""
        if len(cs) <= args.max_cands_per_query:
            return cs
        pos = max(cs, key=lambda r: r["label"])
        rest = [r for r in cs if r is not pos]
        cap_rng.shuffle(rest)
        # prefer keeping some non-zero-label siblings + some zero negatives
        sib = [r for r in rest if r["label"] > 0][: args.max_cands_per_query // 2]
        negs = [r for r in rest if r["label"] <= 0][: args.max_cands_per_query - 1 - len(sib)]
        return [pos] + sib + negs

    # group into query candidate lists (the lists the reranker ranks), capped.
    def group(items):
        g = defaultdict(list)
        for r in items:
            g[r["query"]].append(r)
        return [cap_group(v) for v in g.values() if len(v) >= 1]
    train_groups = group(train_rows)
    if args.max_queries > 0:
        train_groups = train_groups[:args.max_queries]
    if args.smoke:
        train_groups, ev, args.epochs = train_groups[:8], ev[:40], 1
    n_train_ex = sum(len(g) for g in train_groups)
    fam_dist = defaultdict(int)
    for g in train_groups:
        for r in g:
            fam_dist[r.get("family", "?")] += 1
    print(f"[memops-train] train_groups={len(train_groups)} train_ex={n_train_ex} eval={len(ev)} fam={dict(fam_dist)}", flush=True)

    tok = AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION, trust_remote_code=True)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    yes_id, no_id = tok.convert_tokens_to_ids("yes"), tok.convert_tokens_to_ids("no")

    def load():
        m = AutoModelForCausalLM.from_pretrained(MODEL_ID, revision=REVISION, trust_remote_code=True, torch_dtype=torch.float32)
        return m.to(dev).eval()

    def logit_diffs(model, query, docs):
        """Yes-no logit diff for one query's candidate docs, micro-batched to bound activation memory.
        Returns a single tensor (graph preserved across chunks for backward)."""
        outs = []
        for i in range(0, len(docs), args.micro_batch):
            chunk = docs[i:i + args.micro_batch]
            enc = tok([build_prompt(query, d) for d in chunk], return_tensors="pt", truncation=True, max_length=args.max_len, padding=True)
            enc = {k: v.to(dev) for k, v in enc.items()}
            logits = model(**enc).logits
            last = enc["attention_mask"].sum(dim=1) - 1
            lastlog = logits.gather(1, last.view(-1, 1, 1).expand(-1, 1, logits.size(-1))).squeeze(1)
            outs.append(lastlog[:, yes_id] - lastlog[:, no_id])
        return torch.cat(outs, dim=0)

    def pairwise_eval(model, items):
        byq = defaultdict(list)
        for r in items:
            byq[r["query"]].append(r)
        per_fam_c = defaultdict(int); per_fam_n = defaultdict(int)
        correct, n = 0, 0
        model.eval()
        with torch.no_grad():
            for q, cs in byq.items():
                if len(cs) < 2:
                    continue
                pos = max(cs, key=lambda r: r["label"]); neg = min(cs, key=lambda r: r["label"])
                if pos["label"] <= neg["label"]:
                    continue
                diffs = logit_diffs(model, q, [render(pos), render(neg)])
                fam = pos.get("family", "?")
                n += 1; per_fam_n[fam] += 1
                if torch.sigmoid(diffs[0]).item() > torch.sigmoid(diffs[1]).item():
                    correct += 1; per_fam_c[fam] += 1
        by_fam = {f: round(per_fam_c[f] / max(1, per_fam_n[f]), 4) for f in per_fam_n}
        non_temp = [f for f in per_fam_n if f != "temporal_update"]
        nt_c = sum(per_fam_c[f] for f in non_temp); nt_n = sum(per_fam_n[f] for f in non_temp)
        return {"pairwise_acc": correct / max(1, n), "n": n,
                "non_temporal_pairwise_acc": round(nt_c / max(1, nt_n), 4), "non_temporal_n": nt_n, "by_family": by_fam}

    e0 = load(); e0_eval = pairwise_eval(e0, ev)
    print(f"[memops-train] E0 eval={e0_eval}", flush=True)
    del e0
    if dev == "cuda":
        torch.cuda.empty_cache()
    base = load()
    e1 = get_peft_model(base, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.0, target_modules=["q_proj", "k_proj", "v_proj", "o_proj"], task_type="CAUSAL_LM"))
    opt = torch.optim.AdamW([p for p in e1.parameters() if p.requires_grad], lr=args.lr)
    bce = torch.nn.BCEWithLogitsLoss()
    use_bce = args.objective in ("combined", "bce")
    use_pair = args.objective in ("combined", "pairwise")
    use_list = args.objective in ("combined", "listwise")
    for epoch in range(args.epochs):
        e1.train(); random.shuffle(train_groups); tot = 0.0; steps = 0
        for g in train_groups:
            docs = [render(r) for r in g]
            labels = torch.tensor([float(r["label"]) for r in g], device=dev)
            opt.zero_grad()
            diffs = logit_diffs(e1, g[0]["query"], docs)
            loss = torch.zeros((), device=dev)
            if use_bce:
                loss = loss + bce(diffs, labels)
            if use_pair and len(g) >= 2:
                # logistic on ordered pairs (label_i > label_j → diff_i should exceed diff_j)
                li = labels.unsqueeze(0); lj = labels.unsqueeze(1)
                mask = (li > lj + 1e-6)
                if mask.any():
                    di = diffs.unsqueeze(0); dj = diffs.unsqueeze(1)
                    loss = loss + torch.nn.functional.softplus(-(di - dj))[mask].mean()
            if use_list and len(g) >= 2 and labels.max() > 0:
                # InfoNCE: positive (max label) vs the whole in-query list
                tgt = int(torch.argmax(labels).item())
                loss = loss + torch.nn.functional.cross_entropy(diffs.unsqueeze(0), torch.tensor([tgt], device=dev))
            loss.backward(); opt.step(); tot += float(loss.item()); steps += 1
        print(f"[memops-train] E1 epoch {epoch+1}/{args.epochs} loss={tot/max(1,steps):.4f} ({steps} query-steps)", flush=True)
    e1_eval = pairwise_eval(e1, ev)
    print(f"[memops-train] E1 eval={e1_eval}", flush=True)
    os.makedirs(args.adapter_dir, exist_ok=True)
    e1.save_pretrained(args.adapter_dir)
    metrics = {"model": MODEL_ID, "device": dev, "objective": args.objective,
               "n_train_queries": len(train_groups), "n_train_examples": n_train_ex, "train_family_dist": dict(fam_dist),
               "n_eval_queries": e1_eval["n"],
               "E0_pairwise": e0_eval["pairwise_acc"], "E1_pairwise": e1_eval["pairwise_acc"],
               "E0_non_temporal_pairwise": e0_eval["non_temporal_pairwise_acc"], "E1_non_temporal_pairwise": e1_eval["non_temporal_pairwise_acc"],
               "tuning_lift_pairwise": e1_eval["pairwise_acc"] - e0_eval["pairwise_acc"],
               "tuning_lift_non_temporal_pairwise": e1_eval["non_temporal_pairwise_acc"] - e0_eval["non_temporal_pairwise_acc"],
               "E0_by_family": e0_eval["by_family"], "E1_by_family": e1_eval["by_family"], "adapter_dir": args.adapter_dir}
    json.dump(metrics, open(args.out, "w"), indent=1)
    print("[memops-train] METRICS:\n" + json.dumps(metrics, indent=1), flush=True)


if __name__ == "__main__":
    main()
