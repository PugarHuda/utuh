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

/// Blockscout's JSON-RPC proxy for the same chain — the only second way onto CC3 that exists.
///
/// The chain publishes exactly one RPC hostname, and on 2026-09-03 its nginx spent half a day
/// answering large `eth_call` bodies with 413, which took the proving path down with it. This
/// proxy is run by Blockscout rather than by the same nginx, is CORS-open, answers batches,
/// `eth_call` against the precompiles, and `eth_getLogs` — verified live before it was written
/// down here. Reads only ever need those, so the console falls back to it when the primary does
/// not answer.
export const CC3_RPC_FALLBACK = 'https://creditcoin-testnet.blockscout.com/api/eth-rpc';

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
  // Two truthful endpoints is the floor for sealing a claim, and publicnode alone does not clear
  // it: it is a pool, and some of its backends are pruned — the same 300-block WETH query 60,000
  // blocks deep answered 0, 8, 8, 0 on four consecutive calls while tenderly answered 8 each time.
  // The union sweep survives that (it keeps whatever any endpoint saw), so publicnode stays as a
  // source; it just cannot be one of the two. Of every free Sepolia endpoint that could be found,
  // these two answered the same query the same way four times running, answered a 2,000-block
  // window 300,000 blocks deep with all 5,691 logs, serve eth_getBlockReceipts, and allow a
  // browser to call them: 0xrpc.io and the Ethereum Foundation's ethpandaops. The rest: onfinality
  // rate-limits after one call, thirdweb refuses the deep window as too large a response, 1rpc
  // caps eth_getLogs, drpc/blastapi/blockpi/rpc2.sepolia.org refuse or time out, alchemy's demo
  // key is throttled, infura and nodereal want a key. Measured on 2026-08-28; `npm run doctor`
  // re-measures.
  [CHAIN_KEY.sepolia]: [
    SOURCE_RPC_DEFAULT[CHAIN_KEY.sepolia],
    'https://sepolia.gateway.tenderly.co',
    'https://0xrpc.io/sep',
    'https://rpc.sepolia.ethpandaops.io',
  ],
};

/// Endpoints that refuse `eth_getLogs` past a certain span, by host. The chain's default chunk
/// applies to everyone else. A sweep asks each endpoint in pieces it will actually answer, so a
/// small cap costs calls, not coverage. Measured, not read off a pricing page.
export const RANGE_CAP: Record<string, number> = {
  '1rpc.io': 50,
  'nodies.app': 50,
};

/// Blocks per `eth_getLogs` call for one endpoint on one chain.
export function chunkFor(url: string, chainKey: ChainKey, wanted = SWEEP_CHUNK[chainKey]): number {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* leave it */
  }
  const cap = Object.entries(RANGE_CAP).find(([h]) => host === h || host.endsWith('.' + h))?.[1];
  return cap ? Math.min(wanted, cap) : wanted;
}

/// Blocks per `eth_getLogs` call, per chain: the smallest cap among that chain's default
/// endpoints. Mainnet's two both serve ten thousand; Sepolia's publicnode stops answering past a
/// few hundred. A single sweep over 216,000 mainnet blocks is 22 calls per endpoint at this size
/// and 432 at Sepolia's, which is the difference between a page and a spinner.
export const SWEEP_CHUNK: Record<ChainKey, number> = {
  [CHAIN_KEY.mainnet]: 10_000,
  [CHAIN_KEY.sepolia]: 500,
};

/// Where a source-chain block or address can be read by a person.
export const SOURCE_EXPLORER: Record<ChainKey, string> = {
  [CHAIN_KEY.mainnet]: 'https://eth.blockscout.com',
  [CHAIN_KEY.sepolia]: 'https://eth-sepolia.blockscout.com',
};

/// The two published deployments, named by the chain they read. `sepolia` is the completed loop
/// a browser can borrow on; `mainnet` underwrites real Aave history and is where the claims about
/// real borrowers live.
export const DEPLOYMENT_RECORDS = {
  sepolia: 'deployments.full.json',
  mainnet: 'deployments.json',
} as const;
export type DeploymentName = keyof typeof DEPLOYMENT_RECORDS;

/// Creditcoin's own record of every verification the precompile emitted, per source chain.
export const ORACLE_DASHBOARD = 'https://dashboard.cc3-testnet.creditcoin.network/transaction-verifications';

/// The attestation indexer, which publishes what the attestors actually signed.
///
/// Everything else this repository reads about attestation comes from the ChainInfo precompile,
/// and the precompile answers two questions: how far has this chain been attested, and is this
/// height attested. It does not hand back the attested header hash, so nothing here could ever
/// check the attestation layer's own claim against the chain it claims to be attesting.
///
/// This endpoint does, it is CORS-open, and it needs no key — so a browser can ask Creditcoin what
/// hash it attested for Ethereum block N, ask an independent Ethereum endpoint what the hash of
/// block N actually is, and compare. That is this project's own argument turned one level down:
/// a claim is only worth what someone can check, including the oracle's.
/// Both Creditcoin networks publish one, and both are audited here.
///
/// The contracts live on CC3 Testnet, but Creditcoin *Mainnet* attests Ethereum mainnet too — the
/// same chain, by a different set of attestors, under a different chain key. Auditing only the
/// network this deployment sits on would leave the production oracle unchecked by the one page
/// that can check it, and would miss the strongest evidence either network is real: two
/// independent attestor sets signing the same Ethereum headers, checked from a browser against
/// Ethereum itself.
///
/// The chain keys differ between them and that is the whole reason `chainKey` is never assumed.
/// On CC3 Testnet, Ethereum mainnet is key 3 and Sepolia is key 1. On CC3 Mainnet, Ethereum
/// mainnet is key 1 — the same number that means Sepolia on testnet. Both read live from
/// `get_supported_chains()` and stated in the Attestcoin docs' environment pages.
export interface AttestationIndexer {
  /// What to call the Creditcoin network in the interface.
  label: string;
  graphql: string;
  /// The chain key Ethereum mainnet has *on that network*.
  ethereumKey: number;
}

export const ATTESTATION_INDEXERS: { testnet: AttestationIndexer; mainnet: AttestationIndexer } = {
  testnet: {
    label: 'Creditcoin CC3 Testnet',
    graphql: 'https://attestations-graphql.cc3-testnet.creditcoin.network/graphql',
    ethereumKey: 3,
  },
  mainnet: {
    label: 'Creditcoin Mainnet',
    graphql: 'https://attestations-graphql.cc3-mainnet-usc.creditcoin.network/graphql',
    ethereumKey: 1,
  },
};

/// Well-known mainnet fixtures used by the demo flows.
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const AAVE_V3_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';

export const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/// Aave V3 Pool: Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)
export const AAVE_REPAY_SIG = '0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051';
/// Aave V3 Pool: LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, ...)
export const AAVE_LIQUIDATION_SIG = '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286';
