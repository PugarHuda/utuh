// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title SettlementLedger — a minimal payment record on the source chain
/// @author Utuh
///
/// @notice This contract does not live on Creditcoin. It is deployed on the *source* chain, and
/// Utuh reads its events across through the Attestcoin Protocol.
///
/// @dev Utuh's mainnet demonstration reads Aave V3, because Aave is where real borrowers already
/// have real histories. Nobody can originate an Aave position on demand, though, so the parts of
/// the flow that need a borrower to actually *act* — paying, repaying, being marked adverse — need
/// a counterparty on a chain where acting is cheap. This is that counterparty.
///
/// Nothing here is a stand-in for the protocol under test. The payments are real transfers of real
/// testnet ether, the events are real logs in real blocks, and Creditcoin attests them exactly as
/// it attests Aave's. A scope is a scope; the registry cannot tell the difference and does not
/// need to.
contract SettlementLedger {
    /// @notice A payment from `payer` to `payee`. The amount is the value actually forwarded.
    event Settled(address indexed payer, address indexed payee, uint256 amount);

    /// @notice An adverse credit event against `subject` — the shape Aave's LiquidationCall has,
    ///         and what a clean claim asserts the absence of.
    event Adverse(address indexed subject, uint256 amount);

    error PaymentFailed();
    error NothingToSettle();
    error NoPayee();

    /// @notice Pay `payee` and record it.
    /// @dev The ether goes through rather than into this contract: a settlement nobody received is
    ///      not a settlement. The zero address is refused for the same reason — a call to it
    ///      succeeds and burns the value, so without this guard the contract would emit a
    ///      `Settled` event for ether nobody was paid. A lender whose HistorySpec leaves the
    ///      counterparty unpinned would then be counting burns as volume.
    function settle(address payee) external payable {
        if (msg.value == 0) revert NothingToSettle();
        if (payee == address(0)) revert NoPayee();
        emit Settled(msg.sender, payee, msg.value);
        (bool ok,) = payable(payee).call{value: msg.value}("");
        if (!ok) revert PaymentFailed();
    }

    /// @notice Record an adverse event against `subject`.
    /// @dev Unpermissioned, because on the source chain the equivalent event is emitted by whatever
    ///      protocol the borrower actually used, not by the borrower and not by Utuh. What matters
    ///      to a claim is that the log exists in an attested block — the registry verifies the
    ///      event, never the authority of whoever caused it. A lender chooses which emitter it
    ///      trusts when it sets its HistorySpec, and that choice is the trust boundary.
    function recordAdverse(address subject, uint256 amount) external {
        emit Adverse(subject, amount);
    }
}
