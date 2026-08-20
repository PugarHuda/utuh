import { JsonRpcProvider } from 'ethers';
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

/// Source-chain RPCs. Mainnet is the interesting one: CC3 testnet attests Ethereum mainnet, so
/// contracts on a free testnet can be underwritten on real history.
export const SOURCE_RPC: Record<number, string> = {
  // Tenderly's public gateway is the one free endpoint tested here that serves a 216,000-block
  // filtered eth_getLogs in a single call. Watchers need that sweep, so it is the default.
  [CHAIN_KEY.mainnet]: process.env.MAINNET_RPC ?? 'https://gateway.tenderly.co/public/mainnet',
  [CHAIN_KEY.sepolia]: process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com',
};

export const cc3 = () => new JsonRpcProvider(CC3_RPC, CC3_CHAIN_ID, { staticNetwork: true });
export const source = (chainKey: number) => new JsonRpcProvider(SOURCE_RPC[chainKey]);

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
