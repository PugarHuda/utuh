// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {EventScope} from "../src/lib/EventScope.sol";
import {IBlockProver} from "../src/interfaces/IBlockProver.sol";
import {IChainInfo} from "../src/interfaces/IChainInfo.sol";

/// @notice A contract that is not Utuh, using the registry as a completeness oracle.
///
/// @dev UtuhCredit is one consumer of {UtuhRegistry}, and reading this repository it is easy to
///      come away thinking it is the only shape a consumer can have. It is not: the registry
///      answers one question — *was a bonded assertion that this set is complete left standing,
///      and how much was at stake?* — and any contract on Creditcoin can ask it about any class of
///      source-chain event.
///
///      `Gate` below is the whole integration. It is thirty lines, it holds no proofs, it never
///      touches a precompile, and it is written the way a third party would write it: describe the
///      events you care about, demand a finalized claim about them, and size what you are about to
///      risk against what a liar would certainly lose.
///
///      This file exists so that claim is compiled and tested rather than asserted in a README.
///      `docs/INTEGRATING.md` walks through it line by line.
contract ConsumerTest is Test {
    address internal constant PROVER = 0x0000000000000000000000000000000000000FD2;
    address internal constant CHAIN_INFO = 0x0000000000000000000000000000000000000fD3;

    bytes4 internal constant VERIFY_BATCH =
        bytes4(keccak256("verifyAndEmit(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))"));

    uint64 internal constant WINDOW = 25;
    uint64 internal constant SEPOLIA = 1;

    UtuhRegistry internal registry;
    Gate internal gate;

    bytes internal settlement;
    address internal ledger;
    bytes32 internal settledSig;
    address internal payer;

    function setUp() public {
        settlement = vm.parseJsonBytes(vm.readFile("test/fixtures/encodedTransactions.json"), ".settlement");
        EvmV1Decoder.LogEntry memory log = EvmV1Decoder.decodeReceiptFields(settlement).receiptLogs[0];
        ledger = log.address_;
        settledSig = log.topics[0];
        payer = address(uint160(uint256(log.topics[1])));

        registry = new UtuhRegistry(WINDOW);
        gate = new Gate(registry);

        vm.mockCall(CHAIN_INFO, abi.encodeWithSelector(IChainInfo.is_height_attested.selector), abi.encode(true));
        vm.mockCall(
            CHAIN_INFO,
            abi.encodeWithSelector(IChainInfo.get_attestation_genesis_height.selector),
            abi.encode(uint64(0))
        );
        vm.mockCall(PROVER, abi.encodeWithSelector(VERIFY_BATCH), abi.encode(true));
        vm.mockCall(PROVER, abi.encodeWithSelector(IBlockProver.calculateTxIndex.selector), abi.encode(uint64(3)));

        vm.deal(payer, 100 ether);
    }

    /// @notice The consumer's whole job: a finalized empty claim about the right events, backed by
    ///         enough that breaking it would have cost more than what is being risked.
    function test_aCleanFinalizedClaimOpensTheGate() public {
        uint256 claimId = _cleanClaim(4 ether);
        vm.prank(payer);
        gate.admit(claimId, payer, 2 ether);

        assertTrue(gate.admitted(payer), "a bonded, unbroken assertion should have been enough");
    }

    /// @notice Exposure above what a liar is certain to lose is refused. This is the check every
    ///         consumer has to make for itself — the registry cannot know what is being risked.
    function test_exposureAboveTheEnforceableLossIsRefused() public {
        uint256 claimId = _cleanClaim(4 ether); // enforceableLoss = 2 ether

        vm.expectRevert(abi.encodeWithSelector(Gate.NotBackedEnough.selector, claimId, uint256(2 ether + 1)));
        vm.prank(payer);
        gate.admit(claimId, payer, 2 ether + 1);
    }

    /// @notice A claim about somebody else says nothing about this subject.
    function test_aClaimAboutAnotherSubjectIsRefused() public {
        uint256 claimId = _cleanClaim(4 ether);
        address stranger = address(0x5EE);

        vm.expectRevert(abi.encodeWithSelector(Gate.WrongSubject.selector, stranger));
        vm.prank(stranger);
        gate.admit(claimId, stranger, 1 ether);
    }

    /// @notice A claim that is not empty is not clean, whatever else is true of it.
    function test_aClaimWithMembersIsNotClean() public {
        uint256 claimId = _openClaim(4 ether);
        vm.startPrank(payer);
        registry.appendBatch(claimId, _batch(), _continuity());
        registry.seal(claimId);
        vm.stopPrank();
        vm.roll(registry.challengeUntil(claimId) + 1);
        registry.finalize(claimId);

        vm.expectRevert(abi.encodeWithSelector(Gate.NotClean.selector, uint256(1)));
        vm.prank(payer);
        gate.admit(claimId, payer, 1 ether);
    }

    /// @notice A claim still inside its window is not an answer yet — anyone could still break it.
    function test_aSealedButUnfinalizedClaimIsRefused() public {
        uint256 claimId = _openClaim(4 ether);
        vm.startPrank(payer);
        registry.seal(claimId);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(Gate.NotBackedEnough.selector, claimId, uint256(1 ether)));
        vm.prank(payer);
        gate.admit(claimId, payer, 1 ether);
    }

    // ------------------------------------------------------------------

    function _scopeFor(address subject) internal view returns (EventScope.Scope memory s) {
        s.chainKey = SEPOLIA;
        s.emitter = ledger;
        s.eventSig = settledSig;
        s.topics[0] = bytes32(uint256(uint160(subject)));
        s.topicMask = 1;
        s.metric = EventScope.Metric.COUNT;
    }

    function _openClaim(uint256 bond) internal returns (uint256 claimId) {
        vm.prank(payer);
        claimId = registry.open{value: bond}(_scopeFor(payer), 1_000_000, 1_000_200, WINDOW);
    }

    function _cleanClaim(uint256 bond) internal returns (uint256 claimId) {
        claimId = _openClaim(bond);
        vm.prank(payer);
        registry.seal(claimId);
        vm.roll(registry.challengeUntil(claimId) + 1);
        registry.finalize(claimId);
    }

    function _batch() internal view returns (UtuhRegistry.EventProof[] memory ps) {
        ps = new UtuhRegistry.EventProof[](1);
        ps[0].blockHeight = 1_000_010;
        ps[0].encodedTransaction = settlement;
        ps[0].merkleRoot = keccak256("root");
        ps[0].siblings = new IBlockProver.MerkleProofEntry[](0);
        ps[0].logIndex = 0;
    }

    function _continuity() internal pure returns (IBlockProver.ContinuityProof memory c) {
        c.lowerEndpointDigest = bytes32(uint256(1));
        c.roots = new bytes32[](1);
        c.roots[0] = bytes32(uint256(2));
    }
}

