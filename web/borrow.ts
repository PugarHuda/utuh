import { Contract, formatEther, parseEther, type Signer } from 'ethers';
import { planBatches } from '../offchain/lib/batches';
import { fetchBatchProof, fetchSingleProof, proofFromBatch } from '../offchain/lib/proofApi';
import { eventKey, scanScopeUnion, type Scope, type ScopedEvent } from '../offchain/lib/scope';
import { toScope } from '../offchain/lib/specs';
import { sourceEndpoints } from './chain';

/// Borrowing, from a browser.
///
/// The scripts in `offchain/` can already do all of this, and that was the problem: being
/// underwritten meant cloning a repository, filling in a `.env` and running TypeScript. Everything
/// below happens in the page, against the same contracts, with the visitor's own wallet.
///
/// Nothing here is a shortcut around the protocol. The claims this builds are ordinary claims —
/// bonded, sealed, challengeable by anyone including the watcher in the next pane over, and
/// finalized only when their window has actually elapsed. A borrower using this page is exposed to
/// exactly what a borrower using the scripts is exposed to, which is the point.

export interface Log {
  (line: string): void;
}

/// What a borrower has to be told before they send anything on the source chain.
export interface Binding {
  subject: string;
  account: string;
  calldata: string;
  chainKey: number;
}

/// The calldata a subject sends, from their own address, to bind it to a Creditcoin account.
export async function bindingFor(credit: Contract, subject: string, account: string): Promise<Binding> {
  const calldata: string = await credit.controlCommitment(account);
  const spec = await credit.volumeSpec();
  return { subject, account, calldata, chainKey: Number(spec.chainKey) };
}

/// Prove a commitment that has already landed on the source chain.
export async function proveControl(
  credit: Contract,
  signer: Signer,
  chainKey: number,
  txHash: string,
  log: Log,
): Promise<string> {
  log(`fetching a proof for ${txHash}…`);
  const proof = await fetchSingleProof(chainKey, txHash);
  log(`proof for source block ${proof.headerNumber}, tx#${proof.txIndex}`);

  const writable = credit.connect(signer) as Contract;
  const control = {
    chainKey,
    blockHeight: proof.headerNumber,
    encodedTransaction: proof.txBytes,
    merkleRoot: proof.merkleProof.root,
    siblings: proof.merkleProof.siblings,
  };

  // eth_call first, so a commitment that will not bind says why before it costs gas.
  await writable.proveControl.staticCall(control, proof.continuityProof);
  const tx = await writable.proveControl(control, proof.continuityProof);
  log(`sent ${tx.hash}`);
  await tx.wait();
  return tx.hash;
}

/// The scope a claim must carry, rebuilt by the contract rather than alongside it.
export async function scopeFor(credit: Contract, which: 'volume' | 'clean', subject: string): Promise<Scope> {
  const spec = which === 'volume' ? await credit.volumeSpec() : await credit.cleanSpecAt(0);
  const plain = {
    chainKey: spec.chainKey,
    emitter: spec.emitter,
    eventSig: spec.eventSig,
    subjectTopic: spec.subjectTopic,
    counterpartyTopic: spec.counterpartyTopic,
    counterparty: spec.counterparty,
    metric: spec.metric,
    metricArg: spec.metricArg,
  };
  return toScope(await credit.expectedScope(plain, subject));
}

export interface Range {
  fromBlock: number;
  toBlock: number;
}

/// The widest range this lender will underwrite, ending where the attestations do.
///
/// A claim may not reach past the attestation frontier — that requirement is what makes a
/// challenge window mean anything — and the lender's own staleness bound says how far behind the
/// frontier the range may end. Between them there is exactly one sensible default, and computing
/// it here saves a borrower from picking a range that will be refused three transactions later.
export async function defaultRange(credit: Contract, chainInfo: Contract, chainKey: number): Promise<Range> {
  const frontier = Number((await chainInfo.get_latest_attestation_height_and_hash(chainKey)).height);
  const genesis = Number(await chainInfo.get_attestation_genesis_height(chainKey));
  const history = Number(await credit.MIN_HISTORY_BLOCKS());

  // A couple of blocks below the frontier, because it moves while a claim is being built and a
  // range that ends exactly at it can be refused by the time `open` lands.
  const toBlock = Math.max(genesis + history, frontier - 2);
  return { fromBlock: Math.max(genesis, toBlock - history - 1), toBlock };
}

export interface BuiltClaim {
  claimId: bigint;
  members: number;
  aggregate: bigint;
  challengeUntil: number;
}

