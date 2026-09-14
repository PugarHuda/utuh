# Audit package

What an external reviewer needs on day one, written down so the engagement starts at the code
rather than at a call. This is the part of "an external audit" that the project can produce on its
own; the report is the part it cannot.

## Scope

| Contract | Lines | Role | Holds value |
| --- | --- | --- | --- |
| `src/UtuhRegistry.sol` | 532 | bonded completeness claims; the only contract that calls `0x0FD2` | yes — bonds, refuter rewards, `burned` |
| `src/UtuhCredit.sol` | 890 | credit lines underwritten on registry claims | yes — lender funding, draws, repayments |
| `src/lib/EventScope.sol` | 100 | which source-chain events a claim covers, and the ordering key | no |
| `src/source/SettlementLedger.sol` (Sepolia) | 54 | the source-chain side of a repayment | transient — forwards in the same call |
| `src/interfaces/IBlockProver.sol`, `IChainInfo.sol` | — | the precompiles at `0x0FD2` / `0x0FD3` | — |

Out of scope: `offchain/`, `web/`, the MCP server. They build and submit; they cannot make the
contracts accept something the contracts would refuse. A finding there is a finding about what a
claimant or watcher *can be tricked into doing*, which is real but is a different engagement.

Compiler `0.8.28`, Foundry pinned to `1.8.0` in every workflow. Every published address is a full
match on Sourcify against this exact tree, so a reviewer reads what is deployed.

## Trust model

- **`0x0FD2` and `0x0FD3` are trusted.** They are Substrate runtime natives with no bytecode; the
  contracts assume a verified proof means the transaction is in an attested source block. The
  attestor set (4 active, quorum 3 on testnet) is the protocol's trust root, not this project's.
- **No administrator.** Neither contract has an owner, a role, an upgrade path or a pause. Grep
  `onlyOwner|Ownable|owner|onlyRole|AccessControl` across `src/` — empty. Every state transition is
  reachable by an unprivileged caller who satisfies the guard.
- **Claimants are adversarial.** They choose what to submit and are assumed to omit whatever hurts
  them. The design accepts this and bonds it.
- **Refuters are adversarial too.** A refutation has to prove an *in-scope* event the claim omits;
  the contract re-runs scope matching and `value()` on the proven log so a refuter cannot slash an
  honest claimant with an event they could not have appended (`refute`, the `c.scope.value(log)`
  line and its comment).
- **Source-chain endpoints are untrusted and can lie by omission.** That is the problem the layer
  exists for, one level down, and is a known limit rather than a finding.

## Invariants

Enforced by `test/RegistryInvariant.t.sol` over random sequences of four actors, and by the
symbolic suites over every input:

| Invariant | Where |
| --- | --- |
| every wei that entered is either a live bond, withdrawable, or `burned` | `invariant_everyWeiIsAccountedFor` |
| a refuted claim holds nothing | `invariant_aRefutedClaimHoldsNothing` |
| `enforceableLoss` equals the share that burns, never the bond | `invariant_enforceableLossIsTheBurnedShare` |
| members of a claim are strictly ascending by key | `invariant_membersStayOrdered` |
| `burned` never decreases | `invariant_burnedOnlyGrows` |
| the credit contract's balance equals `available`; `funded − withdrawn == available + Σ drawn` | `test/CreditInvariant.t.sol` |
| `drawn <= limit` on every line; a drawn line has a deadline and owes something, an undrawn one has neither | `test/CreditInvariant.t.sol` |
| at most one `Active` line per subject, and `activeLineOf` names it; `defaultsOf` equals the count of `Defaulted` lines | `test/CreditInvariant.t.sol` |
| `underwrittenThrough` and `settledThrough` only advance | `test/CreditInvariant.t.sol` |
| ordering key is injective and chronological over all `(height, txIndex, logIndex)` | `EventScopeKey.symbolic.t.sol`, halmos |
| backing is never short of the limit; every draw owes something | `CreditRounding.symbolic.t.sol`, halmos |
| with both contracts driven at once: bonds are conserved, no line exceeds ten times the enforceable loss behind it, no refuted claim backs a line, the watermarks only advance | `test/UtuhProperties.t.sol` (forge invariants); the same four as medusa properties in `test/medusa/UtuhProperties.sol` |

Properties that are *not* invariants and a reviewer should not expect: completeness of a finalized
claim (economic, not cryptographic — see Known limits), and refuter income (front-runnable by the
claimant, priced rather than prevented).

## Where to look first

Ranked by what a bug there would cost.

1. **`UtuhRegistry.refute`** — the only path that moves a bond to a stranger. Check that
   `_verifyOne` cannot be satisfied by a proof for a different scope, a different chain key, a
   block outside `[fromBlock, toBlock]`, or a reverted transaction; that `_contains` cannot be made
   to return false for a present key; that `_pay` cannot reenter into a second reward.
2. **`UtuhRegistry.appendBatch`** — where members enter. Check that the ordering guard
   (`k <= lastKey` reverts) cannot be bypassed across batches, that `aggregate` cannot be inflated
   by a log the scope should reject, and that the batch cap counts queries not transactions.
3. **`UtuhCredit.openLine`** — where two claims become money. Ten guards, and since 2026-09-13
   every refusal in `openLine`, `draw`, `settle`/`cure`, `closeLine`, `markDefault`, `appendBatch`
   and `refute` has a test that makes it fire (`test/Audit.t.sol`); the CI branch floor of 70% is
   a regression guard, not the coverage. Check `_requireFreshHistory`
   (one stretch of history, one line), `_requireScope` (both claims about the same subject and
   range), `_checkClean` (the cap is the *weakest* clean claim), and `_spend` (a claim funds one
   line).
