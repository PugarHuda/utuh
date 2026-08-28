import { BrowserProvider, formatEther, parseEther, type Signer } from 'ethers';
import { CHAIN_NAME, SOURCE_CHAIN_ID, SOURCE_RPC_DEFAULT, requireChainKey } from '../offchain/lib/networks';
import { claimStatus } from '../offchain/lib/status';
import { cc3, type Wired } from './chain';
import {
  bindingFor,
  buildClaim,
  OpenClaimLeft,
  closeLine,
  cureLine,
  defaultRange,
  draw,
  finalize,
  forgetProgress,
  ledgerPayment,
  lineToShow,
  loadProgress,
  obligationOf,
  openLine,
  proveControl,
  repayScopeFor,
  saveProgress,
  scopeFor,
  settleLine,
} from './borrow';
import { lineStatus } from '../offchain/lib/status';
import { sameScope } from '../offchain/lib/specs';
import { explainRevert } from '../offchain/lib/revert';
import type { Interface } from 'ethers';
import type { Scope } from '../offchain/lib/scope';
import { sourceEndpoints } from './chain';

/// The borrow pane: the whole underwriting, step by step, in the page.
///
/// Each step is a button that does one thing and then re-reads the chain, so the pane's state is
/// never the page's opinion — it is what the contracts say. Refreshing mid-flow loses nothing: the
/// claim ids are kept in this browser's storage and everything else is read back.

export interface BorrowContext {
  wired: Wired;
  signer: () => Signer | undefined;
  account: () => string | undefined;
  onChange: () => void | Promise<void>;
}

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function input(id: string, placeholder: string, value = ''): HTMLInputElement {
  const i = document.createElement('input');
  i.id = id;
  i.placeholder = placeholder;
  // A placeholder disappears the moment somebody types, and is not read as a name by assistive
  // technology either. The label is the placeholder's text, kept.
  i.setAttribute('aria-label', placeholder);
  i.value = value;
  i.dataset.testid = id;
  i.spellcheck = false;
  return i;
}

function button(label: string, testid: string, onClick: () => Promise<void> | void): HTMLButtonElement {
  const b = el('button', 'act', label) as HTMLButtonElement;
  b.dataset.testid = testid;
  b.onclick = () => void onClick();
  return b;
}

/// One step: a heading, whatever it needs, and what the chain says about it.
function step(n: number, title: string, done: boolean, body: (HTMLElement | string)[]): HTMLElement {
  const box = el('div', done ? 'step done' : 'step');
  box.appendChild(el('h3', 'step-title', `${done ? '✓' : n}. ${title}`));
  for (const b of body) box.appendChild(typeof b === 'string' ? el('p', 'note', b) : b);
  return box;
}

