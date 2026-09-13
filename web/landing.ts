import { formatEther } from 'ethers';
import { CHAIN_NAME, SOURCE_EXPLORER, requireChainKey, type DeploymentName } from '../offchain/lib/networks';
import { cc3, EXPLORER, loadAbis, shortAddress, within, type Abis } from './chain';
import { readSchedule, readTally, type Schedule } from './reads';

/// The landing page.
///
/// Nothing on it is written down. The two claims it shows are read from the registries as the page
/// draws, the range strips are plotted from the members the chain returns, and the finding under
/// each is the registry's own ClaimRefuted record. If the chain is down the schedules say so.

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`no element #${id}`);
  return node;
};

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function mark(kind: 'tick' | 'exc'): SVGSVGElement {
  const s = svg('svg', { class: `mark ${kind}`, 'aria-hidden': 'true' });
  const use = svg('use', {});
  use.setAttribute('href', `#m-${kind}`);
  s.appendChild(use);
  return s;
}

function out(href: string, text: string, className = 'addr'): HTMLAnchorElement {
  const a = el('a', className, text) as HTMLAnchorElement;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noreferrer';
  return a;
}

/// The claim's block range drawn to scale: a ruled axis, one blue tick per member, and a red
/// circle where the omitted event sits. On a wide range the members bunch — that is the truth of
/// the data, not a defect of the drawing.
function strip(s: Schedule): SVGSVGElement {
  const W = 600;
  const H = 62;
  const left = 8;
  const right = W - 8;
  const y = 30;
  const span = Math.max(1, s.toBlock - s.fromBlock);
  const x = (block: number) => left + ((block - s.fromBlock) / span) * (right - left);

  const root = svg('svg', {
    class: 'strip',
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label':
      `Source blocks ${s.fromBlock.toLocaleString()} to ${s.toBlock.toLocaleString()}: ${s.members} member(s) ticked` +
      (s.refutation
        ? `, the omitted event at block ${s.refutation.omittedBlock.toLocaleString()} circled in red.`
        : '.'),
  });
  for (let i = 0; i <= 8; i++) {
    const gx = left + ((right - left) * i) / 8;
    root.appendChild(svg('line', { class: 'grid', x1: gx, x2: gx, y1: y - 10, y2: y + 10 }));
  }
  root.appendChild(svg('line', { class: 'axis', x1: left, x2: right, y1: y, y2: y }));
  for (const b of s.memberBlocks) {
    root.appendChild(svg('line', { class: 'member', x1: x(b), x2: x(b), y1: y - 12, y2: y + 12 }));
  }
  const from = svg('text', { x: left, y: H - 6 });
  from.textContent = s.fromBlock.toLocaleString();
  root.appendChild(from);
  const to = svg('text', { x: right, y: H - 6, 'text-anchor': 'end' });
  to.textContent = s.toBlock.toLocaleString();
  root.appendChild(to);
  if (s.refutation) {
    const ox = x(s.refutation.omittedBlock);
    root.appendChild(svg('circle', { class: 'omitted drawn', cx: ox, cy: y, r: 7 }));
    const anchor = ox > W * 0.7 ? 'end' : ox < W * 0.3 ? 'start' : 'middle';
    const label = svg('text', { class: 'red', x: ox, y: 11, 'text-anchor': anchor });
    label.textContent = `EXC ${s.refutation.omittedBlock.toLocaleString()}`;
    root.appendChild(label);
  }
  return root;
}

