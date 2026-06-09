// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IBotcoinMiningV4CoreTexContext {
    function coreTexEpochContextSet(uint64 epoch) external view returns (bool);
    function coreTexParentStateRoot(uint64 epoch) external view returns (bytes32);
    function coreTexCoreVersionHash(uint64 epoch) external view returns (bytes32);
    function coreTexCorpusRoot(uint64 epoch) external view returns (bytes32);
    function coreTexActiveFrontierRoot(uint64 epoch) external view returns (bytes32);
    function coreTexBaselineManifestHash(uint64 epoch) external view returns (bytes32);
    function epochCommit(uint64 epoch) external view returns (bytes32);
}

/// @title CoreTexRegistry
/// @notice Canonical CoreTex state-transition ledger. Epoch timing and CoreTex
///         context live in BotcoinMiningV4; this registry only serializes
///         V4-mediated state advances and exposes V4 context through stable
///         registry views used by validators.
contract CoreTexRegistry is Ownable, Pausable, ReentrancyGuard {
    uint256 public constant CHALLENGE_WINDOW_SECONDS = 21600; // 6h owner-revert audit window

    address public botcoinMiningV4;

    mapping(address => bool) public isCoordinator;
    mapping(uint64 => bytes32) private _liveStateRoot;
    mapping(uint64 => bool) private _liveRootInitialized;
    mapping(uint64 => uint64) public transitionCount;
    mapping(uint64 => bool) public epochFinalized;
    mapping(uint64 => uint256) public finalizedAt;
    mapping(uint64 => bool) public epochReverted;

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

    event CoreTexEpochReverted(uint64 indexed epoch, address indexed by);
    event CoordinatorAdded(address indexed coordinator);
    event CoordinatorRemoved(address indexed coordinator);
    event BotcoinMiningV4Updated(address indexed oldMiningContract, address indexed newMiningContract);

    error NotCoordinator();
    error NotBotcoinMiningV4();
    error ZeroAddress();
    error EpochContextNotSet();
    error AlreadyFinalized();
    error NotFinalized();
    error EpochIsReverted();
    error ParentRootMismatch();
    error CoreVersionMismatch();
    error CorpusRootMismatch();
    error ActiveFrontierMismatch();
    error BaselineManifestMismatch();
    error ZeroPatchHash();
    error NoOpAdvance();
    error FinalRootMismatch();
    error AuditWindowClosed();
    error MiningContractAlreadySet();

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

    modifier onlyBotcoinMiningV4() {
        if (msg.sender != botcoinMiningV4) revert NotBotcoinMiningV4();
        _;
    }

    function addCoordinator(address coordinator) external onlyOwner {
        if (coordinator == address(0)) revert ZeroAddress();
        isCoordinator[coordinator] = true;
        emit CoordinatorAdded(coordinator);
    }

    function removeCoordinator(address coordinator) external onlyOwner {
        isCoordinator[coordinator] = false;
        emit CoordinatorRemoved(coordinator);
    }

    function setBotcoinMiningV4(address miningContract) external onlyOwner {
        if (miningContract == address(0)) revert ZeroAddress();
        if (botcoinMiningV4 != address(0)) revert MiningContractAlreadySet();
        botcoinMiningV4 = miningContract;
        emit BotcoinMiningV4Updated(address(0), miningContract);
    }

    function liveStateRoot(uint64 epoch) public view returns (bytes32) {
        if (_liveRootInitialized[epoch]) return _liveStateRoot[epoch];
        return _context(epoch).coreTexParentStateRoot(epoch);
    }

    function epochParentStateRoot(uint64 epoch) external view returns (bytes32) {
        return _context(epoch).coreTexParentStateRoot(epoch);
    }

    function epochCoreVersionHash(uint64 epoch) external view returns (bytes32) {
        return _context(epoch).coreTexCoreVersionHash(epoch);
    }

    function epochCorpusRoot(uint64 epoch) external view returns (bytes32) {
        return _context(epoch).coreTexCorpusRoot(epoch);
    }

    function epochActiveFrontierRoot(uint64 epoch) external view returns (bytes32) {
        return _context(epoch).coreTexActiveFrontierRoot(epoch);
    }

    function epochBaselineManifestHash(uint64 epoch) external view returns (bytes32) {
        return _context(epoch).coreTexBaselineManifestHash(epoch);
    }

    function epochHiddenSeedCommit(uint64 epoch) external view returns (bytes32) {
        return _context(epoch).epochCommit(epoch);
    }

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
    ) external onlyBotcoinMiningV4 whenNotPaused nonReentrant {
        if (epochFinalized[epoch]) revert AlreadyFinalized();
        if (epochReverted[epoch]) revert EpochIsReverted();

        IBotcoinMiningV4CoreTexContext v4 = _context(epoch);
        bytes32 liveRoot = _liveRootInitialized[epoch] ? _liveStateRoot[epoch] : v4.coreTexParentStateRoot(epoch);
        if (parentStateRoot != liveRoot) revert ParentRootMismatch();
        if (coreVersionHash != v4.coreTexCoreVersionHash(epoch)) revert CoreVersionMismatch();
        if (corpusRoot != v4.coreTexCorpusRoot(epoch)) revert CorpusRootMismatch();
        if (activeFrontierRoot != v4.coreTexActiveFrontierRoot(epoch)) revert ActiveFrontierMismatch();
        if (patchHash == bytes32(0)) revert ZeroPatchHash();
        if (newStateRoot == parentStateRoot) revert NoOpAdvance();

        uint64 idx = transitionCount[epoch];
        transitionCount[epoch] = idx + 1;
        _liveRootInitialized[epoch] = true;
        _liveStateRoot[epoch] = newStateRoot;

        emit CoreTexStateAdvanced(
            epoch,
            idx,
            miner,
            parentStateRoot,
            newStateRoot,
            patchHash,
            evalReportHash,
            coreVersionHash,
            corpusRoot,
            activeFrontierRoot,
            improvementCredits,
            wordCount,
            compactPatchBytes
        );
    }

    function finalizeEpoch(
        uint64 epoch,
        bytes32 finalStateRoot,
        bytes32 coreVersionHash,
        bytes32 corpusRoot,
        bytes32 activeFrontierRoot,
        bytes32 patchSetRoot,
        bytes32 scoreRoot,
        bytes32 baselineManifestHash
    ) external onlyCoordinator whenNotPaused nonReentrant {
        if (epochFinalized[epoch]) revert AlreadyFinalized();
        if (epochReverted[epoch]) revert EpochIsReverted();
        IBotcoinMiningV4CoreTexContext v4 = _context(epoch);
        if (finalStateRoot != liveStateRoot(epoch)) revert FinalRootMismatch();
        if (coreVersionHash != v4.coreTexCoreVersionHash(epoch)) revert CoreVersionMismatch();
        if (corpusRoot != v4.coreTexCorpusRoot(epoch)) revert CorpusRootMismatch();
        if (activeFrontierRoot != v4.coreTexActiveFrontierRoot(epoch)) revert ActiveFrontierMismatch();
        if (baselineManifestHash != v4.coreTexBaselineManifestHash(epoch)) revert BaselineManifestMismatch();

        epochFinalized[epoch] = true;
        finalizedAt[epoch] = block.timestamp;
        _headers[epoch] = EpochHeader({
            parentStateRoot: v4.coreTexParentStateRoot(epoch),
            finalStateRoot: finalStateRoot,
            coreVersionHash: coreVersionHash,
            corpusRoot: corpusRoot,
            activeFrontierRoot: activeFrontierRoot,
            patchSetRoot: patchSetRoot,
            scoreRoot: scoreRoot,
            baselineManifestHash: baselineManifestHash
        });

        emit CoreTexEpochFinalized(
            epoch,
            v4.coreTexParentStateRoot(epoch),
            finalStateRoot,
            coreVersionHash,
            corpusRoot,
            activeFrontierRoot,
            patchSetRoot,
            scoreRoot,
            baselineManifestHash
        );
    }

    function ownerRevertEpoch(uint64 epoch) external onlyOwner {
        if (!epochFinalized[epoch]) revert NotFinalized();
        if (block.timestamp > finalizedAt[epoch] + CHALLENGE_WINDOW_SECONDS) revert AuditWindowClosed();
        epochFinalized[epoch] = false;
        epochReverted[epoch] = true;
        delete _headers[epoch];
        emit CoreTexEpochReverted(epoch, msg.sender);
    }

    function getHeader(uint64 epoch) external view returns (EpochHeader memory) {
        return _headers[epoch];
    }

    function auditWindowOpen(uint64 epoch) external view returns (bool) {
        return epochFinalized[epoch] && block.timestamp <= finalizedAt[epoch] + CHALLENGE_WINDOW_SECONDS;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _context(uint64 epoch) internal view returns (IBotcoinMiningV4CoreTexContext v4) {
        address mining = botcoinMiningV4;
        if (mining == address(0)) revert ZeroAddress();
        v4 = IBotcoinMiningV4CoreTexContext(mining);
        if (!v4.coreTexEpochContextSet(epoch)) revert EpochContextNotSet();
    }
}
