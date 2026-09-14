# Mutation testing and property campaigns

Coverage says a line ran. Mutation testing says a test would notice if that line were wrong.
This file records what that found in `src/UtuhRegistry.sol`, `src/UtuhCredit.sol` and
`src/lib/EventScope.sol`, and what the property campaign found about the four properties the
registry and the lender share.

Measured 2026-09-14 on Windows 11, forge 1.8.0, solc 0.8.28. Nothing here writes to `src/`: every
mutant is applied to a scratch copy of the repository. The deployed contracts are verified from these
exact source bytes.

## Mutation testing

**Tool:** Certora gambit 0.2.1 (`cargo install --git https://github.com/Certora/gambit`, commit 072ff4c6).

**Command:**

```
SOLC=/path/to/solc-0.8.28 WORKERS=4 bash test/mutation/run.sh <outdir> [git-rev-for-tests]
```

`test/mutation/run.sh` generates every gambit mutant of the three files. It then copies each mutant
over its original in a scratch copy and runs the whole suite with `forge test --fail-fast --fuzz-seed 0x1`.
A failing suite kills the mutant. A mutant that does not compile is *stillborn* and counts toward
neither side. The per-mutant results land in `<outdir>/results.tsv`.

**Before and after.**
- The before score ran every mutant against `test/` at 5548901, the suite as it stood when this work began.
- The after score re-runs only the before-run's survivors against the final suite.

That is exact, not an estimate. Between the two, only files under `test/` changed; no source, no
config. A mutant is killed when some test fails on it. Every old test is still present, and each
one that was edited checks strictly more than it did:
- `test_constructorRefusesZeroHistoryOrZeroStaleness` and `test_constructorRefusesTopicsOutsideOneToThree` now run all of their cases, not only the first (see the forge note below).
- `test_openLineRefusesAVolumeClaimWithTooShortAWindow` gives its clean claim a window the lender accepts, so the volume check is the only one that can refuse.
- `_rebindTo` takes the subject as a parameter; its one existing caller passes the same address it always used.

So no mutant the old suite killed can survive the new one.

### Result

| Run | Tests at | Mutants | Stillborn | Killed | Survived | Equivalent | Score | Score over killable mutants |
|---|---|---|---|---|---|---|---|---|
| Before | 5548901 | 738 | 1 | 692 | 45 | 7 | **93.9%** (692/737) | **94.8%** (692/730) |
| After | 0f6ae69 | 738 | 1 | 730 | 7 | 7 | **99.1%** (730/737) | **100%** (730/730) |

Per file:

| File | Mutants | Before: killed / survived | After: killed / survived | Equivalent |
|---|---|---|---|---|
| `src/lib/EventScope.sol` | 85 | 82 / 3 | 83 / 2 | 2 |
| `src/UtuhCredit.sol` | 410 | 385 / 25 | 406 / 4 | 4 |
| `src/UtuhRegistry.sol` | 243 (1 stillborn) | 225 / 17 | 241 / 1 | 1 |

- The before run took about 40 minutes on 4 workers, after 6 minutes of mutant generation.
- The survivors were re-run in three batches, against a276061, d95cbc3 and 0f6ae69, as their tests landed. The tests only grew between those commits.
- The stillborn mutant, UtuhRegistry-1, makes the constructor's floor check `if (true)`. The constructor then always reverts, and solc refuses to compile: immutables are read but never assigned, error 1284.

Over the same change, `forge coverage` on `src/` went from 98.08% to 100% of branches (104/104), and
from 99.77% to 100% of lines (432/432).

### What survived, and why

Every survivor is either an equivalent mutant or a missing assertion. Each missing assertion now has
a test that passes on the contract and fails on the mutant.

#### Equivalent mutants

No test can kill these, because no execution of the contract can tell them from the original.

