import { JsonRpcProvider, FetchRequest } from 'ethers';
import 'dotenv/config';
import {
  CC3_CHAIN_ID,
  CC3_RPC_DEFAULT,
  CHAIN_KEY,
  PROVER_URL_DEFAULT,
  SOURCE_CHAIN_ID,
  SOURCE_RPCS_DEFAULT,
  SOURCE_RPC_DEFAULT,
  requireChainKey,
  type ChainKey,
} from './lib/networks';

/// What the environment says about the networks `./lib/networks` describes.
///
/// The addresses, chain keys and default endpoints live there, unconditioned, so the browser
/// console can import the same ones. This file is the node half: it reads `.env` and it builds
/// providers, neither of which a browser can do.
export {
  CC3_CHAIN_ID,
  CHAIN_KEY,
  CHAIN_INFO_ADDRESS,
  SOURCE_CHAIN_ID,
  requireChainKey,
  USDC,
  AAVE_V3_POOL,
  TRANSFER_SIG,
  AAVE_REPAY_SIG,
  AAVE_LIQUIDATION_SIG,
  type ChainKey,
} from './lib/networks';

/// Creditcoin CC3 Testnet.
export const CC3_RPC = process.env.CC3_RPC ?? CC3_RPC_DEFAULT;

/// The hosted Proof Builder for CC3 testnet.
export const PROVER_URL = process.env.PROVER_URL ?? PROVER_URL_DEFAULT;

/// Source-chain RPCs, environment first.
export const SOURCE_RPC: Record<ChainKey, string> = {
  [CHAIN_KEY.mainnet]: process.env.MAINNET_RPC ?? SOURCE_RPC_DEFAULT[CHAIN_KEY.mainnet],
  [CHAIN_KEY.sepolia]: process.env.SEPOLIA_RPC ?? SOURCE_RPC_DEFAULT[CHAIN_KEY.sepolia],
};

export const cc3 = () => new JsonRpcProvider(CC3_RPC, CC3_CHAIN_ID, { staticNetwork: true });
export const source = (chainKey: number) => {
  const key = requireChainKey(chainKey);
  return new JsonRpcProvider(SOURCE_RPC[key], SOURCE_CHAIN_ID[key], { staticNetwork: true });
};

const list = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

/// `MAINNET_RPCS` / `SEPOLIA_RPCS` **replace** the defaults; `*_RPCS_EXTRA` adds to them.
///
/// A watcher concluding "this claim is complete" is trusting one node to have told it about every
/// log. That is the protocol's own problem reappearing one layer down, and one endpoint cannot
/// detect it.
///
/// The defaults in `./lib/networks` are endpoints checked to actually answer. An earlier list
/// carried three per chain, two of which were dead — which meant the two-source minimum for
/// sealing a claim could never be met and nothing could be built at all. A safety default that
/// makes the system unusable is not a safety default; keep that list short and verified rather
/// than long and hopeful.
///
/// Two per chain is the floor, not a comfortable margin: lose one and claims stop being sealable
/// until it returns. Anyone running this for real should add their own through `*_RPCS_EXTRA`,
/// ideally ones they pay for and nobody else shares.
///
/// An earlier version only ever appended, which meant an operator who knew the bundled public
/// endpoints were rate-limited — or worse, that one of them was the claimant's — had no way to
/// drop them. Widening a trust set has to come with the ability to narrow it.
export const SOURCE_RPCS: Record<ChainKey, string[]> = {
  [CHAIN_KEY.mainnet]: [
    ...(list(process.env.MAINNET_RPCS).length
      ? list(process.env.MAINNET_RPCS)
      : SOURCE_RPCS_DEFAULT[CHAIN_KEY.mainnet]),
    ...list(process.env.MAINNET_RPCS_EXTRA),
  ],
  [CHAIN_KEY.sepolia]: [
    ...(list(process.env.SEPOLIA_RPCS).length
      ? list(process.env.SEPOLIA_RPCS)
      : SOURCE_RPCS_DEFAULT[CHAIN_KEY.sepolia]),
    ...list(process.env.SEPOLIA_RPCS_EXTRA),
  ],
};

/// Milliseconds an endpoint gets before it is treated as absent.
/// A watcher is racing a challenge window; a node that never answers has to cost it a timeout,
/// not the whole sweep.
export const SOURCE_TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS ?? 25_000);

export const sources = (chainKey: number) => {
  const key = requireChainKey(chainKey);
  return [...new Set(SOURCE_RPCS[key])].map((url) => {
    const request = new FetchRequest(url);
    request.timeout = SOURCE_TIMEOUT_MS;
    return {
      url,
      provider: new JsonRpcProvider(request, SOURCE_CHAIN_ID[key], { staticNetwork: true }),
    };
  });
};

/// Give up on `work` after `ms`, so one unresponsive endpoint cannot stall a sweep.
export async function withDeadline<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, bell]);
  } finally {
    clearTimeout(timer!);
  }
}

export function requirePrivateKey(): string {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY missing. Copy .env.example to .env and fill it in.');
  return pk.startsWith('0x') ? pk : `0x${pk}`;
}
