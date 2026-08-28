import { BrowserProvider, Contract, JsonRpcProvider, type Eip1193Provider, type Signer } from 'ethers';
import {
  CC3_CHAIN_ID,
  CC3_RPC_DEFAULT,
  CHAIN_INFO_ADDRESS,
  SOURCE_CHAIN_ID,
  SOURCE_RPCS_DEFAULT,
  requireChainKey,
  type DeploymentName,
} from '../offchain/lib/networks';

/// Everything the console needs to talk to Creditcoin, and nothing it needs a server for.
///
/// The page reads the chain itself. There is no backend holding a key, no indexer, no cached copy
/// of what the registry says — the numbers on screen are `eth_call` results from
/// `rpc.cc3-testnet.creditcoin.network`, which anyone can point their own client at and get the
/// same answers from.

export interface Deployments {
  chainId?: number;
  registry?: string;
  credit?: string;
  decoder?: string;
  ledger?: string;
  sourceChainKey?: number;
  challengeWindow?: number;
  deployer?: string;
}

/// Give a read this long, then call the endpoint unreachable.
///
/// A provider pointed at an endpoint that refuses connections does not fail fast; it retries, and
/// the page it was drawing sits at "loading" with nothing on screen for as long as the retries go
/// on. Measured: ninety seconds and still loading. A page that cannot reach the chain has to say so
/// inside the time a person is willing to wait, which is not ninety seconds.
export async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer from Creditcoin in ${ms / 1000}s`)), ms);
  });
  try {
    return await Promise.race([work, bell]);
  } finally {
    clearTimeout(timer);
  }
}

/// The read-only side, always available, wallet or no wallet.
export const cc3 = new JsonRpcProvider(CC3_RPC_DEFAULT, CC3_CHAIN_ID, { staticNetwork: true });

/// Independent source-chain endpoints, the same list the watcher script sweeps.
export function sourceEndpoints(chainKey: number): { url: string; provider: JsonRpcProvider }[] {
  const key = requireChainKey(chainKey);
  return SOURCE_RPCS_DEFAULT[key].map((url) => ({
    url,
    provider: new JsonRpcProvider(url, SOURCE_CHAIN_ID[key], { staticNetwork: true }),
  }));
}

/// What a statically-hosted build has baked into the page.
///
/// `npm run web` serves the ABIs and the deployment record over HTTP because the files are right
/// there on disk. A static host has no server to do that, so `npm run web:static` writes them into
/// the page itself, read from the same forge artifacts at build time. Either way the page holds the
/// ABI the contracts were compiled with, and either way everything the page then *does* is a call
/// to a public endpoint from the visitor's own browser.
interface Baked {
  abis: Abis;
  deployments: Record<string, Deployments>;
}

/// Which published deployment the page is looking at — `?deployment=mainnet` for the one that
/// underwrites real Aave history, the completed Sepolia loop otherwise.
export function deploymentName(): DeploymentName {
  const asked = new URLSearchParams(location.search).get('deployment');
  return asked === 'mainnet' ? 'mainnet' : 'sepolia';
}

function baked(): Baked | undefined {
  return (globalThis as { __UTUH__?: Baked }).__UTUH__;
}

async function json<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export interface Abis {
  registry: unknown[];
  credit: unknown[];
  chainInfo: unknown[];
}

/// ABIs come from forge's own artifacts, served straight out of `out/`.
///
/// Not copied into the page and not hand-written: a console showing a field the contract stopped
/// having is worse than a console that fails to load.
export async function loadAbis(): Promise<Abis> {
  const inPage = baked();
  if (inPage) return inPage.abis;

  const [registry, credit, chainInfo] = await Promise.all([
    json<unknown[]>('/abi/UtuhRegistry.json'),
    json<unknown[]>('/abi/UtuhCredit.json'),
    json<unknown[]>('/abi/IChainInfo.json'),
  ]);
  return { registry, credit, chainInfo };
}

export function loadDeployments(which: DeploymentName): Promise<Deployments> {
  const inPage = baked();
  if (inPage) {
    const d = inPage.deployments[which];
    return d ? Promise.resolve(d) : Promise.reject(new Error(`no ${which} deployment was baked into this build`));
  }
  return json<Deployments>(`/deployments/${which}.json`);
}

export interface Wired {
  abis: Abis;
  which: DeploymentName;
  deployments: Deployments;
  registry: Contract;
  credit: Contract;
  chainInfo: Contract;
}

export async function wire(): Promise<Wired> {
  const which = deploymentName();
  const [abis, deployments] = await Promise.all([loadAbis(), loadDeployments(which)]);
  if (!deployments.registry || !deployments.credit) {
    throw new Error('the deployment record names no registry or credit — run: npm run full');
  }
  return {
    abis,
    which,
    deployments,
    registry: new Contract(deployments.registry, abis.registry as never, cc3),
    credit: new Contract(deployments.credit, abis.credit as never, cc3),
    chainInfo: new Contract(CHAIN_INFO_ADDRESS, abis.chainInfo as never, cc3),
  };
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider & { on?: (event: string, handler: (...args: unknown[]) => void) => void };
  }
}

export function hasWallet(): boolean {
  return typeof window !== 'undefined' && window.ethereum !== undefined;
}

/// CC3 Testnet as a wallet would need it added.
const CC3_PARAMS = {
  chainId: '0x' + CC3_CHAIN_ID.toString(16),
  chainName: 'Creditcoin CC3 Testnet',
  nativeCurrency: { name: 'Creditcoin', symbol: 'CTC', decimals: 18 },
  rpcUrls: [CC3_RPC_DEFAULT],
  blockExplorerUrls: ['https://creditcoin-testnet.blockscout.com'],
};

/// Connect a wallet and make sure it is pointed at CC3, adding the network if it has never seen it.
export async function connect(): Promise<{ signer: Signer; address: string }> {
  if (!window.ethereum) throw new Error('no wallet in this browser');
  const provider = new BrowserProvider(window.ethereum, 'any');
  await provider.send('eth_requestAccounts', []);

  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CC3_CHAIN_ID) {
    try {
      await provider.send('wallet_switchEthereumChain', [{ chainId: CC3_PARAMS.chainId }]);
    } catch {
      // 4902 and its many spellings: the wallet does not know this chain yet.
      await provider.send('wallet_addEthereumChain', [CC3_PARAMS]);
    }
  }

  const signer = await provider.getSigner();
  return { signer, address: await signer.getAddress() };
}

export const EXPLORER = 'https://creditcoin-testnet.blockscout.com';

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
