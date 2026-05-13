#!/usr/bin/env bash
# Cross-host corpus health check.
#
# Verifies coretex-corpus.service health on this host AND coretex-2,
# logs to /var/lib/coretex/cross-host-health.log, exits 0 always
# (anomalies are flagged in the log, not via exit code, so the timer
# never goes into a failed state from "expected variance").
#
# Run by /etc/systemd/system/cross-host-health-check.timer every 30 min.
set -uo pipefail

LOG=/var/lib/coretex/cross-host-health.log
NOW=$(date -Iseconds)
SNAP=/var/lib/coretex/.cross-host-snapshot

# Min sustained throughput considered healthy (events/sec)
MIN_RATE_PER_SEC=0.8

# Read previous snapshot for incremental delta (per-interval rate).
# Falls back to first-run defaults if no snapshot exists yet.
PREV_TS=""
PREV_HOST1=""
PREV_HOST2=""
if [ -f "$SNAP" ]; then
  # Snapshot format: <epoch>|host1=<n>|host2=<n>
  IFS='|' read -r PREV_TS PREV_HOST1_KV PREV_HOST2_KV < "$SNAP"
  PREV_HOST1="${PREV_HOST1_KV#host1=}"
  PREV_HOST2="${PREV_HOST2_KV#host2=}"
fi

log() { echo "$@" | tee -a "$LOG"; }

log ""
log "============================================"
log "[$NOW] cross-host health check"
log "============================================"

###########################
# HOST 1 (this host)
###########################
HOST1_NDJSON=/var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson
HOST1_LOG=/var/lib/coretex/corpus-epoch-0-launch.log
HOST1_FLAGS=()

HOST1_ACTIVE=$(systemctl is-active coretex-corpus 2>/dev/null || echo "unknown")
HOST1_WATCHDOG=$(systemctl is-active corpus-stuck-watchdog.timer 2>/dev/null || echo "unknown")
HOST1_EVENTS=$(wc -l < "$HOST1_NDJSON" 2>/dev/null || echo "0")
HOST1_NDJSON_MTIME=$(stat -c %Y "$HOST1_NDJSON" 2>/dev/null || echo "0")
HOST1_NDJSON_AGE=$(( $(date +%s) - HOST1_NDJSON_MTIME ))
HOST1_TAIL=$(tail -1 "$HOST1_LOG" 2>/dev/null || echo "")

[ "$HOST1_ACTIVE" != "active" ]    && HOST1_FLAGS+=("service=$HOST1_ACTIVE")
[ "$HOST1_WATCHDOG" != "active" ]  && HOST1_FLAGS+=("watchdog=$HOST1_WATCHDOG")
[ "$HOST1_NDJSON_AGE" -gt 900 ]    && HOST1_FLAGS+=("ndjson-stale=${HOST1_NDJSON_AGE}s")
HOST1_DELTA=$(( HOST1_EVENTS - ${PREV_HOST1:-$HOST1_EVENTS} ))

log "[host 1 — this box, Zen 4 7950X]"
log "  service:       $HOST1_ACTIVE"
log "  watchdog:      $HOST1_WATCHDOG"
log "  events:        $HOST1_EVENTS  (delta since last check: +$HOST1_DELTA)"
log "  ndjson age:    ${HOST1_NDJSON_AGE}s"
log "  latest:        $HOST1_TAIL"

###########################
# HOST 2 (coretex-2)
###########################
HOST2_NDJSON=/var/lib/coretex/corpus-epoch-0-launch-host2.json.events.ndjson
HOST2_LOG=/var/lib/coretex/corpus-epoch-0-launch.log
HOST2_FLAGS=()

HOST2_OUT=$(ssh -o ConnectTimeout=10 -o BatchMode=yes coretex-2 bash <<'REMOTE'
ACTIVE=$(systemctl is-active coretex-corpus 2>/dev/null)
WATCH=$(systemctl is-active corpus-stuck-watchdog.timer 2>/dev/null)
EV=$(wc -l < /var/lib/coretex/corpus-epoch-0-launch-host2.json.events.ndjson 2>/dev/null || echo 0)
MT=$(stat -c %Y /var/lib/coretex/corpus-epoch-0-launch-host2.json.events.ndjson 2>/dev/null || echo 0)
TAIL=$(tail -1 /var/lib/coretex/corpus-epoch-0-launch.log 2>/dev/null || echo "")
echo "$ACTIVE|$WATCH|$EV|$MT|$TAIL"
REMOTE
)
RC=$?

