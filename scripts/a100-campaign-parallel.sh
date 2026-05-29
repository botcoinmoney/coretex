#!/usr/bin/env bash
# CoreTex static-r5 campaign — PARALLEL variant. The scorer's first-stage retrieval is
# single-threaded-JS CPU-bound and dominates wall-clock at 300k (GPU only bursts during
# rerank). The A100 box has 128 cores + a mostly-idle GPU, so running every probe
# concurrently parallelizes the CPU first-stage across cores and overlaps the GPU rerank
# bursts → wall-clock ~= slowest single probe instead of the sum. Each probe spawns its own
# reranker_runner stream (model ~1.2GB; 4 copies fit easily in 80GB). Resumable: skips a
# probe whose --out already exists. Launch detached: setsid bash scripts/a100-campaign-parallel.sh <scale> &
set -uo pipefail
SCALE=${1:?usage: a100-campaign-parallel.sh <100k|300k>}
cd /workspace/cortex
CORPUS=release/calibration/2026-05-21-memory-corpus-v2
C=$CORPUS/dgen1-r5-synth-$SCALE-final-corpus.json
E=$CORPUS/dgen1-r5-synth-$SCALE-final-embeddings.json
P=release/bundle/evaluator-profile-v2-dgen1-policy-r5-$SCALE.json
LOGD=/workspace/campaign-$SCALE; mkdir -p "$LOGD"
export CORETEX_RERANKER_PYTHON=/usr/bin/python3
export CORETEX_RERANKER_ALLOW_CUDA=1
export HF_HUB_CACHE=/var/lib/coretex/model-cache
export HF_HUB_OFFLINE=1
export NODE_OPTIONS=--max-old-space-size=16384

run() { # name out args...
  local name=$1 out=$2; shift 2
  if [ -s "$out" ]; then echo "=== SKIP $name (exists) ==="; return 0; fi
  echo "=== $name START $(date -u) ==="
  local rc=0
  node "$@" --corpus "$C" --emb "$E" --out "$out" > "$LOGD/$name.log" 2>&1 || rc=$?
  if [ "$rc" = "0" ]; then
    echo "=== $name DONE $(date -u) ($(tail -1 "$LOGD/$name.log" | cut -c1-80)) ==="
  else
    echo "=== $name FAIL rc=$rc $(date -u) ($(tail -2 "$LOGD/$name.log" | tr '\n' ' ' | cut -c1-160)) ==="
  fi
  return $rc   # propagate so `wait $p || fails++` actually catches probe failure
}

echo "########## CAMPAIGN(parallel) $SCALE START $(date -u) ##########"
pids=()
run oracle "$CORPUS/r5-a100-oracle-gpu-$SCALE.json" \
  scripts/probe-r5-a100-oracle.mjs --reranker gpu --seeds ${ORACLE_SEEDS:-1} --betas ${ORACLE_BETAS:-1.0} --export-traces --profile "$P" & pids+=($!)
run conflict "$CORPUS/conflict-state-malleability-$SCALE-final.json" \
  scripts/probe-conflict-state-malleability.mjs --reranker gpu --pack-size ${CONFLICT_PACK:-160} --r5-profile "$P" & pids+=($!)
run abstention "$CORPUS/r5-abstention-margin-$SCALE.json" \
  scripts/probe-r5-abstention-margin.mjs --reranker gpu --pack-size ${ABST_PACK:-240} --r5-profile "$P" & pids+=($!)
run temporal "$CORPUS/temporal-yield-$SCALE.json" \
  scripts/measure-temporal-yield-incontext.mjs --reranker gpu --pack-size 12 --target 60 --seeds a5,b7,c3 --profile "$P" & pids+=($!)
if [ "$SCALE" = "100k" ]; then
  run relation_typed "$CORPUS/r5-relation-typed-validate-$SCALE-3seed.json" \
    scripts/probe-r5-relation-typed-validate.mjs --reranker gpu --seeds 1,2,3 --route-per-fam 18 --off-per-fam 14 --r5-profile "$P" & pids+=($!)
fi
echo "launched ${#pids[@]} concurrent probes: ${pids[*]}"
fails=0
for p in "${pids[@]}"; do wait "$p" || fails=$((fails+1)); done
echo "########## CAMPAIGN(parallel) $SCALE DONE $(date -u) fails=$fails ##########"
