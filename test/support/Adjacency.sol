// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IncrementalMerkle} from "../../src/lib/IncrementalMerkle.sol";

/// @notice The witness a refuter carries, built the slow way from every key a claim holds.
/// @dev A test knows which keys it appended, so it can rebuild the whole tree and read a proof
///      out of the layers. That is exactly what a watcher does off-chain from the `EventAppended`
///      log, and it is deliberately the obvious implementation rather than the library's own: a
///      proof built by the code under test proves nothing about the code under test.
library Adjacency {
    uint256 internal constant DEPTH = 32;

    function zeros() internal pure returns (bytes32[DEPTH + 1] memory z) {
        for (uint256 h = 1; h <= DEPTH; h++) {
            z[h] = keccak256(abi.encodePacked(z[h - 1], z[h - 1]));
        }
    }

    function node(uint256[] memory keys, uint256 h, uint256 pos, bytes32[DEPTH + 1] memory z)
        internal
        pure
        returns (bytes32)
    {
        if (h == 0) return pos < keys.length ? bytes32(keys[pos]) : bytes32(0);
        if ((pos << h) >= keys.length) return z[h];
        return keccak256(abi.encodePacked(node(keys, h - 1, pos * 2, z), node(keys, h - 1, pos * 2 + 1, z)));
    }

    function root(uint256[] memory keys) internal pure returns (bytes32) {
        return node(keys, DEPTH, 0, zeros());
    }

    function proofFor(uint256[] memory keys, uint256 index) internal pure returns (bytes32[DEPTH] memory p) {
        bytes32[DEPTH + 1] memory z = zeros();
        uint256 pos = index;
        for (uint256 h = 0; h < DEPTH; h++) {
            p[h] = node(keys, h, pos ^ 1, z);
            pos >>= 1;
        }
    }

    /// @dev The honest witness that `k` is not among `keys` (which must be strictly ascending).
    ///      For a `k` that *is* a member there is no honest witness; what comes back names `k`'s
    ///      own position, which the contract must reject — tests rely on that shape.
    function build(uint256[] memory keys, uint256 k) internal pure returns (IncrementalMerkle.Adjacency memory adj) {
        uint256 n = keys.length;
        if (n == 0) return adj;
        uint256 i = 0;
        while (i < n && keys[i] < k) i++;
        if (i < n && keys[i] == k) {
            adj.index = i;
            adj.lower = keys[i];
            adj.lowerProof = proofFor(keys, i);
            if (i + 1 < n) {
                adj.upper = keys[i + 1];
                adj.upperProof = proofFor(keys, i + 1);
            }
            return adj;
        }
        if (i == 0) {
            adj.lower = keys[0];
            adj.lowerProof = proofFor(keys, 0);
        } else if (i == n) {
            adj.index = n - 1;
            adj.lower = keys[n - 1];
            adj.lowerProof = proofFor(keys, n - 1);
        } else {
            adj.index = i - 1;
            adj.lower = keys[i - 1];
            adj.lowerProof = proofFor(keys, i - 1);
            adj.upper = keys[i];
            adj.upperProof = proofFor(keys, i);
        }
    }
}
