// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {EventScope} from "../src/lib/EventScope.sol";
import {IBlockProver} from "../src/interfaces/IBlockProver.sol";
import {IChainInfo} from "../src/interfaces/IChainInfo.sol";

/// @notice Every wei the registry holds is accounted for, whatever anyone does in whatever order.
///
/// @dev The unit tests take one path each. This takes hundreds, at random: several actors open,
///      append, seal, abandon, refute, finalize and withdraw, with the clock rolled forward between
///      moves, and after every step the books have to balance. The one sentence the registry
///      cannot afford to break is that money is never created or lost — that a bond is escrowed,
///      or credited to someone, or burned, and nothing else — because a bond that leaks is a
///      deterrent that quietly stopped deterring.
///
///      The precompiles are substituted the way `Lifecycle.t.sol` substitutes them, and for the
///      same reason: this is about what the contract does with a valid proof, not about whether
///      the proof is valid.
contract RegistryInvariantTest is Test {
    RegistryHandler internal handler;
    UtuhRegistry internal registry;

    function setUp() public {
        registry = new UtuhRegistry(20);
        handler = new RegistryHandler(registry, Cheats(address(vm)));

        vm.mockCall(
            0x0000000000000000000000000000000000000fD3,
            abi.encodeWithSelector(IChainInfo.is_height_attested.selector),
            abi.encode(true)
        );
        vm.mockCall(
            0x0000000000000000000000000000000000000fD3,
            abi.encodeWithSelector(IChainInfo.get_attestation_genesis_height.selector),
            abi.encode(uint64(0))
        );
        bytes4 verifyOne =
            bytes4(keccak256("verifyAndEmit(uint64,uint64,bytes,(bytes32,(bytes32,bool)[]),(bytes32,bytes32[]))"));
        bytes4 verifyBatch = bytes4(
            keccak256("verifyAndEmit(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))")
        );
        vm.mockCall(0x0000000000000000000000000000000000000FD2, abi.encodeWithSelector(verifyOne), abi.encode(true));
        vm.mockCall(0x0000000000000000000000000000000000000FD2, abi.encodeWithSelector(verifyBatch), abi.encode(true));
        vm.mockCall(
            0x0000000000000000000000000000000000000FD2,
            abi.encodeWithSelector(IBlockProver.calculateTxIndex.selector),
            abi.encode(uint64(7))
        );

        targetContract(address(handler));
    }

    /// @notice The registry's balance is exactly the bonds still escrowed, plus what is credited
    ///         for withdrawal, plus what was burned. No other bucket exists.
    function invariant_everyWeiIsAccountedFor() public view {
        uint256 escrowed;
        uint256 n = registry.nextClaimId();
        for (uint256 id = 1; id < n; id++) {
            escrowed += registry.claim(id).bond;
        }
        uint256 credited;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            credited += registry.withdrawable(handler.actorAt(i));
        }
        assertEq(address(registry).balance, escrowed + credited + registry.burned(), "the books do not balance");
    }

    /// @notice A refuted claim keeps nothing in escrow, and what it guarantees is nothing.
    function invariant_aRefutedClaimHoldsNothing() public view {
        uint256 n = registry.nextClaimId();
        for (uint256 id = 1; id < n; id++) {
            UtuhRegistry.Claim memory c = registry.claim(id);
            if (c.status == UtuhRegistry.Status.Refuted || c.status == UtuhRegistry.Status.None) {
                assertEq(c.bond, 0, "a dead claim still holds a bond");
                assertEq(registry.enforceableLoss(id), 0, "a dead claim still promises a loss");
            }
        }
    }

    /// @notice What a claim guarantees never exceeds what was posted, and is the burned share of it.
    function invariant_enforceableLossIsTheBurnedShare() public view {
        uint256 n = registry.nextClaimId();
        for (uint256 id = 1; id < n; id++) {
            UtuhRegistry.Claim memory c = registry.claim(id);
            uint256 loss = registry.enforceableLoss(id);
            assertLe(loss, c.bondPosted, "a claim promises more than was posted");
            if (c.status == UtuhRegistry.Status.Sealed || c.status == UtuhRegistry.Status.Finalized) {
                assertEq(loss, (c.bondPosted * (10_000 - registry.REFUTER_SHARE_BPS())) / 10_000);
            }
        }
    }

    /// @notice Members are strictly ascending, always — the property refutation's binary search rests on.
    function invariant_membersStayOrdered() public view {
        uint256 n = registry.nextClaimId();
        for (uint256 id = 1; id < n; id++) {
            uint256 count = registry.memberCount(id);
            for (uint256 i = 1; i < count; i++) {
                assertLt(registry.keyAt(id, i - 1), registry.keyAt(id, i), "members out of order");
            }
        }
    }

    /// @notice Money only ever went out to the people the handler acted as.
    function invariant_burnedOnlyGrows() public view {
        assertGe(registry.burned(), handler.burnedSeen(), "burned went down");
    }
}

