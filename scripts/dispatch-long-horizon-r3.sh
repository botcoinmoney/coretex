#!/bin/bash
# Dispatch the long-horizon simulation against the pinned v3-r3 bundle.
# Designed to be run on a freshly-rented A100-SXM4 80GB after the setup
# steps (corpus rsync, dist sync, HF models cached) are done.
#
# Per launch-plan acceptance gate 4.2: this is the LAUNCH-GATING run.
# PASS criteria documented in CORETEX_LAUNCH_PLAN_v2.md §"Acceptance".
set -euo pipefail

cd /workspace/cortex

# Verify pinned bundle is what we think it is
EXPECTED_HASH="0x6c5fa34e3a0c25d3d407de4d44d04531028fa275cc045a2d4a0cade30046cfb5"
ACTUAL_HASH=$(python3 -c "import json; print(json.load(open('/workspace/cortex/release/bundle/bundle-manifest-launch-v3.json'))['bundleHash'])")
if [ "$ACTUAL_HASH" != "$EXPECTED_HASH" ]; then
  echo "FATAL: bundle hash mismatch. expected=$EXPECTED_HASH got=$ACTUAL_HASH"
  echo "Likely the bundle wasn't rsynced from the latest commit. Pull from git first."
  exit 2
fi
echo "[long-horizon] bundleHash verified: $EXPECTED_HASH"
echo "[long-horizon] starting at $(date -Iseconds)"

mkdir -p /workspace/cortex/release/calibration/a100-2026-05-16/long-horizon

# Production-faithful scope per user direction:
# - packSize=128 inherited from profile.hiddenPack (deriveQueryPack uses it)
# - 60 epochs (4 corpus-growth fractions × 15 epochs each)
# - 10 probes/epoch (statistical power for FA rate; balances cost vs confidence)
# - samples=1 (baseline already pinned; no need to multi-sample per epoch)
#
# Estimated compute: 60 epochs × (1 baseline + 10 probes) × packSize=128 × cap=128
#   = 60 × 11 × 16384 = 10.8M reranker pairs
#   @ ~64 pair/sec on A100-SXM = ~47 hours
# At the projected $1.088/hr that's ~$51 — higher than initial estimate.
# If we need to ship faster, drop --probe-random-patches-per-epoch to 5 → ~28 hr.

CORETEX_RERANKER=qwen3 \
CORETEX_RERANKER_PRODUCTION=1 \
CORETEX_RERANKER_MODE=streaming \
CORETEX_RERANKER_ALLOW_CUDA=1 \
RERANKER_NUM_THREADS=16 \
CORETEX_RERANKER_BATCH_SIZE=64 \
RERANKER_INNER_BATCH=64 \
CORETEX_BIENCODER=pinned \
HF_HOME=/root/.cache/huggingface \
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
nohup stdbuf -oL -eL node --max-old-space-size=20480 scripts/simulate-long-horizon-difficulty.mjs \
  --bundle-manifest /workspace/cortex/release/bundle/bundle-manifest-launch-v3.json \
  --corpus /workspace/corpus-epoch-0-launch-MERGED.json \
  --epochs 60 \
  --target-advances 5 \
  --scenario burst100 \
  --active-eval-hidden-fractions 0.25,0.5,0.75,1.0 \
  --epochs-per-fraction 15 \
  --probe-random-patches-per-epoch 10 \
  --baseline-samples 1 \
  --seed "coretex-horizon-v3-r3-launch" \
  --out /workspace/cortex/release/calibration/a100-2026-05-16/long-horizon/long-horizon-r3.json \
  > /workspace/cortex/release/calibration/a100-2026-05-16/long-horizon/long-horizon-r3.log 2>&1 &

echo "[long-horizon] spawned PID=$!"
echo "[long-horizon] tail the log with:"
echo "  tail -f /workspace/cortex/release/calibration/a100-2026-05-16/long-horizon/long-horizon-r3.log"
echo "[long-horizon] result will be at:"
echo "  /workspace/cortex/release/calibration/a100-2026-05-16/long-horizon/long-horizon-r3.json"
