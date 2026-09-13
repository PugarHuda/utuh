/// The watcher's memory and the rules it keeps by, apart from the RPC that feeds them.
///
/// `offchain/watch.ts` runs at import, so nothing in it can be tested without a chain. The four
/// decisions that make it a watcher rather than a poller live here instead, where
/// `offchain/watchTest.ts` can drive each with a value and no network: where to resume from, which
/// claim to look at first, which verdicts retire a claim, and what a failed inspection is.

export type Verdict = 'settled' | 'refuted' | 'complete' | 'expired' | 'inconclusive';

export interface WatchState {
  registry: string;
  /// The last CC3 block whose ClaimSealed logs were read in full.
  lastScanned: number;
  /// Claims seen sealed and not yet resolved, as decimal ids.
  pending: string[];
}

/// What `WATCH_STATE` holds between runs. Pretty-printed because a person reads it in a job summary.
export function encodeState(registry: string, lastScanned: number, pending: Iterable<string>): string {
  const state: WatchState = { registry, lastScanned, pending: [...pending] };
  return JSON.stringify(state, null, 2) + String.fromCharCode(10);
}

/// A saved state, if it is one this watcher can trust: for the same registry, with an integer mark.
/// Anything else — no file, another registry's progress, a hand-edited number — is `null`, and the
/// caller falls back to the lookback and says so.
export function decodeState(text: string, registry: string): WatchState | null {
  let saved: Partial<WatchState>;
  try {
    saved = JSON.parse(text) as Partial<WatchState>;
  } catch {
    return null;
  }
  if (typeof saved?.registry !== 'string' || saved.registry.toLowerCase() !== registry.toLowerCase()) return null;
  if (!Number.isInteger(saved.lastScanned)) return null;
  const pending = Array.isArray(saved.pending) ? saved.pending.filter((p) => typeof p === 'string') : [];
  return { registry: saved.registry, lastScanned: saved.lastScanned as number, pending };
}

/// The block to start reading ClaimSealed from: one past the mark, or `lookback` behind the head.
export function startBlock(saved: WatchState | null, head: number, lookback: number): number {
  return Math.max(0, saved ? saved.lastScanned + 1 : head - lookback);
}

/// Soonest deadline first. A claim with three blocks left cannot wait behind one with five thousand
/// just because it was discovered second. Stable, so equal deadlines keep discovery order.
export function byDeadline<T extends { until: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.until - b.until);
}

/// Only a terminal verdict retires a claim from the queue — refuted, finalized by someone else,
/// proven complete by more than one endpoint, or past its window. An inspection that threw (a lost
/// race, a reverted refutation, an endpoint down) is `inconclusive`: the claim stays queued and the
/// watcher keeps going, because a watcher that forgets a claim it failed to check is blind to it
/// for good.
export function conclude(pending: Set<string>, claimId: bigint | string, outcome: Verdict | Error): Verdict {
  const verdict: Verdict = outcome instanceof Error ? 'inconclusive' : outcome;
  if (verdict !== 'inconclusive') pending.delete(String(claimId));
  return verdict;
}
