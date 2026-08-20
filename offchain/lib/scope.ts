import { JsonRpcProvider, zeroPadValue, getAddress } from 'ethers';

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
export function scopeFor(opts: {
  chainKey: number;
  emitter: string;
  eventSig: string;
  subject?: string;
  subjectTopic?: 1 | 2 | 3;
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
  const receiptCache = new Map<string, number[]>();

  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    const logs = await provider.getLogs({
      address: scope.emitter,
      topics: filterTopics as any,
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      // eth_getLogs reports a block-wide log index; translate it to the per-transaction index
      // the decoder will produce on Creditcoin.
      let blockWideIndices = receiptCache.get(log.transactionHash);
      if (!blockWideIndices) {
        const receipt = await provider.getTransactionReceipt(log.transactionHash);
        if (!receipt) throw new Error(`no receipt for ${log.transactionHash}`);
        blockWideIndices = receipt.logs.map((l) => l.index);
        receiptCache.set(log.transactionHash, blockWideIndices);
      }
      const logIndexInTx = blockWideIndices.indexOf(log.index);
      if (logIndexInTx < 0) throw new Error(`log ${log.index} not found in its own receipt`);

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

/// Mirrors EventScope.value.
function valueOf(scope: Scope, data: string): bigint {
  if (scope.metric === Metric.COUNT) return 1n;
  const offset = 2 + scope.metricArg * 64;
  const word = data.slice(offset, offset + 64);
  if (word.length < 64) throw new Error('metric word out of range for this log');
  return BigInt('0x' + word);
}
