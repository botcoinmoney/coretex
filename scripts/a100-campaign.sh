#!/usr/bin/env bash
# CoreTex real-Qwen calibration campaign — runs ON the A100 under /workspace/cortex.
# Fail-fast (set -euo pipefail): any track failure stops the campaign IMMEDIATELY.
# By default every track is fresh — existing prior outputs are DELETED (NOT quarantined) so no
# stale artifact can be mistaken for current-bundle evidence. Pass --resume to keep outputs
# whose mtime is newer than the active bundle.
#
# Pre-flight gates (must all pass before any long GPU work):
#   1. Every referenced script + lib import exists and parses (node --check / bash -n).
#   2. Calibration bundle + profile are present and verifyBundleManifest is clean.
#   3. GPU smoke gate (a100-gpu-smoke.mjs) passes — init, variance, determinism, random-near-zero.
#
# Tracks (calibration profile enables ALL reclaimed substrates — every surface is measured):
#   2a oracle               — all-6-family no-op/random/off-family/locality safety + bounded magnitude
#                             (DIAGNOSTIC ONLY — sibling NONFINAL.md is written; oracle uses bounded
#                             reranker-score nudges, not canonical encoded states)
#   2b conflict             — conflict_lifecycle malleability (honest/random/wrong, no-op gate)
#   2c abstention           — top1 + margin sweep, false-abstention rate
#   2d temporal             — temporal yield in-context
#   2e relation_typed       — relation-typed routing / evidence-bundle reclaim
#   3  churn_c3             — CoreTex live-update churn long-horizon (canonical
#                             evolveCorpusDelta → buildCorpusDelta → applyCorpusDelta per epoch;
#                             4-arg evaluateRetrievalBenchmarkState; numeric-args stepEpoch)
#   4  screener_threshold   — CoreTex-only screener threshold calibration (NO miner/V4/wallet/chain;
#                             canonical evaluateCoreTexWorkQualification; measured noise floor)
#
# Usage:
#   bash scripts/a100-campaign.sh <100k|300k> [--profile <p>] [--bundle <b>] [--corpus <c>] [--emb <e>] [--resume]
#   setsid nohup bash scripts/a100-campaign.sh 300k > /workspace/campaign-300k/_driver.log 2>&1 < /dev/null &

set -euo pipefail

SCALE=""
PROFILE_OVERRIDE=""
BUNDLE_OVERRIDE=""
CORPUS_OVERRIDE=""
EMB_OVERRIDE=""
RESUME=0
while [ $# -gt 0 ]; do
  case "$1" in
    100k|300k) SCALE="$1"; shift ;;
    --profile) PROFILE_OVERRIDE="$2"; shift 2 ;;
    --bundle)  BUNDLE_OVERRIDE="$2";  shift 2 ;;
    --corpus)  CORPUS_OVERRIDE="$2";  shift 2 ;;
    --emb)     EMB_OVERRIDE="$2";     shift 2 ;;
    --resume)  RESUME=1; shift ;;
    *) echo "HARD FAIL: unknown arg '$1' (usage: a100-campaign.sh <100k|300k> [--profile p] [--bundle b] [--corpus c] [--emb e] [--resume])" >&2; exit 1 ;;
  esac
done
[ -z "$SCALE" ] && { echo "HARD FAIL: scale required (100k|300k)" >&2; exit 1; }

cd /workspace/cortex
CORPUS_DIR=release/calibration/2026-05-21-memory-corpus-v2
C=${CORPUS_OVERRIDE:-$CORPUS_DIR/dgen1-r5-synth-$SCALE-final-corpus.json}
E=${EMB_OVERRIDE:-$CORPUS_DIR/dgen1-r5-synth-$SCALE-final-embeddings.json}
P=${PROFILE_OVERRIDE:-release/bundle/evaluator-profile-v2-dgen1-policy-r5-$SCALE-calibration.json}
B=${BUNDLE_OVERRIDE:-release/bundle/bundle-manifest-v2-dgen1-policy-r5-$SCALE-calibration.json}
LOGD=/workspace/campaign-$SCALE
mkdir -p "$LOGD"

echo "########## CAMPAIGN $SCALE START $(date -u) ##########"
echo "profile: $P"
echo "bundle:  $B"
echo "corpus:  $C"
echo "resume:  $RESUME"

