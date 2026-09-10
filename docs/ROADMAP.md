# Roadmap

Written 2026-09-10. Everything below is either **done**, **gated on somebody else**, or
**engineering that has not been done yet** — and each item says which, because a roadmap that does
not distinguish those three is a wish list.

Every item also carries a line saying **how you would know it happened**, from outside this
repository. That is the only part that matters: the rest is intent, and intent is cheap.

---

## How to read this

| Marker | Means |
| ------ | ----- |
| **Shipped** | It is on a public chain, in the published package, or in CI. Check it now. |
| **Specified** | The design is written down and the work is known. Nothing external blocks it. |
| **Gated** | Blocked on something outside this project. The gate is named. |
| **Refused** | Deliberately not on the roadmap, with the reason. |

There are no dates on the unshipped items. This is one person, the deadline that matters was a
hackathon, and inventing quarters for work whose start depends on funding and on somebody else's
audit would be the least honest page in the repository.

---

## Shipped

- **The registry.** Bonded completeness claims, members verified by the Block Prover on the way in,
  refutation by one proof of one omitted in-scope event, half the bond to whoever finds it.
  _Check it:_ `UtuhRegistry` at `0x8FA0BD5301D998Be873E31453E53d114929a5Fac` (mainnet-sourced) and
  `0x26880c8980Cd54827543bD34c6c613253c69347b` (Sepolia-sourced) on CC3 Testnet, verified on
  Blockscout and matched on Sourcify.
- **The credit line.** `UtuhCredit` underwrites undercollateralized CTC against proven Ethereum
  repayment volume plus a bonded clean claim, caps the limit at `enforceableLoss × BOND_MULTIPLE`
  rather than at volume, and defaults on silence with no administrator anywhere in either contract.
  _Check it:_ grep both contracts for `onlyOwner`, `Ownable`, `owner`, `onlyRole`. Empty.
- **Refutation, actually run.** Not described — executed on-chain, repeatedly.
  _Check it:_ <https://utuh.vercel.app/?claim=5> and
  <https://utuh.vercel.app/?deployment=mainnet&claim=20>, and the tally on the console.
- **A watcher anybody can be.** The console sweeps Ethereum from a browser across independent
  endpoints, takes the union rather than a vote, and sends the refutation itself — no backend, no
  key to look. An hourly keyless sweep in CI goes red if a sealed claim is short.
  _Check it:_ the `watch` workflow's run history, and the page's own network log.
- **The watcher role as an agent.** `npx utuh-mcp` — five tools, claims as addressable resources,
  the job written down as a prompt, per-tool annotations saying which one spends.
  _Check it:_ npm `utuh-mcp@0.3.0`, and the MCP Registry entry `io.github.PugarHuda/utuh-mcp`.
- **All sixteen protocol entry points**, five on the Block Prover and eleven on ChainInfo, each
  because something needed it. _Check it:_ the table in the README, then the contracts.

---

## Specified — engineering, not research

### 1. Claim size stops being the ceiling

Members are a storage array, so refutation is a binary search the chain runs itself with no witness
a claimant could withhold. That property is worth keeping. What it costs is that the price of a
claim follows the bytes of the transactions being proven, and past roughly ten thousand events that
stops being affordable.

The replacement is written down rather than hoped for: the array becomes an **incremental Merkle
root**, and the refuter supplies an **adjacency proof** of the two members bracketing the gap. The
refutation stays one proof and one settlement; what changes is who carries the witness.

_How you would know:_ a claim with six figures of members, sealed and refuted, on a public chain.

### 2. Mainnet

The contracts read Creditcoin Mainnet's ChainInfo precompile today — both networks sign the same
Ethereum block into a byte-identical attestation digest from attestor sets with zero shared BLS
keys, which is checked from the browser in two calls. Nothing in the design is testnet-shaped. What
is missing is a deployment and the CTC to run it.

_How you would know:_ addresses on chain 102030, verified, with the same claims flow running
against them.

### 3. An external audit

Money at rest in a bond contract is a different risk class from a demo, and no amount of
self-testing substitutes for someone whose job is to break it. Slither at zero findings across 97
detectors, 159 Foundry tests, symbolic proofs over every input rather than 256 samples, and an
invariant suite over random sequences are the floor, not the ceiling. The CertiK credits attached
to this hackathon's prizes are the start of it.

_How you would know:_ a published report with findings and responses, including the findings that
were not fixed and why.

### 4. The claim-building path stops being the slow half

Building a proof locally costs tens of seconds against roughly one for the hosted service, because
`RawProofBuilder` re-fetches every sibling transaction in the block one at a time. It is correct,
and it is what makes refutation independent of a hosted service at all — but a challenge window
near the 20-block floor leaves a refuter on that path with almost no margin.

_How you would know:_ `npm run provers` reporting the local path within a small multiple of the
hosted one, on the same endpoints.

---

## Gated on somebody else

### Enforcement back on the source chain

**Gate: Attestcoin writability, which is in third-party audit and not on testnet.**

Today a default is *recorded* on Creditcoin. The borrower is refused the next line while it stands,
and may cure it late on exactly the terms it was owed. What cannot happen yet is consequence on
Ethereum, because outbound messaging does not exist to build against.

The seam is reserved in the design rather than retrofitted later: the default is already a
first-class on-chain record with the subject, the amount and the height, which is the message such
a relay would carry.

_How you would know:_ the week it lands on testnet, an integration exists. Not before — designing
against an unshipped interface is how you build the wrong thing twice.

### A counterparty

**Gate: one lender with real capital deciding a real limit on a real borrower's history.**

This is the honest gap between a working mechanism and a market, and it is the one thing on this
page that cannot be closed by writing more code. Every number in this repository is measured and
none of them is a loan somebody could lose money on. The economics — that a bond deters, that a
lender watches because the exposure is theirs, that `enforceableLoss` is the right ceiling — are
argued and tested, not observed in a market.

_How you would know:_ a line opened by a lender who is not the author, against a borrower who is
not the author, for money that is not testnet.

---

## Refused

- **A token.** The mechanism pays refuters out of bonds that lying claimants posted. Any additional
  bounty large enough to matter is recoverable by a claimant refuting their own claim from a second
  address — the same front-running that made `enforceableLoss` necessary rather than the bond. A
  token layered on that would be worse than the honest gap, and Known limits says so where a buyer
  can read it.
- **More source chains before there is a lender.** Only chain keys 1 and 3 are attested, and adding
  breadth to a layer nobody is lending on optimises the wrong number.
- **More adverse-event classes shipped as adapters.** A lender already configures as many classes
  as it cares about, and `openLine` caps exposure at the weakest of them. Shipping a library of
  protocol adapters would be building somebody else's integration before they asked.
- **Funding watching as a public good.** Honest claims pay watchers nothing and there is no fix for
  it at this layer. What there is instead is a reason the party with money at risk watches anyway,
  and the console and MCP server exist so that costs them a tab rather than a team. Pretending the
  general problem is solved would be a worse answer than naming it.

---

## What would change this page

Two things, and they are the two gates above. If writability ships, enforcement moves from gated to
specified and the design's last reserved seam gets used. If a lender appears, every economic claim
here becomes an observation instead of an argument, and the roadmap after that is written by what
that lender needs rather than by what seemed likely from here.

Everything else on this page is the same work whether or not either happens.
