// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {EventScope} from "../src/lib/EventScope.sol";

/// @notice Symbolic proofs of the ordering key, for `halmos`.
///
/// @dev Refutation rests entirely on one property: claim members are stored in strictly ascending
///      key order, so `_contains` can be a binary search the chain runs itself, with no witness a
///      claimant could withhold. If two distinct positions could ever produce the same key, or if
///      the key order could ever disagree with chronological order, a refuter could be told an
///      event is present when it is not — and the bond would be safe from a real omission.
///
///      `forge test` fuzzes that with 256 random draws per run. These are the same properties
///      checked exhaustively: halmos explores the whole input space symbolically and either
///      returns a counterexample or proves there is none. Run with:
///
///        halmos --contract EventScopeKeySymbolic
///
///      It is deliberately a separate file. halmos is a Python tool and not part of `npm run
///      check`, so nothing here is allowed to affect `forge test`, which is why every function is
///      named `check_` rather than `test_`.
contract EventScopeKeySymbolic is Test {
    /// The whole design in one line: chronological order and key order are the same order.
    function check_keyOrderMatchesChronologicalOrder(
        uint64 h1,
        uint64 tx1,
        uint32 log1,
        uint64 h2,
        uint64 tx2,
        uint32 log2
    ) public pure {
        uint256 k1 = EventScope.key(h1, tx1, log1);
        uint256 k2 = EventScope.key(h2, tx2, log2);

        bool earlier = h1 < h2 || (h1 == h2 && (tx1 < tx2 || (tx1 == tx2 && log1 < log2)));
        if (earlier) {
            assert(k1 < k2);
        } else if (h1 == h2 && tx1 == tx2 && log1 == log2) {
            assert(k1 == k2);
        } else {
            assert(k1 > k2);
        }
    }

    /// Two different positions cannot share a key. A collision would let a claim appear to contain
    /// an event it does not hold, which is the one thing `contains` must never say.
    function check_distinctPositionsHaveDistinctKeys(
        uint64 h1,
        uint64 tx1,
        uint32 log1,
        uint64 h2,
        uint64 tx2,
        uint32 log2
    ) public pure {
        vm.assume(h1 != h2 || tx1 != tx2 || log1 != log2);
        assert(EventScope.key(h1, tx1, log1) != EventScope.key(h2, tx2, log2));
    }

    /// `open` bounds a claim by block range, and refutation checks the key's height against it.
    /// The height has to survive the round trip for that bound to mean anything.
    function check_blockOfRecoversTheHeight(uint64 h, uint64 t, uint32 l) public pure {
        assert(EventScope.blockOf(EventScope.key(h, t, l)) == h);
    }
}