# ─────────────────────────────────────────────────────────────────────────────
# Gate 1 — every referenced script + lib import exists and parses
# ─────────────────────────────────────────────────────────────────────────────
REFERENCED_SCRIPTS=(
  scripts/a100-gpu-smoke.mjs
  scripts/smoke-live-evolve-mechanics.mjs
  scripts/smoke-screener-threshold-mechanics.mjs
  scripts/materialize-production-corpus.mjs
  scripts/probe-r5-a100-oracle.mjs
  scripts/probe-conflict-state-malleability.mjs
  scripts/probe-r5-abstention-margin.mjs
  scripts/measure-temporal-yield-incontext.mjs
  scripts/probe-r5-relation-typed-validate.mjs
  scripts/simulate-v2-live-evolve-long-horizon.mjs
  scripts/screener-threshold-calibration.mjs
  scripts/lib/stream-reranker.mjs
  scripts/lib/evolve-corpus.mjs
  scripts/lib/load-materialized-corpus.mjs
  scripts/_embed-v2.mjs
  scripts/reranker_runner.py
  packages/cortex/scripts/reranker_runner.py
  scripts/bi_encoder_runner.py
)
echo "=== gate1: script-presence + syntax checks ==="
for s in "${REFERENCED_SCRIPTS[@]}"; do
  [ -f "$s" ] || { echo "HARD FAIL: referenced script missing: $s" >&2; exit 1; }
  case "$s" in
    *.mjs) node --check "$s" 2>&1 | grep -v '^$' || true; node --check "$s" >/dev/null 2>&1 || { echo "HARD FAIL: node --check failed: $s" >&2; exit 1; } ;;
    *.py)  python3 -c "import ast,sys; ast.parse(open('$s').read())" >/dev/null 2>&1 || { echo "HARD FAIL: python parse failed: $s" >&2; exit 1; } ;;
  esac
  echo "  ok: $s"
done