export async function renderBorrow(ctx: BorrowContext, say: (line: string) => void): Promise<void> {
  const box = document.getElementById('borrow-body');
  if (!box) return;

  const { wired } = ctx;
  known = [wired.registry.interface, wired.credit.interface];
  const account = ctx.account();
  const signer = ctx.signer();
  const creditAddress = wired.deployments.credit!;

  if (!account || !signer) {
    box.replaceChildren(
      el(
        'p',
        'note',
        'Connect a wallet to borrow. Everything below then happens from this page — binding your ' +
          'Ethereum address, building the two claims, and opening the line — against the same ' +
          'contracts the scripts use.',
      ),
    );
    return;
  }

  const progress = loadProgress(creditAddress, account);
  const subject = progress.subject ?? account;

  // What this browser remembered is a convenience; what the chain holds is the truth. A borrower
  // opening the page in a new browser — or the same one after clearing it — has whatever line the
  // contract says they have, and the pane starts from there rather than from a blank step one.
  // Measured before this: a live test with an open line sat forever on a button that was never
  // rendered, because the page only knew about lines it had opened itself.
  // Two different questions. `active` is the line that holds this subject's one slot, and it
  // decides which step the pane is on: while it is set, steps two to four are done and step five
  // is what matters. `latest` is the line to *show* when none is active — the one just settled,
  // or defaulted, or closed — so a borrower who paid off a line does not come back to a blank
  // step one. Confusing the two once made a settled line hide the build buttons for good.
  const active = (await wired.credit.activeLineOf(subject)) as bigint;
  const latest = active !== 0n ? active : await lineToShow(wired.credit, subject);
  const onChain = active;
  const chainKey = Number((await wired.credit.volumeSpec()).chainKey);
  const controller: string = await wired.credit.controllerOf(subject);
  const bound = controller.toLowerCase() === account.toLowerCase();

  const steps: HTMLElement[] = [];

  /// Run one build, remembering a claim it leaves Open so the next press resumes it rather than
  /// opening another and posting another bond. The key is which build, because a volume claim
  /// left open is not a clean claim half done.
  async function building(
    kind: string,
    scopeWanted: () => Promise<Scope>,
    log: (l: string) => void,
    work: (resume?: bigint) => Promise<void>,
  ) {
    // A function declaration: the early return's narrowing does not reach in here.
    const account = ctx.account()!;
    const open = loadProgress(creditAddress, account).openClaims?.[kind];
    let resume: bigint | undefined;
    if (open) {
      const c = await wired.registry.claim(BigInt(open));
      if (Number(c.status) === 1) resume = BigInt(open);
    }
    // What this browser remembered is a convenience. An open claim of this account's, carrying
    // exactly the scope about to be built, is the same claim whether or not it was opened here —
    // and leaving it to open a second one costs a second bond.
    if (resume === undefined) {
      const wanted = await scopeWanted();
      const next = Number(await wired.registry.nextClaimId());
      for (let id = next - 1; id >= Math.max(1, next - 25); id--) {
        const c = await wired.registry.claim(id);
        if (Number(c.status) !== 1 || c.claimant.toLowerCase() !== account.toLowerCase()) continue;
        if (sameScope(c.scope, wanted)) {
          resume = BigInt(id);
          log(`claim ${id} is open with your bond in it and matches — resuming it`);
          break;
        }
      }
    }
    try {
      await work(resume);
      const left = { ...(loadProgress(creditAddress, account).openClaims ?? {}) };
      delete left[kind];
      saveProgress(creditAddress, account, { openClaims: left });
    } catch (e) {
      if (e instanceof OpenClaimLeft) {
        saveProgress(creditAddress, account, {
          openClaims: { ...(loadProgress(creditAddress, account).openClaims ?? {}), [kind]: String(e.claimId) },
        });
      }
      log(`failed: ${message(e)}`);
    }
  }

  // ---------------------------------------------------------------- 1. bind
  const binding = await bindingFor(wired.credit, subject, account);
  const bindBody: (HTMLElement | string)[] = [
    `Reading a history is not the same as owning it. Send one transaction from ${subject} on ` +
      `${CHAIN_NAME[requireChainKey(chainKey)]} whose calldata is the tag below and your Creditcoin ` +
      `account. Nothing but that key can produce it, and the Block Prover reads the sender out of ` +
      `the verified bytes.`,
  ];

  if (bound) {
    bindBody.push(el('p', 'note good', `Bound: controllerOf(${subject}) is this account.`));
  } else {
    const calldata = el('pre', 'calldata', binding.calldata);
    calldata.dataset.testid = 'commitment-calldata';
    bindBody.push(calldata);

    const hash = input('bind-hash', '0x… the transaction hash, once it is mined');
    const row = el('div', 'controls');
    row.appendChild(
      button('send it with this wallet', 'send-commitment', async () => {
        try {
          const sent = await sendOnSourceChain(chainKey, subject, binding.calldata, say);
          hash.value = sent;
        } catch (e) {
          say(`could not send it: ${message(e)}`);
        }
      }),
    );
    row.appendChild(hash);
    row.appendChild(
      button('prove it', 'prove-control', async () => {
        try {
          await proveControl(wired.credit, signer, chainKey, hash.value.trim(), say);
          saveProgress(creditAddress, account, { subject });
          await ctx.onChange();
        } catch (e) {
          say(`binding failed: ${message(e)}`);
        }
      }),
    );
    bindBody.push(row);
    bindBody.push(
      el(
        'p',
        'note',
        'The proof needs the block to be attested on Creditcoin first, which runs a few minutes ' +
          'behind the source chain. If it says the transaction is not there yet, wait and press it ' +
          'again.',
      ),
    );
  }
  steps.push(step(1, 'Bind your address', bound, bindBody));

  // ---------------------------------------------------------------- 2. claims
  const range = await defaultRange(wired.credit, wired.chainInfo, chainKey);
  const bond = formatEther(await wired.registry.MIN_BOND());
  const window = Number(await wired.registry.MIN_CHALLENGE_WINDOW());

  const from = input('range-from', 'from block', String(range.fromBlock));
  const to = input('range-to', 'to block', String(range.toBlock));
  const bondInput = input('bond', 'bond in CTC', bond);
  const minHistory = Number(await wired.credit.MIN_HISTORY_BLOCKS());

  // The lender's floor on how much history an underwriting must cover, checked before a bond is
  // posted rather than after two claims and two windows. `openLine` would say HistoryTooShort;
  // it said it once, ten minutes and two bonds after the range was typed.
  const rangeOk = (): boolean => {
    const span = Number(to.value) - Number(from.value);
    if (span >= minHistory) return true;
    say(
      `that range covers ${span} source blocks and this lender underwrites on at least ${minHistory} — ` +
        `widen it before building, or the line will be refused after both claims are paid for.`,
    );
    return false;
  };

  const volumeId = progress.volumeClaimId ? BigInt(progress.volumeClaimId) : undefined;
  const cleanIds = (progress.cleanClaimIds ?? []).map(BigInt);
  const hasLine = onChain !== 0n;

  const claimsBody: (HTMLElement | string)[] = [
    `Two claims, adversarial in opposite directions. The volume claim is what you have repaid — ` +
      `every member verified by the Block Prover on the way in, so it cannot be inflated. The clean ` +
      `claim asserts the complete set of your liquidations is empty, and carries a bond anyone can ` +
      `take by proving one you left out.`,
  ];

  const rangeRow = el('div', 'controls');
  rangeRow.appendChild(from);
  rangeRow.appendChild(to);
  rangeRow.appendChild(bondInput);
  claimsBody.push(rangeRow);

  const buildRow = el('div', 'controls');
  buildRow.appendChild(
    button(volumeId ? `volume claim ${volumeId} built` : 'build the volume claim', 'build-volume', async () => {
      if (volumeId || !rangeOk()) return;
      await building(
        'volume',
        () => scopeFor(wired.credit, 'volume', subject),
        say,
        async (resume) => {
          const scope = await scopeFor(wired.credit, 'volume', subject);
          const built = await buildClaim(
            wired.registry,
            wired.chainInfo,
            signer,
            scope,
            { fromBlock: Number(from.value), toBlock: Number(to.value) },
            { bond: parseEther(bondInput.value), challengeWindow: window, ...(resume ? { resume } : {}) },
            say,
          );
          saveProgress(creditAddress, account, { subject, volumeClaimId: String(built.claimId) });
          await ctx.onChange();
        },
      );
    }),
  );

  const cleanCount = Number(await wired.credit.cleanSpecCount());
  buildRow.appendChild(
    button(
      cleanIds.length >= cleanCount
        ? `clean claim(s) ${cleanIds.join(', ')} built`
        : `build the clean claim (${cleanIds.length + 1} of ${cleanCount})`,
      'build-clean',
      async () => {
        if (cleanIds.length >= cleanCount || !rangeOk()) return;
        await building(
          'clean',
          () => scopeFor(wired.credit, 'clean', subject, cleanIds.length),
          say,
          async (resume) => {
            // The next class the lender listed. One empty claim per class, in order.
            const scope = await scopeFor(wired.credit, 'clean', subject, cleanIds.length);
            const built = await buildClaim(
              wired.registry,
              wired.chainInfo,
              signer,
              scope,
              { fromBlock: Number(from.value), toBlock: Number(to.value) },
              { bond: parseEther(bondInput.value), challengeWindow: window, ...(resume ? { resume } : {}) },
              say,
            );
            saveProgress(creditAddress, account, {
              subject,
              cleanClaimIds: [...cleanIds, String(built.claimId)].map(String),
            });
            await ctx.onChange();
          },
        );
      },
    ),
  );
  claimsBody.push(buildRow);

  const claimsDone = hasLine || (volumeId !== undefined && cleanIds.length >= cleanCount);
  steps.push(step(2, 'Build the two claims', claimsDone, hasLine ? ['Done — a line is open on them.'] : claimsBody));

  // ---------------------------------------------------------------- 3. finalize
  if (hasLine) {
    steps.push(step(3, 'Wait out the challenge window', true, ['Done.']));
  } else if (claimsDone) {
    const head = await cc3.getBlockNumber();
    const ids = [volumeId!, ...cleanIds];
    const rows: HTMLElement[] = [];
    let allFinal = true;

    for (const id of ids) {
      const c = await wired.registry.claim(id);
      const until = Number(await wired.registry.challengeUntil(id));
      const status = claimStatus(c.status);
      const final = Number(c.status) === 3;
      allFinal = allFinal && final;
      rows.push(
        el(
          'p',
          'note',
          final
            ? `claim ${id}: ${status}`
            : `claim ${id}: ${status}, window closes at CC3 block ${until} (${Math.max(0, until - head)} to go)`,
        ),
      );
    }

    const finalRow = el('div', 'controls');
    finalRow.appendChild(
      button('finalize what is ready', 'finalize-claims', async () => {
        await guard(say, async () => {
          for (const id of ids) {
            const c = await wired.registry.claim(id);
            if (Number(c.status) === 2) await finalize(wired.registry, signer, id, say);
          }
          await ctx.onChange();
        });
      }),
    );

    steps.push(
      step(3, 'Wait out the challenge window', allFinal, [
        'A claim is only worth something once anyone who could break it has had the chance and did ' +
          'not. That is the window, and nothing shortens it.',
        ...rows,
        finalRow,
      ]),
    );

    // -------------------------------------------------------------- 4. line
    if (allFinal) {
      await renderLine(undefined);
    }
  }

  if (hasLine) await renderLine(onChain);
  else if (latest !== undefined && !claimsDone) await renderLine(latest);

  // A function declaration so it can be reached from two places above; the narrowing of `signer`
  // and `account` by the early return does not cross into it, so they are re-read here. Both are
  // set, because this is only ever called after that return.
  async function renderLine(lineId: bigint | undefined): Promise<void> {
    const signer = ctx.signer()!;
    const account = ctx.account()!;
    {
      const lineBody: (HTMLElement | string)[] = [];

      if (lineId === undefined) {
        const row = el('div', 'controls');
        row.appendChild(
          button('open the line', 'open-line', async () => {
            await guard(say, async () => {
              const opened = await openLine(wired.credit, signer, subject, volumeId!, cleanIds, say);
              saveProgress(creditAddress, account, { lineId: String(opened) });
              await ctx.onChange();
            });
          }),
        );
        lineBody.push(row);
      } else {
        const line = await wired.credit.line(lineId);
        lineBody.push(
          el(
            'p',
            'note good',
            `line ${lineId}: ${lineStatus(line.status)}, limit ${formatEther(line.limit)} CTC, drawn ` +
              `${formatEther(line.drawn)} CTC`,
          ),
        );
        // Drawing is for a line that is open. A settled or closed one is shown for what it was.
        if (Number(line.status) === 1) {
          const amount = input('draw-amount', 'CTC to draw', formatEther(line.limit - line.drawn));
          const row = el('div', 'controls');
          row.appendChild(amount);
          row.appendChild(
            button('draw', 'draw', async () => {
              await guard(say, async () => {
                await draw(wired.credit, signer, lineId, amount.value.trim(), say);
                await ctx.onChange();
              });
            }),
          );
          lineBody.push(row);
          lineBody.push(
            `Repayment is proven the same way this was: pay on the source chain, build a claim over ` +
              `that payment, and settle. The line defaults on silence rather than on a proven missed ` +
              `payment — nobody has to establish a negative.`,
          );
        }
      }

      steps.push(step(4, 'Open the line and draw', lineId !== undefined, lineBody));

      // ------------------------------------------------------------ 5. repay, prove it, settle
      if (lineId !== undefined) {
        const o = await obligationOf(wired.credit, lineId);
        const repayBody: (HTMLElement | string)[] = [];
        const done = o.status === 2 || o.status === 4;

        if (o.status === 1 && o.drawn === 0n) {
          repayBody.push(
            'Nothing has been drawn, so there is nothing to repay. The line can be given back — the ' +
              'history it consumed stays consumed, but the slot comes free for a later one.',
          );
          const row = el('div', 'controls');
          row.appendChild(
            button('close the line', 'close-line', async () => {
              await guard(say, async () => {
                await closeLine(wired.credit, signer, lineId, say);
                await ctx.onChange();
              });
            }),
          );
          repayBody.push(row);
        } else if (!done) {
          const head = await cc3.getBlockNumber();
          const overdue = o.dueBlock !== 0 && head > o.dueBlock;
          repayBody.push(
            el(
              'p',
              overdue || o.status === 3 ? 'note bad' : 'note',
              o.status === 3
                ? `line ${lineId} is in default. Proving the repayment late clears it, on exactly the ` +
                    `terms it was owed — nothing is forgiven, and nothing stays held against you once ` +
                    `it is paid.`
                : `owed: ${o.repayRequired} source units (${formatEther(o.repayRequired)} if the asset ` +
                    `is ether), proven by CC3 block ${o.dueBlock}` +
                    (overdue ? ` — which has passed; anyone may now mark this line in default` : ''),
            ),
          );
          repayBody.push(
            `The proof is a finalized claim over the payment: the event ${o.eventSig.slice(0, 10)}… from ` +
              `${o.emitter}, paying ${o.payee}, in a range starting at source block ${o.repayFrom} or ` +
              `later. Same registry, same bond, same window as the underwriting.`,
          );

          // Paying: one click when the lender is paid through the SettlementLedger, because the
          // page knows that contract's shape. A lender paid in USDC is paid in USDC, by the
          // borrower, however they like — the sweep finds the transfer either way.
          const ledger = wired.deployments.ledger;
          if (ledger && ledger.toLowerCase() === o.emitter.toLowerCase()) {
            const payRow = el('div', 'controls');
            payRow.appendChild(
              button(
                `pay ${formatEther(o.repayRequired)} ETH to the lender with this wallet`,
                'pay-ledger',
                async () => {
                  await guard(say, async () => {
                    await sendOnSourceChain(o.chainKey, subject, ledgerPayment(o.payee), say, {
                      to: ledger,
                      valueWei: o.repayRequired,
                      then: 'wait for Creditcoin to attest that block, then build the repayment claim.',
                    });
                  });
                },
              ),
            );
            repayBody.push(payRow);
          }

          const repayId = progress.repayClaimId ? BigInt(progress.repayClaimId) : undefined;
          if (repayId === undefined) {
            // From the first block a repayment may count, to the source chain's head — the sweep
            // covers whatever was paid, and the build waits for the head to be attested.
            const sourceHead = await sourceEndpoints(o.chainKey)[0]!.provider.getBlockNumber();
            const rFrom = input('repay-from', 'from block', String(o.repayFrom));
            const rTo = input('repay-to', 'to block', String(Math.max(o.repayFrom + 1, sourceHead - 2)));
            const rBond = input('repay-bond', 'bond in CTC', formatEther(await wired.registry.MIN_BOND()));
            const rangeRow = el('div', 'controls');
            rangeRow.appendChild(rFrom);
            rangeRow.appendChild(rTo);
            rangeRow.appendChild(rBond);
            repayBody.push(rangeRow);

            const buildRow = el('div', 'controls');
            buildRow.appendChild(
              button('build the repayment claim', 'build-repay', async () => {
                await building(
                  'repay',
                  () => repayScopeFor(wired.credit, subject),
                  say,
                  async (resume) => {
                    const scope = await repayScopeFor(wired.credit, subject);
                    const built = await buildClaim(
                      wired.registry,
                      wired.chainInfo,
                      signer,
                      scope,
                      { fromBlock: Number(rFrom.value), toBlock: Number(rTo.value) },
                      {
                        bond: parseEther(rBond.value),
                        challengeWindow: Number(await wired.registry.MIN_CHALLENGE_WINDOW()),
                        ...(resume ? { resume } : {}),
                      },
                      say,
                    );
                    if (built.aggregate < o.repayRequired) {
                      say(
                        `the claim proves ${built.aggregate} against ${o.repayRequired} owed — it will not ` +
                          `settle. Pay the rest and build another over a later range.`,
                      );
                    }
                    saveProgress(creditAddress, account, { repayClaimId: String(built.claimId) });
                    await ctx.onChange();
                  },
                );
              }),
            );
            repayBody.push(buildRow);
          } else {
            const rc = await wired.registry.claim(repayId);
            const until = Number(await wired.registry.challengeUntil(repayId));
            const final = Number(rc.status) === 3;
            repayBody.push(
              el(
                'p',
                'note',
                `repayment claim ${repayId}: ${claimStatus(rc.status)}, proves ${rc.aggregate} of ` +
                  `${o.repayRequired}` +
                  (final ? '' : `, window closes at CC3 block ${until} (${Math.max(0, until - head)} to go)`),
              ),
            );
            const row = el('div', 'controls');
            if (!final) {
              row.appendChild(
                button('finalize it', 'finalize-repay', async () => {
                  await guard(say, async () => {
                    await finalize(wired.registry, signer, repayId, say);
                    await ctx.onChange();
                  });
                }),
              );
            } else {
              row.appendChild(
                button(o.status === 3 ? 'cure the default' : 'settle the line', 'settle-line', async () => {
                  await guard(say, async () => {
                    if (o.status === 3) await cureLine(wired.credit, signer, lineId, repayId, say);
                    else await settleLine(wired.credit, signer, lineId, repayId, say);
                    await ctx.onChange();
                  });
                }),
              );
            }
            repayBody.push(row);
          }
        } else {
          repayBody.push(el('p', 'note good', `line ${lineId} is ${lineStatus(o.status)}.`));
        }

        steps.push(step(5, 'Repay, prove it, settle', done, repayBody));
      }
    }
  }

  const reset = button('start over', 'reset-borrow', () => {
    forgetProgress(creditAddress, account);
    void ctx.onChange();
  });
  reset.title = 'Forgets the claim ids this browser remembered. The claims themselves stay on chain.';

  box.replaceChildren(...steps, reset);
}

