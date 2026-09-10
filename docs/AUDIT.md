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
| ordering key is injective and chronological over all `(height, txIndex, logIndex)` | `EventScopeKey.symbolic.t.sol`, halmos |
| backing is never short of the limit; every draw owes something | `CreditRounding.symbolic.t.sol`, halmos |

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
3. **`UtuhCredit.openLine`** — where two claims become money. Ten guards; `forge coverage` floors
   branches at 70% because these were the ones with no test. Check `_requireFreshHistory`
   (one stretch of history, one line), `_requireScope` (both claims about the same subject and
   range), `_checkClean` (the cap is the *weakest* clean claim), and `_spend` (a claim funds one
   line).
4. **`UtuhCredit.markDefault` / `cure` / `_requireNotInDefault`** — default on silence, cured
   late on the original terms, peers' defaults honoured by read. Check that a cure cannot be
   satisfied by a repayment proof for someone else's line, and that a peer contract returning
   garbage cannot brick `openLine` for everyone.
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

Anything that makes one of these *worse than described* is a finding.

## What the tools already say

`npm run check`: Slither at 0 findings across 10 contracts and 97 detectors, with five detectors
off and four line-level suppressions each explained beside the code; `forge lint`; 159 Foundry
tests (9 fuzzed, 5 invariants); halmos over the ordering key and the roundings. `README.md` § What
the tools say lists every suppression and why. A reviewer disagreeing with a suppression is a
finding.

## Reproduction

```
git clone https://github.com/PugarHuda/utuh && cd utuh
npm ci && forge build
forge test            # 159, no network, no key
npm run puretest      # 46 assertions on the classifiers and payload reader, no key
npm run judge         # every deployed claim measured live, no key
npm run livetest      # the full live suite against CC3 — needs a funded testnet key
```

Deployed addresses, verified: `README.md` § Deployed on CC3 Testnet.

## Reporting

`SECURITY.md`. Private first; credit in the fix.
