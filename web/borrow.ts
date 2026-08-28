import { Contract, Interface, formatEther, parseEther, type Signer } from 'ethers';
import { planBatches } from '../offchain/lib/batches';
import {
  builderAttestedHeight,
  fetchBatchProofPatiently,
  fetchSingleProof,
  proofFromBatch,
} from '../offchain/lib/proofApi';
import { eventKey, scanScopeUnion, type Scope, type ScopedEvent } from '../offchain/lib/scope';
import { toScope } from '../offchain/lib/specs';
import { sourceEndpoints } from './chain';
import { SWEEP_CHUNK, requireChainKey } from '../offchain/lib/networks';

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
///
/// `cleanIndex` is which adverse-event class, because a lender lists one per protocol it watches
/// and a line needs a finalized empty claim for each. This read `cleanSpecAt(0)` for every one of
/// them at first, which builds N claims about the first class and has `openLine` refuse the second
/// with ScopeMismatch — after N bonds and N windows.
export async function scopeFor(
  credit: Contract,
  which: 'volume' | 'clean',
  subject: string,
  cleanIndex = 0,
): Promise<Scope> {
  const spec = which === 'volume' ? await credit.volumeSpec() : await credit.cleanSpecAt(cleanIndex);
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
  chainInfo: Contract,
  signer: Signer,
  scope: Scope,
  requested: Range,
  opts: { bond: bigint; challengeWindow: number; minSources?: number; resume?: bigint },
  log: Log,
): Promise<BuiltClaim> {
  let range = requested;
  const minSources = opts.minSources ?? 2;

  // Resuming means the range is already decided — it is the open claim's, and the registry will
  // refuse an event outside it whatever the inputs now say.
  if (opts.resume !== undefined) {
    const c = await registry.claim(opts.resume);
    if (Number(c.status) !== 1) throw new Error(`claim ${opts.resume} is not open, so there is nothing to resume`);
    range = { fromBlock: Number(c.fromBlock), toBlock: Number(c.toBlock) };
  }

  // The whole range has to be attested before the registry will open a claim over it — that is
  // what makes a challenge window sound, since a watcher can then prove anything inside it from
  // block one. Attestation runs a few minutes behind the source chain, so a range ending near the
  // head has a real wait in front of it, and `open` sent early reverts RangeNotAttested after the
  // wallet has already asked the borrower to sign.
  await waitAttested(chainInfo, scope.chainKey, range.toBlock, log);

  log(`sweeping source blocks ${range.fromBlock}..${range.toBlock}`);
  const sweep = await scanScopeUnion(
    sourceEndpoints(scope.chainKey),
    scope,
    range.fromBlock,
    range.toBlock,
    SWEEP_CHUNK[requireChainKey(scope.chainKey)],
  );
  log(`answered: ${sweep.perSource.join('  ')}`);
  for (const c of sweep.conflicts) log(`ENDPOINT CONFLICT: ${c}`);

  if (sweep.vouched < minSources) {
    throw new Error(
      `only ${sweep.vouched} of ${sweep.attempted} endpoints saw everything (${sweep.answered} answered). A claim built on one node's ` +
        `word is only as complete as that node, and the bond is what pays for being wrong.`,
    );
  }
  log(`${sweep.events.length} in-scope event(s) to claim`);

  const writable = registry.connect(signer) as Contract;

  // A build can die between `open` and `seal` — an endpoint that stops answering, a signature
  // refused, a tab closed — and leave a claim Open with a bond in it. Picking it up is cheaper
  // than abandoning it and paying to open another: the registry keeps the last appended key, so
  // what is left to append is exactly the events after it.
  let claimId: bigint;
  let events = sweep.events;
  if (opts.resume !== undefined) {
    const c = await registry.claim(opts.resume);
    claimId = opts.resume;
    const lastKey = c.lastKey as bigint;
    events = sweep.events.filter((e) => eventKey(e) > lastKey);
    log(`resuming claim ${claimId}: ${sweep.events.length - events.length} already in it, ${events.length} to go`);
  } else {
    // eth_call first, here and on every write below. A bond under the floor or a window under the
    // deployment's minimum is the registry's answer to give, by name, before the wallet asks anyone
    // to sign a transaction that will fail.
    const openArgs = [scope, range.fromBlock, range.toBlock, opts.challengeWindow, { value: opts.bond }] as const;
    await writable.open.staticCall(...openArgs);
    const opened = await writable.open(...openArgs);
    const receipt = await opened.wait();
    claimId = await claimIdFrom(registry, receipt);
    log(`claim ${claimId} opened with ${formatEther(opts.bond)} CTC at stake`);
  }

  const batches = planBatches(events);
  try {
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]!;
      log(`batch ${i + 1}/${batches.length}: ${batch.length} event(s)`);
      await appendBatch(writable, claimId, scope.chainKey, batch, log);
    }
  } catch (e) {
    // Say where the money is. The claim is Open, the bond is in it, and the same button resumes.
    throw new OpenClaimLeft(claimId, (e as Error).message);
  }

  await writable.seal.staticCall(claimId);
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

