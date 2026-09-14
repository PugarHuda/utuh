// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {UtuhRegistry} from "utuh/UtuhRegistry.sol";
import {EventScope} from "utuh/lib/EventScope.sol";

/// @notice Anything that records which Creditcoin account a source-chain address bound itself to.
/// @dev `UtuhCredit.controllerOf` is one: set only by `proveControl`, from a Block Prover proof of
///      a transaction the subject's own key sent.
interface IControllerOf {
    function controllerOf(address subject) external view returns (address);
}

/// @title NeverLiquidatedGate
/// @notice A lender-side gate that is not Utuh and consumes Utuh. It grants an allowance to an
///         account only on a Finalized Utuh claim that asserts, under bond, "this address was never
///         liquidated on Aave V3 (Ethereum mainnet) over at least MIN_HISTORY_BLOCKS blocks", and
///         only to the account that address proved it controls.
/// @dev Gluwa's `ASCLoanManager` proves the events that happened (funding, repayment) and settles
///      the one that did not (a missed repayment) with `onlyOwner`. This is the other half: a
///      sentence about absence, read as a boolean, with no owner and no proofs held here.
contract NeverLiquidatedGate {
    uint64 public constant ETHEREUM_MAINNET = 3; // CC3's chain key for Ethereum mainnet
    address public constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    bytes32 public constant LIQUIDATION_CALL =
        keccak256("LiquidationCall(address,address,address,uint256,uint256,address,bool)");

    UtuhRegistry public immutable REGISTRY;
    IControllerOf public immutable CONTROL;
    uint64 public immutable MIN_HISTORY_BLOCKS;

    /// @notice What each account may be lent, in wei of CTC. Never more than one claim's
    ///         enforceable loss: a second grant replaces the first rather than adding to it.
    mapping(address => uint256) public allowanceOf;

    /// @notice One claim backs one grant.
    mapping(uint256 => bool) public claimUsed;

    event AllowanceGranted(address indexed account, address indexed subject, uint256 indexed claimId, uint256 amount);

    error WrongScope(uint256 claimId, bytes32 expected, bytes32 actual);
    error HistoryTooShort(uint64 span, uint64 required);
    error NotClean(uint256 claimId, uint256 liquidations);
    error NotUsable(uint256 claimId, uint256 amount, uint256 enforceableLoss);
    error NotController(address subject, address caller);
    error ClaimAlreadyUsed(uint256 claimId);

    constructor(UtuhRegistry registry, IControllerOf control, uint64 minHistoryBlocks) {
        REGISTRY = registry;
        CONTROL = control;
        MIN_HISTORY_BLOCKS = minHistoryBlocks;
    }

    /// @notice The exact scope a claim must carry to speak for `subject`. Built the way the
    ///         registry stores it, so `EventScope.id` of the two is equal only if every field is.
    /// @dev Aave V3 `LiquidationCall(collateralAsset indexed, debtAsset indexed, user indexed, ...)`:
    ///      the borrower is topics[3], which is `Scope.topics[2]` and mask bit 2.
    function expectedScope(address subject) public pure returns (EventScope.Scope memory s) {
        s.chainKey = ETHEREUM_MAINNET;
        s.emitter = AAVE_V3_POOL;
        s.eventSig = LIQUIDATION_CALL;
        s.topics[2] = bytes32(uint256(uint160(subject)));
        s.topicMask = 4;
        s.metric = EventScope.Metric.COUNT;
    }

    /// @notice Grant the caller an allowance of `amount` on `claimId`.
    function grant(uint256 claimId, uint256 amount) external returns (address subject) {
        UtuhRegistry.Claim memory c = REGISTRY.claim(claimId);

        // The subject is read out of the claim, then the whole scope is rebuilt for it and compared
        // by identity. A claim about another pool, event, topic position or metric fails here, and
        // so does a topic with bits above the address: it truncates to a subject whose scope differs.
        subject = address(uint160(uint256(c.scope.topics[2])));
        bytes32 want = EventScope.id(expectedScope(subject));
        bytes32 got = EventScope.id(c.scope);
        if (got != want) revert WrongScope(claimId, want, got);

        uint64 span = c.toBlock - c.fromBlock;
        if (span < MIN_HISTORY_BLOCKS) revert HistoryTooShort(span, MIN_HISTORY_BLOCKS);

        // Count members, not the aggregate: the assertion is that the set is empty.
        uint256 liquidations = REGISTRY.memberCount(claimId);
        if (liquidations != 0) revert NotClean(claimId, liquidations);

        // Finalized, unrefuted, and a liar would certainly have lost at least `amount`.
        if (!REGISTRY.isUsable(claimId, amount)) {
            revert NotUsable(claimId, amount, REGISTRY.enforceableLoss(claimId));
        }

        // A public history is not the caller's history. Only the account the subject's key bound
        // may spend it.
        if (CONTROL.controllerOf(subject) != msg.sender) revert NotController(subject, msg.sender);

        if (claimUsed[claimId]) revert ClaimAlreadyUsed(claimId);
        claimUsed[claimId] = true;
        allowanceOf[msg.sender] = amount;

        emit AllowanceGranted(msg.sender, subject, claimId, amount);
    }
}
