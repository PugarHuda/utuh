import { Contract, formatEther, parseEther, toUtf8String, type Signer } from 'ethers';
import { claimStatus, lineStatus } from '../offchain/lib/status';
import {
  ATTESTATION_INDEXERS,
  CHAIN_NAME,
  DEPLOYMENT_RECORDS,
  ORACLE_DASHBOARD,
  SOURCE_EXPLORER,
  requireChainKey,
  type AttestationIndexer,
  type DeploymentName,
} from '../offchain/lib/networks';
import type { Eip1193Provider } from 'ethers';
import {
  cc3,
  connect,
  EXPLORER,
  hasWallet,
  loadDeployments,
  shortAddress,
  sourceEndpoints,
  wallets,
  wire,
  within,
  type Wired,
} from './chain';
import { refute, sweepClaim, type Sweep } from './watch';
import { renderBorrow } from './borrowPane';
import { abandonClaim } from './borrow';
import { explainRevert } from '../offchain/lib/revert';
import { attestorCount, recentAttestations } from '../offchain/lib/attestations';
import { CHAIN_KEY } from '../offchain/lib/networks';

/// The Utuh console.
///
/// Everything on the page is read from CC3 Testnet at the moment it is drawn. There is no seeded
/// state, no fixture and no screenshot: if the chain is down the page says so rather than showing
/// the last thing it knew.

let wired: Wired;
let signer: Signer | undefined;
let account: string | undefined;
let currentSweep: { claimId: bigint; sweep: Sweep } | undefined;

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`no element #${id}`);
  return el;
};

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function link(address: string): HTMLElement {
  const a = el('a', 'addr') as HTMLAnchorElement;
  a.href = `${EXPLORER}/address/${address}`;
  a.target = '_blank';
  a.rel = 'noreferrer';
  a.textContent = shortAddress(address);
  a.title = address;
  return a;
}

function row(cells: (string | HTMLElement)[], head = false, className?: string): HTMLElement {
  const tr = el('tr', className);
  for (const c of cells) {
    const td = el(head ? 'th' : 'td');
    // A `th` with no scope is a cell a screen reader cannot attach to its column, which on a
    // ten-column claims table turns every row into unlabelled numbers read in order.
    if (head) td.setAttribute('scope', 'col');
    if (typeof c === 'string') td.textContent = c;
    else td.appendChild(c);
    // A header with no text is a column of controls; a screen reader still needs a name for it.
    if (head && c === '') td.setAttribute('aria-label', 'actions');
    tr.appendChild(td);
  }
  return tr;
}

/// `rowClass` names the state of a row for the stylesheet. A refuted claim is drawn as a struck
/// frame — still on the sheet, visibly crossed out — and nothing in a row of formatted strings
/// tells CSS which one that is, so the caller that knows the status says so here.
function table(
  head: string[],
  rows: (string | HTMLElement)[][],
  testid: string,
  rowClass?: (index: number) => string | undefined,
): HTMLElement {
  const t = el('table');
  t.dataset.testid = testid;
  const thead = el('thead');
  thead.appendChild(row(head, true));
  t.appendChild(thead);
  const tbody = el('tbody');
  rows.forEach((r, i) => tbody.appendChild(row(r, false, rowClass?.(i))));
  t.appendChild(tbody);
  return t;
}

