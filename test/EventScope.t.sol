// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";
import {EventScope} from "../src/lib/EventScope.sol";

/// @notice Unit tests for the scope matcher and ordering key.
/// @dev These cover the pure half of Utuh. The proving half runs against the Attestcoin
///      precompiles at `0x0FD2` and `0x0FD3`, which are Creditcoin runtime natives with no
///      bytecode at their addresses — `eth_getCode` returns `0x`. A forked EVM cannot execute
///      them, and stubbing them would only test the stub. That half is therefore exercised
///      against the live CC3 testnet with real proofs; see offchain/e2e.ts.
contract EventScopeTest is Test {
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant AAVE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    bytes32 constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");
    bytes32 constant OTHER_SIG = keccak256("Approval(address,address,uint256)");

    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    function _topic(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _transferLog(address emitter, address from, address to, uint256 value)
        internal
        pure
        returns (EvmV1Decoder.LogEntry memory log)
    {
        log.address_ = emitter;
        log.topics = new bytes32[](3);
        log.topics[0] = TRANSFER_SIG;
        log.topics[1] = _topic(from);
        log.topics[2] = _topic(to);
        log.data = abi.encode(value);
    }

    function _scope(address emitter, bytes32 sig, address subject, uint8 subjectTopic)
        internal
        pure
        returns (EventScope.Scope memory s)
    {
        s.chainKey = 3;
        s.emitter = emitter;
        s.eventSig = sig;
        if (subjectTopic != 0) {
            s.topics[subjectTopic - 1] = _topic(subject);
            s.topicMask = uint8(1) << (subjectTopic - 1);
        }
        s.metric = EventScope.Metric.DATA_WORD;
        s.metricArg = 0;
    }

    // ------------------------------------------------------------------
    // Ordering key
    // ------------------------------------------------------------------

    /// @notice Numeric order on the key must be chronological order on the source chain.
    /// @dev Refutation is a gap check over a sorted sequence, so any pair that sorts wrongly
    ///      would be a hole a claimant could hide an event in.
    function test_keyOrdersChronologically() public pure {
        uint256 a = EventScope.key(100, 0, 0);
        uint256 b = EventScope.key(100, 0, 1);
        uint256 c = EventScope.key(100, 1, 0);
        uint256 d = EventScope.key(101, 0, 0);

        assertLt(a, b, "later log in same tx must sort after");
        assertLt(b, c, "later tx in same block must sort after");
        assertLt(c, d, "later block must sort after");
    }

    function test_keyRoundTripsBlockHeight() public pure {
        assertEq(EventScope.blockOf(EventScope.key(25_797_486, 7, 3)), 25_797_486);
    }

    function testFuzz_keyIsStrictlyMonotonic(uint64 height, uint64 txIndex, uint32 logIndex) public pure {
        vm.assume(logIndex < type(uint32).max);
        uint256 k1 = EventScope.key(height, txIndex, logIndex);
        uint256 k2 = EventScope.key(height, txIndex, logIndex + 1);
        assertLt(k1, k2);
    }

    /// @notice A later transaction index must outrank any log index in an earlier transaction.
    function testFuzz_txIndexDominatesLogIndex(uint64 height, uint64 txIndex, uint32 logIndex) public pure {
        vm.assume(txIndex < type(uint64).max);
        uint256 earlier = EventScope.key(height, txIndex, logIndex);
        uint256 later = EventScope.key(height, txIndex + 1, 0);
        assertLt(earlier, later);
    }

    // ------------------------------------------------------------------
    // Scope matching
    // ------------------------------------------------------------------

    function test_matchesSubject() public pure {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, ALICE, 1);
        assertTrue(EventScope.matches(s, _transferLog(USDC, ALICE, BOB, 1e6)));
    }

    function test_rejectsDifferentEmitter() public pure {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, ALICE, 1);
        assertFalse(EventScope.matches(s, _transferLog(AAVE, ALICE, BOB, 1e6)));
    }

    function test_rejectsDifferentEventSignature() public pure {
        EventScope.Scope memory s = _scope(USDC, OTHER_SIG, ALICE, 1);
        assertFalse(EventScope.matches(s, _transferLog(USDC, ALICE, BOB, 1e6)));
    }

    function test_rejectsDifferentSubject() public pure {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, ALICE, 1);
        assertFalse(EventScope.matches(s, _transferLog(USDC, BOB, ALICE, 1e6)));
    }

    /// @notice A scope pinning both sender and recipient is what stops "repaying" oneself.
    function test_matchesBothTopicsWhenMasked() public pure {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, ALICE, 1);
        s.topics[1] = _topic(BOB);
        s.topicMask |= 0x02;

        assertTrue(EventScope.matches(s, _transferLog(USDC, ALICE, BOB, 1e6)), "alice->bob matches");
        assertFalse(EventScope.matches(s, _transferLog(USDC, ALICE, ALICE, 1e6)), "alice->alice must not");
    }

    /// @notice An unmasked scope takes every event of that signature from that contract.
    function test_wildcardMatchesAnySubject() public pure {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, address(0), 0);
        assertTrue(EventScope.matches(s, _transferLog(USDC, ALICE, BOB, 1)));
        assertTrue(EventScope.matches(s, _transferLog(USDC, BOB, ALICE, 2)));
    }

    /// @notice A masked topic the event does not carry is a non-match, never a revert.
    /// @dev A refuter who reverts instead of failing cleanly has been griefed out of their gas
    ///      by the claimant's choice of scope.
    function test_missingTopicIsNonMatchNotRevert() public pure {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, ALICE, 3);

        EvmV1Decoder.LogEntry memory log = _transferLog(USDC, ALICE, BOB, 1e6);
        assertEq(log.topics.length, 3, "Transfer carries topics[0..2] only");
        assertFalse(EventScope.matches(s, log));
    }

    function test_emptyTopicsIsNonMatch() public pure {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, ALICE, 1);
        EvmV1Decoder.LogEntry memory log;
        log.address_ = USDC;
        log.topics = new bytes32[](0);
        assertFalse(EventScope.matches(s, log));
    }

    // ------------------------------------------------------------------
    // Metrics
    // ------------------------------------------------------------------

    function test_countMetric() public pure {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, ALICE, 1);
        s.metric = EventScope.Metric.COUNT;
        assertEq(EventScope.value(s, _transferLog(USDC, ALICE, BOB, 12345)), 1);
    }

    function test_dataWordMetricReadsFirstWord() public pure {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, ALICE, 1);
        assertEq(EventScope.value(s, _transferLog(USDC, ALICE, BOB, 12345)), 12345);
    }

    function test_dataWordMetricReadsLaterWord() public pure {
        EventScope.Scope memory s = _scope(AAVE, TRANSFER_SIG, ALICE, 1);
        s.metricArg = 1;

        EvmV1Decoder.LogEntry memory log = _transferLog(AAVE, ALICE, BOB, 0);
        log.data = abi.encode(uint256(111), uint256(222));
        assertEq(EventScope.value(s, log), 222);
    }

    function test_dataWordBeyondPayloadReverts() public {
        EventScope.Scope memory s = _scope(USDC, TRANSFER_SIG, ALICE, 1);
        s.metricArg = 4;

        EvmV1Decoder.LogEntry memory log = _transferLog(USDC, ALICE, BOB, 1);
        vm.expectRevert(EventScope.DataWordOutOfRange.selector);
        this.callValue(s, log);
    }

    function callValue(EventScope.Scope calldata s, EvmV1Decoder.LogEntry calldata log)
        external
        pure
        returns (uint256)
    {
        EventScope.Scope memory ms = s;
        EvmV1Decoder.LogEntry memory ml = log;
        return EventScope.value(ms, ml);
    }

    // ------------------------------------------------------------------
    // Scope identity
    // ------------------------------------------------------------------

    /// @notice Scope identity is what UtuhCredit compares to stop a borrower underwriting with
    ///         someone else's history. Any field change must change the id.
    function test_scopeIdSeparatesSubjects() public pure {
        bytes32 a = EventScope.id(_scope(USDC, TRANSFER_SIG, ALICE, 1));
        bytes32 b = EventScope.id(_scope(USDC, TRANSFER_SIG, BOB, 1));
        assertTrue(a != b);
    }

    function test_scopeIdSeparatesEmittersAndMetrics() public pure {
        EventScope.Scope memory base = _scope(USDC, TRANSFER_SIG, ALICE, 1);
        bytes32 id0 = EventScope.id(base);

        EventScope.Scope memory other = base;
        other.emitter = AAVE;
        assertTrue(EventScope.id(other) != id0, "emitter must matter");

        EventScope.Scope memory counted = base;
        counted.metric = EventScope.Metric.COUNT;
        assertTrue(EventScope.id(counted) != id0, "metric must matter");

        EventScope.Scope memory shifted = base;
        shifted.metricArg = 1;
        assertTrue(EventScope.id(shifted) != id0, "metric arg must matter");

        EventScope.Scope memory rechained = base;
        rechained.chainKey = 1;
        assertTrue(EventScope.id(rechained) != id0, "chain key must matter");
    }

    function test_scopeIdIsStable() public pure {
        assertEq(
            EventScope.id(_scope(USDC, TRANSFER_SIG, ALICE, 1)),
            EventScope.id(_scope(USDC, TRANSFER_SIG, ALICE, 1))
        );
    }

    // ------------------------------------------------------------------
    // Leaf identity
    // ------------------------------------------------------------------

    /// @notice Two events at the same position with different payloads must not share a leaf.
    function test_leafBindsContentsNotJustPosition() public pure {
        uint256 k = EventScope.key(100, 1, 0);
        bytes32 a = EventScope.leaf(k, _transferLog(USDC, ALICE, BOB, 1));
        bytes32 b = EventScope.leaf(k, _transferLog(USDC, ALICE, BOB, 2));
        assertTrue(a != b);
    }

    function test_leafBindsPosition() public pure {
        EvmV1Decoder.LogEntry memory log = _transferLog(USDC, ALICE, BOB, 1);
        assertTrue(EventScope.leaf(EventScope.key(100, 1, 0), log) != EventScope.leaf(EventScope.key(100, 1, 1), log));
    }
}
