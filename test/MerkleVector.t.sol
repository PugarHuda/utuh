// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IncrementalMerkle} from "../src/lib/IncrementalMerkle.sol";
import {Adjacency} from "./support/Adjacency.sol";

/// @notice Three implementations of one tree have to agree before a proof is worth sending: the
///         library on chain, the Solidity reference the tests build witnesses with, and the
///         TypeScript in `offchain/lib/members.ts` that a watcher and the console actually use.
///         The constants below were computed by the TypeScript on the day this was written, for
///         the keys 1, 2, 3, 5, 8, 13 and the witness that 4 is absent. A drift in any of the
///         three shows up here as a wrong hash, not as a refutation that reverts on chain.
contract MerkleVectorTest is Test {
    using IncrementalMerkle for IncrementalMerkle.Tree;

    IncrementalMerkle.Tree internal tree;

    bytes32 constant ROOT = 0x448925097d6d32c3a12d6f08dbb43df1778b7d7192e63a33a49e70e400a92e05;
    bytes32 constant EMPTY = 0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757;
    bytes32 constant LP0 = 0x0000000000000000000000000000000000000000000000000000000000000005;
    bytes32 constant LP1 = 0xe90b7bceb6e7df5418fb78d8ee546e97c83a08bbccc01a0644d599ccd2a7c2e0;
    bytes32 constant LP31 = 0x8448818bb4ae4562849e949e17ac16e0be16688e156b5cf15e098c627c0056a9;

    function _keys() internal pure returns (uint256[] memory k) {
        k = new uint256[](6);
        k[0] = 1;
        k[1] = 2;
        k[2] = 3;
        k[3] = 5;
        k[4] = 8;
        k[5] = 13;
    }

    function test_theLibraryTheReferenceAndTheTypeScriptAgreeOnTheRoot() public {
        uint256[] memory k = _keys();
        for (uint256 i = 0; i < k.length; i++) {
            tree.append(bytes32(k[i]));
        }
        assertEq(tree.root(), ROOT, "library root");
        assertEq(Adjacency.root(k), ROOT, "reference root");
        assertEq(Adjacency.root(new uint256[](0)), EMPTY, "empty root");
    }

    function test_theWitnessTheTypeScriptBuildsIsTheOneTheReferenceBuilds() public pure {
        IncrementalMerkle.Adjacency memory adj = Adjacency.build(_keys(), 4);
        assertEq(adj.index, 2, "index");
        assertEq(adj.lower, 3, "lower");
        assertEq(adj.upper, 5, "upper");
        assertEq(adj.lowerProof[0], LP0, "sibling 0");
        assertEq(adj.lowerProof[1], LP1, "sibling 1");
        assertEq(adj.lowerProof[31], LP31, "sibling 31");
    }
}
