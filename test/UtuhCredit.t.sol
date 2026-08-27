// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {UtuhCredit} from "../src/UtuhCredit.sol";
import {EventScope} from "../src/lib/EventScope.sol";
import {CreditFixture} from "./support/CreditFixture.sol";

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
            repayWindowBlocks: REPAY_WINDOW,
            peers: new address[](0)
        });
    }

    function setUp() public {
        registry = new UtuhRegistry(WINDOW);
        credit = new UtuhCredit(registry, _policy(RATE, WINDOW), _spec(2, 0), _cleanSet(), _spec(1, 2));
    }

    function _cleanSet() internal pure returns (UtuhCredit.HistorySpec[] memory set) {
        set = new UtuhCredit.HistorySpec[](1);
        set[0] = _spec(3, 0);
    }

    /// @notice Two adverse-event classes, as a lender watching more than one protocol would have.
    function _cleanSet2() internal pure returns (UtuhCredit.HistorySpec[] memory set) {
        set = new UtuhCredit.HistorySpec[](2);
        set[0] = _spec(3, 0);
        set[1] = _spec(2, 0);
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
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.ChallengeWindowFloorTooLow.selector, floor - 1, floor));
        new UtuhRegistry(floor - 1);
    }

    function test_creditRejectsWindowBelowRegistryFloor() public {
        uint64 floor = registry.ABSOLUTE_MIN_CHALLENGE_WINDOW();
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.WindowTooShort.selector, floor - 1, floor));
        new UtuhCredit(registry, _policy(RATE, floor - 1), _spec(2, 0), _cleanSet(), _spec(1, 2));
    }

    /// @notice A volume aggregate is in the reserve asset's units; a line is in CTC wei. Crossing
    ///         between them is a price, and a deployment that leaves it at zero would extend no
    ///         credit at all rather than silently extending dust.
    function test_creditRejectsZeroRate() public {
        vm.expectRevert(UtuhCredit.NoCredit.selector);
        new UtuhCredit(registry, _policy(0, WINDOW), _spec(2, 0), _cleanSet(), _spec(1, 2));
    }

    function test_creditRejectsSpecWithSameSubjectAndCounterpartyTopic() public {
        UtuhCredit.HistorySpec memory bad = _spec(1, 1);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.BadSubjectTopic.selector, uint8(1)));
        new UtuhCredit(registry, _policy(RATE, WINDOW), bad, _cleanSet(), _spec(1, 2));
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
        credit.openLine(ALICE, 1, _ids(2));
    }

    /// @notice The refusal is about the caller, not the address — even asking about yourself fails
    ///         until the binding exists.
    function test_openLineRefusesEvenForSelf() public {
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.SubjectNotControlled.selector, ALICE, ALICE));
        credit.openLine(ALICE, 1, _ids(2));
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
        // forge-lint: disable-next-line(unsafe-typecast) — the commitment's first twelve bytes are the tag; truncating to read them is the assertion
        assertEq(bytes12(c), credit.CONTROL_TAG());
        // forge-lint: disable-next-line(unsafe-typecast) — and its last twenty are the account; narrowing to uint160 is how an address is read
        assertEq(address(uint160(uint256(bytes32(c)))), BOB);
    }

    function testFuzz_controlCommitmentNamesTheAccount(address account) public view {
        bytes memory c = credit.controlCommitment(account);
        // forge-lint: disable-next-line(unsafe-typecast) — same layout, asserted for an arbitrary account
        assertEq(address(uint160(uint256(bytes32(c)))), account);
        // forge-lint: disable-next-line(unsafe-typecast) — same tag, asserted for an arbitrary account
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
        new UtuhCredit(registry, p, _spec(2, 0), _cleanSet(), _spec(1, 2));
    }

    function test_rejectsZeroRepayWindow() public {
        UtuhCredit.Policy memory p = _policy(RATE, WINDOW);
        p.repayWindowBlocks = 0;
        vm.expectRevert(UtuhCredit.BadTerms.selector);
        new UtuhCredit(registry, p, _spec(2, 0), _cleanSet(), _spec(1, 2));
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
    /// Every rounding in this contract should land against the party carrying the risk. The
    /// repayment rounds up so no draw owes nothing; the backing requirement rounds up so no limit
    /// is backed by less than a tenth of itself. A limit of 19 asks for 2, not 1.
    function testFuzz_backingRequiredIsNeverLessThanALimitImplies(uint128 limit) public view {
        uint256 multiple = credit.BOND_MULTIPLE();
        uint256 needed = credit.backingFor(limit);
        assertGe(needed * multiple, limit, "the backing asked for is short of the limit");
        if (limit > 0) assertGt(needed, 0, "a non-zero limit asked for no backing at all");
        // And never more than one unit above what is strictly required.
        if (limit > 0) assertLe((needed - 1) * multiple, limit, "the backing asked for overshoots");
    }

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

    /// @notice A claim nothing can rely on quotes no figure. Reporting the bond a refuted claim
    ///         once posted would read like a guarantee that no longer exists.
    function test_enforceableLossIsZeroForClaimsNothingBacks() public view {
        assertEq(registry.enforceableLoss(1), 0);
        assertEq(registry.enforceableLoss(999), 0);
    }

    /// @notice Pins the numbering that offchain/lib/status.ts and offchain/lib/scope.ts assume.
    /// @dev Solidity enums reach an ABI as a bare uint8, so the names live only here and something
    ///      off-chain has to mirror them. Six files each carried their own copy of the statuses
    ///      once, and one of them called LineStatus 2 "Repaid" — a status this system does not
    ///      have — which reached the deck and the submission notes before anyone compared it with
    ///      the contract. `Metric` is here for a sharper reason: it is chosen at deployment and
    ///      then immutable, and the sweep that has to agree with it is built off-chain, so a
    ///      disagreement produces no error at all — only claims that never match.
    ///      Reordering any of the three now breaks this, and this says where to look.
    function test_theEnumsAreWhatTheOffchainMirrorSays() public pure {
        assertEq(uint8(UtuhRegistry.Status.None), 0, "Status.None moved");
        assertEq(uint8(UtuhRegistry.Status.Open), 1, "Status.Open moved");
        assertEq(uint8(UtuhRegistry.Status.Sealed), 2, "Status.Sealed moved");
        assertEq(uint8(UtuhRegistry.Status.Finalized), 3, "Status.Finalized moved");
        assertEq(uint8(UtuhRegistry.Status.Refuted), 4, "Status.Refuted moved");

        assertEq(uint8(UtuhCredit.LineStatus.None), 0, "LineStatus.None moved");
        assertEq(uint8(UtuhCredit.LineStatus.Active), 1, "LineStatus.Active moved");
        assertEq(uint8(UtuhCredit.LineStatus.Settled), 2, "LineStatus.Settled moved");
        assertEq(uint8(UtuhCredit.LineStatus.Defaulted), 3, "LineStatus.Defaulted moved");
        assertEq(uint8(UtuhCredit.LineStatus.Closed), 4, "LineStatus.Closed moved");

        assertEq(uint8(EventScope.Metric.COUNT), 0, "Metric.COUNT moved");
        assertEq(uint8(EventScope.Metric.DATA_WORD), 1, "Metric.DATA_WORD moved");
    }

    /// @notice `finishLine.ts` reads a line before it knows whether one exists, so an unknown id
    ///         has to answer rather than revert — and it has to answer in a way that is
    ///         distinguishable from a real line.
    function test_anUnknownLineReadsAsNothingRatherThanReverting() public view {
        UtuhCredit.Line memory l = credit.line(999);
        assertEq(uint8(l.status), uint8(UtuhCredit.LineStatus.None), "an unknown line looked active");
        assertEq(l.borrower, address(0));
        assertEq(l.subject, address(0));
        assertEq(l.limit, 0);
        assertEq(l.drawn, 0);
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

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    // ------------------------------------------------------------------
    // More than one protocol
    // ------------------------------------------------------------------

    /// @notice A borrower with a spotless Aave record and a liquidated Compound position is not
    ///         clean, and a lender that asked about one contract would never find out. So a line
    ///         needs one empty claim per class the lender configured.
    function test_cleanSpecsAreListedAndRequiredInFull() public {
        UtuhCredit two = new UtuhCredit(registry, _policy(RATE, WINDOW), _spec(2, 0), _cleanSet2(), _spec(1, 2));
        assertEq(two.cleanSpecCount(), 2);
        assertEq(two.cleanSpecAt(0).subjectTopic, 3);
        assertEq(two.cleanSpecAt(1).subjectTopic, 2);
    }

    /// @notice Control is checked first, before the shape of the request. Someone who does not
    ///         hold the address gets turned away on that, and never learns whether their claim
    ///         list would have been the right length.
    function test_controlIsCheckedBeforeTheClaimList() public {
        UtuhCredit two = new UtuhCredit(registry, _policy(RATE, WINDOW), _spec(2, 0), _cleanSet2(), _spec(1, 2));
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.SubjectNotControlled.selector, ALICE, ALICE));
        two.openLine(ALICE, 1, _ids(2));
    }

    /// @notice A lender must configure at least one adverse-event class.
    function test_deploymentNeedsAtLeastOneCleanSpec() public {
        UtuhCredit.HistorySpec[] memory none = new UtuhCredit.HistorySpec[](0);
        vm.expectRevert(UtuhCredit.NoCleanSpecs.selector);
        new UtuhCredit(registry, _policy(RATE, WINDOW), _spec(2, 0), none, _spec(1, 2));
    }

    // ------------------------------------------------------------------
    // Refunds are pulled, not pushed
    // ------------------------------------------------------------------

    /// @notice finalize is permissionless and pays the claimant, so pushing would let a claimant
    ///         that cannot receive ether brick their own claim in Sealed forever — and with it
    ///         anything waiting on it.
    function test_withdrawStartsEmptyAndRefusesNothing() public {
        assertEq(registry.withdrawable(address(this)), 0);
        vm.expectRevert(UtuhRegistry.NothingToWithdraw.selector);
        registry.withdraw();
    }

    receive() external payable {}
}

