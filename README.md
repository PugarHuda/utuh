# Utuh

**A completeness layer for the Attestcoin Protocol, and undercollateralized credit built on it.**

*utuh* — Indonesian: whole, intact, with nothing missing.

Built for BUIDL CTC 2026 Fall on Creditcoin.

---

## The problem

The Attestcoin Protocol proves that a source-chain transaction *happened*. A Merkle proof places
the transaction in a block; a continuity proof anchors that block to an attestation stored on
Creditcoin. The Block Prover precompile at `0x0FD2` checks both natively, synchronously, inside a
single Creditcoin block.

What it cannot prove is that a *set* of events is complete.

Whoever submits proofs chooses which proofs to submit. Every one of them verifies. Nothing in the
protocol notices the ones that were left out.

For credit, that gap is fatal. The sentence every on-chain credit system needs is:

> *This borrower has never been liquidated.*

That is a statement about events which do not exist, and an inclusion proof can only ever speak
about events which do. A borrower assembles their own history, submits the flattering half, and
each proof checks out.

This is not hypothetical. Season 1 of this hackathon drew 76 submissions, and more than twenty of
them were some form of on-chain credit score or reputation-based lending. Every one of them
inherits this hole. None of them won.

## What Utuh does

Two halves, each sound on its own.

**Nothing invented.** Every event enters a claim through `appendBatch`, which runs the Attestcoin
Block Prover on it before it is recorded. Members must arrive in strictly ascending
`(blockHeight, txIndex, logIndex)` order, which the contract enforces rather than trusts. A claim
can only ever contain events that provably happened, so its aggregate cannot be inflated.

**Nothing omitted.** The claimant bonds the assertion that the set is complete. Anyone may break
the claim by proving a single in-scope event the set does not contain. Absence is never proven — a
claim of absence is *refuted by presence*, which Attestcoin does prove.

```
presence  →  cryptographic   (Merkle + continuity, verified by 0x0FD2)
absence   →  economic        (bonded assertion, refutable by one proof)
```

### Why it scales

The registry never verifies a whole set. Appends verify each event once; a refutation verifies
exactly one. A claim spanning ten thousand events is settled by a single proof, or by none at all.

### The subtle part

A challenge window is only meaningful if a watcher could actually have acted inside it. So a claim
may not open until its entire block range is already attested on Creditcoin — checked against the
ChainInfo precompile at `0x0FD3`:

```solidity
if (!CHAIN_INFO.is_height_attested(scope.chainKey, toBlock)) revert RangeNotAttested(...);
```

Without that gate, a claimant could cover a range whose tail is not yet attested, and the window
would expire on a claim nobody was *able* to refute. Attestation heights only advance, so once
`toBlock` is attested the whole range stays provable for the life of the claim.

A second detail: a refuter receives half the slashed bond, not all of it. If they took the whole
bond, a claimant caught lying could refute their own claim and walk away whole, which would make a
false claim free to attempt. The burned remainder is what puts a price on being wrong.

## Built on Ethereum mainnet, not Sepolia

CC3 Testnet attests **Ethereum mainnet** (`chainKey 3`) alongside Sepolia (`chainKey 1`), from
genesis height 0. Verified live:

```
$ npm run balance
attested   sepolia  chainKey 1  height 11530210
attested   mainnet  chainKey 3  height 25797540
```

The mainnet frontier tracks within roughly a hundred blocks of the real chain head. So contracts
on a free testnet can be underwritten on real Aave positions, real USDC flows, and real borrowers,
with no capital at risk and nothing simulated.

Every number in the demos comes from Ethereum mainnet.

## UtuhCredit

An undercollateralized credit line on Creditcoin, underwritten on Ethereum. Nothing bridges: the
history stays on Ethereum, the credit is issued in CTC on Creditcoin, repayment happens back on
Ethereum. The only thing that crosses is proof.

Underwriting rests on two claims that are adversarial in **opposite** directions, which is what
makes the pair sound:

| Claim | Assertion | Who benefits from a lie | Defence |
|---|---|---|---|
| **Volume** | proven Aave repayments | inflating it | every member verified by `0x0FD2` on append |
| **Clean** | complete set of liquidations, normally empty | omitting one | bond, refutable by one liquidation proof |

```
limit = min( 20% of proven repayment volume , 10 × the bond behind the clean claim )
```

The second term is the consumer half of the mechanism. The registry cannot size a bond, because it
does not know what the claim will be used for — only the party about to lend knows its own
exposure. A line never risks more than a liar stood to lose.

### Default without proving a negative

A drawn line is settled by the borrower proving repayment landed at the lender's Ethereum address.
If no finalized claim arrives before the deadline, the line defaults. The contract never
establishes that a payment was missed — the burden sits with the only party who could discharge
it. Silence is the default condition, not an inference.

## Layout