/// Sweep, open, append every proven event, and seal.
///
/// The sweep is the union across independent endpoints, the same one the watcher runs — from the
/// claimant's side rather than the watcher's. A claimant who sweeps with a single RPC is betting
/// their bond on that node having mentioned every log, and a missed event is not a smaller claim,
/// it is an incomplete one.
export async function buildClaim(
  registry: Contract,
  signer: Signer,
  scope: Scope,
  range: Range,
  opts: { bond: bigint; challengeWindow: number; minSources?: number },
  log: Log,
): Promise<BuiltClaim> {
  const minSources = opts.minSources ?? 2;

  log(`sweeping source blocks ${range.fromBlock}..${range.toBlock}`);
  const sweep = await scanScopeUnion(sourceEndpoints(scope.chainKey), scope, range.fromBlock, range.toBlock, 500);
  log(`answered: ${sweep.perSource.join('  ')}`);
  for (const c of sweep.conflicts) log(`ENDPOINT CONFLICT: ${c}`);

  if (sweep.answered < minSources) {
    throw new Error(
      `only ${sweep.answered} of ${sweep.attempted} endpoints answered. A claim built on one node's ` +
        `word is only as complete as that node, and the bond is what pays for being wrong.`,
    );
  }
  log(`${sweep.events.length} in-scope event(s) to claim`);

  const writable = registry.connect(signer) as Contract;
  const opened = await writable.open(scope, range.fromBlock, range.toBlock, opts.challengeWindow, {
    value: opts.bond,
  });
  const receipt = await opened.wait();
  const claimId = await claimIdFrom(registry, receipt);
  log(`claim ${claimId} opened with ${formatEther(opts.bond)} CTC at stake`);

  const batches = planBatches(sweep.events);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i]!;
    log(`batch ${i + 1}/${batches.length}: ${batch.length} event(s)`);
    await appendBatch(writable, claimId, scope.chainKey, batch, log);
  }

  await (await writable.seal(claimId)).wait();
  const until = Number(await registry.challengeUntil(claimId));
  log(`claim ${claimId} sealed — challengeable until CC3 block ${until}`);

  return {
    claimId,
    members: Number(await registry.memberCount(claimId)),
    aggregate: (await registry.claim(claimId)).aggregate,
    challengeUntil: until,
  };
}

async function appendBatch(
  registry: Contract,
  claimId: bigint,
  chainKey: number,
  batch: ScopedEvent[],
  log: Log,
): Promise<void> {
  // One proof request per batch, not per event: the batch endpoint returns the shared continuity
  // proof the array form of `verifyAndEmit` is shaped for.
  const hashes = [...new Set(batch.map((e) => e.txHash))];
  const proof = await fetchBatchProof(chainKey, hashes);

  const proofs = batch.map((e) => {
    const { txBytes, merkleProof } = proofFromBatch(proof, e.blockNumber, e.txIndex);
    return {
      blockHeight: e.blockNumber,
      encodedTransaction: txBytes,
      merkleRoot: merkleProof.root,
      siblings: merkleProof.siblings,
      logIndex: e.logIndexInTx,
    };
  });

  await registry.appendBatch.staticCall(claimId, proofs, proof.continuityProof);
  const tx = await registry.appendBatch(claimId, proofs, proof.continuityProof);
  await tx.wait();
  log(`  ${proofs.length} event(s) verified on-chain by 0x0FD2`);
}

/// The id the registry assigned, read out of its own event rather than guessed from a counter.
async function claimIdFrom(registry: Contract, receipt: { logs: readonly unknown[] }): Promise<bigint> {
  for (const entry of receipt.logs) {
    const parsed = registry.interface.parseLog(entry as { topics: string[]; data: string });
    if (parsed?.name === 'ClaimOpened') return parsed.args[0] as bigint;
  }
  throw new Error('the registry accepted the claim without saying which id it got');
}

export async function finalize(registry: Contract, signer: Signer, claimId: bigint, log: Log): Promise<void> {
  const writable = registry.connect(signer) as Contract;
  await writable.finalize.staticCall(claimId);
  const tx = await writable.finalize(claimId);
  log(`finalizing claim ${claimId} — ${tx.hash}`);
  await tx.wait();
}

export async function openLine(
  credit: Contract,
  signer: Signer,
  subject: string,
  volumeClaimId: bigint,
  cleanClaimIds: bigint[],
  log: Log,
): Promise<bigint> {
  const writable = credit.connect(signer) as Contract;
  await writable.openLine.staticCall(subject, volumeClaimId, cleanClaimIds);
  const tx = await writable.openLine(subject, volumeClaimId, cleanClaimIds);
  log(`opening the line — ${tx.hash}`);
  await tx.wait();
  const lineId = (await credit.nextLineId()) - 1n;
  const line = await credit.line(lineId);
  log(`line ${lineId} open, limit ${formatEther(line.limit)} CTC`);
  return lineId;
}

export async function draw(
  credit: Contract,
  signer: Signer,
  lineId: bigint,
  amount: string,
  log: Log,
): Promise<void> {
  const writable = credit.connect(signer) as Contract;
  const wei = parseEther(amount);
  const due = await writable.draw.staticCall(lineId, wei);
  const tx = await writable.draw(lineId, wei);
  log(`drawing ${amount} CTC — ${tx.hash}`);
  await tx.wait();
  log(`drawn. ${due} source units must be proven repaid before the deadline.`);
}

/// Where a borrower got to, so a reload does not lose a bonded claim.
///
/// The bond is real money and the claim id is the only handle on it. Keeping this in the page's own
/// storage rather than in memory means closing a tab during a challenge window costs nothing —
/// which matters, because the window is measured in blocks and nobody is going to sit and watch it.
export interface Progress {
  subject?: string;
  volumeClaimId?: string;
  cleanClaimIds?: string[];
  lineId?: string;
}

export function loadProgress(credit: string): Progress {
  try {
    return JSON.parse(localStorage.getItem(`utuh:borrow:${credit.toLowerCase()}`) ?? '{}') as Progress;
  } catch {
    return {};
  }
}

export function saveProgress(credit: string, next: Progress): void {
  try {
    const merged = { ...loadProgress(credit), ...next };
    localStorage.setItem(`utuh:borrow:${credit.toLowerCase()}`, JSON.stringify(merged));
  } catch {
    // A browser with storage disabled still borrows fine; it just cannot be closed mid-window.
  }
}

export function forgetProgress(credit: string): void {
  try {
    localStorage.removeItem(`utuh:borrow:${credit.toLowerCase()}`);
  } catch {
    /* nothing to forget */
  }
}

export { eventKey };
