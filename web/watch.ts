import { Contract, type Signer } from 'ethers';
import { eventKey, scanScopeUnion, type Scope, type ScopedEvent } from '../offchain/lib/scope';
import { toScope } from '../offchain/lib/specs';
import { fetchSingleProof } from '../offchain/lib/proofApi';
import { sourceEndpoints } from './chain';
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
  log(`sweeping source blocks ${from}..${to} from ${sourceEndpoints(scope.chainKey).length} endpoints`);

  const endpoints = sourceEndpoints(scope.chainKey);
  const union = await scanScopeUnion(endpoints, scope, from, to, SWEEP_CHUNK[requireChainKey(scope.chainKey)]);

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

  const writable = registry.connect(signer) as Contract;
  // eth_call first. A refutation that would revert is worth finding out about before it costs gas,
  // and the revert reason is the useful half of the answer.
  await writable.refute.staticCall(claimId, event, proof.continuityProof);
  log('the registry accepts it — sending');

  const tx = await writable.refute(claimId, event, proof.continuityProof);
  log(`sent ${tx.hash}`);
  await tx.wait();
  return { hash: tx.hash, key: eventKey(gap) };
}