```
src/
  UtuhRegistry.sol          the completeness layer
  UtuhCredit.sol            undercollateralized credit built on it
  lib/EventScope.sol        which events a claim covers, and how each one counts
  interfaces/IBlockProver.sol   0x0FD2 — Merkle + continuity verification
  interfaces/IChainInfo.sol     0x0FD3 — attestation frontier and coverage
test/
  EventScope.t.sol          21 tests over the matcher, ordering key and leaf identity
offchain/
  deploy.ts                 deploy decoder, registry, credit
  e2e.ts                    honest claim finalized; dishonest claim refuted and slashed
  creditDemo.ts             underwrite a real Aave borrower; refute a real liquidated one
  balance.ts                wallet, chain and attestation status
  lib/scope.ts              independent source-chain sweep
  lib/proofs.ts             Proof Builder batching within Attestcoin's limits
  lib/claims.ts             open, append, seal, find omissions, refute
```

## Running it

```bash
npm install
forge build
forge test

cp .env.example .env        # then fill in PRIVATE_KEY
npm run balance             # prints the faucet command if the account is empty
npm run probe               # verifies real mainnet events on-chain — needs no CTC at all
npm run deploy
npm run e2e                 # the registry, both outcomes
npm run credit              # the credit line, on a real Aave borrower
```

CTC for CC3 Testnet comes from the Creditcoin Discord `#token-faucet` channel:

```
/faucet address:<your address>
```

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `PRIVATE_KEY` | — | required |
| `CC3_RPC` | `https://rpc.cc3-testnet.creditcoin.network` | chain id 102031 |
| `PROVER_URL` | `https://prover.cc3-testnet.creditcoin.network` | hosted Proof Builder |
| `MAINNET_RPC` | `https://gateway.tenderly.co/public/mainnet` | see below |
| `MIN_CHALLENGE_WINDOW` | `25` | Creditcoin blocks, deploy-time floor |

A watcher's whole job is sweeping a claim's range independently, so the source-chain RPC has to
serve a wide `eth_getLogs`. Most free endpoints cap the range at 50–1000 blocks; Tenderly's public
gateway returns a filtered 216,000-block sweep in one call, which is why it is the default.

`MIN_CHALLENGE_WINDOW` is a deployment parameter rather than a constant so a demonstration can
watch a window actually elapse instead of asserting that it would have. The recommended production
value is `UtuhRegistry.RECOMMENDED_CHALLENGE_WINDOW` — 5760 blocks, about 24 hours. The contract
enforces an absolute floor of 20 blocks regardless.

## On testing

`test/EventScope.t.sol` covers the pure half: ordering, scope matching, metrics, scope and leaf
identity, plus two fuzz properties on the key.

The proving half is **not** unit tested, deliberately. The Attestcoin precompiles at `0x0FD2` and
`0x0FD3` are Creditcoin runtime natives — `eth_getCode` returns `0x` for both:

```
$ eth_getCode 0x...0fD2 → 0x
$ eth_getCode 0x...0fD3 → 0x
```

A forked EVM cannot execute them, and a stub would only ever test the stub. So that half runs
against the live CC3 Testnet with proofs fetched from the real Proof Builder for real Ethereum
mainnet transactions. `npm run e2e` and `npm run credit` are the tests, and they either pass on the
real chain or they do not pass at all.

## One thing worth knowing before you build on this

The Block Prover has two `verifyAndEmit` overloads. The Proof Builder's batch endpoint returns a
single continuity proof spanning the batch's block range, and it is the **array** overload that
proof is shaped for:

```solidity
verifyAndEmit(uint64 chainKey, uint64[] heights, bytes[] txs, MerkleProof[] proofs, ContinuityProof shared)
```

Feeding that same shared proof to the single-query overload, once per event, verifies only while
every query sits in the same block. The moment one is in a later block it reverts with
`Merkle root mismatch`, because the roots array is read relative to the queried height.

The cap of 10 is on **queries, not transactions**. A transaction carrying three in-scope logs
spends three slots even though it needs one proof. Batching by transaction count earns
`heights: Value is too large for length`.

Both were found by running `npm run probe` against the live testnet, which is why it exists as a
script: it exercises the entire proving path through `eth_call`, so an empty wallet is enough.

## Attestcoin surface used

| Piece | Where |
|---|---|
| Batch `verifyAndEmit` on `0x0FD2` | `appendBatch` — up to 10 queries, one shared continuity proof |
| Single `verifyAndEmit` on `0x0FD2` | `refute` — a refutation only ever needs one |
| `calculateTxIndex` on `0x0FD2` | ordering key, taken from the proof rather than the caller |
| `EvmV1Decoder` receipt + log decoding | scope matching against verified bytes |
| receipt status check | inclusion is not success; a reverted transaction is still in its block |
| `is_height_attested` on `0x0FD3` | the gate that makes challenge windows sound |
| `get_latest_attestation_height_and_hash` | underwriting staleness bound |
| `get_attestation_genesis_height` | lower bound on claimable ranges |
| Ethereum mainnet as source chain (`chainKey 3`) | all demos |

## Known limits

- Claim members are held as a storage array so refutation is a binary search the chain runs
  itself, with no witness a claimant could withhold. One `SSTORE` per event caps practical claims
  in the low thousands. Beyond that, the array becomes an incremental Merkle root and the refuter
  supplies an adjacency proof of the two members bracketing the gap.
- Writability is still in third-party audit and not on testnet, so Utuh is read-side only. A
  default is recorded on Creditcoin; enforcing consequences back on Ethereum waits for outbound
  messaging.
- Completeness here is economic, not cryptographic. A bond makes lying expensive; it does not make
  it impossible.

## License

MIT
