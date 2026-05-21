#!/usr/bin/env bash
# P2 (100k) A100 GPU batch — calibrated profile, multi-seed. Confirms relation/temporal routing +
# compute-reduction hold at 100k scale under the P1.5 calibrated config.
# Calibrated: rel-mode no-query, firstStageTopK 128, categoryLensExpansionBudget 12, categoryLensBonusWeight 10.
set -uo pipefail
cd /workspace/cortex
D="release/calibration/a100-$(date +%F)"
mkdir -p "$D"
CORPUS=release/calibration/2026-05-21-memory-corpus-v2/p2-corpus.json
EMB=release/calibration/2026-05-21-memory-corpus-v2/p2-embeddings.json
export HF_HUB_CACHE=/var/lib/coretex/model-cache HF_HUB_OFFLINE=1
export CORETEX_RERANKER=qwen3 CORETEX_RERANKER_MODE=streaming CORETEX_RERANKER_PRODUCTION=1
export CORETEX_RERANKER_ALLOW_CUDA=1 CORETEX_RERANKER_PYTHON=/usr/bin/python3
export NODE_OPTIONS=--max-old-space-size=8192  # 100k corpus build needs >2GB heap
unset CUDA_VISIBLE_DEVICES || true

echo "### preflight"; nvidia-smi --query-gpu=name --format=csv,noheader || exit 2
/usr/bin/python3 -c "import torch;assert torch.cuda.is_available();print('cuda',torch.cuda.get_device_name(0))" || exit 3
printf '%s' '{"model":"Qwen/Qwen3-Reranker-0.6B","revision":"e61197ed45024b0ed8a2d74b80b4d909f1255473","pairs":[{"query":"what pet does maya have","document":"Maya adopted a border collie named Pepper"},{"query":"x","document":"unrelated text about taxes"}]}' \
  | /usr/bin/python3 scripts/reranker_runner.py 2>/dev/null | python3 -c "import json,sys;s=json.load(sys.stdin)['scores'];assert s[0]>0.7 and s[1]<0.2,s;print('smoke ok',s)" || { echo SMOKE_FAIL; exit 4; }

GIT=$(git rev-parse HEAD); DIST=$(sha256sum packages/cortex/dist/index.js | cut -d' ' -f1)
echo "{\"run\":\"p2-100k-calibrated-multiseed\",\"git\":\"$GIT\",\"dist\":\"$DIST\",\"profile\":\"no-query+fst128+budget12+bonus10\",\"seeds\":[\"s1\",\"s2\",\"s3\"],\"caps\":[16,32,64],\"pack\":24}" > "$D/P2_MANIFEST.json"

echo "### P2 calibrated multi-seed cap sweep"
for S in s1 s2 s3; do
  for C in 16 32 64; do
    echo "=== seed $S cap $C $(date +%H:%M:%S) ==="
    node scripts/p05-production-bridge.mjs --corpus "$CORPUS" --emb "$EMB" --pack-size 24 --rerank-cap "$C" \
      --reranker gpu --rel-mode no-query --first-stage-topk 128 --cat-budget 12 --lens-bonus-weight 10 --pack-seed "$S" \
      > "$D/p2_${S}_cap${C}.log" 2>>"$D/p2_sweep.err"
    if [ -f release/calibration/2026-05-21-memory-corpus-v2/P05_PRODUCTION_BRIDGE_qwen_no-query.json ]; then
      mv release/calibration/2026-05-21-memory-corpus-v2/P05_PRODUCTION_BRIDGE_qwen_no-query.json "$D/P2_${S}_cap${C}.json"
      python3 -c "import json;json.load(open('$D/P2_${S}_cap${C}.json'));print('seed $S cap $C OK')" || echo "seed $S cap $C UNPARSEABLE"
    else echo "seed $S cap $C NO OUTPUT"; tail -3 "$D/p2_${S}_cap${C}.log"; fi
  done
done

echo "### Layer-8 bonus calibration under Qwen: find bonus that routes (hit up) WITHOUT flooding (lensJunk low). cap-64, seed s1"
for W in 1 2 5 10; do
  node scripts/p05-production-bridge.mjs --corpus "$CORPUS" --emb "$EMB" --pack-size 24 --rerank-cap 64 \
    --reranker gpu --rel-mode no-query --first-stage-topk 128 --cat-budget 12 --lens-bonus-weight "$W" --pack-seed s1 \
    > "$D/p2_bonus${W}.log" 2>>"$D/p2_sweep.err"
  mv release/calibration/2026-05-21-memory-corpus-v2/P05_PRODUCTION_BRIDGE_qwen_no-query.json "$D/P2_BONUS${W}.json" 2>/dev/null \
    && python3 -c "import json;r=json.load(open('$D/P2_BONUS${W}.json'))['relation'];print('bonus=$W relHit',round(r['on']['categoryLensRelationHit10'],3),'nDCG',round(r['on']['nDCG10'],3),'recall',round(r['on']['recall10'],3),'lensJunkTop10',r['flood']['on']['meanLensJunkInTop10'])" || echo "bonus=$W NO OUTPUT"
done

echo "### adversarial edge-injection robustness (Qwen): junk-edges 0 vs 5000 at cap-64 (does junk flood top-10 under the real reranker?)"
for J in 0 5000; do
  node scripts/p05-production-bridge.mjs --corpus "$CORPUS" --emb "$EMB" --pack-size 24 --rerank-cap 64 \
    --reranker gpu --rel-mode no-query --first-stage-topk 128 --cat-budget 12 --lens-bonus-weight 10 --junk-edges "$J" --pack-seed s1 \
    > "$D/p2_junk${J}.log" 2>>"$D/p2_sweep.err"
  mv release/calibration/2026-05-21-memory-corpus-v2/P05_PRODUCTION_BRIDGE_qwen_no-query.json "$D/P2_JUNK${J}.json" 2>/dev/null \
    && python3 -c "import json;r=json.load(open('$D/P2_JUNK${J}.json'))['relation'];print('junk=$J relHit',round(r['on']['categoryLensRelationHit10'],3),'flood',r['flood']['on'])" || echo "junk=$J NO OUTPUT"
done

echo "### abstention separability at 100k (Qwen)"
node scripts/p05-production-bridge.mjs --corpus "$CORPUS" --emb "$EMB" --pack-size 80 --rerank-cap 64 \
  --reranker gpu --abstention --pack-seed s1 > "$D/p2_abstention.log" 2>>"$D/p2_sweep.err"
mv release/calibration/2026-05-21-memory-corpus-v2/P05_ABSTENTION_qwen.json "$D/P2_ABSTENTION.json" 2>/dev/null \
  && python3 -c "import json;d=json.load(open('$D/P2_ABSTENTION.json'));print('abstention auc',d['auc'])" || echo "abstention NO OUTPUT"

echo "### cleanup"; pkill -f reranker_runner.py || true; pgrep -af reranker_runner || echo "no orphans"
echo "P2_BATCH_DONE -> $D"