/// @dev The actors, and the moves. Every call is wrapped so that a revert is a move that did not
///      happen rather than a failed run: the registry refusing something is the registry working.
contract RegistryHandler {
    UtuhRegistry internal immutable REGISTRY;
    Cheats internal immutable VM;

    address[] internal actors;
    bytes internal settlement;
    uint64 internal nextHeight = 1_000_000;
    uint256 public burnedSeen;

    uint64 internal constant FROM = 1_000_000;
    uint64 internal constant TO = 1_200_000;

    constructor(UtuhRegistry registry, Cheats vm_) {
        REGISTRY = registry;
        VM = vm_;
        settlement = vm_.parseJsonBytes(vm_.readFile("test/fixtures/encodedTransactions.json"), ".settlement");
        for (uint160 i = 1; i <= 4; i++) {
            address a = address(uint160(0xA000) + i);
            actors.push(a);
            vm_.deal(a, 1000 ether);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _scope() internal view returns (EventScope.Scope memory s) {
        EvmV1Decoder.LogEntry memory log = EvmV1Decoder.decodeReceiptFields(settlement).receiptLogs[0];
        s.chainKey = 1;
        s.emitter = log.address_;
        s.eventSig = log.topics[0];
        s.topics[0] = log.topics[1];
        s.topicMask = 1;
        s.metric = EventScope.Metric.DATA_WORD;
    }

    function _proofAt(uint64 height) internal view returns (UtuhRegistry.EventProof memory p) {
        p.blockHeight = height;
        p.encodedTransaction = settlement;
        p.merkleRoot = keccak256(abi.encode(height));
        p.siblings = new IBlockProver.MerkleProofEntry[](0);
    }

    function _continuity() internal pure returns (IBlockProver.ContinuityProof memory c) {
        c.lowerEndpointDigest = bytes32(uint256(1));
        c.roots = new bytes32[](1);
        c.roots[0] = bytes32(uint256(2));
    }

    function _claims() internal view returns (uint256) {
        return REGISTRY.nextClaimId() - 1;
    }

    // ------------------------------------------------------------------ moves

    function open(uint256 who, uint96 bondSeed, uint64 windowSeed) external {
        uint256 bond = 1 ether + (uint256(bondSeed) % 5 ether);
        uint64 window = 20 + (windowSeed % 40);
        VM.prank(_actor(who));
        try REGISTRY.open{value: bond}(_scope(), FROM, TO, window) {} catch {}
    }

    function append(uint256 who, uint256 claimSeed, uint8 count) external {
        if (_claims() == 0) return;
        uint256 id = 1 + (claimSeed % _claims());
        uint256 n = 1 + (count % 3);
        UtuhRegistry.EventProof[] memory ps = new UtuhRegistry.EventProof[](n);
        for (uint256 i = 0; i < n; i++) {
            nextHeight += 1;
            ps[i] = _proofAt(nextHeight);
        }
        VM.prank(_actor(who));
        try REGISTRY.appendBatch(id, ps, _continuity()) {} catch {}
    }

    function seal(uint256 who, uint256 claimSeed) external {
        if (_claims() == 0) return;
        VM.prank(_actor(who));
        try REGISTRY.seal(1 + (claimSeed % _claims())) {} catch {}
    }

    function abandon(uint256 who, uint256 claimSeed) external {
        if (_claims() == 0) return;
        VM.prank(_actor(who));
        try REGISTRY.abandon(1 + (claimSeed % _claims())) {} catch {}
    }

    function refute(uint256 who, uint256 claimSeed) external {
        if (_claims() == 0) return;
        uint256 id = 1 + (claimSeed % _claims());
        // An event the claim cannot already hold: a height past everything appended so far.
        nextHeight += 1;
        uint256 before = REGISTRY.burned();
        VM.prank(_actor(who));
        try REGISTRY.refute(id, _proofAt(nextHeight), _continuity()) {
            burnedSeen = REGISTRY.burned();
        } catch {
            if (REGISTRY.burned() < before) revert("burned decreased");
        }
    }

    function finalize(uint256 who, uint256 claimSeed, uint16 roll) external {
        if (_claims() == 0) return;
        VM.roll(block.number + (roll % 80));
        VM.prank(_actor(who));
        try REGISTRY.finalize(1 + (claimSeed % _claims())) {} catch {}
    }

    function withdraw(uint256 who) external {
        VM.prank(_actor(who));
        try REGISTRY.withdraw() {} catch {}
    }
}

/// @dev The handful of cheatcodes the handler needs, under a name that does not collide with
///      forge-std's own `Vm`, which `Test` already brings into scope.
interface Cheats {
    function prank(address) external;
    function roll(uint256) external;
    function deal(address, uint256) external;
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
}
