import { Contract, getAddress } from 'ethers';
import type { Scope, Metric } from './scope';

/// Rebuilding a scope from a UtuhCredit spec had grown three near-identical copies — in the
/// resume script, the bait planter and the live suite — each with its own chance of drifting from
/// what the contract actually checks. There is only one right answer here and the contract owns
/// it, so the conversion lives once, next to the two ethers quirks it has to work around.

/// ethers returns struct values as a frozen Result, and passing one straight back into another
/// call fails while it resolves arguments. Copy it into a plain object first.
export function plainSpec(s: any) {
  return {
    chainKey: s.chainKey,
    emitter: s.emitter,
    eventSig: s.eventSig,
    subjectTopic: s.subjectTopic,
    counterpartyTopic: s.counterpartyTopic,
    counterparty: s.counterparty,
    metric: s.metric,
    metricArg: s.metricArg,
  };
}

export function toScope(raw: any): Scope {
  return {
    chainKey: Number(raw.chainKey),
    emitter: raw.emitter,
    eventSig: raw.eventSig,
    topics: [raw.topics[0], raw.topics[1], raw.topics[2]],
    topicMask: Number(raw.topicMask),
    metric: Number(raw.metric) as Metric,
    metricArg: Number(raw.metricArg),
  };
}

export type SpecName = 'volume' | 'repay';

/// The exact scope a claim must carry for `subject`, rebuilt by the contract itself rather than
/// reconstructed alongside it.
export async function scopeFor(credit: Contract, which: SpecName, subject: string): Promise<Scope> {
  const spec = plainSpec(which === 'volume' ? await credit.volumeSpec() : await credit.repaySpec());
  return toScope(await credit.expectedScope(spec, subject));
}

/// One of the configured adverse-event classes, by index.
export async function cleanScopeFor(credit: Contract, index: number, subject: string): Promise<Scope> {
  const spec = plainSpec(await credit.cleanSpecAt(index));
  return toScope(await credit.expectedScope(spec, subject));
}

/// Are these the same scope?
///
/// The contract decides this by hashing the scope's fields into an id, and it never exposes that
/// id — so anything off-chain has to compare the fields themselves. This compares exactly the
/// fields `EventScope.id` hashes, and normalises before it does: ethers hands scopes back
/// sometimes as a named `Result` and sometimes positionally, addresses in either case, and hex in
/// whichever case the node felt like.
///
/// `finishLine` used to do this with `JSON.stringify` over a hand-built array. It worked, and it
/// would have gone on working right up until a node returned a checksummed emitter where the last
/// one returned lowercase — at which point the resume script decides the claim it already built
/// does not exist, builds a second one, and stakes another bond on it.
export function sameScope(a: any, b: any): boolean {
  const x = toScope(normalise(a));
  const y = toScope(normalise(b));
  return (
    x.chainKey === y.chainKey &&
    getAddress(x.emitter) === getAddress(y.emitter) &&
    x.eventSig.toLowerCase() === y.eventSig.toLowerCase() &&
    x.topicMask === y.topicMask &&
    x.metric === y.metric &&
    x.metricArg === y.metricArg &&
    x.topics.every((t, i) => t.toLowerCase() === y.topics[i].toLowerCase())
  );
}

/// ethers returns a struct as a `Result`: named when the ABI names its members, positional when
/// it does not. Reading both shapes here means callers do not have to know which they were handed.
function normalise(s: any) {
  return {
    chainKey: s.chainKey ?? s[0],
    emitter: s.emitter ?? s[1],
    eventSig: s.eventSig ?? s[2],
    topics: s.topics ?? s[3],
    topicMask: s.topicMask ?? s[4],
    metric: s.metric ?? s[5],
    metricArg: s.metricArg ?? s[6],
  };
}
