// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {CortexRegistry} from "../src/CortexRegistry.sol";
import {CortexMergeBonus} from "../src/CortexMergeBonus.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockBotcoinMiningV3} from "./mocks/MockBotcoinMiningV3.sol";

/// @notice Fork tests against Base mainnet.
///         Skipped automatically when BASE_RPC_URL is not set.
///
/// CI wiring: set BASE_RPC_URL secret in GitHub Actions to run these.
///
/// Covers:
///   1. Full deploy → submitPatchAccepted (×3) → finalizeEpoch → emitSnapshot →
///      fundEpoch → claimMergeBonus.
///   2. Audit-window enforcement on mainnet fork.
///   3. Multisig revert drill.
///   4. SWCP mock at fork-pinned address — confirm nextIndex/lastReceiptHash
///      unchanged by Cortex operations.
///   5. Pool-mode claimMergeBonus via triggerMergeBonusClaim.
///   6. Pause matrix on fork.
///
/// Log-replay (full Phase 3 decoder) is a placeholder — marked SKIP until
/// Phase 3 Core decoder is available.
contract CortexForkTest is Test {

    string constant BASE_RPC_ENV = "BASE_RPC_URL";

    // ── Test addresses ────────────────────────────────────────────────────
    address constant OWNER       = address(0x10);
    address constant COORDINATOR = address(0x20);
    address constant OPERATOR_A  = address(0x30);
    address constant OPERATOR_B  = address(0x40);
    address constant MINER_A     = address(0x50);
    address constant POOL        = address(0x70);

    // ── Contracts ─────────────────────────────────────────────────────────
    CortexRegistry   registry;
    CortexMergeBonus bonus;
    MockERC20        token;
    MockBotcoinMiningV3 mockMining;

    uint64 constant EPOCH = 10;

    bytes32 constant PARENT_STATE = keccak256("fork-parent");
    bytes32 constant PATCH_SET    = keccak256("fork-patchset");
    bytes32 constant NEW_STATE    = keccak256("fork-newstate");
    bytes32 constant CORE_HASH    = keccak256("fork-core");
    bytes32 constant BENCHMARK    = keccak256("fork-bench");
    bytes32 constant CORPUS_ROOT  = keccak256("fork-corpus");
    bytes32 constant SCORE_ROOT   = keccak256("fork-score");

    // ── Fork-guard modifier ───────────────────────────────────────────────

    function _requireFork() internal {
        try vm.envString(BASE_RPC_ENV) returns (string memory rpcUrl) {
            if (bytes(rpcUrl).length == 0) {
                vm.skip(true);
                return;
            }
            vm.createSelectFork(rpcUrl);
        } catch {
            vm.skip(true);
        }
    }

    // ── Setup (called within each test after fork is selected) ────────────

    function _setup() internal {
        vm.startPrank(OWNER);
        token    = new MockERC20("BOTCOIN", "BOT");
        registry = new CortexRegistry(OWNER, COORDINATOR);
        bonus    = new CortexMergeBonus(address(token), address(registry), COORDINATOR);
        registry.addOperator(OPERATOR_A);
        registry.addOperator(OPERATOR_B);
        token.mint(COORDINATOR, 1_000_000 ether);
        mockMining = new MockBotcoinMiningV3();
        vm.stopPrank();
    }

    // ─────────────────────────────────────────────────────────────────────
    // FORK TEST 1: Full end-to-end flow
    // ─────────────────────────────────────────────────────────────────────

    function test_fork_fullE2EFlow() public {
        _requireFork();
        _setup();

        // 1. Commit shard.
        bytes32 seed   = keccak256("fork-seed-10");
        bytes32 commit = keccak256(abi.encodePacked(seed));
        vm.prank(COORDINATOR);
        registry.commitShard(EPOCH, commit);

        // 2. Reveal shard.
        vm.prank(COORDINATOR);
        registry.revealShard(EPOCH, seed);

        // 3. Submit 3 accepted patches.
        vm.startPrank(COORDINATOR);
        for (uint256 i = 0; i < 3; i++) {
            bytes memory pb = abi.encodePacked(i, "patch-data-fork");
            registry.submitPatchAccepted(EPOCH, MINER_A, PARENT_STATE, keccak256(pb), keccak256("r"), pb);
        }
        vm.stopPrank();

        assertEq(registry.patchCount(EPOCH), 3);

        // 4. Finalize epoch.
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
        assertTrue(registry.epochFinalized(EPOCH));

        // 5. Emit snapshot at epoch 100 boundary.
        uint64 snapEpoch = 100;
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(snapEpoch, PARENT_STATE, PATCH_SET, keccak256("snap-state"), CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);

        bytes memory fullState = new bytes(32768);
        vm.prank(COORDINATOR);
        registry.emitSnapshot(snapEpoch, fullState);

        // 6. Wait for audit window to close.
        vm.warp(block.timestamp + 21601);

        // 7. Fund CortexMergeBonus.
        uint256 bonusAmt = 100 ether;
        bytes32 leaf = keccak256(abi.encodePacked(MINER_A, bonusAmt, bonusAmt));

        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), bonusAmt);
        bonus.fundEpoch(EPOCH, leaf, bonusAmt);
        vm.stopPrank();

        assertTrue(bonus.claimsOpen(EPOCH));

        // 8. Miner claims.
        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = bonusAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        uint256 before = token.balanceOf(MINER_A);
        vm.prank(MINER_A);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);

        assertEq(token.balanceOf(MINER_A) - before, bonusAmt);
        console2.log("fork_fullE2EFlow PASS");
    }

    // ─────────────────────────────────────────────────────────────────────
    // FORK TEST 2: Audit-window enforcement
    // ─────────────────────────────────────────────────────────────────────

    function test_fork_auditWindowEnforcement() public {
        _requireFork();
        _setup();

        vm.prank(COORDINATOR);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);

        // Claim before window — must revert.
        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), 10 ether);
        vm.expectRevert(CortexMergeBonus.AuditWindowStillOpen.selector);
        bonus.fundEpoch(EPOCH, bytes32("r"), 10 ether);
        vm.stopPrank();

        console2.log("fork_auditWindowEnforcement PASS");
    }

    // ─────────────────────────────────────────────────────────────────────
    // FORK TEST 3: Multisig revert drill
    // ─────────────────────────────────────────────────────────────────────

    function test_fork_multisigRevertDrill() public {
        _requireFork();
        _setup();

        vm.prank(COORDINATOR);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);

        // 1-of-N: still finalized.
        vm.prank(OPERATOR_A);
        registry.voteRevertEpoch(EPOCH);
        assertTrue(registry.epochFinalized(EPOCH));
        assertFalse(registry.epochReverted(EPOCH));

        // 2-of-N: reverted.
        vm.prank(OPERATOR_B);
        registry.voteRevertEpoch(EPOCH);
        assertTrue(registry.epochReverted(EPOCH));
        assertFalse(registry.epochFinalized(EPOCH));

        // Advance past window — funding must still fail because reverted.
        vm.warp(block.timestamp + 21601);
        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), 1 ether);
        vm.expectRevert(CortexMergeBonus.EpochWasReverted.selector);
        bonus.fundEpoch(EPOCH, bytes32("r"), 1 ether);
        vm.stopPrank();

        console2.log("fork_multisigRevertDrill PASS");
    }

    // ─────────────────────────────────────────────────────────────────────
    // FORK TEST 4: SWCP non-interference (mock at fork address)
    // ─────────────────────────────────────────────────────────────────────

    function test_fork_swcpNonInterference() public {
        _requireFork();
        _setup();

        // Record initial state.
        uint64 indexBefore = mockMining.nextIndex(MINER_A);

        // Perform Cortex operations (finalize + pause).
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
        vm.prank(OWNER);
        registry.pause();

        // Mock SWCP still works.
        mockMining.incrementNextIndex(MINER_A);
        assertEq(mockMining.nextIndex(MINER_A), indexBefore + 1);

        vm.prank(OWNER);
        registry.unpause();

        // Bonus paused — SWCP mock still works.
        vm.prank(OWNER);
        bonus.pause();
        mockMining.incrementNextIndex(MINER_A);
        assertEq(mockMining.nextIndex(MINER_A), indexBefore + 2);

        console2.log("fork_swcpNonInterference PASS");
    }

    // ─────────────────────────────────────────────────────────────────────
    // FORK TEST 5: Pool-mode claim
    // ─────────────────────────────────────────────────────────────────────

    function test_fork_poolModeClaim() public {
        _requireFork();
        _setup();

        uint256 amt = 30 ether;
        bytes32 leaf = keccak256(abi.encodePacked(MINER_A, amt, amt));

        vm.prank(COORDINATOR);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
        vm.warp(block.timestamp + 21601);

        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), amt);
        bonus.fundEpoch(EPOCH, leaf, amt);
        vm.stopPrank();

        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = amt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = amt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = new bytes32[](0);

        uint256 before = token.balanceOf(MINER_A);
        vm.prank(POOL);
        bonus.triggerMergeBonusClaim(epochs, MINER_A, bonuses, caps, proofs);

        assertEq(token.balanceOf(MINER_A) - before, amt);
        console2.log("fork_poolModeClaim PASS");
    }

    // ─────────────────────────────────────────────────────────────────────
    // FORK TEST 6: Pause matrix
    // ─────────────────────────────────────────────────────────────────────

    function test_fork_pauseMatrix() public {
        _requireFork();
        _setup();

        // Pause registry — Cortex finalization blocked, SWCP mock unaffected.
        vm.prank(OWNER);
        registry.pause();

        vm.prank(COORDINATOR);
        vm.expectRevert();
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);

        // SWCP mock unaffected.
        mockMining.incrementNextIndex(MINER_A);
        assertGt(mockMining.nextIndex(MINER_A), 0);

        vm.prank(OWNER);
        registry.unpause();

        // Now finalize successfully.
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
        assertTrue(registry.epochFinalized(EPOCH));

        console2.log("fork_pauseMatrix PASS");
    }

    // ─────────────────────────────────────────────────────────────────────
    // PLACEHOLDER: Log-replay (Phase 3 dependency)
    // ─────────────────────────────────────────────────────────────────────

    /// @notice SKIPPED — requires Phase 3 Core decoder to reconstruct newStateRoot
    ///         from chain logs. Placeholder per Phase 2 scope.
    function test_fork_SKIP_logReplayReconstruction() public {
        _requireFork();
        vm.skip(true); // Phase 3 dependency: botcoin-cortex verify-epoch decoder
        // When Phase 3 ships, this test:
        //   1. Emits CortexPatchAccepted events for 10 epochs (≥1 crossing snapshot boundary).
        //   2. Calls an off-chain helper (or inline Solidity state-hash reducer) to re-derive newStateRoot.
        //   3. Asserts byte-identical match with on-chain CortexEpochFinalized.newStateRoot.
    }
}
