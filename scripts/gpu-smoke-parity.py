"""GPU<>CPU parity smoke for Qwen3-Reranker-0.6B.

Loads the same model on CPU and GPU, scores the same 5 query-doc pairs,
reports per-pair score difference and average wall-clock per pair.

A pass means max relative ppm < 1000 (well under the typical 250 ppm
replay tolerance budget that the bundle absorbs across hosts; here we
give 4x margin since calibration values get used as starting points,
not byte-identically replayed).
"""
import os
import time
import json
import sys
import subprocess

PROMPTS = [
    ("Show me events about Acme Corp Q1 earnings.",
     "Acme Corp announced Q1 earnings of $50M revenue, up 12% YoY."),
    ("Where did the protest happen on Tuesday?",
     "Bicycles are made of metal frames and rubber tires."),
    ("Latest news on the Mars rover?",
     "NASA's Perseverance rover sampled a new rock formation in Jezero Crater."),
    ("Tell me about quantum computing breakthroughs.",
     "Researchers at MIT demonstrated a 256-qubit logical operation with error correction."),
    ("Which restaurant did the food poisoning come from?",
     "The cricket match ended in a draw after rain stopped play."),
]
MODEL = "Qwen/Qwen3-Reranker-0.6B"
REV = "e61197ed45024b0ed8a2d74b80b4d909f1255473"
RUNNER = "/workspace/cortex/scripts/reranker_runner.py"


def make_request(pairs):
    return json.dumps({
        "model": MODEL,
        "revision": REV,
        "pairs": [{"query": q, "document": d, "prompt": None} for (q, d) in pairs]
    })


def run_runner(env_extra, label):
    env = {**os.environ, **env_extra, "RERANKER_NUM_THREADS": "16"}
    req = make_request(PROMPTS)
    t0 = time.time()
    proc = subprocess.run(
        ["python3", RUNNER],
        input=req,
        capture_output=True,
        text=True,
        env=env,
        timeout=900,
    )
    elapsed = time.time() - t0
    if proc.returncode != 0:
        print(f"{label} returncode={proc.returncode}", file=sys.stderr)
        print(f"{label} STDOUT: {proc.stdout}", file=sys.stderr)
        print(f"{label} STDERR: {proc.stderr}", file=sys.stderr)
        sys.exit(2)
    last_line = proc.stdout.strip().splitlines()[-1]
    out = json.loads(last_line)
    if "scores" not in out:
        print(f"{label}: no scores in output: {out}", file=sys.stderr)
        sys.exit(3)
    return out["scores"], elapsed, proc.stderr


print("=== loading CPU (canonical path) ===")
cpu_scores, cpu_time, _ = run_runner({}, "CPU")
print(f"CPU  scores: {[round(s, 6) for s in cpu_scores]}")
print(f"CPU  time:   {cpu_time:.2f}s total  ({cpu_time/len(PROMPTS)*1000:.0f}ms/pair, includes model load)")

print()
print("=== loading GPU (CORETEX_RERANKER_ALLOW_CUDA=1) ===")
gpu_scores, gpu_time, gpu_stderr = run_runner({"CORETEX_RERANKER_ALLOW_CUDA": "1"}, "GPU")
print(f"GPU  device-warning: {[ln for ln in gpu_stderr.splitlines() if 'warning' in ln.lower() or 'CUDA' in ln][:2]}")
print(f"GPU  scores: {[round(s, 6) for s in gpu_scores]}")
print(f"GPU  time:   {gpu_time:.2f}s total  ({gpu_time/len(PROMPTS)*1000:.0f}ms/pair, includes model load)")

print()
print("=== parity ===")
diffs = [abs(c - g) for c, g in zip(cpu_scores, gpu_scores)]
rel_ppm = [(abs(c - g) / max(abs(c), 1e-9)) * 1e6 for c, g in zip(cpu_scores, gpu_scores)]
print(f"abs diffs : {[f'{d:.6f}' for d in diffs]}")
print(f"rel ppm   : {[f'{r:.1f}' for r in rel_ppm]}")
print(f"max abs   : {max(diffs):.6f}")
print(f"max rel   : {max(rel_ppm):.1f} ppm   (replay tolerance is typically 250 ppm)")

# Pass criterion: max rel < 1000 ppm. CPU<>GPU fp32 should be well under
# this; if it isn't, something is wrong (TF32 leaked, dropout active, etc.)
PASS_PPM = 1000.0
verdict = "PASS" if max(rel_ppm) < PASS_PPM else "FAIL"
print(f"verdict   : {verdict} (threshold {PASS_PPM} ppm)")
sys.exit(0 if verdict == "PASS" else 4)