/// ethers puts the useful half in `shortMessage`; everything else has to be dug out of `message`.
function reason(e: unknown): string {
  return (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
}

function fail(where: HTMLElement, e: unknown): void {
  where.replaceChildren(el('p', 'bad', reason(e)));
}

// ------------------------------------------------------------------
// Panes
// ------------------------------------------------------------------

/// What Creditcoin itself says it can read. Straight off the ChainInfo precompile — the same call
/// the registry makes before it will accept a claim over a range.
async function renderAttestcoin(): Promise<void> {
  const box = $('attestcoin-body');
  try {
    const chains = (await wired.chainInfo.get_supported_chains()) as {
      chainKey: bigint;
      chainId: bigint;
      chainName: string;
      chainEncoding: bigint;
    }[];

    const rows: (string | HTMLElement)[][] = [];
    for (const c of chains) {
      const key = Number(c.chainKey);
      const frontier = await wired.chainInfo.get_latest_attestation_height_and_hash(key);
      const genesis = await wired.chainInfo.get_attestation_genesis_height(key);
      rows.push([
        String(key),
        toUtf8String(c.chainName),
        String(c.chainId),
        `v${Number(c.chainEncoding)}`,
        String(genesis),
        String(frontier.height),
      ]);
    }
    box.replaceChildren(
      table(['chain key', 'name', 'evm chain id', 'encoding', 'genesis', 'attested to'], rows, 'attestcoin-table'),
      el(
        'p',
        'note',
        'Read live from the ChainInfo precompile at 0x…0fD3. A claim may only cover a range this ' +
          'network has already attested — that is what makes a challenge window mean anything.',
      ),
    );
  } catch (e) {
    fail(box, e);
  }
}

async function renderHeader(): Promise<void> {
  const block = await within(20_000, 'reading the head', cc3.getBlockNumber());
  const net = await cc3.getNetwork();
  $('chain-id').textContent = String(net.chainId);
  $('cc3-block').textContent = String(block);

  const d = wired.deployments;
  const where = $('addresses');
  const rows: (string | HTMLElement)[][] = [];
  if (d.registry) rows.push(['UtuhRegistry', link(d.registry)]);
  if (d.credit) rows.push(['UtuhCredit', link(d.credit)]);
  if (d.ledger) rows.push([`SettlementLedger (source chain)`, link(d.ledger)]);
  where.replaceChildren(table(['contract', 'address'], rows, 'addresses-table'));
}

interface ClaimView {
  id: bigint;
  claimant: string;
  status: number;
  fromBlock: bigint;
  toBlock: bigint;
  chainKey: number;
  members: bigint;
  aggregate: bigint;
  bondPosted: bigint;
  enforceable: bigint;
  until: bigint;
}

/// How many claims to read at once.
///
/// Four `eth_call`s per claim, one after another, is what this did first, and on the registry with
/// 48 claims on it that took **51.7 seconds** to draw a table. Nothing was slow; everything was
/// waiting. Public endpoints do rate-limit, though, so this is a batch size rather than one
/// `Promise.all` over the lot.
const CLAIM_BATCH = 12;

/// Newest first, and only this many unless asked for more. A registry accumulates claims forever
/// and the ones anyone is looking at are the recent ones — a challenge window is a day at most.
const CLAIM_PAGE = 25;

let linkedApplied = false;
let linkedBumped = false;
let claimLimit = CLAIM_PAGE;

async function readOneClaim(i: number): Promise<ClaimView> {
  const [c, members, enforceable, until] = await Promise.all([
    wired.registry.claim(i),
    wired.registry.memberCount(i) as Promise<bigint>,
    wired.registry.enforceableLoss(i) as Promise<bigint>,
    wired.registry.challengeUntil(i) as Promise<bigint>,
  ]);
  return {
    id: BigInt(i),
    claimant: c.claimant,
    status: Number(c.status),
    fromBlock: c.fromBlock,
    toBlock: c.toBlock,
    chainKey: Number(c.scope.chainKey),
    members,
    aggregate: c.aggregate,
    bondPosted: c.bondPosted,
    enforceable,
    until,
  };
}

interface ClaimPage {
  claims: ClaimView[];
  total: number;
}

async function readClaims(): Promise<ClaimPage> {
  const total = Number(await wired.registry.nextClaimId()) - 1;
  const first = Math.max(1, total - claimLimit + 1);

  const ids: number[] = [];
  for (let i = first; i <= total; i++) ids.push(i);

  const claims: ClaimView[] = [];
  for (let at = 0; at < ids.length; at += CLAIM_BATCH) {
    claims.push(...(await Promise.all(ids.slice(at, at + CLAIM_BATCH).map(readOneClaim))));
  }
  // Read in order because a batch is a batch; shown newest first because that is what anyone
  // watching a challenge window is looking for.
  claims.reverse();
  return { claims, total };
}

/// The four numbers at the top, summed across both deployments.
///
/// The page has always been able to show a claim. What it could not show is what this registry has
/// *done*, and one of these numbers is the only one of its kind on this protocol: nothing else
/// deployed against Attestcoin has a refutation to count, because nothing else has the call.
///
/// Both deployments are read rather than the selected one. A visitor switching the dropdown is
/// asking which set of claims to browse, not asking the totals to shrink — and the mainnet-sourced
/// registry is where most of the work is, so showing one at a time would understate the whole by
/// four fifths.
///
/// Deliberately not awaited by boot: this walks every claim on two registries, and the panes below
/// should not wait on arithmetic. The strip reports its own readiness instead.
async function renderTally(): Promise<void> {
  const strip = $('tally');
  try {
    const registries = await Promise.all(
      (Object.keys(DEPLOYMENT_RECORDS) as DeploymentName[]).map(async (which) => {
        const d = await within(20_000, `${which} deployment record`, loadDeployments(which));
        if (!d.registry) return null;
        return new Contract(d.registry, wired.abis.registry as never, cc3);
      }),
    );

    let proven = 0n;
    let sealed = 0;
    let refuted = 0;
    let burned = 0n;

    for (const registry of registries) {
      if (!registry) continue;
      // ethers does not fail fast on an unreachable endpoint — it retries in the background and
      // this strip would sit on its placeholders indefinitely. A tally stuck at "…" is survivable;
      // one that resolved to a plausible zero would not be, because "0 refuted" is exactly the
      // wrong conclusion to hand a reader.
      const total = Number(await within(20_000, 'nextClaimId', registry.nextClaimId() as Promise<bigint>)) - 1;
      burned += await within(20_000, 'burned', registry.burned() as Promise<bigint>);
      sealed += total;

      const ids = Array.from({ length: total }, (_, i) => i + 1);
      for (let at = 0; at < ids.length; at += CLAIM_BATCH) {
        const slice = await Promise.all(
          ids.slice(at, at + CLAIM_BATCH).map(async (i) => ({
            status: Number((await within(20_000, `claim ${i}`, registry.claim(i))).status),
            members: await within(20_000, `memberCount ${i}`, registry.memberCount(i) as Promise<bigint>),
          })),
        );
        for (const c of slice) {
          proven += c.members;
          if (claimStatus(c.status) === 'Refuted') refuted += 1;
        }
      }
    }

    $('t-proven').textContent = proven.toLocaleString();
    $('t-claims').textContent = sealed.toLocaleString();
    $('t-refuted').textContent = refuted.toLocaleString();
    $('t-burned').textContent = `${formatEther(burned)} CTC`;
    strip.dataset.ready = 'true';
  } catch (e) {
    // A tally that cannot be read says so rather than showing a plausible zero.
    for (const id of ['t-proven', 't-claims', 't-refuted', 't-burned']) $(id).textContent = '—';
    strip.dataset.ready = 'failed';
    strip.title = reason(e);
  }
}

async function renderRegistry(): Promise<void> {
  const box = $('registry-body');
  try {
    const [page, burned, head] = await Promise.all([
      readClaims(),
      wired.registry.burned() as Promise<bigint>,
      cc3.getBlockNumber(),
    ]);
    const claims = page.claims;

    const rows = claims.map((c) => {
      const window =
        c.status === 2
          ? Number(c.until) - head > 0
            ? `${Number(c.until) - head} blocks left`
            : 'window closed'
          : '—';
      return [
        String(c.id),
        link(c.claimant),
        claimStatus(c.status),
        sourceRange(c.chainKey, Number(c.fromBlock), Number(c.toBlock)),
        CHAIN_NAME[c.chainKey as 1 | 3] ?? `key ${c.chainKey}`,
        String(c.members),
        String(c.aggregate),
        `${formatEther(c.bondPosted)} CTC`,
        `${formatEther(c.enforceable)} CTC`,
        window,
      ];
    });

    box.replaceChildren(
      table(
        [
          'claim',
          'claimant',
          'status',
          'source range',
          'chain',
          'members',
          'aggregate',
          'bond',
          'enforceable loss',
          'window',
        ],
        rows,
        'claims-table',
        // Status 4 is Refuted — the claim somebody broke. See offchain/lib/status.ts.
        (i) => (claims[i]?.status === 4 ? 'struck' : undefined),
      ),
      el(
        'p',
        'note',
        `${claims.length} of ${page.total} claim(s) shown, newest first. ` +
          `${formatEther(burned)} CTC burned from broken claims — nobody can recover that.`,
      ),
    );

    if (claims.length < page.total) {
      const more = el(
        'button',
        'act',
        `show ${Math.min(CLAIM_PAGE, page.total - claims.length)} older`,
      ) as HTMLButtonElement;
      more.dataset.testid = 'more-claims';
      more.onclick = () => {
        claimLimit += CLAIM_PAGE;
        void renderRegistry();
      };
      box.appendChild(more);
    }

    // `?claim=N` opens a claim on arrival — how a post or a document points at one. A claim older
    // than the first page is reached by showing enough older ones, once; the list is newest-first
    // and the ids are dense, so "enough" is arithmetic rather than a search.
    const linked = new URLSearchParams(location.search).get('claim');
    const linkedId = linked && /^\d+$/.test(linked) ? Number(linked) : undefined;
    if (
      linkedId !== undefined &&
      !linkedBumped &&
      linkedId >= 1 &&
      linkedId <= page.total &&
      !claims.some((c) => Number(c.id) === linkedId)
    ) {
      linkedBumped = true;
      claimLimit = Math.ceil((page.total - linkedId + 1) / CLAIM_PAGE) * CLAIM_PAGE;
      void renderRegistry();
      return;
    }

    const select = $('claim-select') as HTMLSelectElement;
    const chosen = select.value || (linkedId !== undefined && !linkedApplied ? String(linkedId) : '');
    linkedApplied = true;
    select.replaceChildren(
      ...claims.map((c) => {
        const o = document.createElement('option');
        o.value = String(c.id);
        o.textContent = `claim ${c.id} — ${claimStatus(c.status)}, ${c.members} member(s)`;
        return o;
      }),
    );
    if (chosen) select.value = chosen;
    void renderClaimDetail();

    // A registry that has never been used has nothing to sweep, and a sweep button that produces
    // `BigInt("")` is worse than one that is plainly off.
    const sweep = $('sweep') as HTMLButtonElement;
    sweep.disabled = claims.length === 0;
    sweep.title = claims.length === 0 ? 'this registry holds no claims yet' : '';

    renderActions(claims, head);
  } catch (e) {
    fail(box, e);
  }
}

/// Only the actions that would actually go through, and each says why when it would not.
function renderActions(claims: ClaimView[], head: number): void {
  const box = $('actions');
  const items: HTMLElement[] = [];

  const finalizable = claims.filter((c) => c.status === 2 && Number(c.until) < head);
  for (const c of finalizable) {
    const b = el('button', 'act', `finalize claim ${c.id}`) as HTMLButtonElement;
    b.dataset.testid = `finalize-${c.id}`;
    b.disabled = !signer;
    b.title = signer ? 'permissionless — anyone may settle an unrefuted claim' : 'connect a wallet first';
    b.onclick = () => send(b, () => (wired.registry.connect(signer!) as Contract).finalize(c.id));
    items.push(b);
  }

  // A claim of the connected account's that was opened and never sealed has a bond in it and
  // nothing relying on it. A build that died — a closed tab, a rejected signature — leaves exactly
  // this behind, and the registry gives the bond straight back. One click, because the alternative
  // is a borrower who does not know the money is there.
  if (account) {
    const me = account.toLowerCase();
    const stranded = claims.filter((c) => c.status === 1 && c.claimant.toLowerCase() === me);
    for (const c of stranded) {
      const b = el(
        'button',
        'act',
        `abandon claim ${c.id} and recover ${formatEther(c.bondPosted)} CTC`,
      ) as HTMLButtonElement;
      b.dataset.testid = `abandon-${c.id}`;
      b.title = 'this claim was opened and never sealed; nothing relies on it';
      b.onclick = () =>
        send(b, async () => {
          await abandonClaim(wired.registry, signer!, c.id, say);
          return { hash: 'abandoned', wait: async () => undefined };
        });
      items.push(b);
    }
  }

  if (account) {
    const w = el('button', 'act', 'withdraw refunded bonds') as HTMLButtonElement;
    w.dataset.testid = 'withdraw';
    w.onclick = () => send(w, () => (wired.registry.connect(signer!) as Contract).withdraw());
    items.push(w);
  }

  if (items.length === 0) {
    items.push(el('p', 'note', 'Nothing to do right now: no claim has an expired window waiting to be settled.'));
  }
  box.replaceChildren(...items);
}

async function send(button: HTMLButtonElement, work: () => Promise<{ wait: () => Promise<unknown>; hash: string }>) {
  const was = button.textContent ?? '';
  button.disabled = true;
  button.textContent = 'sending…';
  try {
    const tx = await work();
    button.textContent = 'confirming…';
    await tx.wait();
    say(`sent ${tx.hash}`);
    await refresh();
  } catch (e) {
    say(`failed: ${explainRevert(e, [wired.registry.interface, wired.credit.interface])}`);
  } finally {
    button.textContent = was;
    button.disabled = false;
  }
}

/// The borrow pane keeps its own log, so a long claim build does not scroll the watcher's away.
function sayBorrow(line: string): void {
  const log = $('borrow-log');
  log.appendChild(el('div', 'line', line));
  log.scrollTop = log.scrollHeight;
}

function say(line: string): void {
  const log = $('log');
  log.appendChild(el('div', 'line', line));
  log.scrollTop = log.scrollHeight;
}

/// Check the attestation layer against the chain it claims to attest.
///
/// This is the one pane that does not take Creditcoin's word for anything. The ChainInfo
/// precompile reports how far a source chain has been attested; it does not return the header hash
/// the attestors signed, so on the precompile alone their claim cannot be contradicted from
/// outside. The indexer publishes the hash. So: ask Creditcoin what it attested for source block N,
/// ask the same independent endpoints the watcher sweeps what the hash of block N actually is, and
/// put the two side by side.
///
/// Every row here is expected to agree, and saying so is the point — an oracle nobody audits is an
/// oracle you are trusting. A row that disagreed would mean the attestors signed a header the
/// source chain does not have, which is a far larger failure than any claim on this page, and this
/// is the only place a visitor could find that out without running anything.
async function renderAttestors(): Promise<void> {
  const box = $('attestors-body');
  try {
    // Two Creditcoin networks, one Ethereum. The deployment's own network is audited on the source
    // chain it underwrites; Creditcoin Mainnet is audited on Ethereum mainnet, which is the only
    // chain it attests. When this build is reading its mainnet-sourced deployment both tables are
    // about the same Ethereum blocks, signed by two independent attestor sets — and they are
    // checked against Ethereum rather than against each other.
    const audits = [
      { indexer: ATTESTATION_INDEXERS.testnet, chainKey: CHAIN_KEY[wired.which] },
      { indexer: ATTESTATION_INDEXERS.mainnet, chainKey: ATTESTATION_INDEXERS.mainnet.ethereumKey },
    ];
    const sections = await Promise.all(audits.map((a) => auditIndexer(a.indexer, a.chainKey)));
    box.replaceChildren(...sections.flat());
  } catch (e) {
    fail(box, e);
  }
}

/// One network's attestations, each row checked against the source chain itself.
async function auditIndexer(indexer: AttestationIndexer, chainKey: number): Promise<Node[]> {
  // The chain key is the network's own; the endpoints to check against are chosen by which real
  // chain that key denotes here. Creditcoin Mainnet's key 1 is Ethereum mainnet, and CC3 Testnet's
  // key 1 is Sepolia — reading either through the other's table is exactly the confusion that
  // would produce a table of MISMATCH rows about a perfectly honest oracle.
  const sourceKey = indexer === ATTESTATION_INDEXERS.mainnet ? CHAIN_KEY.mainnet : chainKey;
  const heading = el('h3', 'sub', `${indexer.label} — attesting ${CHAIN_NAME[requireChainKey(sourceKey)]}`);

  let total: number;
  let nodes: Awaited<ReturnType<typeof recentAttestations>>['nodes'];
  let attestors: number;
  try {
    [{ total, nodes }, attestors] = await Promise.all([
      recentAttestations(indexer, chainKey, 6),
      attestorCount(indexer).catch(() => 0),
    ]);
  } catch (e) {
    return [heading, el('p', 'bad', `${indexer.label}: the indexer could not be read — ${reason(e)}`)];
  }

  const endpoints = sourceEndpoints(requireChainKey(sourceKey));
  const rows = await Promise.all(
    nodes.map(async (a) => {
      // Ask every endpoint the watcher would sweep, not one. A single node agreeing proves less
      // than the union does, for the same reason a one-endpoint sweep settles nothing.
      const answers = await Promise.all(
        endpoints.map(async (e) => {
          try {
            const block = await within(12_000, `block ${a.headerNumber}`, e.provider.getBlock(a.headerNumber));
            return block?.hash?.toLowerCase() ?? null;
          } catch {
            return null;
          }
        }),
      );
      const seen = answers.filter((h): h is string => h !== null);
      const agree = seen.filter((h) => h === a.headerHash.toLowerCase()).length;
      const verdict =
        seen.length === 0
          ? 'no endpoint answered'
          : agree === seen.length
            ? `matches ${agree}/${seen.length}`
            : `MISMATCH — ${agree}/${seen.length} agree`;
      return {
        cells: [
          String(a.headerNumber),
          `${a.headerHash.slice(0, 10)}…${a.headerHash.slice(-6)}`,
          new Date(a.timestampMs).toISOString().replace('T', ' ').slice(0, 19),
          verdict,
        ],
        bad: seen.length > 0 && agree !== seen.length,
      };
    }),
  );

  return [
    heading,
    table(
      ['source block', 'header hash Creditcoin signed', 'attested at (UTC)', 'independent check'],
      rows.map((r) => r.cells),
      `attestors-table-${indexer.ethereumKey}`,
      (i) => (rows[i]?.bad ? 'struck' : undefined),
    ),
    el(
      'p',
      'note',
      `${total.toLocaleString()} attestations indexed for this source chain, from ${attestors} registered ` +
        `attestor(s), under chain key ${chainKey} on this network. Each row above was checked against ` +
        `${endpoints.length} independent endpoint(s) from this browser — no server was asked, and nothing ` +
        'here is cached.',
    ),
  ];
}

async function renderCredit(): Promise<void> {
  const box = $('credit-body');
  try {
    const c = wired.credit;
    const [
      available,
      ltv,
      bondMultiple,
      rate,
      minHistory,
      staleness,
      repaymentBps,
      repayWindow,
      lender,
      nextLineId,
      peerCount,
    ] = await Promise.all([
      c.available() as Promise<bigint>,
      c.LTV_BPS() as Promise<bigint>,
      c.BOND_MULTIPLE() as Promise<bigint>,
      c.VOLUME_UNIT_IN_CTC() as Promise<bigint>,
      c.MIN_HISTORY_BLOCKS() as Promise<bigint>,
      c.MAX_STALENESS_BLOCKS() as Promise<bigint>,
      c.REPAYMENT_BPS() as Promise<bigint>,
      c.REPAY_WINDOW_BLOCKS() as Promise<bigint>,
      c.LENDER() as Promise<string>,
      c.nextLineId() as Promise<bigint>,
      c.peerCount() as Promise<bigint>,
    ]);

    // Whose defaults this lender honours besides its own. Read off the contract, because it is
    // immutable there and a page that said otherwise would be the thing that was wrong.
    const peers: HTMLElement[] = [];
    for (let i = 0n; i < peerCount; i++) peers.push(link(await c.peerAt(i)));
    const peersCell =
      peers.length === 0
        ? "none — this lender takes nobody else's books, which is the safe default"
        : (() => {
            const span = el('span');
            peers.forEach((p, i) => {
              if (i > 0) span.appendChild(document.createTextNode(', '));
              span.appendChild(p);
            });
            return span;
          })();

    const policy = table(
      ['lender policy', 'value'],
      [
        ['loan-to-value', `${Number(ltv) / 100}% of proven volume`],
        ['credit per unit of enforceable loss', `${bondMultiple}×`],
        ['CTC wei per source unit', String(rate)],
        ['history required', `${minHistory} source blocks`],
        ['staleness allowed', `${staleness} source blocks`],
        ['repayment', `${Number(repaymentBps) / 100}% of what was drawn`],
        ['repayment window', `${repayWindow} Creditcoin blocks`],
        ['lender', link(lender)],
        ['peers whose defaults are honoured', peersCell],
        ['undrawn liquidity', `${formatEther(available)} CTC`],
      ],
      'policy-table',
    );

    const head = await cc3.getBlockNumber();
    const lines: (string | HTMLElement)[][] = [];
    for (let i = 1n; i < nextLineId; i++) {
      const l = await c.line(i);
      const due = Number(l.dueBlock);
      const overdue = Number(l.status) === 1 && l.drawn > 0n && due !== 0 && head > due;

      // Recording a default is permissionless and unpaid, and the guards no longer depend on it —
      // an overdue line blocks the next one by itself. It is still the record the peers read, so
      // whoever notices may write it. The button says exactly what it does and to whom.
      let action: HTMLElement | string = '';
      if (overdue) {
        const b = el('button', 'act danger', 'mark default') as HTMLButtonElement;
        b.dataset.testid = `mark-default-${i}`;
        b.disabled = !signer;
        b.title = signer
          ? `records that line ${i} passed its deadline with no proven repayment`
          : 'connect a wallet first';
        b.onclick = () => send(b, () => (c.connect(signer!) as Contract).markDefault(i));
        action = b;
      }

      lines.push([
        String(i),
        link(l.borrower),
        link(l.subject),
        lineStatus(l.status),
        `${formatEther(l.limit)} CTC`,
        `${formatEther(l.drawn)} CTC`,
        String(l.repayRequired),
        due === 0 ? 'not drawn' : due < head ? `overdue since ${due}` : `block ${due}`,
        String(await c.defaultsOf(l.subject)),
        action,
      ]);
    }

    // The lender's own controls, shown only to the lender. LENDER is msg.sender at construction
    // and immutable, so this is a comparison, not a permission.
    const lenderBox = el('div', 'actions');
    if (account && lender.toLowerCase() === account.toLowerCase()) {
      const amount = document.createElement('input');
      amount.placeholder = 'CTC';
      amount.setAttribute('aria-label', 'CTC to fund or withdraw');
      amount.dataset.testid = 'lender-amount';
      const fund = el('button', 'act', 'fund') as HTMLButtonElement;
      fund.dataset.testid = 'lender-fund';
      fund.title = 'deposit CTC for borrowers to draw on';
      fund.onclick = () =>
        send(fund, () => (c.connect(signer!) as Contract).fund({ value: parseEther(amount.value.trim() || '0') }));
      const withdraw = el('button', 'act', 'withdraw undrawn') as HTMLButtonElement;
      withdraw.dataset.testid = 'lender-withdraw';
      withdraw.title = 'take back liquidity nobody has drawn';
      withdraw.onclick = () =>
        send(withdraw, () => (c.connect(signer!) as Contract).withdraw(parseEther(amount.value.trim() || '0')));
      lenderBox.appendChild(el('span', 'note', 'you are the lender —'));
      lenderBox.appendChild(amount);
      lenderBox.appendChild(fund);
      lenderBox.appendChild(withdraw);
    }

    const body: HTMLElement[] = [policy, lenderBox];
    if (lines.length > 0) {
      body.push(
        table(
          ['line', 'borrower', 'subject', 'status', 'limit', 'drawn', 'owed (source units)', 'due', 'defaults', ''],
          lines,
          'lines-table',
        ),
      );
    } else {
      const note = el('p', 'note', 'No line has been opened on this deployment yet.');
      note.dataset.testid = 'no-lines';
      body.push(note);
    }
    box.replaceChildren(...body);
  } catch (e) {
    fail(box, e);
  }
}

// ------------------------------------------------------------------
// Watching
// ------------------------------------------------------------------

/// A source-chain block range as two links a person can open.
function sourceRange(chainKey: number, from: number, to: number): HTMLElement {
  const span = el('span');
  try {
    const ex = SOURCE_EXPLORER[requireChainKey(chainKey)];
    const a = (n: number) => {
      const x = el('a', 'addr', String(n)) as HTMLAnchorElement;
      x.href = `${ex}/block/${n}`;
      x.target = '_blank';
      x.rel = 'noreferrer';
      return x;
    };
    span.appendChild(a(from));
    span.appendChild(document.createTextNode('..'));
    span.appendChild(a(to));
  } catch {
    span.textContent = `${from}..${to}`;
  }
  return span;
}

/// What a claim actually holds, decoded and linked, so "read it back yourself" is a click.
///
/// The registry stores an ordering key per member — block, transaction index, log index packed
/// into one number — and nothing else, so what can be linked is the block; the transaction at that
/// index inside it is the one. Every member passed through the Block Prover on the way in, and the
/// oracle dashboard has the verification the precompile emitted for it, by source height.
async function renderClaimDetail(): Promise<void> {
  const box = $('claim-detail');
  const chosen = ($('claim-select') as HTMLSelectElement).value;
  if (!chosen) {
    box.replaceChildren();
    return;
  }
  try {
    const id = BigInt(chosen);
    const [c, count] = await Promise.all([
      wired.registry.claim(id),
      wired.registry.memberCount(id) as Promise<bigint>,
    ]);
    const chainKey = Number(c.scope.chainKey);
    const ex = SOURCE_EXPLORER[requireChainKey(chainKey)];

    const emitter = el('a', 'addr', shortAddress(c.scope.emitter)) as HTMLAnchorElement;
    emitter.href = `${ex}/address/${c.scope.emitter}`;
    emitter.target = '_blank';
    emitter.rel = 'noreferrer';
    emitter.title = c.scope.emitter;

    const head = el('p', 'note');
    head.appendChild(document.createTextNode(`claim ${id}: events from `));
    head.appendChild(emitter);
    head.appendChild(
      document.createTextNode(
        ` with signature ${String(c.scope.eventSig).slice(0, 10)}…, ` +
          `${Number(c.scope.metric) === 0 ? 'counted' : `summing data word ${c.scope.metricArg}`}, ` +
          `${count} member(s), aggregate ${c.aggregate}.`,
      ),
    );

    const shown = Number(count > 50n ? 50n : count);
    const rows: (string | HTMLElement)[][] = [];
    for (let i = 0; i < shown; i++) {
      const k = (await wired.registry.keyAt(id, i)) as bigint;
      const block = Number(k >> 96n);
      const tx = Number((k >> 32n) & 0xffffffffn);
      const log = Number(k & 0xffffffffn);
      const b = el('a', 'addr', String(block)) as HTMLAnchorElement;
      b.href = `${ex}/block/${block}`;
      b.target = '_blank';
      b.rel = 'noreferrer';
      rows.push([String(i), b, `tx #${tx}`, `log #${log}`, String(k)]);
    }

    const dash = el('a', 'addr', "Creditcoin's oracle dashboard") as HTMLAnchorElement;
    dash.href = ORACLE_DASHBOARD;
    dash.target = '_blank';
    dash.rel = 'noreferrer';
    const foot = el('p', 'note');
    foot.appendChild(
      document.createTextNode(
        (count > 50n ? `first 50 of ${count} members shown. ` : '') +
          'Each member was verified by the Block Prover at 0x…0FD2 on the way in; the verification it emitted is on ',
      ),
    );
    foot.appendChild(dash);
    foot.appendChild(document.createTextNode(', by source height.'));

    box.replaceChildren(
      head,
      ...(rows.length > 0
        ? [table(['#', 'source block', 'transaction', 'log', 'ordering key'], rows, 'members-table')]
        : []),
      foot,
    );
  } catch (e) {
    fail(box, e);
  }
}

async function doSweep(): Promise<void> {
  const button = $('sweep') as HTMLButtonElement;
  const claimId = BigInt(($('claim-select') as HTMLSelectElement).value);
  button.disabled = true;
  $('log').replaceChildren();
  say(`sweeping for claim ${claimId}`);
  try {
    const sweep = await sweepClaim(wired.registry, claimId, say);
    currentSweep = { claimId, sweep };
    renderRefuteButton();
  } catch (e) {
    say(`sweep failed: ${(e as Error).message}`);
  } finally {
    button.disabled = false;
  }
}

function renderRefuteButton(): void {
  const box = $('refute-box');
  if (!currentSweep || currentSweep.sweep.gaps.length === 0) {
    box.replaceChildren();
    return;
  }
  const gap = currentSweep.sweep.gaps[0]!;
  const b = el(
    'button',
    'act danger',
    `refute claim ${currentSweep.claimId} with the event at block ${gap.blockNumber}`,
  ) as HTMLButtonElement;
  b.dataset.testid = 'refute';
  b.disabled = !signer;
  b.title = signer ? 'takes half the bond' : 'connect a wallet first';
  b.onclick = async () => {
    b.disabled = true;
    try {
      const { hash } = await refute(
        wired.registry,
        signer!,
        currentSweep!.claimId,
        gap,
        currentSweep!.sweep.scope.chainKey,
        say,
      );
      say(`refuted — ${hash}`);
      await refresh();
    } catch (e) {
      say(
        `refutation failed: ${(e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message}`,
      );
    } finally {
      b.disabled = false;
    }
  };
  box.replaceChildren(b);
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------

async function refresh(): Promise<void> {
  await Promise.all([renderHeader(), renderRegistry(), renderCredit(), renderBorrowPane()]);
}

function renderBorrowPane(): Promise<void> {
  return renderBorrow(
    {
      wired,
      signer: () => signer,
      account: () => account,
      onChange: () => refresh(),
    },
    sayBorrow,
  );
}

async function main(): Promise<void> {
  const connectButton = $('connect') as HTMLButtonElement;
  const choice = $('wallet-choice');
  const connectWith = async (which?: Eip1193Provider) => {
    choice.replaceChildren();
    try {
      const c = await connect(which);
      signer = c.signer;
      account = c.address;
      connectButton.textContent = shortAddress(account);
      connectButton.disabled = true;
      await refresh();
      renderRefuteButton();
    } catch (e) {
      say(`connect failed: ${explainRevert(e, [])}`);
    }
  };
  if (!hasWallet()) {
    connectButton.disabled = true;
    connectButton.textContent = 'no wallet — reading only';
    connectButton.title = 'Install a wallet to finalize, withdraw or refute. Everything else is read-only anyway.';
  } else {
    connectButton.onclick = () => {
      const list = wallets();
      if (list.length === 1) return void connectWith(list[0]!.provider);
      // More than one wallet announced itself. Name them and let the person say which — the
      // alternative is whichever one grabbed `window.ethereum` last, which nobody chose.
      choice.replaceChildren(
        ...list.map((w) => {
          const b = el('button', 'act', w.name) as HTMLButtonElement;
          b.dataset.wallet = w.name;
          b.onclick = () => void connectWith(w.provider);
          return b;
        }),
      );
      (choice.firstElementChild as HTMLButtonElement | null)?.focus();
    };
  }

  ($('sweep') as HTMLButtonElement).onclick = () => void doSweep();

  // A skip link moves focus, not just the scroll: the fragment alone leaves the next Tab landing
  // after the target rather than on it.
  for (const a of document.querySelectorAll<HTMLAnchorElement>('.skip a')) {
    a.onclick = (e) => {
      e.preventDefault();
      const target = document.getElementById(a.dataset.skip ?? '');
      if (!target) return;
      if (!target.hasAttribute('tabindex') && target.tagName !== 'BUTTON') target.tabIndex = -1;
      target.focus();
      target.scrollIntoView({ block: 'center' });
    };
  }
  ($('claim-select') as HTMLSelectElement).onchange = () => {
    // The address bar follows the pick, so what is on screen is what the URL says — copy it and
    // the next person lands on the same claim.
    const url = new URL(location.href);
    url.searchParams.set('claim', ($('claim-select') as HTMLSelectElement).value);
    history.replaceState(null, '', url.toString());
    void renderClaimDetail();
  };

  // Switching deployments is a navigation, not a re-render: everything on the page is derived
  // from one record, and a reload is the honest way to derive it again.
  const picker = $('deployment') as HTMLSelectElement;
  picker.value = new URLSearchParams(location.search).get('deployment') === 'mainnet' ? 'mainnet' : 'sepolia';
  picker.onchange = () => {
    const url = new URL(location.href);
    if (picker.value === 'mainnet') url.searchParams.set('deployment', 'mainnet');
    else url.searchParams.delete('deployment');
    // A claim id means nothing on the other registry.
    url.searchParams.delete('claim');
    location.assign(url.toString());
  };

  try {
    wired = await wire();
  } catch (e) {
    fail($('registry-body'), e);
    $('boot-error').textContent = (e as Error).message;
    document.body.dataset.state = 'failed';
    return;
  }

  // The first read of the chain decides whether this is a page or an apology. If Creditcoin does
  // not answer, say so where the person is looking and stop, rather than leaving every pane on its
  // placeholder text and the body on "loading" until they give up.
  try {
    await renderHeader();
  } catch (e) {
    const why = (e as Error).message;
    $('boot-error').textContent = `Creditcoin is not answering from this browser — ${why}. Nothing below is current.`;
    $('chain-id').textContent = '—';
    $('cc3-block').textContent = '—';
    fail($('attestcoin-body'), e);
    fail($('registry-body'), e);
    fail($('credit-body'), e);
    document.body.dataset.state = 'failed';
    return;
  }

  void renderTally();
  await Promise.all([renderAttestcoin(), renderRegistry(), renderCredit(), renderBorrowPane(), renderAttestors()]);
  document.body.dataset.state = 'ready';
}

void main();
