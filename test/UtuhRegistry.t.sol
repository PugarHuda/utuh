// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {IBlockProver} from "../src/interfaces/IBlockProver.sol";
import {EventScope} from "../src/lib/EventScope.sol";

/// @notice The registry guard layer: everything that decides an answer before a precompile is
///         consulted.
///
/// @dev `open` reaches `0x0FD3` on its fourth check, and `appendBatch` and `refute` reach `0x0FD2`
///      after theirs. Both addresses are Substrate runtime natives with no EVM bytecode, which the
///      last test here asserts rather than assumes, so nothing past those points can run in a local
///      EVM. Until now that meant the guards *before* them were exercised only by
///      offchain/livetest.ts, which needs a funded account and so cannot run in CI. Everything
///      below runs in a plain EVM on every push.
///
///      Faking the precompile would cover more lines and prove less. The guards are the part whose
///      behaviour this contract decides, and they are what these tests pin — in particular the
///      order they run in, because the order is what a caller actually observes.
contract UtuhRegistryGuardTest is Test {
    UtuhRegistry internal registry;

    uint64 constant WINDOW = 25;
    address constant AAVE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    uint256 constant UNKNOWN = 999;

    function setUp() public {
        registry = new UtuhRegistry(WINDOW);
        vm.deal(address(this), 10 ether);
    }

    function _scope() internal pure returns (EventScope.Scope memory s) {
        s.chainKey = 3;
        s.emitter = AAVE;
        s.eventSig = keccak256("Repay(address,address,address,uint256,bool)");
        s.metric = EventScope.Metric.COUNT;
    }

    function _proof() internal pure returns (UtuhRegistry.EventProof memory p) {
        p.blockHeight = 1;
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
    }

    function _continuity() internal pure returns (IBlockProver.ContinuityProof memory c) {
        c.roots = new bytes32[](0);
    }

    // ------------------------------------------------------------------
    // What `open` refuses, and in what order
    // ------------------------------------------------------------------

    /// @notice Three things are wrong here — the range runs backwards, the bond is nothing and the
    ///         window is zero — and the range is the one the caller is told about. Pinning which
    ///         complaint comes first matters because a caller fixing them one at a time follows
    ///         this order, and a reordering would silently change the conversation.
    function test_aBackwardsRangeIsTheFirstThingRefused() public {
        vm.expectRevert(UtuhRegistry.EmptyRange.selector);
        registry.open(_scope(), 100, 99, 0);
    }

    function test_aBondBelowTheFloorIsRefused() public {
        uint256 short = registry.MIN_BOND() - 1;
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.BondTooSmall.selector, short, registry.MIN_BOND()));
        registry.open{value: short}(_scope(), 99, 100, WINDOW);
    }

    /// @notice The bond is checked before the window, so a caller with both wrong hears about the
    ///         bond. The live suite proves the same thing at the cost of a transaction.
    function test_theBondIsCheckedBeforeTheWindow() public {
        uint256 short = registry.MIN_BOND() - 1;
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.BondTooSmall.selector, short, registry.MIN_BOND()));
        registry.open{value: short}(_scope(), 99, 100, 0);
    }

    /// @notice A window under the floor this registry was deployed with, which is stricter than the
    ///         absolute floor the constructor enforces.
    function test_aWindowBelowTheDeploymentFloorIsRefused() public {
        uint64 tooShort = WINDOW - 1;
        // Read the bond first: `vm.expectRevert` arms the *next* call, and a getter inside the
        // value expression would be that call.
        uint256 bond = registry.MIN_BOND();
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.BadChallengeWindow.selector, tooShort));
        registry.open{value: bond}(_scope(), 99, 100, tooShort);
    }

    /// @notice And a window so long that no bond stays meaningful across it.
    function test_aWindowAboveTheCeilingIsRefused() public {
        uint64 tooLong = registry.MAX_CHALLENGE_WINDOW() + 1;
        uint256 bond = registry.MIN_BOND();
        vm.expectRevert(abi.encodeWithSelector(UtuhRegistry.BadChallengeWindow.selector, tooLong));
        registry.open{value: bond}(_scope(), 99, 100, tooLong);
    }

    // ------------------------------------------------------------------
    // What an unknown claim id answers, which is not one thing
    // ------------------------------------------------------------------

    /// @notice `seal`, `abandon` and `appendBatch` check the caller before the status, so an id
    ///         that was never opened answers `NotClaimant` rather than `WrongStatus`. That is worth
    ///         a test on its own: the same asymmetry in UtuhCredit — `draw` answering `NotBorrower`
    ///         where a settled line looks like a status problem — was written into the live
    ///         assertions the wrong way round first, and only the chain corrected it.
    function test_sealingAnUnknownClaimIsAnAuthorisationAnswer() public {
        vm.expectRevert(UtuhRegistry.NotClaimant.selector);
        registry.seal(UNKNOWN);
    }

    function test_abandoningAnUnknownClaimIsAnAuthorisationAnswer() public {
        vm.expectRevert(UtuhRegistry.NotClaimant.selector);
        registry.abandon(UNKNOWN);
    }

    function test_appendingToAnUnknownClaimIsAnAuthorisationAnswer() public {
        UtuhRegistry.EventProof[] memory proofs = new UtuhRegistry.EventProof[](1);
        proofs[0] = _proof();
        vm.expectRevert(UtuhRegistry.NotClaimant.selector);
        registry.appendBatch(UNKNOWN, proofs, _continuity());
    }

    /// @notice `finalize` and `refute` check the status first, so the same unknown id answers
    ///         `WrongStatus` instead. Both orderings are deliberate; this records which is which.
    function test_finalizingAnUnknownClaimIsAStatusAnswer() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhRegistry.WrongStatus.selector, UtuhRegistry.Status.Sealed, UtuhRegistry.Status.None
            )
        );
        registry.finalize(UNKNOWN);
    }

    function test_refutingAnUnknownClaimIsAStatusAnswer() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                UtuhRegistry.WrongStatus.selector, UtuhRegistry.Status.Sealed, UtuhRegistry.Status.None
            )
        );
        registry.refute(UNKNOWN, _proof(), _continuity());
    }

    /// @notice A read of an id that does not exist has to answer rather than revert, because the
    ///         watcher reads before it knows whether there is anything there.
    function test_anUnknownClaimReadsAsEmpty() public view {
        UtuhRegistry.Claim memory c = registry.claim(UNKNOWN);
        assertEq(uint8(c.status), uint8(UtuhRegistry.Status.None), "an unknown claim looked live");
        assertEq(c.claimant, address(0));
        assertEq(c.bond, 0);
        assertEq(registry.memberCount(UNKNOWN), 0, "an unknown claim had members");
        assertFalse(registry.contains(UNKNOWN, 1), "an unknown claim contained something");
        assertEq(registry.challengeUntil(UNKNOWN), 0, "an unknown claim had a deadline");
    }

    function test_claimIdsStartAtOneSoZeroIsNeverAClaim() public view {
        assertEq(registry.nextClaimId(), 1, "id 0 would be indistinguishable from unset");
    }

    // ------------------------------------------------------------------
    // Withdrawals
    // ------------------------------------------------------------------

    function test_thereIsNothingToWithdrawBeforeAnythingIsFinalized() public {
        vm.expectRevert(UtuhRegistry.NothingToWithdraw.selector);
        registry.withdraw();
    }

    // ------------------------------------------------------------------
    // The two addresses everything else depends on
    // ------------------------------------------------------------------

    /// @notice A wrong precompile address fails in the worst possible way — a call to an address
    ///         with no code succeeds and returns nothing — so the addresses are pinned here.
    function test_theRegistryPointsAtTheTwoRuntimeNatives() public view {
        assertEq(address(registry.PROVER()), 0x0000000000000000000000000000000000000FD2, "Block Prover moved");
        assertEq(address(registry.CHAIN_INFO()), 0x0000000000000000000000000000000000000fD3, "ChainInfo moved");
    }

    /// @notice The reason every test above stops at a guard, asserted rather than claimed in a
    ///         comment. If either address ever gains bytecode in a local EVM, this fails and the
    ///         coverage ceiling described at the top of this file is no longer real.
    function test_neitherPrecompileHasBytecodeInAPlainEvm() public view {
        assertEq(address(registry.PROVER()).code.length, 0, "the Block Prover is not a runtime native here");
        assertEq(address(registry.CHAIN_INFO()).code.length, 0, "ChainInfo is not a runtime native here");
    }
}
