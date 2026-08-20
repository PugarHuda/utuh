// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

/// @title EventScope
/// @notice Defines *which* source-chain events a Utuh claim is about, and how each matching
///         event contributes to the claim's aggregate.
/// @dev A scope has to be machine-checkable on Creditcoin: given a decoded log, the registry
///      must decide "does this belong to the claimed set?" with no discretion. An opaque
///      `bytes32 scopeId` would make refutation unfalsifiable — the claimant could always argue
///      the refuter's event was out of scope. So the scope is structured and every field is
///      compared on-chain against the decoded log.
library EventScope {
    /// @notice How a matching event contributes to the claim's aggregate.
    enum Metric {
        COUNT, // each matching event contributes 1
        DATA_WORD // each contributes the uint256 at `metricArg` words into the log's data
    }

    struct Scope {
        uint64 chainKey; // 1 = Ethereum Sepolia, 3 = Ethereum Mainnet
        address emitter; // contract that emitted the log
        bytes32 eventSig; // topics[0]
        bytes32[3] topics; // expected values for topics[1..3]
        uint8 topicMask; // bit i set => topics[i] must match (i = 0,1,2 for topics[1..3])
        Metric metric;
        uint8 metricArg; // word index into log.data when metric == DATA_WORD
    }

    error TopicOutOfRange();
    error DataWordOutOfRange();

    /// @notice Canonical, strictly-increasing ordering key for a source-chain log.
    /// @dev (blockHeight, txIndex, logIndex) packed so that numeric order == chronological order.
    ///      This ordering is what makes completeness refutable: an omitted event's key must fall
    ///      in a gap, and gaps are detectable in a sorted sequence.
    function key(uint64 blockHeight, uint64 txIndex, uint32 logIndex) internal pure returns (uint256) {
        return (uint256(blockHeight) << 96) | (uint256(txIndex) << 32) | uint256(logIndex);
    }

    function blockOf(uint256 k) internal pure returns (uint64) {
        // casting to 'uint64' is safe because key() packs a uint64 height at bit 96 and nothing
        // above it, so the shifted value can never exceed 64 bits.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(k >> 96);
    }

    /// @notice Identity of a single claimed event: its position plus its full contents.
    /// @dev Position alone is not enough — two claims could share a key but disagree on payload.
    function leaf(uint256 k, EvmV1Decoder.LogEntry memory log) internal pure returns (bytes32) {
        return keccak256(abi.encode(k, log.address_, log.topics, log.data));
    }

    /// @notice True when `log` is a member of the set described by `scope`.
    function matches(Scope memory scope, EvmV1Decoder.LogEntry memory log) internal pure returns (bool) {
        if (log.address_ != scope.emitter) return false;
        if (log.topics.length == 0 || log.topics[0] != scope.eventSig) return false;

        for (uint8 i = 0; i < 3; i++) {
            uint8 bit = uint8(1) << i;
            if (scope.topicMask & bit == 0) continue;
            // A masked topic that the event does not carry is a non-match, not a revert:
            // refuters must be able to submit near-miss events without griefing themselves.
            if (log.topics.length <= i + 1) return false;
            if (log.topics[i + 1] != scope.topics[i]) return false;
        }
        return true;
    }

    /// @notice The amount a single matching event adds to the claim's aggregate.
    function value(Scope memory scope, EvmV1Decoder.LogEntry memory log) internal pure returns (uint256) {
        if (scope.metric == Metric.COUNT) return 1;

        uint256 offset = uint256(scope.metricArg) * 32;
        if (log.data.length < offset + 32) revert DataWordOutOfRange();

        bytes memory data = log.data;
        uint256 word;
        assembly {
            word := mload(add(add(data, 0x20), offset))
        }
        return word;
    }

    /// @notice Stable identity of a scope, for indexing and off-chain lookup.
    function id(Scope memory scope) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                scope.chainKey,
                scope.emitter,
                scope.eventSig,
                scope.topics,
                scope.topicMask,
                scope.metric,
                scope.metricArg
            )
        );
    }
}
