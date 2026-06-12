#!/usr/bin/env bash
# THE single launch-preflight entrypoint. Proves the canonical tree is buildable and that dist is
# FRESH from the current source (rebuilds it), then runs the coherence + fingerprint gate. Hard-fails
# on ANY step (set -e). No A100 calibration/economics work may start unless this exits 0 — and for an
# A100 run, the remote fingerprint emitted there must byte-match the local one (launch-preflight.mjs
# --compare). This closes the "tests ran on stale dist" class of drift: dist is always rebuilt here
# immediately before it is fingerprinted, so the executed JS is provably build(current src).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== [1/3] typecheck (source must compile) ==="
npm run typecheck --workspace @botcoin/coretex

echo "=== [2/3] build — dist FRESH from current source ==="
npm run build --workspace @botcoin/coretex

echo "=== [3/3] coherence + launch fingerprint gate ==="
NODE_OPTIONS=--max-old-space-size=20480 node scripts/launch-preflight.mjs "$@"
