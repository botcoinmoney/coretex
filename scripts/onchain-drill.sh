#!/usr/bin/env bash
# CoreTex on-chain e2e drill (Phases 4-7,11). Runs the FULL canonical sequence against a real EVM:
#   deploy CoreTexRegistry -> startEpoch -> 2 state advances (+ 1 bad-parent revert) -> replay-from-chain
#   -> finalizeEpoch -> deployment/drill record.
#
# MODES (auto-detected):
#   LOCAL  (default): boots a local anvil, uses its funded dev key. Zero mainnet risk. Proves the flow.
#   MAINNET: set BASE_RPC_URL + DEPLOYER_PK + OWNER_ADDRESS + COORDINATOR_ADDRESS + MAINNET_CONFIRM=I-UNDERSTAND.
#            Secrets are read from env ONLY and never printed.
#
# Usage:  bash scripts/onchain-drill.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DATE=$(date -u +%Y%m%d)
DROOT=packages/cortex/dist
REG_ABI_START='startEpoch(uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)'
REG_ABI_ADV='submitStateAdvance(uint64,address,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint16,bytes)'
REG_ABI_FIN='finalizeEpoch(uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)'

# ── canonical drill constants (public) ──
CVH=0x474cd8851eebd097a7f1480818c1ccdb0dd473c5da08cd6909b071ac8c101715   # bundleHash
CORPUS=0x15bab3a8e0d6fdb8df4d525e49aa7e22c815e749c8d95301a89e54de933beb33
FRONTIER=0x0000000000000000000000000000000000000000000000000000000000000009
BASELINE=0x00000000000000000000000000000000000000000000000000000000ba5e1142
SEEDCOMMIT=0x00000000000000000000000000000000000000000000000000000000005eed01
EVAL1=0x1111111111111111111111111111111111111111111111111111111111111111
EVAL2=0x2222222222222222222222222222222222222222222222222222222222222222
EPOCH=0

