// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {CortexRegistry} from "../src/CortexRegistry.sol";
import {CortexMergeBonus} from "../src/CortexMergeBonus.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockBotcoinMiningV3} from "./mocks/MockBotcoinMiningV3.sol";

/// @notice Full Phase 2 test suite (no fork required).
contract CortexPhase2Test is Test {

    // ── Test addresses ────────────────────────────────────────────────────
    address constant OWNER        = address(0x1);
    address constant COORDINATOR  = address(0x2);
    address constant OPERATOR_A   = address(0x3);
    address constant OPERATOR_B   = address(0x4);
    address constant MINER_A      = address(0x5);
    address constant MINER_B      = address(0x6);
    address constant POOL         = address(0x7);
    address constant ATTACKER     = address(0x8);

    // ── Contracts ─────────────────────────────────────────────────────────
    CortexRegistry  registry;
    CortexMergeBonus bonus;
    MockERC20       token;
    MockBotcoinMiningV3 mockMining;

    // ── Helpers ───────────────────────────────────────────────────────────
    uint64 constant EPOCH = 1;

    bytes32 constant PARENT_STATE  = keccak256("parent");
    bytes32 constant PATCH_SET     = keccak256("patchSet");
    bytes32 constant NEW_STATE     = keccak256("newState");
    bytes32 constant CORE_HASH     = keccak256("coreVersion");
    bytes32 constant BENCHMARK     = keccak256("benchmark");
    bytes32 constant CORPUS_ROOT   = keccak256("corpusRoot");
    bytes32 constant SCORE_ROOT    = keccak256("scoreRoot");

    // ── Setup ─────────────────────────────────────────────────────────────

    function setUp() public {
        vm.startPrank(OWNER);

        token   = new MockERC20("BOTCOIN", "BOT");
        registry = new CortexRegistry(OWNER, COORDINATOR);
        bonus    = new CortexMergeBonus(address(token), address(registry), COORDINATOR);

        registry.addOperator(OPERATOR_A);
        registry.addOperator(OPERATOR_B);

        mockMining = new MockBotcoinMiningV3();

        // Fund COORDINATOR with tokens to pay merge bonuses.
        token.mint(COORDINATOR, 1_000_000 ether);

        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════
    // §1 – CortexRegistry basic flow
    // ═══════════════════════════════════════════════════════════════════

    function test_submitPatchAccepted_emitsEvent() public {
        vm.startPrank(COORDINATOR);

        bytes memory patchBytes = abi.encodePacked(uint256(42), bytes32("targetIndex"), bytes32("newWord"));
        bytes32 patchHash = keccak256(patchBytes);

        vm.expectEmit(true, true, false, true, address(registry));
        emit CortexRegistry.CortexPatchAccepted(
            EPOCH,
            MINER_A,
            PARENT_STATE,
            patchHash,
            keccak256("report"),
            patchBytes
        );

        registry.submitPatchAccepted(
            EPOCH,
            MINER_A,
            PARENT_STATE,
            patchHash,
            keccak256("report"),
            patchBytes
        );

        assertEq(registry.patchCount(EPOCH), 1);
        vm.stopPrank();
    }

    function test_submitMultiplePatches() public {
        vm.startPrank(COORDINATOR);
        for (uint256 i = 0; i < 5; i++) {
            bytes memory pb = abi.encodePacked(i);
            registry.submitPatchAccepted(EPOCH, MINER_A, PARENT_STATE, keccak256(pb), keccak256("r"), pb);
        }
        assertEq(registry.patchCount(EPOCH), 5);
        vm.stopPrank();
    }

    function test_finalizeEpoch_emitsEvent() public {
        _finalizeEpoch(EPOCH);

        assertTrue(registry.epochFinalized(EPOCH));
        assertGt(registry.finalizedAt(EPOCH), 0);
    }

    function test_getHeader_afterFinalize() public {
        _finalizeEpoch(EPOCH);

        CortexRegistry.CortexHeader memory h = registry.getHeader(EPOCH);
        assertEq(h.epoch,                EPOCH);
        assertEq(h.stateRoot,            NEW_STATE);
        assertEq(h.coreVersionHash,      CORE_HASH);
        assertEq(h.experienceCorpusRoot, CORPUS_ROOT);
        assertEq(h.patchSetRoot,         PATCH_SET);
    }

    function test_cannotGetHeader_beforeFinalize() public {
        vm.expectRevert(CortexRegistry.NotFinalized.selector);
        registry.getHeader(EPOCH);
    }

    function test_cannotFinalizeEpoch_twice() public {
        _finalizeEpoch(EPOCH);
        vm.prank(COORDINATOR);
        vm.expectRevert(CortexRegistry.AlreadyFinalized.selector);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §2 – Snapshot emission
    // ═══════════════════════════════════════════════════════════════════

    function test_emitSnapshot_atInterval() public {
        uint64 snapEpoch = 100;
        _finalizeEpoch(snapEpoch);

        bytes memory fullState = new bytes(32768);
        // Fill with deterministic data.
        for (uint256 i = 0; i < 32768; i++) {
            fullState[i] = bytes1(uint8(i % 256));
        }

        vm.prank(COORDINATOR);
        vm.expectEmit(true, false, false, false, address(registry));
        emit CortexRegistry.CortexStateSnapshot(snapEpoch, NEW_STATE, fullState);
        registry.emitSnapshot(snapEpoch, fullState);
    }

    function test_emitSnapshot_wrongInterval_reverts() public {
        _finalizeEpoch(EPOCH); // epoch 1, not multiple of 100

        bytes memory fullState = new bytes(32768);
        vm.prank(COORDINATOR);
        vm.expectRevert(CortexRegistry.InvalidStateBytes.selector);
        registry.emitSnapshot(EPOCH, fullState);
    }

    function test_emitSnapshot_wrongSize_reverts() public {
        uint64 snapEpoch = 200;
        _finalizeEpoch(snapEpoch);

        bytes memory tooShort = new bytes(100);
        vm.prank(COORDINATOR);
        vm.expectRevert(CortexRegistry.InvalidStateBytes.selector);
        registry.emitSnapshot(snapEpoch, tooShort);
    }

    function test_emitSnapshot_beforeFinalize_reverts() public {
        uint64 snapEpoch = 100;
        bytes memory fullState = new bytes(32768);
        vm.prank(COORDINATOR);
        vm.expectRevert(CortexRegistry.NotFinalized.selector);
        registry.emitSnapshot(snapEpoch, fullState);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §3 – Audit window enforcement
    // ═══════════════════════════════════════════════════════════════════

    function test_auditWindowOpen_afterFinalization() public {
        _finalizeEpoch(EPOCH);
        assertTrue(registry.auditWindowOpen(EPOCH));
    }

    function test_auditWindowClosed_afterWindow() public {
        _finalizeEpoch(EPOCH);
        vm.warp(block.timestamp + 21600 + 1);
        assertFalse(registry.auditWindowOpen(EPOCH));
    }

    function test_fundEpoch_reverts_duringAuditWindow() public {
        _finalizeEpoch(EPOCH);
        // Still within window — should revert.
        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), 1 ether);
        vm.expectRevert(CortexMergeBonus.AuditWindowStillOpen.selector);
        bonus.fundEpoch(EPOCH, bytes32("root"), 1 ether);
        vm.stopPrank();
    }

    function test_fundEpoch_succeeds_afterWindow() public {
        _finalizeEpoch(EPOCH);
        vm.warp(block.timestamp + 21601);

        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), 100 ether);
        bonus.fundEpoch(EPOCH, bytes32("root"), 100 ether);
        vm.stopPrank();

        assertTrue(bonus.claimsOpen(EPOCH));
        assertEq(bonus.epochTotalBonus(EPOCH), 100 ether);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §4 – Multisig revert drill
    // ═══════════════════════════════════════════════════════════════════

    function test_revert_twoOfN_succeeds() public {
        _finalizeEpoch(EPOCH);

        vm.prank(OPERATOR_A);
        registry.voteRevertEpoch(EPOCH);

        // After first vote, epoch should NOT yet be reverted (threshold = 2).
        assertFalse(registry.epochReverted(EPOCH));
        assertTrue(registry.epochFinalized(EPOCH)); // still finalized

        vm.prank(OPERATOR_B);
        registry.voteRevertEpoch(EPOCH);

        // Now threshold met.
        assertTrue(registry.epochReverted(EPOCH));
        assertFalse(registry.epochFinalized(EPOCH));
        assertEq(registry.revertVoteCount(EPOCH), 2);
    }

    function test_revert_oneOfN_fails() public {
        _finalizeEpoch(EPOCH);

        vm.prank(OPERATOR_A);
        registry.voteRevertEpoch(EPOCH);

        // Only one vote — epoch still finalized, not reverted.
        assertFalse(registry.epochReverted(EPOCH));
        assertTrue(registry.epochFinalized(EPOCH));
    }

    function test_revert_afterWindowClose_fails() public {
        _finalizeEpoch(EPOCH);
        vm.warp(block.timestamp + 21601);

        vm.prank(OPERATOR_A);
        vm.expectRevert(CortexRegistry.AuditWindowClosed.selector);
        registry.voteRevertEpoch(EPOCH);
    }

    function test_revert_doubleVote_fails() public {
        _finalizeEpoch(EPOCH);

        vm.prank(OPERATOR_A);
        registry.voteRevertEpoch(EPOCH);

        vm.prank(OPERATOR_A);
        vm.expectRevert(CortexRegistry.AlreadyVoted.selector);
        registry.voteRevertEpoch(EPOCH);
    }

    function test_revert_nonOperator_fails() public {
        _finalizeEpoch(EPOCH);

        vm.prank(ATTACKER);
        vm.expectRevert(CortexRegistry.NotOperator.selector);
        registry.voteRevertEpoch(EPOCH);
    }

    function test_revert_preventsBonus_funding() public {
        _finalizeEpoch(EPOCH);

        // Revert the epoch.
        vm.prank(OPERATOR_A);
        registry.voteRevertEpoch(EPOCH);
        vm.prank(OPERATOR_B);
        registry.voteRevertEpoch(EPOCH);

        // Move past audit window.
        vm.warp(block.timestamp + 21601);

        // Funding should now fail because epoch was reverted.
        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), 100 ether);
        vm.expectRevert(CortexMergeBonus.EpochWasReverted.selector);
        bonus.fundEpoch(EPOCH, bytes32("root"), 100 ether);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════
    // §5 – CortexMergeBonus claim (Merkle)
    // ═══════════════════════════════════════════════════════════════════

    function test_claimMergeBonus_valid() public {
        uint256 bonusAmt = 50 ether;
        uint256 capAmt   = 50 ether;
        bytes32 root;
        bytes32[] memory proof;

        (root, proof) = _buildSingleLeafMerkle(MINER_A, bonusAmt, capAmt);

        _finalizeAndFund(EPOCH, root, bonusAmt);

        uint64[] memory epochs = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps = new uint256[](1);
        caps[0] = capAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = proof;

        uint256 balBefore = token.balanceOf(MINER_A);
        vm.prank(MINER_A);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);

        assertEq(token.balanceOf(MINER_A) - balBefore, bonusAmt);
        assertTrue(bonus.claimed(EPOCH, MINER_A));
    }

    function test_claimMergeBonus_invalidProof_reverts() public {
        uint256 bonusAmt = 10 ether;
        uint256 capAmt   = 10 ether;
        bytes32 root;
        bytes32[] memory proof;

        (root, proof) = _buildSingleLeafMerkle(MINER_A, bonusAmt, capAmt);

        _finalizeAndFund(EPOCH, root, bonusAmt);

        // MINER_B tries to claim with MINER_A's proof — leaf won't match.
        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = capAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = proof;

        vm.prank(MINER_B);
        vm.expectRevert(CortexMergeBonus.InvalidProof.selector);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);
    }

    function test_claimMergeBonus_bonusExceedsCap_reverts() public {
        uint256 bonusAmt = 60 ether;
        uint256 capAmt   = 50 ether; // cap < bonus
        bytes32 root;
        bytes32[] memory proof;

        (root, proof) = _buildSingleLeafMerkle(MINER_A, bonusAmt, capAmt);

        // Fund with the cap amount as the root includes the smaller capAmt.
        _finalizeAndFund(EPOCH, root, bonusAmt);

        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = capAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = proof;

        vm.prank(MINER_A);
        vm.expectRevert(CortexMergeBonus.BonusExceedsCap.selector);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);
    }

    function test_claimMergeBonus_doubleClaimReverts() public {
        uint256 bonusAmt = 10 ether;
        uint256 capAmt   = 10 ether;
        bytes32 root;
        bytes32[] memory proof;
        (root, proof) = _buildSingleLeafMerkle(MINER_A, bonusAmt, capAmt);
        _finalizeAndFund(EPOCH, root, bonusAmt);

        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = capAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = proof;

        vm.prank(MINER_A);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);

        vm.prank(MINER_A);
        vm.expectRevert(CortexMergeBonus.AlreadyClaimed.selector);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §6 – Pool-mode claim
    // ═══════════════════════════════════════════════════════════════════

    function test_triggerMergeBonusClaim_pool() public {
        uint256 bonusAmt = 20 ether;
        uint256 capAmt   = 20 ether;
        bytes32 root;
        bytes32[] memory proof;
        (root, proof) = _buildSingleLeafMerkle(MINER_A, bonusAmt, capAmt);
        _finalizeAndFund(EPOCH, root, bonusAmt);

        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = capAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = proof;

        uint256 before = token.balanceOf(MINER_A);
        vm.prank(POOL);
        bonus.triggerMergeBonusClaim(epochs, MINER_A, bonuses, caps, proofs);

        assertEq(token.balanceOf(MINER_A) - before, bonusAmt);
        assertTrue(bonus.claimed(EPOCH, MINER_A));
    }

    // ═══════════════════════════════════════════════════════════════════
    // §7 – Pause matrix
    // ═══════════════════════════════════════════════════════════════════

    function test_pauseRegistry_blocksFinalisation() public {
        vm.prank(OWNER);
        registry.pause();

        vm.prank(COORDINATOR);
        vm.expectRevert(); // Pausable: EnforcedPause
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
    }

    function test_pauseRegistry_blocksSubmitPatch() public {
        vm.prank(OWNER);
        registry.pause();

        bytes memory pb = bytes("patch");
        vm.prank(COORDINATOR);
        vm.expectRevert();
        registry.submitPatchAccepted(EPOCH, MINER_A, PARENT_STATE, keccak256(pb), keccak256("r"), pb);
    }

    function test_pauseBonus_blocksClaims() public {
        uint256 bonusAmt = 5 ether;
        uint256 capAmt   = 5 ether;
        bytes32 root;
        bytes32[] memory proof;
        (root, proof) = _buildSingleLeafMerkle(MINER_A, bonusAmt, capAmt);
        _finalizeAndFund(EPOCH, root, bonusAmt);

        vm.prank(OWNER);
        bonus.pause();

        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = capAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = proof;

        vm.prank(MINER_A);
        vm.expectRevert(); // EnforcedPause
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);
    }

    function test_pauseRegistry_doesNotAffectBonus() public {
        // Registry is paused, but bonus claims on already-funded epochs still work.
        uint256 bonusAmt = 5 ether;
        uint256 capAmt   = 5 ether;
        bytes32 root;
        bytes32[] memory proof;
        (root, proof) = _buildSingleLeafMerkle(MINER_A, bonusAmt, capAmt);
        _finalizeAndFund(EPOCH, root, bonusAmt);

        vm.prank(OWNER);
        registry.pause();

        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = capAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = proof;

        // Bonus claim should still succeed.
        vm.prank(MINER_A);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);
        assertEq(token.balanceOf(MINER_A), bonusAmt);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §8 – SWCP non-interference (MockBotcoinMiningV3)
    // ═══════════════════════════════════════════════════════════════════

    function test_swcp_unaffected_when_registry_paused() public {
        vm.prank(OWNER);
        registry.pause();

        // MockBotcoinMiningV3 nextIndex / receipt operations are independent.
        uint64 before = mockMining.nextIndex(MINER_A);
        mockMining.incrementNextIndex(MINER_A);
        assertEq(mockMining.nextIndex(MINER_A), before + 1);
    }

    function test_swcp_unaffected_when_registry_absent() public {
        // Deploy bonus with address(0) registry — simulates absent Cortex.
        CortexMergeBonus bonusNoReg = new CortexMergeBonus(address(token), address(0), COORDINATOR);

        // MockBotcoinMiningV3 still works.
        uint64 before = mockMining.nextIndex(MINER_A);
        mockMining.incrementNextIndex(MINER_A);
        assertEq(mockMining.nextIndex(MINER_A), before + 1);
        // bonusNoReg registry is address(0) — confirmed not reverting on construction.
        assertEq(address(bonusNoReg.registry()), address(0));
    }

    // ═══════════════════════════════════════════════════════════════════
    // §9 – Shard commit/reveal
    // ═══════════════════════════════════════════════════════════════════

    function test_shardCommitReveal_happyPath() public {
        bytes32 seed   = keccak256("secret-seed-epoch-1");
        bytes32 commit = keccak256(abi.encodePacked(seed));

        vm.prank(COORDINATOR);
        vm.expectEmit(true, false, false, true, address(registry));
        emit CortexRegistry.CortexShardCommitted(EPOCH, commit);
        registry.commitShard(EPOCH, commit);

        vm.prank(COORDINATOR);
        vm.expectEmit(true, false, false, true, address(registry));
        emit CortexRegistry.CortexShardRevealed(EPOCH, seed);
        registry.revealShard(EPOCH, seed);

        assertEq(registry.shardSeed(EPOCH), seed);
    }

    function test_shardReveal_wrongSeed_reverts() public {
        bytes32 seed   = keccak256("secret");
        bytes32 commit = keccak256(abi.encodePacked(seed));

        vm.prank(COORDINATOR);
        registry.commitShard(EPOCH, commit);

        vm.prank(COORDINATOR);
        vm.expectRevert(CortexRegistry.ShardCommitMismatch.selector);
        registry.revealShard(EPOCH, keccak256("wrong"));
    }

    function test_shardCommit_duplicate_reverts() public {
        bytes32 commit = keccak256("c");
        vm.prank(COORDINATOR);
        registry.commitShard(EPOCH, commit);
        vm.prank(COORDINATOR);
        vm.expectRevert(CortexRegistry.ShardAlreadyCommitted.selector);
        registry.commitShard(EPOCH, commit);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §10 – Access control
    // ═══════════════════════════════════════════════════════════════════

    function test_nonCoordinator_cannotFinalizeEpoch() public {
        vm.prank(ATTACKER);
        vm.expectRevert(CortexRegistry.NotCoordinator.selector);
        registry.finalizeEpoch(EPOCH, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
    }

    function test_nonCoordinator_cannotSubmitPatch() public {
        bytes memory pb = bytes("x");
        vm.prank(ATTACKER);
        vm.expectRevert(CortexRegistry.NotCoordinator.selector);
        registry.submitPatchAccepted(EPOCH, MINER_A, PARENT_STATE, keccak256(pb), keccak256("r"), pb);
    }

    function test_nonOwner_cannotPause() public {
        vm.prank(ATTACKER);
        vm.expectRevert(); // Ownable: caller not owner
        registry.pause();
    }

    // ═══════════════════════════════════════════════════════════════════
    // §11 – Snapshot reconstruction parity (Merkle-only, contract-side)
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Verifies that two finalized epochs at boundary share the same
    ///      stateRoot under the snapshot model: the snapshot at e_k captures
    ///      newStateRoot, and then patches in (e_k, e_n] update state further.
    ///      Contract-side: we just assert that emitSnapshot always records
    ///      the header stateRoot, providing the anchor for off-chain replay.
    function test_snapshotReconstruction_stateRootAnchor() public {
        uint64 snapEpoch = 100;
        bytes32 snap_state = keccak256("snap_new_state");

        vm.prank(COORDINATOR);
        registry.finalizeEpoch(
            snapEpoch,
            PARENT_STATE,
            PATCH_SET,
            snap_state,
            CORE_HASH,
            BENCHMARK,
            CORPUS_ROOT,
            SCORE_ROOT
        );

        bytes memory fullState = new bytes(32768);
        vm.prank(COORDINATOR);
        vm.expectEmit(true, false, false, true, address(registry));
        emit CortexRegistry.CortexStateSnapshot(snapEpoch, snap_state, fullState);
        registry.emitSnapshot(snapEpoch, fullState);

        // The snapshot stateRoot matches the finalized header.
        CortexRegistry.CortexHeader memory h = registry.getHeader(snapEpoch);
        assertEq(h.stateRoot, snap_state);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §12 – Multi-epoch bonus claim
    // ═══════════════════════════════════════════════════════════════════

    function test_multiEpoch_claim() public {
        uint64 E2 = 2;
        uint256 amt1 = 10 ether;
        uint256 amt2 = 20 ether;

        bytes32 root1;
        bytes32[] memory proof1;
        (root1, proof1) = _buildSingleLeafMerkle(MINER_A, amt1, amt1);
        _finalizeAndFund(EPOCH, root1, amt1);

        // Finalize epoch 2 separately.
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(E2, PARENT_STATE, PATCH_SET, keccak256("s2"), CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
        vm.warp(block.timestamp + 21601);

        bytes32 root2;
        bytes32[] memory proof2;
        (root2, proof2) = _buildSingleLeafMerkle(MINER_A, amt2, amt2);

        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), amt2);
        bonus.fundEpoch(E2, root2, amt2);
        vm.stopPrank();

        uint64[] memory epochs   = new uint64[](2);
        epochs[0] = EPOCH; epochs[1] = E2;
        uint256[] memory bonuses = new uint256[](2);
        bonuses[0] = amt1; bonuses[1] = amt2;
        uint256[] memory caps    = new uint256[](2);
        caps[0] = amt1; caps[1] = amt2;
        bytes32[][] memory proofs = new bytes32[][](2);
        proofs[0] = proof1;
        proofs[1] = proof2;

        uint256 before = token.balanceOf(MINER_A);
        vm.prank(MINER_A);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);

        assertEq(token.balanceOf(MINER_A) - before, amt1 + amt2);
    }

    // ═══════════════════════════════════════════════════════════════════
    // §13 – Unpause restores functionality
    // ═══════════════════════════════════════════════════════════════════

    function test_unpause_restoresFunctionality() public {
        vm.prank(OWNER);
        registry.pause();

        vm.prank(OWNER);
        registry.unpause();

        // Should succeed now.
        _finalizeEpoch(EPOCH);
        assertTrue(registry.epochFinalized(EPOCH));
    }

    // ═══════════════════════════════════════════════════════════════════
    // §14 – Fuzz tests
    // ═══════════════════════════════════════════════════════════════════

    function testFuzz_submitPatchAccepted(
        address miner,
        bytes32 parentRoot,
        bytes32 patchHash,
        bytes32 reportHash,
        bytes calldata patchBytes
    ) public {
        vm.assume(miner != address(0));
        vm.assume(patchBytes.length < 500); // realistic budget

        vm.prank(COORDINATOR);
        registry.submitPatchAccepted(EPOCH, miner, parentRoot, patchHash, reportHash, patchBytes);
        assertEq(registry.patchCount(EPOCH), 1);
    }

    function testFuzz_bonusCap(uint256 bonusAmt, uint256 capAmt) public {
        vm.assume(bonusAmt > 0 && bonusAmt <= 1_000_000 ether);
        vm.assume(capAmt > 0 && capAmt <= 1_000_000 ether);
        vm.assume(bonusAmt <= capAmt); // only valid case

        bytes32 root;
        bytes32[] memory proof;
        (root, proof) = _buildSingleLeafMerkle(MINER_A, bonusAmt, capAmt);

        // Fund with bonusAmt (coordinator can fund up to bonusAmt).
        uint256 funded = bonusAmt;
        _finalizeAndFundAmt(EPOCH, root, funded);

        uint64[] memory epochs   = new uint64[](1);
        epochs[0] = EPOCH;
        uint256[] memory bonuses = new uint256[](1);
        bonuses[0] = bonusAmt;
        uint256[] memory caps    = new uint256[](1);
        caps[0] = capAmt;
        bytes32[][] memory proofs = new bytes32[][](1);
        proofs[0] = proof;

        vm.prank(MINER_A);
        bonus.claimMergeBonus(epochs, bonuses, caps, proofs);
        assertTrue(bonus.claimed(EPOCH, MINER_A));
    }

    // ═══════════════════════════════════════════════════════════════════
    // Internal helpers
    // ═══════════════════════════════════════════════════════════════════

    function _finalizeEpoch(uint64 epoch) internal {
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(epoch, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
    }

    function _finalizeAndFund(uint64 epoch, bytes32 root, uint256 amount) internal {
        _finalizeEpoch(epoch);
        vm.warp(block.timestamp + 21601);

        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), amount);
        bonus.fundEpoch(epoch, root, amount);
        vm.stopPrank();
    }

    function _finalizeAndFundAmt(uint64 epoch, bytes32 root, uint256 amount) internal {
        vm.prank(COORDINATOR);
        registry.finalizeEpoch(epoch, PARENT_STATE, PATCH_SET, NEW_STATE, CORE_HASH, BENCHMARK, CORPUS_ROOT, SCORE_ROOT);
        vm.warp(block.timestamp + 21601);

        vm.startPrank(COORDINATOR);
        token.approve(address(bonus), amount);
        bonus.fundEpoch(epoch, root, amount);
        vm.stopPrank();
    }

    /// @notice Build a single-leaf Merkle tree and return (root, emptyProof).
    ///         For a single leaf, root == leaf and proof is empty.
    function _buildSingleLeafMerkle(
        address miner,
        uint256 bonusAmt,
        uint256 capAmt
    ) internal pure returns (bytes32 root, bytes32[] memory proof) {
        root  = keccak256(abi.encodePacked(miner, bonusAmt, capAmt));
        proof = new bytes32[](0); // single-leaf Merkle: no siblings needed
    }
}
