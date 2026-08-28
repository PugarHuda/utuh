import { JsonRpcProvider, zeroPadValue, getAddress } from 'ethers';
import { chunkFor, requireChainKey } from './networks';

export enum Metric {
  COUNT = 0,
  DATA_WORD = 1,
}

const ZERO32 = '0x' + '00'.repeat(32);

/// Mirrors EventScope.Scope in Solidity, field for field and in order.
export interface Scope {
  chainKey: number;
  emitter: string;
  eventSig: string;
  topics: [string, string, string];
  topicMask: number;
  metric: Metric;
  metricArg: number;
}

/// Build a scope that matches `eventSig` from `emitter` where an indexed topic equals `subject`.
///
/// `pin` fixes a second indexed topic. Aave's Repay carries the reserve asset in topic 1, and
/// pinning it is what keeps an aggregate denominated in one asset instead of summing WETH's 18
/// decimals into USDC's 6.
export function scopeFor(opts: {
  chainKey: number;
  emitter: string;
  eventSig: string;
  subject?: string;
  subjectTopic?: 1 | 2 | 3;
  pin?: { topic: 1 | 2 | 3; value: string };
  metric?: Metric;
  metricArg?: number;
}): Scope {
  const topics: [string, string, string] = [ZERO32, ZERO32, ZERO32];
  let topicMask = 0;
  if (opts.subject) {
    const t = opts.subjectTopic ?? 1;
    topics[t - 1] = zeroPadValue(getAddress(opts.subject), 32);
    topicMask = 1 << (t - 1);
  }
  if (opts.pin) {
    topics[opts.pin.topic - 1] = zeroPadValue(getAddress(opts.pin.value), 32);
    topicMask |= 1 << (opts.pin.topic - 1);
  }
  return {
    chainKey: opts.chainKey,
    emitter: getAddress(opts.emitter),
    eventSig: opts.eventSig,
    topics,
    topicMask,
    metric: opts.metric ?? Metric.COUNT,
    metricArg: opts.metricArg ?? 0,
  };
}

/// One in-scope source-chain event, located precisely enough to prove and to order.
export interface ScopedEvent {
  blockNumber: number;
  txHash: string;
  txIndex: number;
  /// Index within *this transaction's* logs — not the block-wide log index. The registry keys
  /// events the way EvmV1Decoder hands them back, which is per transaction.
  logIndexInTx: number;
  value: bigint;
}

/// Ordering key, identical to EventScope.key on the Solidity side.
export function eventKey(e: ScopedEvent): bigint {
  return (BigInt(e.blockNumber) << 96n) | (BigInt(e.txIndex) << 32n) | BigInt(e.logIndexInTx);
}

