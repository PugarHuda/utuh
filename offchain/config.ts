import { JsonRpcProvider, FetchRequest } from 'ethers';
import 'dotenv/config';

/// Creditcoin CC3 Testnet. Chain id verified live: eth_chainId -> 0x18e8f (102031).
export const CC3_RPC = process.env.CC3_RPC ?? 'https://rpc.cc3-testnet.creditcoin.network';
export const CC3_CHAIN_ID = 102031;

/// The hosted Proof Builder for CC3 testnet.
export const PROVER_URL = process.env.PROVER_URL ?? 'https://prover.cc3-testnet.creditcoin.network';

/// Attestcoin chain keys. These are Creditcoin-internal identifiers and are NOT EVM chain ids —
/// Sepolia's EVM chain id is 11155111 but its chain key is 1. Confirmed live against the
/// ChainInfo precompile's get_supported_chains().
export const CHAIN_KEY = {
  sepolia: 1,
  mainnet: 3,
} as const;

/// The chain keys this is configured for. Typing the tables below with this rather than `number`
/// is what makes an unsupported key a question the compiler asks instead of a provider quietly
/// built for `undefined`.
export type ChainKey = (typeof CHAIN_KEY)[keyof typeof CHAIN_KEY];

/// Narrow an arbitrary number to a configured chain key, or say which ones there are.
///
/// `scope.chainKey` arrives from a contract as a plain number, so this is the boundary where it
/// becomes something the rest of the file can index with. Before it existed, a scope carrying an
/// unconfigured key produced `new FetchRequest(undefined)` several calls later, and the error came
/// out of ethers with nothing in it about chain keys.
export function requireChainKey(chainKey: number): ChainKey {
  if (chainKey !== CHAIN_KEY.sepolia && chainKey !== CHAIN_KEY.mainnet) {
    const known = Object.entries(CHAIN_KEY)
      .map(([name, key]) => `${key} (${name})`)
      .join(', ');
    throw new Error(`chain key ${chainKey} is not configured — this build knows ${known}`);
  }
  return chainKey;
}

/// Source-chain RPCs. Mainnet is the interesting one: CC3 testnet attests Ethereum mainnet, so
/// contracts on a free testnet can be underwritten on real history.
export const SOURCE_RPC: Record<ChainKey, string> = {
  // Tenderly's public gateway is the one free endpoint tested here that serves a 216,000-block
  // filtered eth_getLogs in a single call. Watchers need that sweep, so it is the default.
  [CHAIN_KEY.mainnet]: process.env.MAINNET_RPC ?? 'https://gateway.tenderly.co/public/mainnet',
  [CHAIN_KEY.sepolia]: process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com',
};

/// The ChainInfo precompile, quoted once so nothing has to remember the checksum.
export const CHAIN_INFO_ADDRESS = '0x0000000000000000000000000000000000000fD3';

export const cc3 = () => new JsonRpcProvider(CC3_RPC, CC3_CHAIN_ID, { staticNetwork: true });
export const source = (chainKey: number) => {
  const key = requireChainKey(chainKey);
  return new JsonRpcProvider(SOURCE_RPC[key], SOURCE_CHAIN_ID[key], { staticNetwork: true });
};

/// Independent endpoints for the same chain, for anything that needs a second opinion.
///
/// A watcher concluding "this claim is complete" is trusting one node to have told it about every
/// log. That is the protocol's own problem reappearing one layer down, and one endpoint cannot
/// detect it. Set MAINNET_RPCS / SEPOLIA_RPCS to comma-separated URLs to widen it.
const DEFAULT_RPCS: Record<ChainKey, string[]> = {
  [CHAIN_KEY.mainnet]: [SOURCE_RPC[CHAIN_KEY.mainnet], 'https://rpc.mevblocker.io'],
  [CHAIN_KEY.sepolia]: [SOURCE_RPC[CHAIN_KEY.sepolia], 'https://sepolia.gateway.tenderly.co'],
};

const list = (v?: string) =>
  (v ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

/// `MAINNET_RPCS` / `SEPOLIA_RPCS` **replace** the defaults; `*_RPCS_EXTRA` adds to them.
///
/// The defaults are endpoints checked to actually answer. An earlier list carried three per chain,
/// two of which were dead — which meant the two-source minimum for sealing a claim could never be
/// met and nothing could be built at all. A safety default that makes the system unusable is not a
/// safety default; keep this list short and verified rather than long and hopeful.
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
    ...(list(process.env.MAINNET_RPCS).length ? list(process.env.MAINNET_RPCS) : DEFAULT_RPCS[CHAIN_KEY.mainnet]),
    ...list(process.env.MAINNET_RPCS_EXTRA),
  ],
  [CHAIN_KEY.sepolia]: [
    ...(list(process.env.SEPOLIA_RPCS).length ? list(process.env.SEPOLIA_RPCS) : DEFAULT_RPCS[CHAIN_KEY.sepolia]),
    ...list(process.env.SEPOLIA_RPCS_EXTRA),
  ],
};

/// Milliseconds an endpoint gets before it is treated as absent.
/// A watcher is racing a challenge window; a node that never answers has to cost it a timeout,
/// not the whole sweep.
export const SOURCE_TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS ?? 25_000);

/// EVM chain ids for the source chains, so providers never have to go and ask.
///
/// Without this ethers probes for the network on first use and, when an endpoint is unreachable,
/// retries that probe once a second forever — in the background, after the caller has already
/// given up. The abandoned timer then keeps the process alive and floods stderr, which is how a
/// watcher ends up unable to exit. Declaring the network removes the probe entirely.
export const SOURCE_CHAIN_ID: Record<ChainKey, number> = {
  [CHAIN_KEY.mainnet]: 1,
  [CHAIN_KEY.sepolia]: 11155111,
};

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

/// Well-known mainnet fixtures used by the demo flows.
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';

export const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/// Aave V3 Pool: Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)
export const AAVE_REPAY_SIG = '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051';
/// Aave V3 Pool: LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, ...)
export const AAVE_LIQUIDATION_SIG = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286';

export function requirePrivateKey(): string {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY missing. Copy .env.example to .env and fill it in.');
  return pk.startsWith('0x') ? pk : `0x${pk}`;
}
