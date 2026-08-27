import type { ScopedEvent } from './scope';

/// How a claim is cut into transactions the Block Prover will accept.
///
/// Split out of `proofs.ts` for the same reason `networks.ts` was split out of `config.ts`: the
/// browser builds claims too, and `proofs.ts` reaches for `process.env` through `../config` at
/// import time. This file imports nothing but a type, so both sides can plan a batch the same way.

/// Attestcoin's batch endpoint shares one continuity proof across a batch, but only within these
/// bounds. Both come from the SDK's own limits and are the reason claims are built incrementally
/// rather than in one shot.
export const MAX_BATCH_SIZE = 10;
export const MAX_BATCH_RANGE = 1000;

/// Split events into batches the Block Prover will actually accept.
///
/// The cap is on *queries*, not transactions: a transaction carrying three in-scope logs spends
/// three of the ten slots even though it needs only one proof. Counting transactions instead is
/// how you earn `heights: Value is too large for length` from the precompile.
export function planBatches(events: ScopedEvent[]): ScopedEvent[][] {
  const batches: ScopedEvent[][] = [];
  let current: ScopedEvent[] = [];
  let firstBlock = 0;

  for (const e of events) {
    const wouldExceedQueries = current.length + 1 > MAX_BATCH_SIZE;
    const wouldExceedRange = current.length > 0 && e.blockNumber - firstBlock + 1 > MAX_BATCH_RANGE;

    if (current.length > 0 && (wouldExceedQueries || wouldExceedRange)) {
      batches.push(current);
      current = [];
    }
    if (current.length === 0) firstBlock = e.blockNumber;
    current.push(e);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
