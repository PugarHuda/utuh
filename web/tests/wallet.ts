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
///
/// `chainId` starts the wallet on another chain (hex), the way a MetaMask left on Sepolia arrives;
/// `rejectSwitch` is its owner declining the page's request to move. Every method the page asks for
/// is recorded in `window.__utuhWalletCalls`, so a test can say what the page requested, not only
/// what it showed.
export async function injectWallet(
  page: Page,
  privateKey: string,
  opts: {
    rejectSends?: boolean;
    announce?: string;
    noLegacy?: boolean;
    chainId?: string;
    rejectSwitch?: boolean;
  } = {},
): Promise<string> {
  const known = chains(privateKey);
  const address = await new Wallet(privateKey).getAddress();

  await page.exposeFunction('__utuhSign', async (chainIdHex: string, tx: Record<string, string>) => {
    // A thrown error loses its `code` crossing into the page, and the code is what a real wallet's
    // refusal is recognised by, so the refusal comes back as data and the page side throws it.
    if (opts.rejectSends) {
      return { error: { code: 4001, message: 'MetaMask Tx Signature: User denied transaction signature.' } };
    }
    const chain = known[chainIdHex.toLowerCase()];
    if (!chain) throw new Error(`the test wallet has no key for chain ${chainIdHex}`);
    const sent = await chain.wallet.sendTransaction({
      to: tx.to!,
      data: tx.data ?? '0x',
      ...(tx.value ? { value: BigInt(tx.value) } : {}),
    });
    return { hash: sent.hash };
  });

  const rpcs = Object.fromEntries(Object.entries(known).map(([id, c]) => [id, c.rpc]));

  // Plain JavaScript in a string, not a function: Playwright serialises a function with
  // `toString()`, and outside its own runner — under tsx, which the screenshot script uses — the
  // transpiled body carries an `__name(...)` helper the browser has never heard of. The init script
  // then throws before `window.ethereum` exists, silently, and the page says "no wallet".
  const init = `(() => {
    const account = ${JSON.stringify(address)};
    const rpcs = ${JSON.stringify(rpcs)};
    let current = ${JSON.stringify(opts.chainId ?? '0x' + CC3_CHAIN_ID.toString(16))};
    const calls = (window.__utuhWalletCalls = []);
    const passthrough = async (method, params) => {
      const res = await fetch(rpcs[current], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const body = await res.json();
      if (body.error) throw Object.assign(new Error(body.error.message), body.error);
      return body.result;
    };
    const listeners = {};
    const emit = (event, ...args) => (listeners[event] || []).forEach((l) => l(...args));
    const provider = {
      isUtuhTestWallet: true,
      request: async ({ method, params = [] }) => {
        calls.push({ method, params });
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [account];
          case 'eth_chainId':
            return current;
          case 'net_version':
            return String(parseInt(current, 16));
          case 'wallet_switchEthereumChain': {
            if (${JSON.stringify(opts.rejectSwitch === true)}) {
              throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
            }
            const wanted = String(params[0].chainId).toLowerCase();
            if (!rpcs[wanted]) throw Object.assign(new Error('unknown chain'), { code: 4902 });
            current = wanted;
            emit('chainChanged', current);
            return null;
          }
          case 'wallet_addEthereumChain':
            return null;
          case 'eth_sendTransaction': {
            const signed = await window.__utuhSign(current, params[0]);
            if (signed.error) throw Object.assign(new Error(signed.error.message), { code: signed.error.code });
            return signed.hash;
          }
          default:
            return passthrough(method, params);
        }
      },
      on: (event, handler) => {
        (listeners[event] = listeners[event] || []).push(handler);
      },
      removeListener: (event, handler) => {
        listeners[event] = (listeners[event] || []).filter((h) => h !== handler);
      },
    };
    if (!${JSON.stringify(opts.noLegacy === true)}) window.ethereum = provider;
    // EIP-6963: announce on request and once unprompted, the way MetaMask and Rabby do.
    const name = ${JSON.stringify(opts.announce ?? null)};
    if (name) {
      const detail = Object.freeze({
        info: {
          uuid: crypto.randomUUID(),
          name,
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
          rdns: 'test.utuh.' + name.replace(/\W/g, ''),
        },
        provider,
      });
      const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    }
  })();`;
  await page.addInitScript({ content: init });

  return address;
}
