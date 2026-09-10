import { Contract, type Signer } from 'ethers';
import { eventKey, scanScopeUnion, type Scope, type ScopedEvent } from '../offchain/lib/scope';
import { toScope } from '../offchain/lib/specs';
import { fetchSingleProof } from '../offchain/lib/proofApi';
import { adjacencyFor, memberKeys } from '../offchain/lib/members';
import { confirmEndpoints } from '../offchain/lib/attest';
import { cc3, sourceEndpoints } from './chain';
import { SWEEP_CHUNK, requireChainKey } from '../offchain/lib/networks';

/// The watcher, in the browser.
///
/// Every guarantee Utuh makes rests on one sentence: anyone may refute a claim by proving one
/// in-scope event it left out. `npm run watch` is that sentence made real for whoever runs a
/// daemon with a funded key. This is the same sweep, the same union across independent endpoints
/// and the same membership check, for whoever opens a page.
///
/// It matters that it is the *same*: `scanScopeUnion` below is the function the daemon calls,
/// imported rather than reimplemented, so a browser cannot conclude a claim is complete on
/// different reasoning than the daemon would.
///
/// What the two do not share is the wallet. The daemon holds a key; the page asks one to sign.

export interface Sweep {
  scope: Scope;
  events: ScopedEvent[];
  gaps: ScopedEvent[];
  answered: number;
  /// Endpoints that saw everything the union holds — the ones whose silence about a gap counts.
  vouched: number;
  attempted: number;
  perSource: string[];
  conflicts: string[];
  /// A sweep that only one endpoint answered cannot say a claim is complete — it can only say
  /// that one node did not mention a gap. The distinction is the whole reason for the union.
  conclusive: boolean;
}

/// Sweep the source chain for everything a claim's scope covers, and check each against the claim.
export async function sweepClaim(
  registry: Contract,
  claimId: bigint | number,
  log: (line: string) => void,
): Promise<Sweep> {
  const claim = await registry.claim(claimId);
  const scope = toScope(claim.scope);
  const from = Number(claim.fromBlock);
  const to = Number(claim.toBlock);

  log(`scope: ${scope.emitter} · ${scope.eventSig.slice(0, 10)}… on chain key ${scope.chainKey}`);

  // Which chain a scope's key denotes is Creditcoin's answer to give, not this build's to assume,
  // and an endpoint serving a different chain answers a sweep with zero logs — which reads exactly
  // like a claim that left nothing out. Ask the precompile what the scope key means, ask every
  // endpoint what it is actually serving, and drop the ones that name another chain. An endpoint
  // that does not answer at all is left in: the sweep below already reports it as errored and
  // refuses to call a claim complete on it, which is the better answer to being unreachable.
  const { chain, checks, usable, rejected } = await confirmEndpoints(
    cc3,
    scope.chainKey,
    sourceEndpoints(scope.chainKey),
  );
  log(
    `chain key ${scope.chainKey} is ${chain ? `${chain.name}, EVM chain id ${chain.chainId}` : 'not attested by this network'}`,
  );
  for (const c of rejected) log(`ENDPOINT REJECTED: ${c.url} — ${c.why}`);
  if (usable.length === 0) {
    throw new Error(
      `every endpoint is serving some chain other than ${chain?.name ?? `chain key ${scope.chainKey}`} — ` +
        'a sweep across the wrong chain would report an honest claim incomplete, so this one does not run',
    );
  }
  const confirmed = checks.filter((c) => c.verdict === 'confirmed').length;
  log(`sweeping source blocks ${from}..${to} from ${usable.length} endpoint(s), ${confirmed} confirmed on-chain`);

  const union = await scanScopeUnion(usable, scope, from, to, SWEEP_CHUNK[requireChainKey(scope.chainKey)]);

  log(`answered: ${union.perSource.join('  ')}`);
  for (const c of union.conflicts) log(`ENDPOINT CONFLICT: ${c}`);
  log(`union: ${union.events.length} in-scope event(s)`);

  const gaps: ScopedEvent[] = [];
  for (const e of union.events) {
    if (!(await registry.contains(claimId, eventKey(e)))) gaps.push(e);
  }

  if (gaps.length === 0) {
    log(
      union.vouched >= 2
        ? `no gap found across ${union.vouched} independent endpoints`
        : `no gap found — but only ${union.vouched} endpoint saw everything (${union.answered} answered), which settles nothing`,
    );
  } else {
    log(`INCOMPLETE: ${gaps.length} event(s) the claim does not contain`);
  }

  return {
    scope,
    events: union.events,
    gaps,
    answered: union.answered,
    vouched: union.vouched,
    attempted: union.attempted,
    perSource: union.perSource,
    conflicts: union.conflicts,
    conclusive: union.vouched >= 2,
  };
}

/// Break a claim with one proof of one omitted event.
///
/// The proof is fetched from the hosted Proof Builder and handed to the registry, which runs it
/// through the Block Prover precompile itself. Nothing here is trusted: a fabricated proof simply
/// fails to verify and costs the sender their gas.
export async function refute(
  registry: Contract,
  signer: Signer,
  claimId: bigint | number,
  gap: ScopedEvent,
  chainKey: number,
  log: (line: string) => void,
): Promise<{ hash: string; key: bigint }> {
  log(`fetching a proof for ${gap.txHash} from the proof builder…`);
  const proof = await fetchSingleProof(chainKey, gap.txHash);
  log(
    `proof for source block ${proof.headerNumber}, tx#${proof.txIndex}, ${proof.merkleProof.siblings.length} siblings`,
  );

  const event = {
    blockHeight: proof.headerNumber,
    encodedTransaction: proof.txBytes,
    merkleRoot: proof.merkleProof.root,
    siblings: proof.merkleProof.siblings,
    logIndex: gap.logIndexInTx,
  };

  // The witness the registry needs beside the proof: the two members that bracket the omitted
  // key, read from the claim's own log and checked against its root before anything is signed.
  log('reading the claim’s members from its log…');
  const keys = await memberKeys(registry, claimId);
  const adj = adjacencyFor(keys, eventKey(gap));
  if (!adj) throw new Error(`claim ${claimId} already holds this event — nothing to refute`);
  log(
    `${keys.length} member(s); the key falls ${adj.index === 0n && eventKey(gap) < adj.lower ? 'below the first' : adj.upper === 0n ? 'above the last' : `between #${adj.index} and #${adj.index + 1n}`}`,
  );

  const writable = registry.connect(signer) as Contract;
  // eth_call first. A refutation that would revert is worth finding out about before it costs gas,
  // and the revert reason is the useful half of the answer.
  await writable.refute.staticCall(claimId, event, proof.continuityProof, adj);
  log('the registry accepts it — sending');

  const tx = await writable.refute(claimId, event, proof.continuityProof, adj);
  log(`sent ${tx.hash}`);
  await tx.wait();
  return { hash: tx.hash, key: eventKey(gap) };
}