async function guard(say: (line: string) => void, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (e) {
    say(`failed: ${message(e)}`);
  }
}

/// The interfaces a revert might have come from, set once the contracts are wired.
let known: Interface[] = [];

function message(e: unknown): string {
  return explainRevert(e, known);
}

/// Send the control commitment on the source chain, with the wallet the visitor already has.
///
/// The commitment has to come from the subject's own key, so this only works when the connected
/// account *is* the subject — which is the ordinary case, and the only case where a wallet can help.
/// It switches the wallet to the source chain, sends, and switches back, because a page that leaves
/// somebody's wallet pointed at the wrong network has broken something for them.
async function sendOnSourceChain(
  chainKey: number,
  subject: string,
  calldata: string,
  say: (line: string) => void,
  target: { to: string; valueWei: bigint; then: string } = {
    to: subject,
    valueWei: 0n,
    then: 'wait for Creditcoin to attest that block, then press "prove it".',
  },
): Promise<string> {
  if (!window.ethereum) throw new Error('no wallet');
  const key = requireChainKey(chainKey);
  const wanted = '0x' + SOURCE_CHAIN_ID[key].toString(16);
  const provider = new BrowserProvider(window.ethereum, 'any');

  const from = (await provider.send('eth_accounts', []))[0] as string;
  if (from.toLowerCase() !== subject.toLowerCase()) {
    throw new Error(
      `this wallet is ${from}, and the transaction has to come from ${subject}. Switch accounts, or ` +
        `send it yourself.`,
    );
  }

  const was = (await provider.send('eth_chainId', [])) as string;
  say(`switching the wallet to ${CHAIN_NAME[key]}…`);
  try {
    await provider.send('wallet_switchEthereumChain', [{ chainId: wanted }]);
  } catch {
    await provider.send('wallet_addEthereumChain', [
      {
        chainId: wanted,
        chainName: CHAIN_NAME[key],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [SOURCE_RPC_DEFAULT[key]],
      },
    ]);
  }

  try {
    const hash = (await provider.send('eth_sendTransaction', [
      { from, to: target.to, value: '0x' + target.valueWei.toString(16), data: calldata },
    ])) as string;
    say(`sent on ${CHAIN_NAME[key]}: ${hash}`);
    say(target.then);
    return hash;
  } finally {
    if (was !== wanted) {
      await provider.send('wallet_switchEthereumChain', [{ chainId: was }]).catch(() => {});
    }
  }
}