/// Scan a source chain for every event a scope covers.
///
/// This is the honest claimant's job and the watcher's job at once: both run the same sweep, and
/// the protocol's security rests on the watcher being able to run it independently. Public RPCs
/// cap `eth_getLogs` ranges, so the sweep is chunked.
export async function scanScope(
  provider: JsonRpcProvider,
  scope: Scope,
  fromBlock: number,
  toBlock: number,
  chunkSize = 2000,
): Promise<ScopedEvent[]> {
  const filterTopics: (string | null)[] = [scope.eventSig];
  for (let i = 0; i < 3; i++) {
    filterTopics.push(scope.topicMask & (1 << i) ? scope.topics[i] : null);
  }
  while (filterTopics.length > 1 && filterTopics[filterTopics.length - 1] === null) filterTopics.pop();

  const found: ScopedEvent[] = [];
  // Transaction hash -> the block-wide indices of every log it emitted, ascending.
  const txLogIndices = new Map<string, number[]>();

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    const logs = await provider.getLogs({
      address: scope.emitter,
      topics: filterTopics as any,
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      // An endpoint's answer is not automatically an answer to the question. Everything below is
      // taken from whatever the node chose to send back, so anything that does not match what was
      // asked for is discarded rather than carried forward.
      //
      // This is not pedantry. A log claiming a block above the attestation frontier would become a
      // candidate the prover cannot prove and the chain cannot yet speak about — which, by the
      // rule that only a definite answer permits dropping, aborts the whole claim. One hostile or
      // broken endpoint could otherwise stop anyone from ever sealing anything.
      if (!answersTheQuestion(scope, log, start, end)) continue;

      // eth_getLogs reports a block-wide log index; the decoder on Creditcoin numbers logs within
      // their transaction, so the two have to be reconciled — which needs every log that
      // transaction emitted, not just the ones matching this scope.
      //
      // There are two ways to ask and endpoints differ on which they will answer. publicnode
      // serves a filtered eth_getLogs across historical blocks but refuses both the receipt and an
      // unfiltered block query over the same range; tenderly answers the block query happily. So
      // both are tried, and an endpoint that can do neither cannot serve this sweep at all — which
      // is worth failing loudly rather than guessing an index.
      let siblings = txLogIndices.get(log.transactionHash);
      if (!siblings) {
        const found2 = await siblingLogIndices(provider, log);
        if (!found2) {
          throw new Error(`cannot determine the per-transaction log index for ${log.transactionHash}`);
        }
        siblings = found2;
        txLogIndices.set(log.transactionHash, siblings);
      }

      const logIndexInTx = siblings.indexOf(log.index);
      if (logIndexInTx < 0) {
        throw new Error(`log ${log.index} not found among its own transaction's logs`);
      }

      found.push({
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        txIndex: log.transactionIndex,
        logIndexInTx,
        value: valueOf(scope, log.data),
      });
    }
  }

  found.sort((a, b) => (eventKey(a) < eventKey(b) ? -1 : eventKey(a) > eventKey(b) ? 1 : 0));
  return found;
}

export interface UnionSweep {
  events: ScopedEvent[];
  answered: number;
  attempted: number;
  perSource: string[];
  /// Events two endpoints described differently. The union is about presence — any endpoint
  /// surfacing an event is enough to include it — but two endpoints reporting the same position
  /// with different contents is not a union, it is a disagreement, and one of them is wrong.
  conflicts: string[];
}

/// Sweep a scope across every endpoint available and union what comes back.
///
/// A claimant sweeping with one RPC is betting their bond on that node having mentioned every log.
/// A missed event is not a smaller claim — it is an incomplete one, and being slashed for it looks
/// exactly like lying. Taking the union across independent endpoints means any one of them
/// surfacing an event is enough to include it, so a single node's omission stops being fatal.
///
/// The same reasoning as the watcher's, from the other side: there, the union widens what can be
/// refuted; here, it widens what gets claimed. Neither needs any endpoint to be trusted.
export async function scanScopeUnion(
  endpoints: { url: string; provider: JsonRpcProvider }[],
  scope: Scope,
  fromBlock: number,
  toBlock: number,
  chunkSize = 2000,
  deadline?: (p: Promise<ScopedEvent[]>) => Promise<ScopedEvent[]>,
): Promise<UnionSweep> {
  const byKey = new Map<bigint, ScopedEvent>();
  const perSource: string[] = [];
  const conflicts: string[] = [];
  let answered = 0;

  for (const { url, provider } of endpoints) {
    try {
      // Each endpoint is asked in pieces it will answer. One that caps at fifty blocks is still a
      // second opinion; it is just a slower one.
      const work = scanScope(provider, scope, fromBlock, toBlock, chunkFor(url, requireChainKey(scope.chainKey), chunkSize));
      const seen = deadline ? await deadline(work) : await work;
      answered++;
      perSource.push(`${hostOf(url)}=${seen.length}`);
      for (const e of seen) {
        const key = eventKey(e);
        const had = byKey.get(key);
        // Last write used to win, silently. What the chain finally records comes from bytes the
        // Block Prover verified, so a wrong value here cannot corrupt a claim — but an endpoint
        // that disagrees with another about an event it can see is broken or hostile, and that is
        // worth saying out loud rather than resolving by iteration order.
        if (had && (had.txHash !== e.txHash || had.value !== e.value)) {
          conflicts.push(
            `${hostOf(url)} disagrees at block ${e.blockNumber} tx#${e.txIndex} log#${e.logIndexInTx}: ` +
              `${had.txHash} value ${had.value} vs ${e.txHash} value ${e.value}`,
          );
        }
        if (!had) byKey.set(key, e);
      }
    } catch {
      perSource.push(`${hostOf(url)}=err`);
    } finally {
      provider.destroy();
    }
  }

  const events = [...byKey.values()].sort((a, b) => (eventKey(a) < eventKey(b) ? -1 : 1));
  return { events, answered, attempted: endpoints.length, perSource, conflicts };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/// The block-wide indices of every log the transaction emitted, ascending, or null if this
/// endpoint will not say.
async function siblingLogIndices(provider: JsonRpcProvider, log: any): Promise<number[] | null> {
  const receipt = await withRetry(() => provider.getTransactionReceipt(log.transactionHash), 2, 600);
  if (receipt) return receipt.logs.map((l) => l.index).sort((a, b) => a - b);

  const all = await withRetry(
    () => provider.getLogs({ fromBlock: log.blockNumber, toBlock: log.blockNumber }),
    2,
    600,
  );
  if (!all) return null;

  return (all as any[])
    .filter((l) => l.transactionIndex === log.transactionIndex)
    .map((l) => l.index)
    .sort((a, b) => a - b);
}

async function withRetry<T>(work: () => Promise<T>, attempts = 3, waitMs = 800): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await work();
      if (result != null) return result;
    } catch {
      /* fall through to the wait */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, waitMs * (i + 1)));
  }
  return null;
}

