import { FetchRequest, JsonRpcProvider, toUtf8String } from 'ethers';
import type { JsonRpcApiProvider, JsonRpcPayload, JsonRpcResult, Provider } from 'ethers';
import { FAILOVER_READS, sendWithFailover } from './failover';
import { chainInfo, blockProver } from '@gluwa/usc-sdk';
import { CHAIN_INFO_ADDRESS } from './networks';

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

/// A CC3 provider whose reads survive the primary RPC going away.
///
/// The console has had this since 2026-09-03, when Creditcoin's one RPC hostname spent half a day
/// answering large `eth_call` bodies with 413; the scripts had not, so `npm run judge`, `doctor`,
/// `probe` and the watcher went down with it while the page stayed up. Writes go through ethers'
/// own path to the primary, untouched.
///
/// Reads get their own deadline on the primary, because ethers' default is five minutes — a hung
/// primary would otherwise hold a read for that long before there was anything to fail over from.
export class FailoverProvider extends JsonRpcProvider {
  private told = false;

  constructor(
    private primaryUrl: string,
    private fallbackUrl: string | null,
    chainId: number,
    private readTimeoutMs = 30_000,
  ) {
    super(primaryUrl, chainId, { staticNetwork: true });
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const batch = Array.isArray(payload) ? payload : [payload];
    if (!batch.every((p) => FAILOVER_READS.has(p.method))) return super._send(payload);
    const fallback = this.fallbackUrl;
    return sendWithFailover(
      batch,
      (b) => post(this.primaryUrl, b, this.readTimeoutMs),
      fallback ? (b) => gated(() => post(fallback, b, 20_000).catch(() => post(fallback, b, 20_000))) : null,
      (e) => {
        // stderr, not stdout: `npm run mcp` speaks its protocol on stdout, and one stray line there
        // is a corrupt frame to the client.
        if (!this.told) console.error(`CC3 RPC did not answer (${reason(e)}) — reading through ${new URL(fallback!).host}`);
        this.told = true;
      },
    );
  }
}

async function post(url: string, payload: JsonRpcPayload[], timeoutMs: number): Promise<JsonRpcResult[]> {
  const request = new FetchRequest(url);
  request.body = JSON.stringify(payload);
  request.setHeader('content-type', 'application/json');
  request.timeout = timeoutMs;
  const response = await request.send();
  response.assertOk();
  const body = response.bodyJson as JsonRpcResult | JsonRpcResult[];
  return Array.isArray(body) ? body : [body];
}

/// At most three requests to the proxy in the air at once. It serves bursts one after another
/// rather than side by side (the console measured eight concurrent batches at 4–7s each against
/// ~2s alone), so the queue is held here rather than inside a request's deadline.
let inFlight = 0;
const waiting: (() => void)[] = [];
async function gated<T>(work: () => Promise<T>): Promise<T> {
  while (inFlight >= 3) await new Promise<void>((wake) => waiting.push(wake));
  inFlight++;
  try {
    return await work();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

function reason(e: unknown): string {
  return String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? e).slice(0, 60);
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
  // One dropped poll used to end the whole run. Measured 2026-09-13: `npm run e2e` built and
  // refuted two claims over twenty minutes and then died in this loop on a single `request
  // timeout` from the Creditcoin RPC while waiting out a challenge window — with an honest bond
  // left in a sealed claim for somebody to finalize by hand. A poll that fails is a poll to
  // repeat; only a run of them says the endpoint is gone.
  let misses = 0;

  for (;;) {
    let now: number;
    try {
      now = await provider.getBlockNumber();
      misses = 0;
    } catch (e) {
      if (++misses >= 20) throw e;
      if (!tty) console.log(`  poll ${misses}/20 failed (${(e as Error).message.slice(0, 60)}) — trying again`);
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
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

/// Keyed by the network, not left global.
///
/// A single cache would have served the first network's answer to every later provider — and the
/// whole point of asking is that the answer differs between Creditcoin networks. Nothing here talks
/// to two at once today; caching as though the answer were universal is how that stops being true
/// quietly.
const cached = new Map<string, Promise<SupportedChain[]>>();

/// The mapping, read once per network per process.
export async function supportedChains(provider: Provider): Promise<SupportedChain[]> {
  const key = String((await provider.getNetwork()).chainId);
  const existing = cached.get(key);
  if (existing) return existing;
  const pending = chainInfoAt(provider)
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
  cached.set(key, pending);
  return pending;
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

