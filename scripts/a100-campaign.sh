#!/usr/bin/env bash
# CoreTex static-r5 + aspect real-Qwen campaign — runs ON the A100 under /workspace/cortex.
# One GPU reranker stream at a time; each probe logs + writes its own JSON; resumable (skips
# a track whose --out already exists). Launch detached: setsid bash scripts/a100-campaign.sh <scale> &
set -uo pipefail
SCALE=${1:?usage: a100-campaign.sh <100k|300k>}
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

run() { # name  out  args...
  local name=$1 out=$2; shift 2
  if [ -s "$out" ]; then echo "=== SKIP $name (exists: $out) ==="; return 0; fi
  echo "=== $name START $(date -u) ==="
  node "$@" --corpus "$C" --emb "$E" --out "$out" > "$LOGD/$name.log" 2>&1
  local rc=$?
  echo "=== $name DONE rc=$rc $(date -u) === ($(tail -1 "$LOGD/$name.log"))"
  return $rc
}

echo "########## CAMPAIGN $SCALE START $(date -u) ##########"

# Track 2a — unified all-6-family oracle (no-op/random/off-family/locality safety + bounded atom magnitude)
# Cost-conscious launch pass: 1 seed + launch beta 1.0. Re-run a marginal surface with more seeds if needed.
run oracle "$CORPUS/r5-a100-oracle-gpu-$SCALE.json" \
  scripts/probe-r5-a100-oracle.mjs --reranker gpu --seeds ${ORACLE_SEEDS:-1} --betas ${ORACLE_BETAS:-1.0} --export-traces --profile "$P"

# Track 2b — conflict_lifecycle malleability (honest/random/wrong-direction, no-op gate)
run conflict "$CORPUS/conflict-state-malleability-$SCALE-final.json" \
  scripts/probe-conflict-state-malleability.mjs --reranker gpu --pack-size 200 --r5-profile "$P"

# Track 2c — abstention margin (top1/margin sweep, false-abstention rate)
run abstention "$CORPUS/r5-abstention-margin-$SCALE.json" \
  scripts/probe-r5-abstention-margin.mjs --reranker gpu --pack-size 300 --r5-profile "$P"

# Track 2d — temporal yield in-context
run temporal "$CORPUS/temporal-yield-$SCALE.json" \
  scripts/measure-temporal-yield-incontext.mjs --reranker gpu --pack-size 12 --target 60 --seeds a5,b7,c3 --profile "$P"

# Track 2e — relation-typed routing (100k only per scale-truth findings; n is small at 300k)
if [ "$SCALE" = "100k" ]; then
  run relation_typed "$CORPUS/r5-relation-typed-validate-$SCALE-3seed.json" \
    scripts/probe-r5-relation-typed-validate.mjs --reranker gpu --seeds 1,2,3 --route-per-fam 18 --off-per-fam 14 --r5-profile "$P"
fi

echo "########## CAMPAIGN $SCALE DONE $(date -u) ##########"
ls -la "$CORPUS"/*"$SCALE"*.json | grep -iE "oracle|conflict|abstention|temporal|relation" | sed 's/^/  artifact: /'
