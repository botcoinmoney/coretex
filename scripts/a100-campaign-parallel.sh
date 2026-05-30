#!/usr/bin/env bash
# DISABLED — not authoritative for final CoreTex calibration.
#
# This parallel campaign driver predates the calibration-discipline rewrite of
# scripts/a100-campaign.sh and carries:
#   - old churn path (simulate-v2-long-horizon.mjs on a FIXED corpus, not the canonical
#     evolveCorpusDelta → buildCorpusDelta → applyCorpusDelta live-update chain);
#   - old screener-real-qwen-economics wiring (out of scope this phase — miner / V4 / wallet
#     are integration-test concerns, not CoreTex calibration);
#   - skip-on-exists default that masks stale-artifact contamination;
#   - no pre-run script-existence checks, no GPU smoke gate, no parity preflight.
#
# Use scripts/a100-campaign.sh instead. If you need a parallel variant, refactor that
# canonical driver — do not resurrect this one without rewriting every gate.
echo "HARD FAIL: a100-campaign-parallel.sh is DISABLED (not authoritative for final CoreTex calibration)." >&2
echo "Use scripts/a100-campaign.sh — it is the single canonical campaign driver." >&2
exit 1
