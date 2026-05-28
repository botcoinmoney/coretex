// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBotcoinMiningV3StakeSource {
    function currentEpoch() external view returns (uint64);
    function isEligible(address miner) external view returns (bool);
    function stakedAmount(address miner) external view returns (uint256);
    function withdrawableAt(address miner) external view returns (uint256);
    function tierCount() external view returns (uint256);
    function getTier(uint256 index) external view returns (uint256 stakeThreshold, uint256 tierCredits);
    function minStakeRequired() external view returns (uint256);
}

interface ICoreTexRegistry {
    function liveStateRoot(uint64 epoch) external view returns (bytes32);
    function epochStarted(uint64 epoch) external view returns (bool);
    function epochFinalized(uint64 epoch) external view returns (bool);
    function epochReverted(uint64 epoch) external view returns (bool);
    function epochCoreVersionHash(uint64 epoch) external view returns (bytes32);
    function epochCorpusRoot(uint64 epoch) external view returns (bytes32);
    function epochActiveFrontierRoot(uint64 epoch) external view returns (bytes32);
    function submitStateAdvance(
        uint64 epoch,
        address miner,
        bytes32 parentStateRoot,
        bytes32 newStateRoot,
        bytes32 patchHash,
        bytes32 evalReportHash,
        bytes32 coreVersionHash,
        bytes32 corpusRoot,
        bytes32 activeFrontierRoot,
        uint256 improvementCredits,
        uint16 wordCount,
        bytes calldata compactPatchBytes
    ) external;
}

