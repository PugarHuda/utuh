# Using UtuhRegistry from your own contract

Utuh is two things, and this document is about the first one.

`UtuhCredit` is an application. `UtuhRegistry` is infrastructure: it answers one question, for any
contract on Creditcoin, about any class of source-chain event.

> Was a bonded assertion that this set of events is **complete** left standing — and how much was
> at stake while anyone could have broken it?

The Attestcoin Protocol already proves that a transaction happened. What it cannot prove is that a
set is complete, because whoever submits proofs chooses which proofs to submit. If your contract
needs a sentence of the form _"this address has never …"_, no number of inclusion proofs will get
you there, and this registry is one way to get the rest of the way.

You do not need to understand Merkle proofs, continuity proofs, or the precompiles to consume it.
Your contract holds no proofs and never calls `0x0FD2`.

---

## The whole integration

`test/Consumer.t.sol` contains a working consumer called `Gate`, compiled and tested in this
repository so that nothing here is a claim about code that does not exist. It is about thirty
lines. Three of them matter:

```solidity
UtuhRegistry.Claim memory c = REGISTRY.claim(claimId);

// 1. Is this claim about the subject you are asking about?
if (c.scope.topics[0] != bytes32(uint256(uint160(subject)))) revert WrongSubject(subject);

// 2. Is the set empty — that is, did nothing adverse happen?
if (REGISTRY.memberCount(claimId) != 0) revert NotClean(...);

// 3. Was it backed by at least what you are about to risk?
if (!REGISTRY.isUsable(claimId, exposure)) revert NotBackedEnough(claimId, exposure);
```

### 1. Pin the scope

A claim carries the `EventScope.Scope` it was opened with: chain key, emitting contract, event
signature, up to three indexed topics, and how each matching event is counted. Every field is
stored, so you can check it.

Checking the subject topic is the minimum. In most integrations you should rebuild the entire scope
you expect and compare identities, the way `UtuhCredit.expectedScope` does:

```solidity
bytes32 want = EventScope.id(myExpectedScope(subject));
if (EventScope.id(c.scope) != want) revert ScopeMismatch(want, EventScope.id(c.scope));
```

Otherwise a claimant can hand you a perfectly valid, perfectly finalized claim about a _different_
contract's events, or a different address, and every check below it will pass.

### 2. Decide what the set means

- **Empty set** — "nothing of this kind happened in this range". `memberCount(claimId) == 0`.
  This is the assertion an inclusion proof can never make, and the reason the registry exists.
- **Non-empty set** — `claim.aggregate` is the sum of the scope's metric over its members. Every
  member was verified by the Block Prover on the way in, so the aggregate is a **floor** on what
  really happened, never a ceiling on what was asserted.

Count members rather than reading the aggregate when you mean "nothing happened". A `DATA_WORD`
scope over an adverse event that happened to carry a zero amount would sum to nothing while the
event sat in the set.

### 3. Size it against `enforceableLoss`, not the bond

This is the step consumers get wrong.

`enforceableLoss(claimId)` is what a false claim costs its author _no matter what they do about
it_. It is not the bond. A claimant who sees a refutation coming can send their own from a second
address and take the refuter's share back; the part they cannot recover is the part that is burned.

`isUsable(claimId, exposure)` is `Finalized && enforceableLoss >= exposure`. Only you know what you
are about to risk, so only you can size it — the registry cannot do it for you.

If your exposure is larger than any single claim's enforceable loss, that is the registry telling
you the truth: nobody has staked enough for you to rely on this. Ask for a larger bond, or lend
less.

---

## What you also have to decide

**How long a window you will accept.** Each claimant picks their own challenge window above the
registry's floor. A claim exposed for 20 blocks is worth much less than one exposed for a day, at
the same bond. Read `claim.challengeWindow` and set a minimum — `UtuhCredit.MIN_UNDERWRITING_WINDOW`
does exactly this.

**How stale the range may be.** A spotless year that ended the day before the liquidation that
ruined them is still a spotless year. Compare `claim.toBlock` against
`CHAIN_INFO.get_latest_attestation_height_and_hash(chainKey).height`.

**How much history is enough.** A clean claim over a short window is cheap to keep clean and says
almost nothing. `claim.toBlock - claim.fromBlock` is the span.

**Whether one claim can be spent twice.** Claims are the registry's; nothing stops the same
finalized claim being presented to you and to somebody else. If that matters, record what you have
consumed — `UtuhCredit` keeps `claimSpent`, and a watermark per subject so that a _range_ of
history, not just a claim id, is consumed by the thing that rested on it.

**Who is allowed to present it.** Reading a public history is not the same as owning it. If the
claim is about somebody's address and the benefit goes to a caller, you need a binding between the
two — `UtuhCredit.proveControl` is one way: an ordinary source-chain transaction from the subject
whose calldata is a tag and the Creditcoin account, with the sender read out of proven bytes.

---

## If you are the second lender

`UtuhCredit` keeps `defaultsOf(address) → uint64`: how many of its own lines that subject walked
away from and has not made good. It is the one fact a lender is willing to answer for out loud, and
it is read rather than reported — the contract that extended the credit is the only thing that can
speak for its own books.

That makes cross-lender checking a constructor argument rather than an institution. Name the peers
whose word you take, and `openLine` refuses a subject who is in default at any of them:

```solidity
interface IDefaultsElsewhere {
    function defaultsOf(address subject) external view returns (uint64);
}
```

There is deliberately no shared bureau to write to. A registry anyone may report into is a
blacklist with extra steps — deploy a contract, report a rival's borrower, done — and every fix for
that is a permission. Naming your own peers keeps the trust explicit and one-directional: a hostile
peer can only refuse you credit you were not going to extend, and a lender that names nobody is
affected by nobody.

If you expose `defaultsOf` from your own contract with the same meaning, other lenders can name you
back. That is the whole protocol.

---

## What it costs

Nothing, for the consumer. Every call above is a `view` against a contract on Creditcoin.

The cost sits with the claimant, who pays gas to append each proven event and posts a bond — and
with whoever refutes, who spends gas on one proof and takes half the bond. Measured on CC3 Testnet,
an append is about `290,899 + 1.5 × calldata gas + 81,427 per member` over the 56 appends measured
so far; the dominant term is the size of the transactions being proven, and the per-member term is
the one the data pins down least. `npm run gas` refits it from the registry's own receipts.

---

## Who this is for

Anything that wants a sentence about events that did not happen:

- an airdrop that excludes addresses ever slashed on another chain
- a DAO seat that requires never having been liquidated
- a market maker admitting counterparties with no failed settlements
- insurance underwriting on a claims history
- and lending, which is what `UtuhCredit` does with it

The registry does not know or care which. A scope is a scope.

---

## Getting a claim built

Your users need finalized claims to hand you, and building one means sweeping the source chain,
fetching proofs and appending them. That is what `offchain/lib/claims.ts` does, and
`offchain/lib/scope.ts` is the sweep — both are importable, and the browser console in `web/` uses
the same sweep to check claims rather than to build them.

The thing to tell your users: **build the claim from more than one source-chain endpoint**. A
claimant who sweeps with a single RPC is betting their bond on that node having mentioned every
log, and a missed event is not a smaller claim — it is an incomplete one, and being slashed for it
looks exactly like lying.

## Addresses

CC3 Testnet, chain id 102031. The deployed registries are listed in the
[README](../README.md#deployed-on-cc3-testnet-chain-id-102031), all verified on Blockscout. A
registry is not upgradeable and holds no admin key; deploying your own with a different
`MIN_CHALLENGE_WINDOW` costs one transaction if you want a floor of your own.
