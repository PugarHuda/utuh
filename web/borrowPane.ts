import { BrowserProvider, formatEther, parseEther, type Signer } from 'ethers';
import { CHAIN_NAME, SOURCE_CHAIN_ID, SOURCE_RPC_DEFAULT, requireChainKey } from '../offchain/lib/networks';
import { claimStatus } from '../offchain/lib/status';
import { cc3, type Wired } from './chain';
import {
  bindingFor,
  buildClaim,
  closeLine,
  cureLine,
  defaultRange,
  draw,
  finalize,
  forgetProgress,
  ledgerPayment,
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
  const chainKey = Number((await wired.credit.volumeSpec()).chainKey);
  const controller: string = await wired.credit.controllerOf(subject);
  const bound = controller.toLowerCase() === account.toLowerCase();

  const steps: HTMLElement[] = [];

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

  const volumeId = progress.volumeClaimId ? BigInt(progress.volumeClaimId) : undefined;
  const cleanIds = (progress.cleanClaimIds ?? []).map(BigInt);

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
      if (volumeId) return;
      await guard(say, async () => {
        const scope = await scopeFor(wired.credit, 'volume', subject);
        const built = await buildClaim(
          wired.registry,
          wired.chainInfo,
          signer,
          scope,
          { fromBlock: Number(from.value), toBlock: Number(to.value) },
          { bond: parseEther(bondInput.value), challengeWindow: window },
          say,
        );
        saveProgress(creditAddress, account, { subject, volumeClaimId: String(built.claimId) });
        await ctx.onChange();
      });
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
        if (cleanIds.length >= cleanCount) return;
        await guard(say, async () => {
          // The next class the lender listed. One empty claim per class, in order.
          const scope = await scopeFor(wired.credit, 'clean', subject, cleanIds.length);
          const built = await buildClaim(
            wired.registry,
            wired.chainInfo,
            signer,
            scope,
            { fromBlock: Number(from.value), toBlock: Number(to.value) },
            { bond: parseEther(bondInput.value), challengeWindow: window },
            say,
          );
          saveProgress(creditAddress, account, {
            subject,
            cleanClaimIds: [...cleanIds, String(built.claimId)].map(String),
          });
          await ctx.onChange();
        });
      },
    ),
  );
  claimsBody.push(buildRow);

  const claimsDone = volumeId !== undefined && cleanIds.length >= cleanCount;
  steps.push(step(2, 'Build the two claims', claimsDone, claimsBody));

  // ---------------------------------------------------------------- 3. finalize
  if (claimsDone) {
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
      const lineId = progress.lineId ? BigInt(progress.lineId) : undefined;
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
            `line ${lineId}: limit ${formatEther(line.limit)} CTC, drawn ${formatEther(line.drawn)} CTC`,
          ),
        );
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
                await guard(say, async () => {
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
                });
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

function message(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  return err.shortMessage ?? err.message ?? String(e);
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