/// @title BotcoinMiningV4
/// @notice Unified Botcoin mining reward ledger. V3 remains the stake/tier
///         source, while V4 receives standard-lane and CoreTex-lane receipts,
///         funds epochs, finalizes rewards, and pays claims from one pool.
contract BotcoinMiningV4 is EIP712, Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Types ───────────────────────────────────────────────────────────

    struct CoreTexReceipt {
        uint64 epochId;
        uint64 solveIndex;
        bytes32 prevReceiptHash;
        uint8 outcome;
        bytes32 challengeId;
        bytes32 parentStateRoot;
        bytes32 newStateRoot;
        bytes32 corpusRoot;
        bytes32 activeFrontierRoot;
        bytes32 coreVersionHash;
        bytes32 evalReportHash;
        bytes32 patchHash;
        bytes32 artifactHash;
        uint128 worldSeed;
        uint32 rulesVersion;
        bytes32 workPolicyHash;
        uint256 workUnitsBps;
        uint256 difficultyCountSnapshot;
        uint16 stateWordCount;
        uint32 scoreBeforePpm;
        uint32 scoreAfterPpm;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes compactPatchBytes;
        bytes signature;
    }

    struct CoreTexPolicyInput {
        uint32 rulesVersion;
        uint64 effectiveEpoch;
        uint256 screenerWorkBps;
        uint256[] stateAdvanceThresholds;
        uint256[] stateAdvanceWorkBps;
    }

    struct CoreTexPolicy {
        bool exists;
        uint32 rulesVersion;
        uint64 effectiveEpoch;
        bytes32 policyHash;
        uint256 screenerWorkBps;
        uint256[] stateAdvanceThresholds;
        uint256[] stateAdvanceWorkBps;
    }

    // ── EIP-712 ─────────────────────────────────────────────────────────

    bytes32 private constant STANDARD_RECEIPT_TYPEHASH = keccak256(
        "Receipt(address miner,uint64 epochId,uint64 solveIndex,bytes32 prevReceiptHash,bytes32 challengeId,bytes32 commit,bytes32 docHash,bytes32 questionsHash,bytes32 constraintsHash,bytes32 answersHash,uint128 worldSeed,uint32 rulesVersion)"
    );

    bytes32 private constant CORETEX_RECEIPT_TYPEHASH = keccak256(
        "CoreTexReceipt(address miner,uint64 epochId,uint64 solveIndex,bytes32 prevReceiptHash,uint8 outcome,bytes32 challengeId,bytes32 parentStateRoot,bytes32 newStateRoot,bytes32 corpusRoot,bytes32 activeFrontierRoot,bytes32 coreVersionHash,bytes32 evalReportHash,bytes32 patchHash,bytes32 artifactHash,uint128 worldSeed,uint32 rulesVersion,bytes32 workPolicyHash,uint256 workUnitsBps,uint256 difficultyCountSnapshot,uint16 stateWordCount,uint32 scoreBeforePpm,uint32 scoreAfterPpm,uint64 issuedAt,uint64 expiresAt)"
    );

    // ── Constants ───────────────────────────────────────────────────────

    uint256 public constant EPOCH_DURATION = 86400;
    uint256 public constant WORK_BPS_DIVISOR = 10_000;
    uint256 public constant MAX_CLAIM_EPOCHS = 64;
    uint256 public constant MAX_CORETEX_POLICY_TIERS = 10;
    uint256 public constant MAX_SCHEDULED_CORETEX_POLICIES = 64;
    uint256 public constant MAX_CORETEX_WORK_BPS = 300_000; // 30x hard safety cap.
    uint32 public constant MAX_SCORE_PPM = 1_000_000;
    uint64 public constant MAX_WORK_RECEIPT_TTL = 1 hours;

    uint256 public constant COMPACT_PATCH_HEADER_BYTES = 42;
    uint256 public constant COMPACT_PATCH_MAX_BYTES = 178;
    uint16 public constant COMPACT_PATCH_MAX_WORDS = 4;
    uint16 public constant RESERVED_WORD_START = 992;

    bytes32 public constant PATCH_HASH_DOMAIN = keccak256("coretex-patch-hash-v1");

    uint8 public constant OUTCOME_CORETEX_SCREENER_PASS = 1;
    uint8 public constant OUTCOME_CORETEX_STATE_ADVANCE = 2;

    // ── Immutables ─────────────────────────────────────────────────────

    IERC20 public immutable botcoinToken;
    IBotcoinMiningV3StakeSource public immutable stakeSource;

    // ── Config ─────────────────────────────────────────────────────────

    address public coordinatorSigner;
    address public policyAdmin;
    ICoreTexRegistry public coreTexRegistry;
    mapping(address => bool) public authorizedFunders;

    // ── Per-miner receipt chain (unified across both lanes) ─────────────

    mapping(address => uint64) public nextIndex;
    mapping(address => bytes32) public lastReceiptHash;
    mapping(bytes32 => bool) public receiptUsed;

    // ── Unified epoch credit / reward accounting ───────────────────────

    mapping(uint64 => mapping(address => uint256)) public credits;
    mapping(uint64 => uint256) public totalCredits;
    mapping(uint64 => uint256) public epochReward;
    mapping(uint64 => mapping(address => bool)) public claimed;
    mapping(uint64 => bool) public epochFinalized;
    uint256 public rewardBalance;

    // ── Epoch audit anchor ─────────────────────────────────────────────

    mapping(uint64 => bytes32) public epochCommit;
    mapping(uint64 => bytes32) public epochSecret;

    // ── CoreTex policy + dedup state ───────────────────────────────────

    mapping(uint32 => CoreTexPolicy) private _coreTexPolicies;
    uint32[] private _scheduledCoreTexRulesVersions;
    mapping(uint64 => uint256) public qualifiedScreenerPassesSinceLastStateAdvance;
    mapping(uint64 => mapping(bytes32 => mapping(bytes32 => mapping(uint8 => bool)))) public
        coreTexPatchOutcomeCredited;

    // Per-miner per-epoch screener anti-inflation cap. Persists across state advances within an epoch
    // (a state advance resets only the global qualifiedScreenerPassesSinceLastStateAdvance counter, NOT
    // this). Adjustable by owner/policyAdmin; applies to future submissions immediately.
    mapping(uint64 => mapping(address => uint256)) public coreTexScreenerPassesByMiner;
    uint256 public coreTexScreenerCapPerMinerPerEpoch;

    // ── Events ─────────────────────────────────────────────────────────

    event CreditAccepted(
        uint64 indexed epochId,
        address indexed miner,
        uint64 solveIndex,
        bytes32 receiptHash,
        bytes32 challengeId,
        uint256 creditsEarned
    );

    event CoreTexCreditAccepted(
        uint64 indexed epochId,
        address indexed miner,
        uint64 solveIndex,
        uint8 outcome,
        bytes32 receiptHash,
        bytes32 challengeId,
        bytes32 parentStateRoot,
        bytes32 newStateRoot,
        bytes32 patchHash,
        bytes32 evalReportHash,
        bytes32 workPolicyHash,
        uint256 difficultyCountSnapshot,
        uint256 workUnitsBps,
        uint256 creditsEarned
    );

    event EpochFunded(uint64 indexed epochId, uint256 amount, uint256 totalFunded);
    event EpochFinalized(uint64 indexed epochId, uint256 totalReward);
    event RewardClaimed(uint64 indexed epochId, address indexed miner, uint256 amount);
    event CoordinatorSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event FunderUpdated(address indexed funder, bool authorized);
    event EpochCommitSet(uint64 indexed epochId, bytes32 indexed epochCommit);
    event EpochSecretRevealed(uint64 indexed epochId, bytes32 epochSecret);
    event CoreTexRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event PolicyAdminUpdated(address indexed oldAdmin, address indexed newAdmin);
    event CoreTexScreenerCapUpdated(uint256 oldCap, uint256 newCap);
    event CoreTexPolicyScheduled(
        uint32 indexed rulesVersion,
        uint64 indexed effectiveEpoch,
        bytes32 indexed policyHash,
        uint256 screenerWorkBps,
        uint256[] stateAdvanceThresholds,
        uint256[] stateAdvanceWorkBps
    );
    event DustSwept(address indexed to, uint256 amount);

    // ── Errors ─────────────────────────────────────────────────────────

    error InvalidSignature();
    error WrongEpoch();
    error ChainMismatch();
    error DuplicateReceipt();
    error DuplicateCoreTexPatch();
    error InsufficientBalance();
    error NotEligible();
    error EpochNotFunded();
    error AlreadyClaimed();
    error NoCredits();
    error EpochAlreadyFinalized();
    error EpochNotFinalized();
    error MissingEpochCommit();
    error EpochCommitAlreadySet();
    error NotAuthorized();
    error EpochSecretAlreadyRevealed();
    error EpochSecretCommitMismatch();
    error ZeroAmount();
    error ZeroAddress();
    error EpochNotEnded();
    error TooManyEpochs();
    error EpochHasNoCredits();
    error InvalidCoreTexOutcome();
    error InvalidCoreTexRoot();
    error InvalidCoreTexScore();
    error InvalidCoreTexPolicy();
    error InvalidWorkPolicyHash();
    error InvalidDifficultySnapshot();
    error WorkUnitsOutOfBounds();
    error InvalidWorkReceiptWindow();
    error WorkReceiptExpired();
    error CoreTexImprovementTooSmall();
    error InvalidCompactPatch();
    error CompactPatchHashMismatch();
    error CompactPatchParentMismatch();
    error CompactPatchScoreMismatch();
    error CompactPatchReservedWord();
    error ActiveEpochHasCredits();
    error CoreTexScreenerCapExceeded();

    // ── Constructor ────────────────────────────────────────────────────

    constructor(
        address _botcoinToken,
        address _stakeSource,
        address _coreTexRegistry,
        address _coordinatorSigner,
        address _policyAdmin,
        CoreTexPolicyInput memory initialCoreTexPolicy
    ) EIP712("BotcoinMining", "4") Ownable(msg.sender) {
        if (_botcoinToken == address(0) || _stakeSource == address(0) || _coreTexRegistry == address(0)) revert ZeroAddress();
        if (_coordinatorSigner == address(0)) revert ZeroAddress();

        botcoinToken = IERC20(_botcoinToken);
        stakeSource = IBotcoinMiningV3StakeSource(_stakeSource);
        _validateStakeSource();
        coreTexRegistry = ICoreTexRegistry(_coreTexRegistry);
        coordinatorSigner = _coordinatorSigner;
        policyAdmin = _policyAdmin == address(0) ? msg.sender : _policyAdmin;

        coreTexScreenerCapPerMinerPerEpoch = 50;
        emit CoreTexScreenerCapUpdated(0, 50);

        _storeCoreTexPolicy(initialCoreTexPolicy, true);
        emit CoreTexRegistryUpdated(address(0), _coreTexRegistry);
        emit CoordinatorSignerUpdated(address(0), _coordinatorSigner);
        emit PolicyAdminUpdated(address(0), policyAdmin);
    }

    // ── Views ──────────────────────────────────────────────────────────

    function currentEpoch() public view returns (uint64) {
        return stakeSource.currentEpoch();
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function coreTexPolicyCount() external view returns (uint256) {
        return _scheduledCoreTexRulesVersions.length;
    }

    function getCoreTexPolicy(uint32 rulesVersion)
        external
        view
        returns (
            bool exists,
            uint64 effectiveEpoch,
            bytes32 policyHash,
            uint256 screenerWorkBps,
            uint256[] memory stateAdvanceThresholds,
            uint256[] memory stateAdvanceWorkBps
        )
    {
        CoreTexPolicy storage p = _coreTexPolicies[rulesVersion];
        return
            (
                p.exists,
                p.effectiveEpoch,
                p.policyHash,
                p.screenerWorkBps,
                p.stateAdvanceThresholds,
                p.stateAdvanceWorkBps
            );
    }

    function activeCoreTexRulesVersion(uint64 epochId) public view returns (uint32) {
        uint32 active;
        uint64 activeEffective;
        uint256 len = _scheduledCoreTexRulesVersions.length;
        for (uint256 i; i < len; ++i) {
            uint32 rv = _scheduledCoreTexRulesVersions[i];
            CoreTexPolicy storage p = _coreTexPolicies[rv];
            if (p.effectiveEpoch <= epochId && p.effectiveEpoch >= activeEffective) {
                active = rv;
                activeEffective = p.effectiveEpoch;
            }
        }
        if (active == 0) revert InvalidCoreTexPolicy();
        return active;
    }

    function activeCoreTexPolicyHash(uint64 epochId) external view returns (bytes32) {
        return _coreTexPolicies[activeCoreTexRulesVersion(epochId)].policyHash;
    }

    function computeCoreTexWorkUnitsBps(uint64 epochId, uint8 outcome, uint256 difficultyCount)
        public
        view
        returns (uint256)
    {
        CoreTexPolicy storage p = _coreTexPolicies[activeCoreTexRulesVersion(epochId)];
        if (outcome == OUTCOME_CORETEX_SCREENER_PASS) return p.screenerWorkBps;
        if (outcome != OUTCOME_CORETEX_STATE_ADVANCE) revert InvalidCoreTexOutcome();

        uint256 selected = p.stateAdvanceWorkBps[0];
        for (uint256 i; i < p.stateAdvanceThresholds.length; ++i) {
            if (difficultyCount >= p.stateAdvanceThresholds[i]) {
                selected = p.stateAdvanceWorkBps[i];
            }
        }
        return selected;
    }

    function tierCreditsOf(address miner) public view returns (uint256) {
        if (!stakeSource.isEligible(miner)) return 0;
        uint256 bal = stakeSource.stakedAmount(miner);
        uint256 len = stakeSource.tierCount();
        for (uint256 i = len; i > 0; --i) {
            (uint256 threshold, uint256 tierCredits) = stakeSource.getTier(i - 1);
            if (bal >= threshold) return tierCredits;
        }
        return 0;
    }

    // ── Standard lane ──────────────────────────────────────────────────

    function submitReceipt(
        uint64 epochId,
        uint64 solveIndex,
        bytes32 prevReceiptHash,
        bytes32 challengeId,
        bytes32 commit,
        bytes32 docHash,
        bytes32 questionsHash,
        bytes32 constraintsHash,
        bytes32 answersHash,
        uint128 worldSeed,
        uint32 rulesVersion,
        bytes calldata signature
    ) external whenNotPaused {
        address miner = msg.sender;
        _validateCommonReceipt(miner, epochId, solveIndex, prevReceiptHash);

        uint256 creditsEarned = _tierCreditsOrRevert(miner);
        bytes32 digest = _standardReceiptDigest(
            miner,
            epochId,
            solveIndex,
            prevReceiptHash,
            challengeId,
            commit,
            docHash,
            questionsHash,
            constraintsHash,
            answersHash,
            worldSeed,
            rulesVersion
        );
        _requireCoordinatorSignature(digest, signature);

        bytes32 receiptHash =
            keccak256(abi.encode(miner, epochId, solveIndex, prevReceiptHash, challengeId, commit, digest));
        _acceptCredit(epochId, miner, solveIndex, receiptHash, creditsEarned);

        emit CreditAccepted(epochId, miner, solveIndex, receiptHash, challengeId, creditsEarned);
    }

    // ── CoreTex lane ───────────────────────────────────────────────────

    function submitCoreTexReceipt(CoreTexReceipt calldata r) external nonReentrant whenNotPaused {
        address miner = msg.sender;
        _validateCommonReceipt(miner, r.epochId, r.solveIndex, r.prevReceiptHash);
        _validateCoreTexNonZero(r);
        _validateReceiptWindow(r.issuedAt, r.expiresAt);

        CoreTexPolicy storage policy = _activePolicyForReceipt(r.epochId, r.rulesVersion, r.workPolicyHash);
        uint256 liveCount = qualifiedScreenerPassesSinceLastStateAdvance[r.epochId];
        if (r.difficultyCountSnapshot != liveCount) revert InvalidDifficultySnapshot();

        uint256 expectedWorkUnitsBps = computeCoreTexWorkUnitsBps(r.epochId, r.outcome, liveCount);
        if (r.workUnitsBps != expectedWorkUnitsBps || expectedWorkUnitsBps > MAX_CORETEX_WORK_BPS) {
            revert WorkUnitsOutOfBounds();
        }
        if (policy.screenerWorkBps == 0) revert InvalidCoreTexPolicy();

        uint256 tierCredits = _tierCreditsOrRevert(miner);
        uint256 creditsEarned = (tierCredits * expectedWorkUnitsBps) / WORK_BPS_DIVISOR;
        if (creditsEarned == 0) revert InsufficientBalance();

        bytes32 digest = _coreTexReceiptDigest(miner, r);
        _requireCoordinatorSignature(digest, r.signature);

        bytes32 receiptHash = keccak256(
            abi.encode(
                miner,
                r.epochId,
                r.solveIndex,
                r.prevReceiptHash,
                r.outcome,
                r.challengeId,
                r.parentStateRoot,
                r.newStateRoot,
                r.patchHash,
                r.evalReportHash,
                r.workPolicyHash,
                r.difficultyCountSnapshot,
                digest
            )
        );
        if (receiptUsed[receiptHash]) revert DuplicateReceipt();

        if (coreTexPatchOutcomeCredited[r.epochId][r.parentStateRoot][r.patchHash][r.outcome]) {
            revert DuplicateCoreTexPatch();
        }

        if (r.outcome == OUTCOME_CORETEX_SCREENER_PASS) {
            _validateScreenerReceipt(r);
            // Per-miner per-epoch anti-inflation cap (persists across state advances within the epoch).
            if (coreTexScreenerPassesByMiner[r.epochId][miner] >= coreTexScreenerCapPerMinerPerEpoch) {
                revert CoreTexScreenerCapExceeded();
            }
            coreTexScreenerPassesByMiner[r.epochId][miner] += 1;
            qualifiedScreenerPassesSinceLastStateAdvance[r.epochId] = liveCount + 1;
        } else if (r.outcome == OUTCOME_CORETEX_STATE_ADVANCE) {
            _validateStateAdvanceReceipt(r);
            coreTexRegistry.submitStateAdvance(
                r.epochId,
                miner,
                r.parentStateRoot,
                r.newStateRoot,
                r.patchHash,
                r.evalReportHash,
                r.coreVersionHash,
                r.corpusRoot,
                r.activeFrontierRoot,
                creditsEarned,
                r.stateWordCount,
                r.compactPatchBytes
            );
            qualifiedScreenerPassesSinceLastStateAdvance[r.epochId] = 0;
        } else {
            revert InvalidCoreTexOutcome();
        }

        coreTexPatchOutcomeCredited[r.epochId][r.parentStateRoot][r.patchHash][r.outcome] = true;
        _acceptCredit(r.epochId, miner, r.solveIndex, receiptHash, creditsEarned);

        emit CoreTexCreditAccepted(
            r.epochId,
            miner,
            r.solveIndex,
            r.outcome,
            receiptHash,
            r.challengeId,
            r.parentStateRoot,
            r.newStateRoot,
            r.patchHash,
            r.evalReportHash,
            r.workPolicyHash,
            r.difficultyCountSnapshot,
            expectedWorkUnitsBps,
            creditsEarned
        );
    }

    // ── Epoch funding / claims ─────────────────────────────────────────

    function fundEpoch(uint64 epochId, uint256 amount) external nonReentrant {
        if (msg.sender != owner() && !authorizedFunders[msg.sender]) revert NotAuthorized();
        if (epochId >= currentEpoch()) revert EpochNotEnded();
        if (amount == 0) revert ZeroAmount();
        if (totalCredits[epochId] == 0) revert EpochHasNoCredits();
        if (epochFinalized[epochId]) revert EpochAlreadyFinalized();
        epochReward[epochId] += amount;
        rewardBalance += amount;
        botcoinToken.safeTransferFrom(msg.sender, address(this), amount);
        emit EpochFunded(epochId, amount, epochReward[epochId]);
    }

    function finalizeEpoch(uint64 epochId) external {
        if (msg.sender != owner() && !authorizedFunders[msg.sender]) revert NotAuthorized();
        if (epochReward[epochId] == 0) revert EpochNotFunded();
        if (epochFinalized[epochId]) revert EpochAlreadyFinalized();
        epochFinalized[epochId] = true;
        emit EpochFinalized(epochId, epochReward[epochId]);
    }

    function claim(uint64[] calldata epochIds) external nonReentrant {
        if (epochIds.length > MAX_CLAIM_EPOCHS) revert TooManyEpochs();

        address miner = msg.sender;
        uint256 totalPayout;

        for (uint256 i; i < epochIds.length; ++i) {
            uint64 eid = epochIds[i];
            if (!epochFinalized[eid]) revert EpochNotFinalized();
            if (claimed[eid][miner]) revert AlreadyClaimed();
            uint256 minerCredits = credits[eid][miner];
            if (minerCredits == 0) revert NoCredits();

            claimed[eid][miner] = true;
            uint256 payout = (epochReward[eid] * minerCredits) / totalCredits[eid];
            totalPayout += payout;

            emit RewardClaimed(eid, miner, payout);
        }

        if (totalPayout > 0) {
            rewardBalance -= totalPayout;
            botcoinToken.safeTransfer(miner, totalPayout);
        }
    }

    // ── Admin ──────────────────────────────────────────────────────────

    function setEpochCommit(uint64 epochId, bytes32 _epochCommit) external {
        if (msg.sender != owner() && msg.sender != coordinatorSigner) revert NotAuthorized();
        if (_epochCommit == bytes32(0)) revert MissingEpochCommit();
        if (epochCommit[epochId] != bytes32(0)) revert EpochCommitAlreadySet();
        epochCommit[epochId] = _epochCommit;
        emit EpochCommitSet(epochId, _epochCommit);
    }

    function revealEpochSecret(uint64 epochId, bytes32 _epochSecret) external {
        if (msg.sender != owner() && msg.sender != coordinatorSigner) revert NotAuthorized();
        if (_epochSecret == bytes32(0)) revert ZeroAmount();
        if (epochCommit[epochId] == bytes32(0)) revert MissingEpochCommit();
        if (epochSecret[epochId] != bytes32(0)) revert EpochSecretAlreadyRevealed();
        if (keccak256(abi.encodePacked(_epochSecret)) != epochCommit[epochId]) revert EpochSecretCommitMismatch();
        epochSecret[epochId] = _epochSecret;
        emit EpochSecretRevealed(epochId, _epochSecret);
    }

    function setFunder(address funder, bool authorized) external onlyOwner {
        if (funder == address(0)) revert ZeroAddress();
        authorizedFunders[funder] = authorized;
        emit FunderUpdated(funder, authorized);
    }

    function setCoordinatorSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit CoordinatorSignerUpdated(coordinatorSigner, newSigner);
        coordinatorSigner = newSigner;
    }

    function setPolicyAdmin(address newAdmin) external onlyOwner {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit PolicyAdminUpdated(policyAdmin, newAdmin);
        policyAdmin = newAdmin;
    }

    function setCoreTexScreenerCapPerMinerPerEpoch(uint256 newCap) external {
        if (msg.sender != owner() && msg.sender != policyAdmin) revert NotAuthorized();
        if (newCap == 0) revert ZeroAmount();
        emit CoreTexScreenerCapUpdated(coreTexScreenerCapPerMinerPerEpoch, newCap);
        coreTexScreenerCapPerMinerPerEpoch = newCap;
    }

    function setCoreTexRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        uint64 epochId = currentEpoch();
        if (totalCredits[epochId] != 0 || qualifiedScreenerPassesSinceLastStateAdvance[epochId] != 0) {
            revert ActiveEpochHasCredits();
        }
        emit CoreTexRegistryUpdated(address(coreTexRegistry), newRegistry);
        coreTexRegistry = ICoreTexRegistry(newRegistry);
    }

    function scheduleCoreTexPolicy(CoreTexPolicyInput calldata input) external {
        if (msg.sender != owner() && msg.sender != policyAdmin) revert NotAuthorized();
        if (input.effectiveEpoch <= currentEpoch()) revert InvalidCoreTexPolicy();
        _storeCoreTexPolicy(input, false);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function sweepDust(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = botcoinToken.balanceOf(address(this));
        if (balance <= rewardBalance) revert ZeroAmount();
        uint256 dust = balance - rewardBalance;
        botcoinToken.safeTransfer(to, dust);
        emit DustSwept(to, dust);
    }

    // ── Internal: receipt validation ───────────────────────────────────

    function _validateCommonReceipt(address miner, uint64 epochId, uint64 solveIndex, bytes32 prevReceiptHash)
        internal
        view
    {
        if (epochId != currentEpoch()) revert WrongEpoch();
        if (epochCommit[epochId] == bytes32(0)) revert MissingEpochCommit();
        if (solveIndex != nextIndex[miner]) revert ChainMismatch();
        if (prevReceiptHash != lastReceiptHash[miner]) revert ChainMismatch();
    }

    function _acceptCredit(uint64 epochId, address miner, uint64 solveIndex, bytes32 receiptHash, uint256 creditsEarned)
        internal
    {
        if (receiptUsed[receiptHash]) revert DuplicateReceipt();
        receiptUsed[receiptHash] = true;
        credits[epochId][miner] += creditsEarned;
        totalCredits[epochId] += creditsEarned;
        lastReceiptHash[miner] = receiptHash;
        nextIndex[miner] = solveIndex + 1;
    }

    function _tierCreditsOrRevert(address miner) internal view returns (uint256) {
        uint256 tierCredits = tierCreditsOf(miner);
        if (tierCredits == 0) revert InsufficientBalance();
        return tierCredits;
    }

    function _requireCoordinatorSignature(bytes32 digest, bytes calldata signature) internal view {
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != coordinatorSigner) revert InvalidSignature();
    }

    function _validateReceiptWindow(uint64 issuedAt, uint64 expiresAt) internal view {
        if (issuedAt > block.timestamp || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_WORK_RECEIPT_TTL) {
            revert InvalidWorkReceiptWindow();
        }
        if (block.timestamp > expiresAt) revert WorkReceiptExpired();
    }

    function _validateCoreTexNonZero(CoreTexReceipt calldata r) internal pure {
        if (
            r.challengeId == bytes32(0) || r.parentStateRoot == bytes32(0) || r.newStateRoot == bytes32(0)
                || r.corpusRoot == bytes32(0) || r.activeFrontierRoot == bytes32(0) || r.coreVersionHash == bytes32(0)
                || r.evalReportHash == bytes32(0) || r.patchHash == bytes32(0) || r.artifactHash == bytes32(0)
        ) {
            revert InvalidCoreTexRoot();
        }
    }

    function _activePolicyForReceipt(uint64 epochId, uint32 rulesVersion, bytes32 workPolicyHash)
        internal
        view
        returns (CoreTexPolicy storage)
    {
        uint32 active = activeCoreTexRulesVersion(epochId);
        if (rulesVersion != active) revert InvalidCoreTexPolicy();
        CoreTexPolicy storage p = _coreTexPolicies[active];
        if (workPolicyHash != p.policyHash) revert InvalidWorkPolicyHash();
        return p;
    }

    function _validateRegistryContext(CoreTexReceipt calldata r) internal view {
        if (
            !coreTexRegistry.epochStarted(r.epochId) || coreTexRegistry.epochFinalized(r.epochId)
                || coreTexRegistry.epochReverted(r.epochId)
        ) {
            revert InvalidCoreTexRoot();
        }
        if (coreTexRegistry.liveStateRoot(r.epochId) != r.parentStateRoot) revert InvalidCoreTexRoot();
        if (coreTexRegistry.epochCorpusRoot(r.epochId) != r.corpusRoot) revert InvalidCoreTexRoot();
        if (coreTexRegistry.epochCoreVersionHash(r.epochId) != r.coreVersionHash) revert InvalidCoreTexRoot();
        if (coreTexRegistry.epochActiveFrontierRoot(r.epochId) != r.activeFrontierRoot) revert InvalidCoreTexRoot();
    }

    function _validateScreenerReceipt(CoreTexReceipt calldata r) internal view {
        _validateRegistryContext(r);
        if (r.newStateRoot != r.parentStateRoot) revert InvalidCoreTexRoot();
        if (r.scoreBeforePpm != 0 || r.scoreAfterPpm != 0 || r.stateWordCount != 0) revert InvalidCoreTexScore();
        if (r.compactPatchBytes.length != 0) {
            _validatePatchHash(r.compactPatchBytes, r.patchHash);
        }
    }

    function _validateStateAdvanceReceipt(CoreTexReceipt calldata r) internal view {
        _validateRegistryContext(r);
        uint32 scoreDeltaPpm = _validatedScoreDelta(r.scoreBeforePpm, r.scoreAfterPpm, 1);
        uint16 wordCount = _validateCompactPatch(r.compactPatchBytes, r.patchHash, r.parentStateRoot, scoreDeltaPpm);
        if (r.stateWordCount != wordCount) revert InvalidCompactPatch();
    }

    function _validatedScoreDelta(uint32 scoreBeforePpm, uint32 scoreAfterPpm, uint32 minImprovementPpm)
        internal
        pure
        returns (uint32)
    {
        if (scoreBeforePpm > MAX_SCORE_PPM || scoreAfterPpm > MAX_SCORE_PPM || scoreAfterPpm <= scoreBeforePpm) {
            revert InvalidCoreTexScore();
        }
        uint32 delta = scoreAfterPpm - scoreBeforePpm;
        if (delta < minImprovementPpm) revert CoreTexImprovementTooSmall();
        return delta;
    }

    function _validatePatchHash(bytes calldata compactPatchBytes, bytes32 patchHash) internal pure {
        if (keccak256(abi.encodePacked("coretex-patch-hash-v1", compactPatchBytes)) != patchHash) {
            revert CompactPatchHashMismatch();
        }
    }

    function _validateCompactPatch(
        bytes calldata compactPatchBytes,
        bytes32 patchHash,
        bytes32 parentStateRoot,
        uint32 scoreDeltaPpm
    ) internal pure returns (uint16 wordCount) {
        uint256 len = compactPatchBytes.length;
        if (len < COMPACT_PATCH_HEADER_BYTES || len > COMPACT_PATCH_MAX_BYTES) revert InvalidCompactPatch();
        _validatePatchHash(compactPatchBytes, patchHash);

        uint8 patchType = uint8(compactPatchBytes[0]);
        wordCount = uint16(uint8(compactPatchBytes[1]));
        if (!_isKnownPatchType(patchType) || wordCount == 0 || wordCount > COMPACT_PATCH_MAX_WORDS) {
            revert InvalidCompactPatch();
        }

        uint64 patchScoreDelta = _readUint64BE(compactPatchBytes, 2);
        if (patchScoreDelta > 9_223_372_036_854_775_807 || patchScoreDelta != uint64(scoreDeltaPpm)) {
            revert CompactPatchScoreMismatch();
        }
        if (_readBytes32(compactPatchBytes, 10) != parentStateRoot) revert CompactPatchParentMismatch();

        uint256 offset = COMPACT_PATCH_HEADER_BYTES;
        for (uint16 i; i < wordCount; ++i) {
            (uint16 index, uint256 nextOffset) = _readLeb128WordIndex(compactPatchBytes, offset);
            if (index >= RESERVED_WORD_START || !_wordMatchesPatchType(patchType, index)) {
                revert CompactPatchReservedWord();
            }
            offset = nextOffset + 32;
            if (offset > len) revert InvalidCompactPatch();
        }
        if (offset != len) revert InvalidCompactPatch();
    }

    // ── Internal: policy ───────────────────────────────────────────────

    function _storeCoreTexPolicy(CoreTexPolicyInput memory input, bool allowCurrentEpoch) internal {
        _validateCoreTexPolicy(input, allowCurrentEpoch);
        CoreTexPolicy storage p = _coreTexPolicies[input.rulesVersion];
        if (p.exists) revert InvalidCoreTexPolicy();
        for (uint256 i; i < _scheduledCoreTexRulesVersions.length; ++i) {
            if (_coreTexPolicies[_scheduledCoreTexRulesVersions[i]].effectiveEpoch == input.effectiveEpoch) {
                revert InvalidCoreTexPolicy();
            }
        }

        p.exists = true;
        p.rulesVersion = input.rulesVersion;
        p.effectiveEpoch = input.effectiveEpoch;
        p.screenerWorkBps = input.screenerWorkBps;
        p.policyHash = _computeCoreTexPolicyHash(input);
        for (uint256 i; i < input.stateAdvanceThresholds.length; ++i) {
            p.stateAdvanceThresholds.push(input.stateAdvanceThresholds[i]);
            p.stateAdvanceWorkBps.push(input.stateAdvanceWorkBps[i]);
        }

        if (_scheduledCoreTexRulesVersions.length >= MAX_SCHEDULED_CORETEX_POLICIES) revert InvalidCoreTexPolicy();
        _scheduledCoreTexRulesVersions.push(input.rulesVersion);

        emit CoreTexPolicyScheduled(
            input.rulesVersion,
            input.effectiveEpoch,
            p.policyHash,
            input.screenerWorkBps,
            input.stateAdvanceThresholds,
            input.stateAdvanceWorkBps
        );
    }

    function _validateCoreTexPolicy(CoreTexPolicyInput memory input, bool allowCurrentEpoch) internal view {
        if (input.rulesVersion == 0) revert InvalidCoreTexPolicy();
        if (!allowCurrentEpoch && input.effectiveEpoch <= currentEpoch()) revert InvalidCoreTexPolicy();
        if (input.screenerWorkBps == 0 || input.screenerWorkBps > MAX_CORETEX_WORK_BPS) revert InvalidCoreTexPolicy();
        uint256 len = input.stateAdvanceThresholds.length;
        if (len == 0 || len != input.stateAdvanceWorkBps.length || len > MAX_CORETEX_POLICY_TIERS) {
            revert InvalidCoreTexPolicy();
        }
        if (input.stateAdvanceThresholds[0] != 0) revert InvalidCoreTexPolicy();

        uint256 lastThreshold;
        uint256 lastWorkBps;
        for (uint256 i; i < len; ++i) {
            uint256 threshold = input.stateAdvanceThresholds[i];
            uint256 workBps = input.stateAdvanceWorkBps[i];
            if (i > 0 && threshold <= lastThreshold) revert InvalidCoreTexPolicy();
            if (workBps < input.screenerWorkBps || workBps < lastWorkBps || workBps > MAX_CORETEX_WORK_BPS) {
                revert InvalidCoreTexPolicy();
            }
            lastThreshold = threshold;
            lastWorkBps = workBps;
        }
    }

    function _computeCoreTexPolicyHash(CoreTexPolicyInput memory input) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("botcoin-coretex-work-policy-v4"),
                input.rulesVersion,
                input.effectiveEpoch,
                input.screenerWorkBps,
                input.stateAdvanceThresholds,
                input.stateAdvanceWorkBps,
                WORK_BPS_DIVISOR,
                MAX_CORETEX_WORK_BPS
            )
        );
    }

    // ── Internal: EIP-712 digests ──────────────────────────────────────

    function _standardReceiptDigest(
        address miner,
        uint64 epochId,
        uint64 solveIndex,
        bytes32 prevReceiptHash,
        bytes32 challengeId,
        bytes32 commit,
        bytes32 docHash,
        bytes32 questionsHash,
        bytes32 constraintsHash,
        bytes32 answersHash,
        uint128 worldSeed,
        uint32 rulesVersion
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                STANDARD_RECEIPT_TYPEHASH,
                miner,
                epochId,
                solveIndex,
                prevReceiptHash,
                challengeId,
                commit,
                docHash,
                questionsHash,
                constraintsHash,
                answersHash,
                worldSeed,
                rulesVersion
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function _coreTexReceiptDigest(address miner, CoreTexReceipt calldata r) internal view returns (bytes32) {
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
        return _hashTypedDataV4(structHash);
    }

    // ── Internal: compact-patch helpers ────────────────────────────────

    function _readLeb128WordIndex(bytes calldata data, uint256 offset)
        internal
        pure
        returns (uint16 value, uint256 nextOffset)
    {
        if (offset >= data.length) revert InvalidCompactPatch();
        uint8 first = uint8(data[offset]);
        value = uint16(first & 0x7f);
        nextOffset = offset + 1;
        if (first & 0x80 == 0) return (value, nextOffset);

        if (nextOffset >= data.length) revert InvalidCompactPatch();
        uint8 second = uint8(data[nextOffset]);
        if (second & 0x80 != 0) revert InvalidCompactPatch();
        value |= uint16(second & 0x7f) << 7;
        if (value < 128 || value >= 1024) revert InvalidCompactPatch();
        return (value, nextOffset + 1);
    }

    function _readUint64BE(bytes calldata data, uint256 offset) internal pure returns (uint64 value) {
        if (offset + 8 > data.length) revert InvalidCompactPatch();
        for (uint256 i; i < 8; ++i) {
            value = (value << 8) | uint64(uint8(data[offset + i]));
        }
    }

    function _readBytes32(bytes calldata data, uint256 offset) internal pure returns (bytes32 value) {
        if (offset + 32 > data.length) revert InvalidCompactPatch();
        assembly {
            value := calldataload(add(data.offset, offset))
        }
    }

    function _isKnownPatchType(uint8 patchType) internal pure returns (bool) {
        return patchType >= 0x01 && patchType <= 0x06 || patchType == 0xff;
    }

    function _wordMatchesPatchType(uint8 patchType, uint16 index) internal pure returns (bool) {
        if (patchType == 0xff) return true;
        if (patchType == 0x01) return index >= 384 && index <= 671;
        if (patchType == 0x02) return index >= 32 && index <= 383;
        if (patchType == 0x03) return index >= 800 && index <= 895;
        if (patchType == 0x04) return index >= 672 && index <= 799;
        if (patchType == 0x05) return index >= 896 && index <= 991;
        if (patchType == 0x06) return index <= 31;
        return false;
    }

    function _validateStakeSource() internal view {
        if (stakeSource.tierCount() == 0 || stakeSource.minStakeRequired() == 0) revert ZeroAddress();
    }
}
