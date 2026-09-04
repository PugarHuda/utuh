import {
  BrowserProvider,
  Contract,
  FetchRequest,
  JsonRpcProvider,
  type Eip1193Provider,
  type JsonRpcPayload,
  type JsonRpcResult,
  type Signer,
} from 'ethers';
import {
  CC3_CHAIN_ID,
  CC3_RPC_DEFAULT,
  CC3_RPC_FALLBACK,
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

/// One request against one endpoint, with a deadline of its own — the body of ethers'
/// `JsonRpcProvider._send`, minus the connection it keeps.
async function sendTo(url: string, payload: JsonRpcPayload | JsonRpcPayload[], timeoutMs: number) {
  const request = new FetchRequest(url);
  request.body = JSON.stringify(payload);
  request.setHeader('content-type', 'application/json');
  request.timeout = timeoutMs;
  const response = await request.send();
  response.assertOk();
  // JSON-RPC errors ride along in this array too; ethers' own `_send` types it the same way.
  const body = response.bodyJson as JsonRpcResult | JsonRpcResult[];
  return Array.isArray(body) ? body : [body];
}

/// Creditcoin publishes exactly one RPC hostname, and a page whose every number comes from it is
/// down whenever it is. Reads retry against Blockscout's proxy for the same chain when the primary
/// fails to *answer* — a transport failure, an HTTP error, a deadline. A JSON-RPC error is an
/// answer (a revert is the chain speaking) and is never retried, so the two endpoints cannot give
/// this page two opinions. Writes are unaffected: they go through the visitor's wallet.
///
/// Every read on this page is raced against 30s. A dead primary fails in milliseconds, which
/// leaves both fallback attempts inside that budget; only a primary that *hangs* for its full 7s
/// can push the retry past the bell, and then the pane says so rather than waiting.
class FailoverProvider extends JsonRpcProvider {
  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]) {
    try {
      return await sendTo(CC3_RPC_DEFAULT, payload, 7_000);
    } catch {
      // 15s, not 10: the proxy rations bursts by *holding* the excess, not by refusing it —
      // measured, a parked request is answered within ~12s of being sent. A 10s deadline was
      // aborting requests moments before their answer arrived. The second attempt is for the
      // request parked past even that: the ration refills on a ~10s cycle, so a retry that
      // rejoins the queue almost always lands in the next window.
      try {
        return await gated(() => sendTo(CC3_RPC_FALLBACK, payload, 15_000));
      } catch {
        return await gated(() => sendTo(CC3_RPC_FALLBACK, payload, 15_000));
      }
    }
  }
}

/// At most three fallback requests in the air at once.
///
/// The proxy serves bursts one after another rather than side by side — eight concurrent
/// batches measured 4–7s *each*, against ~2s alone — so a page-load's worth of ungated reads
/// queues its own tail past any per-request deadline. The gate holds the queue here, where
/// waiting is free, instead of inside the request, where it counts against the deadline.
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

/// The read-only side, always available, wallet or no wallet.
///
/// `batchMaxCount: 5` is the fallback's measured ceiling, not a taste: Blockscout's proxy answers
/// a 5-call batch in 2s and 413s a 10-call one, while sending every call singly trips its rate
/// limit instead — the Claims pane's burst of forty reads timed out one by one. Five per request
/// clears both, and costs the primary nothing it notices.
export const cc3: JsonRpcProvider = new FailoverProvider(CC3_RPC_DEFAULT, CC3_CHAIN_ID, {
  staticNetwork: true,
  batchMaxCount: 5,
});

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

/// A wallet that announced itself (EIP-6963), by the name it gave.
export interface Announced {
  name: string;
  provider: Eip1193Provider;
}

/// `window.ethereum` is one slot, and two installed wallets fight over it — whichever loaded last
/// wins, and that is not necessarily the one the person meant to use. EIP-6963 is the fix the
/// wallets agreed on: each announces itself with a name, the page lists them, the person picks.
/// The request is dispatched once here, at load; wallets answer synchronously, and any that
/// install later announce on their own. `window.ethereum` stays the fallback for a wallet that
/// only does the old thing.
const announced: Announced[] = [];
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e) => {
    const detail = (e as CustomEvent<{ info?: { name?: string }; provider?: Eip1193Provider }>).detail;
    if (!detail?.provider || announced.some((a) => a.provider === detail.provider)) return;
    announced.push({ name: detail.info?.name?.trim() || 'wallet', provider: detail.provider });
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function wallets(): Announced[] {
  if (announced.length) return announced;
  return typeof window !== 'undefined' && window.ethereum ? [{ name: 'wallet', provider: window.ethereum }] : [];
}

export function hasWallet(): boolean {
  return wallets().length > 0;
}

/// The wallet `connect` was last called with — what every later signature and chain switch on
/// this page goes through, so that picking a wallet by name picks it for the whole session.
let chosen: Eip1193Provider | undefined;
export function walletProvider(): Eip1193Provider | undefined {
  return chosen ?? wallets()[0]?.provider;
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
export async function connect(which?: Eip1193Provider): Promise<{ signer: Signer; address: string }> {
  const eth = which ?? wallets()[0]?.provider;
  if (!eth) throw new Error('no wallet in this browser');
  chosen = eth;
  const provider = new BrowserProvider(eth, 'any');
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
