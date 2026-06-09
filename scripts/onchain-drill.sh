#!/usr/bin/env bash
# CoreTex Base-mainnet on-chain drill.
#
# Required read-only env:
#   BASE_RPC_URL
#   CHAIN_ID=8453
#   CORETEX_REGISTRY_ADDRESS
#   BOTCOIN_MINING_CONTRACT_ADDRESS
#
# Optional write checks:
#   CORETEX_DIRECT_REVERT_TEST_KEY       EOA key used only to prove direct registry advance reverts
#   CORETEX_STATE_ADVANCE_RECEIPT_JSON   JSON file containing a coordinator-signed V4 receipt tuple
#   CORETEX_STATE_ADVANCE_BROADCAST_KEY  miner/relayer key for submitting the signed receipt
set -euo pipefail
cd "$(dirname "$0")/.."

need() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "missing required env: $name" >&2
    exit 2
  fi
}

need BASE_RPC_URL
need CHAIN_ID
need CORETEX_REGISTRY_ADDRESS
need BOTCOIN_MINING_CONTRACT_ADDRESS

if [ "$CHAIN_ID" != "8453" ]; then
  echo "CHAIN_ID must be 8453 for this production drill" >&2
  exit 2
fi

RPC="$BASE_RPC_URL"
REG="$CORETEX_REGISTRY_ADDRESS"
MINING="$BOTCOIN_MINING_CONTRACT_ADDRESS"

echo "=== CoreTex Base-mainnet pin drill ==="
echo "registry: $REG"
echo "mining:   $MINING"

CHAIN_ACTUAL=$(cast chain-id --rpc-url "$RPC")
if [ "$CHAIN_ACTUAL" != "$CHAIN_ID" ]; then
  echo "chain id mismatch: rpc=$CHAIN_ACTUAL env=$CHAIN_ID" >&2
  exit 1
fi

V4_REGISTRY=$(cast call --rpc-url "$RPC" "$MINING" "coreTexRegistry()(address)" | tr '[:upper:]' '[:lower:]')
REG_V4=$(cast call --rpc-url "$RPC" "$REG" "botcoinMiningV4()(address)" | tr '[:upper:]' '[:lower:]')
REG_EXPECTED=$(cast to-check-sum-address "$REG" | tr '[:upper:]' '[:lower:]')
MINING_EXPECTED=$(cast to-check-sum-address "$MINING" | tr '[:upper:]' '[:lower:]')

if [ "$V4_REGISTRY" != "$REG_EXPECTED" ]; then
  echo "V4 registry pin mismatch: $V4_REGISTRY != $REG_EXPECTED" >&2
  exit 1
fi
if [ "$REG_V4" != "$MINING_EXPECTED" ]; then
  echo "registry V4 pin mismatch: $REG_V4 != $MINING_EXPECTED" >&2
  exit 1
fi

EPOCH=$(cast call --rpc-url "$RPC" "$MINING" "currentEpoch()(uint64)")
LIVE_ROOT=$(cast call --rpc-url "$RPC" "$REG" "liveStateRoot(uint64)(bytes32)" "$EPOCH")
TRANSITIONS=$(cast call --rpc-url "$RPC" "$REG" "transitionCount(uint64)(uint64)" "$EPOCH")
CTX_SET=$(cast call --rpc-url "$RPC" "$MINING" "coreTexEpochContextSet(uint64)(bool)" "$EPOCH")
PARENT_ROOT=$(cast call --rpc-url "$RPC" "$MINING" "coreTexParentStateRoot(uint64)(bytes32)" "$EPOCH")
EPOCH_COMMIT=$(cast call --rpc-url "$RPC" "$MINING" "epochCommit(uint64)(bytes32)" "$EPOCH")
REG_HIDDEN=$(cast call --rpc-url "$RPC" "$REG" "epochHiddenSeedCommit(uint64)(bytes32)" "$EPOCH")
if [ "$CTX_SET" != "true" ]; then
  echo "V4 CoreTex epoch context is not set for epoch $EPOCH" >&2
  exit 1
fi
if [ "$EPOCH_COMMIT" = "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
  echo "V4 epochCommit is zero for epoch $EPOCH" >&2
  exit 1
fi
if [ "$(echo "$REG_HIDDEN" | tr '[:upper:]' '[:lower:]')" != "$(echo "$EPOCH_COMMIT" | tr '[:upper:]' '[:lower:]')" ]; then
  echo "registry hidden seed commit does not resolve to V4 epochCommit" >&2
  exit 1
fi
echo "epoch: $EPOCH"
echo "parentRoot: $PARENT_ROOT"
echo "liveRoot: $LIVE_ROOT"
echo "transitionCount: $TRANSITIONS"
echo "pin checks: PASS"

if [ -n "${CORETEX_DIRECT_REVERT_TEST_KEY:-}" ]; then
  echo "--- direct registry advance must revert ---"
  TEST_ADDR=$(cast wallet address --private-key "$CORETEX_DIRECT_REVERT_TEST_KEY")
  PATCH_HASH=$(cast keccak "0xd1")
  EVAL_HASH=$(cast keccak "0xe1")
  CORE_VERSION=$(cast call --rpc-url "$RPC" "$REG" "epochCoreVersionHash(uint64)(bytes32)" "$EPOCH")
  CORPUS=$(cast call --rpc-url "$RPC" "$REG" "epochCorpusRoot(uint64)(bytes32)" "$EPOCH")
  FRONTIER=$(cast call --rpc-url "$RPC" "$REG" "epochActiveFrontierRoot(uint64)(bytes32)" "$EPOCH")
  NEW_ROOT=$(cast keccak "0xfeed")
  if cast send --rpc-url "$RPC" --private-key "$CORETEX_DIRECT_REVERT_TEST_KEY" "$REG" \
    "submitStateAdvance(uint64,address,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint16,bytes)" \
    "$EPOCH" "$TEST_ADDR" "$LIVE_ROOT" "$NEW_ROOT" "$PATCH_HASH" "$EVAL_HASH" "$CORE_VERSION" "$CORPUS" "$FRONTIER" 1 1 0x00 >/tmp/coretex-direct-revert.out 2>&1; then
    echo "FAIL: direct registry advance unexpectedly succeeded" >&2
    exit 1
  fi
  echo "direct registry advance reverted: PASS"
fi

if [ -n "${CORETEX_STATE_ADVANCE_RECEIPT_JSON:-}" ]; then
  need CORETEX_STATE_ADVANCE_BROADCAST_KEY
  RECEIPT_TUPLE=$(node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync(process.env.CORETEX_STATE_ADVANCE_RECEIPT_JSON,'utf8')); console.log(j.receiptTuple ?? j.tuple ?? '');")
  if [ -z "$RECEIPT_TUPLE" ]; then
    echo "receipt JSON must contain receiptTuple or tuple" >&2
    exit 2
  fi
  echo "--- V4-mediated state advance ---"
  cast send --rpc-url "$RPC" --private-key "$CORETEX_STATE_ADVANCE_BROADCAST_KEY" "$MINING" \
    "submitCoreTexReceipt((uint64,uint64,bytes32,uint8,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint128,uint32,bytes32,uint256,uint256,uint16,uint32,uint32,uint64,uint64,bytes,bytes))" \
    "$RECEIPT_TUPLE"
fi

echo "DRILL RESULT: PASS"
