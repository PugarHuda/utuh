// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UtuhRegistry} from "utuh/UtuhRegistry.sol";
import {EventScope} from "utuh/lib/EventScope.sol";
import {NeverLiquidatedGate, IControllerOf} from "../src/NeverLiquidatedGate.sol";

/// @dev Returns whatever claim a test sets, and answers enforceableLoss and isUsable with the
///      registry formulas, so the gate is tested against the rules it meets on-chain.
contract MockRegistry {
    mapping(uint256 => UtuhRegistry.Claim) internal _claims;
    mapping(uint256 => uint256) public memberCount;

    function set(uint256 id, UtuhRegistry.Claim memory c, uint256 members) external {
        _claims[id] = c;
        memberCount[id] = members;
    }

    function claim(uint256 id) external view returns (UtuhRegistry.Claim memory) {
        return _claims[id];
    }

    function enforceableLoss(uint256 id) public view returns (uint256) {
        UtuhRegistry.Claim storage c = _claims[id];
        if (c.status != UtuhRegistry.Status.Sealed && c.status != UtuhRegistry.Status.Finalized) return 0;
        return c.bondPosted / 2;
    }

    function isUsable(uint256 id, uint256 exposure) external view returns (bool) {
        return _claims[id].status == UtuhRegistry.Status.Finalized && enforceableLoss(id) >= exposure;
    }
}

contract MockControl is IControllerOf {
    mapping(address => address) public controllerOf;

    function bind(address subject, address account) external {
        controllerOf[subject] = account;
    }
}

contract NeverLiquidatedGateTest is Test {
    uint64 constant HISTORY = 216_000;
    uint256 constant ID = 7;

    MockRegistry registry;
    MockControl control;
    NeverLiquidatedGate gate;

    address subject = makeAddr("subject");
    address account = makeAddr("account");

    function setUp() public {
        registry = new MockRegistry();
        control = new MockControl();
        gate = new NeverLiquidatedGate(UtuhRegistry(address(registry)), control, HISTORY);
        control.bind(subject, account);
        registry.set(ID, _clean(subject), 0);
    }

    function _clean(address who) internal view returns (UtuhRegistry.Claim memory c) {
        c.claimant = address(0xC1A1);
        c.status = UtuhRegistry.Status.Finalized;
        c.fromBlock = 25_756_480;
        c.toBlock = 25_756_480 + HISTORY;
        c.challengeWindow = 25;
        c.bondPosted = 1 ether; // enforceableLoss 0.5 ether
        c.scope = gate.expectedScope(who);
    }

    function _grant(uint256 amount) internal {
        vm.prank(account);
        gate.grant(ID, amount);
    }

    function _expectWrongScope(UtuhRegistry.Claim memory c) internal {
        registry.set(ID, c, 0);
        vm.expectPartialRevert(NeverLiquidatedGate.WrongScope.selector);
        _grant(0.1 ether);
    }

    // --- the one way in ---------------------------------------------------------------------

    function test_grantsOnAFinalizedCleanClaimToTheBoundAccount() public {
        vm.expectEmit(address(gate));
        emit NeverLiquidatedGate.AllowanceGranted(account, subject, ID, 0.5 ether);
        vm.prank(account);
        address s = gate.grant(ID, 0.5 ether);

        assertEq(s, subject);
        assertEq(gate.allowanceOf(account), 0.5 ether);
        assertTrue(gate.claimUsed(ID));
    }

    function testFuzz_anyAmountUpToTheEnforceableLossIsGranted(uint256 amount) public {
        amount = bound(amount, 0, 0.5 ether);
        _grant(amount);
        assertEq(gate.allowanceOf(account), amount);
    }

    // --- every refusal ----------------------------------------------------------------------

    function test_refusesAClaimThatDoesNotExist() public {
        UtuhRegistry.Claim memory none;
        _expectWrongScope(none);
    }

    function test_refusesAnotherChain() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.scope.chainKey = 1;
        _expectWrongScope(c);
    }

    function test_refusesAnotherEmitter() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.scope.emitter = address(0xBAD);
        _expectWrongScope(c);
    }

    function test_refusesAnotherEvent() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.scope.eventSig = keccak256("Supply(address,address,address,uint256,uint16)");
        _expectWrongScope(c);
    }

    function test_refusesTheSubjectUnmasked() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.scope.topicMask = 2; // the user sits in topics[2] but the mask checks topics[1] instead
        _expectWrongScope(c);
    }

    function test_refusesAnExtraPinnedTopic() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.scope.topics[0] = bytes32(uint256(uint160(address(0xC0FFEE)))); // one collateral asset only
        c.scope.topicMask = 5;
        _expectWrongScope(c);
    }

    function test_refusesADataWordMetric() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.scope.metric = EventScope.Metric.DATA_WORD;
        _expectWrongScope(c);
    }

    function test_refusesDirtyBitsAboveTheAddress() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.scope.topics[2] = bytes32(uint256(uint160(subject)) | (uint256(1) << 200));
        _expectWrongScope(c);
    }

    function test_refusesHistoryShorterThanTheMinimum() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.toBlock = c.fromBlock + HISTORY - 1;
        registry.set(ID, c, 0);
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.HistoryTooShort.selector, HISTORY - 1, HISTORY));
        _grant(0.1 ether);
    }

    function test_refusesAClaimWithALiquidationInIt() public {
        registry.set(ID, _clean(subject), 1);
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.NotClean.selector, ID, 1));
        _grant(0.1 ether);
    }

    function test_refusesAClaimStillInItsWindow() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.status = UtuhRegistry.Status.Sealed;
        registry.set(ID, c, 0);
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.NotUsable.selector, ID, 0.1 ether, 0.5 ether));
        _grant(0.1 ether);
    }

    function test_refusesARefutedClaim() public {
        UtuhRegistry.Claim memory c = _clean(subject);
        c.status = UtuhRegistry.Status.Refuted;
        registry.set(ID, c, 0);
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.NotUsable.selector, ID, 0.1 ether, 0));
        _grant(0.1 ether);
    }

    function test_refusesAnAmountAboveTheEnforceableLoss() public {
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.NotUsable.selector, ID, 0.5 ether + 1, 0.5 ether));
        _grant(0.5 ether + 1);
    }

    function test_refusesSomeoneElsesCleanClaim() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.NotController.selector, subject, stranger));
        vm.prank(stranger);
        gate.grant(ID, 0.1 ether);
    }

    function test_refusesTheSubjectItselfWhenBoundElsewhere() public {
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.NotController.selector, subject, subject));
        vm.prank(subject);
        gate.grant(ID, 0.1 ether);
    }

    function test_refusesAnUnboundSubject() public {
        address loner = makeAddr("loner");
        registry.set(ID, _clean(loner), 0);
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.NotController.selector, loner, loner));
        vm.prank(loner);
        gate.grant(ID, 0.1 ether);
    }

    function test_refusesTheSameClaimTwice() public {
        _grant(0.2 ether);
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.ClaimAlreadyUsed.selector, ID));
        _grant(0.2 ether);
    }

    function test_aSecondClaimReplacesTheAllowanceRatherThanStacking() public {
        _grant(0.5 ether);
        registry.set(ID + 1, _clean(subject), 0);
        vm.prank(account);
        gate.grant(ID + 1, 0.3 ether);
        assertEq(gate.allowanceOf(account), 0.3 ether);
    }
}
