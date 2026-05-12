#!/usr/bin/env bash
# Catch the alive-but-stuck failure mode that Restart=on-failure
# cannot see: the systemd unit is Active=running, but the NDJSON
# shadow has stopped growing — the python subprocess deadlocked,
# the node event loop is wedged, or similar.
#
# If NDJSON mtime is older than $STUCK_THRESHOLD_SECONDS AND the
# unit is Active, SIGTERM it. systemd will Restart it per the unit
# config, and the generator will resume from the last clean tuple.
#
# Run via /root/cortex/systemd/corpus-stuck-watchdog.timer (every 5 min).
set -euo pipefail

UNIT="${UNIT:-coretex-corpus.service}"
NDJSON="${NDJSON:-/var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson}"
STUCK_THRESHOLD_SECONDS="${STUCK_THRESHOLD_SECONDS:-900}"   # 15 min
LOG="${LOG:-/var/lib/coretex/corpus-stuck-watchdog.log}"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG"; }

ACTIVE=$(systemctl is-active "$UNIT" || true)
if [ "$ACTIVE" != "active" ]; then
  log "skip: unit is $ACTIVE (not active, nothing to watchdog)"
  exit 0
fi

if [ ! -f "$NDJSON" ]; then
  log "skip: no NDJSON at $NDJSON yet (probably warming up)"
  exit 0
fi

NOW=$(date +%s)
MTIME=$(stat -c %Y "$NDJSON")
AGE=$((NOW - MTIME))

if [ "$AGE" -ge "$STUCK_THRESHOLD_SECONDS" ]; then
  log "STUCK: NDJSON age=${AGE}s exceeds threshold=${STUCK_THRESHOLD_SECONDS}s — SIGTERM $UNIT"
  systemctl kill --signal=SIGTERM "$UNIT"
  # Note: systemd will Restart=on-failure within ~15s. The generator's
  # --resume path will pick up at the next un-touched tuple.
else
  log "ok: NDJSON age=${AGE}s"
fi
