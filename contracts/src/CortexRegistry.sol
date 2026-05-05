// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

/// @title CortexRegistry
/// @notice On-chain anchor for Botcoin Cortex state. Stores headers, emits
///         accepted-patch records with full compactPatchBytes payloads, emits
///         periodic full-state snapshots, finalizes epochs with an audit-and-
///         multisig-override window before merge-bonus funding can occur.
/// @dev    Phase 2 deliverable. Skeleton only — events + struct frozen, body
///         lands in Phase 2 implementation. Zero reward logic in this contract.
///         Credit issuance flows through the existing BotcoinMiningV3.submitReceipt
///         path with the §6 receipt field mapping.
contract CortexRegistry {
    struct CortexHeader {
        uint64  epoch;
        bytes32 stateRoot;
        bytes32 coreVersionHash;
        bytes32 benchmarkCommitment;
        bytes32 experienceCorpusRoot;
        bytes32 patchSetRoot;
        bytes32 scoreRoot;
    }

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
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // Phase 2 implementation lands the bodies. This skeleton is here to lock
    // the on-chain interface (events + struct) so packages downstream can be
    // built against it.
}
