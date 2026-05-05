// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {CortexRegistry} from "../src/CortexRegistry.sol";
import {CortexMergeBonus} from "../src/CortexMergeBonus.sol";

/// @notice Mainnet deploy for Botcoin Cortex (V0).
///
///   V0 launch decision: multisig audit-window override is DEFERRED. The
///   contract still has multisig wiring (voteRevertEpoch) for V1 reactivation,
///   but V0 uses ownerRevertEpoch (single-owner). MERGE_MULTIPLIER_BPS is
///   hardcoded at 20000 (2.0x) — change the constant in CortexMergeBonus.sol
///   and redeploy if you want a different value at launch.
///
///   Stricter than testnet: requires `MAINNET_CONFIRM=I-UNDERSTAND` env var
///   to broadcast.
///
/// Usage:
///   MAINNET_CONFIRM=I-UNDERSTAND \
///   OWNER_ADDRESS=0xaaa...                  -- the V0 owner / single revert authority
///   COORDINATOR_ADDRESS=0xbbb...            -- existing SWCP coordinator EOA
///   BOTCOIN_TOKEN_ADDRESS=0xccc...          -- already-deployed BOTCOIN ERC-20
///   forge script contracts/script/DeployMainnet.s.sol \
///     --rpc-url $BASE_RPC_URL --broadcast --verify
contract DeployMainnet is Script {
    function run() external {
        require(
            keccak256(bytes(vm.envString("MAINNET_CONFIRM"))) ==
                keccak256(bytes("I-UNDERSTAND")),
            "Refusing to broadcast: set MAINNET_CONFIRM=I-UNDERSTAND"
        );

        address owner_       = vm.envAddress("OWNER_ADDRESS");
        address coordinator_ = vm.envAddress("COORDINATOR_ADDRESS");
        address botcoinToken = vm.envAddress("BOTCOIN_TOKEN_ADDRESS");

        require(owner_       != address(0), "OWNER_ADDRESS zero");
        require(coordinator_ != address(0), "COORDINATOR_ADDRESS zero");
        require(botcoinToken != address(0), "BOTCOIN_TOKEN_ADDRESS zero");

        vm.startBroadcast();

        CortexRegistry registry = new CortexRegistry(owner_, coordinator_);
        CortexMergeBonus mergeBonus = new CortexMergeBonus(
            address(registry),
            botcoinToken,
            coordinator_
        );

        vm.stopBroadcast();

        console2.log("CortexRegistry  deployed at:", address(registry));
        console2.log("CortexMergeBonus deployed at:", address(mergeBonus));
        console2.log("owner:",       owner_);
        console2.log("coordinator:", coordinator_);
        console2.log("botcoin token:", botcoinToken);
        console2.log("MERGE_MULTIPLIER_BPS (compile-time constant):", mergeBonus.MERGE_MULTIPLIER_BPS());
        console2.log("CHALLENGE_WINDOW_SECONDS:",                     registry.CHALLENGE_WINDOW_SECONDS());
        console2.log("SNAPSHOT_EPOCH_INTERVAL:",                      registry.SNAPSHOT_EPOCH_INTERVAL());
        console2.log("");
        console2.log("V0 NOTE: multisig audit-window revert is deferred.");
        console2.log("         The owner alone may call ownerRevertEpoch() within");
        console2.log("         CHALLENGE_WINDOW_SECONDS. V1 reactivates voteRevertEpoch.");
    }
}
