#!/usr/bin/env python3
"""Control for the shadow-epoch probe: is the residual_external_lift caused by the recency
signal being ABSENT from the reranker's text input (vs the reranker being incapable)?

We score the FROZEN E0 reranker on the eval triples two ways:
  (a) doc text as-is (what the production reranker sees)        -> baseline margin
  (b) doc text prefixed with "[as of <timestamp>] "             -> recency now IN the text

If (b) margin >> (a) margin, the reranker CAN exploit recency when it is present in its input,
so the substrate's value is precisely carrying that per-record recency state that the
(query, doc-text) channel lacks — the residual is irreducible-by-input, not model incapacity.
No training; E0 frozen; base checkpoint untouched.
"""
import argparse, json, math, os

MODEL_ID = "Qwen/Qwen3-Reranker-0.6B"
REVISION = "e61197ed45024b0ed8a2d74b80b4d909f1255473"


def build_prompt(query, document):
    instruction = "Given a web search query, retrieve relevant passages that answer the query"
    return (
        "<|im_start|>system\n"
        "Judge whether the Document meets the requirements based on the Query and the Instruct provided. "
        "Note that the answer can only be \"yes\" or \"no\"."
        "<|im_end|>\n"
        "<|im_start|>user\n"
        f"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {document}"
        "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--traces", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION, trust_remote_code=True)
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    yes_id, no_id = tok.convert_tokens_to_ids("yes"), tok.convert_tokens_to_ids("no")
    model = AutoModelForCausalLM.from_pretrained(
        MODEL_ID, revision=REVISION, trust_remote_code=True, torch_dtype=torch.float32).to(device).eval()

    def score(query, doc):
        enc = tok(build_prompt(query, doc), return_tensors="pt", truncation=True, max_length=2048)
        enc = {k: v.to(device) for k, v in enc.items()}
        with torch.no_grad():
            logits = model(**enc).logits
        last = int(enc["attention_mask"].sum().item()) - 1
        row = logits[0, last]
        return 1.0 / (1.0 + math.exp(-float(row[yes_id] - row[no_id])))

    ev = [t for t in json.load(open(args.traces))["triples"] if t["split"] == "eval"]

    def run(prefix_ts):
        corr, margins = 0, []
        for t in ev:
            dp = (f"[as of {t['posTimestamp']}] " + t["posText"]) if prefix_ts else t["posText"]
            dn = (f"[as of {t['negTimestamp']}] " + t["negText"]) if prefix_ts else t["negText"]
            sp, sn = score(t["query"], dp), score(t["query"], dn)
            if sp > sn:
                corr += 1
            margins.append(sp - sn)
        n = max(1, len(ev))
        return {"pairwise_acc": corr / n, "mean_margin": sum(margins) / n, "n": len(ev)}

    base = run(False)
    withts = run(True)
    out = {
        "model": MODEL_ID, "device": device, "n_eval": len(ev),
        "E0_text_only": base,
        "E0_timestamp_in_text": withts,
        "margin_gain_from_timestamp": withts["mean_margin"] - base["mean_margin"],
        "acc_gain_from_timestamp": withts["pairwise_acc"] - base["pairwise_acc"],
        "interpretation": (
            "If timestamp-in-text margin >> text-only margin, the frozen reranker CAN use recency "
            "when present in its input -> the residual_external_lift is caused by recency being "
            "absent from the (query,doc-text) channel, which is exactly the per-record state the "
            "substrate carries externally. Confirms irreducible-by-input, not model incapacity."
        ),
    }
    json.dump(out, open(args.out, "w"), indent=1)
    print(json.dumps(out, indent=1), flush=True)


if __name__ == "__main__":
    main()
