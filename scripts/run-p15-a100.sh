#!/usr/bin/env bash
# P1.5 A100 GPU batch (standard runner): clean-config multi-seed cap sweep + abstention separability.
# Clean config: --rel-mode no-query (leak quarantined) --first-stage-topk 128 (relation lever active).
set -uo pipefail
cd /workspace/coretex
D="release/calibration/a100-$(date +%F)"
mkdir -p "$D"
CORPUS=release/calibration/2026-05-21-memory-corpus-v2/p1-corpus.json
EMB=release/calibration/2026-05-21-memory-corpus-v2/p1-embeddings.json
export HF_HUB_CACHE=/var/lib/coretex/model-cache HF_HUB_OFFLINE=1
export CORETEX_RERANKER=qwen3 CORETEX_RERANKER_MODE=streaming CORETEX_RERANKER_PRODUCTION=1
export CORETEX_RERANKER_ALLOW_CUDA=1 CORETEX_RERANKER_PYTHON=/usr/bin/python3
unset CUDA_VISIBLE_DEVICES || true

echo "### preflight"; nvidia-smi --query-gpu=name --format=csv,noheader || exit 2
/usr/bin/python3 -c "import torch;assert torch.cuda.is_available();print('cuda',torch.cuda.get_device_name(0))" || exit 3
printf '%s' '{"model":"Qwen/Qwen3-Reranker-0.6B","revision":"e61197ed45024b0ed8a2d74b80b4d909f1255473","pairs":[{"query":"what pet does maya have","document":"Maya adopted a border collie named Pepper"},{"query":"x","document":"unrelated text about taxes"}]}' \
  | /usr/bin/python3 scripts/reranker_runner.py 2>/dev/null | python3 -c "import json,sys;s=json.load(sys.stdin)['scores'];assert s[0]>0.7 and s[1]<0.2,s;print('smoke ok',s)" || { echo SMOKE_FAIL; exit 4; }

GIT=$(git rev-parse HEAD); DIST=$(sha256sum packages/coretex/dist/index.js | cut -d' ' -f1)
echo "{\"run\":\"p1.5-clean-multiseed\",\"git\":\"$GIT\",\"dist\":\"$DIST\",\"config\":\"no-query+firstStageTopK128\",\"seeds\":[\"s1\",\"s2\",\"s3\"],\"caps\":[16,32,64,128],\"pack\":24}" > "$D/P15_MANIFEST.json"

echo "### multi-seed clean cap sweep (no-query, firstStageTopK=128)"
for S in s1 s2 s3; do
  for C in 16 32 64 128; do
    echo "=== seed $S cap $C $(date +%H:%M:%S) ==="
    node scripts/p05-production-bridge.mjs --corpus "$CORPUS" --emb "$EMB" --pack-size 24 --rerank-cap "$C" \
      --reranker gpu --rel-mode no-query --first-stage-topk 128 --cat-budget 3000 --pack-seed "$S" \
      > "$D/p15_${S}_cap${C}.log" 2>>"$D/p15_sweep.err"
    if [ -f release/calibration/2026-05-21-memory-corpus-v2/P05_PRODUCTION_BRIDGE_qwen_no-query.json ]; then
      mv release/calibration/2026-05-21-memory-corpus-v2/P05_PRODUCTION_BRIDGE_qwen_no-query.json "$D/P15_${S}_cap${C}.json"
      python3 -c "import json;json.load(open('$D/P15_${S}_cap${C}.json'));print('seed $S cap $C OK')" || echo "seed $S cap $C UNPARSEABLE"
    else echo "seed $S cap $C NO OUTPUT"; tail -3 "$D/p15_${S}_cap${C}.log"; fi
  done
done

echo "### abstention separability (Qwen, eval_hidden mixed pack)"
node scripts/p05-production-bridge.mjs --corpus "$CORPUS" --emb "$EMB" --pack-size 40 --rerank-cap 64 \
  --reranker gpu --abstention --pack-seed s1 > "$D/p15_abstention.log" 2>>"$D/p15_sweep.err"
mv release/calibration/2026-05-21-memory-corpus-v2/P05_ABSTENTION_qwen.json "$D/P15_ABSTENTION.json" 2>/dev/null \
  && python3 -c "import json;print('abstention',json.load(open('$D/P15_ABSTENTION.json'))['auc'])" || echo "abstention NO OUTPUT"

echo "### cleanup"; pkill -f reranker_runner.py || true; pgrep -af reranker_runner || echo "no orphans"
echo "P15_BATCH_DONE -> $D"
