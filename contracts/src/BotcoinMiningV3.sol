// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title BotcoinMiningV3
/// @notice Mining contract with integrated staking and flexible N-tier credit
///         system for the Botcoin Proof-of-Inference protocol.
///
///         Changes from V2:
///         - Dynamic tier system: owner can configure 1–10 tiers with arbitrary
///           stake thresholds and credit values via setTiers().
///         - Credit values are uint256 (was uint8) to support scaled values.
///         - fundEpoch guards against funding epochs with zero credits.
///         - Constructor validates coordinator signer is non-zero.
///         - getTier uses custom error instead of panic on out-of-bounds.
///
///         All other mechanics (staking, receipt chain, EIP-712 verification,
///         epoch commit/reveal, claims, cooldown) are identical to V2.
contract BotcoinMiningV3 is EIP712, Ownable {
    using SafeERC20 for IERC20;

    // ── Types ───────────────────────────────────────────────────────────

    bytes32 private constant RECEIPT_TYPEHASH = keccak256(
        "Receipt(address miner,uint64 epochId,uint64 solveIndex,bytes32 prevReceiptHash,bytes32 challengeId,bytes32 commit,bytes32 docHash,bytes32 questionsHash,bytes32 constraintsHash,bytes32 answersHash,uint128 worldSeed,uint32 rulesVersion)"
    );

    struct Tier {
        uint256 stakeThreshold;
        uint256 credits;
    }

    // ── Constants ─────────────────────────────────────────────────────

    uint256 public constant EPOCH_DURATION = 86400;
    uint256 public constant MIN_UNSTAKE_COOLDOWN = 1 days;
    uint256 public constant MAX_UNSTAKE_COOLDOWN = 3 days;
    uint256 public constant MAX_CLAIM_EPOCHS = 64;
    uint256 public constant MAX_TIERS = 10;

    // ── Immutables ───────────────────────────────────────────────────

    IERC20 public immutable botcoinToken;
    uint256 public immutable genesisTimestamp;

    // ── Config ────────────────────────────────────────────────────────

    address public coordinatorSigner;

    Tier[] private _tiers;

    uint256 public unstakeCooldown;

    mapping(address => bool) public authorizedFunders;

    // ── Per-miner solve chain ───────────────────────────────────────────

    mapping(address => uint64) public nextIndex;
    mapping(address => bytes32) public lastReceiptHash;

    // ── Epoch credit accounting ─────────────────────────────────────────

    mapping(uint64 => mapping(address => uint256)) public credits;
    mapping(uint64 => uint256) public totalCredits;

    // ── Epoch rewards ───────────────────────────────────────────────────

    mapping(uint64 => uint256) public epochReward;
    mapping(uint64 => mapping(address => bool)) public claimed;

    uint256 public rewardBalance;

    /// @notice True once funding is locked and claims are open for this epoch.
    mapping(uint64 => bool) public epochFinalized;

    // ── Epoch audit anchor ──────────────────────────────────────────────

    mapping(uint64 => bytes32) public epochCommit;
    mapping(uint64 => bytes32) public epochSecret;

    // ── Staking ─────────────────────────────────────────────────────────

    mapping(address => uint256) public stakedAmount;
    mapping(address => uint256) public withdrawableAt;
    uint256 public totalStaked;

    // ── Events ──────────────────────────────────────────────────────────

    event CreditAccepted(
        uint64 indexed epochId,
        address indexed miner,
        uint64 solveIndex,
        bytes32 receiptHash,
        bytes32 challengeId,
        uint256 creditsEarned
    );

    event EpochFunded(uint64 indexed epochId, uint256 amount, uint256 totalFunded);
    event EpochFinalized(uint64 indexed epochId, uint256 totalReward);
    event RewardClaimed(uint64 indexed epochId, address indexed miner, uint256 amount);
    event CoordinatorSignerUpdated(address indexed oldSigner, address indexed newSigner);
    event TiersUpdated(uint256[] thresholds, uint256[] creditsPerTier);
    event FunderUpdated(address indexed funder, bool authorized);
    event EpochCommitSet(uint64 indexed epochId, bytes32 indexed epochCommit);
    event EpochSecretRevealed(uint64 indexed epochId, bytes32 epochSecret);
    event UnstakeCooldownUpdated(uint256 oldCooldown, uint256 newCooldown);

    event Staked(address indexed miner, uint256 amount);
    event UnstakeRequested(address indexed miner, uint256 amount, uint256 withdrawableAt);
    event UnstakeCancelled(address indexed miner);
    event Withdrawn(address indexed miner, uint256 amount);
    event DustSwept(address indexed to, uint256 amount);

    // ── Errors ──────────────────────────────────────────────────────────

    error InvalidSignature();
    error WrongEpoch();
    error ChainMismatch();
    error InsufficientBalance();
    error NotEligible();
    error CooldownNotElapsed();
    error NoUnstakePending();
    error UnstakePending();
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
    error InvalidTierConfig();
    error EpochNotEnded();
    error NothingStaked();
    error InvalidCooldown();
    error TooManyEpochs();
    error TooManyTiers();
    error TierIndexOutOfBounds();
    error EpochHasNoCredits();

    // ── Constructor ─────────────────────────────────────────────────────

    constructor(
        address _botcoinToken,
        address _coordinatorSigner,
        uint256[] memory _thresholds,
        uint256[] memory _creditsPerTier,
        uint256 _genesisTimestamp,
        uint256 _unstakeCooldown
    ) EIP712("BotcoinMining", "3") Ownable(msg.sender) {
        if (_botcoinToken == address(0)) revert ZeroAddress();
        if (_coordinatorSigner == address(0)) revert ZeroAddress();
        botcoinToken = IERC20(_botcoinToken);
        coordinatorSigner = _coordinatorSigner;
        _setTiers(_thresholds, _creditsPerTier);
        genesisTimestamp = _genesisTimestamp;
        _setUnstakeCooldown(_unstakeCooldown);
    }

    // ── Views ───────────────────────────────────────────────────────────

    function currentEpoch() public view virtual returns (uint64) {
        return uint64((block.timestamp - genesisTimestamp) / EPOCH_DURATION);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function isEligible(address miner) public view virtual returns (bool) {
        return stakedAmount[miner] >= _tiers[0].stakeThreshold && withdrawableAt[miner] == 0;
    }

    function tierCount() public view virtual returns (uint256) {
        return _tiers.length;
    }

    function getTier(uint256 index) public view virtual returns (uint256 stakeThreshold, uint256 tierCredits) {
        if (index >= _tiers.length) revert TierIndexOutOfBounds();
        Tier storage t = _tiers[index];
        return (t.stakeThreshold, t.credits);
    }

    function minStakeRequired() public view virtual returns (uint256) {
        return _tiers[0].stakeThreshold;
    }

    // ── Staking ─────────────────────────────────────────────────────────

    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        address miner = msg.sender;

        botcoinToken.safeTransferFrom(miner, address(this), amount);
        stakedAmount[miner] += amount;
        totalStaked += amount;

        if (withdrawableAt[miner] != 0) {
            withdrawableAt[miner] = 0;
            emit UnstakeCancelled(miner);
        }

        if (stakedAmount[miner] < _tiers[0].stakeThreshold) revert InsufficientBalance();

        emit Staked(miner, amount);
    }

    function unstake() external {
        address miner = msg.sender;
        if (stakedAmount[miner] == 0) revert NothingStaked();
        if (withdrawableAt[miner] != 0) revert UnstakePending();

        uint256 deadline = block.timestamp + unstakeCooldown;
        withdrawableAt[miner] = deadline;

        emit UnstakeRequested(miner, stakedAmount[miner], deadline);
    }

    function cancelUnstake() external {
        address miner = msg.sender;
        if (withdrawableAt[miner] == 0) revert NoUnstakePending();

        withdrawableAt[miner] = 0;

        emit UnstakeCancelled(miner);
    }

    function withdraw() external {
        address miner = msg.sender;
        uint256 deadline = withdrawableAt[miner];

        if (deadline == 0) revert NoUnstakePending();
        if (block.timestamp < deadline) revert CooldownNotElapsed();

        uint256 amount = stakedAmount[miner];

        stakedAmount[miner] = 0;
        withdrawableAt[miner] = 0;
        totalStaked -= amount;

        botcoinToken.safeTransfer(miner, amount);

        emit Withdrawn(miner, amount);
    }

    // ── Epoch commit anchor ─────────────────────────────────────────────

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
        if (keccak256(abi.encodePacked(_epochSecret)) != epochCommit[epochId]) {
            revert EpochSecretCommitMismatch();
        }
        epochSecret[epochId] = _epochSecret;
        emit EpochSecretRevealed(epochId, _epochSecret);
    }

    // ── Core: submit receipt ────────────────────────────────────────────

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
    ) external {
        address miner = msg.sender;

        if (epochId != currentEpoch()) revert WrongEpoch();
        if (epochCommit[epochId] == bytes32(0)) revert MissingEpochCommit();
        if (solveIndex != nextIndex[miner]) revert ChainMismatch();
        if (prevReceiptHash != lastReceiptHash[miner]) revert ChainMismatch();

        // ── Staking gate: must be staked and not unstaking ─────────
        if (withdrawableAt[miner] != 0) revert NotEligible();
        uint256 creditsEarned = _creditsForBalance(stakedAmount[miner]);
        if (creditsEarned == 0) revert InsufficientBalance();

        // Verify EIP-712 signature from coordinator
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIPT_TYPEHASH,
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
        bytes32 digest = _hashTypedDataV4(structHash);
        address recovered = ECDSA.recover(digest, signature);
        if (recovered != coordinatorSigner) revert InvalidSignature();

        bytes32 receiptHash =
            keccak256(abi.encode(miner, epochId, solveIndex, prevReceiptHash, challengeId, commit, digest));

        credits[epochId][miner] += creditsEarned;
        totalCredits[epochId] += creditsEarned;
        lastReceiptHash[miner] = receiptHash;
        nextIndex[miner] += 1;

        emit CreditAccepted(epochId, miner, solveIndex, receiptHash, challengeId, creditsEarned);
    }

    // ── Epoch funding ───────────────────────────────────────────────────

    /// @notice Deposit BOTCOIN into the reward pool for a past epoch.
    ///         Can be called multiple times — amounts accumulate.
    ///         Claims are blocked until `finalizeEpoch` is called.
    function fundEpoch(uint64 epochId, uint256 amount) external {
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

    /// @notice Lock the epoch reward pool and open claims. No further
    ///         funding is possible after this call.
    function finalizeEpoch(uint64 epochId) external {
        if (msg.sender != owner() && !authorizedFunders[msg.sender]) revert NotAuthorized();
        if (epochReward[epochId] == 0) revert EpochNotFunded();
        if (epochFinalized[epochId]) revert EpochAlreadyFinalized();
        epochFinalized[epochId] = true;
        emit EpochFinalized(epochId, epochReward[epochId]);
    }

    // ── Claims ──────────────────────────────────────────────────────────

    function claim(uint64[] calldata epochIds) external {
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

    // ── Owner-only config ───────────────────────────────────────────────

    function setFunder(address _funder, bool _authorized) external onlyOwner {
        if (_funder == address(0)) revert ZeroAddress();
        authorizedFunders[_funder] = _authorized;
        emit FunderUpdated(_funder, _authorized);
    }

    function setCoordinatorSigner(address _newSigner) external onlyOwner {
        if (_newSigner == address(0)) revert ZeroAddress();
        emit CoordinatorSignerUpdated(coordinatorSigner, _newSigner);
        coordinatorSigner = _newSigner;
    }

    function setTiers(uint256[] calldata thresholds, uint256[] calldata creditsPerTier) external onlyOwner {
        _setTiers(thresholds, creditsPerTier);
    }

    function setUnstakeCooldown(uint256 _cooldown) external onlyOwner {
        _setUnstakeCooldown(_cooldown);
    }

    function sweepDust(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = botcoinToken.balanceOf(address(this));
        uint256 obligated = totalStaked + rewardBalance;
        if (balance <= obligated) revert ZeroAmount();
        uint256 dust = balance - obligated;
        botcoinToken.safeTransfer(to, dust);
        emit DustSwept(to, dust);
    }

    // ── Internal helpers ────────────────────────────────────────────────

    function _setTiers(uint256[] memory thresholds, uint256[] memory creditsPerTier) internal {
        uint256 len = thresholds.length;
        if (len == 0) revert InvalidTierConfig();
        if (len != creditsPerTier.length) revert InvalidTierConfig();
        if (len > MAX_TIERS) revert TooManyTiers();

        delete _tiers;

        for (uint256 i = 0; i < len; i++) {
            if (thresholds[i] == 0) revert InvalidTierConfig();
            if (creditsPerTier[i] == 0) revert InvalidTierConfig();
            if (i > 0) {
                if (thresholds[i] <= thresholds[i - 1]) revert InvalidTierConfig();
                if (creditsPerTier[i] <= creditsPerTier[i - 1]) revert InvalidTierConfig();
            }
            _tiers.push(Tier(thresholds[i], creditsPerTier[i]));
        }

        emit TiersUpdated(thresholds, creditsPerTier);
    }

    function _setUnstakeCooldown(uint256 _cooldown) internal {
        if (_cooldown < MIN_UNSTAKE_COOLDOWN || _cooldown > MAX_UNSTAKE_COOLDOWN) revert InvalidCooldown();
        emit UnstakeCooldownUpdated(unstakeCooldown, _cooldown);
        unstakeCooldown = _cooldown;
    }

    function _creditsForBalance(uint256 bal) internal view returns (uint256) {
        uint256 len = _tiers.length;
        for (uint256 i = len; i > 0; i--) {
            if (bal >= _tiers[i - 1].stakeThreshold) {
                return _tiers[i - 1].credits;
            }
        }
        return 0;
    }
}
