// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {BotcoinMiningV3} from "../src/BotcoinMiningV3.sol";
import {BotcoinMiningV4} from "../src/BotcoinMiningV4.sol";
import {CoreTexRegistry} from "../src/CoreTexRegistry.sol";

contract InvariantBOT is ERC20 {
    constructor() ERC20("Invariant BOT", "IBOT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract BotcoinMiningV4Handler is Test {
    bytes32 private constant STANDARD_RECEIPT_TYPEHASH = keccak256(
        "Receipt(address miner,uint64 epochId,uint64 solveIndex,bytes32 prevReceiptHash,bytes32 challengeId,bytes32 commit,bytes32 docHash,bytes32 questionsHash,bytes32 constraintsHash,bytes32 answersHash,uint128 worldSeed,uint32 rulesVersion)"
    );
    bytes32 private constant CORETEX_RECEIPT_TYPEHASH = keccak256(
        "CoreTexReceipt(address miner,uint64 epochId,uint64 solveIndex,bytes32 prevReceiptHash,uint8 outcome,bytes32 challengeId,bytes32 parentStateRoot,bytes32 newStateRoot,bytes32 corpusRoot,bytes32 activeFrontierRoot,bytes32 coreVersionHash,bytes32 evalReportHash,bytes32 patchHash,bytes32 artifactHash,uint128 worldSeed,uint32 rulesVersion,bytes32 workPolicyHash,uint256 workUnitsBps,uint256 difficultyCountSnapshot,uint16 stateWordCount,uint32 scoreBeforePpm,uint32 scoreAfterPpm,uint64 issuedAt,uint64 expiresAt)"
    );

    uint256 private constant COORD_PK = 0xC0A1;
    uint64 public constant EPOCH = 7;
    bytes32 private constant CVH = bytes32(uint256(0xBEEF));
    bytes32 private constant CORPUS = bytes32(uint256(0xC0FFEE));
    bytes32 private constant FRONTIER = bytes32(uint256(0xF00D));
    bytes32 private constant EVAL1 = bytes32(uint256(0xEE01));
    bytes32 private constant ARTIFACT = bytes32(uint256(0xA47));

    BotcoinMiningV4 public v4;
    CoreTexRegistry public registry;
    address[] public miners;
    bytes32 public expectedRoot;
    uint256 public expectedTotalCredits;
    uint256 public expectedCounter;
    uint256 public serial;

    mapping(address => uint256) public expectedCredits;
    mapping(address => uint64) public expectedNextIndex;

    constructor(BotcoinMiningV4 _v4, CoreTexRegistry _registry, address[] memory _miners, bytes32 root) {
        v4 = _v4;
        registry = _registry;
        miners = _miners;
        expectedRoot = root;
    }

    function standard(uint8 who) external {
        address miner = miners[uint256(who) % miners.length];
        uint64 idx = v4.nextIndex(miner);
        bytes32 prev = v4.lastReceiptHash(miner);
        bytes32 challengeId = keccak256(abi.encodePacked("std", miner, serial++));
        bytes32 commit = keccak256(abi.encodePacked("commit", challengeId));
        bytes memory sig = _signStandard(miner, idx, prev, challengeId, commit);

        vm.prank(miner);
        v4.submitReceipt(
            EPOCH,
            idx,
            prev,
            challengeId,
            commit,
            bytes32("doc"),
            bytes32("qs"),
            bytes32("cons"),
            bytes32("ans"),
            uint128(serial),
            1,
            sig
        );
        _recordCredit(miner, v4.tierCreditsOf(miner));
    }

    function screener(uint8 who) external {
        address miner = miners[uint256(who) % miners.length];
        uint64 idx = v4.nextIndex(miner);
        bytes32 prev = v4.lastReceiptHash(miner);
        BotcoinMiningV4.CoreTexReceipt memory r;
        r.epochId = EPOCH;
        r.solveIndex = idx;
        r.prevReceiptHash = prev;
        r.outcome = v4.OUTCOME_CORETEX_SCREENER_PASS();
        r.challengeId = keccak256(abi.encodePacked("screen-ch", miner, serial));
        r.parentStateRoot = expectedRoot;
        r.newStateRoot = expectedRoot;
        r.corpusRoot = CORPUS;
        r.activeFrontierRoot = FRONTIER;
        r.coreVersionHash = CVH;
        r.evalReportHash = EVAL1;
        r.patchHash = keccak256(abi.encodePacked("screen-patch", miner, serial++));
        r.artifactHash = ARTIFACT;
        r.worldSeed = uint128(serial);
        r.rulesVersion = 0xC0;
        (,, bytes32 policyHash,,,) = v4.getCoreTexPolicy(0xC0);
        r.workPolicyHash = policyHash;
        r.workUnitsBps = v4.computeCoreTexWorkUnitsBps(EPOCH, r.outcome, expectedCounter);
        r.difficultyCountSnapshot = expectedCounter;
        r.issuedAt = uint64(block.timestamp);
        r.expiresAt = uint64(block.timestamp + 30 minutes);
        _signCoreTex(r, miner);

        vm.prank(miner);
        v4.submitCoreTexReceipt(r);
        _recordCredit(miner, (v4.tierCreditsOf(miner) * r.workUnitsBps) / v4.WORK_BPS_DIVISOR());
        expectedCounter++;
    }

    function advance(uint8 who) external {
        address miner = miners[uint256(who) % miners.length];
        uint64 idx = v4.nextIndex(miner);
        bytes32 prev = v4.lastReceiptHash(miner);
        bytes32 child = keccak256(abi.encodePacked("child", serial, expectedRoot));
        bytes memory patchBytes = _patch(expectedRoot, 5, 384);
        BotcoinMiningV4.CoreTexReceipt memory r;
        r.epochId = EPOCH;
        r.solveIndex = idx;
        r.prevReceiptHash = prev;
        r.outcome = v4.OUTCOME_CORETEX_STATE_ADVANCE();
        r.challengeId = keccak256(abi.encodePacked("advance", miner, serial++));
        r.parentStateRoot = expectedRoot;
        r.newStateRoot = child;
        r.corpusRoot = CORPUS;
        r.activeFrontierRoot = FRONTIER;
        r.coreVersionHash = CVH;
        r.evalReportHash = EVAL1;
        r.patchHash = keccak256(abi.encodePacked("coretex-patch-hash-v1", patchBytes));
        r.artifactHash = ARTIFACT;
        r.worldSeed = uint128(serial);
        r.rulesVersion = 0xC0;
        (,, bytes32 policyHash,,,) = v4.getCoreTexPolicy(0xC0);
        r.workPolicyHash = policyHash;
        r.workUnitsBps = v4.computeCoreTexWorkUnitsBps(EPOCH, r.outcome, expectedCounter);
        r.difficultyCountSnapshot = expectedCounter;
        r.stateWordCount = 1;
        r.scoreBeforePpm = 100;
        r.scoreAfterPpm = 105;
        r.issuedAt = uint64(block.timestamp);
        r.expiresAt = uint64(block.timestamp + 30 minutes);
        r.compactPatchBytes = patchBytes;
        _signCoreTex(r, miner);

        vm.prank(miner);
        v4.submitCoreTexReceipt(r);
        _recordCredit(miner, (v4.tierCreditsOf(miner) * r.workUnitsBps) / v4.WORK_BPS_DIVISOR());
        expectedCounter = 0;
        expectedRoot = child;
    }

    function _recordCredit(address miner, uint256 amount) internal {
        expectedCredits[miner] += amount;
        expectedTotalCredits += amount;
        expectedNextIndex[miner] += 1;
    }

    function _signStandard(address miner, uint64 idx, bytes32 prev, bytes32 challengeId, bytes32 commit)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                STANDARD_RECEIPT_TYPEHASH,
                miner,
                EPOCH,
                idx,
                prev,
                challengeId,
                commit,
                bytes32("doc"),
                bytes32("qs"),
                bytes32("cons"),
                bytes32("ans"),
                uint128(serial),
                uint32(1)
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
        bytes memory indexBytes = abi.encodePacked(uint8((index & 0x7f) | 0x80), uint8(index >> 7));
        out = new bytes(42 + indexBytes.length + 32);
        out[0] = bytes1(uint8(0x01));
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
}

contract BotcoinMiningV4InvariantTest is Test {
    uint256 private constant COORD_PK = 0xC0A1;
    address private coordinator = vm.addr(COORD_PK);
    uint256 private constant GENESIS = 1_700_000_000;
    uint64 private constant EPOCH = 7;
    bytes32 private constant PARENT = bytes32(uint256(0x1111));
    bytes32 private constant CVH = bytes32(uint256(0xBEEF));
    bytes32 private constant CORPUS = bytes32(uint256(0xC0FFEE));
    bytes32 private constant FRONTIER = bytes32(uint256(0xF00D));
    bytes32 private constant BASELINE = bytes32(uint256(0xBA5E));
    bytes32 private constant SEEDCOMMIT = bytes32(uint256(0x5EED));
    bytes32 private constant EPOCH_SECRET = bytes32(uint256(0x515151));

    InvariantBOT token;
    BotcoinMiningV3 v3;
    BotcoinMiningV4 v4;
    CoreTexRegistry registry;
    BotcoinMiningV4Handler handler;
    address[] miners;

    function setUp() public {
        vm.warp(GENESIS + uint256(EPOCH) * 1 days + 1);
        token = new InvariantBOT();
        uint256[] memory thresholds = new uint256[](3);
        thresholds[0] = 100 ether;
        thresholds[1] = 200 ether;
        thresholds[2] = 500 ether;
        uint256[] memory tierCredits = new uint256[](3);
        tierCredits[0] = 100;
        tierCredits[1] = 205;
        tierCredits[2] = 520;
        v3 = new BotcoinMiningV3(address(token), coordinator, thresholds, tierCredits, GENESIS, 1 days);
        registry = new CoreTexRegistry(address(this), coordinator);
        v4 = new BotcoinMiningV4(
            address(token), address(v3), address(registry), coordinator, address(this), _defaultPolicy(0xC0, 0)
        );
        registry.addCoordinator(address(v4));
        // Raise screener cap above the fuzz budget so the invariant exercises credit-accounting,
        // not the (separately unit-tested) per-miner screener cap.
        v4.setCoreTexScreenerCapPerMinerPerEpoch(10_000);

        miners.push(address(0xA11CE));
        miners.push(address(0xB0B));
        miners.push(address(0xCAFE));
        _stake(miners[0], 100 ether);
        _stake(miners[1], 200 ether);
        _stake(miners[2], 500 ether);
        v4.setEpochCommit(EPOCH, keccak256(abi.encodePacked(EPOCH_SECRET)));
        vm.prank(coordinator);
        registry.startEpoch(EPOCH, PARENT, CVH, CORPUS, FRONTIER, BASELINE, SEEDCOMMIT);

        handler = new BotcoinMiningV4Handler(v4, registry, miners, PARENT);
        targetContract(address(handler));
    }

    function invariant_totalCreditsMatchTrackedMinerCredits() public view {
        uint256 sum;
        for (uint256 i; i < miners.length; ++i) {
            sum += v4.credits(EPOCH, miners[i]);
            assertEq(v4.credits(EPOCH, miners[i]), handler.expectedCredits(miners[i]));
            assertEq(v4.nextIndex(miners[i]), handler.expectedNextIndex(miners[i]));
        }
        assertEq(v4.totalCredits(EPOCH), sum);
        assertEq(v4.totalCredits(EPOCH), handler.expectedTotalCredits());
    }

    // Per-miner cap persists across advances; global resets — so sum of per-miner across the epoch
    // is always >= the global since-last-advance counter.
    function invariant_globalScreenerLeqSumOfPerMinerScreener() public view {
        uint256 perMinerSum;
        for (uint256 i; i < miners.length; ++i) {
            perMinerSum += v4.coreTexScreenerPassesByMiner(EPOCH, miners[i]);
        }
        assertLe(v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), perMinerSum);
    }

    function invariant_coreTexCounterAndRegistryRootMatchHandler() public view {
        assertEq(v4.qualifiedScreenerPassesSinceLastStateAdvance(EPOCH), handler.expectedCounter());
        assertEq(registry.liveStateRoot(EPOCH), handler.expectedRoot());
    }

    function invariant_rewardBalanceNeverExceedsTokenBalance() public view {
        assertGe(token.balanceOf(address(v4)), v4.rewardBalance());
    }

    function _stake(address miner, uint256 amount) internal {
        token.mint(miner, amount);
        vm.prank(miner);
        token.approve(address(v3), amount);
        vm.prank(miner);
        v3.stake(amount);
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
}
