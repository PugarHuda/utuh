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

## Where this sits next to Creditcoin's own example

Creditcoin ships a [loan-flow tutorial](https://github.com/gluwa/usc-testnet-bridge-examples/tree/main/loan-flow)
— `USCLoanManager` on Creditcoin, an auxiliary contract on Sepolia, an offchain worker between
them. It is a good tutorial and it is the right shape for what it teaches. It is also a precise
illustration of the gap, because it is the reference every builder will start from.

Each event proves itself as it happens. `_markLoanAsFunded` and `_noteLoanRepayment` take one
proven transaction each; `USCBase.execute` verifies it through `0x0FD2` and records the query so
it cannot be replayed. Every *present* fact is cryptographic, and that part is sound.

Two things follow from proving one event at a time, and neither is a defect in the tutorial:

- Nothing asks whether the set is complete. That is fine when the loan is already registered on
  chain and the contract knows exactly which events it is waiting for. It stops being fine the
  moment the question is *"has this borrower ever been liquidated"* — because that question is
  about events nobody submitted, and no number of inclusion proofs answers it.
- Default is declared, not proven. `markLoanAsExpired` is `onlyOwner`. Somebody trusted says the
  loan went bad. For a tutorial that is the honest simplification; for underwriting a stranger it
  is the whole problem moved one layer up.

Utuh is the layer that would sit under such a contract: a bonded claim that a set of events is
*all* of them, refutable by anyone with one proof of one omitted event. Presence stays
cryptographic exactly as above. Absence becomes economic, which is the most that can be had.

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

### What scales, and what does not

*Settling* a claim is O(1): the registry never verifies a whole set, so a claim spanning ten
thousand events is broken by a single proof or by none at all.

*Building* one is not. `npm run gas` measures it rather than reasoning about it — it finds every
transaction a registry has ever seen from the registry's own logs, reads the receipts, and fits a
cost model. No explorer involved. Across the four registries deployed so far, 139 transactions:

| Call | Gas (mean) | % of a 75M block |
|---|---|---|
| `open` | 252,750 | 0.33% |
| `seal` | 206,010 | 0.27% |
| `appendBatch` (1 event) | 552,956 | 0.73% |
| `appendBatch` (2 events) | 893,903 | 1.19% |
| `appendBatch` (10 events) | 2,662,045 | 3.54% |
| `refute` | 611,556 | 0.81% |
| `finalize` | 209,258 | 0.27% |
| `withdraw` | 205,870 | 0.27% |

Member count alone does not explain those. One append of **three** events cost 541,464 gas while
an append of **two** cost 878,903, because the cost follows the *size of the transactions being
proven*, not how many events sit inside them. A least-squares fit over all 36 appends, against the
call's own calldata gas and its member count:

```
  273,022 gas fixed
    1.97 x the call's own calldata gas   (1.00 would be exact)
   61,265 gas per member on top of its bytes
  worst residual 232,253 gas, 20% of the mean append
```

The calldata term is the solid one, and it is the interesting one: **a proven transaction costs
about twice its own calldata gas**, because those bytes are not merely paid for at the door — they
are copied, RLP-decoded by `EvmV1Decoder`, and hashed by the Block Prover. Proving one in-scope
log inside a fat mainnet transaction means carrying all thirty kilobytes of it, and that is not a
choice the claimant has.

The per-member term is **not** well determined, and it is worth saying so rather than quoting it.
An earlier fit over 25 appends put it at 20,526 gas — almost exactly a cold `SSTORE`, which was a
satisfying number and the reason to distrust it. Eleven more appends moved it to 61,265. Members
and bytes are correlated in this data (more members generally means more bytes), so separating the
two needs appends this repo has not made: many members with small transactions, and few with large
ones. What the data does support is the shape — fixed cost, a dominant per-byte cost, and some
per-member cost on top — not a precise value for the last of those.

The practical ceiling is therefore set by bytes:

```
  a 100-event claim:     10 batches,    ~24.5M gas,  0.3 full blocks of it
  a 1,000-event claim:  100 batches,   ~245.2M gas,  3.3 full blocks
  a 10,000-event claim: 1000 batches, ~2451.6M gas, 32.7 full blocks
```

The asymmetry is still the point — challenging is one proof and a binary search, whatever the claim
holds — but a claim of ten thousand events is thirty blocks' worth of gas, and that is the number
that caps this rather than any argument about storage.

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
and naming the account inside it stops anyone binding a stranger's address to their own account.

**Each commitment may be applied once**, and that is not bookkeeping. A subject can move their
binding by sending a second commitment naming a different account — which is how anyone rotates
away from a Creditcoin account they no longer control. The proof of the *first* commitment stays
valid forever, and anyone may submit it. Without a used-marker the binding is therefore whichever
proof was replayed most recently, not whichever the subject meant: an attacker holding the
rotated-away account puts it back at will, including in front of the subject's own `openLine`.
Creditcoin's own `USCBase` records processed queries for exactly this reason, and this did not
until it was found. `controlIdOf` keys on the chain and the encoded transaction — which carries
its own signature — and deliberately not on the block height, so a reorg that moved the same
transaction cannot make the same commitment usable twice. `npm run control` and `npm run full`
both replay the commitment they just used and require `ControlProofAlreadyUsed`.

Any supported source chain will do: an EOA address derives from its public key and is identical on
all of them, so Sepolia gas proves exactly as much as mainnet gas.

The terms of a draw are the lender's, never the borrower's. `draw` takes an amount and nothing
else; what must come back and by when are computed from policy, converting CTC back through the
same rate that produced the limit and rounding up so no draw is small enough to owe nothing.

Two things about the money are worth stating because both were wrong once. Every rounding in the
contract lands against the party carrying the risk: `_repaymentFor` rounds up so no draw is small
enough to owe nothing, and `backingFor` rounds up so no limit is backed by less than a
`BOND_MULTIPLE`th of itself. That second one is asked at both ends of a line — when it opens and
when it settles — and it was a bare division at both until it was not.

And a lender can name where its own capital goes. `LENDER` is `msg.sender` at construction and
immutable, so a lender that is a contract without a payable fallback could `fund` this and never
get the money back out: `withdraw` would revert with `TransferFailed` forever. `withdrawTo` is the
way out. The authority check is unchanged — only the lender may call it.

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

Every contract below is **verified on Blockscout** — source, ABI and decoded constructor arguments
are readable at its address. An unverified address is a wall of bytecode, and "the source is on
GitHub" is a different claim from "this address runs that source". `npm run verify` republishes
them after a redeploy, reading whichever record `DEPLOYMENTS` names — so
`DEPLOYMENTS=deployments.full.json npm run verify` covers the Sepolia-sourced set including its
ledger, with nothing reconstructed by hand.

Deploying refuses to overwrite an existing record without `REDEPLOY=1`. The addresses below are
the ones in it, all verified; `npm run demo` used to begin by replacing them, so following this
file to record a demonstration quietly made everything published about them false.

Blockscout reports a *partial* match: the runtime bytecode agrees and the trailing metadata hash
does not, which is what happens when the compilation environment is not reproduced byte for byte.
The code is readable and the functions are callable.

### Mainnet-sourced deployment

| Contract | Address |
|---|---|
| `UtuhRegistry` | [`0x8FA0BD5301D998Be873E31453E53d114929a5Fac`](https://creditcoin-testnet.blockscout.com/address/0x8FA0BD5301D998Be873E31453E53d114929a5Fac?tab=contract) |
| `UtuhCredit` | [`0x94fC0579701c62a271EC128D904d2A2F8796c86c`](https://creditcoin-testnet.blockscout.com/address/0x94fC0579701c62a271EC128D904d2A2F8796c86c?tab=contract) |
| `EvmV1Decoder` | [`0x5cab00c032D7d4436f312Dd51ef59Dc5b860df3F`](https://creditcoin-testnet.blockscout.com/address/0x5cab00c032D7d4436f312Dd51ef59Dc5b860df3F?tab=contract) |

`npm run credit` runs against these, on Ethereum mainnet data.

### Sepolia-sourced deployment — the completed loop

| Contract | Address |
|---|---|
| `UtuhRegistry` | [`0x0Ec4486664c4311E1c7711D680f1e11d9d1C29ac`](https://creditcoin-testnet.blockscout.com/address/0x0Ec4486664c4311E1c7711D680f1e11d9d1C29ac?tab=contract) |
| `UtuhCredit` | [`0x17299EC7B75B1B148C4d61B6503bde73B70aaddd`](https://creditcoin-testnet.blockscout.com/address/0x17299EC7B75B1B148C4d61B6503bde73B70aaddd?tab=contract) |
| `EvmV1Decoder` | [`0xEEF4094b3848eD261478310a949c4A1E42d28571`](https://creditcoin-testnet.blockscout.com/address/0xEEF4094b3848eD261478310a949c4A1E42d28571?tab=contract) |
| `SettlementLedger` (Sepolia) | [`0x3AF37C2b6a3954c856CDAB3649971Bf546A7c34D`](https://eth-sepolia.blockscout.com/address/0x3AF37C2b6a3954c856CDAB3649971Bf546A7c34D?tab=contract) |

Everything below is readable at those addresses rather than taken on trust — `claim(id)`,
`memberCount(id)`, `keyAt(id, i)`, `enforceableLoss(id)`, `line(1)` and `settledThrough(subject)`
all answer to anyone. Claim 1 volume finalized at **0.003 ETH** over three payments, at Sepolia
blocks 11568493, 11568495 and 11568496; claim 2 clean finalized with zero members; claim 3
**Refuted** with `enforceableLoss` collapsed to 0; claim 4 repayment finalized at **0.000525 ETH**
from Sepolia block 11568588 — and line 1 reads `Settled`, with `settledThrough` at 11568619. The borrower's sweep read `publicnode=3  tenderly=3`: two
independent endpoints agreeing, and the claim built on the union rather than on whichever answered
first. `burned()` on that registry reads 1 CTC, which is the refuted claimant's half that nobody
collected.

That run did not finish in one go, twice over, and both interruptions are worth recording because
the chain absorbed them.

The first: the process died during the long wait for Sepolia's attestation frontier to reach the
repayment block, between the draw and the settlement. Nothing was lost, because nothing was being
held in the script — `npm run finish -- <registry> <credit> 1` read the line's state off the chain
and closed it. That is what `finishLine.ts` is for.

The second was mine. I stopped a resume that looked stuck and started another, and the first was
still running: **two processes built the same repayment claim.** Claim 4 and claim 5 hold the
identical event — Sepolia block 11568588, tx 142, log 0 — and settlement took claim 4. Nothing
broke, because a settlement consumes both the claim and the source-chain range it rests on:
claim 5 could not settle the same line, and `settledThrough` at 11568619 means that payment cannot
settle any other. The duplicate cost its author a bond locked until its own window closed, and
nothing else. Two guards that were written for a lying claimant turned out to cover a clumsy
honest one too.

Three figures there are fixes made visible. The limit is **10 CTC** — `enforceableLoss` of 1 CTC
times a `BOND_MULTIPLE` of 10 — and not the far larger number the 0.003 ETH of volume alone would
justify, because a 2 CTC bond only guarantees a 1 CTC loss and it is the guarantee that lends.
0.000525 ETH is what drawing 10 CTC obliges at the lender's rate and 105% terms; the borrower had
no say in the figure. And `settledThrough` for that subject reads 11565483, past the payment that
discharged the line, so the same payment cannot discharge a second one.

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
.github/workflows/ci.yml    fmt, build, tests, gas snapshot, typecheck, slither — and a daily
                            job that proves real mainnet events against the live precompile,
                            checks the hosted and local provers still agree, and reports what the
                            registry has cost. All three need no key and write nothing.
slither.config.json         which detectors are off, with the reasons next to the code
knip.json                   what counts as reachable; @gluwa/usc-contracts is imported from
                            Solidity, which a TypeScript analyser cannot see
.prettierrc.json            TypeScript formatting, enforced in CI the way forge fmt is
.gas-snapshot               committed, and CI fails if gas moves more than 5%
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
  SettlementLedger.t.sol    what the source-chain ledger will and will not record as a payment
  EventScopeKey.symbolic.t.sol  halmos proofs of the ordering key, over every input rather
                            than 256 samples — `npm run symbolic`
  CreditRounding.symbolic.t.sol proofs of the money roundings, and a note on the one the
                            solver could not decide — `npm run symbolic:deep`
offchain/
  deploy.ts                 deploy decoder, registry, credit
  e2e.ts                    honest claim finalized; dishonest claim refuted and slashed
  creditDemo.ts             underwrite a real Aave borrower; refute a real liquidated one
  watch.ts                  the watcher — follows ClaimSealed, sweeps, refutes what is short
  badClaim.ts               files a deliberately incomplete claim, so the watcher has prey
  liveTest.ts               the guards unit tests cannot reach, asserted against CC3
  fullFlow.ts               the whole loop on Sepolia, borrower and lender both acting
  finishLine.ts             resume an interrupted run — the state lives on-chain, not in the script
  doctor.ts                 preflight: endpoints, both provers, precompiles, balance
  verify.ts                 publish sources to Blockscout, constructor args and all
  proveControl.ts           bind a source-chain address to a Creditcoin account
  provers.ts                the same proof hosted and locally, compared and timed
  gas.ts                    what the registry has cost, fitted from its own receipts
  balance.ts                wallet, chain and attestation status
  probe.ts                  verify real mainnet events through 0x0FD2 over eth_call, no key
  config.ts                 endpoints, chain keys, timeouts — everything the env can override
  lib/scope.ts              independent source-chain sweep
  lib/proofs.ts             hosted and local proof building, batched within Attestcoin's limits
  lib/gasLimit.ts           eth_call first, then estimate, then the measured model
  lib/chain.ts              the two precompiles, through the SDK's own clients
  lib/claims.ts             open, append, seal, find omissions, refute
  lib/specs.ts              a UtuhCredit HistorySpec becomes a Scope, and scope equality
  lib/policy.ts             the lender's deployment configuration, read by deploy and verify
  lib/contracts.ts          artifacts, library linking, deployments.json
```

## Running it

```bash
npm install
forge build
forge test

cp .env.example .env        # then fill in PRIVATE_KEY
npm run doctor              # are the endpoints, both provers and the precompiles reachable?
npm run verify              # publish contract sources to the block explorer
npm run balance             # prints the faucet command if the account is empty
npm run probe               # verifies real mainnet events on-chain — needs no CTC at all

npm run check               # everything CI runs, in one command
npm run build               # forge build
npm run test                # 81 forge tests
npm run lint                # forge lint over src/
npm run fmt                 # forge fmt
npm run format              # prettier over offchain/  (--check variant: npm run format:check)
npm run typecheck           # tsc, ten strictness flags past `strict`
npm run deadcode            # knip: unused files, exports, dependencies
npm run symbolic            # halmos proofs of the ordering key (needs `pip install halmos`)
npm run symbolic:deep       # the rounding proofs; minutes, so CI runs these daily not per push
npm run provers             # prove one transaction hosted and locally, and compare
npm run gas                 # what the registry has really cost, fitted from its own receipts
npm run slither             # static analysis; the config says which detectors are off and why
npm run check               # everything CI runs: fmt, tests, typecheck, slither
npm run deploy
npm run e2e                 # the registry, both outcomes
npm run credit              # the credit line, on a real Aave borrower
npm run control             # bind your own address (needs a little source-chain gas)
npm run full                # the entire loop, two parties, on Sepolia
npm run finish -- <registry> <credit> <lineId>             # resume an interrupted run

npm run watch               # the watcher; --once to sweep and exit, --dry to look without acting
npm run bait                # seal a deliberately short claim for the watcher to find
npm run livetest            # 91 guards asserted against the live chain, refunds included

npm run demo                # e2e then credit, against the deployment already recorded
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
| `MAINNET_RPCS` / `SEPOLIA_RPCS` | bundled list | comma-separated; **replaces** the defaults |
| `*_RPCS_EXTRA` | — | comma-separated; adds to whatever is in use |
| `SOURCE_TIMEOUT_MS` | `25000` | how long one endpoint gets before it counts as absent |
| `PROBE_DEPTH` | `60000` | how far back `doctor` asks; deep enough to cross an archive cutoff |
| `ALLOW_SINGLE_SOURCE` | unset | let `npm run full` seal on one endpoint when two will not answer |
| `MIN_HISTORY_BLOCKS` | `216000` | lender policy: how much history an underwriting must cover |
| `MAX_STALENESS_BLOCKS` | `50400` | lender policy: how recently it must end |
| `REPAYMENT_BPS` | `10500` | lender policy: what a draw must repay, in basis points |
| `REPAY_WINDOW_BLOCKS` | `5760` | lender policy: how long the borrower has |
| `LENDER_MAINNET` | Binance hot wallet | where repayment must land on Ethereum |
| `RESUME_SCAN` | `200` | how many claims back `npm run finish` looks for one this line already built |
| `FORCE_MODELLED_GAS` | unset | skip estimation entirely, so the fallback gas model is the one under test |
| `WAIT_ATTESTED_MS` | `900000` | how long to wait for the attestation frontier to reach a block |
| `GAS_LOOKBACK` / `GAS_LOG_CHUNK` | `100000` / `2000` | how far back `npm run gas` reads, and its chunk size |
| `PROVER_TIMEOUT_MS` | `30000` | `doctor` only; the prover is a separate service with its own latency |
| `LIVE_SUBJECT` / `LIVE_FROM` / `LIVE_SPAN` | discovered / head−3040 / 400 | pin `livetest` to one address or window instead of letting it find a busy one |
| `WATCH_POLL_MS` / `WATCH_LOOKBACK` / `WATCH_LOG_CHUNK` | `20000` / `5000` / `2000` | watcher cadence, how far back it looks with no saved state, and its log-scan chunk |
| `WATCH_STATE` | `.watch-state.json` | where the watcher records how far it has read and what is still unresolved — one file per watcher, or two will overwrite each other's mark |
| `BOND` / `BAIT_FROM` | `2` CTC / `toBlock−3000` | what `npm run bait` stakes, and where it looks for an event to hide |
| `SUBJECT` / `RANGE_BLOCKS` / `MAX_MEMBERS` | derived / `60` / `12` | who and how much `npm run e2e` builds a claim over |
| `DEPLOYMENTS` | `deployments.json` | which deployment record to read and write — `deployments.full.json` holds the one `npm run full` made |
| `REDEPLOY` | unset | required to overwrite an existing deployment record |
| `LEDGER` | — | a source-chain ledger to verify, when the record does not name one |
| `EXPLORER_URL` / `SEPOLIA_EXPLORER_URL` | Blockscout | where `npm run verify` submits |

Two endpoints per chain is the floor for sealing a claim, not a comfortable margin — lose one and
claims stop being sealable until it returns. The bundled defaults are ones checked to actually
answer; an earlier list carried three per chain of which two were dead, which meant the two-source
minimum could never be met and nothing could be built at all. A safety default that makes the
system unusable is not a safety default. Anyone running this for real should add endpoints they
pay for through `*_RPCS_EXTRA`.

They were verified on the day they were written, and endpoints rot — "I checked once" is an
assumption wearing the clothes of a fact. `npm run doctor` is how anyone finds out before a bond is
on the line. It asks each endpoint the question the sweeps actually ask, which took three tries to get right. A
query for every log on the chain is one no endpoint should serve and condemns all of them. Every
USDC transfer across four hundred blocks times out the good ones. And a probe whose right answer is
"nothing" cannot tell a working endpoint from a broken one that returns nothing — which is the
failure it exists to catch. Each chain now gets two questions: a narrow one that must come back
with results, and a wide filtered one that must come back at all.

A watcher's whole job is sweeping a claim's range independently, so the source-chain RPC has to
serve a wide `eth_getLogs`. Most free endpoints cap the range at 50–1000 blocks; Tenderly's public
gateway returns a filtered 216,000-block sweep in one call, which is why it heads the default list.

The `_RPCS` variables replace that list rather than extending it. Widening a trust set has to come
with the ability to narrow it: an operator who knows one of the bundled endpoints is rate-limited —
or is the claimant's — needs to be able to drop it, and an append-only setting cannot.

### A refutation must not depend on a node's willingness to do arithmetic

`pallet-evm` does not always propagate revert reasons in estimation mode, so `eth_estimateGas` on
a call that reaches a precompile can fail on a call that would have succeeded. Gluwa's own SDK
ships a workaround, which is how this is known rather than guessed at. Unhandled, it means a
claimant cannot append and — much worse — **a refuter cannot refute**: a liar keeps a bond because
a node declined to estimate.

Every registry write now goes through `sendRegistryCall`, in this order:

1. `eth_call` first. Free, not subject to the estimation-mode problem, and it settles whether the
   call would actually succeed. If it reverts, that error is the real one and is surfaced.
2. Then `eth_estimateGas`, with the usual 35% buffer, when the node will answer.
3. If it will not, a limit from the measured cost model — and only because step 1 already proved
   the call good, so this can never send a doomed transaction.

Step 1 has a consequence worth spelling out. `buildClaim` drops an event the registry rejects,
because one the registry will not take is one no refuter could use against the claim either — and
adding `eth_call` in front of every append meant a *timeout* could now reach that same code path.
An RPC that failed to answer has said nothing about the event, and dropping it there seals a claim
short of a real member and forfeits the bond for it. So only a decoded revert counts as a
rejection; anything else aborts. It is the prover's 404 problem again, one layer down, and it
arrived as a side effect of the fix above rather than as anything anyone wrote on purpose.

The fallback is deliberately **not** the SDK's heuristic. That one is `21000 + roots*5000 + 20000`,
which for a ten-member append comes to about 146,000 gas against a measured 2,150,000: it would run
out of gas and lose the transaction it exists to save. The constants here are the fit `npm run gas`
produces, rounded up with the worst observed residual folded in and a third on top, and refused
outright above Creditcoin's 75M block cap.

A fallback nothing ever takes is a fallback nobody has tested, so `FORCE_MODELLED_GAS=1` makes
every call take it. Under it, a real ten-event append sent with a modelled 4,704,709 gas limit
against ~2.5M actual, a one-event append with 689,749, and a real refutation — all mined:

```
$ FORCE_MODELLED_GAS=1 npm run e2e
  estimation skipped by FORCE_MODELLED_GAS — the call succeeds under eth_call,
  sending appendBatch with 4704709 gas from the measured model
  batch 1/2: 10 events verified on-chain
  ...
  refuted with one proof. reward 1.0 CTC
```

### A chain key is not a global constant

`CHAIN_KEY` says Sepolia is 1 and Ethereum mainnet is 3. That is true of CC3 Testnet and it is not
a property of Creditcoin: gluwa's own
[networks.json](https://github.com/gluwa/creditcoin-usc-networks/blob/master/networks.json) has
chain key 3 meaning **Sepolia** on `usc-devnet`. Three things were hardcoded here that the chain
itself will tell you — which key means which chain, its EVM chain id, and the transaction encoding
its proofs use.

Point `CC3_RPC` at a different Creditcoin network and a build trusting its own constants would
underwrite one chain while reporting another. Nothing would catch it, because every proof would
still verify — they would be perfectly valid proofs about the chain they actually came from.

`get_supported_chains` is read now, once per process, on the path every bond goes through, and
`npm run doctor` prints what the network says:

```
  ok    chain key 3 is "Ethereum" (EVM 1), encoding v1
  ok    chain key 1 is "Sepolia ethereum" (EVM 11155111), encoding v1
```

A network reporting an encoding other than v1 is refused outright rather than read with the wrong
decoder — `EvmV1Decoder` and the local proof builder both read v1, and supporting an encoding
nobody here has seen would be a guess dressed as a feature.

### The prover was the last single point of failure

Everything above refuses to trust one endpoint for anything — and until recently the one thing
that mattered most came from exactly one place. Merkle and continuity proofs were fetched only
from Gluwa's hosted Proof Builder, so an outage there meant no claim could be built and, far
worse, **no claim could be refuted**. The whole enforcement mechanism sat behind one hosted
service, which is the same assumption the registry exists to reject.

The SDK also ships `RawProofBuilder`, which constructs the identical proofs from a source-chain
RPC and the ChainInfo precompile with no hosted service involved. Every prover here now asks the
hosted service first and falls back to that. `npm run provers` proves the same transaction both
ways and compares them, so the claim rests on evidence rather than on the code path existing:

```
sepolia block 11566420, 126 transaction(s)

  hosted  ok    1.9s   1 continuity roots
  local   ok   50.4s   1 continuity roots

Both proofs carry the same continuity roots.
The local path is 27x slower. Size the challenge window for it, not for the fast one.
```

The test that matters is not the comparison but the outage. Plant an incomplete claim, then run
the watcher with `PROVER_URL` pointed at a dead port:

```
$ PROVER_URL=http://127.0.0.1:1 npm run watch -- --once

claim 5: sealed with 3 member(s), bond 2.0 CTC
  window closes at CC3 block 5373599 (now 5373580, 19 to go)
  swept independently: publicnode=4  tenderly=4
  union: 4 in-scope event(s)
  INCOMPLETE: 1 event(s) missing
  first gap at block 11565480 tx#109 log#0
  refuted with one proof. key 916311728995473911151381154883436544
  reward 1.0 CTC
```

A real bond, taken on chain, with no hosted proof service reachable at all.

That ratio is the operational fact. The local builder re-fetches every sibling transaction in the
block and every block in the continuity range, so it costs tens of seconds where the hosted one
costs one — 84s against a block with 112 transactions and a hundred-block continuity range. Against
`RECOMMENDED_CHALLENGE_WINDOW` (5760 blocks, about a day) that is nothing. Against the absolute
floor of 20 blocks — under four minutes — a refuter driving the local path alone is working with
very little room. The floor exists so a demonstration can watch a window elapse; it is not a
setting to underwrite against.

Two details decide whether the fallback is real or decorative. It needs whole blocks *with
receipts*, and `eth_getBlockReceipts` is a method plenty of public endpoints decline — so the
local builder reads through every configured endpoint rather than one, and `npm run doctor` asks
each of them for that method by name, every run.

Every run, because the answer moves. An earlier version of this paragraph said publicnode does not
serve it on Sepolia and Tenderly does, which is what `doctor` reported that morning; the same
command a few hours later had both serving it. That is the same endpoint whose deep `eth_getLogs`
returns 0 where Tenderly returns 22, intermittently. The useful fact is not which endpoint is good
— it is that an endpoint's capabilities are not a property you can write down once, which is
precisely why `doctor` asks rather than remembering.

The second is that absence now arrives in two dialects. A claimant may drop a candidate only when
the chain definitely does not have it, and the hosted service says that with a `404` while the
local builder says `Transaction 0x… not found`. Two of the local builder's messages read like
absence and are not — `Transaction 0x… not found in block N` and `Block N not found for
transaction 0x…` are a *sibling* transaction or the block itself failing to load from the source
endpoints. Reading either as absence would let a claimant drop an event that is really there and
forfeit the bond, so only the exact form counts, and only when **every** prover consulted agrees.
One answering while the other is unreachable is not agreement.

`MIN_CHALLENGE_WINDOW` is a deployment parameter rather than a constant so a demonstration can
watch a window actually elapse instead of asserting that it would have. The recommended production
value is `UtuhRegistry.RECOMMENDED_CHALLENGE_WINDOW` — 5760 blocks, about 24 hours. The contract
enforces an absolute floor of 20 blocks regardless.

## On testing

81 tests, 9 of them fuzzed, over the half that can run in a plain EVM: ordering and scope matching
in `EventScope.t.sol`; in `SettlementLedger.t.sol` what the source-chain ledger will and will not
record as a payment; and in `UtuhCredit.t.sol` the guards that decide whose history a line may be
opened against — deployment floors, scope identity, the lender's liquidity, and the control
commitment. Neither contract's constructor touches a precompile, so both deploy locally; what
cannot run locally is anything that reaches one.

`_readCommitment` is `internal` rather than `private` so a test can reach it, and that is worth the
widened visibility. It is the check that decides whether an address may be bound to a Creditcoin
account, and reading it too permissively lets a stranger claim someone else's history — the one
failure that would make every other claim in this repo meaningless. Reaching it through
`proveControl` means going through `0x0FD2`, so without a way in it would be exercised only by the
demo's happy path. Eight tests now cover it, including a fuzzed round-trip asserting that what
`controlCommitment` tells a borrower to send is exactly what the parser accepts, and a tag bent by
a single byte.

The proving half is **not** unit tested, deliberately. The Attestcoin precompiles at `0x0FD2` and
`0x0FD3` are Creditcoin runtime natives — `eth_getCode` returns `0x` for both:

```
$ eth_getCode 0x...0fD2 → 0x
$ eth_getCode 0x...0fD3 → 0x
```

A forked EVM cannot execute them, and a stub would only ever test the stub. So that half runs
against the live CC3 Testnet with real proofs for real Ethereum mainnet transactions. `npm run
e2e`, `npm run credit` and `npm run livetest` are the tests, and they either pass on the real chain
or they do not pass at all.

`forge coverage` says 100% of `EventScope.sol` and `SettlementLedger.sol`, 43% of
`UtuhCredit.sol`, and **9.6% of `UtuhRegistry.sol`**. That last number is worth stating rather than
leaving to be discovered: almost every path in the registry begins at `open`, `open` asks `0x0FD3`
whether the range is attested, and that call cannot execute in a local EVM. Everything reachable
without a precompile is covered; everything else is covered live, on chain, where a stub could not
have lied about it.

`npm run livetest` is the one that reaches furthest: 91 guards, most of them `staticCall`s that
prove a revert without spending gas, plus the steps that have to be real for the later ones to
mean anything. It underwrites whichever address the source chain says was busiest in its window,
which is a deliberate change — it used to underwrite a wallet derived from the operator's key,
an address that has never repaid a loan on Ethereum and never will, so the suite could not run
standalone at all. A hardcoded borrower would only move the problem, since addresses go quiet and
a fixture that rots fails the suite for reasons that have nothing to do with the registry.

## What the tools say

`npm run check` is what CI runs: `forge fmt --check`, the 81 tests, `tsc --noEmit`, and Slither.
Slither reports **0 findings**, which is only worth stating alongside what it was allowed to look
for.

Five detectors are off in `slither.config.json`, and none of them are off because they were
inconvenient:

| Detector | Why |
|---|---|
| `naming-convention` | The ChainInfo precompile's ABI is snake_case; the interface has to match it or the calls do not resolve. Immutables are SCREAMING_CASE by house style. |
| `assembly` | One block, in `_readCommitment`, reading a 32-byte word out of calldata. |
| `low-level-calls` | `_pay` uses `.call{value:}` because that is the recommended way to send ether. |
| `calls-loop` | Both loops are bounded — `MAX_BATCH` is 10, and the clean-claim loop runs once per class the lender configured at deployment. |
| `solc-version` | Pinned at 0.8.28. |

Everything else stays on, and `fail_on: medium` means a new medium-or-worse finding fails the
build. The four findings that were real judgments rather than categories — two `arbitrary-send-eth`
on `_pay`, and the reentrancy detectors on the three functions that call `0x0FD2` — are suppressed
at the line, with the reasoning in the source next to them rather than in a config file:

- `_pay` is flagged for sending to an arbitrary destination. Every call site passes `msg.sender`,
  and each sets its state before calling, so a payee that reenters finds the work already done.
- `appendBatch`, `refute` and `proveControl` write state after calling the Block Prover. `0x0FD2`
  is a Substrate runtime native with no bytecode — `eth_getCode` returns `0x` — so it cannot call
  back into the EVM at all.

One finding was not a false positive and is fixed: `SettlementLedger.settle` took a payee without
checking for the zero address. A call to the zero address *succeeds* and burns the value, so the
ledger would have stood behind a `Settled` event for ether nobody received — and a lender whose
`HistorySpec` leaves the counterparty unpinned would have been counting burns as proven volume.

solc also suggests two functions could be `pure`. They could not: both read through a `storage`
pointer parameter, which the mutability checker does not track. Accepting the suggestion compiles
and makes the signature a lie, so both say so in a comment.

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
| `get_supported_chains` on `0x0FD3` | checking the chain keys this build assumes against the ones the network attests |
| `PrecompileChainInfoProvider` | waiting for attestation without asking a hosted service |
| `RawProofBuilder` over source RPCs | proofs built locally when the hosted Proof Builder is down |
| `PrecompileBlockProver` | `npm run probe` — the `view` twin of `verifyAndEmit`, over `eth_call` |
| `utils.gas.MAX_GAS_CAP` / `gasAsPercentageOfMax` | `npm run gas` — what a call costs against a 75M block |

Two SDK modules are deliberately unused, which is worth saying so it does not read as an oversight.
`queryBuilder` builds ABIs for the oracle's query subsystem, and Utuh does not go through it — it
calls the Block Prover precompile directly, which is a layer below. `utils.decoder` decodes EVM v1
transactions off-chain; Utuh decodes them *on*-chain through `EvmV1Decoder`, because an off-chain
decode is a claim about bytes and an on-chain one is a check of them. The one thing an off-chain
decode would have bought — knowing a call will succeed before paying for it — is bought more
cheaply by the `eth_call` in `sendRegistryCall`.
| Ethereum mainnet as source chain (`chainKey 3`) | all demos |

## Known limits

- Claim members are held as a storage array so refutation is a binary search the chain runs
  itself, with no witness a claimant could withhold. What caps a claim is not that array, though —
  measured, the cost follows the *bytes of the transactions being proven* at about twice their
  calldata gas, and a ten-thousand-event claim is thirty blocks' worth. Beyond the point where
  that is affordable, the array becomes an incremental Merkle root and the refuter supplies an
  adjacency proof of the two members bracketing the gap.
- Writability is still in third-party audit and not on testnet, so Utuh is read-side only. A
  default is recorded on Creditcoin; enforcing consequences back on Ethereum waits for outbound
  messaging.
- Completeness here is economic, not cryptographic. A bond makes lying expensive; it does not make
  it impossible.
- **An endpoint conflict is reported, not resolved.** When two endpoints describe the same event
  position differently, the sweep says so and keeps the first answer. Nothing here can tell which
  of them is lying — only that one of them is. It does not affect what a claim records, because
  that comes from bytes the Block Prover verified, but it is a signal an operator has to act on
  themselves.
- **The independent proof path is slow enough to matter.** Building a proof locally costs tens of
  seconds against roughly one for the hosted service, because it re-fetches every sibling
  transaction in the block and every block in the continuity range. It is correct, and it is what
  makes refutation independent of a hosted service at all, but a challenge window near the 20-block
  floor leaves a refuter on that path with almost no margin. Measure it for your own endpoints with
  `npm run provers` before choosing a window.
- A claimant watching the mempool can front-run an incoming refutation with their own, keeping half
  the bond and denying the watcher their reward. This is priced rather than prevented: the
  guarantee is `enforceableLoss`, not the bond. What it does not fix is the watcher's incentive —
  refuting pays only when the claimant fails to defend, so watching is worth less than the reward
  suggests.
- **The union is safe for a watcher and was not for a claimant.** A watcher meeting a candidate it
  cannot prove shrugs and moves on; a claimant has to append everything it swept, so one
  unprovable candidate aborted the whole claim — and since the union deliberately trusts no
  endpoint, a single misbehaving one could inject a phantom event and stop every honest claimant
  from building anything. The Block Prover decides what exists: an event nobody can prove cannot
  be appended and cannot be refuted with either, so dropping it is not an omission.

  Dropping is only safe on a *definite* answer, though, and the SDK returns "no such transaction"
  and "I could not reach the prover" in the same shape — `success: false` with a message. They are
  told apart by what each prover said, in its own dialect, and only when every prover consulted
  agrees; see [The prover was the last single point of failure](#the-prover-was-the-last-single-point-of-failure).
  Anything short of that aborts the claim instead of dropping, because an unbuilt claim costs
  nothing and an incomplete one costs the bond. Even a definite answer only counts once the block
  is attested, which is checked against `0x0FD3` rather than assumed.

- **A watcher that was switched off does not get to skip what it missed.** It used to start
  `WATCH_LOOKBACK` blocks behind the head every time — 5,000 CC3 blocks, about fifteen hours,
  against a recommended challenge window of 5,760, a full day. Down for longer than that, it came
  back and never saw the claims sealed in the gap: not inconclusive, not queued, simply never
  discovered, which is a hole that the retirement rule below says nothing about. It now records how
  far it has read and what is still unresolved, per registry, and resumes from there. The mark
  advances only after a sweep that finished.

- **A watcher only retires a claim on a verdict that cannot change.** Refuted, settled by someone
  else, proven complete by two or more endpoints, or past its window. Anything short of that —
  every endpoint down, an RPC hiccup mid-sweep, a refutation lost to a front-run — leaves the
  claim queued for the next pass. An earlier version marked claims checked *before* inspecting
  them, so a transient outage during the minute a claim sealed made that claim invisible for good;
  and an unguarded `await` meant one failed refutation killed the process. A watcher that dies on
  its first lost race is not a watcher. Claims are also worked soonest-deadline-first, because one
  with three blocks left cannot wait behind one with five thousand.

- **An endpoint's answer is not automatically an answer to the question.** A sweep now discards
  anything that does not match the filter it sent — wrong contract, wrong signature, wrong pinned
  topic, or a block outside the range asked for. That last one matters most: a log claiming a
  height above the attestation frontier becomes a candidate the prover cannot prove and the chain
  cannot yet rule absent, which by the drop rule aborts the whole claim. One hostile endpoint would
  otherwise stop anyone sealing anything.

- **Reconciling log indices needs a capability not every endpoint has.** `eth_getLogs` numbers logs
  across the block; the decoder on Creditcoin numbers them within their transaction, and bridging
  the two needs every log that transaction emitted. There are two ways to ask and endpoints differ
  on which they answer — publicnode serves a filtered historical `eth_getLogs` while refusing both
  the receipt and an unfiltered block query over the same blocks; tenderly answers the block query.
  Both are tried, and an endpoint that can do neither fails loudly rather than guessing an index.

- **A watcher's silence is only as good as its sources.** Deciding a claim is complete means
  trusting some node to have mentioned every log — the protocol's own problem, one layer down.
  Voting across endpoints would not fix it, since they can be wrong together or captured. What
  makes it tractable is that a refutation verifies itself: if *any* endpoint surfaces an event the
  claim omits, the Block Prover settles whether it is real, and a fabricated one just fails to
  prove. So `watch.ts` sweeps every endpoint it has and takes the union rather than a vote, and no
  endpoint has to be trusted for the positive case. The negative stays soft, and is reported that
  way — "no gap found across 3 endpoints", or "inconclusive, 1 answered". Public RPCs tested here
  **do not** always error rather than truncate. That was written here after testing simple
  queries and it was wrong. Measured on Sepolia, same query, same moment, WETH transfers over 200
  blocks:

  | depth below head | publicnode | tenderly |
  |---|---|---|
  | 100 | 27 | 27 |
  | 5,000 | 31 | 31 |
  | 20,000 | 24 | 24 |
  | 60,000 | **0** | 22 |

  An archive cutoff served as an empty result rather than an error, and intermittently — the same
  endpoint agreed at that depth twenty minutes later. Underwriting sweeps two hundred thousand
  blocks, so an endpoint like this reports an empty history for most of the range and a claimant
  trusting it alone seals an empty claim and loses the bond. This is why the union exists, why
  sealing needs two sources, and why `npm run doctor` reports a pass as "this time" rather than as
  a certificate: it catches persistent breakage, not intermittent lying. The union absorbs any
  subset of endpoints being wrong-empty. Nothing here detects all of them being wrong together.

- **The mechanism punishes scale.** One omission voids the whole claim and there is no amend path
  — by design, since amending after being caught would defeat it. So a five-thousand-member claim
  has five thousand chances to be fatally wrong. Most of that risk was self-inflicted and is now
  gone: claimants sweep the union of every endpoint (`sweepForClaim`) rather than betting a bond
  on one node having mentioned every log, and a single-source sweep warns before it seals. What
  remains is inherent — settling cheaply and building fragilely are one property seen from two
  sides — and it still argues for shorter claims than the guarantee deserves.

- **A claim covers one event signature from one contract.** `EventScope` cannot match on
  non-indexed data either, which rules out protocols that keep the subject out of their topics.
  Composition is now handled a level up: a lender configures as many adverse-event classes as it
  cares about and `openLine` demands one finalized, empty claim for each, capping exposure at the
  *weakest* of them. A spotless Aave record no longer says anything about Compound unless the
  lender asked about Compound.

- **Honest claims pay watchers nothing, and there is no fix for that here.** A refutation earns
  only when someone lied; if the deterrent works, almost nobody does, and a watcher spends RPC
  quota and gas on claims that turn out fine. Paying watchers out of the burn pool was the obvious
  patch and it does not work: any bonus large enough to matter is also recoverable by a claimant
  refuting their own claim from a second address, which is the same front-running that made
  `enforceableLoss` necessary. Funding a public good is not a problem this layer can solve, and a
  token mechanism that pretends otherwise would be worse than the honest gap.
- Binding an address costs the borrower one source-chain transaction. That is a real onboarding
  step, and there is no way around it that does not reintroduce the hole it closes. `npm run credit`
  therefore stops at `SubjectNotControlled` when pointed at a stranger's history — the refusal is
  the demonstration.

## License

MIT
