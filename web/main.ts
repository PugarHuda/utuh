import { Contract, formatEther, toUtf8String, type Signer } from 'ethers';
import { claimStatus, lineStatus } from '../offchain/lib/status';
import { CHAIN_NAME } from '../offchain/lib/networks';
import { cc3, connect, EXPLORER, hasWallet, shortAddress, wire, type Wired } from './chain';
import { refute, sweepClaim, type Sweep } from './watch';
import { renderBorrow } from './borrowPane';

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

function row(cells: (string | HTMLElement)[], head = false): HTMLElement {
  const tr = el('tr');
  for (const c of cells) {
    const td = el(head ? 'th' : 'td');
    if (typeof c === 'string') td.textContent = c;
    else td.appendChild(c);
    tr.appendChild(td);
  }
  return tr;
}

function table(head: string[], rows: (string | HTMLElement)[][], testid: string): HTMLElement {
  const t = el('table');
  t.dataset.testid = testid;
  const thead = el('thead');
  thead.appendChild(row(head, true));
  t.appendChild(thead);
  const tbody = el('tbody');
  for (const r of rows) tbody.appendChild(row(r));
  t.appendChild(tbody);
  return t;
}

function fail(where: HTMLElement, e: unknown): void {
  const message =
    (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  where.replaceChildren(el('p', 'bad', message));
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
  const block = await cc3.getBlockNumber();
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
        `${c.fromBlock}..${c.toBlock}`,
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

    const select = $('claim-select') as HTMLSelectElement;
    const chosen = select.value;
    select.replaceChildren(
      ...claims.map((c) => {
        const o = document.createElement('option');
        o.value = String(c.id);
        o.textContent = `claim ${c.id} — ${claimStatus(c.status)}, ${c.members} member(s)`;
        return o;
      }),
    );
    if (chosen) select.value = chosen;

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
    say(`failed: ${(e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message}`);
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
      ]);
    }

    const body: HTMLElement[] = [policy];
    if (lines.length > 0) {
      body.push(
        table(
          ['line', 'borrower', 'subject', 'status', 'limit', 'drawn', 'owed (source units)', 'due', 'defaults'],
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
  if (!hasWallet()) {
    connectButton.disabled = true;
    connectButton.textContent = 'no wallet — reading only';
    connectButton.title = 'Install a wallet to finalize, withdraw or refute. Everything else is read-only anyway.';
  } else {
    connectButton.onclick = async () => {
      try {
        const c = await connect();
        signer = c.signer;
        account = c.address;
        connectButton.textContent = shortAddress(account);
        connectButton.disabled = true;
        await refresh();
        renderRefuteButton();
      } catch (e) {
        say(`connect failed: ${(e as Error).message}`);
      }
    };
  }

  ($('sweep') as HTMLButtonElement).onclick = () => void doSweep();

  try {
    wired = await wire();
  } catch (e) {
    fail($('registry-body'), e);
    $('boot-error').textContent = (e as Error).message;
    document.body.dataset.state = 'failed';
    return;
  }

  await Promise.all([renderHeader(), renderAttestcoin(), renderRegistry(), renderCredit(), renderBorrowPane()]);
  document.body.dataset.state = 'ready';
}

void main();
