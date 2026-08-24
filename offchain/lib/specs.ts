import { Contract } from 'ethers';
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
