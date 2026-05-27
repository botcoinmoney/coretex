// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoreTexRegistry} from "../src/CoreTexRegistry.sol";

contract CoreTexRegistryTest is Test {
    CoreTexRegistry reg;
    address owner = address(0xA11CE);
    address coord = address(0xC007D);
    address miner = address(0x111111);

    bytes32 constant PARENT = bytes32(uint256(0x1111));
    bytes32 constant CHILD1 = bytes32(uint256(0x2222));
    bytes32 constant CHILD2 = bytes32(uint256(0x3333));
    bytes32 constant CVH   = bytes32(uint256(0xBEEF));
    bytes32 constant CORPUS = bytes32(uint256(0xC0FFEE));
    bytes32 constant FRONTIER = bytes32(uint256(0xF00D));
    bytes32 constant BASELINE = bytes32(uint256(0xBA5E));
    bytes32 constant SEEDCOMMIT = bytes32(uint256(0x5EED));
    bytes32 constant PATCH1 = bytes32(uint256(0xAA01));
    bytes32 constant PATCH2 = bytes32(uint256(0xAA02));
    bytes32 constant EVAL1  = bytes32(uint256(0xEE01));

    event CoreTexEpochStarted(uint64 indexed epoch, bytes32 parentStateRoot, bytes32 coreVersionHash, bytes32 corpusRoot, bytes32 activeFrontierRoot, bytes32 baselineManifestHash, bytes32 hiddenSeedCommit);
    event CoreTexStateAdvanced(uint64 indexed epoch, uint64 indexed transitionIndex, address indexed miner, bytes32 parentStateRoot, bytes32 newStateRoot, bytes32 patchHash, bytes32 evalReportHash, bytes32 coreVersionHash, bytes32 corpusRoot, bytes32 activeFrontierRoot, uint256 improvementCredits, uint16 wordCount, bytes compactPatchBytes);
    event CoreTexEpochFinalized(uint64 indexed epoch, bytes32 parentStateRoot, bytes32 finalStateRoot, bytes32 coreVersionHash, bytes32 corpusRoot, bytes32 activeFrontierRoot, bytes32 patchSetRoot, bytes32 scoreRoot, bytes32 baselineManifestHash);

    function setUp() public {
        reg = new CoreTexRegistry(owner, coord);
    }

    function _start(uint64 epoch) internal {
        vm.prank(coord);
        reg.startEpoch(epoch, PARENT, CVH, CORPUS, FRONTIER, BASELINE, SEEDCOMMIT);
    }

    function _advance(uint64 epoch, bytes32 parent, bytes32 child, bytes32 patch) internal {
        vm.prank(coord);
        reg.submitStateAdvance(epoch, miner, parent, child, patch, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    // ── startEpoch ──
    function test_startEpoch_pinsRootsAndEmits() public {
        vm.expectEmit(true, false, false, true);
        emit CoreTexEpochStarted(7, PARENT, CVH, CORPUS, FRONTIER, BASELINE, SEEDCOMMIT);
        _start(7);
        assertTrue(reg.epochStarted(7));
        assertEq(reg.epochParentStateRoot(7), PARENT);
        assertEq(reg.liveStateRoot(7), PARENT, "live seeded to parent");
        assertEq(reg.transitionCount(7), 0);
    }

    function test_startEpoch_duplicateReverts() public {
        _start(7);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.EpochAlreadyStarted.selector);
        reg.startEpoch(7, PARENT, CVH, CORPUS, FRONTIER, BASELINE, SEEDCOMMIT);
    }

    function test_startEpoch_nonCoordinatorReverts() public {
        vm.prank(miner);
        vm.expectRevert(CoreTexRegistry.NotCoordinator.selector);
        reg.startEpoch(7, PARENT, CVH, CORPUS, FRONTIER, BASELINE, SEEDCOMMIT);
    }

    // ── critical fix: no advance before start, no arbitrary first parent ──
    function test_advanceBeforeStartReverts() public {
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.EpochNotStarted.selector);
        reg.submitStateAdvance(7, miner, PARENT, CHILD1, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_firstAdvanceFromArbitraryParentReverts() public {
        _start(7);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.ParentRootMismatch.selector);
        reg.submitStateAdvance(7, miner, bytes32(uint256(0xDEAD)), CHILD1, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    // ── advance happy path + ordering ──
    function test_advance_emitsAndAdvancesLiveRoot() public {
        _start(7);
        vm.expectEmit(true, true, true, true);
        emit CoreTexStateAdvanced(7, 0, miner, PARENT, CHILD1, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
        _advance(7, PARENT, CHILD1, PATCH1);
        assertEq(reg.liveStateRoot(7), CHILD1);
        assertEq(reg.transitionCount(7), 1);
    }

    function test_multipleAdvancesInOrder() public {
        _start(7);
        _advance(7, PARENT, CHILD1, PATCH1);
        _advance(7, CHILD1, CHILD2, PATCH2);
        assertEq(reg.liveStateRoot(7), CHILD2);
        assertEq(reg.transitionCount(7), 2);
    }

    function test_secondAdvanceWrongParentReverts() public {
        _start(7);
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.ParentRootMismatch.selector);
        reg.submitStateAdvance(7, miner, PARENT /* stale */, CHILD2, PATCH2, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_advance_zeroPatchHashReverts() public {
        _start(7);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.ZeroPatchHash.selector);
        reg.submitStateAdvance(7, miner, PARENT, CHILD1, bytes32(0), EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_advance_noOpReverts() public {
        _start(7);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.NoOpAdvance.selector);
        reg.submitStateAdvance(7, miner, PARENT, PARENT, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_advance_coreVersionMismatchReverts() public {
        _start(7);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.CoreVersionMismatch.selector);
        reg.submitStateAdvance(7, miner, PARENT, CHILD1, PATCH1, EVAL1, bytes32(uint256(0xBAD)), CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_advance_corpusRootMismatchReverts() public {
        _start(7);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.CorpusRootMismatch.selector);
        reg.submitStateAdvance(7, miner, PARENT, CHILD1, PATCH1, EVAL1, CVH, bytes32(uint256(0xBAD)), FRONTIER, 30000, 3, hex"ff03");
    }

    // ── finalize ──
    function test_finalize_happyPath() public {
        _start(7);
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.expectEmit(true, false, false, true);
        emit CoreTexEpochFinalized(7, PARENT, CHILD1, CVH, CORPUS, FRONTIER, bytes32(uint256(0x9001)), bytes32(uint256(0x9002)), BASELINE);
        vm.prank(coord);
        reg.finalizeEpoch(7, CHILD1, CVH, CORPUS, FRONTIER, bytes32(uint256(0x9001)), bytes32(uint256(0x9002)), BASELINE);
        assertTrue(reg.epochFinalized(7));
        CoreTexRegistry.EpochHeader memory h = reg.getHeader(7);
        assertEq(h.finalStateRoot, CHILD1);
        assertEq(h.parentStateRoot, PARENT);
    }

    function test_finalize_wrongFinalRootReverts() public {
        _start(7);
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.FinalRootMismatch.selector);
        reg.finalizeEpoch(7, CHILD2, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
    }

    function test_advanceAfterFinalizeReverts() public {
        _start(7);
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(coord);
        reg.finalizeEpoch(7, CHILD1, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.AlreadyFinalized.selector);
        reg.submitStateAdvance(7, miner, CHILD1, CHILD2, PATCH2, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    // ── owner revert within audit window ──
    function test_ownerRevertWithinWindow() public {
        _start(7);
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(coord);
        reg.finalizeEpoch(7, CHILD1, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
        vm.prank(owner);
        reg.ownerRevertEpoch(7);
        assertFalse(reg.epochFinalized(7));
        assertTrue(reg.epochReverted(7));
    }

    function test_ownerRevertAfterWindowReverts() public {
        _start(7);
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(coord);
        reg.finalizeEpoch(7, CHILD1, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
        vm.warp(block.timestamp + reg.CHALLENGE_WINDOW_SECONDS() + 1);
        vm.prank(owner);
        vm.expectRevert(CoreTexRegistry.AuditWindowClosed.selector);
        reg.ownerRevertEpoch(7);
    }
}
