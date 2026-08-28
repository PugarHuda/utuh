# Security

Utuh is testnet software built for BUIDL CTC 2026 Fall. Nothing here custodies mainnet funds. The
contracts on CC3 Testnet hold testnet CTC; the Ethereum contract holds nothing between calls.

## Reporting

If you find a way to make a claim of completeness stand when it is not — inflate an aggregate past
what the Block Prover verified, keep a bond that should have burned, open a line on history you do
not control, or draw twice on one history — please report it privately rather than in an issue:

- GitHub: use *Report a vulnerability* under the Security tab of this repository.
- Or email the address on the maintainer's profile.

Say what you found, how to reproduce it, and which of the published deployments it applies to. You
will get an answer within a week, and credit in the fix.

## What is in scope

- `src/` — the registry, the credit contract, the scope library, the source-chain ledger.
- `offchain/` and `web/` — anything that builds, sweeps, proves, refutes or signs.
- The published console at https://pugarhuda.github.io/utuh/.

## What is already known

`README.md` has a *Known limits* section. The front-running of refutations, the economic (not
cryptographic) nature of completeness, and the dependence on source-chain endpoints being honest
about which logs exist are described there and are design limits rather than bugs. Anything that
makes one of them worse than described is a bug.