/// A build that failed after `open`. Carries the claim so the caller can offer to resume it.
export class OpenClaimLeft extends Error {
  constructor(
    public readonly claimId: bigint,
    cause: string,
  ) {
    super(
      `claim ${claimId} is open with your bond in it, and appending failed: ${cause}. Press build again to resume it.`,
    );
  }
}

/// Block until Creditcoin has attested `height` — and the proof builder has indexed it, which is
/// a later moment, and the one that matters for the request that comes next.
async function waitAttested(chainInfo: Contract, chainKey: number, height: number, log: Log): Promise<void> {
  let said = -1;
  for (;;) {
    const frontier = Number((await chainInfo.get_latest_attestation_height_and_hash(chainKey)).height);
    if (frontier >= height) break;
    if (frontier !== said) {
      log(`waiting for Creditcoin to attest source block ${height} — at ${frontier}, ${height - frontier} to go`);
      said = frontier;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  said = -1;
  for (;;) {
    const indexed = await builderAttestedHeight(chainKey);
    if (indexed >= height) return;
    if (indexed !== said) {
      log(`waiting for the proof builder to index source block ${height} — at ${indexed}`);
      said = indexed;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
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
  const proof = await fetchBatchProofPatiently(chainKey, hashes, log);

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

/// The line this subject should be looking at: the open one, else the most recent one.
///
/// The contract keeps one slot per subject and the slot empties on settlement, so a borrower who
/// has just paid off a line — or who defaulted on one, or closed one — has `activeLineOf` of zero
/// and a history the page should still show. Read off the chain, newest first, because a browser
/// that was not the one that opened the line knows nothing, and the chain knows everything.
export async function lineToShow(credit: Contract, subject: string): Promise<bigint | undefined> {
  const active = (await credit.activeLineOf(subject)) as bigint;
  if (active !== 0n) return active;
  const next = (await credit.nextLineId()) as bigint;
  for (let id = next - 1n; id >= 1n; id--) {
    const l = await credit.line(id);
    if (l.subject.toLowerCase() === subject.toLowerCase()) return id;
  }
  return undefined;
}

/// What a drawn line owes, and where the proof of paying it has to come from.
export interface Obligation {
  lineId: bigint;
  status: number;
  drawn: bigint;
  /// In the source asset's own units — wei of ether for the ledger, 1e6 units for USDC.
  repayRequired: bigint;
  dueBlock: number;
  /// The first source-chain block a repayment claim may start at: after the underwriting, and
  /// after anything this subject already settled with.
  repayFrom: number;
  /// The event the claim must contain, and who must be paid.
  emitter: string;
  eventSig: string;
  payee: string;
  chainKey: number;
}

export async function obligationOf(credit: Contract, lineId: bigint): Promise<Obligation> {
  const [line, spec] = await Promise.all([credit.line(lineId), credit.repaySpec()]);
  const settled = Number(await credit.settledThrough(line.subject));
  return {
    lineId,
    status: Number(line.status),
    drawn: line.drawn,
    repayRequired: line.repayRequired,
    dueBlock: Number(line.dueBlock),
    repayFrom: Math.max(Number(line.repayFrom), settled),
    emitter: spec.emitter,
    eventSig: spec.eventSig,
    payee: spec.counterparty,
    chainKey: Number(spec.chainKey),
  };
}

/// The scope a repayment claim must carry — the lender's repay spec, pinned to this subject.
export async function repayScopeFor(credit: Contract, subject: string): Promise<Scope> {
  const spec = await credit.repaySpec();
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

/// The calldata that pays through the source-chain SettlementLedger: `settle(payee)`, with the
/// amount as the transaction's value. Only that contract; a lender whose repay spec names USDC
/// transfers is paid the way USDC is paid, and the page says so rather than pretending.
export function ledgerPayment(payee: string): string {
  return new Interface(['function settle(address payee) payable']).encodeFunctionData('settle', [payee]);
}

export async function settleLine(credit: Contract, signer: Signer, lineId: bigint, claimId: bigint, log: Log) {
  const writable = credit.connect(signer) as Contract;
  await writable.settle.staticCall(lineId, claimId);
  const tx = await writable.settle(lineId, claimId);
  log(`settling line ${lineId} with claim ${claimId} — ${tx.hash}`);
  await tx.wait();
}

export async function cureLine(credit: Contract, signer: Signer, lineId: bigint, claimId: bigint, log: Log) {
  const writable = credit.connect(signer) as Contract;
  await writable.cure.staticCall(lineId, claimId);
  const tx = await writable.cure(lineId, claimId);
  log(`curing line ${lineId} with claim ${claimId} — ${tx.hash}`);
  await tx.wait();
}

export async function closeLine(credit: Contract, signer: Signer, lineId: bigint, log: Log) {
  const writable = credit.connect(signer) as Contract;
  await writable.closeLine.staticCall(lineId);
  const tx = await writable.closeLine(lineId);
  log(`closing line ${lineId} — ${tx.hash}`);
  await tx.wait();
}

/// Take back an unpublished claim and its bond.
///
/// A build that died between `open` and `seal` — a closed tab, a rejected signature, an endpoint
/// that stopped answering — leaves a claim Open with a real bond in it. Nothing downstream can have
/// relied on it, so the registry hands the bond straight back. This is the recovery path, and it
/// has to be one click, because the alternative is a borrower who does not know the money is there.
export async function abandonClaim(registry: Contract, signer: Signer, claimId: bigint, log: Log) {
  const writable = registry.connect(signer) as Contract;
  await writable.abandon.staticCall(claimId);
  const tx = await writable.abandon(claimId);
  log(`abandoning claim ${claimId}, bond coming back — ${tx.hash}`);
  await tx.wait();
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
  repayClaimId?: string;
  /// A claim a build left Open, keyed by which build: 'volume', 'clean', 'repay'.
  openClaims?: Record<string, string>;
}

/// Keyed by the lender *and* the account. Two people sharing a browser — or one person with two
/// wallets — must not inherit each other's claim ids, because the next thing the pane would do
/// with an inherited id is try to open a line on somebody else's underwriting.
function progressKey(credit: string, account: string): string {
  return `utuh:borrow:${credit.toLowerCase()}:${account.toLowerCase()}`;
}

export function loadProgress(credit: string, account: string): Progress {
  try {
    return JSON.parse(localStorage.getItem(progressKey(credit, account)) ?? '{}') as Progress;
  } catch {
    return {};
  }
}

export function saveProgress(credit: string, account: string, next: Progress): void {
  try {
    const merged = { ...loadProgress(credit, account), ...next };
    localStorage.setItem(progressKey(credit, account), JSON.stringify(merged));
  } catch {
    // A browser with storage disabled still borrows fine; it just cannot be closed mid-window.
  }
}

export function forgetProgress(credit: string, account: string): void {
  try {
    localStorage.removeItem(progressKey(credit, account));
  } catch {
    /* nothing to forget */
  }
}

export { eventKey };
