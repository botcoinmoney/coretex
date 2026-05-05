// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CortexRegistry
/// @notice On-chain anchor for Botcoin Cortex state. Stores headers, emits
///         accepted-patch records with full compactPatchBytes payloads, emits
///         periodic full-state snapshots, finalizes epochs with an audit-and-
///         multisig-override window before merge-bonus funding can occur.
/// @dev    Zero reward logic. Credit issuance flows through the existing
///         BotcoinMiningV3.submitReceipt path with the §6 receipt field mapping.
///         The audit window is NOT an on-chain fraud proof — it is a public delay
///         during which any party runs `botcoin-cortex verify-epoch` and, if
///         divergence is found, the operator multisig calls revertEpoch(). V1
///         replaces this with bond-based or ZK fraud proofs.
contract CortexRegistry is Ownable, Pausable, ReentrancyGuard {

    // ── Frozen struct — names/types MUST NOT change ───────────────────────

    struct CortexHeader {
        uint64  epoch;
        bytes32 stateRoot;
        bytes32 coreVersionHash;
        bytes32 benchmarkCommitment;
        bytes32 experienceCorpusRoot;
        bytes32 patchSetRoot;
        bytes32 scoreRoot;
    }

    // ── Constants ─────────────────────────────────────────────────────────

    uint256 public constant CHALLENGE_WINDOW_SECONDS  = 21600; // 6 hours
    uint64  public constant SNAPSHOT_EPOCH_INTERVAL   = 100;
    uint256 public constant MAX_PATCHES_PER_EPOCH     = 1024;
    uint256 public constant MULTISIG_THRESHOLD        = 2;

    // ── Multisig ──────────────────────────────────────────────────────────

    /// @notice Set of authorized multisig operator addresses.
    mapping(address => bool) public isOperator;

    /// @notice Per-epoch revert votes keyed by operator address.
    mapping(uint64 => mapping(address => bool)) public revertVote;

    /// @notice Number of revert votes cast for each epoch.
    mapping(uint64 => uint256) public revertVoteCount;

    // ── Coordinator / submitter ───────────────────────────────────────────

    /// @notice Accounts authorized to call submitHeader / submitPatchAccepted /
    ///         finalizeEpoch / commitShard / revealShard.
    mapping(address => bool) public isCoordinator;

    // ── State storage ─────────────────────────────────────────────────────

    /// @notice Finalized headers keyed by epoch.
    mapping(uint64 => CortexHeader) private _headers;

    /// @notice True when the header has been finalized (epoch reducer output accepted).
    mapping(uint64 => bool) public epochFinalized;

    /// @notice Timestamp of finalization — used to enforce the audit window.
    mapping(uint64 => uint256) public finalizedAt;

    /// @notice True when an epoch has been reverted (within audit window).
    mapping(uint64 => bool) public epochReverted;

    // ── Patch count tracking ──────────────────────────────────────────────

    /// @notice Number of accepted patches emitted per epoch.
    mapping(uint64 => uint256) public patchCount;

    // ── Shard commit/reveal ───────────────────────────────────────────────

    mapping(uint64 => bytes32) public shardCommit;
    mapping(uint64 => bytes32) public shardSeed;

    // ── Frozen events — names/types MUST NOT change ───────────────────────

    event CortexShardCommitted(uint64 indexed epoch, bytes32 hiddenSeedCommit);
    event CortexShardRevealed (uint64 indexed epoch, bytes32 hiddenSeed);

    event CortexPatchAccepted(
        uint64  indexed epoch,
        address indexed miner,
        bytes32         parentStateRoot,
        bytes32         patchHash,
        bytes32         evalReportHash,
        bytes           compactPatchBytes // full payload, not just the hash
    );

    event CortexEpochFinalized(
        uint64  indexed epoch,
        bytes32         parentStateRoot,
        bytes32         patchSetRoot,
        bytes32         newStateRoot,
        bytes32         coreVersionHash,
        bytes32         experienceCorpusRoot
    );

    event CortexStateSnapshot(
        uint64  indexed epoch,
        bytes32         stateRoot,
        bytes           fullStateBytes // raw 1024 words, every SNAPSHOT_EPOCH_INTERVAL
    );

    event EpochReverted(uint64 indexed epoch, address indexed by);
    event OperatorAdded(address indexed operator);
    event OperatorRemoved(address indexed operator);
    event CoordinatorAdded(address indexed coordinator);
    event CoordinatorRemoved(address indexed coordinator);

    // ── Errors ────────────────────────────────────────────────────────────

    error NotCoordinator();
    error NotOperator();
    error AlreadyFinalized();
    error NotFinalized();
    error EpochReverted_();
    error AuditWindowOpen();
    error AuditWindowClosed();
    error TooManyPatches();
    error ZeroAddress();
    error InvalidStateBytes();
    error ShardAlreadyCommitted();
    error ShardAlreadyRevealed();
    error ShardCommitMissing();
    error ShardCommitMismatch();
    error AlreadyVoted();
    error ThresholdNotMet();
    error EpochAlreadyReverted();

    // ── Constructor ───────────────────────────────────────────────────────

    constructor(address initialOwner, address initialCoordinator) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (initialCoordinator == address(0)) revert ZeroAddress();
        isCoordinator[initialCoordinator] = true;
        emit CoordinatorAdded(initialCoordinator);
    }

    // ── Modifiers ─────────────────────────────────────────────────────────

    modifier onlyCoordinator() {
        if (!isCoordinator[msg.sender] && msg.sender != owner()) revert NotCoordinator();
        _;
    }

    modifier onlyOperatorOrOwner() {
        if (!isOperator[msg.sender] && msg.sender != owner()) revert NotOperator();
        _;
    }

    // ── Coordinator management ────────────────────────────────────────────

    function addCoordinator(address coordinator) external onlyOwner {
        if (coordinator == address(0)) revert ZeroAddress();
        isCoordinator[coordinator] = true;
        emit CoordinatorAdded(coordinator);
    }

    function removeCoordinator(address coordinator) external onlyOwner {
        isCoordinator[coordinator] = false;
        emit CoordinatorRemoved(coordinator);
    }

    // ── Operator management (multisig set) ───────────────────────────────

    function addOperator(address op) external onlyOwner {
        if (op == address(0)) revert ZeroAddress();
        isOperator[op] = true;
        emit OperatorAdded(op);
    }

    function removeOperator(address op) external onlyOwner {
        isOperator[op] = false;
        emit OperatorRemoved(op);
    }

    // ── Shard commit / reveal ─────────────────────────────────────────────

    /// @notice Commit the hidden seed for an epoch (call at epoch start).
    function commitShard(uint64 epoch, bytes32 hiddenSeedCommit) external onlyCoordinator whenNotPaused {
        if (shardCommit[epoch] != bytes32(0)) revert ShardAlreadyCommitted();
        shardCommit[epoch] = hiddenSeedCommit;
        emit CortexShardCommitted(epoch, hiddenSeedCommit);
    }

    /// @notice Reveal the hidden seed at epoch end.
    function revealShard(uint64 epoch, bytes32 hiddenSeed) external onlyCoordinator whenNotPaused {
        if (shardCommit[epoch] == bytes32(0)) revert ShardCommitMissing();
        if (shardSeed[epoch] != bytes32(0)) revert ShardAlreadyRevealed();
        if (keccak256(abi.encodePacked(hiddenSeed)) != shardCommit[epoch]) revert ShardCommitMismatch();
        shardSeed[epoch] = hiddenSeed;
        emit CortexShardRevealed(epoch, hiddenSeed);
    }

    // ── Patch submission ──────────────────────────────────────────────────

    /// @notice Record an accepted patch in calldata. Full compactPatchBytes
    ///         must be supplied — hash-only is insufficient for data availability.
    function submitPatchAccepted(
        uint64  epoch,
        address miner,
        bytes32 parentStateRoot,
        bytes32 patchHash,
        bytes32 evalReportHash,
        bytes calldata compactPatchBytes
    ) external onlyCoordinator whenNotPaused nonReentrant {
        if (epochFinalized[epoch]) revert AlreadyFinalized();
        if (patchCount[epoch] >= MAX_PATCHES_PER_EPOCH) revert TooManyPatches();

        patchCount[epoch]++;

        emit CortexPatchAccepted(
            epoch,
            miner,
            parentStateRoot,
            patchHash,
            evalReportHash,
            compactPatchBytes
        );
    }

    // ── Epoch finalization ────────────────────────────────────────────────

    /// @notice Finalize epoch. Header is provisional for CHALLENGE_WINDOW_SECONDS.
    ///         After the window, finalization is canonical and CortexMergeBonus
    ///         may be funded.
    function finalizeEpoch(
        uint64  epoch,
        bytes32 parentStateRoot,
        bytes32 patchSetRoot,
        bytes32 newStateRoot,
        bytes32 coreVersionHash,
        bytes32 benchmarkCommitment,
        bytes32 experienceCorpusRoot,
        bytes32 scoreRoot
    ) external onlyCoordinator whenNotPaused nonReentrant {
        if (epochFinalized[epoch]) revert AlreadyFinalized();
        if (epochReverted[epoch])  revert EpochReverted_();

        _headers[epoch] = CortexHeader({
            epoch:               epoch,
            stateRoot:           newStateRoot,
            coreVersionHash:     coreVersionHash,
            benchmarkCommitment: benchmarkCommitment,
            experienceCorpusRoot: experienceCorpusRoot,
            patchSetRoot:        patchSetRoot,
            scoreRoot:           scoreRoot
        });

        epochFinalized[epoch] = true;
        finalizedAt[epoch]    = block.timestamp;

        emit CortexEpochFinalized(
            epoch,
            parentStateRoot,
            patchSetRoot,
            newStateRoot,
            coreVersionHash,
            experienceCorpusRoot
        );

        // Emit periodic full-state snapshot every SNAPSHOT_EPOCH_INTERVAL epochs.
        // The snapshot bytes are provided by the coordinator off-chain since the
        // contract does not store the full 32 KB state. At interval boundaries
        // we emit an empty snapshot as a chain-anchor marker; the coordinator
        // is expected to call emitSnapshot() separately with the full bytes.
        // (See emitSnapshot below.)
    }

    /// @notice Emit a full-state snapshot for reconstruction purposes.
    ///         Must be called at SNAPSHOT_EPOCH_INTERVAL boundaries.
    ///         fullStateBytes MUST be exactly 1024 * 32 = 32768 bytes.
    function emitSnapshot(
        uint64 epoch,
        bytes calldata fullStateBytes
    ) external onlyCoordinator whenNotPaused {
        if (!epochFinalized[epoch]) revert NotFinalized();
        if (epoch % SNAPSHOT_EPOCH_INTERVAL != 0) revert InvalidStateBytes();
        if (fullStateBytes.length != 32768) revert InvalidStateBytes();

        emit CortexStateSnapshot(epoch, _headers[epoch].stateRoot, fullStateBytes);
    }

    // ── Audit-window revert (multisig, 2-of-N) ───────────────────────────

    /// @notice [V0] Owner-only revert within the audit window.
    ///         Per the V0 launch decision the multisig lever is deferred — the
    ///         owner alone may revert a divergent epoch within
    ///         CHALLENGE_WINDOW_SECONDS. The 2-of-N multisig path
    ///         (`voteRevertEpoch`) below is retained as dead V1 wiring; once
    ///         operator multisig is published it becomes the canonical lever
    ///         and `ownerRevertEpoch` is removed.
    function ownerRevertEpoch(uint64 epoch) external onlyOwner {
        if (!epochFinalized[epoch]) revert NotFinalized();
        if (epochReverted[epoch])   revert EpochAlreadyReverted();
        if (block.timestamp > finalizedAt[epoch] + CHALLENGE_WINDOW_SECONDS) {
            revert AuditWindowClosed();
        }
        _executeRevert(epoch);
    }

    /// @notice [V1] Multisig revert vote. Requires MULTISIG_THRESHOLD votes to
    ///         unwind the epoch. Must be called within CHALLENGE_WINDOW_SECONDS.
    ///         Wiring retained for V1 reactivation; not relied on at V0 launch.
    function voteRevertEpoch(uint64 epoch) external onlyOperatorOrOwner {
        if (!epochFinalized[epoch]) revert NotFinalized();
        if (epochReverted[epoch])   revert EpochAlreadyReverted();
        if (block.timestamp > finalizedAt[epoch] + CHALLENGE_WINDOW_SECONDS) {
            revert AuditWindowClosed();
        }
        if (revertVote[epoch][msg.sender]) revert AlreadyVoted();

        revertVote[epoch][msg.sender] = true;
        revertVoteCount[epoch]++;

        if (revertVoteCount[epoch] >= MULTISIG_THRESHOLD) {
            _executeRevert(epoch);
        }
    }

    function _executeRevert(uint64 epoch) internal {
        epochReverted[epoch]  = true;
        epochFinalized[epoch] = false;

        // Clear the stored header so stale data cannot be queried.
        delete _headers[epoch];

        emit EpochReverted(epoch, msg.sender);
    }

    // ── View helpers ──────────────────────────────────────────────────────

    /// @notice Returns the stored header for a finalized epoch.
    function getHeader(uint64 epoch) external view returns (CortexHeader memory) {
        if (!epochFinalized[epoch]) revert NotFinalized();
        return _headers[epoch];
    }

    /// @notice Returns true if the audit window for `epoch` is still open.
    function auditWindowOpen(uint64 epoch) external view returns (bool) {
        if (!epochFinalized[epoch]) return false;
        return block.timestamp <= finalizedAt[epoch] + CHALLENGE_WINDOW_SECONDS;
    }

    // ── Emergency pause (Cortex lane only) ───────────────────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
