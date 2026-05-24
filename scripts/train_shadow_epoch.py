#!/usr/bin/env python3
"""Reranker shadow-epoch probe: E0 (frozen launch baseline) vs E1 (LoRA candidate).

See release/calibration/2026-05-21-memory-corpus-v2/RERANKER_SHADOW_EPOCH_DESIGN.md.

Question: does a reranker tuned on the substrate's own accepted temporal traces INTERNALIZE
the temporal-currency lift (absorbed), or does the substrate still do irreducible work the
reranker weights cannot hold (residual)?

E0  = Qwen3-Reranker-0.6B (pinned rev), FROZEN — the launch reranker. Never written.
E1  = a LoRA adapter on a FRESH copy of E0, trained ONLY on the train-split (Q,D+,D-) triples
      (BCE: (Q,D+)->yes, (Q,D-)->no). Base checkpoint is never mutated; adapter -> scratch dir.

Pairwise reduction (faithful + tractable): the substrate's temporal lift IS the "prefer the
current doc over the stale doc" preference. So we measure, on HELD-OUT eval triples:
  E0_acc / E1_acc = fraction where score(Q,D+) > score(Q,D-)
  absorbed_lift          = E1_acc - E0_acc          (skill the reranker gained from text)
  residual_external_lift = 1 - E1_acc               (pairs still needing the substrate state)
  new_headroom           = (substrate+E1) - (substrate+E0); substrate forces D+>D- (admission)
                           so it saturates pairwise -> ~0: the epoch is about REPLACING the
                           substrate (absorption), not opening a new ceiling.
Score = sigmoid(logit[yes] - logit[no]) at the last real token of the Qwen3 chat template
(identical to scripts/reranker_runner.py).
"""
import argparse, json, math, os, random, sys

MODEL_ID = "Qwen/Qwen3-Reranker-0.6B"
REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"


