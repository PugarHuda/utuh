// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {UtuhCredit} from "../src/UtuhCredit.sol";
import {EventScope} from "../src/lib/EventScope.sol";
import {IBlockProver} from "../src/interfaces/IBlockProver.sol";
import {IChainInfo} from "../src/interfaces/IChainInfo.sol";

/// @notice The whole loop — claim, seal, refute, finalize, underwrite, draw, settle, default,
///         cure — run locally, against real source-chain bytes.
///
/// @dev Every other suite here stops at the first line that touches `0x0FD2` or `0x0FD3`, because
///      those are Substrate runtime natives with no bytecode and a plain EVM cannot execute them.
///      That left the entire happy path — everything past the guards — exercised only by the live
///      scripts, which need CTC, a funded key and a network. A hundred tests passed without one of
///      them opening a line.
///
///      What is substituted here is exactly two answers and nothing else:
///
///        - the Block Prover's verdict on a proof (`verifyAndEmit` → true) and the transaction
///          index it reads out of the Merkle path;
///        - the ChainInfo precompile's attestation heights.
///
///      Everything downstream of those runs for real, on the bytes of a real Sepolia transaction
///      captured from the recorded full-flow run: the transaction is decoded by the real
///      `EvmV1Decoder`, the receipt status is read, the log is matched against the scope field by
///      field, the metric is pulled out of the log's data, the ordering key is packed, membership
///      is binary-searched, and every figure below falls out of that arithmetic rather than being
///      asserted into place.
///
///      The two substituted answers are the two this repository checks against the live chain
///      every day instead: `npm run probe` proves real mainnet transactions through `0x0FD2` over
///      `eth_call`, and CI runs it on a schedule. A wrong verdict there is caught there. What
///      could not be caught anywhere was a wrong *consequence* of a right verdict, and that is
///      what this file is for.
contract LifecycleTest is Test {
    address internal constant PROVER = 0x0000000000000000000000000000000000000FD2;
    address internal constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;

    /// The two `verifyAndEmit` overloads share a name, so `.selector` cannot name either of them.
    /// A wrong value here does not weaken a test — the mock simply never applies, the call lands on
    /// an address with no code, and decoding its empty return reverts.
    bytes4 internal constant VERIFY_ONE =
        bytes4(keccak256("verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))"));
    bytes4 internal constant VERIFY_BATCH =
        bytes4(keccak256("verifyAndEmit(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))"));

    /// The fixture transaction is Sepolia, which CC3 Testnet numbers chain key 1.
    uint64 internal constant SEPOLIA = 1;
    uint64 internal constant TX_INDEX = 7;

    uint64 internal constant WINDOW = 25;
    uint256 internal constant BOND = 2 ether;
    uint256 internal constant RATE = 20_000; // CTC wei per wei of settled ether

    uint64 internal constant VOL_FROM = 1_000_000;
    uint64 internal constant VOL_TO = 1_000_200;
    uint64 internal constant FRONTIER = 1_000_500;

    UtuhRegistry internal registry;
    UtuhCredit internal credit;

    bytes internal settlement;
    bytes internal control;

    /// Read out of the fixture rather than written down beside it.
    address internal ledger;
    bytes32 internal settledSig;
    address internal payer;
    address internal payee;
    uint256 internal settledAmount;

    address internal constant WATCHER = address(0xBEEF);

    function setUp() public {
        string memory json = vm.readFile("test/fixtures/encodedTransactions.json");
        settlement = vm.parseJsonBytes(json, ".settlement");
        control = vm.parseJsonBytes(json, ".control");

        EvmV1Decoder.ReceiptFields memory r = EvmV1Decoder.decodeReceiptFields(settlement);
        EvmV1Decoder.LogEntry memory log = r.receiptLogs[0];
        ledger = log.address_;
        settledSig = log.topics[0];
        payer = address(uint160(uint256(log.topics[1])));
        payee = address(uint160(uint256(log.topics[2])));
        settledAmount = uint256(bytes32(log.data));

        registry = new UtuhRegistry(WINDOW);
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        credit = new UtuhCredit(registry, _policy(), _paymentSpec(), clean, _paymentSpec());

        _mockChainInfo(FRONTIER);
        _mockProver();

        vm.deal(payer, 100 ether);
        vm.deal(address(this), 100 ether);
        vm.deal(WATCHER, 1 ether);
    }

    // ------------------------------------------------------------------
    // What the fixture actually is
    // ------------------------------------------------------------------

    /// @notice The bytes underneath every test below, read the way the registry reads them.
    /// @dev If this fails, nothing else in the file means what it says.
    function test_theFixtureIsASettlementFromThePayerToThePayee() public view {
        assertTrue(ledger != address(0), "no emitter in the fixture");
        assertEq(settledSig, keccak256("Settled(address,address,uint256)"), "not a Settled log");
        assertTrue(payer != payee, "payer and payee are the same address");
        assertEq(settledAmount, 0.001 ether, "the recorded settlement was 0.001 ETH");
    }

    // ------------------------------------------------------------------
    // The registry, end to end
    // ------------------------------------------------------------------

    /// @notice Three proven events, sealed, unchallenged, finalized — and the bond comes back.
    function test_aClaimAggregatesWhatItProvesAndReturnsItsBond() public {
        uint64[] memory at = _heights(3);
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, at);

        assertEq(registry.memberCount(claimId), 3, "three members");
        assertEq(registry.claim(claimId).aggregate, 3 * settledAmount, "aggregate is the sum of the logs");
        assertEq(uint8(registry.claim(claimId).status), uint8(UtuhRegistry.Status.Sealed));

        // Keys are strictly ascending, and chronological order is numeric order.
        assertLt(registry.keyAt(claimId, 0), registry.keyAt(claimId, 1));
        assertLt(registry.keyAt(claimId, 1), registry.keyAt(claimId, 2));
        assertEq(registry.keyAt(claimId, 0), EventScope.key(at[0], TX_INDEX, 0));

        _finalize(claimId);
        assertEq(uint8(registry.claim(claimId).status), uint8(UtuhRegistry.Status.Finalized));

        uint256 before = payer.balance;
        vm.prank(payer);
        registry.withdraw();
        assertEq(payer.balance - before, BOND, "the bond came back whole");
    }

    /// @notice A claim that left an in-scope event out is broken by one proof of that event.
    /// @dev The refuter needs no bond and no permission, and the burn is what the claimant cannot
    ///      get back however they respond.
    function test_oneOmittedEventBreaksTheClaimAndBurnsHalfTheBond() public {
        uint64[] memory all = _heights(3);
        uint64[] memory kept = new uint64[](2);
        kept[0] = all[0];
        kept[1] = all[1];

        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, kept);
        assertEq(registry.enforceableLoss(claimId), BOND / 2, "half the bond is unrecoverable");

        uint256 before = WATCHER.balance;
        vm.prank(WATCHER);
        registry.refute(claimId, _proofAt(all[2], 0), _continuity());

        assertEq(uint8(registry.claim(claimId).status), uint8(UtuhRegistry.Status.Refuted));
        assertEq(WATCHER.balance - before, BOND / 2, "the refuter took half");
        assertEq(registry.burned(), BOND / 2, "and the other half is gone");
        assertEq(registry.enforceableLoss(claimId), 0, "a broken claim guarantees nothing");
    }

    /// @notice An event the claim already holds is not a refutation.
    function test_refutingWithAnEventTheClaimContainsIsRefused() public {
        uint64[] memory at = _heights(3);
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, at);

        uint256 key = EventScope.key(at[1], TX_INDEX, 0);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.EventAlreadyInSet.selector, key));
        vm.prank(WATCHER);
        registry.refute(claimId, _proofAt(at[1], 0), _continuity());
    }

    /// @notice Once the window has closed the claim is settled, whatever anyone can prove.
    function test_refutingAfterTheWindowIsTooLate() public {
        uint64[] memory all = _heights(3);
        uint64[] memory kept = new uint64[](1);
        kept[0] = all[0];
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, kept);

        uint64 until = registry.challengeUntil(claimId);
        vm.roll(until + 1);

        vm.expectRevert(
            abi.encodeWithSelector(UtuhRegistry.ChallengeWindowClosed.selector, uint64(block.number), until)
        );
        vm.prank(WATCHER);
        registry.refute(claimId, _proofAt(all[2], 0), _continuity());
    }

    /// @notice An event outside the claimed range says nothing about the claim.
    function test_refutingWithAnEventOutsideTheRangeIsRefused() public {
        uint64[] memory at = _heights(3);
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, at);

        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.BlockOutOfRange.selector, VOL_TO + 1, VOL_FROM, VOL_TO));
        vm.prank(WATCHER);
        registry.refute(claimId, _proofAt(VOL_TO + 1, 0), _continuity());
    }

    /// @notice Members must arrive in ascending key order, which is what makes membership decidable.
    function test_appendingOutOfOrderIsRefused() public {
        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        uint64[] memory at = _heights(3);

        vm.startPrank(payer);
        registry.appendBatch(claimId, _batch(_one(at[2], 0)), _continuity());
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhRegistry.KeysOutOfOrder.selector,
                EventScope.key(at[2], TX_INDEX, 0),
                EventScope.key(at[0], TX_INDEX, 0)
            )
        );
        registry.appendBatch(claimId, _batch(_one(at[0], 0)), _continuity());
        vm.stopPrank();
    }

    /// @notice A log the scope does not describe cannot be filed under it.
    function test_appendingAnOutOfScopeEventIsRefused() public {
        EventScope.Scope memory other = _volumeScope();
        other.topics[0] = bytes32(uint256(uint160(WATCHER))); // a different subject
        uint256 claimId = _open(other, VOL_FROM, VOL_TO);

        vm.expectRevert(UtuhRegistry.EventOutOfScope.selector);
        vm.prank(payer);
        registry.appendBatch(claimId, _batch(_one(VOL_FROM + 1, 0)), _continuity());
    }

    /// @notice The empty claim — "nothing of this kind happened here" — is a real claim.
    function test_anEmptyClaimFinalizesAndIsWhatCleanMeans() public {
        uint256 claimId = _sealedClaim(_adverseScope(), VOL_FROM, VOL_TO, new uint64[](0));
        _finalize(claimId);

        assertEq(registry.memberCount(claimId), 0);
        assertEq(registry.claim(claimId).aggregate, 0);
        assertTrue(registry.isUsable(claimId, BOND / 2), "usable up to what a liar would lose");
        assertFalse(registry.isUsable(claimId, BOND / 2 + 1), "and no further");
    }

    // ------------------------------------------------------------------
    // Credit, end to end
    // ------------------------------------------------------------------

    /// @notice The published run, reproduced locally: bind, underwrite, draw, prove repayment.
    /// @dev The figures are the ones in the README and the submission. They are computed here from
    ///      the fixture's own amount and the deployed policy, so if either moves this fails.
    function test_aLineIsOpenedDrawnAndSettled() public {
        uint256 lineId = _openLine();

        UtuhCredit.Line memory l = credit.line(lineId);
        assertEq(l.subject, payer);
        assertEq(l.borrower, payer);
        // Volume alone would justify 12 CTC; the bond behind the clean claim caps it at 10.
        assertEq(3 * settledAmount * RATE * 2000 / 10_000, 12 ether, "volume implies 12 CTC");
        assertEq(l.limit, 10 ether, "the guarantee is what lends, not the volume");
        assertEq(l.limit, registry.enforceableLoss(1) * credit.BOND_MULTIPLE(), "capped by the weakest claim");

        credit.fund{value: 10 ether}();
        uint256 before = payer.balance;
        vm.prank(payer);
        uint256 due = credit.draw(lineId, 10 ether);

        assertEq(payer.balance - before, 10 ether, "the borrower was paid");
        assertEq(due, 525_000_000_000_000, "105% of 10 CTC, back in source units");
        assertEq(credit.available(), 0);

        uint256 repayClaim = _repaymentClaim(VOL_TO + 1, VOL_TO + 100);
        credit.settle(lineId, repayClaim);

        assertEq(uint8(credit.line(lineId).status), uint8(UtuhCredit.LineStatus.Settled));
        assertEq(credit.settledThrough(payer), VOL_TO + 101, "the range that discharged it is spent");
    }

    /// @notice One stretch of history opens one line, however many claims are built over it.
    /// @dev Before {underwrittenThrough} both claims below were finalized, unspent and identical,
    ///      and each opened a full line. The bond cap bounded every line and nothing bounded the
    ///      total, so a borrower could repeat this for the price of a bond that comes back.
    function test_theSameHistoryCannotUnderwriteTwice() public {
        uint256 first = _openLine();

        // Give the slot back first, or the one-line-at-a-time guard answers instead and this
        // proves nothing about the history watermark.
        vm.prank(payer);
        credit.closeLine(first);
        assertEq(uint8(credit.line(first).status), uint8(UtuhCredit.LineStatus.Closed));

        uint256 volume2 = _volumeClaim(VOL_FROM, VOL_TO);
        uint256 clean2 = _cleanClaim(VOL_FROM, VOL_TO);

        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.HistoryAlreadyUnderwritten.selector, VOL_FROM, VOL_TO + 1));
        vm.prank(payer);
        credit.openLine(payer, volume2, _ids(clean2));
    }

    /// @notice History earned after the last underwriting opens the next line.
    function test_laterHistoryOpensAnotherLine() public {
        uint256 first = _openLine();
        _drawAndSettle(first);

        uint64 from = VOL_TO + 1;
        uint64 to = from + 200;
        uint256 second = _openLineOver(from, to);

        assertEq(second, 2, "a second line");
        assertEq(credit.underwrittenThrough(payer), to + 1);
    }

    /// @notice A defaulted borrower does not open the next line by pointing at a later month.
    function test_aDefaulterCannotOpenAnotherLine() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);

        vm.roll(credit.line(lineId).dueBlock + 1);
        credit.markDefault(lineId);

        assertEq(uint8(credit.line(lineId).status), uint8(UtuhCredit.LineStatus.Defaulted));
        assertEq(credit.defaultsOf(payer), 1);

        uint64 from = VOL_TO + 1;
        uint64 to = from + 200;
        uint256 volume = _volumeClaim(from, to);
        uint256 clean = _cleanClaim(from, to);

        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.SubjectInDefault.selector, payer, uint64(1)));
        vm.prank(payer);
        credit.openLine(payer, volume, _ids(clean));
    }

    /// @notice One line at a time, per subject.
    function test_aSubjectWithALineOpenCannotOpenAnother() public {
        uint256 first = _openLine();
        _bindPayer();

        uint64 from = VOL_TO + 1;
        uint256 volume = _volumeClaim(from, from + 200);
        uint256 clean = _cleanClaim(from, from + 200);

        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.SubjectHasActiveLine.selector, payer, first));
        vm.prank(payer);
        credit.openLine(payer, volume, _ids(clean));
    }

    /// @notice The hole the slot exists for: a deadline that passed and nobody marked.
    /// @dev {markDefault} is permissionless and unpaid, so `defaultsOf` can sit at zero
    ///      indefinitely after a borrower has walked away. Before this, fresh history was all it
    ///      took to draw a second time.
    function test_anOverdueLineNobodyMarkedStillBlocksTheNextOne() public {
        uint256 first = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(first, 10 ether);

        vm.roll(credit.line(first).dueBlock + 1);
        assertEq(credit.defaultsOf(payer), 0, "nobody has marked it, and nobody is paid to");

        uint64 from = VOL_TO + 1;
        uint256 volume = _volumeClaim(from, from + 200);
        uint256 clean = _cleanClaim(from, from + 200);

        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.SubjectHasActiveLine.selector, payer, first));
        vm.prank(payer);
        credit.openLine(payer, volume, _ids(clean));
    }

    /// @notice An undrawn line can be given back, or the rule above would be a trap.
    function test_anUndrawnLineCanBeClosedAndTheSlotComesBack() public {
        uint256 first = _openLine();

        vm.prank(payer);
        credit.closeLine(first);
        assertEq(uint8(credit.line(first).status), uint8(UtuhCredit.LineStatus.Closed));
        assertEq(credit.activeLineOf(payer), 0);

        uint64 from = VOL_TO + 1;
        uint256 second = _openLineOver(from, from + 200);
        assertEq(second, 2, "the subject can borrow again on later history");
    }

    /// @notice A line with money out of it is not closeable, whatever the borrower would prefer.
    function test_aDrawnLineCannotBeClosed() public {
        uint256 first = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(first, 3 ether);

        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.LineHasBeenDrawn.selector, first, uint256(3 ether)));
        vm.prank(payer);
        credit.closeLine(first);
    }

    function test_onlyTheBorrowerMayCloseTheirLine() public {
        uint256 first = _openLine();
        vm.expectRevert(UtuhCredit.NotBorrower.selector);
        vm.prank(WATCHER);
        credit.closeLine(first);
    }

    // ------------------------------------------------------------------
    // What another lender's books are worth
    // ------------------------------------------------------------------

    /// @notice A default here is a refusal next door, when the lender next door says so.
    /// @dev No reports and no shared registry: the second lender reads `defaultsOf` out of the
    ///      first one's storage, where the contract that actually lent the money recorded it.
    function test_aPeersStandingDefaultIsRefusedHere() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        vm.roll(credit.line(lineId).dueBlock + 1);
        credit.markDefault(lineId);
        assertEq(credit.defaultsOf(payer), 1);

        UtuhCredit next = _lenderWithPeers(_peerList(address(credit)));
        next.proveControl(_controlProof(), _continuity());

        uint64 from = VOL_TO + 1;
        uint256 volume = _volumeClaim(from, from + 200);
        uint256 clean = _cleanClaim(from, from + 200);

        vm.expectRevert(
            abi.encodeWithSelector(UtuhCredit.SubjectInDefaultElsewhere.selector, address(credit), payer, uint64(1))
        );
        vm.prank(payer);
        next.openLine(payer, volume, _ids(clean));
    }

    /// @notice A lender that names no peers is not affected by anyone else's books.
    /// @dev Trusting nobody is the safe default and a real choice, not an oversight.
    function test_aLenderWithNoPeersDoesNotSeeTheDefault() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        vm.roll(credit.line(lineId).dueBlock + 1);
        credit.markDefault(lineId);

        UtuhCredit next = _lenderWithPeers(new address[](0));
        next.proveControl(_controlProof(), _continuity());

        // Built before the prank: `vm.prank` applies to the next call, and evaluating these
        // arguments makes several of their own.
        uint64 from = VOL_TO + 1;
        uint256 volume = _volumeClaim(from, from + 200);
        uint256 clean = _cleanClaim(from, from + 200);

        vm.prank(payer);
        uint256 opened = next.openLine(payer, volume, _ids(clean));
        assertEq(opened, 1, "this lender never asked, so it never heard");
    }

    /// @notice Curing at the first lender clears the refusal at the second.
    function test_curingAtOneLenderClearsTheRefusalAtTheOther() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 10 ether);
        vm.roll(credit.line(lineId).dueBlock + 1);
        credit.markDefault(lineId);

        UtuhCredit next = _lenderWithPeers(_peerList(address(credit)));
        next.proveControl(_controlProof(), _continuity());

        credit.cure(lineId, _repaymentClaim(VOL_TO + 1, VOL_TO + 100));
        assertEq(credit.defaultsOf(payer), 0);

        uint64 from = VOL_TO + 101;
        uint256 volume = _volumeClaim(from, from + 200);
        uint256 clean = _cleanClaim(from, from + 200);

        vm.prank(payer);
        uint256 opened = next.openLine(payer, volume, _ids(clean));
        assertEq(opened, 1, "the record was made good, so the door is open again");
    }

    /// @notice An address with no code answers every question with zero. That is not a peer.
    function test_aPeerThatIsNotAContractIsRefusedAtDeployment() public {
        address notAContract = address(0xDEAD);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.NotAContract.selector, notAContract));
        _lenderWithPeers(_peerList(notAContract));
    }

    function test_thePeerListIsReadable() public {
        UtuhCredit next = _lenderWithPeers(_peerList(address(credit)));
        assertEq(next.peerCount(), 1);
        assertEq(next.peerAt(0), address(credit));
        assertEq(credit.peerCount(), 0);
    }

    /// @notice Proving the repayment late clears the default, on the terms it was owed.
    function test_aDefaultIsCuredByProvingTheRepaymentLate() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        uint256 due = credit.draw(lineId, 10 ether);

        vm.roll(credit.line(lineId).dueBlock + 1);
        credit.markDefault(lineId);

        uint256 repayClaim = _repaymentClaim(VOL_TO + 1, VOL_TO + 100);
        vm.expectEmit(true, false, false, true, address(credit));
        emit UtuhCredit.Cured(lineId, repayClaim, settledAmount, 0);
        credit.cure(lineId, repayClaim);

        assertEq(uint8(credit.line(lineId).status), uint8(UtuhCredit.LineStatus.Settled));
        assertEq(credit.defaultsOf(payer), 0, "the record is clear");
        assertGe(settledAmount, due, "the cure proved at least what was owed");

        // And the subject can borrow again, on history it has not already spent.
        uint64 from = VOL_TO + 101;
        _openLineOver(from, from + 200);
    }

    /// @notice A cure is not a discount. Everything settle demands, cure demands.
    function test_curingWithTooLittleIsRefused() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 10 ether);

        vm.roll(credit.line(lineId).dueBlock + 1);
        credit.markDefault(lineId);

        // A repayment claim carrying no payments at all.
        uint256 empty = _sealedClaim(_repayScope(), VOL_TO + 1, VOL_TO + 100, new uint64[](0));
        _finalize(empty);

        vm.expectRevert(
            abi.encodeWithSelector(UtuhCredit.RepaymentShort.selector, uint256(0), uint256(525_000_000_000_000))
        );
        credit.cure(lineId, empty);
    }

    /// @notice Curing a line that never defaulted is a status answer, not a second settlement.
    function test_curingALineThatIsNotInDefaultIsRefused() public {
        uint256 lineId = _openLine();
        uint256 repayClaim = _repaymentClaim(VOL_TO + 1, VOL_TO + 100);

        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhCredit.WrongLineStatus.selector, UtuhCredit.LineStatus.Defaulted, UtuhCredit.LineStatus.Active
            )
        );
        credit.cure(lineId, repayClaim);
    }

    /// @notice One payment cannot discharge two debts, cured or settled.
    /// @dev The watermark is what refuses it, before the spent-claim check ever runs: settling
    ///      consumed the range the payment sits in, so the next line has to prove money from
    ///      after it. `claimSpent` is the second lock on the same door — reachable for an
    ///      underwriting claim, and, as this shows, never reached by a repayment.
    function test_aCuredRepaymentClaimCannotBeSpentAgain() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        vm.roll(credit.line(lineId).dueBlock + 1);
        credit.markDefault(lineId);

        uint256 repayClaim = _repaymentClaim(VOL_TO + 1, VOL_TO + 100);
        credit.cure(lineId, repayClaim);

        uint64 from = VOL_TO + 101;
        uint256 second = _openLineOver(from, from + 200);
        vm.prank(payer);
        credit.draw(second, 1 ether);

        // The second line will not look at a payment older than its own underwriting either, and
        // that bound is the later of the two here.
        uint64 required = credit.line(second).repayFrom;
        assertGt(required, credit.settledThrough(payer), "the newer underwriting is the binding one");

        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.RepaymentAlreadyCounted.selector, VOL_TO + 1, required));
        credit.settle(second, repayClaim);
    }

    /// @notice Binding an address is the proof that someone holds the key that wrote the history.
    function test_controlIsBoundFromTheProvenTransaction() public {
        // A fresh credit, so the binding is the one this test makes.
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        UtuhCredit fresh = new UtuhCredit(registry, _policy(), _paymentSpec(), clean, _paymentSpec());

        assertEq(fresh.controllerOf(payer), address(0));
        (address subject, address account) = fresh.proveControl(_controlProof(), _continuity());

        assertEq(subject, payer, "the sender of the commitment");
        assertEq(fresh.controllerOf(subject), account, "and the account it named");

        bytes32 controlId = fresh.controlIdOf(SEPOLIA, control);
        assertTrue(fresh.controlProofUsed(controlId));

        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.ControlProofAlreadyUsed.selector, controlId));
        fresh.proveControl(_controlProof(), _continuity());
    }

    // ------------------------------------------------------------------
    // Building blocks
    // ------------------------------------------------------------------

    function _policy() internal pure returns (UtuhCredit.Policy memory) {
        return UtuhCredit.Policy({
            volumeUnitInCtc: RATE,
            minUnderwritingWindow: WINDOW,
            minHistoryBlocks: 100,
            maxStalenessBlocks: 5_000,
            repaymentBps: 10_500,
            repayWindowBlocks: 400,
            peers: new address[](0)
        });
    }

    /// A payment from the subject to the payee the fixture actually names.
    function _paymentSpec() internal view returns (UtuhCredit.HistorySpec memory s) {
        s.chainKey = SEPOLIA;
        s.emitter = ledger;
        s.eventSig = settledSig;
        s.subjectTopic = 1;
        s.counterpartyTopic = 2;
        s.counterparty = payee;
        s.metric = EventScope.Metric.DATA_WORD;
        s.metricArg = 0;
    }

    /// The adverse class a clean claim asserts the absence of — the ledger's other event.
    function _adverseSpec() internal view returns (UtuhCredit.HistorySpec memory s) {
        s.chainKey = SEPOLIA;
        s.emitter = ledger;
        s.eventSig = keccak256("Adverse(address,uint256)");
        s.subjectTopic = 1;
        s.counterpartyTopic = 0;
        s.counterparty = address(0);
        s.metric = EventScope.Metric.COUNT;
        s.metricArg = 0;
    }

    function _volumeScope() internal view returns (EventScope.Scope memory) {
        return credit.expectedScope(_paymentSpec(), payer);
    }

    function _repayScope() internal view returns (EventScope.Scope memory) {
        return credit.expectedScope(_paymentSpec(), payer);
    }

    function _adverseScope() internal view returns (EventScope.Scope memory) {
        return credit.expectedScope(_adverseSpec(), payer);
    }

    function _heights(uint256 n) internal pure returns (uint64[] memory at) {
        at = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            at[i] = VOL_FROM + uint64(10 * (i + 1));
        }
    }

    function _open(EventScope.Scope memory scope, uint64 from, uint64 to) internal returns (uint256 claimId) {
        vm.prank(payer);
        claimId = registry.open{value: BOND}(scope, from, to, WINDOW);
    }

    /// Open, append one proof per height, and seal.
    function _sealedClaim(EventScope.Scope memory scope, uint64 from, uint64 to, uint64[] memory at)
        internal
        returns (uint256 claimId)
    {
        claimId = _open(scope, from, to);
        vm.startPrank(payer);
        for (uint256 i = 0; i < at.length; i++) {
            registry.appendBatch(claimId, _batch(_one(at[i], 0)), _continuity());
        }
        registry.seal(claimId);
        vm.stopPrank();
    }

    function _finalize(uint256 claimId) internal {
        vm.roll(registry.challengeUntil(claimId) + 1);
        registry.finalize(claimId);
    }

    function _volumeClaim(uint64 from, uint64 to) internal returns (uint256 claimId) {
        uint64[] memory at = new uint64[](3);
        for (uint256 i = 0; i < 3; i++) {
            at[i] = from + uint64(10 * (i + 1));
        }
        claimId = _sealedClaim(_volumeScope(), from, to, at);
        _finalize(claimId);
    }

    function _cleanClaim(uint64 from, uint64 to) internal returns (uint256 claimId) {
        claimId = _sealedClaim(_adverseScope(), from, to, new uint64[](0));
        _finalize(claimId);
    }

    function _repaymentClaim(uint64 from, uint64 to) internal returns (uint256 claimId) {
        uint64[] memory at = new uint64[](1);
        at[0] = from + 1;
        claimId = _sealedClaim(_repayScope(), from, to, at);
        _finalize(claimId);
    }

    function _bindPayer() internal {
        if (credit.controllerOf(payer) == payer) return;
        credit.proveControl(_controlProof(), _continuity());
    }

    function _openLine() internal returns (uint256 lineId) {
        return _openLineOver(VOL_FROM, VOL_TO);
    }

    function _openLineOver(uint64 from, uint64 to) internal returns (uint256 lineId) {
        _bindPayer();
        uint256 volume = _volumeClaim(from, to);
        uint256 clean = _cleanClaim(from, to);
        vm.prank(payer);
        lineId = credit.openLine(payer, volume, _ids(clean));
    }

    function _drawAndSettle(uint256 lineId) internal {
        credit.fund{value: 1 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        credit.settle(lineId, _repaymentClaim(VOL_TO + 1, VOL_TO + 100));
    }

    function _peerList(address one) internal pure returns (address[] memory peers) {
        peers = new address[](1);
        peers[0] = one;
    }

    /// A second lender over the same registry, with the same terms and its own books.
    function _lenderWithPeers(address[] memory peers) internal returns (UtuhCredit) {
        UtuhCredit.Policy memory p = _policy();
        p.peers = peers;
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        return new UtuhCredit(registry, p, _paymentSpec(), clean, _paymentSpec());
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = a;
    }

    function _one(uint64 height, uint32 logIndex) internal view returns (UtuhRegistry.EventProof memory p) {
        p.blockHeight = height;
        p.encodedTransaction = settlement;
        p.merkleRoot = keccak256(abi.encode(height));
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
        p.logIndex = logIndex;
    }

    function _proofAt(uint64 height, uint32 logIndex) internal view returns (UtuhRegistry.EventProof memory) {
        return _one(height, logIndex);
    }

    function _batch(UtuhRegistry.EventProof memory p) internal pure returns (UtuhRegistry.EventProof[] memory ps) {
        ps = new UtuhRegistry.EventProof[](1);
        ps[0] = p;
    }

    function _continuity() internal pure returns (IBlockProver.ContinuityProof memory c) {
        c.lowerEndpointDigest = bytes32(uint256(1));
        c.roots = new bytes32[](1);
        c.roots[0] = bytes32(uint256(2));
    }

    function _controlProof() internal view returns (UtuhCredit.ControlProof memory p) {
        p.chainKey = SEPOLIA;
        p.blockHeight = VOL_FROM;
        p.encodedTransaction = control;
        p.merkleRoot = keccak256("control");
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
    }

    // ------------------------------------------------------------------
    // The two substituted answers
    // ------------------------------------------------------------------

    function _mockChainInfo(uint64 frontier) internal {
        vm.mockCall(CHAIN_INFO, abi.encodeWithSelector(IChainInfo.is_height_attested.selector), abi.encode(true));
        vm.mockCall(
            CHAIN_INFO,
            abi.encodeWithSelector(IChainInfo.get_attestation_genesis_height.selector),
            abi.encode(uint64(0))
        );
        vm.mockCall(
            CHAIN_INFO,
            abi.encodeWithSelector(IChainInfo.get_latest_attestation_height_and_hash.selector),
            abi.encode(
                IChainInfo.HeightHashResult({height: frontier, hash: bytes32(0), isAttestation: true, exists: true})
            )
        );
    }

    function _mockProver() internal {
        vm.mockCall(PROVER, abi.encodeWithSelector(VERIFY_ONE), abi.encode(true));
        vm.mockCall(PROVER, abi.encodeWithSelector(VERIFY_BATCH), abi.encode(true));
        vm.mockCall(
            PROVER, abi.encodeWithSelector(IBlockProver.calculateTxIndex.selector), abi.encode(uint64(TX_INDEX))
        );
    }
}
