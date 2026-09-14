# ts-read

What a frontend needs to show a Utuh claim's standing: `claim`, `memberCount`, `enforceableLoss`,
`isUsable` and `challengeUntil`, all plain views on CC3 Testnet. No key, no proofs, no Utuh code:
just an ABI and ethers.

```sh
npm i
npx tsx read.ts 72 0.5   # claim id, then the exposure you would take, in CTC
```

Output from a live run on 2026-09-14, against the mainnet-sourced registry
`0x8FA0BD5301D998Be873E31453E53d114929a5Fac`:

```text
claim 72: Finalized, 0 member(s)
  scope    chainKey 3, emitter 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2, event 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286
           topic3=0x00000000000000000000000001a802c650cccef077208a93c1cf43025239003f
  range    source blocks 25756480..25972480 (216000 blocks)
  window   25 CC3 blocks, until 5484013 (now 5484020)
  bond     1.0 CTC posted, enforceableLoss 0.5 CTC
  isUsable(0.5 CTC) = true
```

```text
claim 20: Refuted, 0 member(s)
  scope    chainKey 3, emitter 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2, event 0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286
           topic3=0x00000000000000000000000058039c0ce2bddecc6f60458d425da66f606c5afa
  range    source blocks 25621579..25837580 (216001 blocks)
  window   25 CC3 blocks, until 5375939 (now 5484020)
  bond     2.0 CTC posted, enforceableLoss 0.0 CTC
  isUsable(0.5 CTC) = false
```

Claim 72 is the one [`../completeness-gate`](../completeness-gate/README.md) granted an allowance on.
Claim 20 is an empty "never liquidated" set that one mainnet liquidation proof broke. Its member count
is still 0, which is why a consumer reads `isUsable` and never the member count alone.
