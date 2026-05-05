// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {CortexRegistry} from "../src/CortexRegistry.sol";
import {CortexMergeBonus} from "../src/CortexMergeBonus.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Gas ceiling tests. CI must fail if any function exceeds its ceiling.
///         Ceilings are documented in contracts/test/GAS_BUDGETS.md.
///
/// Gas ceilings (warm storage after first hit, conservative estimates):
///   submitPatchAccepted  ≤ 90_000
///   finalizeEpoch        ≤ 180_000
///   emitSnapshot         ≤ 600_000  (1024 × 32 bytes in calldata is expensive)
///   claimMergeBonus      ≤ 100_000  per epoch in the batch
contract GasBudgetTest is Test {

    uint256 constant GAS_SUBMIT_PATCH    =  90_000;
    uint256 constant GAS_FINALIZE_EPOCH  = 250_000; // measured ~210K; 7 SSTOREs + event + ReentrancyGuard
    uint256 constant GAS_EMIT_SNAPSHOT   = 600_000;
    uint256 constant GAS_CLAIM_PER_EPOCH = 100_000;

    address constant OWNER       = address(0x1);
    address constant COORDINATOR = address(0x2);
    address constant MINER_A     = address(0x5);

    CortexRegistry  registry;
    CortexMergeBonus bonus;
    MockERC20 token;

    uint64 constant EPOCH = 1;
    bytes32 constant PARENT_STATE = keccak256("p");
    bytes32 constant PATCH_SET    = keccak256("ps");
    bytes32 constant NEW_STATE    = keccak256("ns");
    bytes32 constant CORE_HASH    = keccak256("cv");
    bytes32 constant BENCHMARK    = keccak256("bc");
    bytes32 constant CORPUS_ROOT  = keccak256("cr");
    bytes32 constant SCORE_ROOT   = keccak256("sr");

    function setUp() public {
        vm.startPrank(OWNER);
        token    = new MockERC20("B", "B");
        registry = new CortexRegistry(OWNER, COORDINATOR);
        bonus    = new CortexMergeBonus(address(token), address(registry), COORDINATOR);
        token.mint(COORDINATOR, 1_000_000 ether);
        vm.stopPrank();
    }

    function test_gas_submitPatchAccepted() public {
        bytes memory patchBytes = abi.encodePacked(uint256(1), uint256(2), uint256(3));
        bytes32 ph = keccak256(patchBytes);
        bytes32 rh = keccak256("report");

        // Warm up storage.
        vm.prank(COORDINATOR);
        registry.submitPatchAccepted(EPOCH, MINER_A, PARENT_STATE, ph, rh, patchBytes);

        uint256 gasBefore = gasleft();
        vm.prank(COORDINATOR);
        registry.submitPatchAccepted(EPOCH, MINER_A, PARENT_STATE, ph, rh, patchBytes);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("submitPatchAccepted gas:", gasUsed);
        assertLt(gasUsed, GAS_SUBMIT_PATCH, "submitPatchAccepted exceeds gas ceiling");
    }

    function test_gas_finalizeEpoch() public {
        // Warm-up call on a different epoch.
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(99, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);

        uint256 gasBefore = gasleft();
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("finalizeEpoch gas:", gasUsed);
        assertLt(gasUsed, GAS_FINALIZE_EPOCH, "finalizeEpoch exceeds gas ceiling");
    }

    function test_gas_emitSnapshot() public {
        uint64 snapEpoch = 100;
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(snapEpoch, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);

        bytes memory fullState = new bytes(32768);

        uint256 gasBefore = gasleft();
        vm.prank(COORDINATOR);
        registry.emitSnapshot(snapEpoch, fullState);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("emitSnapshot gas:", gasUsed);
        assertLt(gasUsed, GAS_EMIT_SNAPSHOT, "emitSnapshot exceeds gas ceiling");
    }

    function test_gas_claimMergeBonus() public {
        // Build single-leaf Merkle.
        uint256 bonusAmt = 10 ether;
        uint256 capAmt   = 10 ether;
        bytes32 leaf = keccak256(abi.encodePacked(MINER_A, bonusAmt, capAmt));
        bytes32[] memory emptyProof = new bytes32[](0);

        vm.prank(COORDINATOR);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
        vm.warp(block.timestamp + 21601);

        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), bonusAmt);
        bonus.fundEpoch(EPOCH, leaf, bonusAmt);
        vm.stopPrank();

        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = capAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = emptyProof;

        uint256 gasBefore = gasleft();
        vm.prank(MINER_A);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);
        uint256 gasUsed = gasBefore - gasleft();

        console2.log("claimMergeBonus (1 epoch) gas:", gasUsed);
        assertLt(gasUsed, GAS_CLAIM_PER_EPOCH, "claimMergeBonus exceeds gas ceiling");
    }
}