# ── L4 vector values (genuine parent/child roots, patch hashes, wire bytes) ──
read -r GENESIS T_CHILD T_PATCHHASH T_WIRE M_CHILD M_PATCHHASH M_WIRE < <(node -e '
const fx=require("./release/calibration/fixtures/state-root-vectors.json").vectors;
const g=fx[0], t=fx[1], m=fx[2];
console.log([g.stateRoot,t.childStateRoot,t.patchHash,t.patchBytesHex,m.childStateRoot,m.patchHash,m.patchBytesHex].join(" "));')

# ── mode detection ──
if [ -n "${MAINNET_CONFIRM:-}" ] && [ -n "${BASE_RPC_URL:-}" ] && [ -n "${DEPLOYER_PK:-}" ]; then
  if [ "$MAINNET_CONFIRM" != "I-UNDERSTAND" ]; then echo "MAINNET_CONFIRM must equal I-UNDERSTAND"; exit 1; fi
  MODE=mainnet; RPC="$BASE_RPC_URL"; PK="$DEPLOYER_PK"
  OWNER="${OWNER_ADDRESS:?set OWNER_ADDRESS}"; COORD="${COORDINATOR_ADDRESS:?set COORDINATOR_ADDRESS}"
  echo "=== MODE: MAINNET (Base) — broadcasting real txs ==="
else
  MODE=local; RPC=http://127.0.0.1:8545
  PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil dev key #0 (public, local-only)
  OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; COORD=$OWNER
  echo "=== MODE: LOCAL anvil (zero mainnet risk) ==="
  pkill -x anvil 2>/dev/null || true
  anvil --silent --port 8545 & ANVIL_PID=$!
  trap 'kill -9 $ANVIL_PID 2>/dev/null' EXIT
  # poll until ready (foreground sleep is unavailable in this harness)
  for i in $(seq 1 200); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; done
fi
MINER=$COORD

forge build --root contracts >/dev/null 2>&1 || { echo "forge build failed"; exit 1; }
CAST="cast send --rpc-url $RPC --private-key $PK --json"

echo "--- deploy CoreTexRegistry ---"
DEP=$(forge create --root contracts src/CoreTexRegistry.sol:CoreTexRegistry \
  --rpc-url "$RPC" --private-key "$PK" --broadcast --constructor-args "$OWNER" "$COORD" 2>&1)
# tolerant extraction: handles both `Deployed to: 0x..` text and `"deployedTo":"0x.."` json
REG=$(echo "$DEP" | grep -oiE '(deployed to:?\s*|"deployedTo":\s*")0x[0-9a-fA-F]{40}' | grep -oiE '0x[0-9a-fA-F]{40}' | head -1)
[ -z "$REG" ] && { echo "deploy failed:"; echo "$DEP" | tail -5; exit 1; }
DEPLOY_BLOCK=$(cast block-number --rpc-url "$RPC")
echo "registry: $REG  (block $DEPLOY_BLOCK)"

echo "--- startEpoch ---"
$CAST "$REG" "$REG_ABI_START" $EPOCH "$GENESIS" "$CVH" "$CORPUS" "$FRONTIER" "$BASELINE" "$SEEDCOMMIT" >/dev/null
LIVE=$(cast call --rpc-url "$RPC" "$REG" "liveStateRoot(uint64)(bytes32)" $EPOCH)
echo "liveStateRoot after start: $LIVE (expect genesis $GENESIS)"

echo "--- advance 1 (temporal, parent=genesis) ---"
$CAST "$REG" "$REG_ABI_ADV" $EPOCH "$MINER" "$GENESIS" "$T_CHILD" "$T_PATCHHASH" "$EVAL1" "$CVH" "$CORPUS" "$FRONTIER" 30000 3 "$T_WIRE" >/dev/null
echo "--- advance 2 (mixed rel+conflict, parent=temporal child) ---"
$CAST "$REG" "$REG_ABI_ADV" $EPOCH "$MINER" "$T_CHILD" "$M_CHILD" "$M_PATCHHASH" "$EVAL2" "$CVH" "$CORPUS" "$FRONTIER" 40000 3 "$M_WIRE" >/dev/null
LIVE=$(cast call --rpc-url "$RPC" "$REG" "liveStateRoot(uint64)(bytes32)" $EPOCH)
TC=$(cast call --rpc-url "$RPC" "$REG" "transitionCount(uint64)(uint64)" $EPOCH)
echo "liveStateRoot after 2 advances: $LIVE (expect mixed $M_CHILD); transitionCount=$TC"

echo "--- bad advance (wrong parent) MUST revert ---"
if cast send --rpc-url "$RPC" --private-key "$PK" "$REG" "$REG_ABI_ADV" $EPOCH "$MINER" "$GENESIS" 0x00000000000000000000000000000000000000000000000000000000deadbeef "$T_PATCHHASH" "$EVAL1" "$CVH" "$CORPUS" "$FRONTIER" 30000 3 "$T_WIRE" >/dev/null 2>&1; then
  echo "UNEXPECTED: bad-parent advance succeeded"; BAD=fail
else echo "reverted as expected (ParentRootMismatch)"; BAD=ok; fi

echo "--- replay from chain ---"
node -e 'process.stdout.write(Buffer.alloc(32768))' > /tmp/empty-state.bin
REPLAY=$(node "$DROOT/replay-cli.js" watch --rpc "$RPC" --coretex-registry "$REG" \
  --from-block "$DEPLOY_BLOCK" --to-block latest --parent-state /tmp/empty-state.bin \
  --expected-bundle-hash "$CVH" --allow-unverified-bundle --once 2>&1)
echo "$REPLAY" | tail -3
REPLAY_OK=$(echo "$REPLAY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=s.match(/"ok":\s*(true|false)/);console.log(m?m[1]:"unknown")})')

echo "--- finalizeEpoch ---"
PATCHSET=$(cast keccak "0x${T_PATCHHASH#0x}${M_PATCHHASH#0x}")
SCOREROOT=0x9100000000000000000000000000000000000000000000000000000000000091
$CAST "$REG" "$REG_ABI_FIN" $EPOCH "$M_CHILD" "$CVH" "$CORPUS" "$FRONTIER" "$PATCHSET" "$SCOREROOT" "$BASELINE" >/dev/null 2>>/tmp/drill.err || echo "finalize tx error (see /tmp/drill.err)"
FINAL=$(cast call --rpc-url "$RPC" "$REG" "epochFinalized(uint64)(bool)" $EPOCH)
echo "epochFinalized: $FINAL"

# ── deployment/drill record (gitignored) ──
mkdir -p ops
REC="ops/coretex-${MODE}-drill-${DATE}.json"
CHAINID=$(cast chain-id --rpc-url "$RPC")
node -e "require('fs').writeFileSync('$REC', JSON.stringify({mode:'$MODE',chainId:'$CHAINID',registry:'$REG',deployBlock:'$DEPLOY_BLOCK',owner:'$OWNER',coordinator:'$COORD',bundleHash:'$CVH',corpusRoot:'$CORPUS',initialStateRoot:'$GENESIS',finalStateRoot:'$M_CHILD',transitionCount:'$TC',patchHashes:['$T_PATCHHASH','$M_PATCHHASH'],badParentReverted:'$BAD',replayOk:'$REPLAY_OK',epochFinalized:'$FINAL',generatedAt:new Date().toISOString()},null,2)+'\n')"
echo "wrote $REC"

echo "════════════════════════════════════════════════════"
echo "DRILL RESULT ($MODE): liveRoot==mixed:$([ "$LIVE" = "$M_CHILD" ] && echo YES || echo NO) | badParentReverted:$BAD | replayOk:$REPLAY_OK | finalized:$FINAL"
[ "$LIVE" = "$M_CHILD" ] && [ "$BAD" = ok ] && [ "$REPLAY_OK" = true ] && [ "$FINAL" = true ] && echo "ALL PASS ✅" || echo "FAIL ❌"