def build_prompt(query: str, document: str) -> str:
    instruction = "Given a web search query, retrieve relevant passages that answer the query"
    return (
        "<|im_start|>system\n"
        "Judge whether the Document meets the requirements based on the Query and the Instruct provided. "
        "Note that the answer can only be \"yes\" or \"no\"."
        "<|im_end|>\n"
        "<|im_start|>user\n"
        f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}"
        "<|im_end|>\n"
        "<|im_start|>assistant\n"
        "<think>\n\n</think>\n\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--traces", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--adapter-dir", default="/workspace/run/scratch/e1-lora-adapter")
    ap.add_argument("--lora-r", type=int, default=16)
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--seed", type=int, default=20260524)
    ap.add_argument("--smoke", action="store_true", help="tiny: 4 train / 2 eval, 2 train epochs")
    args = ap.parse_args()

    random.seed(args.seed)
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import LoraConfig, get_peft_model

    torch.manual_seed(args.seed)
    use_cuda = torch.cuda.is_available()
    device = "cuda" if use_cuda else "cpu"
    print(f"[shadow] device={device} torch={torch.__version__}", flush=True)

    with open(args.traces) as f:
        data = json.load(f)
    triples = data["triples"]
    train = [t for t in triples if t["split"] == "train"]
    ev = [t for t in triples if t["split"] == "eval"]
    if args.smoke:
        train, ev = train[:4], ev[:2]
        args.epochs = 2
    print(f"[shadow] train={len(train)} eval={len(ev)} surface_entropy={data['meta'].get('surfaceEntropyBits')}", flush=True)

    tok = AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION, trust_remote_code=True)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    yes_id = tok.convert_tokens_to_ids("yes")
    no_id = tok.convert_tokens_to_ids("no")

    def load_model():
        m = AutoModelForCausalLM.from_pretrained(
            MODEL_ID, revision=REVISION, trust_remote_code=True, torch_dtype=torch.float32
        )
        return m.to(device).eval()

    def score_logit_diff(model, query, doc):
        """Return the raw (logit_yes - logit_no) tensor (keeps grad)."""
        enc = tok(build_prompt(query, doc), return_tensors="pt", truncation=True, max_length=2048)
        enc = {k: v.to(device) for k, v in enc.items()}
        logits = model(**enc).logits  # [1, seq, vocab]
        last = int(enc["attention_mask"].sum().item()) - 1
        row = logits[0, last]
        return row[yes_id] - row[no_id]

    def eval_pairwise(model, items):
        model.eval()
        correct, margins, pos_scores = 0, [], []
        with torch.no_grad():
            for t in items:
                sp = torch.sigmoid(score_logit_diff(model, t["query"], t["posText"])).item()
                sn = torch.sigmoid(score_logit_diff(model, t["query"], t["negText"])).item()
                if sp > sn:
                    correct += 1
                margins.append(sp - sn)
                pos_scores.append(sp)
        n = max(1, len(items))
        return {
            "pairwise_acc": correct / n,
            "mean_margin": sum(margins) / n,
            "mean_pos_score": sum(pos_scores) / n,
            "n": len(items),
        }

    def anti_cheat_parity(model, items):
        """E1 must not rank an UNRELATED doc (another eval triple's D+) above the true D+.
        Returns the rate of (Q_i, D+_j!=i) that beat (Q_i, D+_i) — should stay ~0."""
        if len(items) < 2:
            return {"unrelated_beats_pos_rate": 0.0, "checks": 0}
        model.eval()
        beats, checks = 0, 0
        with torch.no_grad():
            for i, t in enumerate(items):
                sp = torch.sigmoid(score_logit_diff(model, t["query"], t["posText"])).item()
                j = (i + 1) % len(items)
                su = torch.sigmoid(score_logit_diff(model, t["query"], items[j]["posText"])).item()
                checks += 1
                if su >= sp:
                    beats += 1
        return {"unrelated_beats_pos_rate": beats / max(1, checks), "checks": checks}

    # --- E0: frozen baseline ---
    e0 = load_model()
    e0_eval = eval_pairwise(e0, ev)
    e0_train = eval_pairwise(e0, train)
    e0_parity = anti_cheat_parity(e0, ev)
    print(f"[shadow] E0 eval={e0_eval}", flush=True)

    # --- E1: LoRA on a FRESH copy (base never written) ---
    base = load_model()
    lcfg = LoraConfig(
        r=args.lora_r, lora_alpha=args.lora_alpha, lora_dropout=0.0,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        task_type="CAUSAL_LM",
    )
    e1 = get_peft_model(base, lcfg)
    e1.print_trainable_parameters()
    opt = torch.optim.AdamW([p for p in e1.parameters() if p.requires_grad], lr=args.lr)
    bce = torch.nn.BCEWithLogitsLoss()

    examples = []
    for t in train:
        examples.append((t["query"], t["posText"], 1.0))
        examples.append((t["query"], t["negText"], 0.0))

    for epoch in range(args.epochs):
        e1.train()
        random.shuffle(examples)
        tot = 0.0
        for (q, d, label) in examples:
            opt.zero_grad()
            diff = score_logit_diff(e1, q, d)  # logit-diff (pre-sigmoid) -> BCEWithLogits
            loss = bce(diff.unsqueeze(0), torch.tensor([label], device=device))
            loss.backward()
            opt.step()
            tot += float(loss.item())
        print(f"[shadow] E1 train epoch {epoch+1}/{args.epochs} loss={tot/max(1,len(examples)):.4f}", flush=True)

    e1_eval = eval_pairwise(e1, ev)
    e1_train = eval_pairwise(e1, train)
    e1_parity = anti_cheat_parity(e1, ev)
    print(f"[shadow] E1 eval={e1_eval}", flush=True)

    os.makedirs(args.adapter_dir, exist_ok=True)
    e1.save_pretrained(args.adapter_dir)  # adapter ONLY; base weights untouched

    absorbed = e1_eval["pairwise_acc"] - e0_eval["pairwise_acc"]
    residual = 1.0 - e1_eval["pairwise_acc"]
    external_lift_e0 = 1.0 - e0_eval["pairwise_acc"]  # substrate fixes all D+>D- it admits
    metrics = {
        "model": MODEL_ID, "revision": REVISION, "device": device, "smoke": args.smoke,
        "n_train": len(train), "n_eval": len(ev),
        "surface_entropy_bits": data["meta"].get("surfaceEntropyBits"),
        "E0_eval": e0_eval, "E0_train": e0_train, "E0_anti_cheat": e0_parity,
        "E1_eval": e1_eval, "E1_train": e1_train, "E1_anti_cheat": e1_parity,
        "external_lift_e0": external_lift_e0,
        "absorbed_lift": absorbed,
        "residual_external_lift": residual,
        "new_headroom": 0.0,  # substrate admission saturates pairwise (D+>D-); see design doc
        "interpretation": (
            "absorbed_lift = pairwise current>stale skill E1 gained from training on accepted "
            "traces; residual_external_lift = held-out pairs E1 STILL cannot rank from text -> "
            "require the substrate's per-record temporal state. High residual => external store "
            "does irreducible work (thesis-affirming)."
        ),
    }
    with open(args.out, "w") as f:
        json.dump(metrics, f, indent=1)
    print("\n[shadow] METRICS:\n" + json.dumps(metrics, indent=1), flush=True)


if __name__ == "__main__":
    main()