[ -f "$C" ] || { echo "HARD FAIL: corpus missing: $C" >&2; exit 1; }
[ -f "$E" ] || { echo "HARD FAIL: embeddings missing: $E" >&2; exit 1; }
[ -f "$P" ] || { echo "HARD FAIL: profile missing: $P" >&2; exit 1; }
[ -f "$B" ] || { echo "HARD FAIL: bundle missing: $B" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# Gate 0 — one-shot production-corpus materialization. After this, EVERY downstream harness
# loads the corpus from the materialized artifact via canonical loadProductionCorpus — none
# re-runs the 16-minute buildV2ProductionCorpus. The materialize step is idempotent: if the
# artifact already matches (bundleHash + sourceCorpusSha256 + sourceEmbSha256), it is a cache
# hit and exits immediately.
# ─────────────────────────────────────────────────────────────────────────────
echo "=== gate0: production-corpus materialization (one-shot, idempotent) ==="
if ! node scripts/materialize-production-corpus.mjs --profile "$P" --bundle "$B" --corpus "$C" --emb "$E" > "$LOGD/gate0-materialize.log" 2>&1; then
  echo "HARD FAIL: gate0 materialization (see $LOGD/gate0-materialize.log)" >&2
  tail -25 "$LOGD/gate0-materialize.log" >&2
  exit 1
fi
tail -8 "$LOGD/gate0-materialize.log"

# ─────────────────────────────────────────────────────────────────────────────
# Gate 2 — bundle/profile coherence via parity-mode preflight (cheap, no corpus rebuild)
# ─────────────────────────────────────────────────────────────────────────────
echo "=== gate2: parity-mode preflight (bundle attestation + fingerprint roots) ==="
node scripts/launch-preflight.mjs --mode=parity \
  --profile "$P" --bundle "$B" --corpus "$C" --emb "$E" \
  --emit "$LOGD/preflight-parity.json" > "$LOGD/gate2.log" 2>&1 || {
  echo "HARD FAIL: gate2 parity preflight (see $LOGD/gate2.log)" >&2
  tail -20 "$LOGD/gate2.log" >&2
  exit 1
}
tail -3 "$LOGD/gate2.log"

# ─────────────────────────────────────────────────────────────────────────────
# Stale-quarantine pre-sweep (deterministic). Unless --resume, every existing output
# is moved aside so no track silently reuses pre-fix bytes.
# ─────────────────────────────────────────────────────────────────────────────
BUNDLE_TAG=$(node -e "const j=JSON.parse(require('fs').readFileSync('$B','utf8')); console.log((j.bundleHash||'unknown').slice(2,10))")
TRACK_OUTPUTS=(
  "$CORPUS_DIR/r5-a100-oracle-gpu-$SCALE.json"
  "$CORPUS_DIR/conflict-state-malleability-$SCALE-final.json"
  "$CORPUS_DIR/r5-abstention-margin-$SCALE.json"
  "$CORPUS_DIR/temporal-yield-$SCALE.json"
  "$CORPUS_DIR/r5-relation-typed-validate-$SCALE-3seed.json"
  "$CORPUS_DIR/churn-c3-live-evolve-$SCALE"
  "$CORPUS_DIR/churn-c3-long-horizon-$SCALE"
  "$CORPUS_DIR/screener-threshold-calibration-$SCALE.json"
)

BUNDLE_MTIME=$(stat -c %Y "$B")
if [ "$RESUME" = "0" ]; then
  echo "=== pre-run cleanup: DELETING any prior outputs (no quarantine — stale artifacts must not linger) ==="
  for out in "${TRACK_OUTPUTS[@]}"; do
    if [ -e "$out" ]; then
      rm -rfv "$out" 2>&1 | sed 's/^/  /'
    fi
  done
else
  echo "=== resume mode: deleting outputs older than bundle ($(date -u -d @$BUNDLE_MTIME)) ==="
  for out in "${TRACK_OUTPUTS[@]}"; do
    if [ -e "$out" ]; then
      m=$(stat -c %Y "$out")
      if [ "$m" -lt "$BUNDLE_MTIME" ]; then
        rm -rfv "$out" 2>&1 | sed 's/^/  /'
      else
        echo "  keep: $out (newer than bundle)"
      fi
    fi
  done
fi
# Also delete any leftover quarantine dirs from prior runs — stale artifacts must not linger in active calibration paths.
find "$CORPUS_DIR" -maxdepth 1 -type d -name '_stale_pre_*' -exec rm -rfv {} + 2>&1 | sed 's/^/  removed /'
# Delete obsolete screener-real-qwen-economics run dirs (out of scope for this phase).
find release/calibration/runs -maxdepth 1 -type d -name 'screener-real-qwen-economics-*' -exec rm -rfv {} + 2>/dev/null | sed 's/^/  removed /'

# ─────────────────────────────────────────────────────────────────────────────
# Gate 3 — mandatory GPU smoke (hard-fail on any of: init, variance, determinism, random-near-zero)
# ─────────────────────────────────────────────────────────────────────────────
export CORETEX_RERANKER_PYTHON=/usr/bin/python3
export CORETEX_BIENCODER_PYTHON=/usr/bin/python3
export CORETEX_RERANKER_ALLOW_CUDA=1
export HF_HUB_CACHE=/var/lib/coretex/model-cache
export HF_HUB_OFFLINE=1
export NODE_OPTIONS=--max-old-space-size=16384

echo "=== gate3: GPU reranker smoke (init/variance/determinism/random) ==="
node scripts/a100-gpu-smoke.mjs > "$LOGD/gate3-smoke.log" 2>&1 || {
  echo "HARD FAIL: gate3 GPU smoke (see $LOGD/gate3-smoke.log)" >&2
  tail -30 "$LOGD/gate3-smoke.log" >&2
  exit 1
}
tail -6 "$LOGD/gate3-smoke.log"

FRONTIER_WINDOW=${CHURN_FRONTIER_WINDOW:-$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); console.log(p.epochFrontier?.activeWindow ?? 0)" "$P")}
echo "frontier-window: $FRONTIER_WINDOW"

# ─────────────────────────────────────────────────────────────────────────────
# Track runner — fails fast on rc != 0.
#
# Wall-clock watchdog: each track is wrapped in `timeout` with a per-track budget so a
# wedged GPU process can't silently sink hours of A100 time. Budgets are env-tunable
# (TRACK_BUDGET_<NAME>_SEC, default TRACK_BUDGET_DEFAULT_SEC=14400 = 4h). Elapsed seconds
# are recorded for every track and re-emitted in the campaign summary so multi-hour gaps
# in the log show up as a single visible row, not as a guess from file mtimes.
# ─────────────────────────────────────────────────────────────────────────────
TRACK_BUDGET_DEFAULT_SEC=${TRACK_BUDGET_DEFAULT_SEC:-14400}
declare -A TRACK_ELAPSED_SEC=()
declare -A TRACK_BUDGET_SEC=()
track_budget() {
  local name=$1
  local upper=$(echo "$name" | tr '[:lower:]' '[:upper:]')
  local var="TRACK_BUDGET_${upper}_SEC"
  echo "${!var:-$TRACK_BUDGET_DEFAULT_SEC}"
}
run() {
  local name=$1 out=$2; shift 2
  if [ -s "$out" ]; then
    if [ "$RESUME" = "1" ]; then
      echo "=== SKIP $name (resume: $out exists newer than bundle) ==="
      return 0
    fi
    # Should not happen (quarantine cleared it), but treat as hard fail rather than silent skip.
    echo "HARD FAIL: track $name output exists pre-run and resume not set: $out" >&2
    exit 1
  fi
  local budget=$(track_budget "$name")
  TRACK_BUDGET_SEC[$name]=$budget
  local t0=$(date +%s)
  echo "=== $name START $(date -u) (budget=${budget}s) ==="
  # rc capture must use set +e to read timeout's actual exit code. `if ! cmd; then rc=$?`
  # captures the status of `!`, not cmd — 124 (timeout) and 137 (SIGKILL after --kill-after)
  # would be misclassified.
  set +e
  timeout --kill-after=30s "${budget}s" node "$@" --corpus "$C" --emb "$E" --out "$out" > "$LOGD/$name.log" 2>&1
  local rc=$?
  set -e
  local elapsed=$(($(date +%s) - t0))
  TRACK_ELAPSED_SEC[$name]=$elapsed
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      echo "HARD FAIL: track $name WALL-CLOCK BUDGET EXCEEDED (${elapsed}s > ${budget}s, rc=$rc) — wedged process killed (see $LOGD/$name.log)" >&2
    else
      echo "HARD FAIL: track $name (rc=$rc, elapsed=${elapsed}s, see $LOGD/$name.log)" >&2
    fi
    tail -20 "$LOGD/$name.log" >&2
    exit 1
  fi
  echo "=== $name DONE $(date -u) elapsed=${elapsed}s (budget=${budget}s) === ($(tail -1 "$LOGD/$name.log"))"
}

run_churn() {
  local name=$1 outdir=$2; shift 2
  if find "$outdir" -maxdepth 1 -name 'V2_LIVE_EVOLVE_LONG_HORIZON_*_qwen*.json' -size +0 2>/dev/null | grep -q .; then
    if [ "$RESUME" = "1" ]; then
      echo "=== SKIP $name (resume: $outdir has output newer than bundle) ==="
      return 0
    fi
    echo "HARD FAIL: track $name has output pre-run and resume not set: $outdir" >&2
    exit 1
  fi
  local budget=$(track_budget "$name")
  TRACK_BUDGET_SEC[$name]=$budget
  local t0=$(date +%s)
  echo "=== $name START $(date -u) (budget=${budget}s) ==="
  set +e
  timeout --kill-after=30s "${budget}s" node "$@" --corpus "$C" --emb "$E" --out "$outdir" --tag "$SCALE-c3" > "$LOGD/$name.log" 2>&1
  local rc=$?
  set -e
  local elapsed=$(($(date +%s) - t0))
  TRACK_ELAPSED_SEC[$name]=$elapsed
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      echo "HARD FAIL: track $name WALL-CLOCK BUDGET EXCEEDED (${elapsed}s > ${budget}s, rc=$rc) — wedged process killed (see $LOGD/$name.log)" >&2
    else
      echo "HARD FAIL: track $name (rc=$rc, elapsed=${elapsed}s, see $LOGD/$name.log)" >&2
    fi
    tail -20 "$LOGD/$name.log" >&2
    exit 1
  fi
  echo "=== $name DONE $(date -u) elapsed=${elapsed}s (budget=${budget}s) === ($(tail -1 "$LOGD/$name.log"))"
}

# Helper: wrap a one-shot command (smoke / threshold / etc.) in timeout + elapsed reporting,
# same idiom as run()/run_churn() but for non-track shell blocks that need watchdog coverage.
# Usage:  run_timed <name> <budget_var_name_or_default> -- <cmd ...>
# (uses the literal '--' separator to mark end of name/budget args)
run_timed() {
  local name=$1
  shift
  # accept "-- cmd..." or "cmd ..." (no -- → name uses default budget)
  if [ "${1:-}" = "--" ]; then shift; fi
  local budget=$(track_budget "$name")
  TRACK_BUDGET_SEC[$name]=$budget
  local t0=$(date +%s)
  echo "=== $name START $(date -u) (budget=${budget}s) ==="
  set +e
  timeout --kill-after=30s "${budget}s" "$@" > "$LOGD/$name.log" 2>&1
  local rc=$?
  set -e
  local elapsed=$(($(date +%s) - t0))
  TRACK_ELAPSED_SEC[$name]=$elapsed
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      echo "HARD FAIL: $name WALL-CLOCK BUDGET EXCEEDED (${elapsed}s > ${budget}s, rc=$rc) — wedged process killed (see $LOGD/$name.log)" >&2
    else
      echo "HARD FAIL: $name (rc=$rc, elapsed=${elapsed}s, see $LOGD/$name.log)" >&2
    fi
    tail -25 "$LOGD/$name.log" >&2
    exit 1
  fi
  echo "=== $name DONE $(date -u) elapsed=${elapsed}s (budget=${budget}s) === ($(tail -1 "$LOGD/$name.log"))"
}

# Track 2a — unified all-6-family oracle. NOT launch-final on its own: the oracle applies
# bounded reranker-score nudges to finalRankingFull (diagnostic), not canonical encoded
# states/patches via evaluateRetrievalBenchmarkState/Patch. A NONFINAL sibling note is
# written next to the artifact so downstream agents cannot mistake it for promotion evidence.
# Static probes that already accept --r5-profile do NOT accept --bundle today; the active bundle
# is captured in the campaign log line below + recorded by gate2 parity and gate4 metric validator.
echo "  active-bundle (recorded for static probes that do not yet accept --bundle): bundleHash=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$B','utf8')).bundleHash)") path=$B"
run oracle "$CORPUS_DIR/r5-a100-oracle-gpu-$SCALE.json" \
  scripts/probe-r5-a100-oracle.mjs --reranker gpu --seeds ${ORACLE_SEEDS:-1} --betas ${ORACLE_BETAS:-1.0} --export-traces --profile "$P" --bundle "$B"
