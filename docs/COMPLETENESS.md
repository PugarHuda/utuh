# The completeness hole, in code that already exists

A diagnostic, not an accusation. Every contract discussed here is correct about what it claims;
the point is what none of them can claim, because the protocol underneath cannot express it.

If you are building a fact registry, a credit score, a reputation layer or a lending market on the
Attestcoin Protocol, this document is three questions to ask your own contract, and one worked
example from code neither of us wrote.

---

## The three questions

**1. Who chooses which proofs arrive?**

The Block Prover verifies a transaction that happened. It has nothing to say about a transaction
that was never submitted. If the party who benefits from a fact is also the party who submits it,
then your contract sees a filtered view and cannot tell a filtered view from a complete one — every
proof in it verifies.

**2. Does any sentence in your product have the shape "this address has never …"?**

_Never liquidated. No defaults. Clean record. No adverse events._ These are statements about
events that do not exist. An inclusion proof can only speak about events that do. If a number in
your product is computed as though such a sentence were established, the number inherits the gap
whether or not the code mentions it.

**3. When a negative fact has to be settled, what settles it?**

This is the question that finds the hole fastest, because the answer is usually visible in one
function signature. If it is an owner key, a multisig, an oracle address, or an off-chain job with
a private key, then the protocol proved everything else in your system and a person decided that
one. That is not automatically wrong. It is worth knowing that it is what happened.

---

## A worked example: Creditcoin's own loan flow

`gluwa/attestcoin-protocol-examples`, commit `6668487ad07f` (2026-09-02),
`loan/contracts/sol/ASCLoanManager.sol` — the reference cross-chain loan the docs point newcomers
at. It is a good example, which is exactly why it is the useful one.

Every positive fact in it is cryptographic. `_noteLoanRepayment` (line 180) accepts a repayment
only through a Block Prover proof, checks the emitting contract against a registered address,
checks `topics[0]` against the event signature, and decodes the amount out of verified bytes. A
borrower cannot invent a repayment. The comment above `_processRepayLogs` says why the emitter
check is there, in the authors' own words: without it "anyone could deploy a contract that emits a
LoanRepaid event with an arbitrary loanId/amount and prove it to fraudulently repay loans." That is
careful work.

Now the one adverse outcome the flow has. A borrower who does not repay:

```solidity
function markLoanAsExpired(uint256 loanId) external onlyOwner {
```

Line 208. The only bad thing that can happen to a lender in the canonical example is settled by an
owner key.

**This is not a flaw in the example.** It is the protocol's shape showing through. Repayment is a
transaction that exists and can be proven. Default is the absence of one, and there was nothing in
the protocol to resolve it with, so the authors resolved it the only way that was available. Any
contract that needed the same sentence in 2026 reached the same place.

A second, softer observation from the same file. `_processRepayLogs` (line 274) takes
`repayLogs[0]` and moves on:

> // For this demonstration we only process the first repay log found within a transaction.
> // We only expect a single repay log to exist per transaction anyways

That is a statement about a **set** — that this transaction holds one such log and not two —
asserted rather than proven, and the authors flag it themselves as a demonstration simplification.
It is a smaller cousin of the same problem one level down: not "which transactions were submitted"
but "which logs within one were looked at". Per-proof binding of that kind is a real and separate
concern, and it is not what this document is about.

---

## What Utuh puts in that place

`UtuhCredit` has the same adverse outcome and no owner:

```solidity
/// @dev No proof is required and none exists to give. The contract is not asserting that a
///      payment was missed — it is recording that the borrower, who alone could have proven
///      otherwise, did not.
function markDefault(uint256 lineId) external {
```

`src/UtuhCredit.sol:862`. Anyone may call it; nobody has to. An overdue line that nobody marked is
still `Active`, and `Active` already blocks the next line, so the guard holds even when no one
volunteers the gas. Grep either contract in this repository for `onlyOwner`, `Ownable`, `owner` or
`onlyRole` and the result is empty — there is no administrator in the system at all.

That handles a negative fact the borrower alone could have refuted. The harder case is a negative
fact about a stranger's whole history — _this address has never been liquidated on Aave_ — and
that is what `UtuhRegistry` is for. A claimant bonds the assertion that a set of in-scope events is
complete; every member is verified by the Block Prover on the way in, so the set cannot be padded;
and anyone who proves one in-scope event the claim omits takes half the bond and voids the claim.
Presence stays cryptographic. Absence becomes economic.

It is worth being exact about what that buys, because the distinction is load-bearing:
**completeness here is economic, not cryptographic.** A bond makes lying expensive. It does not
make it impossible.

---

## Closing it in your own contract

Your contract holds no proofs and never calls `0x0FD2`. It reads one boolean:

```solidity
if (!REGISTRY.isUsable(claimId, exposure)) revert NotUnderwritten();
```

`isUsable` is true only for a claim that reached `Status.Finalized` — its challenge window closed
with nobody breaking it — and whose `enforceableLoss` is at least the exposure you are about to
take. Sizing against `enforceableLoss` rather than the posted bond is the part most integrations
get wrong on the first read; [INTEGRATING.md](INTEGRATING.md) is the whole thirty-line version,
with a working consumer compiled and tested in `test/Consumer.t.sol`.

Two things that document will tell you and this one should not bury:

- **You choose the scope, and the scope is the claim.** A claim covers one event signature from one
  contract. A spotless Aave record says nothing about Compound unless you asked about Compound.
- **You are the watcher of last resort.** A line opens only on a finalized claim, so the challenge
  window is your diligence window and the loss from a false clean claim is yours. Half the bond is
  a rebate on work you had to do, not a wage that has to clear. The console at
  <https://utuh.vercel.app/> sweeps and refutes from a browser with no backend, and `npx utuh-mcp`
  puts the same role behind the Model Context Protocol, so holding it costs a tab or an agent
  rather than a team.

---

## If you disagree

The claim in this document is falsifiable and the addresses are public. If your registry closes the
gap some other way, that is a better answer than this one and worth writing down. If it does not
and you would rather it did, the integration is a boolean and an interface.

Two live examples to read rather than take on trust — the console renders each of these from
Creditcoin directly:

- A claim sealed one event short, found and broken from a browser:
  <https://utuh.vercel.app/?claim=5>
- A false "never liquidated" claim over 216,000 blocks of Ethereum mainnet, refuted by one
  liquidation proof: <https://utuh.vercel.app/?deployment=mainnet&claim=20>