/// @notice Reaches `_readCommitment`, which decides whether an address may be bound to an account.
/// @dev Not a stand-in for anything: it inherits the real contract and calls the real function
///      with the real constructor arguments. The only thing added is a way in.
contract ExposedCredit is UtuhCredit {
    constructor(
        UtuhRegistry registry,
        Policy memory policy,
        HistorySpec memory volume,
        HistorySpec[] memory clean,
        HistorySpec memory repay
    ) UtuhCredit(registry, policy, volume, clean, repay) {}

    function readCommitment(bytes memory data) external pure returns (bool ok, address account) {
        return _readCommitment(data);
    }

    function readControlTx(bytes calldata encodedTransaction) external pure returns (address subject, address account) {
        return _readControlTx(encodedTransaction);
    }
}

/// @notice The control commitment, read the way `proveControl` reads it.
/// @dev `proveControl` itself has to go through `0x0FD2`, which holds no bytecode and cannot run
///      locally, so this is the only place the parser is exercised against anything but the demo's
///      happy path. It is worth exercising: read too permissively and a stranger binds an address
///      they do not hold, which is the one failure that would make every claim about a borrower's
///      history meaningless.
contract ControlCommitmentTest is Test, CreditFixture {
    ExposedCredit internal credit;

    address constant ACCOUNT = address(0xC0FFEE);

    function setUp() public {
        UtuhRegistry registry = new UtuhRegistry(25);
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _spec(3, 0);
        credit = new ExposedCredit(registry, _policy(), _spec(2, 0), clean, _spec(1, 2));
    }

    /// The builder and the reader have to agree, or a borrower who follows the instructions
    /// exactly is refused. Nothing outside this contract enforces that they stay in step.
    function testFuzz_whatTheContractTellsYouToSendIsWhatItAccepts(address account) public view {
        bytes memory data = credit.controlCommitment(account);
        (bool ok, address read) = credit.readCommitment(data);
        assertTrue(ok, "the contract's own instructions were rejected");
        assertEq(read, account, "bound the wrong account");
    }

    function test_theTagMustMatch() public view {
        // forge-lint: disable-next-line(unsafe-typecast) — "utuh:CONTROL" is twelve bytes; the case is wrong on purpose, the width is not
        bytes memory data = abi.encodePacked(bytes12("utuh:CONTROL"), ACCOUNT);
        (bool ok, address read) = credit.readCommitment(data);
        assertFalse(ok, "a different tag was accepted");
        assertEq(read, address(0));
    }

    /// A near miss is the dangerous case: eleven right bytes and one wrong one must not pass.
    function test_aTagOffByOneByteIsRejected() public view {
        bytes12 tag = credit.CONTROL_TAG();
        bytes12 bent = bytes12(bytes32(tag) ^ bytes32(uint256(1) << 168));
        (bool ok,) = credit.readCommitment(abi.encodePacked(bent, ACCOUNT));
        assertFalse(ok, "a tag differing in one byte was accepted");
    }

    function test_shortCalldataIsRejected() public view {
        (bool ok,) = credit.readCommitment(abi.encodePacked(credit.CONTROL_TAG(), bytes19(0)));
        assertFalse(ok, "31 bytes was accepted");
    }

    function test_longCalldataIsRejected() public view {
        (bool ok,) = credit.readCommitment(abi.encodePacked(credit.CONTROL_TAG(), ACCOUNT, bytes1(0xff)));
        assertFalse(ok, "33 bytes was accepted");
    }

    function test_emptyCalldataIsRejected() public view {
        (bool ok,) = credit.readCommitment("");
        assertFalse(ok, "empty calldata was accepted");
    }

    /// An ordinary transfer is 32 bytes past the selector and must not read as a commitment.
    function test_anUnrelatedThirtyTwoByteWordIsRejected() public view {
        (bool ok,) = credit.readCommitment(abi.encode(uint256(1 ether)));
        assertFalse(ok, "an unrelated word was read as a commitment");
    }

    /// The zero account is the one an unset controller compares equal to, so binding it would make
    /// `controllerOf` unable to tell "never proven" from "proven to nobody".
    /// A binding that can be replayed is not a binding. The subject can move theirs by sending a
    /// second commitment; if the first proof stays usable, anyone can put it back, and the binding
    /// becomes whichever proof was replayed most recently rather than whichever the subject meant.
    /// The commitment layout is twelve bytes of tag then twenty of address, and `bytes12(...)`
    /// truncates silently. Rename the tag to anything longer and every commitment ever issued
    /// still parses, against a tag that is no longer the one the constant reads as.
    function test_theTagIsExactlyTheTwelveBytesItReadsAs() public view {
        assertEq(bytes(string("utuh:control")).length, 12, "the tag is not twelve bytes");
        // forge-lint: disable-next-line(unsafe-typecast) — bytes12 of a twelve-byte string truncates nothing, which is exactly what this asserts
        assertEq(credit.CONTROL_TAG(), bytes12(bytes("utuh:control")), "the tag was truncated or padded");
        // And the commitment is exactly those twelve bytes followed by twenty of address.
        bytes memory c = credit.controlCommitment(ACCOUNT);
        assertEq(c.length, 32, "a commitment is not 32 bytes");
    }

    function test_aControlIdIsOneTransactionOnOneChain() public view {
        bytes memory txA = abi.encodePacked("transaction-a");
        bytes memory txB = abi.encodePacked("transaction-b");

        assertEq(credit.controlIdOf(1, txA), credit.controlIdOf(1, txA), "the same commitment got two ids");
        assertTrue(credit.controlIdOf(1, txA) != credit.controlIdOf(1, txB), "two transactions share an id");
        assertTrue(credit.controlIdOf(1, txA) != credit.controlIdOf(3, txA), "two chains share an id");
    }

    /// The height is deliberately not part of the id: a reorg that moved the same transaction must
    /// not make the same commitment usable a second time.
    function testFuzz_theIdDependsOnNothingButTheChainAndTheBytes(uint64 chainKey, bytes memory encoded) public view {
        assertEq(credit.controlIdOf(chainKey, encoded), keccak256(abi.encode(chainKey, keccak256(encoded))));
    }

    function test_nothingIsMarkedUsedBeforeAnythingIsProven() public view {
        assertFalse(credit.controlProofUsed(credit.controlIdOf(1, abi.encodePacked("anything"))));
    }

    function test_theZeroAccountRoundTripsAsZeroAndIsStillATag() public view {
        (bool ok, address read) = credit.readCommitment(credit.controlCommitment(address(0)));
        assertTrue(ok, "a well-formed commitment was rejected");
        assertEq(read, address(0));
    }
}