cat > "$CORPUS_DIR/r5-a100-oracle-gpu-$SCALE.NONFINAL.md" <<EONFM
# Oracle output is DIAGNOSTIC ONLY — not launch-final.

probe-r5-a100-oracle.mjs applies bounded additive reranker-score nudges to finalRankingFull as
a fast surface-exploration tool. It does NOT exercise canonical substrate application
(evaluateRetrievalBenchmarkState / evaluateRetrievalBenchmarkPatch).

Do not use this artifact alone for promotion / final substrate claims. Final claims require:
  - churn_c3 (canonical live-evolve long-horizon) report
  - screener_threshold (canonical threshold calibration) report
  - substrate probes that hit canonical evaluators (conflict, abstention, temporal, relation_typed)
EONFM

# Track 2b — conflict_lifecycle malleability
run conflict "$CORPUS_DIR/conflict-state-malleability-$SCALE-final.json" \
  scripts/probe-conflict-state-malleability.mjs --reranker gpu --pack-size 200 --r5-profile "$P" --bundle "$B"

# Track 2c — abstention margin
run abstention "$CORPUS_DIR/r5-abstention-margin-$SCALE.json" \
  scripts/probe-r5-abstention-margin.mjs --reranker gpu --pack-size 300 --r5-profile "$P" --bundle "$B"

