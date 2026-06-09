// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {BotcoinMiningV4} from "../src/BotcoinMiningV4.sol";

/// @notice Deploy BotcoinMiningV4, the unified standard-lane + CoreTex reward ledger.
///
/// Required env:
///   MAINNET_CONFIRM=I-UNDERSTAND
///   BOTCOIN_TOKEN_ADDRESS=0x...
///   BOTCOIN_STAKE_SOURCE_ADDRESS=0x...
///   CORETEX_REGISTRY_ADDRESS=0x...
///   CORETEX_COORDINATOR_SIGNER_ADDRESS=0x...
/// Optional:
///   POLICY_ADMIN=0x...       defaults to msg.sender
///
/// Broadcast:
///   MAINNET_CONFIRM=I-UNDERSTAND forge script contracts/script/DeployMiningV4Mainnet.s.sol \
///     --root contracts --rpc-url "$BASE_RPC_URL" --broadcast --private-key "$DEPLOYER_PK"
contract DeployMiningV4Mainnet is Script {
    function run() external {
        require(
            keccak256(bytes(vm.envString("MAINNET_CONFIRM"))) == keccak256(bytes("I-UNDERSTAND")),
            "Refusing to broadcast: set MAINNET_CONFIRM=I-UNDERSTAND"
        );

        address botcoin = vm.envAddress("BOTCOIN_TOKEN_ADDRESS");
        address v3 = vm.envAddress("BOTCOIN_STAKE_SOURCE_ADDRESS");
        address registry = vm.envAddress("CORETEX_REGISTRY_ADDRESS");
        address coordinator = vm.envAddress("CORETEX_COORDINATOR_SIGNER_ADDRESS");
        address policyAdmin = vm.envOr("POLICY_ADMIN", address(0));

        BotcoinMiningV4.CoreTexPolicyInput memory policy;
        policy.rulesVersion = 0xC0;
        policy.effectiveEpoch = 0;
        policy.screenerWorkBps = 10_000;
        policy.stateAdvanceThresholds = new uint256[](5);
        policy.stateAdvanceThresholds[0] = 0;
        policy.stateAdvanceThresholds[1] = 25;
        policy.stateAdvanceThresholds[2] = 100;
        policy.stateAdvanceThresholds[3] = 250;
        policy.stateAdvanceThresholds[4] = 500;
        policy.stateAdvanceWorkBps = new uint256[](5);
        policy.stateAdvanceWorkBps[0] = 30_000;
        policy.stateAdvanceWorkBps[1] = 40_000;
        policy.stateAdvanceWorkBps[2] = 60_000;
        policy.stateAdvanceWorkBps[3] = 90_000;
        policy.stateAdvanceWorkBps[4] = 120_000;

        vm.startBroadcast();
        BotcoinMiningV4 miningV4 = new BotcoinMiningV4(botcoin, v3, registry, coordinator, policyAdmin, policy);
        vm.stopBroadcast();

        (,, bytes32 policyHash,,,) = miningV4.getCoreTexPolicy(0xC0);
        console2.log("BotcoinMiningV4 deployed at:", address(miningV4));
        console2.log("BOTCOIN_TOKEN_ADDRESS:", botcoin);
        console2.log("BOTCOIN_STAKE_SOURCE_ADDRESS:", v3);
        console2.log("CORETEX_REGISTRY_ADDRESS:", registry);
        console2.log("CORETEX_COORDINATOR_SIGNER_ADDRESS:", coordinator);
        console2.log("POLICY_ADMIN:", miningV4.policyAdmin());
        console2.log("currentEpoch from V3:", miningV4.currentEpoch());
        console2.logBytes32(policyHash);
        console2.log(
            "NEXT: call CoreTexRegistry.setBotcoinMiningV4(BotcoinMiningV4) from registry owner before first CoreTex state advance."
        );
    }
}
