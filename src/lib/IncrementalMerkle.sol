// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title An append-only Merkle tree whose members are strictly ascending, and a proof that a
///        value is not among them.
///
/// @notice The registry used to hold a claim's members as a storage array so that refutation was a
///         binary search the chain ran itself, with no witness a claimant could withhold. That
///         property was worth keeping and it had a price: every member cost a storage slot, and
///         past roughly ten thousand of them a claim stopped being affordable. This is the
///         replacement the roadmap named — the array becomes a root, and the *refuter* carries the
///         witness: an adjacency proof of the two members bracketing the key they say is missing.
///
/// @dev Depth 32, appended left to right, in the shape Ethereum's deposit contract uses: `branch[h]`
///      holds the left sibling at height `h` for the frontier, so an append costs at most 32 hashes
///      and no reads beyond the branch. Leaves are `bytes32(key)`. Because the registry refuses an
///      append whose key does not exceed the last one, the leaves are strictly ascending by
///      construction, which is what turns "these two leaves are adjacent and the key lies between
///      them" into "the key is absent" — a sorted set has exactly one place a value could be, and
///      showing that place occupied by two neighbours closes it.
///
///      The witness is not withheld by the claimant because every appended key is emitted in
///      `EventAppended`; anybody who read the log can build any proof. What a claimant *can* do is
///      nothing worse than before: an omission is still one proof away from costing them the bond.
library IncrementalMerkle {
    uint256 internal constant DEPTH = 32;
    uint256 internal constant CAPACITY = 2 ** 32 - 1;

    struct Tree {
        bytes32[DEPTH] branch;
        uint256 count;
    }

    /// @notice The two leaves that bracket a key the refuter says is missing.
    /// @dev `index` is the position of `lower`. Exactly one of three shapes is accepted, and the
    ///      contract decides which from `index` and `count` rather than from a flag the caller could
    ///      set to the convenient one:
    ///        below   index == 0 and the key is under the first leaf — only `lower` is checked;
    ///        above   index + 1 == count and the key is over the last leaf — only `lower` is checked;
    ///        between lower < key < upper with `upper` at `index + 1` — both are checked.
    ///      `upperProof` is ignored in the first two shapes and may be anything.
    struct Adjacency {
        uint256 index;
        uint256 lower;
        bytes32[DEPTH] lowerProof;
        uint256 upper;
        bytes32[DEPTH] upperProof;
    }

    error TreeFull();

    /// @dev Append one leaf. The caller enforces ordering; this only hashes.
    function append(Tree storage t, bytes32 leaf) internal {
        uint256 size = t.count + 1;
        if (size > CAPACITY) revert TreeFull();
        t.count = size;
        bytes32 node = leaf;
        for (uint256 h = 0; h < DEPTH; h++) {
            if (size & 1 == 1) {
                t.branch[h] = node;
                return;
            }
            node = keccak256(abi.encodePacked(t.branch[h], node));
            size >>= 1;
        }
    }

    /// @dev The root over `count` leaves with every unused position a zero subtree.
    function root(Tree storage t) internal view returns (bytes32 node) {
        uint256 size = t.count;
        bytes32 zero = bytes32(0);
        for (uint256 h = 0; h < DEPTH; h++) {
            if (size & 1 == 1) node = keccak256(abi.encodePacked(t.branch[h], node));
            else node = keccak256(abi.encodePacked(node, zero));
            zero = keccak256(abi.encodePacked(zero, zero));
            size >>= 1;
        }
    }

    /// @dev Is `leaf` at `index` under `expected`? Standard path walk, the bit of `index` at each
    ///      height saying which side the sibling is on.
    function verify(bytes32 expected, bytes32 leaf, uint256 index, bytes32[DEPTH] calldata proof)
        internal
        pure
        returns (bool)
    {
        if (index >= 2 ** DEPTH) return false;
        bytes32 node = leaf;
        for (uint256 h = 0; h < DEPTH; h++) {
            if ((index >> h) & 1 == 1) node = keccak256(abi.encodePacked(proof[h], node));
            else node = keccak256(abi.encodePacked(node, proof[h]));
        }
        return node == expected;
    }

    /// @notice Does `adj` show that `key` is not among the tree's leaves?
    /// @dev Sound only because the leaves are strictly ascending, which the caller guarantees on
    ///      append. An empty tree contains nothing and needs no witness at all.
    function absent(Tree storage t, uint256 key, Adjacency calldata adj) internal view returns (bool) {
        uint256 count = t.count;
        if (count == 0) return true;
        if (adj.index >= count) return false;
        bytes32 r = root(t);

        if (!verify(r, bytes32(adj.lower), adj.index, adj.lowerProof)) return false;

        if (adj.index == 0 && key < adj.lower) return true;
        if (adj.index + 1 == count && key > adj.lower) return true;
        if (adj.index + 1 >= count) return false;
        if (!(adj.lower < key && key < adj.upper)) return false;
        return verify(r, bytes32(adj.upper), adj.index + 1, adj.upperProof);
    }
}
