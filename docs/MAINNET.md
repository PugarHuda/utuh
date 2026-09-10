# Deploying on Creditcoin Mainnet

A runbook, written before the deployment rather than after, because the deployment needs a funded
key that only one person holds and the person running it should not be reading code to find out
what differs. Everything below was measured against `https://rpc.cc3-mainnet.creditcoin.network`
on 2026-09-10.

## What is the same

- Chain id `102030`. The RPC answers `eth_chainId`, is CORS-open, and serves the ChainInfo
  precompile: `get_supported_chains` returns one chain, and `get_latest_attestation_height_and_hash`
  for it returned `25,947,520` — Ethereum mainnet's height that minute, within a few hundred blocks
  of what the testnet's frontier said. Both networks sign the same Ethereum block into a
  byte-identical attestation digest from attestor sets with no shared BLS keys (`npm run livetest`
  asserts it), so an Ethereum event provable on testnet is provable on mainnet.
- `0x0FD2` and `0x0FD3` have no bytecode on either network. Same reason, same consequence: nothing
  about verification can be fork-tested.
- The contracts. Nothing in `src/` is testnet-shaped; the chain key and the precompile addresses
  are constructor arguments and constants respectively.
- Blockscout exists: `https://creditcoin.blockscout.com` answers `/api/v2/stats`.

## What is different, and it is three things

### 1. Ethereum is chain key **1** on mainnet, not 3

On CC3 Testnet, key 1 is Sepolia and key 3 is Ethereum mainnet. On Creditcoin Mainnet there is one
attested chain and its key is 1, and `get_chain_by_key(3)` reverts `chain not supported`.

The README already says a chain key is not a global constant, and `verifyChainKeys` in
`offchain/lib/chain.ts` asks the network what each configured key is *named* before anything
trusts the table. That check is the tripwire: pointed at mainnet with the testnet table, it fails
on the first line, which is the correct outcome. It also means the `CHAIN_KEY` / `SOURCE_CHAIN_ID` /
`SOURCE_RPCS_DEFAULT` tables in `offchain/lib/networks.ts` — keyed by number, and used by every
script and the console — need a mainnet profile in which key 1 maps to Ethereum, not Sepolia.

That is the one real code change, and it is not made yet. It is deliberately not made yet: a
profile nobody can exercise until a key is funded is scaffolding, and the tripwire means the wrong
table cannot be used by accident.

### 2. There is no hosted Proof Builder

`prover.cc3-mainnet.creditcoin.network`, `proof-gen-api.cc3-mainnet.creditcoin.network` and
`prover.creditcoin.network` do not resolve. Every proof on mainnet comes from `RawProofBuilder`
over public Ethereum endpoints plus the ChainInfo precompile — the path `npm run provers` proves is
byte-identical to the hosted one, and which as of 2026-09-10 runs in under a second on a block
with receipts. `Prover.withDefaults(chainKey, budget, 'http://127.0.0.1:1')` is how the scripts
already run it with the hosted URL sent nowhere.

The consequence for refuters: the independence argument stops being a fallback and becomes the
only path. It was built for that.

### 3. The CTC is real

Testnet CTC comes from a faucet. Mainnet CTC is bought. `npm run gas` fits the registry's real
cost from its own receipts rather than from a table; Creditcoin's published price for a
verification is `2.3e-5 + 2.9e-7 × continuity-hash-count` CTC, and a member's continuity proof is
at most 100 hashes because checkpoints land every 100 blocks. Run `npm run gas` against the
testnet record before funding, and size the key for a demonstration, not for a market — the
market is gated on a counterparty, not on this.

## The runbook

```sh
# 1. The tripwire, before anything else. This must FAIL with the testnet table.
CC3_RPC=https://rpc.cc3-mainnet.creditcoin.network npm run probe

# 2. Add the mainnet profile to offchain/lib/networks.ts (chain id 102030, key 1 → Ethereum,
#    no PROVER_URL, Blockscout at creditcoin.blockscout.com) and make step 1 pass.

# 3. Deploy with a funded key. DEPLOYMENTS names a separate record so nothing testnet is touched.
CC3_RPC=https://rpc.cc3-mainnet.creditcoin.network DEPLOYMENTS=deployments.mainnet.json \
  REDEPLOY=1 PRIVATE_KEY=... npm run deploy

# 4. Verify on both, the way the testnet contracts are.
npm run verify                         # Blockscout, reads the record DEPLOYMENTS names
forge verify-contract --chain 102030 --verifier sourcify <address> <contract>

# 5. One real claim, sealed and finalized, so the deployment is a deployment and not an address.
CC3_RPC=... DEPLOYMENTS=deployments.mainnet.json PRIVATE_KEY=... npm run e2e

# 6. Tell the judge about it.
#    Add the record to LISTED in offchain/judge.ts so the daily run measures it too.
```

## How you would know it happened

Addresses on chain 102030, verified on Blockscout and matched on Sourcify, with at least one claim
sealed and one refuted — the same two observables the testnet deployment carries, on a chain where
the CTC was paid for. `ROADMAP.md` moves the item from *specified* to *shipped* on that day and not
before.