| Mutant | Line | Change | Why it is equivalent |
|---|---|---|---|
| EventScope-1 | 39 | `(tx << 32) \| log` becomes `(tx << 32) + log` | `log` is a `uint32` and `tx << 32` has its low 32 bits clear. Adding numbers with no bits in common is the same as or-ing them. |
| EventScope-7 | 39 | `(h << 96) \| (tx << 32)` becomes `(h << 96) + (tx << 32)` | Same argument. `tx` is a `uint64`, so `tx << 32` stays below bit 96, where `h << 96` starts. |
| UtuhCredit-355 | 793 | `cure` stops writing `activeLineOf[l.subject] = 0` | `markDefault` has already zeroed the slot (line 873). While the line stands Defaulted, `defaultsOf` is at least 1, so `openLine` refuses the subject and nothing can refill the slot before `cure` runs. The store is dead. The comment beside it, "a defaulted line still held the subject's one slot", no longer matches `markDefault`. That is a comment-only discrepancy, and it is left in `src/` because the source is frozen. |
| UtuhCredit-360 | 798 | `defaultsOf[s] - 1` becomes `defaultsOf[s] % 1` | Both give 0 when `defaultsOf[s]` is 1, and at `cure` it is always exactly 1. Only an Active line can default, a subject has at most one Active line, and no line opens while a default stands. So at one lender `defaultsOf` only ever holds 0 or 1. `invariant_defaultsMatchTheBooks` walks that state space. The `@dev` on `defaultsOf` about "a borrower with two defaulted lines" describes a state this deployment cannot reach. |
| UtuhCredit-362 | 798 | `defaultsOf[s] - 1` becomes `1 - defaultsOf[s]` | Same reason: equal when the count is 1. |
| UtuhCredit-364 | 799 | `defaultsOf[s] = left` becomes `defaultsOf[s] = 0` | Same reason: `left` is always 0. |
| UtuhRegistry-241 | 528 | `_pay`'s `if (amount == 0) return` becomes `if (false) return` | `_pay` is never called with zero. `abandon` refunds a bond of at least `MIN_BOND` that nothing changes while the claim is Open. `refute` pays half a bond of at least 1 CTC. `withdraw` refuses zero before it calls. |

#### Missing assertions, now tested

