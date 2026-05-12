#!/usr/bin/env bash
# Wrapper that the coretex-corpus.service unit ExecStart= invokes.
#
# Always passes --resume so the same unit handles both fresh starts and
# crash recovery without operator intervention. The generator's
# --resume path treats a missing NDJSON shadow as a fresh run.
#
# Overrides come from /etc/default/coretex-corpus (loaded by the
# .service via EnvironmentFile=). Defaults match the May 2026 launch.
set -euo pipefail

DOMAINS="${CORETEX_CORPUS_DOMAINS:-companies,quantum_physics,computational_biology,scrna_imputation}"
SEEDS="${CORETEX_CORPUS_SEEDS_PER_DOMAIN:-512}"
OUT="${CORETEX_CORPUS_OUT:-/var/lib/coretex/corpus-epoch-0-launch.json}"
BUNDLE="${CORETEX_CORPUS_BUNDLE:-/etc/coretex/template-bundle.json}"
CHALLENGE_LIB="${CORETEX_CORPUS_CHALLENGE_LIB:-/root/botcoin-coordinator/packages/challenges}"

exec node --max-old-space-size=8192 \
  /root/cortex/scripts/generate-coretex-retrieval-corpus.mjs \
  --bundle-manifest "$BUNDLE" \
  --challenge-lib-root "$CHALLENGE_LIB" \
  --source challenge-library \
  --domains "$DOMAINS" \
  --seeds-per-domain "$SEEDS" \
  --resume \
  --out "$OUT"
