// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IncrementalMerkle} from "../src/lib/IncrementalMerkle.sol";

/// @notice The tree, against a reference that keeps every leaf and every layer.
///
/// @dev The library keeps 32 words and a count. A bug in it would not revert; it would accept a
///      wrong proof or reject a right one, quietly, and the first person to find out would be a
///      refuter whose valid refutation bounced — or a claimant slashed for a member they had
///      appended. So the reference here is the slow, obvious thing: every leaf in an array, every
///      layer rebuilt from scratch, and a proof read straight out of those layers. The library has
///      to agree with it on every root and every proof, for every set the fuzzer can make.
contract IncrementalMerkleTest is Test {
    using IncrementalMerkle for IncrementalMerkle.Tree;

    IncrementalMerkle.Tree internal tree;
    uint256[] internal keys;

    // A literal: solc only takes a literal-backed constant as an array length, not one read
    // through a library. The library asserts it is the same number below.
    uint256 constant DEPTH = 32;

    // ------------------------------------------------------------------
    // Reference: layers rebuilt from all the leaves, no cleverness
    // ------------------------------------------------------------------

    function _zeros() internal pure returns (bytes32[DEPTH + 1] memory z) {
        for (uint256 h = 1; h <= DEPTH; h++) {
            z[h] = keccak256(abi.encodePacked(z[h - 1], z[h - 1]));
        }
    }

    /// @dev Node at (height, position), with positions past the leaves being zero subtrees.
    function _node(uint256 h, uint256 pos, bytes32[DEPTH + 1] memory z) internal view returns (bytes32) {
        if (h == 0) return pos < keys.length ? bytes32(keys[pos]) : bytes32(0);
        // Whole subtree empty? Then it is the zero hash for that height.
        if ((pos << h) >= keys.length) return z[h];
        return keccak256(abi.encodePacked(_node(h - 1, pos * 2, z), _node(h - 1, pos * 2 + 1, z)));
    }

    function _referenceRoot() internal view returns (bytes32) {
        return _node(DEPTH, 0, _zeros());
    }

    function _proofFor(uint256 index) internal view returns (bytes32[DEPTH] memory p) {
        bytes32[DEPTH + 1] memory z = _zeros();
        uint256 pos = index;
        for (uint256 h = 0; h < DEPTH; h++) {
            p[h] = _node(h, pos ^ 1, z);
            pos >>= 1;
        }
    }

    /// @dev The honest adjacency proof for `k` against the current keys, or `found = true`.
    function _adjacency(uint256 k) internal view returns (IncrementalMerkle.Adjacency memory adj, bool found) {
        uint256 n = keys.length;
        if (n == 0) return (adj, false);
        // First position whose key is >= k.
        uint256 i = 0;
        while (i < n && keys[i] < k) i++;
        if (i < n && keys[i] == k) return (adj, true);
        if (i == 0) {
            adj.index = 0;
            adj.lower = keys[0];
            adj.lowerProof = _proofFor(0);
        } else if (i == n) {
            adj.index = n - 1;
            adj.lower = keys[n - 1];
            adj.lowerProof = _proofFor(n - 1);
        } else {
            adj.index = i - 1;
            adj.lower = keys[i - 1];
            adj.lowerProof = _proofFor(i - 1);
            adj.upper = keys[i];
            adj.upperProof = _proofFor(i);
        }
    }

    /// @dev Strictly ascending keys, the way the registry guarantees them.
    function _seed(uint256 seed, uint256 n) internal {
        delete keys;
        uint256 last = 0;
        for (uint256 i = 0; i < n; i++) {
            uint256 step = 1 + (uint256(keccak256(abi.encode(seed, i))) % 1000);
            last += step;
            keys.push(last);
            tree.append(bytes32(last));
        }
    }

    // ------------------------------------------------------------------
    // The library agrees with the reference
    // ------------------------------------------------------------------

    function testFuzz_rootMatchesTheReference(uint256 seed, uint8 n) public {
        _seed(seed, n);
        assertEq(tree.count, n, "count");
        assertEq(tree.root(), _referenceRoot(), "root");
    }

    function test_theDepthHereIsTheLibrarys() public pure {
        assertEq(DEPTH, IncrementalMerkle.DEPTH);
    }

    function test_emptyTreeRootIsTheZeroSubtree() public view {
        assertEq(tree.count, 0);
        assertEq(tree.root(), _zeros()[DEPTH]);
    }

    function testFuzz_everyMemberVerifiesAtItsIndexAndNowhereElse(uint256 seed, uint8 n, uint8 pick, uint8 other)
        public
    {
        vm.assume(n > 0);
        _seed(seed, n);
        uint256 i = pick % n;
        bytes32 r = tree.root();
        assertTrue(this.verifyAt(r, bytes32(keys[i]), i, _proofFor(i)), "member verifies at its index");
        uint256 j = other % n;
        if (j != i) {
            assertFalse(this.verifyAt(r, bytes32(keys[i]), j, _proofFor(i)), "same proof, wrong index");
            assertFalse(this.verifyAt(r, bytes32(keys[j]), i, _proofFor(i)), "wrong leaf, right index");
        }
    }

    // ------------------------------------------------------------------
    // Absence: what a refuter can and cannot show
    // ------------------------------------------------------------------

    function testFuzz_anHonestAdjacencyShowsAbsenceExactlyWhenTheKeyIsAbsent(uint256 seed, uint8 n, uint256 k) public {
        _seed(seed, n);
        k = bound(k, 0, n == 0 ? 10 : keys[n - 1] + 500);
        (IncrementalMerkle.Adjacency memory adj, bool found) = _adjacency(k);
        if (n == 0) {
            assertTrue(this.absentOf(k, adj), "an empty set holds nothing");
            return;
        }
        if (found) {
            // There is no honest adjacency for a member; the best a refuter can do is lie, and
            // every lie is tried below.
            return;
        }
        assertTrue(this.absentOf(k, adj), "honest adjacency accepted");
    }

    function testFuzz_noAdjacencyShowsAMemberAbsent(uint256 seed, uint8 n, uint8 pick, uint8 at) public {
        vm.assume(n > 0);
        _seed(seed, n);
        uint256 k = keys[pick % n];
        // Every shape a refuter could try, with real proofs for the leaves they name.
        uint256 i = at % n;
        IncrementalMerkle.Adjacency memory adj;
        adj.index = i;
        adj.lower = keys[i];
        adj.lowerProof = _proofFor(i);
        if (i + 1 < n) {
            adj.upper = keys[i + 1];
            adj.upperProof = _proofFor(i + 1);
        }
        assertFalse(this.absentOf(k, adj), "a member shown absent with real neighbours");

        // And with the neighbours' keys swapped for the member itself, which is the obvious forgery.
        adj.lower = k;
        assertFalse(this.absentOf(k, adj), "a member shown absent by naming itself as lower");
    }

    function testFuzz_aForgedNeighbourDoesNotVerify(uint256 seed, uint8 n, uint256 k, uint256 fake) public {
        vm.assume(n > 1);
        _seed(seed, n);
        k = bound(k, 1, keys[n - 1] + 500);
        (IncrementalMerkle.Adjacency memory adj, bool found) = _adjacency(k);
        vm.assume(!found);
        // Move the lower neighbour to a value that is not in the tree at that index.
        vm.assume(fake != adj.lower);
        adj.lower = fake;
        assertFalse(this.absentOf(k, adj), "a lower bound the tree does not hold at that index");
    }

    function test_theTreeRefusesTheLeafPastCapacity() public {
        tree.count = IncrementalMerkle.CAPACITY;
        vm.expectRevert(IncrementalMerkle.TreeFull.selector);
        this.appendOne(bytes32(uint256(1)));
    }

    // ------------------------------------------------------------------
    // External shims so calldata-typed library functions can be called from memory
    // ------------------------------------------------------------------

    function verifyAt(bytes32 r, bytes32 leaf, uint256 index, bytes32[DEPTH] calldata proof)
        external
        pure
        returns (bool)
    {
        return IncrementalMerkle.verify(r, leaf, index, proof);
    }

    function absentOf(uint256 k, IncrementalMerkle.Adjacency calldata adj) external view returns (bool) {
        return tree.absent(k, adj);
    }

    function appendOne(bytes32 leaf) external {
        tree.append(leaf);
    }
}
