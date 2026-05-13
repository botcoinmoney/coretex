#!/usr/bin/env bash
# Idempotent: when host 1's coretex-corpus.service has finished its
# companies+quantum_physics run (gone inactive after clean exit), swap
# it to scrna_imputation and drop scrna_imputation from host 2's domain
# list. Maximizes both CPUs by giving each host one remaining domain.
#
# Safe to run multiple times. If host 1 is still active, exits with
# code 2. If the swap has already happened, exits with code 0.
set -euo pipefail

LOG="/var/lib/coretex/host1-swap.log"
log() { echo "[$(date -Iseconds)] $*" | tee -a "$LOG" >&2; }

############################################################
# 1. Verify host 1 finished cleanly (not still running, not
#    failed mid-flight)
############################################################
H1_STATE=$(systemctl is-active coretex-corpus 2>&1 || true)
if [ "$H1_STATE" = "active" ]; then
  log "host 1 coretex-corpus.service is still active — refusing to swap"
  exit 2
fi
if [ "$H1_STATE" = "failed" ]; then
  log "host 1 coretex-corpus.service is in FAILED state — manual intervention required"
  exit 3
fi
log "host 1 service state: $H1_STATE (expected inactive)"

############################################################
# 2. Sanity check: companies + quantum_physics fully on disk
############################################################
H1_TOTAL=$(wc -l < /var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson)
H1_COMP=$(grep -c '":"companies",' /var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson || true)
H1_QP=$(grep -c '":"quantum_physics",' /var/lib/coretex/corpus-epoch-0-launch.json.events.ndjson || true)
log "host 1 NDJSON: total=$H1_TOTAL companies=$H1_COMP quantum_physics=$H1_QP (targets 205822 + 147456 = 353278)"
if [ "$H1_COMP" -ne 205822 ] || [ "$H1_QP" -ne 147456 ]; then
  log "EXPECTED counts not met. companies=$H1_COMP/205822 quantum_physics=$H1_QP/147456 — refusing to swap"
  exit 4
fi
log "host 1 domain counts confirmed clean"

############################################################
# 3. Check if swap was already applied
############################################################
if grep -q "CORETEX_CORPUS_DOMAINS=scrna_imputation" /etc/default/coretex-corpus; then
  log "host 1 /etc/default/coretex-corpus already set for scrna_imputation — skipping rewrite"
else
  ############################################################
  # 4. Rewrite host 1's /etc/default/coretex-corpus
  ############################################################
  log "rewriting host 1 /etc/default/coretex-corpus → scrna_imputation"
  cat > /etc/default/coretex-corpus <<'EOF'
# Phase 2 of the May-2026 launch corpus run.
# Host 1 (Zen 4 7950X) finished companies + quantum_physics on 2026-05-13.
# Reassigned to scrna_imputation to parallelize the long-tail domains.
# Writes to a SEPARATE NDJSON so the merge step at finalization is clean.
CORETEX_CORPUS_DOMAINS=scrna_imputation
CORETEX_CORPUS_SEEDS_PER_DOMAIN=512
CORETEX_CORPUS_OUT=/var/lib/coretex/corpus-epoch-0-launch-scrna.json
CORETEX_CORPUS_BUNDLE=/etc/coretex/template-bundle.json
CORETEX_CORPUS_CHALLENGE_LIB=/root/botcoin-coordinator/packages/challenges
EOF
fi

############################################################
# 5. Update host 2's /etc/default/coretex-corpus to drop scrna
############################################################
H2_CURRENT=$(ssh coretex-2 'grep "^CORETEX_CORPUS_DOMAINS" /etc/default/coretex-corpus')
if echo "$H2_CURRENT" | grep -q "scrna_imputation"; then
  log "host 2 still has scrna_imputation in domain list — rewriting"
  ssh coretex-2 'sed -i "s|^CORETEX_CORPUS_DOMAINS=.*|CORETEX_CORPUS_DOMAINS=computational_biology|" /etc/default/coretex-corpus'
  ssh coretex-2 'grep "^CORETEX_CORPUS_DOMAINS" /etc/default/coretex-corpus'
  log "restarting host 2 service to pick up new env"
  ssh coretex-2 'systemctl restart coretex-corpus'
  sleep 5
  H2_STATE=$(ssh coretex-2 'systemctl is-active coretex-corpus')
  log "host 2 service state after restart: $H2_STATE"
else
  log "host 2 already scoped to computational_biology only — skipping"
fi

############################################################
# 6. Start host 1 on scrna_imputation
############################################################
log "starting host 1 coretex-corpus.service on scrna_imputation"
systemctl start coretex-corpus
sleep 5
H1_STATE=$(systemctl is-active coretex-corpus)
log "host 1 service state: $H1_STATE"

############################################################
# 7. Verify post-swap
############################################################
sleep 5
H1_PID=$(systemctl show coretex-corpus -p MainPID --value)
log "host 1 MainPID=$H1_PID"
log "swap complete"
