// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {UtuhCredit} from "../src/UtuhCredit.sol";
import {EventScope} from "../src/lib/EventScope.sol";
import {IBlockProver} from "../src/interfaces/IBlockProver.sol";
import {LifecycleFixture} from "./support/LifecycleFixture.sol";

/// @notice The refusals and the adversarial paths that had no test, found by reading the coverage
///         report branch by branch and the contracts guard by guard.
///
/// @dev `forge coverage` had UtuhCredit at 67.80% of branches and the registry at 82.86%. Every
///      zero-hit branch is below, each made to fire by exactly the input it guards against, plus
///      the paths a reviewer asks about first: reentrancy on every path that sends CTC, the lower
///      half of the membership binary search, the exact block at which a window closes, a proof
///      from the wrong chain, and the same finalized claim offered to two lenders.
contract AuditTest is LifecycleFixture {
    // ------------------------------------------------------------------
    // Registry: appendBatch
    // ------------------------------------------------------------------

    /// @notice Once sealed, a claim takes no more members. The set is what was published.
    function test_appendingToASealedClaimIsRefused() public {
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, _heights(1));
        UtuhRegistry.EventProof[] memory ps = _batch(_one(VOL_FROM + 20, 0));
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhRegistry.WrongStatus.selector, UtuhRegistry.Status.Open, UtuhRegistry.Status.Sealed
            )
        );
        vm.prank(payer);
        registry.appendBatch(claimId, ps, _continuity());
    }

    function test_anEmptyBatchIsRefused() public {
        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        vm.expectRevert(UtuhRegistry.EmptyBatch.selector);
        vm.prank(payer);
        registry.appendBatch(claimId, new UtuhRegistry.EventProof[](0), _continuity());
    }

    /// @notice A proof from outside the claimed range is refused before the prover is asked.
    function test_appendingAnEventOutsideTheRangeIsRefused() public {
        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        UtuhRegistry.EventProof[] memory ps = _batch(_one(VOL_TO + 1, 0));
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.BlockOutOfRange.selector, VOL_TO + 1, VOL_FROM, VOL_TO));
        vm.prank(payer);
        registry.appendBatch(claimId, ps, _continuity());
    }

    /// @notice A transaction type the decoder does not know is refused, not decoded as something else.
    /// @dev The type is byte 31 of the first word. The fixture is type 2; this is the same bytes
    ///      with that one byte set to 5, which is one past what EvmV1Decoder supports.
    function test_appendingAnUnsupportedTransactionTypeIsRefused() public {
        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        UtuhRegistry.EventProof memory p = _one(VOL_FROM + 10, 0);
        p.encodedTransaction = _withTxType(settlement, 5);
        UtuhRegistry.EventProof[] memory ps = _batch(p);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.UnsupportedTransactionType.selector, uint8(5)));
        vm.prank(payer);
        registry.appendBatch(claimId, ps, _continuity());
    }

    /// @notice The same key twice in one batch is refused by the ordering guard, so a claim can
    ///         never hold a member twice however the batch is arranged.
    function test_theSameEventTwiceInOneBatchIsRefused() public {
        uint256 claimId = _open(_volumeScope(), VOL_FROM, VOL_TO);
        UtuhRegistry.EventProof[] memory ps = new UtuhRegistry.EventProof[](2);
        ps[0] = _one(VOL_FROM + 10, 0);
        ps[1] = _one(VOL_FROM + 10, 0);
        uint256 k = EventScope.key(VOL_FROM + 10, TX_INDEX, 0);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.KeysOutOfOrder.selector, k, k));
        vm.prank(payer);
        registry.appendBatch(claimId, ps, _continuity());
    }

    // ------------------------------------------------------------------
    // Registry: refute, the lower half of the search
    // ------------------------------------------------------------------

    /// @notice Every earlier refutation test hit a member on the first probe or walked right. This
    ///         omits the *earliest* event, so the search has to walk left past every member and
    ///         come back empty — the `hi = mid` branch that no test had taken.
    function test_omittingTheEarliestEventIsRefutedToo() public {
        uint64[] memory all = _heights(3);
        uint64[] memory kept = new uint64[](2);
        kept[0] = all[1];
        kept[1] = all[2];
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, kept);

        assertFalse(registry.contains(claimId, EventScope.key(all[0], TX_INDEX, 0)));
        vm.prank(WATCHER);
        registry.refute(claimId, _proofAt(all[0], 0), _continuity());
        assertEq(uint8(registry.claim(claimId).status), uint8(UtuhRegistry.Status.Refuted));
    }

    /// @notice And an event in the gap between two members.
    function test_omittingAnEventBetweenTwoMembersIsRefuted() public {
        uint64[] memory all = _heights(3);
        uint64[] memory kept = new uint64[](2);
        kept[0] = all[0];
        kept[1] = all[2];
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, kept);

        vm.prank(WATCHER);
        registry.refute(claimId, _proofAt(all[1], 0), _continuity());
        assertEq(uint8(registry.claim(claimId).status), uint8(UtuhRegistry.Status.Refuted));
    }

    /// @notice The binary search agrees with a linear scan on every member and every gap.
    function testFuzz_containsAgreesWithALinearScan(uint8 count, uint64 probeOffset) public {
        uint256 n = 1 + (count % 8);
        uint64[] memory at = new uint64[](n);
        for (uint256 i = 0; i < n; i++) {
            at[i] = VOL_FROM + uint64(3 * (i + 1));
        }
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, at);

        uint64 probe = VOL_FROM + (probeOffset % 30);
        uint256 k = EventScope.key(probe, TX_INDEX, 0);
        bool linear;
        for (uint256 i = 0; i < n; i++) {
            if (registry.keyAt(claimId, i) == k) linear = true;
        }
        assertEq(registry.contains(claimId, k), linear, "binary search disagrees with a scan");
    }

    // ------------------------------------------------------------------
    // Registry: the exact block a window closes
    // ------------------------------------------------------------------

    /// @notice At `challengeUntil` itself the claim can still be refuted and not yet finalized;
    ///         one block later, the reverse. No height allows both, and none allows neither.
    function test_theWindowBoundaryIsExclusiveToExactlyOneSide() public {
        uint64[] memory all = _heights(3);
        uint64[] memory kept = new uint64[](1);
        kept[0] = all[0];
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, kept);
        uint64 until = registry.challengeUntil(claimId);

        vm.roll(until);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.ChallengeWindowOpen.selector, until, until));
        registry.finalize(claimId);

        // Still refutable on the last block. Snapshot so the same claim can then be finalized.
        uint256 snap = vm.snapshotState();
        vm.prank(WATCHER);
        registry.refute(claimId, _proofAt(all[2], 0), _continuity());
        assertEq(uint8(registry.claim(claimId).status), uint8(UtuhRegistry.Status.Refuted));
        vm.revertToState(snap);

        vm.roll(until + 1);
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.ChallengeWindowClosed.selector, until + 1, until));
        vm.prank(WATCHER);
        registry.refute(claimId, _proofAt(all[2], 0), _continuity());
        registry.finalize(claimId);
        assertEq(uint8(registry.claim(claimId).status), uint8(UtuhRegistry.Status.Finalized));
    }

    // ------------------------------------------------------------------
    // Registry: every path that sends CTC
    // ------------------------------------------------------------------

    /// @notice A refuter that reenters gets the state it already changed: the second call finds
    ///         the claim Refuted, and exactly one reward leaves the contract.
    function test_aReenteringRefuterIsPaidOnce() public {
        uint64[] memory all = _heights(3);
        uint64[] memory kept = new uint64[](1);
        kept[0] = all[0];
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, kept);

        ReenteringRefuter r = new ReenteringRefuter(registry, claimId, all[2], settlement, _continuity());
        uint256 registryBefore = address(registry).balance;
        r.attack();

        assertEq(r.entries(), 1, "the reentrant call went through");
        assertEq(address(r).balance, BOND / 2, "paid exactly the refuter's share");
        assertEq(registryBefore - address(registry).balance, BOND / 2);
        assertEq(registry.burned(), BOND / 2);
        assertTrue(r.innerReverted(), "the inner refute did not revert");
    }

    /// @notice A claimant that reenters `withdraw` finds nothing left to withdraw.
    function test_aReenteringWithdrawerIsPaidOnce() public {
        ReenteringClaimant c = new ReenteringClaimant(registry);
        vm.deal(address(c), 10 ether);
        uint256 claimId = c.openAndSeal(_volumeScope(), VOL_FROM, VOL_TO, WINDOW, BOND);
        _finalize(claimId);
        assertEq(registry.withdrawable(address(c)), BOND);

        c.withdraw();
        assertEq(address(c).balance, 10 ether, "the bond came back exactly once");
        assertEq(registry.withdrawable(address(c)), 0);
        assertTrue(c.innerReverted(), "the inner withdraw did not revert");
    }

    /// @notice A refuter that cannot take ether cannot refute; nothing is slashed.
    function test_aRefuterThatCannotReceiveBreaksNothing() public {
        uint64[] memory all = _heights(3);
        uint64[] memory kept = new uint64[](1);
        kept[0] = all[0];
        uint256 claimId = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, kept);

        RefuserThatCannotReceive r = new RefuserThatCannotReceive();
        vm.expectRevert(UtuhRegistry.TransferFailed.selector);
        vm.prank(address(r));
        registry.refute(claimId, _proofAt(all[2], 0), _continuity());
        assertEq(uint8(registry.claim(claimId).status), uint8(UtuhRegistry.Status.Sealed));
        assertEq(registry.burned(), 0);
    }

    // ------------------------------------------------------------------
    // Credit: draw
    // ------------------------------------------------------------------

    function test_drawRefusesAStranger() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.expectRevert(UtuhCredit.NotBorrower.selector);
        vm.prank(WATCHER);
        credit.draw(lineId, 1 ether);
    }

    function test_drawRefusesAClosedLine() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.closeLine(lineId);
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhCredit.WrongLineStatus.selector, UtuhCredit.LineStatus.Active, UtuhCredit.LineStatus.Closed
            )
        );
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
    }

    function test_drawRefusesNothing() public {
        uint256 lineId = _openLine();
        vm.expectRevert(UtuhCredit.NoCredit.selector);
        vm.prank(payer);
        credit.draw(lineId, 0);
    }

    function test_drawRefusesMoreThanTheLimit() public {
        uint256 lineId = _openLine();
        credit.fund{value: 20 ether}();
        uint256 limit = credit.line(lineId).limit;
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.ExceedsLimit.selector, limit, limit - 1 ether));
        vm.prank(payer);
        credit.draw(lineId, limit);
    }

    function test_drawRefusesMoreThanTheLenderFunded() public {
        uint256 lineId = _openLine();
        credit.fund{value: 1 ether}();
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.InsufficientLiquidity.selector, 2 ether, 1 ether));
        vm.prank(payer);
        credit.draw(lineId, 2 ether);
    }

    /// @notice The deadline is set by the first draw and later draws leave it alone.
    function test_aSecondDrawDoesNotMoveTheDeadline() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        uint64 due = credit.line(lineId).dueBlock;
        vm.roll(block.number + 100);
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        assertEq(credit.line(lineId).dueBlock, due, "the deadline moved");
    }

    /// @notice A borrower that reenters `draw` from the payout can take more, never past the limit.
    function test_aReenteringBorrowerCannotDrawPastTheLimit() public {
        ReenteringBorrower b = new ReenteringBorrower();
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        // A lender whose control binding names the reentering contract as the account.
        UtuhCredit lender = new UtuhCredit(registry, _policy(), _paymentSpec(), clean, _paymentSpec());
        b.setLender(lender);
        _rebindTo(lender, payer, address(b));

        uint256 volume = _volumeClaim(VOL_FROM, VOL_TO);
        uint256 cln = _cleanClaim(VOL_FROM, VOL_TO);
        uint256 lineId = b.openLine(payer, volume, _ids(cln));
        uint256 limit = lender.line(lineId).limit;
        lender.fund{value: limit * 2}();

        b.draw(lineId, limit);
        assertEq(lender.line(lineId).drawn, limit, "drew past the limit");
        assertEq(address(b).balance, limit);
        assertTrue(b.innerReverted(), "the inner draw was not refused");
    }

    // ------------------------------------------------------------------
    // Credit: settle, cure, close, default
    // ------------------------------------------------------------------

    function test_settlingASettledLineIsRefused() public {
        uint256 lineId = _openLine();
        _drawAndSettle(lineId);
        uint256 again = _repaymentClaim(VOL_TO + 101, VOL_TO + 200);
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhCredit.WrongLineStatus.selector, UtuhCredit.LineStatus.Active, UtuhCredit.LineStatus.Settled
            )
        );
        credit.settle(lineId, again);
    }

    /// @notice Past the deadline, settle is closed and the only way back is markDefault then cure.
    function test_settlingPastDueIsRefused() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        uint256 repay = _repaymentClaim(VOL_TO + 1, VOL_TO + 100);
        uint64 due = credit.line(lineId).dueBlock;
        vm.roll(due + 1);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.PastDue.selector, due + 1, due));
        credit.settle(lineId, repay);
    }

    /// @notice On the due block itself the line can be settled and not yet defaulted; one block
    ///         later, the reverse.
    function test_theDueBoundaryIsExclusiveToExactlyOneSide() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        uint256 repay = _repaymentClaim(VOL_TO + 1, VOL_TO + 100);
        uint64 due = credit.line(lineId).dueBlock;

        vm.roll(due);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.NotYetDue.selector, due, due));
        credit.markDefault(lineId);
        uint256 snap = vm.snapshotState();
        credit.settle(lineId, repay);
        assertEq(uint8(credit.line(lineId).status), uint8(UtuhCredit.LineStatus.Settled));
        vm.revertToState(snap);

        vm.roll(due + 1);
        credit.markDefault(lineId);
        assertEq(uint8(credit.line(lineId).status), uint8(UtuhCredit.LineStatus.Defaulted));
    }

    /// @notice A claim about the wrong event cannot settle a line, however much it proves.
    /// @notice A claim one subject spent underwriting their own line cannot also repay another's.
    /// @dev The spent-claim check in `_applyRepayment` sits behind the watermark, and for a single
    ///      subject the watermark always fires first: a claim spent opening a line starts before
    ///      that line's `repayFrom`, and no second line opens while one still owes. So no test ever
    ///      reached it, and gambit could delete it unnoticed.
    ///
    ///      It is reachable across subjects when a lender's volume and repayment specs mirror each
    ///      other — volume counts payments from D to the subject, repayment counts payments from the
    ///      subject to C. C's volume scope and D's repayment scope are then one scope, and the claim
    ///      C spent underwriting their line clears D's watermark. Only `claimSpent` stands between
    ///      that claim and discharging D's debt as well.
    ///
    ///      D is the fixture's payer and C its payee. D's own volume is payments to themselves, which
    ///      the fixture does not carry, so D's claim uses the fixture transaction with its recipient
    ///      topic set to the payer: the same log, decoded by the same decoder.
    function test_aClaimSpentByOneSubjectCannotRepayAnother() public {
        UtuhCredit.HistorySpec memory volume = _paymentSpec();
        volume.subjectTopic = 2;
        volume.counterpartyTopic = 1;
        volume.counterparty = payer;
        UtuhCredit.HistorySpec memory repay = _paymentSpec();
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        UtuhCredit lender = new UtuhCredit(registry, _policy(), volume, clean, repay);
        assertEq(
            EventScope.id(lender.expectedScope(volume, payee)),
            EventScope.id(lender.expectedScope(repay, payer)),
            "the payee's volume and the payer's repayment are one scope"
        );

        bytes memory selfPay = _withRecipient(settlement, payer);
        bytes32[] memory topics = EvmV1Decoder.decodeReceiptFields(selfPay).receiptLogs[0].topics;
        assertEq(topics[1], bytes32(uint256(uint160(payer))));
        assertEq(topics[2], bytes32(uint256(uint160(payer))), "the patch did not land on the recipient");

        // D borrows on payments to themselves, and draws.
        _bindOn(lender);
        uint256 dVolume = _finalizedWith(lender.expectedScope(volume, payer), VOL_FROM, VOL_TO, selfPay);
        uint256 dClean = _cleanOn(lender, payer, VOL_FROM, VOL_TO);
        vm.prank(payer);
        uint256 dLine = lender.openLine(payer, dVolume, _ids(dClean));
        lender.fund{value: 1 ether}();
        vm.prank(payer);
        lender.draw(dLine, 1 ether);

        // C borrows on the fixture's payments to them, over history that starts after D's.
        _rebindTo(lender, payee, payee);
        uint64 from = VOL_TO + 1;
        uint256 cVolume = _finalizedWith(lender.expectedScope(volume, payee), from, from + 200, settlement);
        uint256 cClean = _cleanOn(lender, payee, from, from + 200);
        vm.prank(payee);
        lender.openLine(payee, cVolume, _ids(cClean));
        assertTrue(lender.claimSpent(cVolume));

        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.ClaimAlreadySpent.selector, cVolume));
        lender.settle(dLine, cVolume);

        // The same payments, proven in a claim nobody has spent, do settle it.
        uint256 unspent = _finalizedWith(lender.expectedScope(repay, payer), from, from + 200, settlement);
        lender.settle(dLine, unspent);
        assertEq(uint8(lender.line(dLine).status), uint8(UtuhCredit.LineStatus.Settled));
    }

    function test_settlingWithAClaimOfAnotherScopeIsRefused() public {
        uint256 lineId = _openLine();
        credit.fund{value: 10 ether}();
        vm.prank(payer);
        credit.draw(lineId, 1 ether);
        // A finalized claim carrying the adverse scope rather than the repayment one.
        uint256 other = _cleanClaim(VOL_TO + 1, VOL_TO + 100);
        bytes32 want = credit.line(lineId).repayScopeId;
        bytes32 got = EventScope.id(_adverseScope());
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.ScopeMismatch.selector, want, got));
        credit.settle(lineId, other);
    }

    function test_closingAClosedLineIsRefused() public {
        uint256 lineId = _openLine();
        vm.prank(payer);
        credit.closeLine(lineId);
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhCredit.WrongLineStatus.selector, UtuhCredit.LineStatus.Active, UtuhCredit.LineStatus.Closed
            )
        );
        vm.prank(payer);
        credit.closeLine(lineId);
    }

    function test_markDefaultRefusesASettledLine() public {
        uint256 lineId = _openLine();
        _drawAndSettle(lineId);
        vm.roll(block.number + 1000);
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhCredit.WrongLineStatus.selector, UtuhCredit.LineStatus.Active, UtuhCredit.LineStatus.Settled
            )
        );
        credit.markDefault(lineId);
    }

    /// @notice No money went out, so nothing was missed. An undrawn line cannot default.
    function test_markDefaultRefusesAnUndrawnLine() public {
        uint256 lineId = _openLine();
        vm.roll(block.number + 1000);
        vm.expectRevert(UtuhCredit.NoCredit.selector);
        credit.markDefault(lineId);
    }

    // ------------------------------------------------------------------
    // Credit: openLine and the constructor
    // ------------------------------------------------------------------

    /// @notice A volume claim that proves nothing underwrites nothing.
    function test_openLineRefusesAVolumeClaimWithNoVolume() public {
        _bindPayer();
        uint256 empty = _sealedClaim(_volumeScope(), VOL_FROM, VOL_TO, new uint64[](0));
        _finalize(empty);
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO);
        vm.expectRevert(UtuhCredit.NoCredit.selector);
        vm.prank(payer);
        credit.openLine(payer, empty, _ids(clean));
    }

    /// @notice A claim about the same emitter, event and subject on a *different chain* is a
    ///         different scope. CC3 numbers Sepolia 1 and Ethereum mainnet 3; a Sepolia history
    ///         cannot underwrite a lender that reads mainnet.
    function test_openLineRefusesAClaimFromAnotherChain() public {
        _bindPayer();
        EventScope.Scope memory mainnet = _volumeScope();
        mainnet.chainKey = 3;
        uint256 claimId = _open(mainnet, VOL_FROM, VOL_TO);
        vm.prank(payer);
        registry.seal(claimId);
        _finalize(claimId);
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO);

        bytes32 want = EventScope.id(_volumeScope());
        bytes32 got = EventScope.id(mainnet);
        assertTrue(want != got, "chain key is not part of the scope identity");
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.ScopeMismatch.selector, want, got));
        vm.prank(payer);
        credit.openLine(payer, claimId, _ids(clean));
    }

    /// @notice A peer that reverts when asked blocks every line at this lender.
    /// @dev Peers are immutable and chosen by the lender, and a UtuhCredit peer's `defaultsOf` is
    ///      a mapping read that cannot revert. This pins what naming anything else would cost.
    function test_aPeerThatRevertsBlocksEveryLine() public {
        RevertingPeer peer = new RevertingPeer();
        UtuhCredit lender = _lenderWithPeers(_peerList(address(peer)));
        _bindOn(lender);
        uint256 volume = _volumeClaim(VOL_FROM, VOL_TO);
        uint256 clean = _cleanClaim(VOL_FROM, VOL_TO);
        vm.expectRevert("no books today");
        vm.prank(payer);
        lender.openLine(payer, volume, _ids(clean));
    }

    /// @notice `claimSpent` and `underwrittenThrough` are per lender. The same finalized pair
    ///         opens a full line at every UtuhCredit deployment that accepts it, and the bond
    ///         behind the clean claim is the same one bond each time.
    /// @dev Not a bug in either contract in isolation — each lender caps its own line at
    ///      BOND_MULTIPLE times the enforceable loss — but the aggregate exposure across lenders on
    ///      one bond is N times that, while a liar loses the burned half once. README's known
    ///      limits should say so; this is the test that keeps that sentence true.
    function test_oneClaimPairUnderwritesALineAtEveryLender() public {
        uint256 first = _openLine();
        UtuhCredit second = _lenderWithPeers(new address[](0));
        _bindOn(second);

        UtuhCredit.Line memory l1 = credit.line(first);
        uint256 volume = 1;
        uint256 clean = 2;
        assertTrue(credit.claimSpent(volume) && credit.claimSpent(clean), "the first lender spent them");
        assertFalse(second.claimSpent(volume) || second.claimSpent(clean), "the second has not");

        vm.prank(payer);
        uint256 lineId = second.openLine(payer, volume, _ids(clean));
        assertEq(second.line(lineId).limit, l1.limit, "the same claims, the same limit, twice");
        assertEq(registry.enforceableLoss(clean) * credit.BOND_MULTIPLE(), l1.limit);
    }

    /// @notice A lender can deploy a repayment window shorter than the registry's own challenge
    ///         floor, and every draw on such a line defaults: a repayment claim needs at least
    ///         MIN_CHALLENGE_WINDOW blocks after sealing before it can be finalized.
    /// @dev Lender policy, visible on-chain before anyone draws, and the constructor does not
    ///      refuse it. Pinned so the policy gap is a stated one.
    function test_aRepayWindowShorterThanTheChallengeFloorCannotBeMet() public {
        UtuhCredit.Policy memory p = _policy();
        p.repayWindowBlocks = registry.MIN_CHALLENGE_WINDOW() - 1;
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        UtuhCredit harsh = new UtuhCredit(registry, p, _paymentSpec(), clean, _paymentSpec());
        _bindOn(harsh);

        uint256 volume = _volumeClaim(VOL_FROM, VOL_TO);
        uint256 cln = _cleanClaim(VOL_FROM, VOL_TO);
        vm.prank(payer);
        uint256 lineId = harsh.openLine(payer, volume, _ids(cln));
        harsh.fund{value: 1 ether}();
        vm.prank(payer);
        harsh.draw(lineId, 1 ether);
        uint64 due = harsh.line(lineId).dueBlock;

        // The fastest possible repayment claim, sealed the same block, finalizes after the due block.
        uint64[] memory at = new uint64[](1);
        at[0] = VOL_TO + 2;
        uint256 repay = _sealedClaim(_repayScope(), VOL_TO + 1, VOL_TO + 100, at);
        assertGt(registry.challengeUntil(repay) + 1, due, "a repayment could have been finalized in time");
    }

    function test_constructorRefusesZeroHistoryOrZeroStaleness() public {
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();
        UtuhCredit.Policy memory p = _policy();
        p.minHistoryBlocks = 0;
        vm.expectRevert(UtuhCredit.NoCredit.selector);
        new UtuhCredit(registry, p, _paymentSpec(), clean, _paymentSpec());

        p = _policy();
        p.maxStalenessBlocks = 0;
        vm.expectRevert(UtuhCredit.NoCredit.selector);
        new UtuhCredit(registry, p, _paymentSpec(), clean, _paymentSpec());
    }

    function test_constructorRefusesTopicsOutsideOneToThree() public {
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _adverseSpec();

        UtuhCredit.HistorySpec memory bad = _paymentSpec();
        bad.subjectTopic = 0;
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.BadSubjectTopic.selector, uint8(0)));
        new UtuhCredit(registry, _policy(), bad, clean, _paymentSpec());

        bad = _paymentSpec();
        bad.subjectTopic = 4;
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.BadSubjectTopic.selector, uint8(4)));
        new UtuhCredit(registry, _policy(), bad, clean, _paymentSpec());

        bad = _paymentSpec();
        bad.counterpartyTopic = 4;
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.BadSubjectTopic.selector, uint8(4)));
        new UtuhCredit(registry, _policy(), bad, clean, _paymentSpec());
    }

    // ------------------------------------------------------------------
    // Credit: proveControl
    // ------------------------------------------------------------------

    /// @notice A commitment in a transaction that reverted on the source chain binds nothing.
    function test_aRevertedControlTransactionBindsNothing() public {
        bytes memory reverted = vm.parseJsonBytes(vm.readFile("test/fixtures/encodedTransactions.json"), ".reverted");
        UtuhCredit.ControlProof memory p = _controlProof();
        p.encodedTransaction = reverted;
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.TransactionFailedOnSource.selector, uint8(0)));
        credit.proveControl(p, _continuity());
    }

    function test_anUnsupportedControlTransactionTypeBindsNothing() public {
        UtuhCredit.ControlProof memory p = _controlProof();
        p.encodedTransaction = _withTxType(control, 5);
        vm.expectRevert(abi.encodeWithSelector(UtuhCredit.UnsupportedTransactionType.selector, uint8(5)));
        credit.proveControl(p, _continuity());
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev The same encoded transaction with its type byte, byte 31 of the first word, replaced.
    function _withTxType(bytes memory encoded, uint8 txType) internal pure returns (bytes memory out) {
        out = bytes.concat(encoded);
        out[31] = bytes1(txType);
    }

    /// @dev Bind the fixture's payer to `account` at `lender`. The control fixture names the payer
    ///      itself, so a different account means writing the mapping the way the proof would have.
    ///      The slot is the one a read of `controllerOf(payer)` touches, not an assumed layout.
    function _rebindTo(UtuhCredit lender, address subject, address account) internal {
        vm.record();
        lender.controllerOf(subject);
        (bytes32[] memory reads,) = vm.accesses(address(lender));
        vm.store(address(lender), reads[0], bytes32(uint256(uint160(account))));
        assertEq(lender.controllerOf(subject), account, "the binding did not land");
    }

    /// @dev The fixture settlement with its recipient topic replaced. Word 39 of the encoding is
    ///      `topics[2]` of the receipt's first log; the caller decodes the result to confirm it.
    function _withRecipient(bytes memory encoded, address to) internal pure returns (bytes memory out) {
        out = bytes.concat(encoded);
        bytes32 word = bytes32(uint256(uint160(to)));
        for (uint256 i = 0; i < 32; i++) {
            out[39 * 32 + i] = word[i];
        }
    }

    /// @dev A finalized claim of three members, each proven from `encoded`.
    function _finalizedWith(EventScope.Scope memory scope, uint64 from, uint64 to, bytes memory encoded)
        internal
        returns (uint256 claimId)
    {
        claimId = _open(scope, from, to);
        vm.startPrank(payer);
        for (uint64 i = 1; i <= 3; i++) {
            UtuhRegistry.EventProof memory p = _one(from + 10 * i, 0);
            p.encodedTransaction = encoded;
            registry.appendBatch(claimId, _batch(p), _continuity());
        }
        registry.seal(claimId);
        vm.stopPrank();
        _finalize(claimId);
    }

    /// @dev A finalized empty claim over `lender`'s adverse class for `subject`.
    function _cleanOn(UtuhCredit lender, address subject, uint64 from, uint64 to) internal returns (uint256 claimId) {
        claimId = _sealedClaim(lender.expectedScope(_adverseSpec(), subject), from, to, new uint64[](0));
        _finalize(claimId);
    }
}

