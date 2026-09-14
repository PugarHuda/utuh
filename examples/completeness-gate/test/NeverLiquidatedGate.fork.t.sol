// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UtuhRegistry} from "utuh/UtuhRegistry.sol";
import {NeverLiquidatedGate, IControllerOf} from "../src/NeverLiquidatedGate.sol";

/// @notice The gate against the live mainnet-sourced registry on CC3 Testnet. Every read here is a
///         plain view (no precompile runs), so a fork answers exactly what the chain does.
/// @dev Needs network: `forge test --match-contract Fork`. Offline: `--no-match-contract Fork`.
contract NeverLiquidatedGateForkTest is Test {
    UtuhRegistry constant REGISTRY = UtuhRegistry(0x8FA0BD5301D998Be873E31453E53d114929a5Fac);
    /// Sepolia-sourced UtuhCredit, where the borrower proved control with a Block Prover proof.
    IControllerOf constant CONTROL = IControllerOf(0x0177aDb82152c8673a85271F7F06336B820324b6);
    NeverLiquidatedGate constant DEPLOYED = NeverLiquidatedGate(0xcA6228C30607F26253Fffc2A4013a801DEEB5D09);

    address constant BORROWER = 0x01a802C650ccceF077208A93c1cF43025239003f;
    uint256 constant CLEAN = 72; // borrower, never liquidated over 216,000 mainnet blocks, Finalized
    uint256 constant REFUTED = 20; // a false never-liquidated claim, broken by one proof
    uint256 constant STRANGER = 18; // Finalized and clean, but about an address nobody here controls
    uint256 constant SUPPLY = 69; // Finalized, but an Aave Supply scope, not LiquidationCall

    NeverLiquidatedGate gate;

    function setUp() public {
        vm.createSelectFork("cc3");
        // CC3 headers carry no prevrandao, and the EVM refuses a post-merge block without one.
        vm.prevrandao(bytes32(uint256(1)));
        gate = new NeverLiquidatedGate(REGISTRY, CONTROL, 216_000);
    }

    function test_fork_theDeployedGateIsThisCode() public view {
        assertEq(address(DEPLOYED).code, address(gate).code);
    }

    function test_fork_theBoundBorrowerIsGrantedOnARealFinalizedClaim() public {
        assertEq(CONTROL.controllerOf(BORROWER), BORROWER);
        assertTrue(REGISTRY.isUsable(CLEAN, 0.5 ether));

        vm.prank(BORROWER);
        assertEq(gate.grant(CLEAN, 0.5 ether), BORROWER);
        assertEq(gate.allowanceOf(BORROWER), 0.5 ether);
    }

    function test_fork_theDeployedGateAlreadySpentClaim72() public {
        assertTrue(DEPLOYED.claimUsed(CLEAN));
        assertEq(DEPLOYED.allowanceOf(BORROWER), 0.5 ether);
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.ClaimAlreadyUsed.selector, CLEAN));
        vm.prank(BORROWER);
        DEPLOYED.grant(CLEAN, 1);
    }

    function test_fork_aRefutedClaimIsRefused() public {
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.NotUsable.selector, REFUTED, 1, 0));
        gate.grant(REFUTED, 1);
    }

    function test_fork_aStrangersCleanClaimIsRefused() public {
        address subject = address(uint160(uint256(REGISTRY.claim(STRANGER).scope.topics[2])));
        vm.expectRevert(abi.encodeWithSelector(NeverLiquidatedGate.NotController.selector, subject, BORROWER));
        vm.prank(BORROWER);
        gate.grant(STRANGER, 0.5 ether);
    }

    function test_fork_aClaimAboutAnotherEventIsRefused() public {
        vm.expectPartialRevert(NeverLiquidatedGate.WrongScope.selector);
        gate.grant(SUPPLY, 1);
    }
}