| Mutant(s) | Line | What the mutant did | Why the suite missed it | Test that kills it |
|---|---|---|---|---|
| EventScope-50 | 62 | `mask & bit == 0` becomes `mask / bit == 0` | Every masked scope under test set bit 0, where the two agree. | `EventScopeTest.test_aRecipientOnlyScopeMatchesAnySender` |
| UtuhCredit-42, -43, -55 | 362, 364, 377 | Deleted `_requireSpec(repay)`; deleted `_requireSpec(clean[i])`; made `counterpartyTopic > 3` false | Every bad spec under test was the volume spec. Worse, the three multi-case constructor tests stopped at their first case: see the forge note below. | `AuditTest.test_constructorChecksTheRepaymentAndCleanSpecsToo`, and `test_constructorRefusesTopicsOutsideOneToThree` once it ran all of its cases |
| UtuhCredit-94, -109, -135, -141, -149, -150 | 527–539 | `expectedScope` writes chain key 1; uses `1 + (t-1)` or `(t-1) << 1` for `1 << (t-1)`; drops or zeroes the metric argument | Tests used topics 1 and 2 only, where the three shifts agree. They never read the chain key or the metric argument. | `UtuhCreditTest.test_expectedScopeIsExactForEveryTopicPair` |
| UtuhCredit-161, -162 | 565 | Deleted, or reversed, the volume claim's window floor | The refusal test gave the clean claim the same short window, so the clean check refused with the identical error. No claim ever carried more than its lender's floor. | `LifecycleTest.test_openLineRefusesAVolumeClaimWithTooShortAWindow` (clean claim now long enough), `AuditTest.test_aClaimWindowAboveTheLendersFloorIsAccepted` |
| UtuhCredit-168 | 573 | `span = to - from` becomes `to % from` | Every history started at block 1,000,000, where the two agree. | `AuditTest.test_historyStartingAtALowHeightIsMeasuredAsASpan` |
| UtuhCredit-184 | 579 | `limit = … / 10_000` becomes `… * 10_000` | Every line rested on 12 CTC of volume and was clamped to the clean claim's 10 CTC cap either way. | `AuditTest.test_aLineUnderTheCapIsExactlyWhatTheVolumeUnderwrites` |
| UtuhCredit-207, -208 | 592–593 | Deleted the clean claims' `_requireUsable`, or stopped its loop from running | `_checkClean`'s cap reads `enforceableLoss`, which also answers for Sealed claims. The not-finalized test only left the volume claim unfinished. | `AuditTest.test_openLineRefusesACleanClaimThatIsNotFinalized` |
| UtuhCredit-244 | 627 | Deleted the clean claim's scope check | The wrong-scope test only offered a wrong volume claim. | `AuditTest.test_openLineRefusesACleanClaimAboutAnotherSubject` |
| UtuhCredit-254 | 637 | The cap takes the last clean claim's backing instead of the smallest | Every lender listed one clean spec. | `AuditTest.test_theWeakerOfTwoCleanClaimsCapsTheLine` |
| UtuhCredit-373 | 820 | `claimSpent` check in `_applyRepayment` never reverts | For one subject the watermark always fires first, so the check was never reached. It is reachable across subjects when volume and repayment specs mirror each other. | `AuditTest.test_aClaimSpentByOneSubjectCannotRepayAnother` |
| UtuhCredit-374 | 826 | Deleted the repayment claim's `_requireUsable` | Every settlement used a finalized claim. | `AuditTest.test_settlingWithARepaymentClaimNotYetFinalizedIsRefused` |
| UtuhCredit-378, -379 | 832 | Deleted `claimSpent[repayClaimId] = true`, or wrote `false` | Nothing tried to reuse a repayment claim as the next line's volume claim, which is well-formed and starts exactly at the underwriting watermark. | `AuditTest.test_aRepaymentClaimCannotUnderwriteTheNextLine` |
| UtuhRegistry-64, -65, -66, -67, -68 | 265–267 | `_verifyBatch` zeroes or drops the heights, drops the transactions, or drops the Merkle paths it hands the prover | Every test mocks the batch verifier to answer true for any arguments. | `AuditTest.test_theBatchVerifierIsAskedAboutExactlyTheProofsSent` (`vm.expectCall` on the exact calldata) |
| UtuhRegistry-94, -95, -96 | 305 | `ClaimSealed` announces `sealedAt * window`, `/` or `%` instead of the sum | Nothing checked the event's arguments. | `AuditTest.test_sealingAnnouncesTheBlockTheWindowCloses` |
| UtuhRegistry-102, -103 | 316 | `abandon` leaves the bond in `claim.bond`, or sets it to 1 wei | The test checked the refund, not the books. The invariant handler rarely lands `abandon`, because its caller is a random actor. | `LifecycleTest.test_anOpenClaimCanBeAbandonedAndTheBondComesBack`; in the after run, `--fail-fast` stopped first at `UtuhPropertiesTest.invariant_bondsAreConserved`, which the new property harness catches it with |
| UtuhRegistry-120 | 356 | `refute` skips `scope.value(log)` | No refutation used an event the claimant could not have appended. | `AuditTest.test_anEventTheClaimantCouldNotHaveAppendedDoesNotRefute` |
| UtuhRegistry-134, -135 | 363 | `refute` leaves the bond standing after paying and burning it | The test checked the payout and `burned`, not `claim.bond`. | `LifecycleTest.test_oneOmittedEventBreaksTheClaimAndBurnsHalfTheBond` |
| UtuhRegistry-157, -158 | 385 | `finalize` leaves the bond standing after crediting it | The test checked the withdrawal, not `claim.bond`. | `LifecycleTest.test_aClaimAggregatesWhatItProvesAndReturnsItsBond` |
| UtuhRegistry-188 | 462 | `mid = (lo + hi) >> 1` becomes `(lo + hi) - 1` | This scans from the top instead of halving, and still answers correctly every time, so no correctness test can see it. But a claim large enough that the scan exceeds a block could not be refuted at all. | `AuditTest.test_membershipReadsLogarithmicallyManyMembers`, which counts storage reads: the mutant reads 129 slots on 64 members, and the contract at most 16 |

