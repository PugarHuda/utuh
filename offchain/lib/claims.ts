import { Contract } from 'ethers';
import { eventKey, scanScopeUnion, type Scope, type ScopedEvent } from './scope';
import { sources, withDeadline, SOURCE_TIMEOUT_MS } from '../config';
import { Prover, planBatches } from './proofs';
import { sendChecked, isChainRejection } from './gasLimit';
import { attested } from './chain';

export interface BuildOptions {
  bond: bigint;
  challengeWindow: number;
  /// Keys deliberately left out of the claim. Used to stage a dishonest claim so the refutation
  /// path can be exercised against a real omission rather than a hypothetical one.
  omit?: Set<bigint>;
  log?: (msg: string) => void;
}

/// Sweep a scope the way a claimant should: across every endpoint, and refusing to seal on the
/// word of a single node.
///
/// An incomplete claim is indistinguishable from a dishonest one, and the penalty is the same. A
/// claimant betting a bond on one RPC having told them about every log is taking a risk they did
/// not choose and cannot see.
export async function sweepForClaim(
  scope: Scope,
  fromBlock: number,
  toBlock: number,
  opts: { minSources?: number; chunkSize?: number; log?: (m: string) => void } = {},
): Promise<ScopedEvent[]> {
  const log = opts.log ?? (() => {});
  // Two by default. This function stakes a bond on the answer being complete, and a warning
  // printed to a log nobody reads protects nobody — refusing to seal does. A caller who really
  // means to bet on one endpoint has to say so.
  const minSources = opts.minSources ?? 2;

  const sweep = await scanScopeUnion(
    sources(scope.chainKey),
    scope,
    fromBlock,
    toBlock,
    opts.chunkSize ?? 500,
    (work) => withDeadline(SOURCE_TIMEOUT_MS, work),
  );

  log(`swept ${sweep.answered}/${sweep.attempted} endpoints: ${sweep.perSource.join('  ')}`);
  // Counts differing is normal — that is what the union is for. The same event described two
  // different ways is not, and means one of these endpoints is wrong about something it can see.
  for (const c of sweep.conflicts) log(`  ENDPOINT CONFLICT: ${c}`);
  if (sweep.answered < minSources) {
    throw new Error(
      `only ${sweep.answered} endpoint(s) answered and ${minSources} were required — ` +
        'sealing on this would risk the bond on one node being complete',
    );
  }
  if (sweep.answered === 1) {
    log('WARNING: one endpoint answered. An omission it made would cost the bond.');
  }
  if (!sweep.perSource.every((c) => c.endsWith('=err')) && new Set(sweep.perSource.filter((c) => !c.endsWith('=err')).map((c) => c.split('=')[1])).size > 1) {
    log(`endpoints disagreed (${sweep.perSource.join('  ')}) — claiming the union, which is the safe direction`);
  }
  return sweep.events;
}

/// Raised when the chain keys an event differently from the sweep that found it.
export class KeyMismatch extends Error {}

