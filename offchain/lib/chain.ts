import { toUtf8String } from 'ethers';
import type { JsonRpcApiProvider, Provider } from 'ethers';
import { chainInfo, blockProver } from '@gluwa/usc-sdk';
import { CHAIN_INFO_ADDRESS } from '../config';

/// One way to ask Creditcoin what it has attested.
///
/// Six scripts used to build their own `new Contract(CHAIN_INFO, chainInfoAbi, ...)` out of the
/// SDK's raw ABI json, which meant six copies of the address, six copies of the snake_case method
/// names, and no types on any of them. The SDK ships `PrecompileChainInfoProvider` for exactly
/// this — it is the same precompile, reached through an interface that names things and returns
/// numbers rather than ethers `Result` tuples.
///
/// The Solidity side keeps its own `IChainInfo`, because a contract cannot import a TypeScript
/// class and the on-chain call has to be snake_case to match the ABI.
/// Takes any ethers provider. The SDK wants a `JsonRpcApiProvider` specifically and every caller
/// here has one — a `Wallet`'s provider is typed as the wider `Provider`, so the narrowing happens
/// once, here, rather than as a cast at each of six call sites.
export function chainInfoAt(provider: Provider): chainInfo.PrecompileChainInfoProvider {
  return new chainInfo.PrecompileChainInfoProvider(provider as JsonRpcApiProvider, CHAIN_INFO_ADDRESS);
}

/// The Block Prover precompile, through the SDK rather than through a hand-held ABI.
///
/// `verifySingle` and `verifyBatch` are `view` twins of the emitting forms, which is what makes
/// the entire proving path exercisable over `eth_call` with an empty wallet — see `npm run probe`.
export function blockProverAt(provider: Provider): blockProver.PrecompileBlockProver {
  return new blockProver.PrecompileBlockProver(provider as JsonRpcApiProvider);
}

/// Is `height` attested for `chainKey` yet?
///
/// The precompile answers this directly on-chain, and the registry calls it that way — an
/// unattested range is the one thing that makes a challenge window unsound. Off-chain there is no
/// `is_height_attested` on the SDK provider, and there does not need to be: the frontier answers
/// the same question and is worth printing when it says no.
export async function attested(
  provider: Provider,
  chainKey: number,
  height: number,
): Promise<{ ok: boolean; frontier: number }> {
  const frontier = Number((await chainInfoAt(provider).getLatestAttestedHeightAndHash(chainKey)).height);
  return { ok: height <= frontier, frontier };
}

/// Block until the chain reaches `target`, saying so in a way the destination can read.
///
/// There were five copies of this, in three variants that had already drifted: one forgot to clear
/// its progress line and left it in the output, one used `console.log` and a ten-second poll so it
/// printed a line per attempt, the rest updated in place every five seconds. The visible symptom
/// was captured logs that were either one enormous line or a hundred near-identical ones.
///
/// A carriage return is right for a terminal and wrong for a pipe, and this is run both ways —
/// by hand, and by CI. So it updates in place when stdout is a TTY, and otherwise prints only when
/// there is something new to say: once on starting to wait, then at a slow interval, then nothing.
export async function waitForBlock(
  provider: Provider,
  target: number,
  opts: { label?: string; pollMs?: number; quietMs?: number } = {},
): Promise<void> {
  const { label = 'block', pollMs = 5000, quietMs = 60_000 } = opts;
  const tty = process.stdout.isTTY === true;
  let announced = false;
  let lastPrinted = 0;

  for (;;) {
    const now = await provider.getBlockNumber();
    if (now >= target) {
      if (tty && announced) process.stdout.write('\r'.padEnd(72) + '\r');
      return;
    }
    if (tty) {
      process.stdout.write(`\r  waiting for ${label} ${target}, at ${now}   `);
      announced = true;
    } else if (!announced || Date.now() - lastPrinted >= quietMs) {
      console.log(`  waiting for ${label} ${target}, at ${now} (${target - now} to go)`);
      announced = true;
      lastPrinted = Date.now();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/// What the connected Creditcoin network says about the chains it attests.
///
/// Three things are hardcoded off-chain that the chain itself will tell you: which key means which
/// chain (`CHAIN_KEY`), which EVM chain id that is (`SOURCE_CHAIN_ID`), and which transaction
/// encoding its proofs use (the `encoding` handed to `RawProofBuilder`). All three are correct for
/// CC3 Testnet and none of them are properties of Creditcoin in general — gluwa's own networks.json
/// shows chain key 3 meaning Sepolia on `usc-devnet` while it means Ethereum mainnet here.
///
/// So pointing `CC3_RPC` at a different Creditcoin network would leave the code underwriting one
/// chain while believing it was reading another, and every proof would verify. This is the check
/// that makes that impossible, and it is why the claim that `get_supported_chains` is read at
/// runtime is now true rather than aspirational.
export interface SupportedChain {
  chainKey: number;
  chainId: number;
  name: string;
  encoding: number;
}

/// The only transaction encoding this reads: EvmV1Decoder's, and the local builder's.
const SUPPORTED_ENCODING = 1;

let cached: Promise<SupportedChain[]> | null = null;

/// The mapping, read once per process.
export function supportedChains(provider: Provider): Promise<SupportedChain[]> {
  cached ??= chainInfoAt(provider)
    .getSupportedChains()
    .then((chains) =>
      chains.map((c) => ({
        chainKey: Number(c.chainKey),
        chainId: Number(c.chainId),
        // `chainName` arrives as hex-encoded bytes: 0x457468657265756d is "Ethereum".
        name: toUtf8String(c.chainName),
        encoding: Number(c.chainEncoding),
      })),
    );
  return cached;
}

/// Check the hardcoded assumptions against the chain, and say precisely which one is wrong.
export async function verifyChainKeys(
  provider: Provider,
  expected: { chainKey: number; label: string; chainId: number }[],
): Promise<SupportedChain[]> {
  const chains = await supportedChains(provider);
  for (const want of expected) {
    const got = chains.find((c) => c.chainKey === want.chainKey);
    if (!got) {
      const known = chains.map((c) => `${c.chainKey} (${c.name})`).join(', ');
      throw new Error(
        `this build treats chain key ${want.chainKey} as ${want.label}, and the network at this ` +
          `RPC does not attest that key at all — it attests ${known}. Chain keys are per network, ` +
          `not global.`,
      );
    }
    // The proofs this builds are v1-encoded, in the Solidity decoder and in the local prover
    // alike. A network reporting another encoding is not a network this can read, and finding
    // that out here beats finding it out as a Merkle root mismatch with no mention of encodings.
    if (got.encoding !== SUPPORTED_ENCODING) {
      throw new Error(
        `chain key ${want.chainKey} on this network uses transaction encoding v${got.encoding}, ` +
          `and everything here — EvmV1Decoder and the local proof builder — reads v${SUPPORTED_ENCODING}.`,
      );
    }
    if (got.chainId !== want.chainId) {
      throw new Error(
        `this build treats chain key ${want.chainKey} as ${want.label} (EVM chain id ` +
          `${want.chainId}), and the network at this RPC says that key is "${got.name}", EVM chain ` +
          `id ${got.chainId}. Underwriting would read a different chain than it reported.`,
      );
    }
  }
  return chains;
}