if [ $RC -ne 0 ] || [ -z "$HOST2_OUT" ]; then
  log "[host 2 — coretex-2, Zen 3 7313P]"
  log "  SSH FAILURE (rc=$RC). Skipping host 2 metrics."
  HOST2_FLAGS+=("ssh-down")
  HOST2_DELTA=0
  HOST2_EVENTS=0
else
  IFS='|' read -r HOST2_ACTIVE HOST2_WATCHDOG HOST2_EVENTS HOST2_NDJSON_MTIME HOST2_TAIL <<< "$HOST2_OUT"
  HOST2_NDJSON_AGE=$(( $(date +%s) - HOST2_NDJSON_MTIME ))
  [ "$HOST2_ACTIVE" != "active" ]    && HOST2_FLAGS+=("service=$HOST2_ACTIVE")
  [ "$HOST2_WATCHDOG" != "active" ]  && HOST2_FLAGS+=("watchdog=$HOST2_WATCHDOG")
  [ "$HOST2_NDJSON_AGE" -gt 900 ]    && HOST2_FLAGS+=("ndjson-stale=${HOST2_NDJSON_AGE}s")
  HOST2_DELTA=$(( HOST2_EVENTS - ${PREV_HOST2:-$HOST2_EVENTS} ))
  log "[host 2 — coretex-2, Zen 3 7313P]"
  log "  service:       $HOST2_ACTIVE"
  log "  watchdog:      $HOST2_WATCHDOG"
  log "  events:        $HOST2_EVENTS  (delta since last check: +$HOST2_DELTA)"
  log "  ndjson age:    ${HOST2_NDJSON_AGE}s"
  log "  latest:        $HOST2_TAIL"
fi

###########################
# Throughput sanity (events/sec over the inter-check interval)
###########################
NOW_EPOCH=$(date +%s)
if [ -n "${PREV_TS:-}" ]; then
  # PREV_TS is an ISO-8601 timestamp string from the prior snapshot.
  PREV_EPOCH=$(date -d "$PREV_TS" +%s 2>/dev/null || echo 0)
  if [ "$PREV_EPOCH" -gt 0 ]; then
    INTERVAL_SECS=$(( NOW_EPOCH - PREV_EPOCH ))
    if [ "$INTERVAL_SECS" -gt 60 ]; then
      H1_RATE=$(awk "BEGIN {printf \"%.2f\", $HOST1_DELTA / $INTERVAL_SECS}")
      H2_RATE=$(awk "BEGIN {printf \"%.2f\", $HOST2_DELTA / $INTERVAL_SECS}")
      log "  rates over last ${INTERVAL_SECS}s: host1=${H1_RATE}/s  host2=${H2_RATE}/s"
      # Only flag low throughput when we have a meaningful sample window
      # (≥10 min). Shorter intervals can be skewed by bi-encoder warmup
      # or progress-reporter quantization.
      if [ "$INTERVAL_SECS" -gt 600 ]; then
        awk "BEGIN {exit !($H1_RATE < $MIN_RATE_PER_SEC)}" && HOST1_FLAGS+=("low-throughput=${H1_RATE}/s")
        awk "BEGIN {exit !($H2_RATE < $MIN_RATE_PER_SEC)}" && HOST2_FLAGS+=("low-throughput=${H2_RATE}/s")
      fi
    fi
  fi
else
  log "  (first invocation — no prior snapshot, throughput sample on next run)"
fi

###########################
# Verdict
###########################
ALL_FLAGS=("${HOST1_FLAGS[@]}" "${HOST2_FLAGS[@]}")
if [ ${#ALL_FLAGS[@]} -eq 0 ]; then
  log "VERDICT: HEALTHY — both hosts generating cleanly"
else
  log "VERDICT: NEEDS ATTENTION — ${ALL_FLAGS[*]}"
fi

# Update snapshot so next invocation can compute incremental delta too
echo "$NOW|host1=$HOST1_EVENTS|host2=$HOST2_EVENTS" > "$SNAP"

exit 0
