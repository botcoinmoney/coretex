// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title IMiningCredits
/// @notice Read-only interface into the active Botcoin mining contract. The bonus
///         contract never writes to the mining contract.
interface IMiningCredits {
    function credits(uint64 epochId, address miner) external view returns (uint256);
    function totalCredits(uint64 epochId) external view returns (uint256);
    function epochSecret(uint64 epochId) external view returns (bytes32);
    function currentEpoch() external view returns (uint64);
}

/// @title BonusEpoch
/// @notice Standalone bonus-epoch module for Botcoin mining. Reads credit
///         state from the active mining contract and distributes
///         bonus BOTCOIN rewards on randomly-selected epochs.
///
///         Randomness uses a two-party non-gameable system:
///         1. Epoch secret — committed by coordinator at epoch start, revealed
///            after epoch ends. Unknown to anyone except coordinator until reveal.
///         2. Predetermined block hash — a Base block number chosen at epoch
///            start (~75% through the epoch). Its hash is unknowable until produced.
///
///         An epoch is a bonus epoch when:
///           keccak256(abi.encodePacked(epochSecret, blockHash)) % 10 == 0
///
///         This contract is read-only against mining state and keeps mining
///         custody logic completely separate.
contract BonusEpoch is Ownable {
    using SafeERC20 for IERC20;

    // ── Constants ────────────────────────────────────────────────────────

    uint256 public constant BONUS_DENOMINATOR = 10;
    uint256 public constant MAX_CLAIM_EPOCHS = 64;

    // ── Immutables ──────────────────────────────────────────────────────

    IERC20 public immutable botcoin;

    // ── Config ──────────────────────────────────────────────────────────

    /// @notice The mining contract to read credits/secrets from.
    ///         Settable by owner because V2 address is not known at deploy time.
    IMiningCredits public mining;

    /// @notice Operator address (coordinator signer) that can set bonus blocks
    ///         and capture/submit block hashes.
    address public operator;

    // ── Per-epoch bonus block target and captured hash ───────────────────

    mapping(uint64 => uint256) public epochBonusBlock;
    mapping(uint64 => bytes32) public epochBonusHash;

    // ── Bonus reward pool ───────────────────────────────────────────────

    /// @notice Accumulated BOTCOIN reward for a bonus epoch.
    ///         Multiple fundBonusEpoch calls accumulate into this.
    mapping(uint64 => uint256) public bonusReward;

    /// @notice Tracks total reward obligations held by the contract.
    uint256 public rewardBalance;

    // ── Claims gate ─────────────────────────────────────────────────────

    /// @notice Operator opens claims after all TWAP tranches are funded.
    mapping(uint64 => bool) public bonusClaimsOpen;

    // ── Claim tracking ──────────────────────────────────────────────────

    mapping(uint64 => mapping(address => bool)) public bonusClaimed;

    // ── Reserve accounting (pre-TWAP bonus pool visibility) ─────────────

    /// @notice Tracked balance per reserve token (wETH, USDC, etc).
    ///         Purely for on-chain accounting / API readability.
    mapping(address => uint256) public reserve;

    // ── Events ──────────────────────────────────────────────────────────

    event BonusBlockSet(uint64 indexed epochId, uint256 blockNum);
    event BonusHashCaptured(uint64 indexed epochId, bytes32 blockHash);
    event BonusHashSubmitted(uint64 indexed epochId, bytes32 blockHash);
    event BonusEpochFunded(uint64 indexed epochId, uint256 amount, uint256 totalFunded);
    event BonusClaimsOpened(uint64 indexed epochId, uint256 totalReward);
    event BonusClaimed(uint64 indexed epochId, address indexed miner, uint256 amount);
    event MiningContractUpdated(address indexed oldMining, address indexed newMining);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event DustSwept(address indexed to, uint256 amount);
    event ReserveDeposited(address indexed token, uint256 amount);
    event ReserveWithdrawn(address indexed token, uint256 amount, address indexed to);

    // ── Errors ──────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotAuthorized();
    error BonusBlockAlreadySet();
    error BonusBlockMustBeFuture();
    error BonusHashAlreadyCaptured();
    error NoBonusBlockSet();
    error TargetBlockNotProduced();
    error BlockHashWindowMissed();
    error BlockHashWindowNotMissed();
    error NotBonusEpoch();
    error ClaimsAlreadyOpen();
    error ClaimsNotOpen();
    error NothingFunded();
    error AlreadyClaimed();
    error NoCredits();
    error TooManyEpochs();
    error InsufficientReserve();

    // ── Constructor ─────────────────────────────────────────────────────

    /// @param _botcoin    The BOTCOIN token address.
    /// @param _mining     The initial mining contract to read from (can be
    ///                    address(0) if V2 is not deployed yet — set later).
    /// @param _operator   Coordinator address for setting bonus blocks and
    ///                    capturing/submitting hashes.
    constructor(address _botcoin, address _mining, address _operator) Ownable(msg.sender) {
        if (_botcoin == address(0)) revert ZeroAddress();
        if (_operator == address(0)) revert ZeroAddress();
        botcoin = IERC20(_botcoin);
        if (_mining != address(0)) {
            mining = IMiningCredits(_mining);
        }
        operator = _operator;
    }

    // ── Modifiers ───────────────────────────────────────────────────────

    modifier onlyOperatorOrOwner() {
        if (msg.sender != operator && msg.sender != owner()) revert NotAuthorized();
        _;
    }

    // ── Views ───────────────────────────────────────────────────────────

    /// @notice Returns true if the epoch is a bonus epoch. Both the epoch
    ///         secret (from mining contract) and the captured block hash
    ///         must be available for the result to be deterministic.
    /// @param epochId The epoch to check.
    function isBonusEpoch(uint64 epochId) public view returns (bool) {
        bytes32 secret = mining.epochSecret(epochId);
        bytes32 bh = epochBonusHash[epochId];
        if (secret == bytes32(0) || bh == bytes32(0)) return false;

        return uint256(keccak256(abi.encodePacked(secret, bh))) % BONUS_DENOMINATOR == 0;
    }

    // ── 1. Set Target Block (operator, at epoch start) ──────────────────

    /// @notice Set the target block whose hash will be used for bonus
    ///         randomness. Called by the coordinator at epoch start alongside
    ///         setEpochCommit. The block should be ~18 hours in the future.
    /// @param epochId  The epoch this bonus block belongs to.
    /// @param blockNum The future Base block number to target.
    function setEpochBonusBlock(uint64 epochId, uint256 blockNum) external onlyOperatorOrOwner {
        if (epochBonusBlock[epochId] != 0) revert BonusBlockAlreadySet();
        if (blockNum <= block.number) revert BonusBlockMustBeFuture();

        epochBonusBlock[epochId] = blockNum;

        emit BonusBlockSet(epochId, blockNum);
    }

    // ── 2. Capture Block Hash (permissionless, after target block) ──────

    /// @notice Capture the block hash for the predetermined target block.
    ///         Permissionless — anyone can call this, and the caller cannot
    ///         influence the result. Must be called within ~256 blocks
    ///         (~8.5 minutes on Base) of the target block being produced.
    /// @param epochId The epoch to capture the bonus hash for.
    function captureBonusHash(uint64 epochId) external {
        if (epochBonusHash[epochId] != bytes32(0)) revert BonusHashAlreadyCaptured();
        uint256 target = epochBonusBlock[epochId];
        if (target == 0) revert NoBonusBlockSet();
        if (block.number <= target) revert TargetBlockNotProduced();

        bytes32 bh = blockhash(target);
        if (bh == bytes32(0)) revert BlockHashWindowMissed();

        epochBonusHash[epochId] = bh;

        emit BonusHashCaptured(epochId, bh);
    }

    // ── 3. Fallback Hash Submission (operator, if 256-block window missed)

    /// @notice Emergency fallback to submit the block hash if the 256-block
    ///         capture window was missed. The hash is publicly verifiable
    ///         against any archive node or block explorer.
    /// @param epochId   The epoch to submit the hash for.
    /// @param blockHash The hash of the target block (verifiable off-chain).
    function submitBonusHash(uint64 epochId, bytes32 blockHash) external onlyOperatorOrOwner {
        if (epochBonusHash[epochId] != bytes32(0)) revert BonusHashAlreadyCaptured();
        if (blockHash == bytes32(0)) revert ZeroAmount();
        uint256 target = epochBonusBlock[epochId];
        if (target == 0) revert NoBonusBlockSet();
        // Only allow fallback after the 256-block window has passed
        if (block.number <= target + 256) revert BlockHashWindowNotMissed();

        epochBonusHash[epochId] = blockHash;

        emit BonusHashSubmitted(epochId, blockHash);
    }

    // ── 4. Fund Bonus Epoch (owner, multi-call for TWAP tranches) ───────

    /// @notice Deposit BOTCOIN into the bonus pool for a confirmed bonus
    ///         epoch. Can be called multiple times (TWAP tranches accumulate).
    ///         Reverts if the epoch is not a bonus epoch or claims are open.
    /// @param epochId The bonus epoch to fund.
    /// @param amount  Amount of BOTCOIN to deposit.
    function fundBonusEpoch(uint64 epochId, uint256 amount) external onlyOwner {
        if (!isBonusEpoch(epochId)) revert NotBonusEpoch();
        if (bonusClaimsOpen[epochId]) revert ClaimsAlreadyOpen();
        if (amount == 0) revert ZeroAmount();

        bonusReward[epochId] += amount;
        rewardBalance += amount;
        botcoin.safeTransferFrom(msg.sender, address(this), amount);

        emit BonusEpochFunded(epochId, amount, bonusReward[epochId]);
    }

    // ── 5. Open Claims (owner, after all TWAP tranches funded) ──────────

    /// @notice Lock the bonus pool and open claims for miners. No further
    ///         funding is possible after this call.
    /// @param epochId The bonus epoch to open claims for.
    function openBonusClaims(uint64 epochId) external onlyOwner {
        if (!isBonusEpoch(epochId)) revert NotBonusEpoch();
        if (bonusReward[epochId] == 0) revert NothingFunded();
        if (bonusClaimsOpen[epochId]) revert ClaimsAlreadyOpen();

        bonusClaimsOpen[epochId] = true;

        emit BonusClaimsOpened(epochId, bonusReward[epochId]);
    }

    // ── 6. Claim Bonus (permissionless, pro-rata by mining credits) ─────

    /// @notice Claim bonus reward for one or more bonus epochs. Payout is
    ///         proportional to the miner's credits in each epoch (read from
    ///         the mining contract), exactly like regular epoch rewards.
    /// @param epochIds Array of bonus epoch IDs to claim.
    function claimBonus(uint64[] calldata epochIds) external {
        if (epochIds.length > MAX_CLAIM_EPOCHS) revert TooManyEpochs();

        address miner = msg.sender;
        uint256 totalPayout;

        for (uint256 i; i < epochIds.length; ++i) {
            uint64 eid = epochIds[i];
            if (!bonusClaimsOpen[eid]) revert ClaimsNotOpen();
            if (bonusClaimed[eid][miner]) revert AlreadyClaimed();

            uint256 minerCredits = mining.credits(eid, miner);
            if (minerCredits == 0) revert NoCredits();

            uint256 total = mining.totalCredits(eid);
            uint256 payout = (bonusReward[eid] * minerCredits) / total;

            bonusClaimed[eid][miner] = true;
            totalPayout += payout;

            emit BonusClaimed(eid, miner, payout);
        }

        if (totalPayout > 0) {
            rewardBalance -= totalPayout;
            botcoin.safeTransfer(miner, totalPayout);
        }
    }

    // ── Owner-only config ───────────────────────────────────────────────

    /// @notice Update the mining contract address. Required because the V2
    ///         mining contract may not be deployed when this contract is created.
    /// @param _mining The new mining contract address.
    function setMiningContract(address _mining) external onlyOwner {
        if (_mining == address(0)) revert ZeroAddress();
        emit MiningContractUpdated(address(mining), _mining);
        mining = IMiningCredits(_mining);
    }

    /// @notice Update the operator address (coordinator).
    /// @param _operator The new operator address.
    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, _operator);
        operator = _operator;
    }

    // ── Reserve (pre-TWAP bonus pool) ─────────────────────────────────

    /// @notice Deposit a reserve token (wETH, USDC, etc.) for on-chain
    ///         accounting of the accumulated bonus pool before TWAP.
    function depositReserve(address token, uint256 amount) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        reserve[token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit ReserveDeposited(token, amount);
    }

    /// @notice Withdraw reserve tokens (e.g. to execute TWAP off-chain).
    function withdrawReserve(address token, uint256 amount, address to) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (amount > reserve[token]) revert InsufficientReserve();
        reserve[token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit ReserveWithdrawn(token, amount, to);
    }

    /// @notice Sweep dust tokens from integer division truncation residuals.
    ///         Cannot withdraw more than the unobligated balance.
    /// @param to The address to send dust to.
    function sweepDust(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = botcoin.balanceOf(address(this));
        if (balance <= rewardBalance) revert ZeroAmount();
        uint256 dust = balance - rewardBalance;
        botcoin.safeTransfer(to, dust);
        emit DustSwept(to, dust);
    }
}
