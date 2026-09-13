// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {UtuhCredit} from "../src/UtuhCredit.sol";
import {EventScope} from "../src/lib/EventScope.sol";
import {IChainInfo} from "../src/interfaces/IChainInfo.sol";
import {LifecycleFixture} from "./support/LifecycleFixture.sol";

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
contract LifecycleTest is LifecycleFixture {
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

    /// @notice A claim opened and never sealed can be withdrawn, and its bond comes straight back.
    /// @dev This is the recovery path for a build that died between `open` and `seal`. Nothing
    ///      downstream can have relied on an unsealed claim, so there is nothing to wait for.
    function test_anOpenClaimCanBeAbandonedAndTheBondComesBack() public {
        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        vm.prank(payer);
        registry.appendBatch(claimId, _batch(_one(VOL_FROM + 10, 0)), _continuity());

        uint256 before = payer.balance;
        vm.prank(payer);
        registry.abandon(claimId);

        assertEq(payer.balance - before, BOND, "the whole bond, immediately");
        assertEq(uint8(registry.claim(claimId).status), uint8(UtuhRegistry.Status.None));
        assertEq(registry.enforceableLoss(claimId), 0, "an abandoned claim guarantees nothing");

        // And it cannot be sealed, finalized or refuted afterwards — it is gone.
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhRegistry.WrongStatus.selector, UtuhRegistry.Status.Open, UtuhRegistry.Status.None
            )
        );
        vm.prank(payer);
        registry.seal(claimId);
    }

    /// @notice A sealed claim cannot be abandoned: the moment it is published, it can be relied on.
    function test_aSealedClaimCannotBeAbandoned() public {
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, _heights(1));
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhRegistry.WrongStatus.selector, UtuhRegistry.Status.Open, UtuhRegistry.Status.Sealed
            )
        );
        vm.prank(payer);
        registry.abandon(claimId);
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
    // The registry's own refusals
    // ------------------------------------------------------------------
    //
    // Same story as the credit guards above: `forge coverage` had the registry at 60% of branches,
    // and the missing ones were the refusals — including both places where the Block Prover says
    // no, which is the answer the whole design rests on and the one no local test had ever seen.
    //
    // Every scope is built before its prank. `_volumeScope` is an external call into the credit
    // contract, so evaluating it inside a pranked call's arguments spends the prank on it and the
    // test then measures the wrong caller.

    /// @notice A range the network has not attested cannot be claimed over.
    /// @dev Every other test here runs with `is_height_attested` answering true, because that is
    ///      what it answers for a range in the past. This is the refusal that makes a challenge
    ///      window mean something: without it a claim could run its whole window over data nobody
    ///      was yet able to prove anything about.
    function test_openRefusesAnUnattestedRange() public {
        EventScope.Scope memory scope = _volumeScope();
        vm.mockCall(CHAIN_INFO, abi.encodeWithSelector(IChainInfo.is_height_attested.selector), abi.encode(false));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.RangeNotAttested.selector, SEPOLIA, VOL_TO));
        registry.open{value: BOND}(scope, VOL_FROM, VOL_TO, WINDOW);
        _mockChainInfo(FRONTIER);
    }

    /// @notice Nor one that starts before the attestation data does.
    function test_openRefusesARangeBeforeGenesis() public {
        EventScope.Scope memory scope = _volumeScope();
        uint64 genesis = 500;
        vm.mockCall(
            CHAIN_INFO, abi.encodeWithSelector(IChainInfo.get_attestation_genesis_height.selector), abi.encode(genesis)
        );
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.RangeBeforeGenesis.selector, uint64(100), genesis));
        registry.open{value: BOND}(scope, 100, VOL_TO, WINDOW);
        _mockChainInfo(FRONTIER);
    }

    /// @notice The batch cap is the precompile's, and the registry refuses past it rather than
    ///         spending the gas to be told.
    function test_appendRefusesABatchOverTheCap() public {
        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        uint256 tooMany = registry.MAX_BATCH() + 1;
        UtuhRegistry.EventProof[] memory ps = new UtuhRegistry.EventProof[](tooMany);
        for (uint256 i = 0; i < tooMany; i++) {
            ps[i] = _one(VOL_FROM + uint64(10 * (i + 1)), 0);
        }
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.BatchTooLarge.selector, tooMany));
        registry.appendBatch(claimId, ps, _continuity());
    }

    /// @notice A batch the Block Prover will not verify appends nothing.
    function test_appendRefusesWhatTheProverRejects() public {
        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        UtuhRegistry.EventProof[] memory ps = _batch(_one(VOL_FROM + 10, 0));
        vm.mockCall(PROVER, abi.encodeWithSelector(VERIFY_BATCH), abi.encode(false));
        vm.prank(payer);
        vm.expectRevert(UtuhRegistry.ProofRejected.selector);
        registry.appendBatch(claimId, ps, _continuity());
        _mockProver();
    }

    /// @notice And a refutation the prover will not verify breaks nothing.
    /// @dev This is the asymmetry that makes the whole mechanism safe to open to strangers: a
    ///      fabricated refutation is not a risk to be managed, it simply fails to prove and costs
    ///      the sender their gas.
    function test_refutingWithAProofTheProverRejectsIsRefused() public {
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, _heights(2));
        UtuhRegistry.EventProof memory p = _one(VOL_FROM + 30, 0);
        vm.mockCall(PROVER, abi.encodeWithSelector(VERIFY_ONE), abi.encode(false));
        vm.prank(WATCHER);
        vm.expectRevert(UtuhRegistry.ProofRejected.selector);
        registry.refute(claimId, p, _continuity());
        _mockProver();
    }

    /// @notice A log index the receipt does not have is a refusal, not a read of whatever is there.
    function test_appendRefusesALogIndexPastTheEndOfTheReceipt() public {
        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        uint256 logCount = EvmV1Decoder.decodeReceiptFields(settlement).receiptLogs.length;
        UtuhRegistry.EventProof[] memory ps = _batch(_one(VOL_FROM + 10, uint32(logCount)));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.LogIndexOutOfRange.selector, uint32(logCount), logCount));
        registry.appendBatch(claimId, ps, _continuity());
    }

    /// @notice A transaction that reverted on the source chain is still in its block, and proves
    ///         nothing.
    /// @dev The fixture is a real Ethereum mainnet transaction that failed — block 25,926,178,
    ///      index 96, receipt status 0 — with its bytes taken from the hosted Proof Builder, the
    ///      same service a claimant uses. The Block Prover attests inclusion and says so in its own
    ///      documentation; every consumer has to read the status itself, and the ones that do not
    ///      pay out against transactions that did nothing.
    function test_appendRefusesATransactionThatRevertedOnTheSourceChain() public {
        bytes memory reverted = vm.parseJsonBytes(vm.readFile("test/fixtures/encodedTransactions.json"), ".reverted");
        assertEq(EvmV1Decoder.decodeReceiptFields(reverted).receiptStatus, 0, "the fixture is a failed transaction");

        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        UtuhRegistry.EventProof memory p = _one(VOL_FROM + 10, 0);
        p.encodedTransaction = reverted;
        UtuhRegistry.EventProof[] memory ps = _batch(p);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.TransactionFailedOnSource.selector, uint8(0)));
        registry.appendBatch(claimId, ps, _continuity());
    }

    /// @notice Finalizing before the window closes is refused, whoever asks.
    function test_finalizeRefusesAnOpenChallengeWindow() public {
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, _heights(1));
        uint64 until = registry.challengeUntil(claimId);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.ChallengeWindowOpen.selector, uint64(block.number), until));
        registry.finalize(claimId);
    }

    // ------------------------------------------------------------------
    // The guards on the way in
    // ------------------------------------------------------------------
    //
    // `forge coverage` put UtuhCredit's branches at 49%: lines and functions were near-total, and
    // half the *decisions* were never taken. Almost all of the missing ones were here, on the
    // function that turns two claims into money — and none of them was reachable from the live
    // suite either, so ten refusals that decide whether a liquidated borrower gets a credit line
    // had no test anywhere. Each one below trips exactly one guard, in the order `openLine`
    // actually checks them.

    /// @notice A lender listing one adverse class will not open a line on zero assertions about it.
    function test_openLineRefusesTheWrongNumberOfCleanClaims() public {
        _bindPayer();
        uint256 volume = _volumeClaim(VOL_FROM, VOL_TO);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.WrongNumberOfCleanClaims.selector, uint256(0), uint256(1)));
        credit.openLine(payer, volume, new uint256[](0));
    }

    /// @notice A volume claim whose challenge window is shorter than this lender demands.
    /// @dev The registry's floor and this lender's happen to be the same number, so the refusal
    ///      needs a lender that asks for more than the registry's minimum — which is the whole
    ///      point of the policy field: a lender may be stricter than the registry, never looser.
    function test_openLineRefusesAVolumeClaimWithTooShortAWindow() public {
        UtuhCredit strict = _strictLender(WINDOW * 2);
        _bindOn(strict);
        uint256 volume = _volumeClaim(VOL_FROM, VOL_TO);
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.WindowTooShort.selector, WINDOW, WINDOW * 2));
        strict.openLine(payer, volume, _ids(clean));
    }

    /// @notice And the same floor applies to the clean claim, which is checked separately.
    function test_openLineRefusesACleanClaimWithTooShortAWindow() public {
        UtuhCredit strict = _strictLender(WINDOW * 2);
        _bindOn(strict);
        uint256 volume = _sealedClaimWithWindow(_volumeScope(), VOL_FROM, VOL_TO, _heights(3), WINDOW * 2);
        _finalize(volume);
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.WindowTooShort.selector, WINDOW, WINDOW * 2));
        strict.openLine(payer, volume, _ids(clean));
    }

    /// @notice A history too short to say anything about a borrower.
    function test_openLineRefusesTooLittleHistory() public {
        uint64 to = VOL_FROM + 50;
        _bindPayer();
        uint256 volume = _volumeClaim(VOL_FROM, to);
        uint256 clean = _cleanClaim(VOL_FROM, to);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.HistoryTooShort.selector, uint64(50), uint64(100)));
        credit.openLine(payer, volume, _ids(clean));
    }

    /// @notice A history that ended too long ago to still describe the borrower.
    /// @dev The claims are built while the frontier is where it was; the chain then moves past this
    ///      lender's staleness bound before the line is asked for. Nothing about the claims changed
    ///      — only how old they are, which is the whole idea.
    function test_openLineRefusesStaleUnderwriting() public {
        _bindPayer();
        uint256 volume = _volumeClaim(VOL_FROM, VOL_TO);
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO);
        uint64 far = VOL_TO + 5_001;
        _mockChainInfo(far);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.UnderwritingStale.selector, VOL_TO, far));
        credit.openLine(payer, volume, _ids(clean));
    }

    /// @notice A clean claim over a different range than the volume it is paired with.
    /// @dev This is the attack the range check exists for: a long history of repayments beside a
    ///      short, quiet window asserted clean. Both claims are honest on their own.
    function test_openLineRefusesACleanClaimOverAnotherRange() public {
        _bindPayer();
        uint256 volume = _volumeClaim(VOL_FROM, VOL_TO);
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO + 10);
        vm.prank(payer);
        vm.expectRevert(UtuhCredit.RangeMismatch.selector);
        credit.openLine(payer, volume, _ids(clean));
    }

    /// @notice A clean claim that is not clean.
    /// @dev The fixture only carries settlement logs, so this uses a lender whose adverse class is
    ///      that same event: the claim then holds three real, proven members and asserts absence
    ///      anyway. Membership is counted rather than summed, so this fires whatever the metric.
    function test_openLineRefusesACleanClaimThatHoldsEvents() public {
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _paymentSpec();
        UtuhCredit odd = new UtuhCredit(registry, _policy(), _paymentSpec(), clean, _paymentSpec());
        _bindOn(odd);

        uint256 volume = _volumeClaim(VOL_FROM, VOL_TO);
        uint256 notClean = _volumeClaim(VOL_FROM, VOL_TO);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.NotClean.selector, uint256(3)));
        odd.openLine(payer, volume, _ids(notClean));
    }

    /// @notice One underwriting funds one line, even after the first is given back.
    function test_openLineRefusesToSpendAClaimTwice() public {
        _bindPayer();
        uint256 volume = _volumeClaim(VOL_FROM, VOL_TO);
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO);
        vm.prank(payer);
        uint256 lineId = credit.openLine(payer, volume, _ids(clean));
        vm.prank(payer);
        credit.closeLine(lineId);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.ClaimAlreadySpent.selector, volume));
        credit.openLine(payer, volume, _ids(clean));
    }

    /// @notice A claim about something else, offered as the volume history.
    function test_openLineRefusesAClaimWithTheWrongScope() public {
        _bindPayer();
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO);
        uint256 other = _cleanClaim(VOL_FROM, VOL_TO);
        bytes32 want = EventScope.id(credit.expectedScope(_paymentSpec(), payer));
        bytes32 got = EventScope.id(credit.expectedScope(_adverseSpec(), payer));
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.ScopeMismatch.selector, want, got));
        credit.openLine(payer, clean, _ids(other));
    }

    /// @notice A claim still inside its challenge window is not yet worth anything.
    function test_openLineRefusesAClaimThatIsNotFinalized() public {
        _bindPayer();
        uint256 volume = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, _heights(3));
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO);
        // Worked out before the prank: `backingFor` is an external call, and it would otherwise be
        // the call the prank applied to — leaving `openLine` to run as this contract and fail on
        // control instead of on the guard under test.
        uint256 cap = registry.enforceableLoss(clean) * credit.BOND_MULTIPLE();
        uint256 uncapped = _limitFor(3);
        uint256 backing = credit.backingFor(uncapped < cap ? uncapped : cap);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.ClaimNotUsable.selector, volume, backing));
        credit.openLine(payer, volume, _ids(clean));
    }

    /// @notice A control proof the Block Prover refuses binds nothing.
    /// @dev Every other test here runs with the prover answering true, which is the answer the
    ///      live chain gives for a real proof. This is the other one, and it is the only thing
    ///      standing between "I can read this history" and "this history is mine".
    function test_proveControlRefusesAProofTheProverRejects() public {
        vm.mockCall(PROVER, abi.encodeWithSelector(VERIFY_ONE), abi.encode(false));
        vm.expectRevert(UtuhCredit.ProofRejected.selector);
        credit.proveControl(_controlProof(), _continuity());
        _mockProver();
    }
}