/// @dev Refutes, and tries again from inside the payout.
contract ReenteringRefuter {
    UtuhRegistry internal immutable REGISTRY;
    uint256 internal immutable CLAIM;
    uint64 internal immutable HEIGHT;
    bytes internal encoded;
    IBlockProver.ContinuityProof internal continuity;
    uint256 public entries;
    bool public innerReverted;

    constructor(
        UtuhRegistry registry,
        uint256 claimId,
        uint64 height,
        bytes memory encodedTransaction,
        IBlockProver.ContinuityProof memory c
    ) {
        REGISTRY = registry;
        CLAIM = claimId;
        HEIGHT = height;
        encoded = encodedTransaction;
        continuity = c;
    }

    function _proof() internal view returns (UtuhRegistry.EventProof memory p) {
        p.blockHeight = HEIGHT;
        p.encodedTransaction = encoded;
        p.merkleRoot = keccak256(abi.encode(HEIGHT));
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
    }

    function attack() external {
        REGISTRY.refute(CLAIM, _proof(), continuity);
    }

    receive() external payable {
        entries++;
        if (entries == 1) {
            try REGISTRY.refute(CLAIM, _proof(), continuity) {}
            catch {
                innerReverted = true;
            }
        }
    }
}

/// @dev Opens and seals a claim, then withdraws the refund and tries again from inside the payout.
contract ReenteringClaimant {
    UtuhRegistry internal immutable REGISTRY;
    bool public innerReverted;
    bool internal inside;

    constructor(UtuhRegistry registry) {
        REGISTRY = registry;
    }

    function openAndSeal(EventScope.Scope memory scope, uint64 from, uint64 to, uint64 window, uint256 bond)
        external
        returns (uint256 claimId)
    {
        claimId = REGISTRY.open{value: bond}(scope, from, to, window);
        REGISTRY.seal(claimId);
    }

    function withdraw() external {
        REGISTRY.withdraw();
    }

    receive() external payable {
        if (!inside) {
            inside = true;
            try REGISTRY.withdraw() {}
            catch {
                innerReverted = true;
            }
        }
    }
}

/// @dev Draws, and draws again from inside the payout.
contract ReenteringBorrower {
    UtuhCredit internal lender;
    uint256 internal lineId;
    uint256 internal again;
    bool public innerReverted;
    bool internal inside;

    function setLender(UtuhCredit l) external {
        lender = l;
    }

    function openLine(address subject, uint256 volume, uint256[] memory clean) external returns (uint256) {
        return lender.openLine(subject, volume, clean);
    }

    function draw(uint256 id, uint256 amount) external {
        lineId = id;
        again = amount;
        lender.draw(id, amount);
    }

    receive() external payable {
        if (!inside) {
            inside = true;
            try lender.draw(lineId, again) {}
            catch {
                innerReverted = true;
            }
        }
    }
}

contract RefuserThatCannotReceive {
    receive() external payable {
        revert("no");
    }
}

contract RevertingPeer {
    function defaultsOf(address) external pure returns (uint64) {
        revert("no books today");
    }
}
