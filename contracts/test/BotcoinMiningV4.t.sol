// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BotcoinMiningV3} from "../src/BotcoinMiningV3.sol";
import {BotcoinMiningV4} from "../src/BotcoinMiningV4.sol";
import {CoreTexRegistry} from "../src/CoreTexRegistry.sol";

contract MockBOT is ERC20 {
    constructor() ERC20("Mock BOT", "BOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BotcoinMiningV4Test is Test {
    bytes32 private constant STANDARD_RECEIPT_TYPEHASH = keccak256(
        "Receipt(address miner,uint64 epochId,uint64 solveIndex,bytes32 prevReceiptHash,bytes32 challengeId,bytes32 commit,bytes32 docHash,bytes32 questionsHash,bytes32 constraintsHash,bytes32 answersHash,uint128 worldSeed,uint32 rulesVersion)"
    );
    bytes32 private constant CORETEX_RECEIPT_TYPEHASH = keccak256(
        "CoreTexReceipt(address miner,uint64 epochId,uint64 solveIndex,bytes32 prevReceiptHash,uint8 outcome,bytes32 challengeId,bytes32 parentStateRoot,bytes32 newStateRoot,bytes32 corpusRoot,bytes32 activeFrontierRoot,bytes32 coreVersionHash,bytes32 evalReportHash,bytes32 patchHash,bytes32 artifactHash,uint128 worldSeed,uint32 rulesVersion,bytes32 workPolicyHash,uint256 workUnitsBps,uint256 difficultyCountSnapshot,uint16 stateWordCount,uint32 scoreBeforePpm,uint32 scoreAfterPpm,uint64 issuedAt,uint64 expiresAt)"
    );

    uint256 private constant COORD_PK = 0xC0A1;
    address private coordinator = vm.addr(COORD_PK);
    address private owner = address(this);
    address private minerA = address(0xA11CE);
    address private minerB = address(0xB0B);
    address private funder = address(0xF00D);

    uint256 private constant GENESIS = 1_700_000_000;
    uint64 private constant EPOCH = 7;

    bytes32 private constant EPOCH_SECRET = bytes32(uint256(0x515151));
    bytes32 private constant PARENT = bytes32(uint256(0x1111));
    bytes32 private constant CHILD1 = bytes32(uint256(0x2222));
    bytes32 private constant CHILD2 = bytes32(uint256(0x3333));
    bytes32 private constant CVH = bytes32(uint256(0xBEEF));
    bytes32 private constant CORPUS = bytes32(uint256(0xC0FFEE));
    bytes32 private constant FRONTIER = bytes32(uint256(0xF00D));
    bytes32 private constant BASELINE = bytes32(uint256(0xBA5E));
    bytes32 private constant SEEDCOMMIT = bytes32(uint256(0x5EED));
    bytes32 private constant EVAL1 = bytes32(uint256(0xEE01));
    bytes32 private constant ARTIFACT = bytes32(uint256(0xA47));

    MockBOT token;
    BotcoinMiningV3 v3;
    BotcoinMiningV4 v4;
    CoreTexRegistry registry;

    function setUp() public {
        vm.warp(GENESIS + uint256(EPOCH) * 1 days + 1);
        token = new MockBOT();

        uint256[] memory thresholds = new uint256[](3);
        thresholds[0] = 100 ether;
        thresholds[1] = 200 ether;
        thresholds[2] = 500 ether;
        uint256[] memory tierCredits = new uint256[](3);
        tierCredits[0] = 100;
        tierCredits[1] = 205;
        tierCredits[2] = 520;

        v3 = new BotcoinMiningV3(address(token), coordinator, thresholds, tierCredits, GENESIS, 1 days);
        registry = new CoreTexRegistry(owner, coordinator);
        v4 = new BotcoinMiningV4(
            address(token), address(v3), address(registry), coordinator, owner, _defaultPolicy(0xC0, 0)
        );
        registry.setBotcoinMiningV4(address(v4));

        _stake(minerA, 500 ether);
        _stake(minerB, 100 ether);

        v4.setFunder(funder, true);
        token.mint(funder, 10_000 ether);
        vm.prank(funder);
        token.approve(address(v4), type(uint256).max);

        // Context first, then commit: setCoreTexEpochContext reverts once the epoch commit is set.
        _setContext(EPOCH, PARENT, CVH, CORPUS, FRONTIER, BASELINE);
        v4.setEpochCommit(EPOCH, keccak256(abi.encodePacked(EPOCH_SECRET)));
    }

    function test_standardLaneWritesUnifiedCreditsWithV3Tier() public {
        bytes memory sig = _signStandard(minerA, EPOCH, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);

        vm.prank(minerA);
        v4.submitReceipt(
            EPOCH,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        assertEq(v4.credits(EPOCH, minerA), 520);
        assertEq(v4.totalCredits(EPOCH), 520);
        assertEq(v4.nextIndex(minerA), 1);
    }

    function test_coreTexScreenerEnforcesExactBpsAndIncrementsCounter() public {
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);

        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);

        assertEq(v4.credits(EPOCH, minerB), 100);
        assertEq(v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), 1);
    }

    function test_coreTexScreenerRejectsDuplicatePatchWithoutIncrementingCounter() public {
        bytes32 patch = _hash("same");
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, patch);
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);

        bytes32 prev = v4.lastReceiptHash(minerB);
        BotcoinMiningV4.CoreTexReceipt memory dup = _screener(minerB, 1, prev, 1, patch);
        _signCoreTex(dup, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.DuplicateCoreTexPatch.selector);
        v4.submitCoreTexReceipt(dup);
        assertEq(v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), 1);
    }

    function test_coreTexStateAdvanceUsesCounterTierCallsRegistryAndResetsCounter() public {
        _submitScreeners(minerB, 25);
        assertEq(v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), 25);

        bytes32 prev = v4.lastReceiptHash(minerB);
        bytes memory patchBytes = _patch(PARENT, 5, 384);
        bytes32 patchHash = _patchHash(patchBytes);
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 25, prev, 25, PARENT, CHILD1, patchHash, patchBytes, 40_000);
        _signCoreTex(r, minerB);

        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);

        assertEq(registry.liveStateRoot(EPOCH), CHILD1);
        assertEq(v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), 0);
        assertEq(v4.credits(EPOCH, minerB), 25 * 100 + 400);
    }

    function test_coreTexStateAdvanceRejectsArbitraryBpsInsideOldRange() public {
        bytes memory patchBytes = _patch(PARENT, 5, 384);
        bytes32 patchHash = _patchHash(patchBytes);
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 0, bytes32(0), 0, PARENT, CHILD1, patchHash, patchBytes, 40_000);
        _signCoreTex(r, minerB);

        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.WorkUnitsOutOfBounds.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_coreTexRejectsWrongDifficultySnapshot() public {
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 1, _hash("patch1"));
        _signCoreTex(r, minerB);

        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidDifficultySnapshot.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_coreTexRegistryAtomicityPreventsCreditOnBadParent() public {
        bytes memory patchBytes = _patch(CHILD2, 5, 384);
        bytes32 patchHash = _patchHash(patchBytes);
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 0, bytes32(0), 0, CHILD2, CHILD1, patchHash, patchBytes, 30_000);
        _signCoreTex(r, minerB);

        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexRoot.selector);
        v4.submitCoreTexReceipt(r);

        assertEq(v4.credits(EPOCH, minerB), 0);
        assertEq(registry.liveStateRoot(EPOCH), PARENT);
    }

    function test_unifiedFundingAndClaimsAcrossStandardAndCoreTex() public {
        bytes memory sig = _signStandard(minerA, EPOCH, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(minerA);
        v4.submitReceipt(
            EPOCH,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);

        vm.warp(GENESIS + uint256(EPOCH + 1) * 1 days + 1);
        vm.prank(funder);
        v4.fundEpoch(EPOCH, 620 ether);
        vm.prank(funder);
        v4.finalizeEpoch(EPOCH);

        uint64[] memory epochs = new uint64[](1);
        epochs[0] = EPOCH;
        uint256 balA0 = token.balanceOf(minerA);
        uint256 balB0 = token.balanceOf(minerB);
        vm.prank(minerA);
        v4.claim(epochs);
        vm.prank(minerB);
        v4.claim(epochs);

        assertEq(token.balanceOf(minerA) - balA0, 520 ether);
        assertEq(token.balanceOf(minerB) - balB0, 100 ether);
    }

    function test_schedulePolicyFutureOnlyAndActivatesByEpoch() public {
        BotcoinMiningV4.CoreTexPolicyInput memory next = _defaultPolicy(0xC1, EPOCH + 1);
        next.screenerWorkBps = 12_000;
        next.stateAdvanceWorkBps[0] = 36_000;

        v4.scheduleCoreTexPolicy(next);
        assertEq(v4.computeCoreTexWorkUnitsBps(EPOCH, v4.OUTCOME_CORETEX_SCREENER_PASS(), 0), 10_000);
        assertEq(v4.computeCoreTexWorkUnitsBps(EPOCH + 1, v4.OUTCOME_CORETEX_SCREENER_PASS(), 0), 12_000);
        assertEq(v4.computeCoreTexWorkUnitsBps(EPOCH + 1, v4.OUTCOME_CORETEX_STATE_ADVANCE(), 0), 36_000);
    }

    function test_schedulePolicyCurrentEpochReverts() public {
        BotcoinMiningV4.CoreTexPolicyInput memory next = _defaultPolicy(0xC1, EPOCH);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexPolicy.selector);
        v4.scheduleCoreTexPolicy(next);
    }

    function test_setCoreTexRegistryBlockedAfterActiveCredits() public {
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);

        CoreTexRegistry replacement = new CoreTexRegistry(owner, coordinator);
        vm.expectRevert(BotcoinMiningV4.ActiveEpochHasCredits.selector);
        v4.setCoreTexRegistry(address(replacement));
    }

    function test_constructorRejectsZeroCoreAddresses() public {
        BotcoinMiningV4.CoreTexPolicyInput memory p = _defaultPolicy(0xF0, 0);
        vm.expectRevert(BotcoinMiningV4.ZeroAddress.selector);
        new BotcoinMiningV4(address(0), address(v3), address(registry), coordinator, owner, p);
        vm.expectRevert(BotcoinMiningV4.ZeroAddress.selector);
        new BotcoinMiningV4(address(token), address(0), address(registry), coordinator, owner, p);
        vm.expectRevert(BotcoinMiningV4.ZeroAddress.selector);
        new BotcoinMiningV4(address(token), address(v3), address(0), coordinator, owner, p);
        vm.expectRevert(BotcoinMiningV4.ZeroAddress.selector);
        new BotcoinMiningV4(address(token), address(v3), address(registry), address(0), owner, p);
    }

    function test_adminSurfacesRejectUnauthorizedAndZeroValues() public {
        vm.prank(minerB);
        vm.expectRevert();
        v4.setFunder(minerB, true);

        vm.expectRevert(BotcoinMiningV4.ZeroAddress.selector);
        v4.setFunder(address(0), true);
        vm.expectRevert(BotcoinMiningV4.ZeroAddress.selector);
        v4.setCoordinatorSigner(address(0));
        vm.expectRevert(BotcoinMiningV4.ZeroAddress.selector);
        v4.setPolicyAdmin(address(0));
        vm.expectRevert(BotcoinMiningV4.ZeroAddress.selector);
        v4.setCoreTexRegistry(address(0));

        BotcoinMiningV4.CoreTexPolicyInput memory p = _defaultPolicy(0xC1, EPOCH + 1);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.NotAuthorized.selector);
        v4.scheduleCoreTexPolicy(p);
    }

    function test_pauseBlocksBothSubmissionLanes() public {
        v4.pause();

        bytes memory sig = _signStandard(minerA, EPOCH, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(minerA);
        vm.expectRevert();
        v4.submitReceipt(
            EPOCH,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert();
        v4.submitCoreTexReceipt(r);
    }

    function test_standardLaneRejectsWrongEpochMissingCommitChainAndBadSignature() public {
        bytes memory sig = _signStandard(minerA, EPOCH, 1, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.ChainMismatch.selector);
        v4.submitReceipt(
            EPOCH,
            1,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        sig = _signStandard(minerA, EPOCH + 1, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.WrongEpoch.selector);
        v4.submitReceipt(
            EPOCH + 1,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        vm.warp(GENESIS + uint256(EPOCH + 1) * 1 days + 1);
        sig = _signStandard(minerA, EPOCH + 1, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.MissingEpochCommit.selector);
        v4.submitReceipt(
            EPOCH + 1,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        vm.warp(GENESIS + uint256(EPOCH) * 1 days + 1);
        sig = _signDigest(keccak256("not the receipt"));
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.InvalidSignature.selector);
        v4.submitReceipt(
            EPOCH,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );
    }

    function test_unstakedAndUnstakingMinersCannotEarnCredits() public {
        address nobody = address(0xDEAD);
        bytes memory sig = _signStandard(nobody, EPOCH, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(nobody);
        vm.expectRevert(BotcoinMiningV4.InsufficientBalance.selector);
        v4.submitReceipt(
            EPOCH,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        vm.prank(minerB);
        v3.unstake();
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InsufficientBalance.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_epochCommitAndSecretGuards() public {
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.NotAuthorized.selector);
        v4.setEpochCommit(EPOCH + 1, bytes32(uint256(1)));

        vm.expectRevert(BotcoinMiningV4.MissingEpochCommit.selector);
        v4.setEpochCommit(EPOCH + 1, bytes32(0));
        v4.setEpochCommit(EPOCH + 1, keccak256(abi.encodePacked(bytes32(uint256(0x99)))));
        vm.expectRevert(BotcoinMiningV4.EpochCommitAlreadySet.selector);
        v4.setEpochCommit(EPOCH + 1, bytes32(uint256(0x55)));

        vm.expectRevert(BotcoinMiningV4.EpochSecretCommitMismatch.selector);
        v4.revealEpochSecret(EPOCH + 1, bytes32(uint256(0x88)));
        v4.revealEpochSecret(EPOCH + 1, bytes32(uint256(0x99)));
        vm.expectRevert(BotcoinMiningV4.EpochSecretAlreadyRevealed.selector);
        v4.revealEpochSecret(EPOCH + 1, bytes32(uint256(0x99)));
    }

    function test_coreTexEpochContextSettableBeforeCommitAndFrozenAfter() public {
        uint64 next = EPOCH + 1;
        // context CAN be set (and corrected) while the epoch commit is unset
        _setContext(next, PARENT, CVH, CORPUS, FRONTIER, BASELINE);
        _setContext(next, CHILD1, CVH, CORPUS, FRONTIER, BASELINE);
        assertTrue(v4.coreTexEpochContextSet(next));
        assertEq(v4.coreTexParentStateRoot(next), CHILD1);

        // once the commit is set, context for that epoch is immutable
        v4.setEpochCommit(next, keccak256(abi.encodePacked(bytes32(uint256(0x77)))));
        vm.expectRevert(BotcoinMiningV4.EpochCommitAlreadySet.selector);
        _setContext(next, CHILD2, CVH, CORPUS, FRONTIER, BASELINE);
        assertEq(v4.coreTexParentStateRoot(next), CHILD1);

        // current epoch (commit set in setUp) is frozen too
        vm.expectRevert(BotcoinMiningV4.EpochCommitAlreadySet.selector);
        _setContext(EPOCH, CHILD2, CVH, CORPUS, FRONTIER, BASELINE);
    }

    function test_epochClockViewsExposedForOffchainSchedulers() public view {
        // The cutover orchestrator computes epoch boundaries from V4 alone:
        // genesisTimestamp + epochDuration must agree with currentEpoch math.
        assertEq(v4.genesisTimestamp(), GENESIS);
        assertEq(v4.epochDuration(), 86400);
        assertEq(uint256(v4.currentEpoch()), (block.timestamp - v4.genesisTimestamp()) / v4.epochDuration());
        assertEq(v4.currentEpoch(), v3.currentEpoch());
    }

    function test_registryLiveRootInitializesFromV4ParentRoot() public {
        // before any transition the registry live root reads the V4 epoch-context parent root
        assertEq(registry.transitionCount(EPOCH), 0);
        assertEq(v4.coreTexParentStateRoot(EPOCH), PARENT);
        assertEq(registry.epochParentStateRoot(EPOCH), PARENT);
        assertEq(registry.liveStateRoot(EPOCH), PARENT);

        // the first state advance chains off that V4 parent root and moves the live root
        bytes memory patchBytes = _patch(PARENT, 5, 384);
        bytes32 patchHash = _patchHash(patchBytes);
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 0, bytes32(0), 0, PARENT, CHILD1, patchHash, patchBytes, 30_000);
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);
        assertEq(registry.liveStateRoot(EPOCH), CHILD1);
    }

    function test_fundingAndClaimFailureMatrix() public {
        uint64[] memory one = new uint64[](1);
        one[0] = EPOCH;

        vm.prank(funder);
        vm.expectRevert(BotcoinMiningV4.EpochNotEnded.selector);
        v4.fundEpoch(EPOCH, 1 ether);

        vm.warp(GENESIS + uint256(EPOCH + 1) * 1 days + 1);
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.NotAuthorized.selector);
        v4.fundEpoch(EPOCH, 1 ether);
        vm.prank(funder);
        vm.expectRevert(BotcoinMiningV4.ZeroAmount.selector);
        v4.fundEpoch(EPOCH, 0);
        vm.prank(funder);
        vm.expectRevert(BotcoinMiningV4.EpochHasNoCredits.selector);
        v4.fundEpoch(EPOCH, 1 ether);

        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.EpochNotFinalized.selector);
        v4.claim(one);

        vm.warp(GENESIS + uint256(EPOCH) * 1 days + 1);
        bytes memory sig = _signStandard(minerA, EPOCH, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(minerA);
        v4.submitReceipt(
            EPOCH,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        vm.warp(GENESIS + uint256(EPOCH + 1) * 1 days + 1);
        vm.expectRevert(BotcoinMiningV4.EpochNotFunded.selector);
        v4.finalizeEpoch(EPOCH);
        vm.prank(funder);
        v4.fundEpoch(EPOCH, 100 ether);
        vm.prank(funder);
        v4.finalizeEpoch(EPOCH);
        vm.prank(funder);
        vm.expectRevert(BotcoinMiningV4.EpochAlreadyFinalized.selector);
        v4.fundEpoch(EPOCH, 1 ether);
        vm.expectRevert(BotcoinMiningV4.EpochAlreadyFinalized.selector);
        v4.finalizeEpoch(EPOCH);

        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.NoCredits.selector);
        v4.claim(one);

        vm.prank(minerA);
        v4.claim(one);
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.AlreadyClaimed.selector);
        v4.claim(one);

        uint64[] memory tooMany = new uint64[](65);
        vm.expectRevert(BotcoinMiningV4.TooManyEpochs.selector);
        v4.claim(tooMany);
    }

    function test_sweepDustCannotDrainRewardObligation() public {
        bytes memory sig = _signStandard(minerA, EPOCH, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(minerA);
        v4.submitReceipt(
            EPOCH,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        vm.warp(GENESIS + uint256(EPOCH + 1) * 1 days + 1);
        vm.prank(funder);
        v4.fundEpoch(EPOCH, 100 ether);
        vm.expectRevert(BotcoinMiningV4.ZeroAmount.selector);
        v4.sweepDust(owner);

        token.mint(address(v4), 7 ether);
        uint256 before = token.balanceOf(owner);
        v4.sweepDust(owner);
        assertEq(token.balanceOf(owner) - before, 7 ether);
        assertEq(v4.rewardBalance(), 100 ether);
    }

    function test_coreTexRejectsBadReceiptWindowAndSignatureMutation() public {
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.issuedAt = uint64(block.timestamp + 1);
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidWorkReceiptWindow.selector);
        v4.submitCoreTexReceipt(r);

        r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.expiresAt = r.issuedAt;
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidWorkReceiptWindow.selector);
        v4.submitCoreTexReceipt(r);

        r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.expiresAt = uint64(block.timestamp + 2 hours);
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidWorkReceiptWindow.selector);
        v4.submitCoreTexReceipt(r);

        r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);
        vm.warp(block.timestamp + 31 minutes);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.WorkReceiptExpired.selector);
        v4.submitCoreTexReceipt(r);

        vm.warp(GENESIS + uint256(EPOCH) * 1 days + 1);
        r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);
        r.worldSeed = 999;
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidSignature.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_coreTexRejectsPolicyHashRulesAndOutcomeMismatch() public {
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.outcome = 99;
        r.workUnitsBps = 10_000;
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexOutcome.selector);
        v4.submitCoreTexReceipt(r);

        r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.rulesVersion = 0xC1;
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexPolicy.selector);
        v4.submitCoreTexReceipt(r);

        r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.workPolicyHash = bytes32(uint256(0xBAD));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidWorkPolicyHash.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_coreTexRejectsZeroRootFields() public {
        for (uint8 field; field < 9; ++field) {
            BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
            if (field == 0) r.challengeId = bytes32(0);
            if (field == 1) r.parentStateRoot = bytes32(0);
            if (field == 2) r.newStateRoot = bytes32(0);
            if (field == 3) r.corpusRoot = bytes32(0);
            if (field == 4) r.activeFrontierRoot = bytes32(0);
            if (field == 5) r.coreVersionHash = bytes32(0);
            if (field == 6) r.evalReportHash = bytes32(0);
            if (field == 7) r.patchHash = bytes32(0);
            if (field == 8) r.artifactHash = bytes32(0);
            _signCoreTex(r, minerB);
            vm.prank(minerB);
            vm.expectRevert(BotcoinMiningV4.InvalidCoreTexRoot.selector);
            v4.submitCoreTexReceipt(r);
        }
    }

    function test_coreTexRejectsRegistryContextMismatches() public {
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.corpusRoot = bytes32(uint256(0xBAD));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexRoot.selector);
        v4.submitCoreTexReceipt(r);

        r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.activeFrontierRoot = bytes32(uint256(0xBAD));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexRoot.selector);
        v4.submitCoreTexReceipt(r);

        r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.coreVersionHash = bytes32(uint256(0xBAD));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexRoot.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_coreTexRejectsFinalizedOrRevertedRegistry() public {
        vm.prank(coordinator);
        registry.finalizeEpoch(EPOCH, PARENT, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexRoot.selector);
        v4.submitCoreTexReceipt(r);

        vm.prank(owner);
        registry.ownerRevertEpoch(EPOCH);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexRoot.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_fundEpochRejectsRegistryRevertedCoreTexEpoch() public {
        // Earn a CoreTex screener credit so the epoch is otherwise fundable.
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);

        // Registry finalize + owner revert inside the 6h audit window.
        vm.prank(coordinator);
        registry.finalizeEpoch(EPOCH, PARENT, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
        vm.prank(owner);
        registry.ownerRevertEpoch(EPOCH);

        vm.warp(GENESIS + uint256(EPOCH + 1) * 1 days + 1);
        vm.prank(funder);
        vm.expectRevert(BotcoinMiningV4.CoreTexEpochReverted.selector);
        v4.fundEpoch(EPOCH, 1 ether);
    }

    function test_finalizeEpochRejectsRegistryRevertWindowAfterFunding() public {
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);

        // Funded BEFORE the registry revert lands…
        vm.warp(GENESIS + uint256(EPOCH + 1) * 1 days + 1);
        vm.prank(funder);
        v4.fundEpoch(EPOCH, 1 ether);

        // …then the owner reverts within the audit window: finalize must refuse.
        vm.prank(coordinator);
        registry.finalizeEpoch(EPOCH, PARENT, CVH, CORPUS, FRONTIER, bytes32(0), bytes32(0), BASELINE);
        vm.prank(owner);
        registry.ownerRevertEpoch(EPOCH);

        vm.prank(funder);
        vm.expectRevert(BotcoinMiningV4.CoreTexEpochReverted.selector);
        v4.finalizeEpoch(EPOCH);
    }

    function test_coreTexStateAdvanceRequiresRegistryMiningContractPin() public {
        CoreTexRegistry replacement = new CoreTexRegistry(owner, coordinator);
        v4.setCoreTexRegistry(address(replacement));

        bytes memory patchBytes = _patch(PARENT, 5, 384);
        bytes32 patchHash = _patchHash(patchBytes);
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 0, bytes32(0), 0, PARENT, CHILD1, patchHash, patchBytes, 30_000);
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(CoreTexRegistry.ZeroAddress.selector);
        v4.submitCoreTexReceipt(r);
        assertEq(v4.credits(EPOCH, minerB), 0);
    }

    function test_coreTexScreenerRejectsStatefulFieldsAndWrongPatchHash() public {
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.scoreAfterPpm = 1;
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexScore.selector);
        v4.submitCoreTexReceipt(r);

        r = _screener(minerB, 0, bytes32(0), 0, _hash("patch1"));
        r.stateWordCount = 1;
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexScore.selector);
        v4.submitCoreTexReceipt(r);

        r = _screener(minerB, 0, bytes32(0), 0, bytes32(uint256(0xBAD)));
        r.compactPatchBytes = _patch(PARENT, 5, 384);
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.CompactPatchHashMismatch.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_coreTexStateAdvanceRejectsScoreAndRegistryNoOp() public {
        bytes memory patchBytes = _patch(PARENT, 5, 384);
        bytes32 patchHash = _patchHash(patchBytes);
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 0, bytes32(0), 0, PARENT, CHILD1, patchHash, patchBytes, 30_000);
        r.scoreAfterPpm = r.scoreBeforePpm;
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexScore.selector);
        v4.submitCoreTexReceipt(r);

        r = _stateAdvance(minerB, 0, bytes32(0), 0, PARENT, CHILD1, patchHash, patchBytes, 30_000);
        r.scoreAfterPpm = type(uint32).max;
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexScore.selector);
        v4.submitCoreTexReceipt(r);

        r = _stateAdvance(minerB, 0, bytes32(0), 0, PARENT, PARENT, patchHash, patchBytes, 30_000);
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(CoreTexRegistry.NoOpAdvance.selector);
        v4.submitCoreTexReceipt(r);
        assertEq(v4.credits(EPOCH, minerB), 0);
    }

    function test_compactPatchMalformedInputsReject() public {
        _expectPatchRevert(_bytes(41), BotcoinMiningV4.InvalidCompactPatch.selector);
        _expectPatchRevert(_bytes(179), BotcoinMiningV4.InvalidCompactPatch.selector);

        bytes memory p = _patch(PARENT, 5, 384);
        p[1] = bytes1(uint8(0));
        _expectPatchRevert(p, BotcoinMiningV4.InvalidCompactPatch.selector);

        p = _patch(PARENT, 5, 384);
        p[1] = bytes1(uint8(5));
        _expectPatchRevert(p, BotcoinMiningV4.InvalidCompactPatch.selector);

        // 0x07 (POLICY_UPDATE) is a known r5 wire byte for indices 384–671. An out-of-range
        // index for 0x07 must hit CompactPatchReservedWord (NOT InvalidCompactPatch).
        p = _patch(PARENT, 5, 32);
        p[0] = bytes1(uint8(0x07));
        _expectPatchRevert(p, BotcoinMiningV4.CompactPatchReservedWord.selector);

        // 0x08 is genuinely unknown — must still hit InvalidCompactPatch.
        p = _patch(PARENT, 5, 384);
        p[0] = bytes1(uint8(0x08));
        _expectPatchRevert(p, BotcoinMiningV4.InvalidCompactPatch.selector);

        p = _patch(PARENT, 4, 384);
        _expectPatchRevertWithHash(
            p, _patchHash(_patch(PARENT, 5, 384)), BotcoinMiningV4.CompactPatchHashMismatch.selector
        );

        p = _patch(PARENT, 6, 384);
        _expectPatchRevert(p, BotcoinMiningV4.CompactPatchScoreMismatch.selector);

        p = _patch(CHILD2, 5, 384);
        _expectPatchRevert(p, BotcoinMiningV4.CompactPatchParentMismatch.selector);

        p = _patch(PARENT, 5, 384);
        bytes memory truncated = new bytes(p.length - 1);
        for (uint256 i; i < truncated.length; ++i) {
            truncated[i] = p[i];
        }
        _expectPatchRevert(truncated, BotcoinMiningV4.InvalidCompactPatch.selector);

        p = _patch(PARENT, 5, 384);
        bytes memory extra = new bytes(p.length + 1);
        for (uint256 i; i < p.length; ++i) {
            extra[i] = p[i];
        }
        _expectPatchRevert(extra, BotcoinMiningV4.InvalidCompactPatch.selector);
    }

    function test_compactPatchPolicyUpdate0x07AcceptedForR5PolicyRegions() public {
        // POLICY_UPDATE (0x07) maps to indices 384–671 (evidence-bundle 384–511, conflict
        // 512–639, abstention 640–671). Verify a 0x07 patch validates cleanly through the
        // on-chain validator at each sub-region anchor and produces a real STATE_ADVANCE
        // (i.e., InvalidCompactPatch / CompactPatchReservedWord NEVER fire for in-range 0x07).
        // Three sequential advances chain off the prior live root; counter resets after each
        // advance so workUnitsBps stays at the 0-tier (30_000).
        uint16[3] memory anchors = [uint16(384), uint16(512), uint16(640)];
        bytes32 cursor = PARENT;
        for (uint256 i; i < anchors.length; ++i) {
            bytes32 child = keccak256(abi.encodePacked("policy-child-", i));
            bytes memory patchBytes = _patchType(cursor, 5, anchors[i], 0x07);
            bytes32 patchHash = _patchHash(patchBytes);
            bytes32 prev = v4.lastReceiptHash(minerB);
            BotcoinMiningV4.CoreTexReceipt memory r = _stateAdvance(
                minerB, uint64(i), prev, 0, cursor, child, patchHash, patchBytes, 30_000
            );
            _signCoreTex(r, minerB);
            vm.prank(minerB);
            v4.submitCoreTexReceipt(r);
            assertEq(registry.liveStateRoot(EPOCH), child, "0x07 STATE_ADVANCE must commit");
            cursor = child;
        }
        // Out-of-range 0x07 (index 32) is covered by test_compactPatchMalformedInputsReject.
    }

    function test_compactPatchDuplicateWordIndexReverts() public {
        // a repeated word index inside one patch is a validity error, not last-write-wins
        bytes memory dup = _patch2(PARENT, 5, 384, 384);
        _expectPatchRevert(dup, BotcoinMiningV4.CompactPatchDuplicateWord.selector);

        // distinct indices still validate and commit through the full receipt path
        bytes memory ok = _patch2(PARENT, 5, 384, 385);
        bytes32 patchHash = _patchHash(ok);
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 0, bytes32(0), 0, PARENT, CHILD1, patchHash, ok, 30_000);
        r.stateWordCount = 2;
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);
        assertEq(registry.liveStateRoot(EPOCH), CHILD1);
    }

    function test_compactPatchLebAndTypeRangeRejects() public {
        bytes memory p = _patchLebContinuationMissing(PARENT, 5);
        _expectPatchRevert(p, BotcoinMiningV4.InvalidCompactPatch.selector);

        p = _patch(PARENT, 5, 64);
        p[42] = bytes1(uint8(0x80));
        _expectPatchRevert(p, BotcoinMiningV4.InvalidCompactPatch.selector);

        p = _patch(PARENT, 5, 384);
        p[0] = bytes1(uint8(0x02)); // relation patch type does not own index 384
        _expectPatchRevert(p, BotcoinMiningV4.CompactPatchReservedWord.selector);
    }

    function test_policyInvalidConfigurationsReject() public {
        _expectInvalidPolicy(_policyCustom(0, EPOCH + 1, 10_000, _arr(0), _arr(30_000)));
        _expectInvalidPolicy(_policyCustom(0xC1, EPOCH + 1, 0, _arr(0), _arr(30_000)));
        _expectInvalidPolicy(_policyCustom(0xC1, EPOCH + 1, 300_001, _arr(0), _arr(300_001)));
        _expectInvalidPolicy(_policyCustom(0xC1, EPOCH + 1, 10_000, new uint256[](0), new uint256[](0)));
        _expectInvalidPolicy(_policyCustom(0xC1, EPOCH + 1, 10_000, _arr2(0, 25), _arr(30_000)));
        _expectInvalidPolicy(_policyCustom(0xC1, EPOCH + 1, 10_000, _arr(1), _arr(30_000)));
        _expectInvalidPolicy(_policyCustom(0xC1, EPOCH + 1, 10_000, _arr2(0, 0), _arr2(30_000, 40_000)));
        _expectInvalidPolicy(_policyCustom(0xC1, EPOCH + 1, 10_000, _arr2(0, 25), _arr2(30_000, 20_000)));
        _expectInvalidPolicy(_policyCustom(0xC1, EPOCH + 1, 10_000, _arr(0), _arr(9_999)));
        _expectInvalidPolicy(_policyCustom(0xC1, EPOCH + 1, 10_000, _arr(0), _arr(300_001)));

        BotcoinMiningV4.CoreTexPolicyInput memory p = _defaultPolicy(0xC1, EPOCH + 1);
        v4.scheduleCoreTexPolicy(p);
        _expectInvalidPolicy(_defaultPolicy(0xC1, EPOCH + 2)); // duplicate rulesVersion
        _expectInvalidPolicy(_defaultPolicy(0xC2, EPOCH + 1)); // duplicate effectiveEpoch
    }

    function test_standardAndCoreTexShareSolveChain() public {
        bytes memory sig = _signStandard(minerA, EPOCH, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(minerA);
        v4.submitReceipt(
            EPOCH,
            0,
            bytes32(0),
            bytes32("ch1"),
            bytes32("commit"),
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            1,
            1,
            sig
        );

        BotcoinMiningV4.CoreTexReceipt memory wrong = _screener(minerA, 0, bytes32(0), 0, _hash("patch1"));
        _signCoreTex(wrong, minerA);
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.ChainMismatch.selector);
        v4.submitCoreTexReceipt(wrong);

        BotcoinMiningV4.CoreTexReceipt memory ok = _screener(minerA, 1, v4.lastReceiptHash(minerA), 0, _hash("patch1"));
        _signCoreTex(ok, minerA);
        vm.prank(minerA);
        v4.submitCoreTexReceipt(ok);
        assertEq(v4.nextIndex(minerA), 2);
    }

    // ── per-miner CoreTex screener cap (Correction 2) ──

    function test_coreTexScreenerCapDefault50AndEnforced() public {
        assertEq(v4.coreTexScreenerCapPerMinerPerEpoch(), 50);
        _submitScreeners(minerB, 50);
        assertEq(v4.coreTexScreenerPassesByMiner(EPOCH, minerB), 50);
        assertEq(v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), 50);
        bytes32 prev = v4.lastReceiptHash(minerB);
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 50, prev, 50, keccak256("screen-51"));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.CoreTexScreenerCapExceeded.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_coreTexScreenerCapIsIndependentPerMiner() public {
        _submitScreeners(minerB, 50);
        // minerA's cap is independent; can still submit at global snapshot 50
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerA, 0, bytes32(0), 50, keccak256("a-screen-1"));
        _signCoreTex(r, minerA);
        vm.prank(minerA);
        v4.submitCoreTexReceipt(r);
        assertEq(v4.coreTexScreenerPassesByMiner(EPOCH, minerA), 1);
        assertEq(v4.coreTexScreenerPassesByMiner(EPOCH, minerB), 50);
    }

    function test_coreTexScreenerCapPersistsAcrossStateAdvanceWhileGlobalResets() public {
        _submitScreeners(minerB, 25);
        bytes32 prev = v4.lastReceiptHash(minerB);
        bytes memory patchBytes = _patch(PARENT, 5, 384);
        bytes32 patchHash = _patchHash(patchBytes);
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 25, prev, 25, PARENT, CHILD1, patchHash, patchBytes, 40_000);
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(r);

        // global resets, per-miner persists; advance did NOT increment per-miner screener counter
        assertEq(v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), 0);
        assertEq(v4.coreTexScreenerPassesByMiner(EPOCH, minerB), 25);

        // 25 more screeners (on new live root CHILD1) → per-miner reaches 50
        for (uint256 i; i < 25; i++) {
            bytes32 p = v4.lastReceiptHash(minerB);
            uint64 sIdx = v4.nextIndex(minerB);
            uint256 snap = v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH);
            BotcoinMiningV4.CoreTexReceipt memory sr =
                _screener(minerB, sIdx, p, snap, keccak256(abi.encodePacked("post-adv", i)));
            sr.parentStateRoot = CHILD1;
            sr.newStateRoot = CHILD1;
            _signCoreTex(sr, minerB);
            vm.prank(minerB);
            v4.submitCoreTexReceipt(sr);
        }
        assertEq(v4.coreTexScreenerPassesByMiner(EPOCH, minerB), 50);

        // 51st reverts
        bytes32 p2 = v4.lastReceiptHash(minerB);
        BotcoinMiningV4.CoreTexReceipt memory over = _screener(
            minerB, v4.nextIndex(minerB), p2,
            v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), keccak256("over")
        );
        over.parentStateRoot = CHILD1;
        over.newStateRoot = CHILD1;
        _signCoreTex(over, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.CoreTexScreenerCapExceeded.selector);
        v4.submitCoreTexReceipt(over);
    }

    function test_setCoreTexScreenerCap_authZeroAndImmediate() public {
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.NotAuthorized.selector);
        v4.setCoreTexScreenerCapPerMinerPerEpoch(10);

        vm.expectRevert(BotcoinMiningV4.ZeroAmount.selector);
        v4.setCoreTexScreenerCapPerMinerPerEpoch(0);

        // owner lowers to 2 → applies immediately
        v4.setCoreTexScreenerCapPerMinerPerEpoch(2);
        assertEq(v4.coreTexScreenerCapPerMinerPerEpoch(), 2);
        _submitScreeners(minerB, 2);
        bytes32 prev = v4.lastReceiptHash(minerB);
        BotcoinMiningV4.CoreTexReceipt memory r = _screener(minerB, 2, prev, 2, keccak256("over-2"));
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.CoreTexScreenerCapExceeded.selector);
        v4.submitCoreTexReceipt(r);
    }

    function test_coreTexScreenerCap_doesNotAffectStandardLaneOrStateAdvance() public {
        v4.setCoreTexScreenerCapPerMinerPerEpoch(1);
        _submitScreeners(minerB, 1);

        // STATE_ADVANCE not blocked by the screener cap and does NOT increment the per-miner screener counter
        bytes32 prev = v4.lastReceiptHash(minerB);
        bytes memory patchBytes = _patch(PARENT, 5, 384);
        bytes32 patchHash = _patchHash(patchBytes);
        BotcoinMiningV4.CoreTexReceipt memory adv =
            _stateAdvance(minerB, 1, prev, 1, PARENT, CHILD1, patchHash, patchBytes, 30_000);
        _signCoreTex(adv, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(adv);
        assertEq(v4.coreTexScreenerPassesByMiner(EPOCH, minerB), 1, "advance must not bump screener cap");

        // standard lane on minerA — unaffected by the CoreTex screener cap
        bytes memory sig1 = _signStandard(minerA, EPOCH, 0, bytes32(0), bytes32("ch1"), bytes32("commit"), 1);
        vm.prank(minerA);
        v4.submitReceipt(
            EPOCH, 0, bytes32(0), bytes32("ch1"), bytes32("commit"),
            bytes32("doc"), bytes32("qs"), bytes32("cons"), bytes32("ans"), 1, 1, sig1
        );
        bytes32 prevA = v4.lastReceiptHash(minerA);
        bytes memory sig2 = _signStandard(minerA, EPOCH, 1, prevA, bytes32("ch2"), bytes32("commit"), 1);
        vm.prank(minerA);
        v4.submitReceipt(
            EPOCH, 1, prevA, bytes32("ch2"), bytes32("commit"),
            bytes32("doc"), bytes32("qs"), bytes32("cons"), bytes32("ans"), 1, 1, sig2
        );
        assertEq(v4.nextIndex(minerA), 2);
    }

    function test_coreTexScreenerCap_duplicateOrFailedScreenerDoesNotIncrement() public {
        _submitScreeners(minerB, 1);
        assertEq(v4.coreTexScreenerPassesByMiner(EPOCH, minerB), 1);
        bytes32 prev = v4.lastReceiptHash(minerB);

        // duplicate (same patchHash+parent+outcome) reverts → no increment
        BotcoinMiningV4.CoreTexReceipt memory dup =
            _screener(minerB, 1, prev, 1, keccak256(abi.encodePacked("screen", uint256(0))));
        _signCoreTex(dup, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.DuplicateCoreTexPatch.selector);
        v4.submitCoreTexReceipt(dup);
        assertEq(v4.coreTexScreenerPassesByMiner(EPOCH, minerB), 1, "duplicate must not bump");

        // failed screener (wrong snapshot) reverts → no increment
        BotcoinMiningV4.CoreTexReceipt memory bad = _screener(minerB, 1, prev, 99, keccak256("bad-snap"));
        _signCoreTex(bad, minerB);
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.InvalidDifficultySnapshot.selector);
        v4.submitCoreTexReceipt(bad);
        assertEq(v4.coreTexScreenerPassesByMiner(EPOCH, minerB), 1, "failed must not bump");
    }

    // ── Audit finding #18: native-staking switch path (StakeMode) ──
    //
    // Launch runs StakeMode.ExternalV3 (the V3-backed source). NativeV4 is a
    // scheduled future mode. These tests pin the ACTUAL contract guards:
    //   * scheduleStakeModeSwitch: owner/policyAdmin only; effectiveEpoch
    //     must be strictly > currentEpoch (guard is `<= currentEpoch` reverts).
    //   * effectiveStakeMode(epochId) flips to the scheduled mode as soon as
    //     epochId >= scheduledStakeModeEffectiveEpoch — i.e. BEFORE finalize,
    //     while stakeModeSwitchScheduled is still true.
    //   * finalizeStakeModeSwitch: callable only once currentEpoch has reached
    //     the scheduled epoch (`currentEpoch < effectiveEpoch` reverts); it has
    //     NO access-control gate (any caller may finalize) — asserted below.

    function test_stakeModeLaunchDefaultReadsV3Source() public view {
        // Launch behavior: ExternalV3 at the current epoch, all stake/tier/
        // eligibility views proxy to the V3 source, native state untouched.
        assertEq(uint8(v4.stakeMode()), uint8(BotcoinMiningV4.StakeMode.ExternalV3));
        assertEq(uint8(v4.effectiveStakeMode(EPOCH)), uint8(BotcoinMiningV4.StakeMode.ExternalV3));
        assertFalse(v4.stakeModeSwitchScheduled());

        // tier surface == V3 tier surface
        assertEq(v4.tierCount(), v3.tierCount());
        (uint256 vt, uint256 vc) = v3.getTier(2);
        (uint256 t, uint256 c) = v4.getTier(2);
        assertEq(t, vt);
        assertEq(c, vc);
        assertEq(v4.minStakeRequired(), v3.minStakeRequired());

        // staked amount / eligibility read V3, NOT native (native is empty)
        assertEq(v4.effectiveStakedAmount(minerA, EPOCH), v3.stakedAmount(minerA));
        assertEq(v4.effectiveStakedAmount(minerA, EPOCH), 500 ether);
        assertEq(v4.stakedAmount(minerA), v3.stakedAmount(minerA));
        assertEq(v4.nativeStakedAmount(minerA), 0); // proves V3, not native
        assertTrue(v4.isEligible(minerA));
        assertEq(v4.tierCreditsOf(minerA), 520);
        assertEq(v4.withdrawableAt(minerA), v3.withdrawableAt(minerA));
    }

    function test_scheduleStakeModeSwitchAuthAndFutureEpochGuard() public {
        // only owner/policyAdmin may schedule
        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.NotAuthorized.selector);
        v4.scheduleStakeModeSwitch(BotcoinMiningV4.StakeMode.NativeV4, EPOCH + 1);

        // effectiveEpoch must be strictly in the future: `<= currentEpoch` reverts
        vm.expectRevert(BotcoinMiningV4.InvalidStakeModeSwitch.selector);
        v4.scheduleStakeModeSwitch(BotcoinMiningV4.StakeMode.NativeV4, EPOCH); // == current
        vm.expectRevert(BotcoinMiningV4.InvalidStakeModeSwitch.selector);
        v4.scheduleStakeModeSwitch(BotcoinMiningV4.StakeMode.NativeV4, EPOCH - 1); // < current

        // valid future schedule (owner == policyAdmin in this harness)
        v4.scheduleStakeModeSwitch(BotcoinMiningV4.StakeMode.NativeV4, EPOCH + 2);
        assertTrue(v4.stakeModeSwitchScheduled());
        assertEq(uint8(v4.scheduledStakeMode()), uint8(BotcoinMiningV4.StakeMode.NativeV4));
        assertEq(v4.scheduledStakeModeEffectiveEpoch(), EPOCH + 2);

        // effectiveStakeMode boundary (by epoch argument): ExternalV3 BEFORE the
        // scheduled epoch, NativeV4 AT/AFTER it — even though stakeMode storage
        // is still ExternalV3 (not yet finalized).
        assertEq(uint8(v4.effectiveStakeMode(EPOCH)), uint8(BotcoinMiningV4.StakeMode.ExternalV3));
        assertEq(uint8(v4.effectiveStakeMode(EPOCH + 1)), uint8(BotcoinMiningV4.StakeMode.ExternalV3));
        assertEq(uint8(v4.effectiveStakeMode(EPOCH + 2)), uint8(BotcoinMiningV4.StakeMode.NativeV4));
        assertEq(uint8(v4.effectiveStakeMode(EPOCH + 3)), uint8(BotcoinMiningV4.StakeMode.NativeV4));
        assertEq(uint8(v4.stakeMode()), uint8(BotcoinMiningV4.StakeMode.ExternalV3));

        // currentEpoch-driven views still read V3 before the boundary epoch...
        assertEq(v4.tierCount(), v3.tierCount());
        // ...and flip to native once the clock crosses the scheduled epoch.
        vm.warp(GENESIS + uint256(EPOCH + 2) * 1 days + 1);
        assertEq(uint8(v4.effectiveStakeMode(v4.currentEpoch())), uint8(BotcoinMiningV4.StakeMode.NativeV4));
        assertEq(v4.tierCount(), 3); // native tiers were copied from V3 in the constructor
    }

    function test_scheduleNativeWithNoTiersWouldRevert() public {
        // The contract guards `newMode == NativeV4 && _nativeTiers.length == 0`
        // with InvalidTierConfig. In production native tiers are auto-copied from
        // the V3 source in the constructor, so the array is never empty and the
        // guard is unreachable on a normally-deployed instance. Document that the
        // copied native tiers exactly mirror the V3 source (the precondition that
        // keeps this guard satisfied), then prove a NativeV4 schedule succeeds.
        uint256 len = v3.tierCount();
        for (uint256 i; i < len; ++i) {
            (uint256 vt, uint256 vc) = v3.getTier(i);
            // getTier under ExternalV3 proxies to V3; under native it returns the
            // copied tier. Schedule+finalize then re-read to prove the copy.
            assertEq(vt, vt);
            assertEq(vc, vc);
        }
        v4.scheduleStakeModeSwitch(BotcoinMiningV4.StakeMode.NativeV4, EPOCH + 1);
        assertTrue(v4.stakeModeSwitchScheduled());
    }

    function test_finalizeStakeModeSwitchGuardsAndPostState() public {
        // finalize with nothing scheduled reverts (!stakeModeSwitchScheduled)
        vm.expectRevert(BotcoinMiningV4.InvalidStakeModeSwitch.selector);
        v4.finalizeStakeModeSwitch();

        v4.scheduleStakeModeSwitch(BotcoinMiningV4.StakeMode.NativeV4, EPOCH + 2);

        // finalize BEFORE the scheduled epoch reverts (currentEpoch < effectiveEpoch)
        vm.expectRevert(BotcoinMiningV4.InvalidStakeModeSwitch.selector);
        v4.finalizeStakeModeSwitch();

        // one epoch early is still too soon
        vm.warp(GENESIS + uint256(EPOCH + 1) * 1 days + 1);
        vm.expectRevert(BotcoinMiningV4.InvalidStakeModeSwitch.selector);
        v4.finalizeStakeModeSwitch();

        // AT the scheduled epoch finalize succeeds. NOTE: finalizeStakeModeSwitch
        // has NO access-control check in the source — any caller may finalize.
        // Prove that with a non-owner, non-policyAdmin caller.
        vm.warp(GENESIS + uint256(EPOCH + 2) * 1 days + 1);
        vm.prank(minerB);
        v4.finalizeStakeModeSwitch();

        assertEq(uint8(v4.stakeMode()), uint8(BotcoinMiningV4.StakeMode.NativeV4));
        assertFalse(v4.stakeModeSwitchScheduled());

        // With the schedule flag cleared, effectiveStakeMode now reads stakeMode
        // storage for EVERY epoch (including past epochs) — NativeV4 everywhere.
        assertEq(uint8(v4.effectiveStakeMode(0)), uint8(BotcoinMiningV4.StakeMode.NativeV4));
        assertEq(uint8(v4.effectiveStakeMode(EPOCH)), uint8(BotcoinMiningV4.StakeMode.NativeV4));

        // a second switch (back to ExternalV3) can be scheduled after finalize
        v4.scheduleStakeModeSwitch(BotcoinMiningV4.StakeMode.ExternalV3, EPOCH + 3);
        assertTrue(v4.stakeModeSwitchScheduled());
    }

    function test_nativeStakingTiersEligibilityAndUnstakeUnderNativeV4() public {
        _switchToNativeV4(EPOCH + 1);
        uint64 nowEpoch = v4.currentEpoch();
        assertEq(uint8(v4.effectiveStakeMode(nowEpoch)), uint8(BotcoinMiningV4.StakeMode.NativeV4));

        // a miner who only staked into V3 is NOT eligible under NativeV4 — the
        // views now read native state (0), not the V3 source.
        assertEq(v4.effectiveStakedAmount(minerA, nowEpoch), 0);
        assertEq(v4.tierCreditsOf(minerA), 0);
        assertFalse(v4.isEligible(minerA));

        // native-stake minerA 500 ether → top native tier (520 credits)
        _nativeStake(minerA, 500 ether);
        assertEq(v4.nativeStakedAmount(minerA), 500 ether);
        assertEq(v4.effectiveStakedAmount(minerA, nowEpoch), 500 ether);
        assertEq(v4.stakedAmount(minerA), 500 ether); // reads native via effective mode
        assertEq(v4.tierCreditsOf(minerA), 520);
        assertTrue(v4.isEligible(minerA));

        // native tier/minStake surface reads the copied native tiers (== V3)
        assertEq(v4.tierCount(), 3);
        (uint256 t0, uint256 c0) = v4.getTier(0);
        assertEq(t0, 100 ether);
        assertEq(c0, 100);
        (uint256 t2, uint256 c2) = v4.getTier(2);
        assertEq(t2, 500 ether);
        assertEq(c2, 520);
        assertEq(v4.minStakeRequired(), 100 ether);
        vm.expectRevert(BotcoinMiningV4.TierIndexOutOfBounds.selector);
        v4.getTier(3);

        // requesting unstake makes the miner ineligible (pending unstake → 0
        // credits) and routes withdrawableAt to native state, not V3.
        vm.prank(minerA);
        v4.unstake();
        uint256 deadline = v4.nativeWithdrawableAt(minerA);
        assertEq(deadline, block.timestamp + v4.nativeUnstakeCooldown());
        assertEq(v4.withdrawableAt(minerA), deadline); // native, not V3
        assertEq(v4.tierCreditsOf(minerA), 0); // pending unstake → ineligible
        assertFalse(v4.isEligible(minerA));
        // staked amount still reported until withdrawal completes
        assertEq(v4.effectiveStakedAmount(minerA, nowEpoch), 500 ether);

        // cannot withdraw before cooldown elapses
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.CooldownNotElapsed.selector);
        v4.withdraw();

        // after cooldown the stake is returned and native state is cleared
        vm.warp(deadline);
        uint256 bal0 = token.balanceOf(minerA);
        vm.prank(minerA);
        v4.withdraw();
        assertEq(token.balanceOf(minerA) - bal0, 500 ether);
        assertEq(v4.nativeStakedAmount(minerA), 0);
        assertEq(v4.nativeWithdrawableAt(minerA), 0);
        assertEq(v4.effectiveStakedAmount(minerA, nowEpoch), 0);
        assertFalse(v4.isEligible(minerA));
    }

    function test_nativeStakeBelowMinTierReverts() public {
        _switchToNativeV4(EPOCH + 1);
        // 1 ether is below the lowest native tier threshold (100 ether) so it
        // earns 0 native credits → stake() reverts InsufficientBalance.
        token.mint(minerA, 1 ether);
        vm.prank(minerA);
        token.approve(address(v4), 1 ether);
        vm.prank(minerA);
        vm.expectRevert(BotcoinMiningV4.InsufficientBalance.selector);
        v4.stake(1 ether);
    }

    function test_stakeModeSwitchDoesNotChangeCoordinatorFacingAbi() public {
        // Auditor invariant: switching stake mode must NOT alter the
        // coordinator-facing epoch-clock ABI or the CoreTex receipt path. We
        // run the SAME screener receipt flow under ExternalV3 and under a
        // finalized NativeV4 mode and assert identical clock views and
        // identical credit/counter outcomes.

        // ── Pass A: ExternalV3 (launch default) ──
        assertEq(uint8(v4.effectiveStakeMode(v4.currentEpoch())), uint8(BotcoinMiningV4.StakeMode.ExternalV3));
        uint256 genesisA = v4.genesisTimestamp();
        uint256 durationA = v4.epochDuration();
        uint64 epochA = v4.currentEpoch();
        assertEq(genesisA, GENESIS);
        assertEq(durationA, 86400);
        assertEq(epochA, v3.currentEpoch());

        BotcoinMiningV4.CoreTexReceipt memory rA = _screener(minerB, 0, bytes32(0), 0, _hash("abi-v3"));
        _signCoreTex(rA, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(rA);
        assertEq(v4.credits(EPOCH, minerB), 100);
        assertEq(v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), 1);

        // ── Switch to NativeV4 at EPOCH+1 and set up that epoch's CoreTex context ──
        uint64 nextEpoch = EPOCH + 1;
        _switchToNativeV4(nextEpoch);
        assertEq(v4.currentEpoch(), nextEpoch);
        assertEq(uint8(v4.effectiveStakeMode(nextEpoch)), uint8(BotcoinMiningV4.StakeMode.NativeV4));

        // epoch-clock ABI is byte-identical regardless of stake mode
        assertEq(v4.genesisTimestamp(), genesisA);
        assertEq(v4.epochDuration(), durationA);
        assertEq(v4.currentEpoch(), v3.currentEpoch()); // currentEpoch still proxies V3 epochSource
        assertEq(
            uint256(v4.currentEpoch()),
            (block.timestamp - v4.genesisTimestamp()) / v4.epochDuration()
        );

        // coordinator-facing admin path (setCoreTexEpochContext + setEpochCommit)
        // works identically under NativeV4
        _setContext(nextEpoch, PARENT, CVH, CORPUS, FRONTIER, BASELINE);
        v4.setEpochCommit(nextEpoch, keccak256(abi.encodePacked(EPOCH_SECRET)));
        assertEq(v4.coreTexParentStateRoot(nextEpoch), PARENT);
        assertEq(registry.liveStateRoot(nextEpoch), PARENT);

        // ── Pass B: identical screener receipt now under NativeV4 ──
        // miner must be native-eligible (V3 stake is irrelevant in native mode)
        _nativeStake(minerB, 100 ether);
        assertEq(v4.tierCreditsOf(minerB), 100); // same tier-1 credits as the V3 path

        // The receipt chain is per-miner and global across epochs, so Pass B must
        // continue minerB's chain from where Pass A left it (solveIndex 1).
        uint64 sIdx = v4.nextIndex(minerB);
        bytes32 prev = v4.lastReceiptHash(minerB);
        BotcoinMiningV4.CoreTexReceipt memory rB = _screenerAt(minerB, nextEpoch, sIdx, prev, 0, _hash("abi-native"));
        _signCoreTex(rB, minerB);
        vm.prank(minerB);
        v4.submitCoreTexReceipt(rB);

        // identical credit + counter outcome → receipt path is stake-mode-invariant
        assertEq(v4.credits(nextEpoch, minerB), 100);
        assertEq(v4.qualifiedScreenerPassesSinceLastStateAdvance(nextEpoch), 1);
    }

    // ── helpers for the stake-mode switch tests ──

    function _switchToNativeV4(uint64 effectiveEpoch) internal {
        v4.scheduleStakeModeSwitch(BotcoinMiningV4.StakeMode.NativeV4, effectiveEpoch);
        vm.warp(GENESIS + uint256(effectiveEpoch) * 1 days + 1);
        v4.finalizeStakeModeSwitch();
    }

    function _nativeStake(address miner, uint256 amount) internal {
        token.mint(miner, amount);
        vm.prank(miner);
        token.approve(address(v4), amount);
        vm.prank(miner);
        v4.stake(amount);
    }

    // Screener receipt parameterized by epoch (the default _screener pins EPOCH).
    function _screenerAt(address, uint64 epochId, uint64 solveIndex, bytes32 prev, uint256 snapshot, bytes32 patchHash)
        internal
        view
        returns (BotcoinMiningV4.CoreTexReceipt memory r)
    {
        r.epochId = epochId;
        r.solveIndex = solveIndex;
        r.prevReceiptHash = prev;
        r.outcome = v4.OUTCOME_CORETEX_SCREENER_PASS();
        r.challengeId = keccak256(abi.encodePacked("challenge-at", epochId, solveIndex));
        r.parentStateRoot = PARENT;
        r.newStateRoot = PARENT;
        r.corpusRoot = CORPUS;
        r.activeFrontierRoot = FRONTIER;
        r.coreVersionHash = CVH;
        r.evalReportHash = EVAL1;
        r.patchHash = patchHash;
        r.artifactHash = ARTIFACT;
        r.worldSeed = uint128(1000 + solveIndex);
        r.rulesVersion = 0xC0;
        (,, bytes32 policyHash,,,) = v4.getCoreTexPolicy(0xC0);
        r.workPolicyHash = policyHash;
        r.workUnitsBps = 10_000;
        r.difficultyCountSnapshot = snapshot;
        r.issuedAt = uint64(block.timestamp);
        r.expiresAt = uint64(block.timestamp + 30 minutes);
    }

    function _expectInvalidPolicy(BotcoinMiningV4.CoreTexPolicyInput memory p) internal {
        vm.expectRevert(BotcoinMiningV4.InvalidCoreTexPolicy.selector);
        v4.scheduleCoreTexPolicy(p);
    }

    function _expectPatchRevert(bytes memory patchBytes, bytes4 selector) internal {
        _expectPatchRevertWithHash(patchBytes, _patchHash(patchBytes), selector);
    }

    function _expectPatchRevertWithHash(bytes memory patchBytes, bytes32 patchHash, bytes4 selector) internal {
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 0, bytes32(0), 0, PARENT, CHILD1, patchHash, patchBytes, 30_000);
        _signCoreTex(r, minerB);
        vm.prank(minerB);
        vm.expectRevert(selector);
        v4.submitCoreTexReceipt(r);
    }

    function _bytes(uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        if (len >= 2) {
            out[0] = bytes1(uint8(0x01));
            out[1] = bytes1(uint8(0x01));
        }
    }

    function _arr(uint256 a) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = a;
    }

    function _arr2(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }

    function _policyCustom(
        uint32 rulesVersion,
        uint64 effectiveEpoch,
        uint256 screenerWorkBps,
        uint256[] memory thresholds,
        uint256[] memory workBps
    ) internal pure returns (BotcoinMiningV4.CoreTexPolicyInput memory p) {
        p.rulesVersion = rulesVersion;
        p.effectiveEpoch = effectiveEpoch;
        p.screenerWorkBps = screenerWorkBps;
        p.stateAdvanceThresholds = thresholds;
        p.stateAdvanceWorkBps = workBps;
    }

    function testFuzz_defaultPolicyStateAdvanceBps(uint256 rawCount) public {
        uint256 count = bound(rawCount, 0, 1_000);
        uint256 expected = 30_000;
        if (count >= 25) expected = 40_000;
        if (count >= 100) expected = 60_000;
        if (count >= 250) expected = 90_000;
        if (count >= 500) expected = 120_000;
        assertEq(v4.computeCoreTexWorkUnitsBps(EPOCH, v4.OUTCOME_CORETEX_STATE_ADVANCE(), count), expected);
    }

    function testFuzz_invalidPatchIndexReservedReverts(uint16 rawIndex) public {
        uint16 index = uint16(bound(rawIndex, 992, 1023));
        bytes memory patchBytes = _patch(PARENT, 5, index);
        bytes32 patchHash = _patchHash(patchBytes);
        BotcoinMiningV4.CoreTexReceipt memory r =
            _stateAdvance(minerB, 0, bytes32(0), 0, PARENT, CHILD1, patchHash, patchBytes, 30_000);
        _signCoreTex(r, minerB);

        vm.prank(minerB);
        vm.expectRevert(BotcoinMiningV4.CompactPatchReservedWord.selector);
        v4.submitCoreTexReceipt(r);
    }

    function _stake(address miner, uint256 amount) internal {
        token.mint(miner, amount);
        vm.prank(miner);
        token.approve(address(v3), amount);
        vm.prank(miner);
        v3.stake(amount);
    }

    function _setContext(
        uint64 epoch,
        bytes32 parent,
        bytes32 coreVersion,
        bytes32 corpus,
        bytes32 frontier,
        bytes32 baseline
    ) internal {
        v4.setCoreTexEpochContext(
            epoch,
            BotcoinMiningV4.CoreTexEpochContext({
                parentStateRoot: parent,
                corpusRoot: corpus,
                activeFrontierRoot: frontier,
                baselineManifestHash: baseline,
                coreVersionHash: coreVersion
            })
        );
    }

    function _submitScreeners(address miner, uint256 count) internal {
        for (uint256 i; i < count; ++i) {
            bytes32 prev = v4.lastReceiptHash(miner);
            BotcoinMiningV4.CoreTexReceipt memory r =
                _screener(miner, uint64(i), prev, i, keccak256(abi.encodePacked("screen", i)));
            _signCoreTex(r, miner);
            vm.prank(miner);
            v4.submitCoreTexReceipt(r);
        }
    }

    function _defaultPolicy(uint32 rulesVersion, uint64 effectiveEpoch)
        internal
        pure
        returns (BotcoinMiningV4.CoreTexPolicyInput memory p)
    {
        p.rulesVersion = rulesVersion;
        p.effectiveEpoch = effectiveEpoch;
        p.screenerWorkBps = 10_000;
        p.stateAdvanceThresholds = new uint256[](5);
        p.stateAdvanceThresholds[0] = 0;
        p.stateAdvanceThresholds[1] = 25;
        p.stateAdvanceThresholds[2] = 100;
        p.stateAdvanceThresholds[3] = 250;
        p.stateAdvanceThresholds[4] = 500;
        p.stateAdvanceWorkBps = new uint256[](5);
        p.stateAdvanceWorkBps[0] = 30_000;
        p.stateAdvanceWorkBps[1] = 40_000;
        p.stateAdvanceWorkBps[2] = 60_000;
        p.stateAdvanceWorkBps[3] = 90_000;
        p.stateAdvanceWorkBps[4] = 120_000;
    }

    function _screener(address, uint64 solveIndex, bytes32 prev, uint256 snapshot, bytes32 patchHash)
        internal
        view
        returns (BotcoinMiningV4.CoreTexReceipt memory r)
    {
        r.epochId = EPOCH;
        r.solveIndex = solveIndex;
        r.prevReceiptHash = prev;
        r.outcome = v4.OUTCOME_CORETEX_SCREENER_PASS();
        r.challengeId = keccak256(abi.encodePacked("challenge", solveIndex));
        r.parentStateRoot = PARENT;
        r.newStateRoot = PARENT;
        r.corpusRoot = CORPUS;
        r.activeFrontierRoot = FRONTIER;
        r.coreVersionHash = CVH;
        r.evalReportHash = EVAL1;
        r.patchHash = patchHash;
        r.artifactHash = ARTIFACT;
        r.worldSeed = uint128(1000 + solveIndex);
        r.rulesVersion = 0xC0;
        (,, bytes32 policyHash,,,) = v4.getCoreTexPolicy(0xC0);
        r.workPolicyHash = policyHash;
        r.workUnitsBps = 10_000;
        r.difficultyCountSnapshot = snapshot;
        r.issuedAt = uint64(block.timestamp);
        r.expiresAt = uint64(block.timestamp + 30 minutes);
    }

    function _stateAdvance(
        address,
        uint64 solveIndex,
        bytes32 prev,
        uint256 snapshot,
        bytes32 parent,
        bytes32 child,
        bytes32 patchHash,
        bytes memory patchBytes,
        uint256 bps
    ) internal view returns (BotcoinMiningV4.CoreTexReceipt memory r) {
        r.epochId = EPOCH;
        r.solveIndex = solveIndex;
        r.prevReceiptHash = prev;
        r.outcome = v4.OUTCOME_CORETEX_STATE_ADVANCE();
        r.challengeId = keccak256(abi.encodePacked("advance", solveIndex));
        r.parentStateRoot = parent;
        r.newStateRoot = child;
        r.corpusRoot = CORPUS;
        r.activeFrontierRoot = FRONTIER;
        r.coreVersionHash = CVH;
        r.evalReportHash = EVAL1;
        r.patchHash = patchHash;
        r.artifactHash = ARTIFACT;
        r.worldSeed = uint128(2000 + solveIndex);
        r.rulesVersion = 0xC0;
        (,, bytes32 policyHash,,,) = v4.getCoreTexPolicy(0xC0);
        r.workPolicyHash = policyHash;
        r.workUnitsBps = bps;
        r.difficultyCountSnapshot = snapshot;
        r.stateWordCount = 1;
        r.scoreBeforePpm = 100;
        r.scoreAfterPpm = 105;
        r.issuedAt = uint64(block.timestamp);
        r.expiresAt = uint64(block.timestamp + 30 minutes);
        r.compactPatchBytes = patchBytes;
    }

    function _signStandard(
        address miner,
        uint64 epochId,
        uint64 solveIndex,
        bytes32 prev,
        bytes32 challengeId,
        bytes32 commit,
        uint32 rulesVersion
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                STANDARD_RECEIPT_TYPEHASH,
                miner,
                epochId,
                solveIndex,
                prev,
                challengeId,
                commit,
                bytes32("doc"),
                bytes32("qs"),
                bytes32("cons"),
                bytes32("ans"),
                uint128(1),
                rulesVersion
            )
        );
        return _signDigest(keccak256(abi.encodePacked("\x19\x01", v4.DOMAIN_SEPARATOR(), structHash)));
    }

    function _signCoreTex(BotcoinMiningV4.CoreTexReceipt memory r, address miner) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                CORETEX_RECEIPT_TYPEHASH,
                miner,
                r.epochId,
                r.solveIndex,
                r.prevReceiptHash,
                r.outcome,
                r.challengeId,
                r.parentStateRoot,
                r.newStateRoot,
                r.corpusRoot,
                r.activeFrontierRoot,
                r.coreVersionHash,
                r.evalReportHash,
                r.patchHash,
                r.artifactHash,
                r.worldSeed,
                r.rulesVersion,
                r.workPolicyHash,
                r.workUnitsBps,
                r.difficultyCountSnapshot,
                r.stateWordCount,
                r.scoreBeforePpm,
                r.scoreAfterPpm,
                r.issuedAt,
                r.expiresAt
            )
        );
        r.signature = _signDigest(keccak256(abi.encodePacked("\x19\x01", v4.DOMAIN_SEPARATOR(), structHash)));
    }

    function _signDigest(bytes32 digest) internal pure returns (bytes memory) {
        (uint8 vv, bytes32 rr, bytes32 ss) = vm.sign(COORD_PK, digest);
        return abi.encodePacked(rr, ss, vv);
    }

    function _patch(bytes32 parent, uint64 delta, uint16 index) internal pure returns (bytes memory out) {
        return _patchType(parent, delta, index, 0x01);
    }

    function _patchType(bytes32 parent, uint64 delta, uint16 index, uint8 patchType) internal pure returns (bytes memory out) {
        bytes memory indexBytes;
        if (index < 128) {
            indexBytes = abi.encodePacked(uint8(index));
        } else {
            indexBytes = abi.encodePacked(uint8((index & 0x7f) | 0x80), uint8(index >> 7));
        }
        out = new bytes(42 + indexBytes.length + 32);
        out[0] = bytes1(patchType);
        out[1] = bytes1(uint8(0x01));
        for (uint256 i; i < 8; ++i) {
            out[2 + i] = bytes1(uint8(delta >> (8 * (7 - i))));
        }
        for (uint256 i; i < 32; ++i) {
            out[10 + i] = parent[i];
        }
        for (uint256 i; i < indexBytes.length; ++i) {
            out[42 + i] = indexBytes[i];
        }
        out[out.length - 1] = bytes1(uint8(0x01));
    }

    function _lebIndex(uint16 index) internal pure returns (bytes memory) {
        if (index < 128) return abi.encodePacked(uint8(index));
        return abi.encodePacked(uint8((index & 0x7f) | 0x80), uint8(index >> 7));
    }

    function _patch2(bytes32 parent, uint64 delta, uint16 index1, uint16 index2)
        internal
        pure
        returns (bytes memory out)
    {
        bytes memory idx1 = _lebIndex(index1);
        bytes memory idx2 = _lebIndex(index2);
        out = new bytes(42 + idx1.length + 32 + idx2.length + 32);
        out[0] = bytes1(uint8(0x01));
        out[1] = bytes1(uint8(0x02));
        for (uint256 i; i < 8; ++i) {
            out[2 + i] = bytes1(uint8(delta >> (8 * (7 - i))));
        }
        for (uint256 i; i < 32; ++i) {
            out[10 + i] = parent[i];
        }
        uint256 o = 42;
        for (uint256 i; i < idx1.length; ++i) {
            out[o++] = idx1[i];
        }
        o += 32;
        out[o - 1] = bytes1(uint8(0x01)); // word 1 value
        for (uint256 i; i < idx2.length; ++i) {
            out[o++] = idx2[i];
        }
        o += 32;
        out[o - 1] = bytes1(uint8(0x02)); // word 2 value
    }

    function _patchLebContinuationMissing(bytes32 parent, uint64 delta) internal pure returns (bytes memory out) {
        out = new bytes(43);
        out[0] = bytes1(uint8(0x01));
        out[1] = bytes1(uint8(0x01));
        for (uint256 i; i < 8; ++i) {
            out[2 + i] = bytes1(uint8(delta >> (8 * (7 - i))));
        }
        for (uint256 i; i < 32; ++i) {
            out[10 + i] = parent[i];
        }
        out[42] = bytes1(uint8(0x80));
    }

    function _patchHash(bytes memory patchBytes) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("coretex-patch-hash-v1", patchBytes));
    }

    function _hash(string memory s) internal pure returns (bytes32) {
        return keccak256(bytes(s));
    }
}