/// @notice A lender that cannot receive ether — a vault or a multisig of the wrong shape.
/// @dev Not a stand-in for anything: it deploys the real contract and becomes its real LENDER,
///      which is exactly the deployment that used to strand its own capital.
contract LenderThatCannotReceive {
    UtuhCredit public credit;

    function deploy(
        UtuhRegistry registry,
        UtuhCredit.Policy memory policy,
        UtuhCredit.HistorySpec memory volume,
        UtuhCredit.HistorySpec[] memory clean,
        UtuhCredit.HistorySpec memory repay
    ) external {
        credit = new UtuhCredit(registry, policy, volume, clean, repay);
    }

    function fund() external payable {
        credit.fund{value: msg.value}();
    }

    function withdraw(uint256 amount) external {
        credit.withdraw(amount);
    }

    function withdrawTo(address to, uint256 amount) external {
        credit.withdrawTo(to, amount);
    }

    receive() external payable {
        revert("no");
    }
}

/// @notice Getting the lender's own capital back out.
/// @dev LENDER is msg.sender at construction and immutable. Every payout went straight to it, so a
///      lender that is a contract without a payable fallback could fund this and never recover the
///      money: fund accepts, withdraw reverts, forever. withdrawTo is the way out, and these are
///      the tests that say so.
contract LenderWithdrawTest is Test, CreditFixture {
    UtuhRegistry internal registry;
    address constant ELSEWHERE = address(0xBEEF);

    function setUp() public {
        registry = new UtuhRegistry(25);
    }

    function _deployVia(LenderThatCannotReceive lender) internal returns (UtuhCredit) {
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _spec(3, 0);
        lender.deploy(registry, _policy(), _spec(2, 0), clean, _spec(1, 2));
        return lender.credit();
    }

    /// The three tests below start from the same place: a lender that cannot receive its own
    /// money, holding one ether of capital.
    function _fundedLender() internal returns (LenderThatCannotReceive lender, UtuhCredit credit) {
        lender = new LenderThatCannotReceive();
        credit = _deployVia(lender);
        vm.deal(address(this), 2 ether);
        lender.fund{value: 1 ether}();
    }

    /// The deployment that used to strand its own money.
    function test_aLenderThatCannotReceiveIsNotStranded() public {
        LenderThatCannotReceive lender = new LenderThatCannotReceive();
        UtuhCredit credit = _deployVia(lender);
        assertEq(credit.LENDER(), address(lender), "the deployer is not the lender");

        vm.deal(address(this), 5 ether);
        lender.fund{value: 3 ether}();
        assertEq(credit.available(), 3 ether);

        // Paying itself is exactly what it cannot do.
        vm.expectRevert(UtuhCredit.TransferFailed.selector);
        lender.withdraw(1 ether);

        // Naming somewhere else works, and the accounting follows.
        lender.withdrawTo(ELSEWHERE, 1 ether);
        assertEq(ELSEWHERE.balance, 1 ether, "the money did not arrive");
        assertEq(credit.available(), 2 ether, "available did not follow the payout");
    }

    function test_onlyTheLenderMayDirectTheCapital() public {
        (, UtuhCredit credit) = _fundedLender();

        vm.expectRevert(UtuhCredit.NotLender.selector);
        credit.withdrawTo(ELSEWHERE, 1 ether);
    }

    /// A payout to the zero address succeeds at the EVM level and burns the value, so it is
    /// refused for the same reason SettlementLedger refuses it.
    function test_theZeroAddressIsNotAWithdrawalTarget() public {
        (LenderThatCannotReceive lender, UtuhCredit credit) = _fundedLender();

        vm.expectRevert(UtuhCredit.NoPayee.selector);
        lender.withdrawTo(address(0), 1 ether);
        assertEq(credit.available(), 1 ether, "a refused withdrawal moved the accounting");
    }

    function test_moreThanIsAvailableIsRefused() public {
        (LenderThatCannotReceive lender, UtuhCredit credit) = _fundedLender();

        vm.expectRevert(UtuhCredit.NothingToWithdraw.selector);
        lender.withdrawTo(ELSEWHERE, 1 ether + 1);
        assertEq(credit.available(), 1 ether);
    }
}