4. **`UtuhCredit.markDefault` / `cure` / `_requireNotInDefault`** — default on silence, cured
   late on the original terms, peers' defaults honoured by read. Check that a cure cannot be
   satisfied by a repayment proof for someone else's line, and that a peer contract returning
   garbage cannot brick `openLine` for everyone. The honest answer to the last one: a peer whose
   `defaultsOf` reverts *does* block every `openLine` at the lender that named it
   (`test_aPeerThatRevertsBlocksEveryLine`). Peers are immutable and a `UtuhCredit` peer's getter
   cannot revert, so the mitigation is naming only `UtuhCredit` deployments — which the
   constructor's code-length check does not enforce.
5. **`proveControl`** — binding an address to an account from verified calldata. Check that the
   commitment cannot be replayed for a different account or chain.

## What is already known and is not a finding

`README.md` § Known limits, in full. The ones a reviewer will otherwise report:

- Completeness is economic, not cryptographic.
- A claimant can front-run a refutation from a second address and keep half; `enforceableLoss`
  is the guarantee for exactly that reason.
- Honest claims pay watchers nothing; the lender is the watcher of last resort.
- Claim size is bounded by the storage array; the incremental-Merkle replacement is specified in
  `ROADMAP.md`.
- Writability is not live; a default is recorded, not enforced on Ethereum.
- **A finalized claim is not reserved by the lender that relies on it.** The registry's `isUsable`
  is stateless and `claimSpent` / `underwrittenThrough` are per `UtuhCredit` deployment
  (`src/UtuhCredit.sol:188`, `:211`), so one volume-and-clean pair opens a full line at every
  lender that accepts it. Each lender's cap holds for its own line; nothing bounds the sum, while
  a liar loses the burned half of one bond once. Pinned by
  `test_oneClaimPairUnderwritesALineAtEveryLender`. A registry-level reservation would fix it and
  is an ABI change — `ROADMAP.md`.
- The constructor (`src/UtuhCredit.sol:343`) does not check `repayWindowBlocks` against the
  registry's `MIN_CHALLENGE_WINDOW`; a lender that sets it below the floor plus the time to build
  a claim has deployed a line nobody can repay in time. Lender-chosen, visible on-chain before any
  draw; the deployed policy is 5760 against a floor of 25. Pinned by
  `test_aRepayWindowShorterThanTheChallengeFloorCannotBeMet`.
- `draw` (`src/UtuhCredit.sol:712`) checks the limit and the slot, not the deadline: an overdue
  `Active` line nobody has marked can still be drawn up to its limit. Exposure stays bounded by
  the limit.

- **Two comments in `src/` are stale. Neither is a bug.** `src/UtuhCredit.sol:791-792` says a
  defaulted line still holds the subject's one slot when `cure` runs, but `markDefault` already gave
  the slot back (`:873`). The `@dev` on `defaultsOf` (`:234-235`) describes a borrower with two
  defaulted lines, which one lender cannot reach, because no line opens while a default stands. Both
  stay because `src/` is frozen: a comment changes the metadata hash, and every published address is
  a full Sourcify match against this tree. They are exactly why four of the seven equivalent mutants
  in `test/MUTATION.md` are equivalent.

Anything that makes one of these *worse than described* is a finding. Verified sound and pinned
by tests on the same day, so a reviewer need not re-derive them: reentrancy on every CTC path
(`refute`, `withdraw`, `abandon`, `draw`) pays a reentrant caller once; the window boundaries are
exact (`refute` allowed and `finalize` refused at `challengeUntil`, reversed one block later; the
same for `settle` and `markDefault` at `dueBlock`); the ordering guard refuses the same key twice
inside one batch; the binary search agrees with a linear scan under fuzzing, lower half included;
the chain key is part of scope identity, so a Sepolia claim cannot underwrite a mainnet spec; an
unsupported transaction type and a reverted source transaction are refused in both `appendBatch`
and `proveControl`. There are no `unchecked` blocks in `src/`.

## What the tools already say

`npm run check`: Slither at 0 findings across 10 contracts and 97 detectors, with five detectors
off and four line-level suppressions each explained beside the code; `forge lint`; 211 Foundry
tests (10 fuzzed, 16 invariants — 5 on the registry, 7 on the credit contract, 4 across both in
`test/UtuhProperties.t.sol`); halmos over the
ordering key and the roundings, 5 of 5 checks passing (the deep rounding proof takes about five
minutes). Line and branch coverage over `src/` are 100% (432/432 and 104/104) on 2026-09-14.
Mutation testing (Certora gambit 0.2.1) kills 730 of 737 mutants, 99.1%; the other 7 are equivalent,
each argued in `test/MUTATION.md`, and a reviewer who can kill one has a finding. A 30-minute medusa
campaign passed its 22 checks over 639,295 calls and caught both bugs planted in scratch copies of `src/`. `README.md` § What
the tools say lists every suppression and why. A reviewer disagreeing with a suppression is a
finding.

## Reproduction

```
git clone https://github.com/PugarHuda/utuh && cd utuh
npm ci && forge build
forge test            # 211 (`forge test --list` counts 224 functions; the summary counts each invariant contract once), no network, no key
npm run puretest      # 93 assertions on the classifiers, payload reader and watcher rules, no key
npm run judge         # every deployed claim measured live, no key
SOLC=<solc-0.8.28> WORKERS=4 bash test/mutation/run.sh <outdir>   # 738 gambit mutants, hours, not in CI
npm run livetest      # the full live suite against CC3 — needs a funded testnet key
```

Deployed addresses, verified: `README.md` § Deployed on CC3 Testnet.

## Reporting

`SECURITY.md`. Private first; credit in the fix.
