import { Contract } from 'ethers';
import type { Scope, ScopedEvent } from './scope';
import { eventKey } from './scope';
import { Prover, planBatches } from './proofs';

export interface BuildOptions {
  bond: bigint;
  challengeWindow: number;
  /// Keys deliberately left out of the claim. Used to stage a dishonest claim so the refutation
  /// path can be exercised against a real omission rather than a hypothetical one.
  omit?: Set<bigint>;
  log?: (msg: string) => void;
}

export interface BuiltClaim {
  claimId: bigint;
  included: ScopedEvent[];
  omitted: ScopedEvent[];
}

/// Open a claim, append every event through the Attestcoin Block Prover, and seal it.
export async function buildClaim(
  registry: Contract,
  prover: Prover,
  scope: Scope,
  fromBlock: number,
  toBlock: number,
  events: ScopedEvent[],
  opts: BuildOptions,
): Promise<BuiltClaim> {
  const log = opts.log ?? (() => {});
  const omit = opts.omit ?? new Set<bigint>();

  const included = events.filter((e) => !omit.has(eventKey(e)));
  const omitted = events.filter((e) => omit.has(eventKey(e)));

  // The whole range must be attested before the claim can open — that requirement is what makes
  // the challenge window meaningful, since a watcher can prove anything inside it from block one.
  await prover.waitAttested(toBlock);

  const openTx = await registry.open(scope, fromBlock, toBlock, opts.challengeWindow, { value: opts.bond });
  const openReceipt = await openTx.wait();
  const claimId = readClaimId(registry, openReceipt);
  log(`claim ${claimId} opened over ${fromBlock}..${toBlock} (${included.length} members, bond ${opts.bond})`);

  const batches = planBatches(included);
  for (let i = 0; i < batches.length; i++) {
    const { proofs, continuity } = await prover.proveBatch(batches[i]);
    const tx = await registry.appendBatch(claimId, proofs, continuity);
    await tx.wait();
    log(`  batch ${i + 1}/${batches.length}: ${proofs.length} events verified on-chain`);
  }

  const sealTx = await registry.seal(claimId);
  await sealTx.wait();
  log(`claim ${claimId} sealed`);

  return { claimId, included, omitted };
}

function readClaimId(registry: Contract, receipt: any): bigint {
  for (const rawLog of receipt.logs) {
    let parsed;
    try {
      parsed = registry.interface.parseLog(rawLog);
    } catch {
      continue;
    }
    if (parsed?.name === 'ClaimOpened') return parsed.args[0] as bigint;
  }
  throw new Error('ClaimOpened not found in receipt');
}

/// The watcher's move: sweep the claim's own range and return the first in-scope event the claim
/// does not contain. Nothing here trusts the claimant — the sweep is independent, and membership
/// is checked against the chain.
export async function findOmission(
  registry: Contract,
  claimId: bigint,
  events: ScopedEvent[],
): Promise<ScopedEvent | null> {
  for (const e of events) {
    const present: boolean = await registry.contains(claimId, eventKey(e));
    if (!present) return e;
  }
  return null;
}

export async function refuteClaim(
  registry: Contract,
  prover: Prover,
  claimId: bigint,
  omission: ScopedEvent,
): Promise<{ reward: bigint; key: bigint }> {
  const { proof, continuity } = await prover.proveOne(omission);
  const tx = await registry.refute(claimId, proof, continuity);
  const receipt = await tx.wait();

  for (const rawLog of receipt.logs) {
    let parsed;
    try {
      parsed = registry.interface.parseLog(rawLog);
    } catch {
      continue;
    }
    if (parsed?.name === 'ClaimRefuted') {
      return { key: parsed.args[2] as bigint, reward: parsed.args[3] as bigint };
    }
  }
  throw new Error('ClaimRefuted not found in receipt');
}
