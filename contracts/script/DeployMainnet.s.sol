// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CoreTexRegistry} from "../src/CoreTexRegistry.sol";

/// @notice Deploy a fresh canonical CoreTexRegistry on Base mainnet (state-integrity drill).
///         Credit accounting (epoch funding / claims) is intentionally NOT deployed here.
///
///   Requires MAINNET_CONFIRM=I-UNDERSTAND to broadcast. Secrets via env only (never printed):
///     export BASE_RPC_URL=...
///     export DEPLOYER_PK=...            (forge reads via --private-key or PRIVATE_KEY/wallet)
///     export OWNER_ADDRESS=0x...        registry owner
///     export CORETEX_COORDINATOR_SIGNER_ADDRESS=0x...  coordinator signer
///     export MAINNET_CONFIRM=I-UNDERSTAND
///
///   MAINNET_CONFIRM=I-UNDERSTAND forge script contracts/script/DeployMainnet.s.sol \
///     --root contracts --rpc-url "$BASE_RPC_URL" --broadcast
contract DeployMainnet is Script {
    function run() external {
        require(
            keccak256(bytes(vm.envString("MAINNET_CONFIRM"))) == keccak256(bytes("I-UNDERSTAND")),
            "Refusing to broadcast: set MAINNET_CONFIRM=I-UNDERSTAND"
        );
        address owner_ = vm.envAddress("OWNER_ADDRESS");
        address coordinator_ = vm.envOr("CORETEX_COORDINATOR_SIGNER_ADDRESS", address(0));
        if (coordinator_ == address(0)) {
            coordinator_ = vm.envAddress("COORDINATOR_ADDRESS"); // deprecated compatibility alias
        }
        require(owner_ != address(0), "OWNER_ADDRESS zero");
        require(coordinator_ != address(0), "CORETEX_COORDINATOR_SIGNER_ADDRESS zero");

        vm.startBroadcast();
        CoreTexRegistry registry = new CoreTexRegistry(owner_, coordinator_);
        vm.stopBroadcast();

        console2.log("CoreTexRegistry deployed at:", address(registry));
        console2.log("owner:", owner_);
        console2.log("coordinator:", coordinator_);
        // no on-chain per-epoch state-advance cap; scarcity is coordinator + frontier + V4 multipliers
    }
}
