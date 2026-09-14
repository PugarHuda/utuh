# completeness-gate

A contract that is not Utuh, built on Utuh: `NeverLiquidatedGate` grants an account an allowance only
if it names a Finalized, unrefuted Utuh claim that asserts, under bond, *this address was never
liquidated on Aave V3 (Ethereum mainnet) over at least 216,000 blocks*, and only if the account is
the one that address proved it controls.

It is the missing half of Gluwa's reference loan,
[`ASCLoanManager`](https://github.com/gluwa/attestcoin-protocol-examples/blob/main/loan/contracts/sol/ASCLoanManager.sol).
That contract proves the events that happened (`LoanFunded`, `LoanRepaid`) with the Block Prover, and
it settles the one that did not happen (a borrower who never repaid) with `markLoanAsExpired ...
onlyOwner`. A lender deciding whether to register a loan at all needs a sentence about absence, and
no inclusion proof can give one. This gate reads it as a boolean. It holds no proofs, never calls
`0x0FD2`, and has no owner.

## Install (as an outsider)

```sh
mkdir completeness-gate && cd completeness-gate
forge install foundry-rs/forge-std@v1.16.2 --no-git
forge install PugarHuda/utuh --no-git
npm i @gluwa/usc-contracts@0.1.2
```

`remappings.txt` and `foundry.toml` are in this directory and match
[`docs/INTEGRATING.md`](../../docs/INTEGRATING.md): solc 0.8.28, optimizer 200 runs, no via-IR.

```sh
forge build
forge test --no-match-contract Fork   # 20 tests against a mocked registry, offline
forge test --match-contract Fork      # 6 tests against the live registry, forked from CC3
```

## Deployed

CC3 Testnet, chain id 102031.

| | |
| --- | --- |
| `NeverLiquidatedGate` | [`0xcA6228C30607F26253Fffc2A4013a801DEEB5D09`](https://creditcoin-testnet.blockscout.com/address/0xcA6228C30607F26253Fffc2A4013a801DEEB5D09?tab=contract), verified on Blockscout |
| `REGISTRY` | `0x8FA0BD5301D998Be873E31453E53d114929a5Fac`, Utuh's mainnet-sourced registry |
| `CONTROL` | `0x0177aDb82152c8673a85271F7F06336B820324b6`, a `UtuhCredit` whose `controllerOf` is set only by a Block Prover proof |
| `MIN_HISTORY_BLOCKS` | 216,000 |

## Both outcomes, on-chain

**Granted.** Borrower `0x01a802C650ccceF077208A93c1cF43025239003f` has never sent a mainnet
transaction; two independent mainnet endpoints (Tenderly in one call, 0xrpc.io in 22 chunks) returned
no `LiquidationCall` naming it over blocks 25,756,480..25,972,480. It proved control of its address on
the Sepolia-sourced `UtuhCredit`, which binds it to the same account on CC3. Claim 72 was opened with a
1 CTC bond, sealed, left unrefuted for its 25-block window and finalized, and then the borrower called
the gate.

| Step | Transaction |
| --- | --- |
| Open claim 72 (1 CTC bond, empty set) | [`0x7443025f…7936f`](https://creditcoin-testnet.blockscout.com/tx/0x7443025f5010d0de6d33b6476c20ed53529bd51392e36891cdb620d8bec7936f) |
| Seal it (window opens) | [`0xc4299be9…786ea`](https://creditcoin-testnet.blockscout.com/tx/0xc4299be97b2aeda9025ef9067aae477f7001a6bc9b5feba7232053daded786ea) |
| Deploy the gate | [`0x03054b1e…213d6`](https://creditcoin-testnet.blockscout.com/tx/0x03054b1ea133f15d7123ade31ccc160f94714ca23348f4bdb32573afe02213d6) |
| Finalize claim 72 | [`0xe7ff4c97…24920`](https://creditcoin-testnet.blockscout.com/tx/0xe7ff4c9742aa864a41c0396d3a89eb873a90b1d1d064cb67f6b1d56cea124920) |
| Withdraw the refunded bond | [`0xaf7742e6…ed1f2`](https://creditcoin-testnet.blockscout.com/tx/0xaf7742e6cf4be603d49c8cf20804bd2d49ec91d76e1ce3f8ed0fca30164ed1f2) |
| **`grant(72, 0.5 CTC)` from the borrower: `AllowanceGranted`** | [`0x82fe073a…01a53`](https://creditcoin-testnet.blockscout.com/tx/0x82fe073a1de45d11e644ec1147630303851d87253a3c276ced6ec9d151e01a53) |

**Refused.** Claim 20 asserted the same thing about `0x58039c0ce2bddecc6f60458d425da66f606c5afa`, and
one proof of a real liquidation broke it. Naming it reverts with `NotUsable(20, 1, 0)`, and a refusal
was sent so it stays on the record:
[`0x89561d2e…a46b9`](https://creditcoin-testnet.blockscout.com/tx/0x89561d2e9b9bd96cc4df97010d78b0f8723fb6d1cea782463a0af3ac09ba46b9)
(status 0, 275,520 of 700,000 gas). A first attempt at a 200,000 gas limit,
[`0x3989ee00…bb4f3`](https://creditcoin-testnet.blockscout.com/tx/0x3989ee001f93069eb72b1c134869f86999a590df43db6aa90011cb8c9edbb4f3),
ran out of gas before reaching the check. CC3 meters calls well above a local EVM: the same refusal
costs 71,232 gas in the fork test. Every refusal can be reproduced with `cast call`:

```sh
G=0xcA6228C30607F26253Fffc2A4013a801DEEB5D09; RPC=https://rpc.cc3-testnet.creditcoin.network
B=0x01a802C650ccceF077208A93c1cF43025239003f
cast call $G "grant(uint256,uint256)" 20 1 --from $B --rpc-url $RPC  # NotUsable(20, 1, 0): refuted
cast call $G "grant(uint256,uint256)" 18 5e17 --from $B --rpc-url $RPC  # NotController(0x09d8…, borrower): clean, but not yours
cast call $G "grant(uint256,uint256)" 69 1 --from $B --rpc-url $RPC  # WrongScope(69, …): an Aave Supply claim
cast call $G "grant(uint256,uint256)" 72 1 --from $B --rpc-url $RPC  # ClaimAlreadyUsed(72): one claim, one grant
```

## Walkthrough

```solidity
function grant(uint256 claimId, uint256 amount) external returns (address subject) {
    UtuhRegistry.Claim memory c = REGISTRY.claim(claimId);

    // 1. Whose history is it, and is it the history this gate asks about? Rebuild the whole scope
    //    for that subject and compare identities, exactly as the registry hashes it.
    subject = address(uint160(uint256(c.scope.topics[2])));
    bytes32 want = EventScope.id(expectedScope(subject));
    bytes32 got = EventScope.id(c.scope);
    if (got != want) revert WrongScope(claimId, want, got);

    // 2. Is it long enough to mean something?
    uint64 span = c.toBlock - c.fromBlock;
    if (span < MIN_HISTORY_BLOCKS) revert HistoryTooShort(span, MIN_HISTORY_BLOCKS);

    // 3. Is the set empty? Count members; never read the aggregate for this.
    uint256 liquidations = REGISTRY.memberCount(claimId);
    if (liquidations != 0) revert NotClean(claimId, liquidations);

    // 4. Finalized and unrefuted, and would a liar certainly have lost at least `amount`?
    if (!REGISTRY.isUsable(claimId, amount)) {
        revert NotUsable(claimId, amount, REGISTRY.enforceableLoss(claimId));
    }

    // 5. A public history is not the caller's history.
    if (CONTROL.controllerOf(subject) != msg.sender) revert NotController(subject, msg.sender);

    // 6. One claim backs one grant, and a grant replaces rather than stacks.
    if (claimUsed[claimId]) revert ClaimAlreadyUsed(claimId);
    claimUsed[claimId] = true;
    allowanceOf[msg.sender] = amount;
    emit AllowanceGranted(msg.sender, subject, claimId, amount);
}
```

`expectedScope(subject)` is chain key 3, emitter the Aave V3 Pool, `topics[0]` =
`keccak256("LiquidationCall(address,address,address,uint256,uint256,address,bool)")`, the subject in
`Scope.topics[2]` (the event's `user`, its third indexed argument) with mask `4`, metric `COUNT`. A claim
that pins one more topic (for example, a single collateral asset) makes a narrower promise and is
refused. So is a subject topic with bits above the address.

Deliberately left to the lender who adopts this: a minimum challenge window (every claim on this
registry uses the 25-block floor), a staleness bound against
`CHAIN_INFO.get_latest_attestation_height_and_hash(3)`, and a per-subject watermark so two claims over
overlapping ranges cannot back two allowances. `docs/INTEGRATING.md` covers each one, and `UtuhCredit`
implements all three.

## Cost

Everything the gate reads is a view. Chain spend for this example, from the funded key: the claim's
1 CTC bond went out and came back through `finalize` and `withdraw`, and the rest is gas (open, seal,
deploy, both refusal attempts, finalize, withdraw, grant), 0.001311 CTC in total.
