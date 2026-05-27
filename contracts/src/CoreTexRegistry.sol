// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title CoreTexRegistry — canonical on-chain state-integrity registry for CoreTex.
/// @notice Pins per-epoch CoreTex substrate state roots, records miner state advances with their
///         compact patch bytes (data availability), and finalizes epoch headers. This is the
///         STATE-INTEGRITY surface only — credit accounting (epoch funding / claims) is intentionally
///         NOT implemented here; state-advance events DO carry the fields a future credit contract
///         needs (miner, epoch, improvementCredits, evalReportHash, parent/new roots).
///
/// Canonical invariants:
///   - An epoch MUST be started (startEpoch) before any advance. startEpoch pins the parent root and
///     seeds liveStateRoot = parentStateRoot. There is NO special case for the first advance.
///   - EVERY submitStateAdvance requires parentStateRoot == liveStateRoot[epoch]; the chain enforces a
///     single linear transition sequence per epoch.
///   - coreVersionHash (== bundleHash) and corpusRoot are pinned at startEpoch and re-asserted on every
///     advance, so the scoring context cannot drift mid-epoch.
contract CoreTexRegistry is Ownable, Pausable, ReentrancyGuard {
    // ── Constants ─────────────────────────────────────────────────────────
    uint256 public constant CHALLENGE_WINDOW_SECONDS = 21600; // 6h owner-revert audit window
    uint64  public constant MAX_TRANSITIONS_PER_EPOCH = 1024;

    // ── Access ────────────────────────────────────────────────────────────
    mapping(address => bool) public isCoordinator;

    // ── Canonical per-epoch state ─────────────────────────────────────────
    mapping(uint64 => bytes32) public epochParentStateRoot; // pinned at startEpoch
    mapping(uint64 => bytes32) public liveStateRoot;         // advances linearly; == parent at start
    mapping(uint64 => uint64)  public transitionCount;       // number of advances in the epoch
    mapping(uint64 => bool)    public epochStarted;
    mapping(uint64 => bool)    public epochFinalized;
    mapping(uint64 => uint256) public finalizedAt;           // timestamp for the audit window
    mapping(uint64 => bool)    public epochReverted;

    // scoring-context pins (set at startEpoch, re-asserted per advance)
    mapping(uint64 => bytes32) public epochCoreVersionHash;
    mapping(uint64 => bytes32) public epochCorpusRoot;

    // finalized header storage (for header verification / replay)
    struct EpochHeader {
        bytes32 parentStateRoot;
        bytes32 finalStateRoot;
        bytes32 coreVersionHash;
        bytes32 corpusRoot;
        bytes32 activeFrontierRoot;
        bytes32 patchSetRoot;
        bytes32 scoreRoot;
        bytes32 baselineManifestHash;
    }
    mapping(uint64 => EpochHeader) private _headers;

    // ── Canonical events ──────────────────────────────────────────────────
    event CoreTexEpochStarted(
        uint64 indexed epoch,
        bytes32 parentStateRoot,
        bytes32 coreVersionHash,
        bytes32 corpusRoot,
        bytes32 activeFrontierRoot,
        bytes32 baselineManifestHash,
        bytes32 hiddenSeedCommit
    );

    event CoreTexStateAdvanced(
        uint64  indexed epoch,
        uint64  indexed transitionIndex,
        address indexed miner,
        bytes32 parentStateRoot,
        bytes32 newStateRoot,
        bytes32 patchHash,
        bytes32 evalReportHash,
        bytes32 coreVersionHash,
        bytes32 corpusRoot,
        bytes32 activeFrontierRoot,
        uint256 improvementCredits,
        uint16  wordCount,
        bytes   compactPatchBytes
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

    event CoreTexEpochReverted(uint64 indexed epoch, address indexed by);
    event CoordinatorAdded(address indexed coordinator);
    event CoordinatorRemoved(address indexed coordinator);

    // ── Errors ────────────────────────────────────────────────────────────
    error NotCoordinator();
    error ZeroAddress();
    error EpochAlreadyStarted();
    error EpochNotStarted();
    error AlreadyFinalized();
    error NotFinalized();
    error EpochIsReverted();
    error ParentRootMismatch();      // parentStateRoot != liveStateRoot[epoch]
    error CoreVersionMismatch();     // coreVersionHash != epoch pin
    error CorpusRootMismatch();      // corpusRoot != epoch pin
    error TooManyTransitions();
    error ZeroPatchHash();
    error NoOpAdvance();             // newStateRoot == parentStateRoot
    error FinalRootMismatch();       // finalStateRoot != liveStateRoot[epoch]
    error AuditWindowClosed();

    constructor(address initialOwner, address initialCoordinator) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (initialCoordinator == address(0)) revert ZeroAddress();
        isCoordinator[initialCoordinator] = true;
        emit CoordinatorAdded(initialCoordinator);
    }

    modifier onlyCoordinator() {
        if (!isCoordinator[msg.sender] && msg.sender != owner()) revert NotCoordinator();
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

    // ── Epoch lifecycle ───────────────────────────────────────────────────

    /// @notice Start an epoch, pinning the parent state root + scoring context. Seeds
    ///         liveStateRoot = parentStateRoot so the first advance is NOT special-cased.
    function startEpoch(
        uint64  epoch,
        bytes32 parentStateRoot,
        bytes32 coreVersionHash,
        bytes32 corpusRoot,
        bytes32 activeFrontierRoot,
        bytes32 baselineManifestHash,
        bytes32 hiddenSeedCommit
    ) external onlyCoordinator whenNotPaused {
        if (epochStarted[epoch]) revert EpochAlreadyStarted();
        epochStarted[epoch] = true;
        epochParentStateRoot[epoch] = parentStateRoot;
        liveStateRoot[epoch] = parentStateRoot;
        epochCoreVersionHash[epoch] = coreVersionHash;
        epochCorpusRoot[epoch] = corpusRoot;
        emit CoreTexEpochStarted(
            epoch, parentStateRoot, coreVersionHash, corpusRoot,
            activeFrontierRoot, baselineManifestHash, hiddenSeedCommit
        );
    }

    /// @notice Record a verified state advance and move the live root forward. Single linear
    ///         transition sequence: parentStateRoot MUST equal the current liveStateRoot.
    function submitStateAdvance(
        uint64  epoch,
        address miner,
        bytes32 parentStateRoot,
        bytes32 newStateRoot,
        bytes32 patchHash,
        bytes32 evalReportHash,
        bytes32 coreVersionHash,
        bytes32 corpusRoot,
        bytes32 activeFrontierRoot,
        uint256 improvementCredits,
        uint16  wordCount,
        bytes calldata compactPatchBytes
    ) external onlyCoordinator whenNotPaused nonReentrant {
        if (!epochStarted[epoch]) revert EpochNotStarted();
        if (epochFinalized[epoch]) revert AlreadyFinalized();
        if (epochReverted[epoch]) revert EpochIsReverted();
        if (transitionCount[epoch] >= MAX_TRANSITIONS_PER_EPOCH) revert TooManyTransitions();
        if (parentStateRoot != liveStateRoot[epoch]) revert ParentRootMismatch();   // NO first-advance special case
        if (coreVersionHash != epochCoreVersionHash[epoch]) revert CoreVersionMismatch();
        if (corpusRoot != epochCorpusRoot[epoch]) revert CorpusRootMismatch();
        if (patchHash == bytes32(0)) revert ZeroPatchHash();
        if (newStateRoot == parentStateRoot) revert NoOpAdvance();

        uint64 idx = transitionCount[epoch];
        transitionCount[epoch] = idx + 1;
        liveStateRoot[epoch] = newStateRoot;

        emit CoreTexStateAdvanced(
            epoch, idx, miner, parentStateRoot, newStateRoot, patchHash, evalReportHash,
            coreVersionHash, corpusRoot, activeFrontierRoot, improvementCredits, wordCount, compactPatchBytes
        );
    }

    /// @notice Finalize the epoch header. finalStateRoot MUST equal the current liveStateRoot.
    function finalizeEpoch(
        uint64  epoch,
        bytes32 finalStateRoot,
        bytes32 coreVersionHash,
        bytes32 corpusRoot,
        bytes32 activeFrontierRoot,
        bytes32 patchSetRoot,
        bytes32 scoreRoot,
        bytes32 baselineManifestHash
    ) external onlyCoordinator whenNotPaused nonReentrant {
        if (!epochStarted[epoch]) revert EpochNotStarted();
        if (epochFinalized[epoch]) revert AlreadyFinalized();
        if (epochReverted[epoch]) revert EpochIsReverted();
        if (finalStateRoot != liveStateRoot[epoch]) revert FinalRootMismatch();
        if (coreVersionHash != epochCoreVersionHash[epoch]) revert CoreVersionMismatch();
        if (corpusRoot != epochCorpusRoot[epoch]) revert CorpusRootMismatch();

        epochFinalized[epoch] = true;
        finalizedAt[epoch] = block.timestamp;
        _headers[epoch] = EpochHeader({
            parentStateRoot: epochParentStateRoot[epoch],
            finalStateRoot: finalStateRoot,
            coreVersionHash: coreVersionHash,
            corpusRoot: corpusRoot,
            activeFrontierRoot: activeFrontierRoot,
            patchSetRoot: patchSetRoot,
            scoreRoot: scoreRoot,
            baselineManifestHash: baselineManifestHash
        });

        emit CoreTexEpochFinalized(
            epoch, epochParentStateRoot[epoch], finalStateRoot, coreVersionHash,
            corpusRoot, activeFrontierRoot, patchSetRoot, scoreRoot, baselineManifestHash
        );
    }

    /// @notice Owner-only revert of a finalized epoch within the audit window (replay-divergence remedy).
    function ownerRevertEpoch(uint64 epoch) external onlyOwner {
        if (!epochFinalized[epoch]) revert NotFinalized();
        if (block.timestamp > finalizedAt[epoch] + CHALLENGE_WINDOW_SECONDS) revert AuditWindowClosed();
        epochFinalized[epoch] = false;
        epochReverted[epoch] = true;
        delete _headers[epoch];
        emit CoreTexEpochReverted(epoch, msg.sender);
    }

    // ── Views ─────────────────────────────────────────────────────────────
    function getHeader(uint64 epoch) external view returns (EpochHeader memory) {
        return _headers[epoch];
    }

    function auditWindowOpen(uint64 epoch) external view returns (bool) {
        return epochFinalized[epoch] && block.timestamp <= finalizedAt[epoch] + CHALLENGE_WINDOW_SECONDS;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
