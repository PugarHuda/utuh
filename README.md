# Utuh

**A completeness layer for the Attestcoin Protocol, and undercollateralized credit built on it.**

*utuh* — Indonesian: whole, intact, with nothing missing.

Built for BUIDL CTC 2026 Fall on Creditcoin.

**Technical brief:** https://claude.ai/code/artifact/2caca05b-c659-463f-b5ca-28e207f95147

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

That price is smaller than the bond, and the difference matters. A claimant knows which event they
omitted from the moment they seal, so they can watch for an incoming refutation and send their own
from a second address, taking the refuter's share back. No ordering scheme closes this — an
earlier draft of these notes claimed commit-reveal would, which was wrong: the claimant holds the
private knowledge, so they simply commit first. What survives is the burn, which nobody can
recover.

So the registry reports `enforceableLoss` rather than the bond, and `isUsable` measures exposure
against that. Sizing a line against the whole bond, as `UtuhCredit` did at first, carried twice
the exposure the deterrent actually covered.

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

Budget for the attestation lag when running anything live: a freshly mined block takes on the
order of ten minutes to become provable on either chain. Historical blocks are immediate, and a
proof for one 210,000 blocks back still resolves in about seven seconds — it is only the tip that
you wait on.

Every number in the demos comes from Ethereum mainnet.

## UtuhCredit

An undercollateralized credit line on Creditcoin, underwritten on Ethereum. Nothing bridges: the
history stays on Ethereum, the credit is issued in CTC on Creditcoin, repayment happens back on
Ethereum. The only thing that crosses is proof.

Underwriting rests on two claims that are adversarial in **opposite** directions, which is what
makes the pair sound:

| Claim | Assertion | Who benefits from a lie | Defence |
|---|---|---|---|
| **Volume** | proven Aave USDC repayments | inflating it | every member verified by `0x0FD2` on append |
| **Clean** | complete set of liquidations, normally empty | omitting one | bond, refutable by one liquidation proof |

```
limit = min( 20% of proven volume × the lender's rate , 10 × the bond behind the clean claim )
```

The second term is the consumer half of the mechanism. The registry cannot size a bond, because it
does not know what the claim will be used for — only the party about to lend knows its own
exposure. A line never risks more than a liar stood to lose.

### Two places where units have to be taken seriously

Aave's `Repay` carries `amount` in the reserve asset's own decimals. Scoping a volume claim to the
event alone would sum WETH's 18 decimals into USDC's 6 and call the total a credit history. So the
volume scope **pins the reserve** — `Repay` puts it in topic 1 — and a claim is denominated in
exactly one asset.

That leaves a second gap: the claim aggregates USDC at 1e6, a line is CTC at 1e18, and crossing
between them is a price. This contract has no oracle and does not pretend to: the lender fixes
`VOLUME_UNIT_IN_CTC` at deployment, in the open, where anyone can judge it. A lender wanting a live
price puts a feed in front of this contract rather than having the protocol invent one.

### Reading a history is not the same as owning it

Underwriting reads a public chain. Nothing about reading it proves the reader holds the key that
wrote it, so before a line opens the borrower must bind their Ethereum address to their Creditcoin
account:

```
calldata = bytes12("utuh:control") || <creditcoin account>
```

One ordinary transaction from the subject address carrying exactly that. `proveControl` verifies
it through the Block Prover and reads the sender out of the decoded transaction — no signature
scheme of our own, no trusted relayer. The tag stops the commitment colliding with real calldata,
and naming the account inside it stops anyone replaying someone else's commitment.

Any supported source chain will do: an EOA address derives from its public key and is identical on
all of them, so Sepolia gas proves exactly as much as mainnet gas.

The terms of a draw are the lender's, never the borrower's. `draw` takes an amount and nothing
else; what must come back and by when are computed from policy, converting CTC back through the
same rate that produced the limit and rounding up so no draw is small enough to owe nothing.

Three smaller rules close the same class of hole. A finalized claim is **spent** when it opens a
line, so one underwriting funds one line and the cap bounds aggregate exposure rather than each
line separately. A line's deadline is fixed by its first draw and never moves — otherwise a
borrower who owes money could buy an unlimited extension by drawing one more wei. And each
settlement consumes the source-chain range it rests on, tracked per subject in `settledThrough`,
because marking a *claim* spent does not stop a *payment* being spent twice: two lines, two claims
over overlapping ranges, one transfer inside both.

### Default without proving a negative

A drawn line is settled by the borrower proving repayment landed at the lender's Ethereum address.
If no finalized claim arrives before the deadline, the line defaults. The contract never
establishes that a payment was missed — the burden sits with the only party who could discharge
it. Silence is the default condition, not an inference.

## Deployed on CC3 Testnet (chain id 102031)

### Mainnet-sourced deployment

| Contract | Address |
|---|---|
| `UtuhRegistry` | `0xc40a9b36fd2070407159f767983EC11Cb1D0428E` |
| `UtuhCredit` | `0xd978248cbB62F43B75b39A35e5B8990B45e7B167` |
| `EvmV1Decoder` | `0xF0f348c48E8e590898b915e17Bb8cad8Db590048` |

`npm run credit` runs against these, on Ethereum mainnet data.

### Sepolia-sourced deployment — the completed loop

