import type { JsonRpcPayload, JsonRpcResult } from 'ethers';

/// When a CC3 read may be answered by Blockscout's eth-rpc proxy instead of Creditcoin's own RPC.
///
/// Pure and dependency-free (ethers types only), so the node scripts (`./chain.ts`) and the browser
/// console (`web/chain.ts`) decide failover by one rule rather than two copies that drift. Every fact
/// below was measured against the live proxy; the checks in `npm run puretest` pin each one.

/// The only methods any caller will ask Blockscout's proxy instead of Creditcoin's own RPC.
///
/// Reads, and only the three every script here depends on: the head, precompile and contract views,
/// and logs. Everything else — above all `eth_sendRawTransaction`, and the nonce and gas estimate a
/// write is built from — stays on the primary. A write that half-happened through one endpoint and
/// was retried through another is a double spend of a bond; a read asked twice is just a read.
export const FAILOVER_READS: ReadonlySet<string> = new Set(['eth_call', 'eth_getLogs', 'eth_blockNumber']);

/// Calls per request to the proxy. Measured 2026-09-14 against
/// `creditcoin-testnet.blockscout.com/api/eth-rpc`: a 5-call batch answers, a 6-call batch is
/// refused with 413, and so is everything larger. The primary takes a hundred; this is the
/// proxy's ceiling, not a taste.
export const FALLBACK_BATCH = 5;

/// One JSON-RPC round trip, a batch at a time.
export type RpcSend = (payload: JsonRpcPayload[]) => Promise<JsonRpcResult[]>;

/// Ask the primary, and the fallback only when the primary did not *answer*.
///
/// A transport failure — refused, reset, timed out, an HTTP error status, a 413 from the nginx in
/// front of it — throws, and a read that threw is asked again of the fallback in batches it
/// accepts. A JSON-RPC error is not a throw: a revert comes back inside the result array (measured,
/// both endpoints return a `-32603 … revert Unknown selector` body with status 200), and it is
/// returned as it is, so the two endpoints never give a script two opinions about one call.
///
/// Pure in everything but the two functions it is handed, which is what lets `npm run puretest`
/// pin all three rules without a network.
export async function sendWithFailover(
  payload: JsonRpcPayload[],
  primary: RpcSend,
  fallback: RpcSend | null,
  onFallback: (e: unknown) => void = () => {},
): Promise<JsonRpcResult[]> {
  try {
    return await primary(payload);
  } catch (e) {
    if (!fallback || !payload.every(proxyAnswersFaithfully)) throw e;
    onFallback(e);
    const asked = payload.map(forProxy);
    const out: JsonRpcResult[] = [];
    for (let i = 0; i < asked.length; i += FALLBACK_BATCH) {
      out.push(...(await fallback(asked.slice(i, i + FALLBACK_BATCH))));
    }
    for (const [i, r] of out.entries()) {
      const logs = (r as { result?: unknown }).result;
      if (payload[i]?.method === 'eth_getLogs' && Array.isArray(logs) && logs.length >= PROXY_LOG_CAP) {
        // Truncated, not complete: unknown is the only honest answer, and a throw is how a read says it.
        throw new Error(`the CC3 read fallback returned ${logs.length} logs, its silent cap — the answer may be cut short`);
      }
    }
    return out;
  }
}

/// Blockscout's eth-rpc proxy stops at this many logs and does not say so. Measured by feature-scout2
/// on 2026-09-14 against the same software on eth.blockscout.com: a WETH Transfer query tenderly
/// answered with 3,847 logs came back with exactly 1,000.
export const PROXY_LOG_CAP = 1000;

/// Whether the proxy can be trusted with this request at all.
///
/// Its `eth_getLogs` is wrong for two filter shapes, both measured against the primary on
/// 2026-09-14. A null topic before a non-null one returns nothing: the registry's `[null, claim 20]`
/// over blocks 5,375,865–5,375,965 is 3 logs at the primary and 0 at the proxy, a silent omission. And
/// a null in the middle makes it ignore the topics after it, so `[Transfer, null, to]` comes back
/// wider than asked. A filter with no address is refused outright. So only the shape it gets right
/// fails over: an address, and topics with no gaps. Anything else stays on the primary and fails there
/// as unknown — an omission that looks like an answer is exactly the false "complete" this project
/// exists to prevent.
function proxyAnswersFaithfully(p: JsonRpcPayload): boolean {
  if (!FAILOVER_READS.has(p.method)) return false;
  if (p.method !== 'eth_getLogs') return true;
  const filter = (Array.isArray(p.params) ? p.params[0] : undefined) as
    | { address?: unknown; topics?: unknown[]; blockHash?: unknown }
    | undefined;
  if (!filter || !filter.address) return false;
  const topics = [...(filter.topics ?? [])];
  while (topics.length && topics[topics.length - 1] == null) topics.pop();
  return topics.every((t) => typeof t === 'string');
}

/// The same request in words the proxy accepts.
///
/// The SDK's ChainInfo client reads at block tag `finalized`, and the proxy answers `finalized` and
/// `safe` with `"error": "Invalid block number"` — which is a JSON-RPC error, so without this every
/// precompile read would have failed over to a refusal. Measured 2026-09-14, three samples: the
/// primary finalizes two blocks behind its head, and the proxy's `latest` is exactly the primary's
/// `finalized` each time, because Blockscout serves what it has indexed and it indexes finalized
/// blocks. So `latest` at the proxy is the block `finalized` names at the primary.
export function forProxy(p: JsonRpcPayload): JsonRpcPayload {
  if (!Array.isArray(p.params)) return p;
  const params = p.params.map((v) => (v === 'finalized' || v === 'safe' ? 'latest' : v));
  return { ...p, params };
}

