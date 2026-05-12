#!/usr/bin/env bash
# Install the coretex-corpus.service systemd unit and its slice.
# Idempotent — safe to re-run after edits.
set -euo pipefail

REPO=/root/cortex
SYSTEMD=/etc/systemd/system

install -m 0644 "$REPO/systemd/coretex.slice"                   "$SYSTEMD/coretex.slice"
install -m 0644 "$REPO/systemd/coretex-corpus.service"          "$SYSTEMD/coretex-corpus.service"
install -m 0644 "$REPO/systemd/corpus-stuck-watchdog.service"   "$SYSTEMD/corpus-stuck-watchdog.service"
install -m 0644 "$REPO/systemd/corpus-stuck-watchdog.timer"     "$SYSTEMD/corpus-stuck-watchdog.timer"
chmod 0755 "$REPO/scripts/run-corpus-generator.sh"
chmod 0755 "$REPO/scripts/corpus-stuck-watchdog.sh"

systemctl daemon-reload
systemctl enable corpus-stuck-watchdog.timer >/dev/null 2>&1 || true
echo "installed coretex.slice + coretex-corpus.service + corpus-stuck-watchdog.{service,timer}"
echo
echo "Operator overrides (optional): /etc/default/coretex-corpus"
echo "    CORETEX_CORPUS_DOMAINS=quantum_physics"
echo "    CORETEX_CORPUS_SEEDS_PER_DOMAIN=512"
echo "    CORETEX_CORPUS_OUT=/var/lib/coretex/corpus-epoch-0-launch.json"
echo
echo "To start:    systemctl start coretex-corpus"
echo "To follow:   journalctl -u coretex-corpus -f"
echo "                 (or:  tail -f /var/lib/coretex/corpus-epoch-0-launch.log)"
echo "To stop:     systemctl stop coretex-corpus"
echo "To verify scope-immune: systemctl show coretex-corpus -p Slice"
echo "                       (must print Slice=coretex.slice — NOT user.slice)"
