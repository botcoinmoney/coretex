#!/usr/bin/env bash
# A100 bare-box bring-up for the CoreTex real-Qwen calibration campaign.
# Idempotent. Run detached; logs to /workspace/a100-setup.log.
set -euo pipefail
LOG=/workspace/a100-setup.log
exec > >(tee -a "$LOG") 2>&1
echo "=== a100-setup START $(date -u) ==="

MODEL_CACHE=/var/lib/coretex/model-cache
QWEN_REV=e61197ed45024b0ed8a2d74b80b4d909f1255473
BGE_REV=5617a9f61b028005a4858fdac845db406aefb181
mkdir -p "$MODEL_CACHE" /workspace/coretex

# 1. Node (official binary tarball, no apt) -----------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "--- installing node v22 ---"
  cd /tmp
  curl -fsSL https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz -o node.tar.xz
  tar -xf node.tar.xz
  cp -r node-v22.14.0-linux-x64/{bin,include,lib,share} /usr/local/
  node --version && echo "node OK"
else
  echo "--- node present: $(node --version) ---"
fi

# 2. GPU torch + transformers --------------------------------------------------
python3 - <<'PY' 2>/dev/null || NEED_TORCH=1
import importlib.util,sys
sys.exit(0 if (importlib.util.find_spec("torch") and importlib.util.find_spec("transformers")) else 1)
PY
if [ "${NEED_TORCH:-0}" = "1" ]; then
  echo "--- installing torch cu124 + pinned transformers stack ---"
  pip3 install --no-input torch==2.6.0 --index-url https://download.pytorch.org/whl/cu124
  pip3 install --no-input "transformers==4.55.0" "huggingface_hub==0.36.2" "tokenizers==0.21.4" "safetensors==0.4.5" "numpy==1.26.4" accelerate
else
  echo "--- torch/transformers present ---"
fi
python3 -c "import torch,transformers,huggingface_hub,numpy;print('torch',torch.__version__,'cuda',torch.cuda.is_available());print('transformers',transformers.__version__);print('hub',huggingface_hub.__version__);print('numpy',numpy.__version__)"

# 3. Qwen3-Reranker-0.6B (the ONLY model the GPU scorer needs; bi-encoder embeddings are precomputed)
if [ ! -d "$MODEL_CACHE/models--Qwen--Qwen3-Reranker-0.6B/snapshots/$QWEN_REV" ]; then
  echo "--- downloading Qwen3-Reranker-0.6B @ $QWEN_REV ---"
  HF_HUB_CACHE="$MODEL_CACHE" hf download Qwen/Qwen3-Reranker-0.6B --revision "$QWEN_REV" >/dev/null
else
  echo "--- Qwen model already cached ---"
fi

# 4. BGE-M3 is required by live-evolve churn to embed newly generated delta docs.
# The base corpus embeddings are synced, but live deltas are produced on-host.
if [ ! -d "$MODEL_CACHE/models--BAAI--bge-m3/snapshots/$BGE_REV" ]; then
  echo "--- downloading BGE-M3 @ $BGE_REV ---"
  HF_HUB_CACHE="$MODEL_CACHE" hf download BAAI/bge-m3 --revision "$BGE_REV" >/dev/null
else
  echo "--- BGE-M3 model already cached ---"
fi
ls "$MODEL_CACHE" | sed 's/^/  cache: /'

echo "=== a100-setup DONE $(date -u) ==="