/// @notice Somebody else's contract, gating on a source-chain history it never reads itself.
///
/// @dev The example is deliberately not lending. A registry claim is "this set of source-chain
///      events is complete", and plenty of things want that without wanting credit: an airdrop
///      that excludes addresses which were ever slashed, a DAO seat that requires never having
///      been liquidated, a market maker admitting counterparties with no failed settlements.
///
///      Three lines carry the whole integration:
///
///        `EventScope.id(...)` — rebuild the exact scope this contract cares about for this
///        subject, and refuse a claim carrying any other. Without it a borrower could hand over a
///        perfectly good claim about a different address, or a different contract's events.
///
///        `memberCount(...) == 0` — the assertion is that the set is *empty*. Counting rather than
///        reading the aggregate keeps that true whatever metric the scope carries.
///
///        `isUsable(claimId, exposure)` — Finalized, and the burn behind it was at least what is
///        about to be risked. The registry cannot size this; only the caller knows its own
///        exposure.
contract Gate {
    UtuhRegistry public immutable REGISTRY;

    mapping(address => bool) public admitted;

    error WrongSubject(address subject);
    error NotClean(uint256 adverse);
    error NotBackedEnough(uint256 claimId, uint256 exposure);

    constructor(UtuhRegistry registry) {
        REGISTRY = registry;
    }

    /// @notice Admit `subject` if `claimId` is a standing, bonded assertion that nothing adverse
    ///         happened to them — backed by at least `exposure`.
    function admit(uint256 claimId, address subject, uint256 exposure) external {
        UtuhRegistry.Claim memory c = REGISTRY.claim(claimId);

        // The subject is pinned in topic 1 of the scope the claim carries. A claim about anyone
        // else is not an answer about this one.
        if (c.scope.topics[0] != bytes32(uint256(uint160(subject)))) revert WrongSubject(subject);

        uint256 adverse = REGISTRY.memberCount(claimId);
        if (adverse != 0) revert NotClean(adverse);

        if (!REGISTRY.isUsable(claimId, exposure)) revert NotBackedEnough(claimId, exposure);

        admitted[subject] = true;
    }
}
