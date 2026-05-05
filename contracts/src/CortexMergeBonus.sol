// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title ICortexRegistry
/// @notice Read-only view into CortexRegistry for audit-window checks.
interface ICortexRegistry {
    function epochFinalized(uint64 epoch) external view returns (bool);
    function finalizedAt(uint64 epoch) external view returns (uint256);
    function epochReverted(uint64 epoch) external view returns (bool);
    function CHALLENGE_WINDOW_SECONDS() external view returns (uint256);
}

/// @title CortexMergeBonus
/// @notice Multiplier-uplift bonus for miners whose Cortex patches are merged
///         by the epoch reducer. Mirrors the existing BonusEpoch pattern.
///
///         Funding model:
///         - Coordinator funds the contract AFTER the CortexRegistry audit window
///           closes for that epoch. Calling fundEpoch() before the window closes reverts.
///         - Per epoch the coordinator posts a Merkle root of (miner, bonusBOTCOIN, capBOTCOIN)
///           leaves. On-chain verification checks bonus ≤ cap.
///         - MERGE_MULTIPLIER stored as basis points; 15000 = 1.5×. Cap = (MERGE_MULTIPLIER − 10000)
///           × claimBase / 10000 is encoded into each Merkle leaf (capBOTCOIN field).
///
///         The SWCP receipt path and BotcoinMiningV3 are NOT touched.
contract CortexMergeBonus is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ─────────────────────────────────────────────────────────

    uint256 public constant MAX_CLAIM_EPOCHS    = 64;
    uint256 public constant MERGE_MULTIPLIER_BPS = 15000; // 1.5× in basis points

    // ── Immutables ────────────────────────────────────────────────────────

    IERC20 public immutable botcoin;

    // ── Config (mutable) ─────────────────────────────────────────────────

    /// @notice CortexRegistry — consulted to verify audit window has closed.
    ///         May be address(0) if registry is not yet deployed; funding
    ///         will revert unless registry is set.
    ICortexRegistry public registry;

    /// @notice Coordinator address that funds epochs and triggers claims.
    address public operator;

    // ── Per-epoch funding state ───────────────────────────────────────────

    /// @notice Merkle root of (miner, bonusBOTCOIN, capBOTCOIN) leaves.
    mapping(uint64 => bytes32) public epochMerkleRoot;

    /// @notice Total BOTCOIN deposited for a funded epoch.
    mapping(uint64 => uint256) public epochTotalBonus;

    /// @notice True once claims are open for an epoch.
    mapping(uint64 => bool) public claimsOpen;

    // ── Claim tracking ────────────────────────────────────────────────────

    mapping(uint64 => mapping(address => bool)) public claimed;

    // ── Reward accounting ─────────────────────────────────────────────────

    uint256 public rewardBalance;

    // ── Events ────────────────────────────────────────────────────────────

    event EpochFunded(uint64 indexed epoch, bytes32 minerBonusRoot, uint256 totalBonus);
    event MergeBonusClaimed(address indexed miner, uint64[] epochIds, uint256 amount);
    event RegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event DustSwept(address indexed to, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotAuthorized();
    error RegistryNotSet();
    error EpochNotFinalized();
    error AuditWindowStillOpen();
    error EpochWasReverted();
    error AlreadyFunded();
    error ClaimsNotOpen();
    error AlreadyClaimed();
    error InvalidProof();
    error BonusExceedsCap();
    error TooManyEpochs();
    error NothingFunded();

    // ── Constructor ───────────────────────────────────────────────────────

    /// @param _botcoin   BOTCOIN ERC-20 token.
    /// @param _registry  CortexRegistry address (may be address(0) — set later).
    /// @param _operator  Coordinator/operator address for funding and pool-mode.
    constructor(
        address _botcoin,
        address _registry,
        address _operator
    ) Ownable(msg.sender) {
        if (_botcoin == address(0)) revert ZeroAddress();
        if (_operator == address(0)) revert ZeroAddress();
        botcoin = IERC20(_botcoin);
        if (_registry != address(0)) {
            registry = ICortexRegistry(_registry);
            emit RegistryUpdated(address(0), _registry);
        }
        operator = _operator;
        emit OperatorUpdated(address(0), _operator);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────

    modifier onlyOperatorOrOwner() {
        if (msg.sender != operator && msg.sender != owner()) revert NotAuthorized();
        _;
    }

    // ── Coordinator: fund epoch ───────────────────────────────────────────

    /// @notice Fund a merge-bonus epoch AFTER the CortexRegistry audit window closes.
    ///         Posts a Merkle root of (miner, bonusBOTCOIN, capBOTCOIN) pairs.
    ///         Cannot be called while the audit window is still open or if the epoch
    ///         was reverted by the operator multisig.
    /// @param epoch           The epoch to fund.
    /// @param minerBonusRoot  Merkle root of leaf = keccak256(miner, bonusBOTCOIN, capBOTCOIN).
    /// @param amount          Total BOTCOIN to deposit (sum of all per-miner bonuses).
    function fundEpoch(
        uint64  epoch,
        bytes32 minerBonusRoot,
        uint256 amount
    ) external onlyOperatorOrOwner whenNotPaused nonReentrant {
        if (address(registry) == address(0)) revert RegistryNotSet();
        // Check revert before finalized: revertEpoch() sets epochFinalized=false,
        // so we must distinguish "never finalized" from "reverted after finalization".
        if (registry.epochReverted(epoch))     revert EpochWasReverted();
        if (!registry.epochFinalized(epoch))   revert EpochNotFinalized();

        // Enforce audit window — cannot fund while window is open.
        uint256 window    = registry.CHALLENGE_WINDOW_SECONDS();
        uint256 finalTime = registry.finalizedAt(epoch);
        if (block.timestamp <= finalTime + window) revert AuditWindowStillOpen();

        if (epochMerkleRoot[epoch] != bytes32(0)) revert AlreadyFunded();
        if (amount == 0) revert ZeroAmount();

        epochMerkleRoot[epoch]  = minerBonusRoot;
        epochTotalBonus[epoch]  = amount;
        claimsOpen[epoch]       = true;
        rewardBalance          += amount;

        botcoin.safeTransferFrom(msg.sender, address(this), amount);

        emit EpochFunded(epoch, minerBonusRoot, amount);
    }

    // ── Claim entrypoint ──────────────────────────────────────────────────

    /// @notice Claim merge bonus for one or more epochs. Mirrors BonusEpoch.claimBonus UX.
    /// @param epochIds     Epochs to claim.
    /// @param bonusAmounts Per-epoch bonusBOTCOIN amounts (matched to proof).
    /// @param capAmounts   Per-epoch capBOTCOIN amounts encoded in each Merkle leaf.
    /// @param proofs       Per-epoch Merkle proofs.
    function claimMergeBonus(
        uint64[]         calldata epochIds,
        uint256[]        calldata bonusAmounts,
        uint256[]        calldata capAmounts,
        bytes32[][] calldata proofs
    ) external whenNotPaused nonReentrant {
        uint256 len = epochIds.length;
        if (len > MAX_CLAIM_EPOCHS) revert TooManyEpochs();

        address miner = msg.sender;
        uint256 totalPayout;

        for (uint256 i; i < len; ++i) {
            uint64 eid = epochIds[i];
            if (!claimsOpen[eid])        revert ClaimsNotOpen();
            if (claimed[eid][miner])     revert AlreadyClaimed();

            // Cap enforcement: bonus must not exceed capBOTCOIN from the leaf.
            if (bonusAmounts[i] > capAmounts[i]) revert BonusExceedsCap();

            // Verify Merkle proof: leaf = keccak256(miner, bonusBOTCOIN, capBOTCOIN)
            bytes32 leaf = keccak256(abi.encodePacked(miner, bonusAmounts[i], capAmounts[i]));
            if (!MerkleProof.verify(proofs[i], epochMerkleRoot[eid], leaf)) revert InvalidProof();

            claimed[eid][miner] = true;
            totalPayout += bonusAmounts[i];

            // Emit single-epoch claim event for indexer compatibility.
            uint64[] memory single = new uint64[](1);
            single[0] = eid;
            emit MergeBonusClaimed(miner, single, bonusAmounts[i]);
        }

        if (totalPayout > 0) {
            rewardBalance -= totalPayout;
            botcoin.safeTransfer(miner, totalPayout);
        }
    }

    // ── Pool-mode calldata ────────────────────────────────────────────────

    /// @notice Pool-mode wrapper. Pool contracts call this; msg.sender is the pool.
    ///         The pool contract must supply valid proofs/amounts for the pooled
    ///         miner's allocation. Mirrors existing bonus-epoch pool flow.
    /// @param epochIds     Epochs to claim.
    /// @param miner        The miner whose bonus is being claimed by the pool.
    /// @param bonusAmounts Per-epoch bonus amounts.
    /// @param capAmounts   Per-epoch cap amounts.
    /// @param proofs       Per-epoch Merkle proofs (leaf uses `miner`, not msg.sender).
    function triggerMergeBonusClaim(
        uint64[]  calldata epochIds,
        address   miner,
        uint256[] calldata bonusAmounts,
        uint256[] calldata capAmounts,
        bytes32[][] calldata proofs
    ) external whenNotPaused nonReentrant {
        uint256 len = epochIds.length;
        if (len > MAX_CLAIM_EPOCHS) revert TooManyEpochs();

        uint256 totalPayout;

        for (uint256 i; i < len; ++i) {
            uint64 eid = epochIds[i];
            if (!claimsOpen[eid])        revert ClaimsNotOpen();
            if (claimed[eid][miner])     revert AlreadyClaimed();

            if (bonusAmounts[i] > capAmounts[i]) revert BonusExceedsCap();

            bytes32 leaf = keccak256(abi.encodePacked(miner, bonusAmounts[i], capAmounts[i]));
            if (!MerkleProof.verify(proofs[i], epochMerkleRoot[eid], leaf)) revert InvalidProof();

            claimed[eid][miner] = true;
            totalPayout += bonusAmounts[i];

            uint64[] memory single = new uint64[](1);
            single[0] = eid;
            emit MergeBonusClaimed(miner, single, bonusAmounts[i]);
        }

        if (totalPayout > 0) {
            rewardBalance -= totalPayout;
            // Pay out to the miner directly (pool is caller but miner gets funds).
            botcoin.safeTransfer(miner, totalPayout);
        }
    }

    // ── Owner-only config ─────────────────────────────────────────────────

    function setRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert ZeroAddress();
        emit RegistryUpdated(address(registry), _registry);
        registry = ICortexRegistry(_registry);
    }

    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, _operator);
        operator = _operator;
    }

    function sweepDust(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = botcoin.balanceOf(address(this));
        if (balance <= rewardBalance) revert ZeroAmount();
        uint256 dust = balance - rewardBalance;
        botcoin.safeTransfer(to, dust);
        emit DustSwept(to, dust);
    }

    // ── Emergency pause (separate from CortexRegistry) ────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
