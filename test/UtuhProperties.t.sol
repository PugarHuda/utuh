// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {UtuhCredit} from "../src/UtuhCredit.sol";
import {UtuhProperties} from "./medusa/UtuhProperties.sol";

/// @notice The medusa property harness, run by forge as well.
///
/// @dev medusa is not in CI, so its four properties would otherwise be checked only when someone
///      remembers to run a campaign. Here they are forge invariants over the same moves, on every
///      `forge test`. And `test_everyMoveLands` is what says the harness is not vacuous: a walk
///      whose moves all revert passes every property while testing nothing.
contract UtuhPropertiesTest is Test {
    UtuhProperties internal h;
    UtuhRegistry internal registry;
    UtuhCredit internal credit;
    address internal payer;

    function setUp() public {
        h = new UtuhProperties();
        registry = h.REGISTRY();
        credit = h.CREDIT();
        payer = h.PAYER();
        targetContract(address(h));
    }

    function invariant_bondsAreConserved() public view {
        assertTrue(h.property_bondsAreConserved(), "a wei is neither escrowed, credited, burned nor available");
    }

    function invariant_noLineExceedsTenTimesEnforceableLoss() public view {
        assertTrue(h.property_noLineExceedsTenTimesEnforceableLoss(), "a line outruns the loss behind it");
    }

    function invariant_noRefutedClaimBacksALine() public view {
        assertTrue(h.property_noRefutedClaimBacksALine(), "a line rests on a claim that is not Finalized");
    }

    function invariant_watermarksOnlyAdvance() public view {
        assertTrue(h.property_watermarksOnlyAdvance(), "a watermark moved back");
    }

    function test_everyMoveLands() public {
        h.fund(uint96(5 ether));
        assertEq(credit.available(), 5 ether + 1, "fund did not land");

        // A line, drawn, defaulted and cured.
        h.underwrite(0, 1 ether, 1 ether, 0);
        assertEq(credit.activeLineOf(payer), 1, "underwrite did not open a line");
        h.draw(uint96(1 ether));
        assertGt(credit.line(1).drawn, 0, "draw did not land");
        h.roll(50);
        h.markDefault(0);
        assertEq(uint8(credit.line(1).status), uint8(UtuhCredit.LineStatus.Defaulted), "markDefault did not land");
        h.repay(0, true, 0);
        assertEq(uint8(credit.line(1).status), uint8(UtuhCredit.LineStatus.Settled), "cure did not land");

        // A second, drawn and settled on time.
        h.underwrite(0, 1 ether, 1 ether, 2);
        assertEq(credit.activeLineOf(payer), 2, "a second line after the cure");
        h.draw(uint96(1 ether));
        h.repay(1, false, 0);
        assertEq(uint8(credit.line(2).status), uint8(UtuhCredit.LineStatus.Settled), "settle did not land");

        // A third, given back undrawn.
        h.underwrite(0, 1 ether, 1 ether, 0);
        h.closeLine(2);
        assertEq(uint8(credit.line(3).status), uint8(UtuhCredit.LineStatus.Closed), "closeLine did not land");

        // Over fresh history: a clean claim refuted by the watcher, and a volume claim finalized.
        h.open(0, true, 7, 1, 0, 9);
        uint256 clean = registry.nextClaimId() - 1;
        h.open(0, false, 7, 1, 0, 9);
        uint256 volume = clean + 1;
        h.append(volume - 1, 1, 0);
        assertEq(registry.memberCount(volume), 1, "append did not land");
        h.seal(clean - 1);
        h.seal(volume - 1);
        h.refute(1, clean - 1, 5);
        assertEq(uint8(registry.claim(clean).status), uint8(UtuhRegistry.Status.Refuted), "refute did not land");
        h.finalize(volume - 1, 39);
        assertEq(uint8(registry.claim(volume).status), uint8(UtuhRegistry.Status.Finalized), "finalize did not land");

        // The refuted claim is offered, and refused.
        h.openLine(volume - 1, clean - 1);
        assertEq(credit.nextLineId(), 4, "a refuted clean claim opened a line");

        // An abandoned claim, a collected refund, and liquidity taken back.
        h.open(1, false, 0, 0, 0, 0);
        uint256 dropped = registry.nextClaimId() - 1;
        h.abandon(dropped - 1);
        assertEq(uint8(registry.claim(dropped).status), uint8(UtuhRegistry.Status.None), "abandon did not land");
        assertGt(registry.withdrawable(payer), 0);
        h.withdrawBond(0);
        assertEq(registry.withdrawable(payer), 0, "withdrawBond did not land");
        uint256 before = credit.available();
        h.withdrawLiquidity(uint96(1 ether));
        assertEq(credit.available(), before - 1 ether - 1, "withdrawLiquidity did not land");

        assertTrue(h.property_bondsAreConserved());
        assertTrue(h.property_noLineExceedsTenTimesEnforceableLoss());
        assertTrue(h.property_noRefutedClaimBacksALine());
        assertTrue(h.property_watermarksOnlyAdvance());
    }
}
