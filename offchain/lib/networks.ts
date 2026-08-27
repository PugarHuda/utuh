/// Everything about the networks that is a fact rather than a setting.
///
/// Split out of `config.ts` because the browser console needs the same addresses, chain keys and
/// endpoints, and `config.ts` reads `process.env` at import time — which does not exist in a
/// browser and cannot be polyfilled honestly. Two copies of a chain key is exactly the drift this
/// repository keeps refusing everywhere else: the console would sweep one chain while the scripts
/// proved another, and both would look right.
///
/// So: the defaults live here, pure, importable from either side. `config.ts` still owns the
/// environment overrides, because only the node side has an environment.

export const CC3_RPC_DEFAULT = 'https://rpc.cc3-testnet.creditcoin.network';

/// Chain id verified live: eth_chainId -> 0x18e8f (102031).
export const CC3_CHAIN_ID = 102031;

/// The hosted Proof Builder for CC3 testnet.
export const PROVER_URL_DEFAULT = 'https://prover.cc3-testnet.creditcoin.network';

/// The same service, under the hostname the Attestcoin docs publish. Both answer; keeping the
/// second means a rename or a retirement of the first is a fallback rather than an outage, and the
/// documented name is the one likeliest to outlive it.
export const PROVER_URL_ALTERNATE = 'https://proof-gen-api.cc3-testnet.creditcoin.network';

/// The ChainInfo precompile, quoted once so nothing has to remember the checksum.
export const CHAIN_INFO_ADDRESS = '0x0000000000000000000000000000000000000fD3';

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
export function requireChainKey(chainKey: number): ChainKey {
  if (chainKey !== CHAIN_KEY.sepolia && chainKey !== CHAIN_KEY.mainnet) {
    const known = Object.entries(CHAIN_KEY)
      .map(([name, key]) => `${key} (${name})`)
      .join(', ');
    throw new Error(`chain key ${chainKey} is not configured — this build knows ${known}`);
  }
  return chainKey;
}

export const CHAIN_NAME: Record<ChainKey, string> = {
  [CHAIN_KEY.mainnet]: 'Ethereum mainnet',
  [CHAIN_KEY.sepolia]: 'Ethereum Sepolia',
};

/// EVM chain ids for the source chains, so providers never have to go and ask.
export const SOURCE_CHAIN_ID: Record<ChainKey, number> = {
  [CHAIN_KEY.mainnet]: 1,
  [CHAIN_KEY.sepolia]: 11155111,
};

/// Source-chain RPCs. Mainnet is the interesting one: CC3 testnet attests Ethereum mainnet, so
/// contracts on a free testnet can be underwritten on real history.
///
/// Tenderly's public gateway is the one free endpoint tested here that serves a 216,000-block
/// filtered eth_getLogs in a single call. Watchers need that sweep, so it is first.
export const SOURCE_RPC_DEFAULT: Record<ChainKey, string> = {
  [CHAIN_KEY.mainnet]: 'https://gateway.tenderly.co/public/mainnet',
  [CHAIN_KEY.sepolia]: 'https://ethereum-sepolia-rpc.publicnode.com',
};

/// Independent endpoints for the same chain, for anything that needs a second opinion.
export const SOURCE_RPCS_DEFAULT: Record<ChainKey, string[]> = {
  [CHAIN_KEY.mainnet]: [SOURCE_RPC_DEFAULT[CHAIN_KEY.mainnet], 'https://rpc.mevblocker.io'],
  [CHAIN_KEY.sepolia]: [SOURCE_RPC_DEFAULT[CHAIN_KEY.sepolia], 'https://sepolia.gateway.tenderly.co'],
};

/// Well-known mainnet fixtures used by the demo flows.
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';

export const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/// Aave V3 Pool: Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)
export const AAVE_REPAY_SIG = '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051';
/// Aave V3 Pool: LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, ...)
export const AAVE_LIQUIDATION_SIG = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286';
