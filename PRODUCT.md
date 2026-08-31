# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three roles meet at the same console, and none of them is a consumer.

- **Watchers** sweep a source chain looking for an in-scope event a claim left out, and refute it
  for half the bond. Adversarial, unpaid until they win, and the only reason the system's central
  claim holds. The console must let a stranger do this with no backend, no key, and no clone.
- **Claimants / borrowers** open a claim over a block range, append proven events, post a bond,
  wait out a challenge window, and draw a credit line against the history that survived.
- **Lenders and integrators** read a claim's standing before extending anything, or wire the
  registry into their own contract.

*(Inferred from README, docs/INTEGRATING.md and the console's own panes; not confirmed in
interview.)*

## Product Purpose

The Attestcoin Protocol proves a source-chain transaction happened. It cannot prove that a *set* of
events is complete, because whoever submits proofs chooses which proofs to submit and every one of
them verifies. Utuh closes that gap economically rather than cryptographically: a claimant bonds
the assertion that a set is whole, and anyone who finds one omitted in-scope event breaks the claim
and takes half the bond.

Success is a claim that survives a challenge window in public, and a credit line drawn against a
history nobody could refute.

## Positioning

The sentence every on-chain credit system needs — *this borrower has never been liquidated* — is a
statement about events that do not exist, and an inclusion proof can only speak about events that
do. Utuh is the layer that makes absence assertable, then builds undercollateralized credit on it.
A neighbouring project cannot truthfully copy this by adding another score: sixteen of the
thirty-nine entries in this hackathon compute a score over facts the chain already shows, and all
of them inherit the hole.

Completeness here is **economic, not cryptographic**. A bond makes lying expensive; it does not
make it impossible. That distinction is load-bearing and must never be overstated in copy.

## Operating Context

- Creditcoin CC3 Testnet (chain 102031, 15s blocks). Source chains: Ethereum mainnet (chainKey 3)
  and Sepolia (chainKey 1) — the only two attested.
- The console runs entirely in the visitor's browser. Every endpoint it touches is CORS-open, so it
  sweeps a source chain, fetches a proof and sends a refutation with no server of its own. The host
  serves bytes and holds nothing.
- Read paths work with an empty wallet; only claiming, refuting and borrowing need a key and CTC.
- Waits are real and long: challenge windows are measured in Creditcoin blocks, attestation lags
  the source head by ~32 blocks, and a sweep of a wide range takes visible time.
- Writability (outbound messages to Ethereum) is not live on testnet, so the product is read-side
  only by necessity.

## Capabilities and Constraints

- `UtuhRegistry` — open a claim over a source-chain range, append proven events in batches of up to
  10 queries, seal, challenge window, finalize, refute, abandon, withdraw.
- `UtuhCredit` — underwrites a line from proven repayment history (Aave `Repay` on mainnet), with a
  policy of volume unit, minimum history, staleness bound, repayment bps and repay window.
- Refutation is one proof plus a binary search over a stored member array; it does not scale with
  claim size. Building a claim does: measured, ~1.5x the call's own calldata gas, so a
  ten-thousand-event claim is roughly forty full blocks of gas.
- Contracts are deployed and verified on CC3; the ledger has a Sepolia twin.
- Terminology is fixed and must not be softened: claim, scope, member, bond, challenge window,
  refute, finalize, abandon, standing, line, draw, settle.

## Brand Commitments

- The name: **utuh** — Indonesian for *whole, intact, with nothing missing*. This is the product's
  one piece of given poetry and the concept the whole system encodes.
- Voice throughout the repo is plain, exact, and unhyped: it states measurements, names what it
  does not prove, and never sells. UI copy must match that register.
- Built for BUIDL CTC 2026 Fall on Creditcoin.

## Evidence on Hand

- Live contracts on CC3 Testnet, verified on Blockscout and Sourcify (full match).
- A live console at utuh.vercel.app, mirrored at pugarhuda.github.io/utuh, both built from each
  commit's own artifacts by the same workflow.
- Real measurements produced by the repo, not asserted: `npm run gas` fits a cost model over 56
  real appends; symbolic proofs of two roundings; 136 forge tests; a nightly job that proves real
  mainnet transactions against the live precompile.
- Public third-party evidence of usage: CC3's own dashboard lists every `verifyAndEmit`.
- **Absences that must never be fabricated:** no users, no testimonials, no TVL, no partnerships,
  no audit. Nothing has been through third-party review.

## Product Principles

1. **Say what is not proven.** Every claim in the interface carries its own limit. Economic, not
   cryptographic; a bond, not a guarantee.
2. **The stranger is the security model.** Anything a watcher needs must work from a cold browser
   with no key, no install and no permission.
3. **Measured beats asserted.** Numbers shown come from a run that produced them, and say what
   produced them.
4. **The wait is part of the truth.** Challenge windows and attestation lag are the mechanism, not
   latency to be hidden. Show progress honestly rather than implying speed the chain does not have.
5. **Terminology does not bend.** The words are the protocol's; clarity comes from explaining them,
   never from replacing them with friendlier ones.

## Accessibility & Inclusion

The console already ships skip links, semantic landmarks and an axe-core Playwright suite in CI.
Keyboard operability and screen-reader correctness are a maintained standard, not an aspiration —
a redesign must not regress them.