/// The members as the auditor lists them, with the omitted event printed as a row in its place.
/// A gap that is only an absence cannot be read; a gap printed as a row can.
function members(s: Schedule): HTMLElement {
  const ex = SOURCE_EXPLORER[requireChainKey(s.chainKey)];
  const t = el('table');
  t.dataset.testid = `schedule-members-${s.which}-${s.id}`;
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['#', 'source block', 'traced']) {
    const th = el('th', undefined, h);
    th.setAttribute('scope', 'col');
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el('tbody');

  const rows: { block: number; index?: number }[] = s.memberBlocks.map((block, index) => ({ block, index }));
  if (s.refutation) rows.push({ block: s.refutation.omittedBlock });
  rows.sort((a, b) => a.block - b.block || (a.index ?? 1e9) - (b.index ?? 1e9));

  for (const r of rows) {
    const tr = el('tr', r.index === undefined ? 'struck' : undefined);
    tr.appendChild(el('td', undefined, r.index === undefined ? '—' : String(r.index)));
    const td = el('td');
    td.appendChild(out(`${ex}/block/${r.block}`, r.block.toLocaleString()));
    tr.appendChild(td);
    const traced = el('td');
    if (r.index === undefined) {
      traced.appendChild(mark('exc'));
      traced.appendChild(document.createTextNode('in scope, not in claim'));
      traced.className = 'exc';
    } else {
      traced.appendChild(mark('tick'));
      traced.appendChild(document.createTextNode('verified by the Block Prover'));
    }
    tr.appendChild(traced);
    tbody.appendChild(tr);
  }
  if (s.members > s.memberBlocks.length) {
    const tr = el('tr');
    const td = el('td', undefined, `… ${s.members - s.memberBlocks.length} more member(s) in the console`);
    (td as HTMLTableCellElement).colSpan = 3;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}

function finding(s: Schedule): HTMLElement {
  const p = el('p', 'finding');
  p.dataset.testid = 'finding';
  const r = s.refutation;
  if (s.status === 'Refuted' && r) {
    p.appendChild(el('b', undefined, 'Exception. '));
    p.appendChild(
      document.createTextNode(
        `An in-scope event at source block ${r.omittedBlock.toLocaleString()} is not in the claim. Refuted at ` +
          `Creditcoin block ${r.cc3Block.toLocaleString()} by `,
      ),
    );
    p.appendChild(out(`${EXPLORER}/address/${r.refuter}`, shortAddress(r.refuter)));
    p.appendChild(
      document.createTextNode(
        `; ${formatEther(r.reward)} of the ${formatEther(s.bondPosted)} CTC bond paid to the refuter, the rest burned. `,
      ),
    );
    p.appendChild(out(`${EXPLORER}/tx/${r.tx}`, `${r.tx.slice(0, 10)}…${r.tx.slice(-4)}`));
    p.appendChild(document.createTextNode('.'));
  } else if (s.status === 'Refuted') {
    p.appendChild(el('b', undefined, 'Exception. '));
    p.appendChild(document.createTextNode('An omitted in-scope event was proven and the bond slashed.'));
  } else if (s.status === 'Finalized') {
    p.appendChild(el('b', undefined, 'Agreed. '));
    p.appendChild(
      document.createTextNode('The claim survived its challenge window in public and the bond went home.'),
    );
  } else if (s.status === 'Sealed') {
    p.appendChild(el('b', undefined, 'In window. '));
    p.appendChild(document.createTextNode('Sealed and challengeable; anyone may still break it.'));
  } else {
    p.appendChild(document.createTextNode(`Status: ${s.status}.`));
  }
  return p;
}

async function renderSchedule(abis: Abis, which: DeploymentName, id: number): Promise<void> {
  const box = $(`schedule-${which}-${id}`);
  try {
    const s = await readSchedule(abis, which, id);
    const chain = CHAIN_NAME[requireChainKey(s.chainKey)];
    const ex = SOURCE_EXPLORER[requireChainKey(s.chainKey)];

    const header = el('header');
    const h = el('h3');
    h.textContent = `Claim ${s.id} — ${chain}, ${s.members} member(s) over ${(s.toBlock - s.fromBlock + 1).toLocaleString()} blocks`;
    header.appendChild(h);
    header.appendChild(el('span', 'ref', `W/P ${which === 'mainnet' ? 'M' : 'S'}-${s.id}`));
    const scope = el('span', 'gloss');
    scope.appendChild(document.createTextNode('scope · emitter '));
    scope.appendChild(out(`${ex}/address/${s.emitter}`, shortAddress(s.emitter)));
    scope.appendChild(document.createTextNode(` · claimant `));
    scope.appendChild(out(`${EXPLORER}/address/${s.claimant}`, shortAddress(s.claimant)));
    scope.appendChild(document.createTextNode(` · bond ${formatEther(s.bondPosted)} CTC · ${s.status}`));
    header.appendChild(scope);

    const open = el('a', 'act', 'Open in the console') as HTMLAnchorElement;
    open.href = `app/?deployment=${which}&claim=${s.id}`;
    open.dataset.testid = `open-${which}-${s.id}`;
    const foot = el('p', 'finding');
    foot.appendChild(open);

    box.replaceChildren(header, strip(s), el('div', 'body'), finding(s), foot);
    box.querySelector('.body')!.appendChild(members(s));
  } catch (e) {
    box.replaceChildren(el('p', 'pending bad', `Creditcoin did not answer for claim ${id}: ${(e as Error).message}`));
  }
}

export async function landing(): Promise<void> {
  // The MCP install line, copied. Clipboard access is a user gesture away and nothing else.
  const copy = document.getElementById('copy-mcp') as HTMLButtonElement | null;
  if (copy) {
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(copy.dataset.copy ?? '');
        copy.textContent = 'copied';
      } catch {
        copy.textContent = 'select it';
      }
      setTimeout(() => (copy.textContent = 'copy'), 1600);
    };
  }

  const chips = async () => {
    const block = await within(30_000, 'reading the head', cc3.getBlockNumber());
    $('live-block').textContent = block.toLocaleString();
    $('live-chain').textContent = String((await cc3.getNetwork()).chainId);
  };

  let abis: Abis;
  try {
    [abis] = await Promise.all([loadAbis(), chips()]);
  } catch (e) {
    $('live-block').textContent = '—';
    $('live-chain').textContent = '—';
    $('boot-error').textContent = `Creditcoin is not answering from this browser — ${(e as Error).message}.`;
    document.body.dataset.state = 'failed';
    return;
  }

  // The tally walks every claim on two registries; the schedules should not wait on it.
  void (async () => {
    const strip = $('tally');
    try {
      const t = await readTally(abis);
      $('t-proven').textContent = t.proven.toLocaleString();
      $('t-claims').textContent = t.sealed.toLocaleString();
      $('t-refuted').textContent = t.refuted.toLocaleString();
      $('t-burned').textContent = `${formatEther(t.burned)} CTC`;
      const box = $('invitation');
      if (t.openNow) {
        const hours = (t.openNow.blocksLeft * 15) / 3600;
        const left = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${Math.max(1, Math.round(hours))} hours`;
        const a = el('a', 'act', `Sweep claim ${t.openNow.id} yourself`) as HTMLAnchorElement;
        a.href = `app/?deployment=${t.openNow.which}&claim=${t.openNow.id}`;
        a.dataset.testid = 'invitation-link';
        box.replaceChildren(
          a,
          el(
            'span',
            'note',
            `It is sealed, with ${left} left on its window. No wallet is needed to look; one is needed only to send the refutation.`,
          ),
        );
      } else {
        box.replaceChildren(
          el('span', 'note', 'No claim is inside its challenge window right now — every one has settled.'),
        );
      }
      strip.dataset.ready = 'true';
    } catch (e) {
      for (const id of ['t-proven', 't-claims', 't-refuted', 't-burned']) $(id).textContent = '—';
      strip.dataset.ready = 'failed';
      strip.title = (e as Error).message;
    }
  })();

  await Promise.all([renderSchedule(abis, 'sepolia', 5), renderSchedule(abis, 'mainnet', 20)]);
  document.body.dataset.state = 'ready';
}