### A forge behaviour the mutants exposed

Under forge 1.8.0, `vm.expectRevert(...)` followed by `new Contract(...)` whose constructor reverts
ends the test at that line. The create's revert bubbles into the test's own frame, is accepted as
the expected revert, and nothing after it runs.

`test_constructorRefusesZeroHistoryOrZeroStaleness` and `test_constructorRefusesTopicsOutsideOneToThree`
were written as several `expectRevert` and `new` pairs. They passed while checking only their first
pair. Mutants UtuhCredit-43 and -55 deleted guards that only the later pairs exercise, and survived.

A probe confirmed it: a test ending in `revert("this line ran")` right after an expected constructor
revert passes. The same deployment through an external call on the test contract
(`this.deployCredit(...)`) returns control normally, and those tests now deploy that way. Every
other `expectRevert` and `new` pair in the suite is the last statement of its test, so it was unaffected.

## Property campaign

**Tool:** medusa 1.5.1 (the `medusa-win-x64` release binary).

**Harness:** `test/medusa/UtuhProperties.sol`, with its config in `test/medusa/medusa.json`. It drives the registry and the
lender together. Anyone opens, appends to, seals, refutes, abandons and finalizes claims, and the
borrower may offer any claim that exists, in any state, to `openLine`, `settle` and `cure`. The two
precompile answers are substituted by contracts placed at `0x0FD2` and `0x0FD3`, the same two answers
`LifecycleFixture` mocks. Everything else runs on the real Sepolia transaction bytes.

**Properties:**
- `property_bondsAreConserved`: the registry's balance is exactly escrowed bonds plus credited refunds plus burned, and the lender's balance is exactly `available`.
- `property_noLineExceedsTenTimesEnforceableLoss`: no line's limit exceeds `BOND_MULTIPLE` times the enforceable loss of either claim it opened on.
- `property_noRefutedClaimBacksALine`: every claim a line opened on, or was repaid with, is Finalized. Finalized is terminal, so no line ever rested on a refuted, sealed, open or abandoned claim.
- `property_watermarksOnlyAdvance`: `underwrittenThrough` and `settledThrough` never decrease.

The same four also run as forge invariants on every `forge test`, in `test/UtuhProperties.t.sol`.
That file also holds `test_everyMoveLands`, which walks every move once so the harness cannot pass
vacuously.

**Command:**

```
medusa fuzz --config test/medusa/medusa.json --timeout 1800 --workers 3
```

**Harness version:** the campaign ran on the harness as committed in 5548901. Commit 81b9404 then
moved the fixture transaction from a `bytes constant` into storage, because the constant was inlined
into runtime code and put the harness 614 bytes over EIP-170. No move and no property changed.

**Result:** 22 of 22 passed: the 4 properties, plus the 18 moves as assertion tests.
- Run: 29 min 57 s on 3 workers, 639,295 calls in 6,391 sequences, 2,730 branches reached.
- Failures: none.

**Does the harness catch a real bug?** Two bugs were planted, one at a time, in scratch copies of
`src/`, and the same config was run for up to 10 minutes on 2 workers:

| Planted bug | Property that failed | Found after | Shrunk to |
|---|---|---|---|
| `isUsable` without its `status == Finalized` check | `property_noRefutedClaimBacksALine` | 1,796 calls | 7 calls: a line settled on a claim that was only Sealed |
| `refute` burns the whole bond but still pays the refuter | `property_bondsAreConserved` | 9,342 calls | 16 calls |
