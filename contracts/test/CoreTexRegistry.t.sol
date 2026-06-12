// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CoreTexRegistry} from "../src/CoreTexRegistry.sol";

contract MockV4Context {
    struct Ctx {
        bool set;
        bytes32 parent;
        bytes32 coreVersion;
        bytes32 corpus;
        bytes32 frontier;
        bytes32 baseline;
        bytes32 commit;
    }

    mapping(uint64 => Ctx) public ctx;

    function setContext(
        uint64 epoch,
        bytes32 parent,
        bytes32 coreVersion,
        bytes32 corpus,
        bytes32 frontier,
        bytes32 baseline,
        bytes32 commit
    ) external {
        ctx[epoch] = Ctx(true, parent, coreVersion, corpus, frontier, baseline, commit);
    }

    function coreTexEpochContextSet(uint64 epoch) external view returns (bool) {
        return ctx[epoch].set;
    }

    function coreTexParentStateRoot(uint64 epoch) external view returns (bytes32) {
        return ctx[epoch].parent;
    }

    function coreTexCoreVersionHash(uint64 epoch) external view returns (bytes32) {
        return ctx[epoch].coreVersion;
    }

    function coreTexCorpusRoot(uint64 epoch) external view returns (bytes32) {
        return ctx[epoch].corpus;
    }

    function coreTexActiveFrontierRoot(uint64 epoch) external view returns (bytes32) {
        return ctx[epoch].frontier;
    }

    function coreTexBaselineManifestHash(uint64 epoch) external view returns (bytes32) {
        return ctx[epoch].baseline;
    }

    function epochCommit(uint64 epoch) external view returns (bytes32) {
        return ctx[epoch].commit;
    }
}

