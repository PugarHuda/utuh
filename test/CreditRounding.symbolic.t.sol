// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UtuhRegistry} from "../src/UtuhRegistry.sol";
import {UtuhCredit} from "../src/UtuhCredit.sol";
import {CreditFixture} from "./support/CreditFixture.sol";

/// @notice Symbolic proofs of the two roundings that decide who absorbs a fraction.
///
/// @dev Both were wrong once, in the same direction, and both were found by reading rather than by
///      a test. `openLine` asked each claim to back `limit / BOND_MULTIPLE` and `settle` asked for
///      `drawn / BOND_MULTIPLE`; integer division rounds toward zero, so both asked for slightly
///      less than the amount implied — against the party carrying the risk. `_repaymentFor` had
///      always rounded up, so the contract was inconsistent with itself.
///
///      `forge test` fuzzes these. halmos proves them, which is the difference between no
///      counterexample found and no counterexample existing:
///
///        npm run symbolic:deep
contract CreditRoundingSymbolic is Test, CreditFixture {
    UtuhCredit internal credit;

    /// The multiplier, as a literal.
    ///
    /// Reading it from the contract makes the multiplication below nonlinear — two symbolic
    /// operands — and the solver times out rather than deciding. A literal keeps the arithmetic
    /// linear and the proof tractable, at the cost of assuming a value; `setUp` asserts that the
    /// contract agrees, so the assumption cannot go stale without failing here first.
    uint256 constant MULTIPLE = 10;

    function setUp() public {
        UtuhRegistry registry = new UtuhRegistry(25);
        UtuhCredit.HistorySpec[] memory clean = new UtuhCredit.HistorySpec[](1);
        clean[0] = _spec(3, 0);
        credit = new UtuhCredit(registry, _policy(), _spec(2, 0), clean, _spec(1, 2));
        // The literal above is only sound while the contract says the same thing.
        assert(credit.BOND_MULTIPLE() == MULTIPLE);
    }

    /// A limit is never backed by less than a BOND_MULTIPLE-th of itself.
    ///
    /// Assumed below `type(uint256).max / MULTIPLE`, above which the check's own multiplication
    /// overflows and there is no arithmetic left to state the claim in.
    ///
    /// These two take minutes, not seconds: `backingFor` divides, and 256-bit division is what the
    /// solver finds hard. Narrowing the input to `uint128` does not help, since the division
    /// happens at full width whatever the argument's declared type. So they run on the daily
    /// schedule with a ten-minute budget rather than on every push — `npm run symbolic:deep`.
    /// Measured: 467 seconds to decide, and it decides in favour.
    function check_backingIsNeverShortOfTheLimit(uint256 limit) public view {
        vm.assume(limit <= type(uint256).max / MULTIPLE);
        assert(credit.backingFor(limit) * MULTIPLE >= limit);
    }

    /// The other half of this property — that `backingFor` never overshoots by more than one unit
    /// — is **not** proved here, and it is worth saying why rather than leaving a gap.
    ///
    /// It was attempted twice: as `(backingFor(x) - 1) * MULTIPLE < x`, and restated as the
    /// equality `backingFor(x) == (x + MULTIPLE - 1) / MULTIPLE`, which needs no multiplication.
    /// The solver could not decide either within ten minutes. 256-bit division is where this stops
    /// being tractable, and narrowing the argument does not help since the division inside
    /// `backingFor` happens at full width whatever type the argument is declared.
    ///
    /// So it stays a fuzz property — `testFuzz_backingRequiredIsNeverLessThanALimitImplies` in
    /// test/UtuhCredit.t.sol checks both directions on 256 random draws a run. Sampled rather than
    /// proved, and this is the note that says so.

    /// Nothing is owed on nothing, and something is always owed on something. The second half is
    /// what stops a borrower drawing an amount small enough that the repayment rounds to zero.
    function check_everyDrawOwesSomething(uint256 amount) public view {
        vm.assume(amount > 0 && amount < type(uint128).max);
        assert(credit.repaymentFor(amount) > 0);
        assert(credit.repaymentFor(0) == 0);
    }
}
