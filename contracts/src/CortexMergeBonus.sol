// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

/// @title CortexMergeBonus
/// @notice Multiplier-uplift bonus for miners whose Cortex patches are merged
///         by the epoch reducer. Mirrors the existing BonusEpoch pattern
///         (BonusEpochManager). Funded per epoch by the coordinator AFTER the
///         CortexRegistry audit-and-multisig-override window closes.
/// @dev    Phase 2 deliverable. Skeleton only — events + entrypoints frozen,
///         body lands in Phase 2 implementation. No multiplier funded until
///         the CortexRegistry audit window closes for that epoch. Cap enforced
///         on-chain at (MERGE_MULTIPLIER - 1) * claimBaseForMerger.
contract CortexMergeBonus {
    event EpochFunded(uint64 indexed epoch, bytes32 minerBonusRoot, uint256 totalBonus);
    event MergeBonusClaimed(address indexed miner, uint64[] epochIds, uint256 amount);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    /// @notice Claim merge bonus for one or more epochs. Same UX as the existing
    ///         BonusEpoch.claimBonus.
    function claimMergeBonus(uint64[] calldata /*epochIds*/) external payable {
        revert("CortexMergeBonus: Phase 2 stub");
    }

    /// @notice Pool-mode wrapping calldata for pool contracts. Mirrors existing
    ///         bonus-epoch pool flow.
    function triggerMergeBonusClaim(uint64[] calldata /*epochIds*/) external {
        revert("CortexMergeBonus: Phase 2 stub");
    }
}
