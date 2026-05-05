// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {CortexRegistry} from "../src/CortexRegistry.sol";
import {CortexMergeBonus} from "../src/CortexMergeBonus.sol";

/// @notice Deploy CortexRegistry and CortexMergeBonus.
///
/// Required env vars:
///   DEPLOYER_PK          — private key of deployer
///   COORDINATOR_ADDRESS  — coordinator EOA (authorized for submitPatchAccepted / finalizeEpoch)
///   BOTCOIN_TOKEN        — BOTCOIN ERC-20 token address
///   OPERATOR_1 … _N      — optional multisig operator addresses (call addOperator post-deploy)
///
/// Usage:
///   forge script script/DeployCortex.s.sol --broadcast --rpc-url $BASE_RPC_URL
contract DeployCortex is Script {
    function run() external {
        address deployer     = vm.envAddress("DEPLOYER_ADDRESS");
        address coordinator  = vm.envAddress("COORDINATOR_ADDRESS");
        address botcoin      = vm.envAddress("BOTCOIN_TOKEN");

        vm.startBroadcast();

        // 1. Deploy CortexRegistry
        CortexRegistry registry = new CortexRegistry(deployer, coordinator);
        console2.log("CortexRegistry deployed at:", address(registry));

        // 2. Deploy CortexMergeBonus (registry address wired immediately)
        CortexMergeBonus bonus = new CortexMergeBonus(botcoin, address(registry), coordinator);
        console2.log("CortexMergeBonus deployed at:", address(bonus));

        vm.stopBroadcast();

        console2.log("\n--- Post-deploy checklist ---");
        console2.log("1. Call registry.addOperator(op) for each multisig operator key.");
        console2.log("2. Confirm bonus.registry() ==", address(registry));
        console2.log("3. Run smoke test: submitPatchAccepted + finalizeEpoch on a test epoch.");
    }
}