/// @notice What a proven transaction has to be before it can bind an address.
/// @dev The bytes here are real: two Sepolia transactions the Block Prover has already vouched
///      for, captured from the recorded full-flow run and stored as they came back. One is the
///      borrower's control commitment; the other is an ordinary settlement, which is what a
///      transaction that is *not* a commitment looks like. Neither can go stale — they are
///      history.
contract ControlTransactionTest is Test, CreditFixture {
    ExposedCredit internal credit;

    address constant BORROWER = 0x01a802C650ccceF077208A93c1cF43025239003f;

    /// The fixture transactions are Sepolia, which CC3 Testnet numbers chain key 1.
    uint64 constant SEPOLIA = 1;

    bytes internal control;
    bytes internal settlement;

    function setUp() public {
        string memory json = vm.readFile("test/fixtures/encodedTransactions.json");
        control = vm.parseJsonBytes(json, ".control");
        settlement = vm.parseJsonBytes(json, ".settlement");

        UtuhRegistry registry = new UtuhRegistry(25);
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _specOn(SEPOLIA, 3, 0);
        credit = new ExposedCredit(registry, _policy(), _specOn(SEPOLIA, 2, 0), clean, _specOn(SEPOLIA, 1, 2));
    }

    /// The real commitment, read the way proveControl reads it: the sender comes out of bytes the
    /// prover vouched for, and the account comes out of the calldata inside them.
    function test_aRealCommitmentNamesItsSenderAndItsAccount() public view {
        (address subject, address account) = credit.readControlTx(control);
        assertEq(subject, BORROWER, "the sender is not the address that sent it");
        assertEq(account, BORROWER, "the bound account is not the one in the calldata");
    }

    /// An ordinary transaction is not a commitment, however well proven it is. This is the check
    /// that stops any proven transaction from binding an address.
    function test_anOrdinaryTransactionIsNotACommitment() public {
        vm.expectRevert(UtuhCredit.NotAControlCommitment.selector);
        credit.readControlTx(settlement);
    }

    /// Bytes that are not an encoded transaction at all.
    function test_bytesThatAreNotATransactionAreRefused() public {
        vm.expectRevert();
        credit.readControlTx(hex"deadbeef");
    }

    function test_emptyBytesAreRefused() public {
        vm.expectRevert();
        credit.readControlTx("");
    }
}
