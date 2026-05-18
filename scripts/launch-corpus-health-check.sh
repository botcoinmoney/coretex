#!/usr/bin/env bash
# Periodic health check for the in-flight launch corpus generation.
# Runs no model work; uses ~100ms total.
#
# Output is appended to /var/lib/coretex/launch-corpus-health.log so a
# tail at any wake-up shows the recent history.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CORETEX_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"

LOG=/var/lib/coretex/corpus-epoch-0-launch.log
HEALTH=/var/lib/coretex/launch-corpus-health.log
SMOKE=/var/lib/coretex/corpus-cat-v2.json

NOW=$(date -Iseconds)
echo "=== health $NOW ===" >> "$HEALTH"

# 1. Is the launch corpus generator still alive?
# Pattern tolerates optional node flags between the binary and the
# script path (e.g. --max-old-space-size=8192). Match on the launch-
# distinctive substring: the script path + --seeds-per-domain 512.
PIDS=$(pgrep -f "generate-coretex-retrieval-corpus.mjs.*--seeds-per-domain 512" || true)
if [ -z "$PIDS" ]; then
  echo "  status: CORPUS GEN NOT RUNNING — investigate" >> "$HEALTH"
  echo "  last-log:" >> "$HEALTH"
  tail -5 "$LOG" 2>/dev/null | sed 's/^/    /' >> "$HEALTH"
  exit 0
fi

# 2. Latest progress line + sustained throughput
LATEST=$(grep "^\[progress\]" "$LOG" 2>/dev/null | tail -1)
echo "  pids: $PIDS" >> "$HEALTH"
echo "  latest: $LATEST" >> "$HEALTH"

# 3. CPU usage and orphan check
echo "  procs:" >> "$HEALTH"
ps -o pid,pcpu,pmem,etime,comm -p $(pgrep -f "bi_encoder_runner|reranker_runner|generate-coretex-" | tr '\n' ' ') 2>/dev/null | tail -n +2 | sed 's/^/    /' >> "$HEALTH"

# 4. Memory state
echo "  mem(used/total MB): $(free -m | awk '/^Mem:/ {print $3"/"$2}')" >> "$HEALTH"

# 5. Smoke corpus regression — same code path, zero model work
if [ -f "$SMOKE" ]; then
  if node "$REPO_ROOT"/scripts/validate-retrieval-corpus.mjs \
      --corpus "$SMOKE" \
      --min-events 100 --min-per-family 1 --min-hard-negatives 3 \
      --out /var/lib/coretex/reports/health-smoke-validate.json >/dev/null 2>&1; then
    ERRS=$(node -e "console.log(JSON.parse(require('fs').readFileSync('/var/lib/coretex/reports/health-smoke-validate.json','utf8')).errors.length)" 2>/dev/null || echo "?")
    echo "  smoke-validate: PASS (errors=$ERRS)" >> "$HEALTH"
  else
    echo "  smoke-validate: FAIL — code path regression" >> "$HEALTH"
  fi
fi

# 6. Tail the last 20 lines of the health log so the most recent wakeup
# can see the trend at a glance
echo "$NOW: $(echo "$LATEST" | sed -E 's/^\[progress\] *//')" >> "$HEALTH"