/// Compare the keys the registry computed against the ones the sweep predicted.
///
/// The registry takes the transaction index from the proof, which is authoritative, but the log
/// index from the caller — and the caller got it from an endpoint. An endpoint returning a real,
/// in-scope log with a permuted index makes an honest claimant seal a set with a wrong key, which
/// is then refutable: they lose the bond and it looks like they lied.
///
/// `EventAppended` carries the key the chain computed, so the two can simply be compared. A
/// mismatch means the sweep was wrong about position, and the claim is still Open at that point —
/// abandoning it costs nothing.
function assertKeysMatch(registry: Contract, receipt: any, expected: ScopedEvent[]): void {
  const got: bigint[] = [];
  for (const raw of receipt.logs) {
    try {
      const parsed = registry.interface.parseLog(raw);
      if (parsed?.name === 'EventAppended') got.push(parsed.args[1] as bigint);
    } catch {
      /* not ours */
    }
  }
  if (got.length !== expected.length) {
    throw new KeyMismatch(`appended ${got.length} events but expected ${expected.length}`);
  }
  for (let i = 0; i < got.length; i++) {
    const want = eventKey(expected[i]);
    if (got[i] !== want) {
      throw new KeyMismatch(
        `the chain keyed ${expected[i].blockNumber}/${expected[i].txIndex}/${expected[i].logIndexInTx} as ` +
          `${got[i]}, the sweep said ${want} — an endpoint reported the wrong position`,
      );
    }
  }
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

  // Appending the union has a failure mode the watcher does not share. A watcher that meets a
  // candidate it cannot prove shrugs and moves on; a claimant has to append everything it swept,
  // so one unprovable candidate would abort the whole claim. Since the union deliberately trusts
  // no endpoint, a single misbehaving one could inject a phantom event and stop every honest
  // claimant from building anything.
  //
  // The Block Prover is the authority on what exists. An event nobody can prove cannot be
  // appended and cannot be refuted with either — the same prover guards both paths — so dropping
  // it is not an omission. What must not happen is dropping a *real* event because the Proof
  // Builder was briefly down, hence the retries before giving up on any of them.
  const dropped: ScopedEvent[] = [];
  const batches = planBatches(included);

  try {

    for (let i = 0; i < batches.length; i++) {
      try {
        const { proofs, continuity } = await prover.proveBatch(batches[i]);
        const tx = await sendChecked(registry, 'appendBatch', [claimId, proofs, continuity], {
          members: proofs.length,
          log,
        });
        const receipt = await tx.wait();
        assertKeysMatch(registry, receipt, batches[i]);
        log(`  batch ${i + 1}/${batches.length}: ${proofs.length} events verified on-chain`);
      } catch (e: any) {
        if (e instanceof KeyMismatch) throw e;
        log(`  batch ${i + 1}/${batches.length} failed as a batch (${e.shortMessage ?? e.message}) — one at a time`);

        for (const event of batches[i]) {
          const where = `${event.blockNumber}/${event.txIndex}/${event.logIndexInTx}`;
          const attempt = await prover.tryProveOne(event);

          if (!attempt.ok) {
            // Dropping is only safe on a definite answer. "I could not reach the prover" is not one,
            // and treating it as one would seal a claim missing a real event — which is
            // indistinguishable from lying and costs the same bond. Better to abort and let the
            // claimant come back: an unbuilt claim loses nothing.
            if (!attempt.authoritative) {
              throw new Error(`could not prove ${where} and could not establish that it is absent: ${attempt.reason}`);
            }
            // Even a 404 only means "no such transaction" once the block is attested; before that
            // the prover has nothing to serve for a transaction that does exist.
            const frontier = await attested(registry.runner!.provider!, scope.chainKey, event.blockNumber);
            if (!frontier.ok) {
              throw new Error(
                `block ${event.blockNumber} is not attested yet (frontier ${frontier.frontier}) — ` +
                  `nothing can be concluded about ${where}`,
              );
            }
            dropped.push(event);
            log(`    dropped ${where}: the chain has no such transaction`);
            continue;
          }

          try {
            const one = await (
              await sendChecked(registry, 'appendBatch', [claimId, [attempt.proof], attempt.continuity], {
                members: 1,
                log,
              })
            ).wait();
            assertKeysMatch(registry, one, [event]);
          } catch (inner: any) {
            if (inner instanceof KeyMismatch) throw inner;
            // The registry rejecting a proven event means it is out of scope or out of range, which
            // a refuter could not use against the claim either — so dropping it is safe.
            //
            // Only when the *chain* rejected it. Appends now run `eth_call` before they send, so a
            // timeout or a dead endpoint reaches this catch as well, and it has said nothing about
            // the event. Dropping there would seal a claim short of a real member and forfeit the
            // bond for it. An unbuilt claim costs nothing; the same trade as the prover's 404.
            if (!isChainRejection(registry, inner)) {
              throw new Error(
                `could not establish whether the registry accepts ${where}: ${inner.shortMessage ?? inner.message}`,
              );
            }
            dropped.push(event);
            log(`    dropped ${where}: ${inner.revert?.name ?? inner.shortMessage ?? 'rejected on-chain'}`);
          }
        }
      }
    }

    } catch (e) {
    if (e instanceof KeyMismatch) {
      // Still Open, so nothing has been asserted to anyone yet and the bond comes back whole.
      // Sealing on a set the chain keys differently would hand a refuter an easy win.
      log(`  ${e.message}`);
      log('  abandoning the claim — the bond is recoverable while it is still open');
      await (await registry.abandon(claimId)).wait();
    }
    throw e;
  }

  if (dropped.length > 0) {
      log(`  ${dropped.length} candidate(s) dropped as unprovable — an endpoint reported events the chain does not have`);
    }

  const sealTx = await registry.seal(claimId);
  await sealTx.wait();
  log(`claim ${claimId} sealed`);

  const kept = included.filter((e) => !dropped.includes(e));
  return { claimId, included: kept, omitted };
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
  log: (message: string) => void = () => {},
): Promise<{ reward: bigint; key: bigint }> {
  const { proof, continuity } = await prover.proveOne(omission);
  // The one call in this repo that must go through even when the node will not estimate it.
  const tx = await sendChecked(registry, 'refute', [claimId, proof, continuity], { members: 0, log });
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
