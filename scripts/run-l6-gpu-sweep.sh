#!/usr/bin/env bash
# Layer 6 cap sweep — A100 GPU, STANDARD runner path (operator protocol 2026-05-21).
# Pre-flight (GPU + CUDA python + tiny smoke) → provenance manifest → bounded cap sweep
# {8,16,32,64,128} OFF(stage1) vs ON(substrate-routed) via the production scorer → verify → cleanup.
set -uo pipefail
cd /workspace/cortex

# Corpus-parametric (default P0). Override: CORPUS_PATH, EMB_PATH, PACK, TAG, CAPS.
CORPUS_PATH="${CORPUS_PATH:-release/calibration/2026-05-21-memory-corpus-v2/p0-corpus.json}"
EMB_PATH="${EMB_PATH:-release/calibration/2026-05-21-memory-corpus-v2/p0-embeddings.json}"
PACK="${PACK:-24}"
TAG="${TAG:-}"
CAPS="${CAPS:-8 16 32 64 128}"
EXTRA_P05_ARGS="${EXTRA_P05_ARGS:-}"  # e.g. "--rel-mode no-query --first-stage-topk 128 --pack-seed s1"

DATEDIR="release/calibration/a100-$(date +%F)"
mkdir -p "$DATEDIR"
MAN="$DATEDIR/L6_SWEEP_MANIFEST${TAG}.json"
SMOKE="$DATEDIR/l6_smoke.json"
export HF_HUB_CACHE=/var/lib/coretex/model-cache
export HF_HUB_OFFLINE=1
export CORETEX_RERANKER=qwen3
export CORETEX_RERANKER_MODE=streaming
export CORETEX_RERANKER_PRODUCTION=1
export CORETEX_RERANKER_ALLOW_CUDA=1
export CORETEX_RERANKER_PYTHON=/usr/bin/python3
# GPU runs: leave CUDA_VISIBLE_DEVICES UNSET.
unset CUDA_VISIBLE_DEVICES || true

echo "### 1. nvidia-smi"; nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader || { echo "NO GPU"; exit 2; }
echo "### 2. CUDA python"
/usr/bin/python3 - <<'PY'
import torch
print("torch", torch.__version__)
print("cuda", torch.cuda.is_available())
print("gpu", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "NO CUDA")
PY
TORCH_VER=$(/usr/bin/python3 -c "import torch;print(torch.__version__)")
CUDA_OK=$(/usr/bin/python3 -c "import torch;print(torch.cuda.is_available())")
GPU_NAME=$(/usr/bin/python3 -c "import torch;print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NO')")
if [ "$CUDA_OK" != "True" ]; then echo "CUDA not available on /usr/bin/python3 — STOP"; exit 3; fi

echo "### 3. tiny smoke (relevant high / unrelated low)"
printf '%s' '{"model":"Qwen/Qwen3-Reranker-0.6B","revision":"e61197ed45024b0ed8a2d74b80b4d909f1255473","pairs":[{"query":"what pet does maya have","document":"Maya adopted a border collie named Pepper"},{"query":"x","document":"unrelated text about taxes"}]}' \
  | /usr/bin/python3 scripts/reranker_runner.py > "$SMOKE" 2>/dev/null
cat "$SMOKE"
python3 - "$SMOKE" <<'PY' || { echo "SMOKE FAILED — STOP"; exit 4; }
import json,sys
s=json.load(open(sys.argv[1]))["scores"]
assert s[0]>0.7 and s[1]<0.2, f"smoke scores out of range: {s}"
print("smoke OK", s)
PY

echo "### 4. provenance manifest"
GIT_SHA=$(git rev-parse HEAD)
DIST_HASH=$(sha256sum packages/cortex/dist/index.js | cut -d' ' -f1)
cat > "$MAN" <<JSON
{
  "run": "layer6-cap-sweep", "date": "$(date -u +%FT%TZ)",
  "gitSha": "$GIT_SHA", "distHash": "$DIST_HASH",
  "model": "Qwen/Qwen3-Reranker-0.6B", "revision": "e61197ed45024b0ed8a2d74b80b4d909f1255473",
  "torch": "$TORCH_VER", "cudaAvailable": "$CUDA_OK", "gpu": "$GPU_NAME",
  "biEncoder": "BAAI/bge-m3 int8/243", "corpus": "$CORPUS_PATH",
  "caps": "$CAPS", "packSize": $PACK,
  "command": "node scripts/p05-production-bridge.mjs --corpus $CORPUS_PATH --emb $EMB_PATH --pack-size $PACK --rerank-cap <C> --reranker gpu",
  "env": {"CORETEX_RERANKER":"qwen3","CORETEX_RERANKER_MODE":"streaming","CORETEX_RERANKER_PRODUCTION":"1","CORETEX_RERANKER_ALLOW_CUDA":"1","CORETEX_RERANKER_PYTHON":"/usr/bin/python3","HF_HUB_OFFLINE":"1"}
}
JSON
cat "$MAN"

echo "### 5. cap sweep"
for C in $CAPS; do
  echo "=== cap $C $(date +%H:%M:%S) ==="
  node scripts/p05-production-bridge.mjs --corpus "$CORPUS_PATH" --emb "$EMB_PATH" --pack-size "$PACK" --rerank-cap "$C" --reranker gpu $EXTRA_P05_ARGS \
     > "$DATEDIR/l6${TAG}_cap${C}.log" 2>>"$DATEDIR/l6${TAG}_sweep.err"
  if [ -f release/calibration/2026-05-21-memory-corpus-v2/P05_PRODUCTION_BRIDGE_qwen.json ]; then
    mv release/calibration/2026-05-21-memory-corpus-v2/P05_PRODUCTION_BRIDGE_qwen.json "$DATEDIR/L6${TAG}_cap${C}.json"
    python3 -c "import json;json.load(open('$DATEDIR/L6${TAG}_cap${C}.json'));print('cap $C JSON OK')" || echo "cap $C JSON UNPARSEABLE"
  else
    echo "cap $C NO OUTPUT"; tail -3 "$DATEDIR/l6${TAG}_cap${C}.log"
  fi
done

echo "### 6. cleanup"
pkill -f reranker_runner.py || true
pkill -f bi_encoder_runner.py || true
pgrep -af "reranker_runner|bi_encoder_runner" || echo "no orphan model procs"
echo "SWEEP_DONE -> $DATEDIR"
