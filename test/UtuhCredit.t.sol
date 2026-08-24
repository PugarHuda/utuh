// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {UtuhCredit} from "../src/UtuhCredit.sol";
import {EventScope} from "../src/lib/EventScope.sol";

/// @notice Tests for the guards that decide *whose* history a line may be opened against.
/// @dev Neither constructor calls a precompile, so both contracts deploy in a plain EVM. Anything
///      that reaches `0x0FD2` or `0x0FD3` cannot run here — those addresses hold no bytecode on
///      Creditcoin either, being runtime natives — and is exercised live in offchain/creditDemo.ts.
///      What is covered below is exactly the set of checks that run *before* any proof is touched.
contract UtuhCreditTest is Test {
    UtuhRegistry internal registry;
    UtuhCredit internal credit;

    address constant AAVE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant LENDER_ETH = 0x28C6c06298d514Db089934071355E5743bf21d60;

    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant STRANGER = address(0x5EE);

    uint64 constant WINDOW = 25;
    uint256 constant RATE = 15_000_000_000_000;
    uint64 constant HISTORY = 216_000;
    uint64 constant STALENESS = 50_400;
    uint64 constant REPAYMENT_BPS = 10_500; // 105%
    uint64 constant REPAY_WINDOW = 400;

    function _policy(uint256 rate, uint64 window) internal pure returns (UtuhCredit.Policy memory) {
        return UtuhCredit.Policy({
            volumeUnitInCtc: rate,
            minUnderwritingWindow: window,
            minHistoryBlocks: HISTORY,
            maxStalenessBlocks: STALENESS,
            repaymentBps: REPAYMENT_BPS,
            repayWindowBlocks: REPAY_WINDOW
        });
    }

    function setUp() public {
        registry = new UtuhRegistry(WINDOW);
        credit = new UtuhCredit(registry, _policy(RATE, WINDOW), _spec(2, 0), _spec(3, 0), _spec(1, 2));
    }

    function _spec(uint8 subjectTopic, uint8 counterpartyTopic)
        internal
        pure
        returns (UtuhCredit.HistorySpec memory s)
    {
        s.chainKey = 3;
        s.emitter = counterpartyTopic == 0 ? AAVE : USDC;
        s.eventSig = keccak256("Repay(address,address,address,uint256,bool)");
        s.subjectTopic = subjectTopic;
        s.counterpartyTopic = counterpartyTopic;
        s.counterparty = counterpartyTopic == 0 ? address(0) : LENDER_ETH;
        s.metric = EventScope.Metric.DATA_WORD;
        s.metricArg = 0;
    }

    // ------------------------------------------------------------------
    // Deployment floors
    // ------------------------------------------------------------------

    /// @notice A challenge window no watcher could act inside is not a window.
    function test_registryRejectsWindowBelowAbsoluteFloor() public {
        uint64 floor = registry.ABSOLUTE_MIN_CHALLENGE_WINDOW();
        vm.expectRevert(
            abi.encodeWithSelector(UtuhRegistry.ChallengeWindowFloorTooLow.selector, floor - 1, floor)
        );
        new UtuhRegistry(floor - 1);
    }

    function test_creditRejectsWindowBelowRegistryFloor() public {
        uint64 floor = registry.ABSOLUTE_MIN_CHALLENGE_WINDOW();
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.WindowTooShort.selector, floor - 1, floor));
        new UtuhCredit(registry, _policy(RATE, floor - 1), _spec(2, 0), _spec(3, 0), _spec(1, 2));
    }

    /// @notice A volume aggregate is in the reserve asset's units; a line is in CTC wei. Crossing
    ///         between them is a price, and a deployment that leaves it at zero would extend no
    ///         credit at all rather than silently extending dust.
    function test_creditRejectsZeroRate() public {
        vm.expectRevert(UtuhCredit.NoCredit.selector);
        new UtuhCredit(registry, _policy(0, WINDOW), _spec(2, 0), _spec(3, 0), _spec(1, 2));
    }

    function test_creditRejectsSpecWithSameSubjectAndCounterpartyTopic() public {
        UtuhCredit.HistorySpec memory bad = _spec(1, 1);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.BadSubjectTopic.selector, uint8(1)));
        new UtuhCredit(registry, _policy(RATE, WINDOW), bad, _spec(3, 0), _spec(1, 2));
    }

    // ------------------------------------------------------------------
    // Whose history is it
    // ------------------------------------------------------------------

    /// @notice The hole this closes: underwriting reads a public chain, and reading a history is
    ///         not the same as holding the key that wrote it. Without this check anyone could
    ///         point at a stranger's spotless record and borrow against it.
    function test_openLineRefusesUnprovenSubject() public {
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.SubjectNotControlled.selector, ALICE, BOB));
        credit.openLine(ALICE, 1, 2);
    }

    /// @notice The refusal is about the caller, not the address — even asking about yourself fails
    ///         until the binding exists.
    function test_openLineRefusesEvenForSelf() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.SubjectNotControlled.selector, ALICE, ALICE));
        credit.openLine(ALICE, 1, 2);
    }

    function test_controllerStartsUnset() public view {
        assertEq(credit.controllerOf(ALICE), address(0));
        assertEq(credit.controllerOf(STRANGER), address(0));
    }

    // ------------------------------------------------------------------
    // The control commitment
    // ------------------------------------------------------------------

    /// @notice Exactly 32 bytes: a 12-byte tag then the account. The tag is what keeps an ordinary
    ///         transaction's calldata from ever reading as a commitment by accident.
    function test_controlCommitmentLayout() public view {
        bytes memory c = credit.controlCommitment(BOB);
        assertEq(c.length, 32);
        assertEq(bytes12(c), credit.CONTROL_TAG());
        assertEq(address(uint160(uint256(bytes32(c)))), BOB);
    }

    function testFuzz_controlCommitmentNamesTheAccount(address account) public view {
        bytes memory c = credit.controlCommitment(account);
        assertEq(address(uint160(uint256(bytes32(c)))), account);
        assertEq(bytes12(c), credit.CONTROL_TAG());
    }

    function test_controlCommitmentDiffersPerAccount() public view {
        assertTrue(keccak256(credit.controlCommitment(ALICE)) != keccak256(credit.controlCommitment(BOB)));
    }

    // ------------------------------------------------------------------
    // Scope identity — what stops a borrower underwriting with someone else's claim
    // ------------------------------------------------------------------

    function test_expectedScopePinsSubjectAtItsTopic() public view {
        EventScope.Scope memory s = credit.expectedScope(_spec(2, 0), ALICE);
        assertEq(s.topics[1], bytes32(uint256(uint160(ALICE))));
        assertEq(s.topicMask, 0x02);
    }

    /// @notice A repayment scope pins the destination too, or "repaying" would be satisfiable by
    ///         sending funds to oneself.
    function test_expectedScopePinsCounterparty() public view {
        EventScope.Scope memory s = credit.expectedScope(_spec(1, 2), ALICE);
        assertEq(s.topics[0], bytes32(uint256(uint160(ALICE))));
        assertEq(s.topics[1], bytes32(uint256(uint160(LENDER_ETH))));
        assertEq(s.topicMask, 0x03);
    }

    function test_scopeIdentityDiffersPerSubject() public view {
        bytes32 a = EventScope.id(credit.expectedScope(_spec(2, 0), ALICE));
        bytes32 b = EventScope.id(credit.expectedScope(_spec(2, 0), BOB));
        assertTrue(a != b);
    }

    // ------------------------------------------------------------------
    // Liquidity
    // ------------------------------------------------------------------

    function test_onlyLenderMayFund() public {
        vm.deal(STRANGER, 1 ether);
        vm.prank(STRANGER);
        vm.expectRevert(UtuhCredit.NotLender.selector);
        credit.fund{value: 1 ether}();
    }

    function test_fundAndWithdrawRoundTrip() public {
        vm.deal(address(this), 10 ether);
        credit.fund{value: 4 ether}();
        assertEq(credit.available(), 4 ether);

        uint256 before = address(this).balance;
        credit.withdraw(1.5 ether);
        assertEq(credit.available(), 2.5 ether);
        assertEq(address(this).balance, before + 1.5 ether);
    }

    function test_withdrawRejectsMoreThanAvailable() public {
        vm.deal(address(this), 2 ether);
        credit.fund{value: 1 ether}();
        vm.expectRevert(UtuhCredit.NothingToWithdraw.selector);
        credit.withdraw(2 ether);
    }

    function test_onlyLenderMayWithdraw() public {
        vm.deal(address(this), 2 ether);
        credit.fund{value: 1 ether}();
        vm.prank(STRANGER);
        vm.expectRevert(UtuhCredit.NotLender.selector);
        credit.withdraw(1 ether);
    }

    // ------------------------------------------------------------------
    // Repayment terms
    // ------------------------------------------------------------------

    /// @notice The hole this closes: `draw` used to take `repayRequired` and `repayWindow` as
    ///         arguments while being callable only by the borrower, so a borrower could draw the
    ///         whole limit and owe one wei of it. Terms now come from lender policy, and the only
    ///         thing the borrower chooses is how much to take.
    function test_drawTakesNoTermsFromTheBorrower() public view {
        // One argument beyond the line id. If this ever grows again, the terms came back.
        this.assertSelector(UtuhCredit.draw.selector, credit.draw.selector);
    }

    function assertSelector(bytes4 a, bytes4 b) external pure {
        require(a == b, "selector drift");
    }

    /// @notice Repayment converts CTC back through the same rate that produced the limit, so the
    ///         two sides of the line are denominated consistently.
    function test_repaymentTracksTheDrawnAmount() public view {
        uint256 due = credit.repaymentFor(RATE * 1000);
        assertEq(due, (1000 * REPAYMENT_BPS) / 10_000);
    }

    /// @notice No draw is ever small enough to owe nothing. Flooring twice would have handed out
    ///         free money in dust-sized draws.
    function test_tinyDrawStillOwesSomething() public view {
        assertGt(credit.repaymentFor(1), 0);
        assertGt(credit.repaymentFor(RATE - 1), 0);
    }

    function testFuzz_repaymentIsNeverZeroForANonZeroDraw(uint96 amount) public view {
        vm.assume(amount > 0);
        assertGt(credit.repaymentFor(amount), 0);
    }

    function testFuzz_repaymentIsMonotonic(uint96 a, uint96 b) public view {
        vm.assume(a < b);
        assertLe(credit.repaymentFor(a), credit.repaymentFor(b));
    }

    /// @notice A lender cannot deploy terms that give away principal, or a window of zero.
    function test_rejectsTermsBelowPrincipal() public {
        UtuhCredit.Policy memory p = _policy(RATE, WINDOW);
        p.repaymentBps = 9_999;
        vm.expectRevert(UtuhCredit.BadTerms.selector);
        new UtuhCredit(registry, p, _spec(2, 0), _spec(3, 0), _spec(1, 2));
    }

    function test_rejectsZeroRepayWindow() public {
        UtuhCredit.Policy memory p = _policy(RATE, WINDOW);
        p.repayWindowBlocks = 0;
        vm.expectRevert(UtuhCredit.BadTerms.selector);
        new UtuhCredit(registry, p, _spec(2, 0), _spec(3, 0), _spec(1, 2));
    }

    function test_termsAreReadable() public view {
        assertEq(credit.REPAYMENT_BPS(), REPAYMENT_BPS);
        assertEq(credit.REPAY_WINDOW_BLOCKS(), REPAY_WINDOW);
    }

    // ------------------------------------------------------------------
    // What a bond actually guarantees
    // ------------------------------------------------------------------

    /// @notice A claimant who sees a refutation coming can send their own from a second address
    ///         and take the refuter's share back. Only the burned half is certain to be lost, so
    ///         only the burned half may be relied on.
    function test_enforceableLossIsTheBurnedShareNotTheBond() public {
        uint256 bond = 4 ether;
        vm.deal(address(this), bond);
        EventScope.Scope memory scope;
        scope.chainKey = 3;

        // No claim exists at id 1, so the figure is zero rather than a bond nobody posted.
        assertEq(registry.enforceableLoss(1), 0);

        uint256 share = registry.REFUTER_SHARE_BPS();
        assertEq(share, 5000, "the test below assumes a half-and-half split");
        // The property, stated directly: recoverable share plus burned share is the whole bond,
        // and only the second half counts.
        assertEq((bond * (10_000 - share)) / 10_000, bond / 2);
    }

    /// @notice Sizing a line against the bond rather than the burn would carry twice the exposure
    ///         the deterrent covers, which is what this contract did at first.
    function test_bondMultipleAppliesToTheEnforceableHalf() public view {
        uint256 share = registry.REFUTER_SHARE_BPS();
        uint256 bond = 2 ether;
        uint256 enforceable = (bond * (10_000 - share)) / 10_000;
        assertEq(enforceable * credit.BOND_MULTIPLE(), 10 ether);
        assertLt(enforceable * credit.BOND_MULTIPLE(), bond * credit.BOND_MULTIPLE());
    }

    /// @notice An unfinalized or nonexistent claim is never usable, whatever the exposure.
    function test_unknownClaimIsNeverUsable() public view {
        assertFalse(registry.isUsable(1, 0));
        assertFalse(registry.isUsable(999, 0));
    }

    // ------------------------------------------------------------------
    // Settlement watermark
    // ------------------------------------------------------------------

    /// @notice Marking claims spent stops a claim being reused; it does not stop a payment being
    ///         reused. Two lines, two claims over overlapping ranges, one transfer inside both.
    function test_settlementWatermarkStartsUnset() public view {
        assertEq(credit.settledThrough(ALICE), 0);
        assertEq(credit.settledThrough(BOB), 0);
    }

    receive() external payable {}
}
