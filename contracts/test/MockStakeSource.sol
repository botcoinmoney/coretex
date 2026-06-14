// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockStakeSource {
    using SafeERC20 for IERC20;

    struct Tier {
        uint256 stakeThreshold;
        uint256 credits;
    }

    IERC20 public immutable botcoinToken;
    uint256 public immutable genesisTimestamp;
    uint256 public immutable epochDuration;
    uint256 public immutable unstakeCooldown;

    Tier[] private _tiers;

    mapping(address => uint256) public stakedAmount;
    mapping(address => uint256) public withdrawableAt;

    error InsufficientBalance();
    error InvalidTierConfig();
    error NoUnstakePending();
    error TooManyTiers();
    error TierIndexOutOfBounds();
    error ZeroAddress();
    error ZeroAmount();

    constructor(
        address _botcoinToken,
        uint256[] memory thresholds,
        uint256[] memory creditsPerTier,
        uint256 _genesisTimestamp,
        uint256 _epochDuration,
        uint256 _unstakeCooldown
    ) {
        if (_botcoinToken == address(0)) revert ZeroAddress();
        if (thresholds.length == 0 || thresholds.length != creditsPerTier.length) revert InvalidTierConfig();
        if (thresholds.length > 10) revert TooManyTiers();
        botcoinToken = IERC20(_botcoinToken);
        genesisTimestamp = _genesisTimestamp;
        epochDuration = _epochDuration;
        unstakeCooldown = _unstakeCooldown;

        uint256 previous;
        for (uint256 i; i < thresholds.length; ++i) {
            if (thresholds[i] == 0 || creditsPerTier[i] == 0) revert InvalidTierConfig();
            if (i != 0 && thresholds[i] <= previous) revert InvalidTierConfig();
            _tiers.push(Tier({stakeThreshold: thresholds[i], credits: creditsPerTier[i]}));
            previous = thresholds[i];
        }
    }

    function currentEpoch() public view returns (uint64) {
        return uint64((block.timestamp - genesisTimestamp) / epochDuration);
    }

    function isEligible(address miner) external view returns (bool) {
        return stakedAmount[miner] >= _tiers[0].stakeThreshold && withdrawableAt[miner] == 0;
    }

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function getTier(uint256 index) external view returns (uint256 stakeThreshold, uint256 tierCredits) {
        if (index >= _tiers.length) revert TierIndexOutOfBounds();
        Tier storage t = _tiers[index];
        return (t.stakeThreshold, t.credits);
    }

    function minStakeRequired() external view returns (uint256) {
        return _tiers[0].stakeThreshold;
    }

    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        address miner = msg.sender;
        botcoinToken.safeTransferFrom(miner, address(this), amount);
        stakedAmount[miner] += amount;
        withdrawableAt[miner] = 0;
        if (stakedAmount[miner] < _tiers[0].stakeThreshold) revert InsufficientBalance();
    }

    function unstake() external {
        address miner = msg.sender;
        if (stakedAmount[miner] == 0) revert NoUnstakePending();
        withdrawableAt[miner] = block.timestamp + unstakeCooldown;
    }
}