/// Whether a returned log is actually a response to the filter that was sent.
/// Exported so it can be tested as what it is: a pure decision about untrusted input.
export function answersTheQuestion(scope: Scope, log: any, fromBlock: number, toBlock: number): boolean {
  // Coerce before comparing. A raw endpoint can hand back "0x5f5e0ff" where ethers would have
  // given a number, and `'0x5f5e0ff' < 100` is false rather than an error — so a string block
  // height would sail through a range check that looks like it rejects everything outside it.
  const height = Number(log.blockNumber);
  const txIndex = Number(log.transactionIndex);
  const index = Number(log.index);
  if (!Number.isInteger(height) || !Number.isInteger(txIndex) || !Number.isInteger(index)) return false;
  if (txIndex < 0 || index < 0) return false;
  if (height < fromBlock || height > toBlock) return false;
  if (String(log.address).toLowerCase() !== scope.emitter.toLowerCase()) return false;
  if (!log.topics?.length || String(log.topics[0]).toLowerCase() !== scope.eventSig.toLowerCase()) return false;
  for (let i = 0; i < 3; i++) {
    if ((scope.topicMask & (1 << i)) === 0) continue;
    const got = log.topics[i + 1];
    if (!got || String(got).toLowerCase() !== scope.topics[i].toLowerCase()) return false;
  }
  // The payload has to be well-formed hex before anything reads a number out of it. A DATA_WORD
  // metric slices a 64-character window at a fixed offset, and that offset assumes the `0x` the
  // prefix normally supplies — hand the same bytes over without it and every window lands two
  // characters early. With three data words that is not a short read the length check would catch;
  // it is a different number, returned silently. An amount of 1234567 reads as 316049152.
  if (!isHexData(log.data)) return false;
  return true;
}

/// A `0x`-prefixed hex string of whole bytes, or nothing.
function isHexData(data: unknown): data is string {
  return typeof data === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(data);
}

/// Mirrors EventScope.value.
///
/// The offset is taken from the hex *body* rather than from the whole string, so a payload that
/// arrives without its `0x` cannot shift every window two characters early — see `isHexData`,
/// which is what actually keeps such a payload out. Belt and braces, because the failure this
/// prevents is a wrong number rather than an error.
export function valueOf(scope: Scope, data: string): bigint {
  if (scope.metric === Metric.COUNT) return 1n;
  if (!isHexData(data)) throw new Error(`log payload is not whole-byte hex: ${String(data).slice(0, 24)}`);
  const body = data.slice(2);
  const offset = scope.metricArg * 64;
  const word = body.slice(offset, offset + 64);
  if (word.length < 64) throw new Error('metric word out of range for this log');
  return BigInt('0x' + word);
}
