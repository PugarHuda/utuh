// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {SettlementLedger} from "../src/source/SettlementLedger.sol";

/// @notice A payee that refuses ether, which is a thing real payees do.
/// @dev Not a stand-in for anything under test — the ledger is the contract being tested, and this
///      is the counterparty behaviour it has to handle. A payee whose fallback reverts must not
///      leave a `Settled` event standing for a payment that never landed.
contract RefusesEther {
    receive() external payable {
        revert("no");
    }
}

/// @notice Tests for the source-chain contract the Sepolia demonstration pays through.
/// @dev It emits the logs a claim is built from, so what it will and will not record is part of
///      Utuh's trust boundary rather than a detail of a demo.
contract SettlementLedgerTest is Test {
    SettlementLedger internal ledger;

    address constant PAYER = address(0xA11CE);
    address constant PAYEE = address(0xB0B);

    event Settled(address indexed payer, address indexed payee, uint256 amount);
    event Adverse(address indexed subject, uint256 amount);

    function setUp() public {
        ledger = new SettlementLedger();
        vm.deal(PAYER, 100 ether);
    }

    function test_settleForwardsEverythingAndKeepsNothing() public {
        vm.prank(PAYER);
        ledger.settle{value: 1 ether}(PAYEE);

        assertEq(PAYEE.balance, 1 ether, "payee was not paid");
        assertEq(address(ledger).balance, 0, "the ledger kept value it should have forwarded");
    }

    function test_settleRecordsThePayment() public {
        vm.expectEmit(true, true, false, true, address(ledger));
        emit Settled(PAYER, PAYEE, 0.5 ether);
        vm.prank(PAYER);
        ledger.settle{value: 0.5 ether}(PAYEE);
    }

    /// A call to the zero address succeeds and burns the value, so without an explicit guard the
    /// ledger would stand behind a `Settled` event for ether nobody received. A lender whose
    /// HistorySpec leaves the counterparty unpinned would be counting burns as proven volume.
    function test_theZeroAddressIsNotAPayee() public {
        vm.prank(PAYER);
        vm.expectRevert(SettlementLedger.NoPayee.selector);
        ledger.settle{value: 1 ether}(address(0));
    }

    function test_aSettlementOfNothingIsNotASettlement() public {
        vm.prank(PAYER);
        vm.expectRevert(SettlementLedger.NothingToSettle.selector);
        ledger.settle{value: 0}(PAYEE);
    }

    /// The event must not outlive the transfer. If the payee refuses, the whole call reverts and
    /// no log survives for a claim to be built on.
    function test_aRefusedPaymentLeavesNoRecord() public {
        RefusesEther payee = new RefusesEther();
        vm.prank(PAYER);
        vm.expectRevert(SettlementLedger.PaymentFailed.selector);
        ledger.settle{value: 1 ether}(address(payee));
        assertEq(PAYER.balance, 100 ether, "the payer's ether did not come back");
    }

    function testFuzz_thePayeeReceivesExactlyWhatWasSent(uint96 amount, address payee) public {
        vm.assume(amount > 0);
        vm.assume(payee != address(0) && payee.code.length == 0);
        vm.assume(payee != PAYER && payee != address(this) && payee != address(ledger));
        // Precompiles are not ordinary accounts: some refuse value outright, which would fail this
        // for a reason that has nothing to do with the ledger. forge-std knows the full set.
        assumeNotPrecompile(payee);
        assumePayable(payee);

        uint256 before = payee.balance;
        vm.deal(PAYER, amount);
        vm.prank(PAYER);
        ledger.settle{value: amount}(payee);

        assertEq(payee.balance - before, amount, "the amount recorded is not the amount delivered");
        assertEq(address(ledger).balance, 0, "value stuck in the ledger");
    }

    function test_adverseIsUnpermissionedAndRecordsTheSubject() public {
        vm.expectEmit(true, false, false, true, address(ledger));
        emit Adverse(PAYEE, 7);
        vm.prank(address(0xDEAD));
        ledger.recordAdverse(PAYEE, 7);
    }
}
