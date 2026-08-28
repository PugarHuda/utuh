import type { Page } from '@playwright/test';
import { JsonRpcProvider, Wallet } from 'ethers';
import {
  CC3_CHAIN_ID,
  CC3_RPC_DEFAULT,
  CHAIN_KEY,
  SOURCE_CHAIN_ID,
  SOURCE_RPC_DEFAULT,
} from '../../offchain/lib/networks';

/// A wallet for the page under test, backed by a key this process holds.
///
/// What stands in for MetaMask is a wallet, not a mock chain. Every read the page makes goes to the
/// real public RPC for whichever chain the wallet is currently on; every `eth_sendTransaction` is
/// handed back to this process, signed with a real key, and broadcast. The key never reaches the
/// browser. The transactions that come out the other end are real, verified by the real precompile,
/// and cost real testnet gas.
///
/// It also switches chains, because the borrow flow does: the control commitment goes out on the
/// source chain, and the page asks the wallet to move there and back. `wallet_switchEthereumChain`
/// changes which RPC reads go to and which key signs, and nothing else — which is what a wallet
/// does.

/// Chains the wallet knows, keyed by the hex chain id the page will ask for.
function chains(privateKey: string): Record<string, { rpc: string; wallet: Wallet }> {
  const cc3 = new JsonRpcProvider(CC3_RPC_DEFAULT, CC3_CHAIN_ID, { staticNetwork: true });
  const sepolia = new JsonRpcProvider(SOURCE_RPC_DEFAULT[CHAIN_KEY.sepolia], SOURCE_CHAIN_ID[CHAIN_KEY.sepolia], {
    staticNetwork: true,
  });
  return {
    ['0x' + CC3_CHAIN_ID.toString(16)]: { rpc: CC3_RPC_DEFAULT, wallet: new Wallet(privateKey, cc3) },
    ['0x' + SOURCE_CHAIN_ID[CHAIN_KEY.sepolia].toString(16)]: {
      rpc: SOURCE_RPC_DEFAULT[CHAIN_KEY.sepolia],
      wallet: new Wallet(privateKey, sepolia),
    },
  };
}

/// Put a working EIP-1193 provider on the page. Returns the account it will answer with.
///
/// `rejectSends` makes it a wallet whose owner presses "Reject" on every signature — error 4001,
/// the way MetaMask reports it — which is how the page's every write path gets exercised for what
/// it does when the person says no.
export async function injectWallet(
  page: Page,
  privateKey: string,
  opts: { rejectSends?: boolean } = {},
): Promise<string> {
  const known = chains(privateKey);
  const address = await new Wallet(privateKey).getAddress();

  await page.exposeFunction('__utuhSign', async (chainIdHex: string, tx: Record<string, string>) => {
    if (opts.rejectSends) {
      throw Object.assign(new Error('MetaMask Tx Signature: User denied transaction signature.'), { code: 4001 });
    }
    const chain = known[chainIdHex.toLowerCase()];
    if (!chain) throw new Error(`the test wallet has no key for chain ${chainIdHex}`);
    const sent = await chain.wallet.sendTransaction({
      to: tx.to!,
      data: tx.data ?? '0x',
      ...(tx.value ? { value: BigInt(tx.value) } : {}),
    });
    return sent.hash;
  });

  const rpcs = Object.fromEntries(Object.entries(known).map(([id, c]) => [id, c.rpc]));

  await page.addInitScript(
    ({ account, start, rpcs }) => {
      let current = start;

      const passthrough = async (method: string, params: unknown[]) => {
        const res = await fetch(rpcs[current]!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        });
        const body = await res.json();
        if (body.error) throw Object.assign(new Error(body.error.message), body.error);
        return body.result;
      };

      const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
      const emit = (event: string, ...args: unknown[]) => (listeners[event] ?? []).forEach((l) => l(...args));

      (window as unknown as { ethereum: unknown }).ethereum = {
        isUtuhTestWallet: true,
        request: async ({ method, params = [] }: { method: string; params?: unknown[] }) => {
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [account];
            case 'eth_chainId':
              return current;
            case 'net_version':
              return String(parseInt(current, 16));
            case 'wallet_switchEthereumChain': {
              const wanted = String((params as { chainId: string }[])[0]!.chainId).toLowerCase();
              if (!rpcs[wanted]) throw Object.assign(new Error('unknown chain'), { code: 4902 });
              current = wanted;
              emit('chainChanged', current);
              return null;
            }
            case 'wallet_addEthereumChain':
              return null;
            case 'eth_sendTransaction':
              return (window as unknown as { __utuhSign: (c: string, tx: unknown) => Promise<string> }).__utuhSign(
                current,
                (params as Record<string, string>[])[0],
              );
            default:
              return passthrough(method, params);
          }
        },
        on: (event: string, handler: (...a: unknown[]) => void) => {
          (listeners[event] ??= []).push(handler);
        },
        removeListener: (event: string, handler: (...a: unknown[]) => void) => {
          listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
        },
      };
    },
    { account: address, start: '0x' + CC3_CHAIN_ID.toString(16), rpcs },
  );

  return address;
}