# Track 2d — temporal yield in-context
run temporal "$CORPUS_DIR/temporal-yield-$SCALE.json" \
  scripts/measure-temporal-yield-incontext.mjs --reranker gpu --pack-size 12 --target 60 --seeds a5,b7,c3 --profile "$P" --bundle "$B"

# Track 2e — relation-typed routing / evidence-bundle reclaim
run relation_typed "$CORPUS_DIR/r5-relation-typed-validate-$SCALE-3seed.json" \
  scripts/probe-r5-relation-typed-validate.mjs --reranker gpu --seeds ${REL_SEEDS:-1,2,3} --route-per-fam ${REL_ROUTE_PER_FAM:-18} --off-per-fam ${REL_OFF_PER_FAM:-14} --r5-profile "$P" --bundle "$B"

# Track 3 — Live-evolve long-horizon churn endurance (CANONICAL: evolveCorpusDelta →
# buildCorpusDelta → applyCorpusDelta per epoch, NOT just frontier rotation on a fixed corpus).
# Pre-track gate: CPU smoke proves the live-evolve mechanics on a small slice before any GPU time.
echo "=== churn_pre_smoke: live-evolve mechanics smoke (CPU, materialized slice — fast) ==="
run_timed churn_pre_smoke -- node scripts/smoke-live-evolve-mechanics.mjs --profile "$P" --bundle "$B" --corpus "$C" --emb "$E" --slice 2048 --epochs 3
tail -6 "$LOGD/churn_pre_smoke.log"

