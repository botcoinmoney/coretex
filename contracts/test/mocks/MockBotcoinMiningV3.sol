// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.26;

/// @notice Minimal stub of BotcoinMiningV3 for SWCP non-interference tests.
///         Only models nextIndex and lastReceiptHash — no staking, no EIP-712.
///         Deployed at a fresh address in tests; does not touch CortexRegistry
///         or CortexMergeBonus storage.
contract MockBotcoinMiningV3 {
    mapping(address => uint64)  public nextIndex;
    mapping(address => bytes32) public lastReceiptHash;

    uint256 public totalCreditsProcessed;

    /// @notice Simulate a successful submitReceipt call.
    function incrementNextIndex(address miner) external {
        nextIndex[miner]++;
        lastReceiptHash[miner] = keccak256(abi.encodePacked(miner, nextIndex[miner]));
        totalCreditsProcessed++;
    }

    /// @notice Simulate a claim — does nothing beyond emitting an event, which
    ///         is sufficient to prove the SWCP flow is not blocked.
    function claim(uint64[] calldata /*epochIds*/) external pure {
        // no-op for isolation test
    }
}
