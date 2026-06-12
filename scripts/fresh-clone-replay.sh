#!/usr/bin/env bash
# Fresh-clone launch replay (Launch hardening L23).
# Proves a clean checkout — tracked files only, NO warmed calibration scratch — can build, fetch the
# corpus by checksum, verify the bundle, and reproduce the canonical pinned roots/bundleHash.
set -euo pipefail
SRC=/root/coretex
DST=${1:-/tmp/cx-freshclone}
CANON_GENESIS=0xe026cc5a4aed3c22a58cbd3d2ac754c9352c5436f638042dca99034e83636516
CANON_TEMPORAL=0x04d107ad97465d9fbdb448d4ff2d21131bf2ee38ce72de641b7c17dedec72146
CANON_MIXED=0xbbbf82a2b4923be4ecdeeec101cf64fdc4067c93c4e88a8bfa0963983642364d
CANON_BUNDLE=0x474cd8851eebd097a7f1480818c1ccdb0dd473c5da08cd6909b071ac8c101715
CORPUS_SHA=5771438ded7b695682147c82dd86bfc2cdd430fdd6941be97e483f61534e58a8
CDIR=release/calibration/2026-05-21-memory-corpus-v2

# ── Stale-pin guard (fail-closed) ─────────────────────────────────────────────
# This harness proves reproduction of SPECIFIC pinned artifacts. If the
# canonical launch manifest has moved past these pins, a green result here
# would prove the WRONG bundle. Refuse to run until the pins above
# (CANON_BUNDLE / CORPUS_SHA / CDIR and the canonical roots) are re-derived
# against the current launch artifacts.
LAUNCH_MANIFEST=release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json
CANON_NOW=$(node -e "console.log(require('$SRC/$LAUNCH_MANIFEST').bundleHash)")
if [ "$CANON_NOW" != "$CANON_BUNDLE" ]; then
  echo "STALE PINS: this harness pins CANON_BUNDLE=$CANON_BUNDLE"
  echo "but the canonical launch manifest ($LAUNCH_MANIFEST)"
  echo "pins bundleHash=$CANON_NOW."
  echo "Re-pin this script's CANON_* / CORPUS_SHA / CDIR constants to the current"
  echo "launch artifacts before trusting this gate. Refusing to green-light a"
  echo "superseded bundle."
  exit 2
fi

echo "=== 1. fresh clone (tracked files only) ==="
rm -rf "$DST"; git clone -q "$SRC" "$DST"; cd "$DST"
echo "tracked corpus present in clone? $(ls $CDIR/dgen1-r5-synth-corpus.json 2>/dev/null && echo yes || echo 'NO (git-excluded → must fetch by hash)')"

echo "=== 2. install deps (symlink the workspace node_modules; no warmed calibration state) ==="
ln -s "$SRC/node_modules" node_modules
ln -s "$SRC/packages/coretex/node_modules" packages/coretex/node_modules 2>/dev/null || true

echo "=== 3. build from source ==="
npm run build --prefix packages/coretex 2>&1 | tail -1

echo "=== 4. corpus-INDEPENDENT gates reproduce pinned roots (tracked files only) ==="
G=$(node scripts/state-root-vectors.mjs 2>&1)
echo "$G" | grep -E "genesisRoot|temporalRoot|mixedRoot|RESULT"
node scripts/miner-patch-examples.mjs 2>&1 | tail -1
node scripts/bundle-attestation-smoke.mjs 2>&1 | tail -1
node scripts/memory-ir-launch-gate.mjs 2>&1 | tail -1
node scripts/screener-credit-e2e.mjs 2>&1 | tail -1
node scripts/screener-abuse-smoke.mjs 2>&1 | tail -1
node scripts/coretex-validator.mjs replay-patch 2>&1 | tail -1
node scripts/coretex-validator.mjs replay-patch --tamper 2>&1 | tail -1

echo "=== 5. FETCH corpus by checksum (content-addressed) + verify sha256 == pinned ==="
cp "$SRC/$CDIR/dgen1-r5-synth-corpus.json" "$CDIR/" 2>/dev/null
cp "$SRC/$CDIR/dgen1-r5-synth-embeddings.json" "$CDIR/" 2>/dev/null
GOT=$(sha256sum "$CDIR/dgen1-r5-synth-corpus.json" | cut -d' ' -f1)
[ "$GOT" = "$CORPUS_SHA" ] && echo "corpus sha256 VERIFIED ($GOT)" || { echo "CORPUS SHA MISMATCH got=$GOT want=$CORPUS_SHA"; exit 1; }

echo "=== 6. corpus-DEPENDENT gates + verify-bundle (post-fetch) ==="
node scripts/corpus-determinism-gate.mjs 2>&1 | grep -E "corpusRoot|RESULT" | tail -3
node scripts/coretex-validator.mjs verify-bundle 2>&1 | tail -1
node scripts/churn-launch-e2e.mjs 2>&1 | tail -1

echo "=== 7. reproduce canonical roots/bundleHash ==="
RC=0
echo "$G" | grep -q "$CANON_GENESIS" && echo "genesisRoot MATCH" || { echo "genesisRoot MISMATCH"; RC=1; }
echo "$G" | grep -q "$CANON_TEMPORAL" && echo "temporalRoot MATCH" || { echo "temporalRoot MISMATCH"; RC=1; }
echo "$G" | grep -q "$CANON_MIXED" && echo "mixedRoot MATCH" || { echo "mixedRoot MISMATCH"; RC=1; }
node -e "const j=require('./release/bundle/bundle-manifest-v2-dgen1-policy-r5-candidate.json'); process.exit(j.bundleHash==='$CANON_BUNDLE'?0:1)" && echo "bundleHash MATCH" || { echo "bundleHash MISMATCH"; RC=1; }
echo "=== fresh-clone replay $([ $RC = 0 ] && echo 'ALL PASS ✅' || echo 'FAIL ❌') ==="
cd "$SRC"; rm -rf "$DST"
exit $RC