run_churn churn_c3 "$CORPUS_DIR/churn-c3-live-evolve-$SCALE" \
  scripts/simulate-v2-live-evolve-long-horizon.mjs --reranker gpu \
  --epochs ${CHURN_EPOCHS:-12} --churn-fraction ${CHURN_FRACTION:-0.05} \
  --honest-per-epoch ${CHURN_HONEST_PER_EPOCH:-3} \
  --pack-size ${CHURN_PACK_SIZE:-64} --clear-pack-quotas \
  --profile "$P" --bundle "$B"

# Track 4 — CoreTex-only screener threshold calibration (NO miner driver, NO V4, NO wallet, NO chain).
# Pre-track gate: tiny CPU smoke proves the canonical patch-class generators + canonical
# evaluateRetrievalBenchmarkPatch + computeCoreTexScreenerThresholdPpm wiring works end-to-end
# before any GPU spend on the full real-Qwen sweep.
echo "=== screener_pre_smoke: screener-threshold mechanics smoke (CPU, materialized slice — fast) ==="
run_timed screener_pre_smoke -- node scripts/smoke-screener-threshold-mechanics.mjs --profile "$P" --bundle "$B" --slice 256
tail -6 "$LOGD/screener_pre_smoke.log"

SCREENER_OUT="$CORPUS_DIR/screener-threshold-calibration-$SCALE.json"
run_timed screener_threshold -- node scripts/screener-threshold-calibration.mjs --reranker gpu --profile "$P" --bundle "$B" --corpus "$C" --emb "$E" --per-class ${SCREENER_PER_CLASS:-8} --pack-size ${SCREENER_PACK_SIZE:-64} --clear-pack-quotas --out "$SCREENER_OUT"

run_timed gate4_metrics -- node scripts/validate-campaign-metric-gates.mjs --corpus-dir "$CORPUS_DIR" --scale "$SCALE"
tail -20 "$LOGD/gate4_metrics.log"

echo "########## CAMPAIGN $SCALE DONE $(date -u) ##########"
# Per-track timing summary: every track's wall-clock elapsed and budget. A glance reveals
# where time actually went (vs. having to mtime-subtract log files after the fact). A 4.5h
# track stands out as a single row; a 4.5h GAP between tracks would now be impossible (each
# track is bounded by its budget and timeout-killed if it wedges).
echo "=== per-track wall-clock summary ==="
for name in "${!TRACK_ELAPSED_SEC[@]}"; do
  printf "  %-22s elapsed=%6ss  budget=%6ss\n" "$name" "${TRACK_ELAPSED_SEC[$name]}" "${TRACK_BUDGET_SEC[$name]:-?}"
done | sort
ls -la "$CORPUS_DIR"/*"$SCALE"*.json 2>/dev/null | grep -iE "oracle|conflict|abstention|temporal|relation" | grep -v _stale | sed 's/^/  artifact: /'
find "$CORPUS_DIR/churn-c3-live-evolve-$SCALE" -maxdepth 1 -name 'V2_LIVE_EVOLVE_LONG_HORIZON_*_qwen*.json' -print 2>/dev/null | sed 's/^/  artifact: /'
ls -la "$CORPUS_DIR/screener-threshold-calibration-$SCALE.json" 2>/dev/null | sed 's/^/  artifact: /'
