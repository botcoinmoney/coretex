// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {CortexRegistry} from "../src/CortexRegistry.sol";
import {CortexMergeBonus} from "../src/CortexMergeBonus.sol";

/// @notice Deploy CortexRegistry and CortexMergeBonus to a testnet.
///
/// Reads addresses from environment variables.
/// Outputs a deployment manifest summary to stdout (JSON captured to
/// ops/testnet-deployment.json by the wrapping deploy-testnet.mjs script).
/// ops/testnet-deployment.json is gitignored — do NOT commit live addresses.
///
/// Required env vars:
///   DEPLOYER_ADDRESS     — msg.sender / deployer EOA
///   DEPLOYER_PK          — private key of deployer
///   BASE_TESTNET_RPC_URL — testnet RPC endpoint (e.g. Base Sepolia)
///   COORDINATOR_ADDRESS  — coordinator EOA granted submitPatchAccepted / finalizeEpoch
///   BOTCOIN_TOKEN        — BOTCOIN ERC-20 address (testnet mock is fine)
///
/// Optional env vars (operators added post-deploy):
///   OPERATOR_1 … OPERATOR_5 — multisig operator addresses for audit-window revert
///
/// Phase 9 mainnet deployment uses contracts/script/DeployMainnet.s.sol (not this file).
///
/// Usage:
///   forge script contracts/script/DeployTestnet.s.sol \
///     --broadcast \
///     --rpc-url $BASE_TESTNET_RPC_URL \
///     --private-key $DEPLOYER_PK
contract DeployTestnet is Script {
    function run() external {
        address deployer    = vm.envAddress("DEPLOYER_ADDRESS");
        address coordinator = vm.envAddress("COORDINATOR_ADDRESS");
        address botcoin     = vm.envAddress("BOTCOIN_TOKEN");

        console2.log("=== CortexRegistry + CortexMergeBonus — TESTNET DEPLOY ===");
        console2.log("Deployer:    ", deployer);
        console2.log("Coordinator: ", coordinator);
        console2.log("BotcoinToken:", botcoin);
        console2.log("Chain ID:    ", block.chainid);

        vm.startBroadcast();

        // 1. Deploy CortexRegistry (state anchor, zero reward logic)
        CortexRegistry registry = new CortexRegistry(deployer, coordinator);
        console2.log("CortexRegistry:    ", address(registry));

        // 2. Deploy CortexMergeBonus (multiplier payout, mirrors BonusEpoch)
        CortexMergeBonus bonus = new CortexMergeBonus(botcoin, address(registry), coordinator);
        console2.log("CortexMergeBonus:  ", address(bonus));

        vm.stopBroadcast();

        // Optional: add multisig operators if provided
        uint8 opCount = 0;
        address[5] memory operators;
        for (uint8 i = 1; i <= 5; i++) {
            string memory key = string(abi.encodePacked("OPERATOR_", uint8(48 + i)));
            try vm.envAddress(key) returns (address op) {
                operators[opCount++] = op;
            } catch { break; }
        }

        if (opCount > 0) {
            console2.log("\n--- Adding", opCount, "multisig operator(s) ---");
            vm.startBroadcast();
            for (uint8 i = 0; i < opCount; i++) {
                registry.addOperator(operators[i]);
                console2.log("  addOperator:", operators[i]);
            }
            vm.stopBroadcast();
        }

        // Emit JSON manifest to stdout so deploy-testnet.mjs can capture it
        console2.log("\n--- DEPLOYMENT MANIFEST (JSON) ---");
        console2.log("{");
        console2.log('  "network": "testnet",');
        console2.log('  "chainId": %d,', block.chainid);
        console2.log('  "deployer": "%s",', deployer);
        console2.log('  "coordinator": "%s",', coordinator);
        console2.log('  "cortexRegistry": "%s",', address(registry));
        console2.log('  "cortexMergeBonus": "%s",', address(bonus));
        console2.log('  "deployedAt": %d', block.timestamp);
        console2.log("}");
        console2.log("--- END MANIFEST ---");

        console2.log("\n--- Post-deploy checklist ---");
        console2.log("1. Copy JSON manifest above to ops/testnet-deployment.json (gitignored).");
        console2.log("2. Set CORTEX_REGISTRY_ADDRESS and CORTEX_MERGE_BONUS_ADDRESS in .env.");
        console2.log("3. Add remaining multisig operators: registry.addOperator(op).");
        console2.log("4. Run smoke test: scripts/testnet/deploy-testnet.mjs --smoke-only.");
        console2.log("5. Run synthetic traffic: scripts/testnet/feed-synthetic-traffic.mjs.");
    }
}