contract CoreTexRegistryTest is Test {
    CoreTexRegistry reg;
    MockV4Context v4;
    address owner = address(0xA11CE);
    address coord = address(0xC007D);
    address miner = address(0x111111);

    bytes32 constant PARENT = bytes32(uint256(0x1111));
    bytes32 constant CHILD1 = bytes32(uint256(0x2222));
    bytes32 constant CHILD2 = bytes32(uint256(0x3333));
    bytes32 constant CVH = bytes32(uint256(0xBEEF));
    bytes32 constant CORPUS = bytes32(uint256(0xC0FFEE));
    bytes32 constant FRONTIER = bytes32(uint256(0xF00D));
    bytes32 constant BASELINE = bytes32(uint256(0xBA5E));
    bytes32 constant SEEDCOMMIT = bytes32(uint256(0x5EED));
    bytes32 constant PATCH1 = bytes32(uint256(0xAA01));
    bytes32 constant PATCH2 = bytes32(uint256(0xAA02));
    bytes32 constant EVAL1 = bytes32(uint256(0xEE01));

    event CoreTexStateAdvanced(
        uint64 indexed epoch,
        uint64 indexed transitionIndex,
        address indexed miner,
        bytes32 parentStateRoot,
        bytes32 newStateRoot,
        bytes32 patchHash,
        bytes32 evalReportHash,
        bytes32 coreVersionHash,
        bytes32 corpusRoot,
        bytes32 activeFrontierRoot,
        uint256 improvementCredits,
        uint16 wordCount,
        bytes compactPatchBytes
    );
    event CoreTexEpochFinalized(
        uint64 indexed epoch,
        bytes32 parentStateRoot,
        bytes32 finalStateRoot,
        bytes32 coreVersionHash,
        bytes32 corpusRoot,
        bytes32 activeFrontierRoot,
        bytes32 patchSetRoot,
        bytes32 scoreRoot,
        bytes32 baselineManifestHash
    );
    event BotcoinMiningV4Updated(address indexed oldMiningContract, address indexed newMiningContract);

    function setUp() public {
        reg = new CoreTexRegistry(owner, coord);
        v4 = new MockV4Context();
        v4.setContext(7, PARENT, CVH, CORPUS, FRONTIER, BASELINE, SEEDCOMMIT);
        vm.prank(owner);
        reg.setBotcoinMiningV4(address(v4));
    }

    function _advanceN(uint64 epoch, uint256 n) internal returns (bytes32 parent) {
        parent = reg.liveStateRoot(epoch);
        for (uint256 i; i < n; i++) {
            bytes32 child = keccak256(abi.encodePacked("root", epoch, i));
            vm.prank(address(v4));
            reg.submitStateAdvance(
                epoch, miner, parent, child, keccak256(abi.encodePacked("p", epoch, i)),
                EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03"
            );
            parent = child;
        }
    }

    function _advance(uint64 epoch, bytes32 parent, bytes32 child, bytes32 patch) internal {
        vm.prank(address(v4));
        reg.submitStateAdvance(epoch, miner, parent, child, patch, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_contextViewsReadV4AndLiveRootFallsBackToParent() public {
        assertEq(reg.epochParentStateRoot(7), PARENT);
        assertEq(reg.liveStateRoot(7), PARENT);
        assertEq(reg.epochActiveFrontierRoot(7), FRONTIER);
        assertEq(reg.epochBaselineManifestHash(7), BASELINE);
        assertEq(reg.epochHiddenSeedCommit(7), SEEDCOMMIT);
        assertEq(reg.transitionCount(7), 0);
    }

    function test_ownerCanUpdateBotcoinMiningV4Pointer() public {
        MockV4Context replacement = new MockV4Context();
        replacement.setContext(7, CHILD1, CVH, CORPUS, FRONTIER, BASELINE, SEEDCOMMIT);

        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit BotcoinMiningV4Updated(address(v4), address(replacement));
        reg.setBotcoinMiningV4(address(replacement));

        assertEq(reg.botcoinMiningV4(), address(replacement));
        assertEq(reg.liveStateRoot(7), CHILD1);
    }

    function test_missingContextReverts() public {
        vm.prank(address(v4));
        vm.expectRevert(CoreTexRegistry.EpochContextNotSet.selector);
        reg.submitStateAdvance(8, miner, PARENT, CHILD1, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_firstAdvanceFromArbitraryParentReverts() public {
        vm.prank(address(v4));
        vm.expectRevert(CoreTexRegistry.ParentRootMismatch.selector);
        reg.submitStateAdvance(
            7, miner, bytes32(uint256(0xDEAD)), CHILD1, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03"
        );
    }

    function test_directCoordinatorEoaAdvanceReverts() public {
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.NotBotcoinMiningV4.selector);
        reg.submitStateAdvance(7, miner, PARENT, CHILD1, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_nonV4AdvanceReverts() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(CoreTexRegistry.NotBotcoinMiningV4.selector);
        reg.submitStateAdvance(7, miner, PARENT, CHILD1, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_advance_emitsAndAdvancesLiveRoot() public {
        vm.expectEmit(true, true, true, true);
        emit CoreTexStateAdvanced(
            7, 0, miner, PARENT, CHILD1, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03"
        );
        _advance(7, PARENT, CHILD1, PATCH1);
        assertEq(reg.liveStateRoot(7), CHILD1);
        assertEq(reg.transitionCount(7), 1);
    }

    function test_multipleAdvancesInOrder() public {
        _advance(7, PARENT, CHILD1, PATCH1);
        _advance(7, CHILD1, CHILD2, PATCH2);
        assertEq(reg.liveStateRoot(7), CHILD2);
        assertEq(reg.transitionCount(7), 2);
    }

    function test_secondAdvanceWrongParentReverts() public {
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(address(v4));
        vm.expectRevert(CoreTexRegistry.ParentRootMismatch.selector);
        reg.submitStateAdvance(7, miner, PARENT, CHILD2, PATCH2, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_advance_zeroPatchHashReverts() public {
        vm.prank(address(v4));
        vm.expectRevert(CoreTexRegistry.ZeroPatchHash.selector);
        reg.submitStateAdvance(7, miner, PARENT, CHILD1, bytes32(0), EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_advance_noOpReverts() public {
        vm.prank(address(v4));
        vm.expectRevert(CoreTexRegistry.NoOpAdvance.selector);
        reg.submitStateAdvance(7, miner, PARENT, PARENT, PATCH1, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_advance_coreVersionMismatchReverts() public {
        vm.prank(address(v4));
        vm.expectRevert(CoreTexRegistry.CoreVersionMismatch.selector);
        reg.submitStateAdvance(
            7, miner, PARENT, CHILD1, PATCH1, EVAL1, bytes32(uint256(0xBAD)), CORPUS, FRONTIER, 30000, 3, hex"ff03"
        );
    }

    function test_advance_corpusRootMismatchReverts() public {
        vm.prank(address(v4));
        vm.expectRevert(CoreTexRegistry.CorpusRootMismatch.selector);
        reg.submitStateAdvance(
            7, miner, PARENT, CHILD1, PATCH1, EVAL1, CVH, bytes32(uint256(0xBAD)), FRONTIER, 30000, 3, hex"ff03"
        );
    }

    function test_advance_activeFrontierMismatchReverts() public {
        vm.prank(address(v4));
        vm.expectRevert(CoreTexRegistry.ActiveFrontierMismatch.selector);
        reg.submitStateAdvance(
            7, miner, PARENT, CHILD1, PATCH1, EVAL1, CVH, CORPUS, bytes32(uint256(0xBAD)), 30000, 3, hex"ff03"
        );
    }

    function test_finalize_happyPath() public {
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.expectEmit(true, false, false, true);
        emit CoreTexEpochFinalized(
            7, PARENT, CHILD1, CVH, CORPUS, FRONTIER, bytes32(uint256(0x9001)), bytes32(uint256(0x9002)), BASELINE
        );
        vm.prank(coord);
        reg.finalizeEpoch(
            7, CHILD1, CVH, CORPUS, FRONTIER, bytes32(uint256(0x9001)), bytes32(uint256(0x9002)), BASELINE
        );
        assertTrue(reg.epochFinalized(7));
        CoreTexRegistry.EpochHeader memory h = reg.getHeader(7);
        assertEq(h.finalStateRoot, CHILD1);
        assertEq(h.parentStateRoot, PARENT);
    }

    function test_finalize_wrongFinalRootReverts() public {
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.FinalRootMismatch.selector);
        reg.finalizeEpoch(7, CHILD2, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
    }

    function test_finalize_activeFrontierMismatchReverts() public {
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(coord);
        vm.expectRevert(CoreTexRegistry.ActiveFrontierMismatch.selector);
        reg.finalizeEpoch(7, CHILD1, CVH, CORPUS, bytes32(uint256(0xBAD)), bytes32(0), bytes32(0), BASELINE);
    }

    function test_advanceAfterFinalizeReverts() public {
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(coord);
        reg.finalizeEpoch(7, CHILD1, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
        vm.prank(address(v4));
        vm.expectRevert(CoreTexRegistry.AlreadyFinalized.selector);
        reg.submitStateAdvance(7, miner, CHILD1, CHILD2, PATCH2, EVAL1, CVH, CORPUS, FRONTIER, 30000, 3, hex"ff03");
    }

    function test_finalizeRecordsHeaderAndTimestamp() public {
        _advance(7, PARENT, CHILD1, PATCH1);
        vm.prank(coord);
        reg.finalizeEpoch(7, CHILD1, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
        assertTrue(reg.epochFinalized(7));
        assertEq(reg.finalizedAt(7), block.timestamp);
        CoreTexRegistry.EpochHeader memory h = reg.getHeader(7);
        assertEq(h.parentStateRoot, PARENT);
        assertEq(h.finalStateRoot, CHILD1);
    }

    function test_noOnChainAdvanceCap_largeNumberOfAdvancesAccepted() public {
        bytes32 last = _advanceN(7, 64);
        assertEq(reg.transitionCount(7), 64);
        assertEq(reg.liveStateRoot(7), last);
        vm.prank(coord);
        reg.finalizeEpoch(7, last, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
        assertTrue(reg.epochFinalized(7));
    }
}
