// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {CortexRegistry} from "../src/CortexRegistry.sol";
import {CortexMergeBonus} from "../src/CortexMergeBonus.sol";

/// @notice Mainnet deploy for Botcoin Cortex. STRICTER than testnet:
///   - Requires `MAINNET_CONFIRM=I-UNDERSTAND` env var to broadcast.
///   - Reads multisig operator addresses from `MULTISIG_OPERATOR_ADDRESSES`
///     (comma-separated).
///   - Reads `BOTCOIN_TOKEN_ADDRESS` for the merge-bonus payout token.
///
/// Usage:
///   MAINNET_CONFIRM=I-UNDERSTAND \
///   MULTISIG_OPERATOR_ADDRESSES=0xaaa...,0xbbb...,0xccc... \
///   BOTCOIN_TOKEN_ADDRESS=0x... \
///   CHALLENGE_WINDOW_SECONDS=21600 \
///   SNAPSHOT_EPOCH_INTERVAL=100 \
///   MERGE_MULTIPLIER_BPS=15000 \
///   forge script contracts/script/DeployMainnet.s.sol \
///     --rpc-url $BASE_RPC_URL --broadcast --verify
contract DeployMainnet is Script {
    function run() external {
        require(
            keccak256(bytes(vm.envString("MAINNET_CONFIRM"))) ==
                keccak256(bytes("I-UNDERSTAND")),
            "Refusing to broadcast: set MAINNET_CONFIRM=I-UNDERSTAND"
        );

        address[] memory operators = vm.envAddress(
            "MULTISIG_OPERATOR_ADDRESSES",
            ","
        );
        require(operators.length >= 3, "need >= 3 operators (2-of-N threshold)");

        address botcoinToken = vm.envAddress("BOTCOIN_TOKEN_ADDRESS");
        uint64  challengeWindow = uint64(vm.envOr("CHALLENGE_WINDOW_SECONDS", uint256(21600)));
        uint64  snapshotInterval = uint64(vm.envOr("SNAPSHOT_EPOCH_INTERVAL", uint256(100)));
        uint16  mergeMultBps    = uint16(vm.envOr("MERGE_MULTIPLIER_BPS",   uint256(15000)));
        uint8   threshold       = uint8(vm.envOr("MULTISIG_THRESHOLD",     uint256(2)));

        vm.startBroadcast();

        CortexRegistry registry = new CortexRegistry(
            challengeWindow,
            snapshotInterval,
            operators,
            threshold
        );

        CortexMergeBonus mergeBonus = new CortexMergeBonus(
            address(registry),
            botcoinToken,
            mergeMultBps
        );

        vm.stopBroadcast();

        console2.log("CortexRegistry  deployed at:", address(registry));
        console2.log("CortexMergeBonus deployed at:", address(mergeBonus));
        console2.log("operator count:", operators.length);
        console2.log("threshold:", threshold);
        console2.log("challengeWindow (s):", challengeWindow);
        console2.log("snapshotInterval:", snapshotInterval);
        console2.log("mergeMultiplierBps:", mergeMultBps);
    }
}