| Contract | Address |
|---|---|
| `UtuhRegistry` | `0xC86a454B32d44db77E09DAcAd99880Dc6b68687b` |
| `UtuhCredit` | `0x20D39852003d070a84B05C0931C2f40158e9323C` |
| `SettlementLedger` (Sepolia) | `0x81e387D59E2112FDC5c89d71DC76fB92041EcF83` |

Claim 1 volume finalized at 0.003 ETH over three payments, claim 2 clean finalized empty, claim 3
refuted, claim 4 repayment finalized at 0.00063 ETH — and line 1 `Settled`.

That 0.00063 is the point of the last fix: drawing 12 CTC at the lender's stated rate and 105%
terms obliges exactly that much back, and the borrower had no say in the figure.

## Two demonstrations, and why there are two

`npm run credit` reads **Ethereum mainnet**: real Aave positions, real liquidations, real
borrowers. It underwrites them, refutes a genuinely liquidated address that claims it was never
liquidated — and then stops, because nobody can prove control of a stranger's address. That
refusal is the honest end of that flow.

`npm run full` closes the loop instead. A borrower we control acts on **Sepolia**: they pay a
lender through `SettlementLedger`, bind their address with a control commitment, get underwritten
on what they actually did, draw CTC on Creditcoin, repay on Sepolia, and settle. Two parties, both
transacting for themselves.

The source-chain contract is not a stand-in for anything under test. The payments are real
transfers, the events are real logs in real blocks, and Creditcoin attests them exactly as it
attests Aave's. A scope is a scope — the registry cannot tell the difference, and does not need
to.

## Layout

```
src/
  UtuhRegistry.sol          the completeness layer
  source/SettlementLedger.sol   deployed on the *source* chain: payments and adverse events
  UtuhCredit.sol            undercollateralized credit built on it
  lib/EventScope.sol        which events a claim covers, and how each one counts
  interfaces/IBlockProver.sol   0x0FD2 — Merkle + continuity verification
  interfaces/IChainInfo.sol     0x0FD3 — attestation frontier and coverage
test/
  EventScope.t.sol          the matcher, ordering key, metrics and leaf identity
  UtuhCredit.t.sol          deployment floors, control binding, scope identity, terms, liquidity
offchain/
  deploy.ts                 deploy decoder, registry, credit
  e2e.ts                    honest claim finalized; dishonest claim refuted and slashed
  creditDemo.ts             underwrite a real Aave borrower; refute a real liquidated one
  fullFlow.ts               the whole loop on Sepolia, borrower and lender both acting
  finishLine.ts             resume an interrupted run — the state lives on-chain, not in the script
  proveControl.ts           bind a source-chain address to a Creditcoin account
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
npm run control             # bind your own address (needs a little source-chain gas)
npm run full                # the entire loop, two parties, on Sepolia
npm run finish -- <registry> <credit> <claimId> <lineId>   # resume an interrupted run

npm run demo                # all three in sequence, for recording
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
| `VOLUME_UNIT_IN_CTC` | `15000000000000` | CTC wei per USDC unit; the lender's stated rate |
| `CONTROL_CHAIN_KEY` | `1` (Sepolia) | which source chain to send the control commitment on |
| `MIN_HISTORY_BLOCKS` | `216000` | lender policy: how much history an underwriting must cover |
| `MAX_STALENESS_BLOCKS` | `50400` | lender policy: how recently it must end |
| `REPAYMENT_BPS` | `10500` | lender policy: what a draw must repay, in basis points |
| `REPAY_WINDOW_BLOCKS` | `5760` | lender policy: how long the borrower has |
| `LENDER_MAINNET` | Binance hot wallet | where repayment must land on Ethereum |

A watcher's whole job is sweeping a claim's range independently, so the source-chain RPC has to
serve a wide `eth_getLogs`. Most free endpoints cap the range at 50–1000 blocks; Tenderly's public
gateway returns a filtered 216,000-block sweep in one call, which is why it is the default.

`MIN_CHALLENGE_WINDOW` is a deployment parameter rather than a constant so a demonstration can
watch a window actually elapse instead of asserting that it would have. The recommended production
value is `UtuhRegistry.RECOMMENDED_CHALLENGE_WINDOW` — 5760 blocks, about 24 hours. The contract
enforces an absolute floor of 20 blocks regardless.

## On testing

50 tests over the half that can run in a plain EVM: ordering and scope matching in
`EventScope.t.sol`, and in `UtuhCredit.t.sol` the guards that decide whose history a line may be
opened against — deployment floors, the control commitment's layout, scope identity, and the
lender's liquidity. Neither contract's constructor touches a precompile, so both deploy locally;
what cannot run locally is anything that reaches one.

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
| Single `verifyAndEmit` on `0x0FD2` | `proveControl` — binding an address to an account |
| `decodeCommonTxFields` | reading a control commitment's sender and calldata |
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
- A claimant watching the mempool can front-run an incoming refutation with their own, keeping half
  the bond and denying the watcher their reward. This is priced rather than prevented: the
  guarantee is `enforceableLoss`, not the bond. What it does not fix is the watcher's incentive —
  refuting pays only when the claimant fails to defend, so watching is worth less than the reward
  suggests.
- Binding an address costs the borrower one source-chain transaction. That is a real onboarding
  step, and there is no way around it that does not reintroduce the hole it closes. `npm run credit`
  therefore stops at `SubjectNotControlled` when pointed at a stranger's history — the refusal is
  the demonstration.

## License

MIT
