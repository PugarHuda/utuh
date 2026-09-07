import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { Wallet } from 'ethers';
import { injectWallet } from './wallet';

/// The console from the angles nobody demos: in the dark, on a phone, without a mouse, with a
/// wallet whose owner says no, and with the chain unreachable.
///
/// None of these stub the product. The dark theme is the browser's own preference; the phone is a
/// viewport; the keyboard is the keyboard; the refusing wallet is a real EIP-1193 provider whose
/// owner presses "Reject"; the outage is the CC3 RPC being unreachable from this browser, which is
/// a thing that happens to public endpoints on ordinary afternoons.

test('in dark mode, still no WCAG A/AA violations — contrast included', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  // The palette actually switched, or this checks nothing.
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).not.toBe('rgb(251, 252, 253)');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const named = results.violations.map((v) => `${v.id}: ${v.help}`);
  expect(named, named.join('\n')).toEqual([]);
});

test('on a phone: nothing sideways, everything reachable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(client);

  // The wide tables scroll inside their own box rather than being cut off.
  const table = page.locator('[data-testid=claims-table]');
  if ((await table.count()) > 0) {
    const inner = await table.evaluate((t) => {
      const box = t.parentElement as HTMLElement;
      return { canScroll: box.scrollWidth > box.clientWidth, overflow: getComputedStyle(box).overflowX };
    });
    expect(inner.overflow).toBe('auto');
  }

  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('[data-testid=sweep]')).toBeVisible();
});

test('the sweep can be started from the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  test.skip((await page.locator('[data-testid=claim-select] option').count()) === 0, 'no claims to sweep');

  // The first Tab lands on the skip link — seventy-odd links sit between the top of the page and
  // the sweep button, and nobody should have to tab through them — and Enter puts focus on the
  // button itself, not after it. Then Enter again.
  await page.locator('body').press('Tab');
  const focused = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent ?? '');
  expect(focused).toContain('Skip to the watcher');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.testid)).toBe('sweep');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-testid=log]')).toContainText('sweeping', { timeout: 30_000 });
});

test('a wallet whose owner says no leaves the page usable and says what happened', async ({ page }) => {
  // Any key will do: it never signs. The wallet answers every send with MetaMask's 4001.
  await injectWallet(page, Wallet.createRandom().privateKey, { rejectSends: true });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await page.locator('#connect').click();
  await expect(page.locator('#connect')).toBeDisabled();

  // "withdraw refunded bonds" is offered to any connected account. This account has nothing to
  // withdraw, so the registry's eth_call refuses before the wallet is even asked — which is the
  // right order, and the message is the contract's own.
  const withdraw = page.locator('[data-testid=withdraw]');
  await expect(withdraw).toBeVisible();
  await withdraw.click();
  // By name — the contract's own — not "unknown custom error". Creditcoin's RPC hides the revert
  // data inside the message text, and the page digs it out and decodes it.
  await expect(page.locator('[data-testid=log]')).toContainText(/failed: NothingToWithdraw\(\)/, {
    timeout: 60_000,
  });
  await expect(withdraw).toBeEnabled();

  // And the borrow pane, which does send: the commitment is refused by the owner, and the page
  // reports the refusal rather than hanging or pretending it went out.
  const send = page.locator('[data-testid=send-commitment]');
  await expect(send).toBeVisible({ timeout: 60_000 });
  await send.click();
  // ethers reports MetaMask's 4001 as "user rejected action"; the page passes that through.
  await expect(page.locator('[data-testid=borrow-log]')).toContainText(/could not send it: .*(rejected|denied)/i, {
    timeout: 60_000,
  });
  await expect(send).toBeEnabled();
});

test('with the primary RPC down, the page reads Creditcoin through Blockscout instead', async ({ page }) => {
  await page.route('**/rpc.cc3-testnet.creditcoin.network/**', (route) => route.abort('connectionrefused'));
  await page.goto('/');

  // Not "fails politely" — works. `ready` is only reached after live reads succeed, and the head
  // block in the banner is one of them, so both came through Blockscout. The claims table is not
  // asserted: the fallback rations bursts by parking them, and a pane of forty sequential reads
  // can honestly take minutes there — degraded is the contract, dead is the bug.
  //
  // Three minutes, not ninety seconds. Measured here: 31s on a good run and 1m0s on a slower one,
  // and it has failed at 1m30s on a CI runner. The fallback parks excess requests for ~12s each
  // and this page's boot is several of them, so a budget close to the median turns a working
  // degraded path into a red build on somebody's dependency bump.
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 180_000 });
  await expect(page.locator('#chain-id')).toHaveText('102031');
  await expect(page.locator('#cc3-block')).toHaveText(/^[1-9]\d*$/);
});

test('with Creditcoin unreachable, the page fails loudly instead of showing stale numbers', async ({ page }) => {
  await page.route('**/rpc.cc3-testnet.creditcoin.network/**', (route) => route.abort('connectionrefused'));
  await page.route('**/creditcoin-testnet.blockscout.com/api/eth-rpc**', (route) => route.abort('connectionrefused'));
  await page.goto('/');

  await expect(page.locator('body')).toHaveAttribute('data-state', /failed|ready/, { timeout: 45_000 });
  // Either the boot itself failed, or the panes did — in both cases something on screen says so,
  // and no pane shows a number it did not just read.
  const state = await page.locator('body').getAttribute('data-state');
  if (state === 'failed') {
    await expect(page.locator('#boot-error')).not.toBeEmpty();
  } else {
    await expect(page.locator('#registry-body .bad, #attestcoin-body .bad, #credit-body .bad').first()).toBeVisible();
  }
  await expect(page.locator('[data-testid=claims-table] tbody tr')).toHaveCount(0);
});

test('an endpoint answering for the wrong chain is refused, and the sweep does not run', async ({ page }) => {
  // The failure this guards against is the quiet one. A source endpoint serving a different chain
  // than the claim's scope names returns no in-scope logs, and no logs is exactly what a claim
  // with nothing left out looks like — so a misconfigured or repointed endpoint would hand a
  // visitor a confident, wrong "complete". Every provider in the page asserts its chain id through
  // ethers' staticNetwork and never asks, which is why the page asks itself before it sweeps.
  //
  // Nothing is stubbed but the answer to one method: every source-chain endpoint still serves its
  // logs, and only `eth_chainId` lies. That is the shape of the real accident.
  await page.route(
    (url) => !url.host.includes('creditcoin') && url.protocol.startsWith('http'),
    async (route) => {
      const body = route.request().postData() ?? '';
      if (!body.includes('eth_chainId')) return route.fallback();
      const id = JSON.parse(body).id;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id, result: '0x7a69' }),
      });
    },
  );

  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  const options = await page.locator('[data-testid=claim-select] option').count();
  test.skip(options === 0, 'no sweepable claim');

  await page.locator('#sweep').click();
  const log = page.locator('#log');
  await expect(log).toContainText(/ENDPOINT REJECTED/, { timeout: 60_000 });
  const text = await log.innerText();
  expect(text, 'the page says which chain it expected').toMatch(
    /serves chain id 31337, not 1|serves chain id 31337, not 11155111/,
  );
  expect(text, 'and refuses to sweep rather than reporting a verdict').toMatch(/serving some chain other than/);
  expect(text, 'no completeness verdict may be reached this way').not.toMatch(/INCOMPLETE|no gap found/);
});

test('the range the borrow pane offers ends on a settled attestation, not near one', async ({ page }) => {
  // `defaultRange` used to end a claim two blocks under the attestation frontier, which was a guess
  // at how far the edge moves while a claim is being built. It now asks the ChainInfo precompile
  // for the newest attestation strictly *before* the frontier — a finished one, which is what the
  // proof builder needs before it will serve proofs over the range.
  //
  // The whole underwriting flow behind this pane takes forty minutes and real money
  // (`borrow.live.spec.ts`). This is the first ten seconds of it: connect a wallet that never
  // signs, and read the range the page proposes. Attestations land every ten source blocks, so a
  // range that ends on a real attestation point ends on a multiple of ten — which is a fact about
  // the chain, checked against the chain, not a number this test knows.
  await injectWallet(page, Wallet.createRandom().privateKey, { rejectSends: true });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await page.locator('#connect').click();

  const pane = page.locator('#borrow-body');
  const from = pane.locator('[data-testid=range-from]');
  await expect(from).toBeVisible({ timeout: 90_000 });
  const fromBlock = Number(await from.inputValue());
  const toBlock = Number(await pane.locator('[data-testid=range-to]').inputValue());

  expect(Number.isFinite(fromBlock) && fromBlock > 0, `from block: ${fromBlock}`).toBe(true);
  expect(toBlock, 'the range runs forwards').toBeGreaterThan(fromBlock);
  expect(toBlock % 10, `to block ${toBlock} is an attestation point`).toBe(0);

  // And it is behind the frontier, which is what makes it settled rather than in flight.
  const res = await page.request.post('https://rpc.cc3-testnet.creditcoin.network', {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [
        {
          to: '0x0000000000000000000000000000000000000fD3',
          // get_latest_attestation_height_and_hash(uint64) for Sepolia, chain key 1
          data: '0x809112da' + '0000000000000000000000000000000000000000000000000000000000000001',
        },
        'latest',
      ],
    },
  });
  const hex = (await res.json()).result as string | undefined;
  if (hex && hex.length >= 66) {
    const frontier = Number(BigInt('0x' + hex.slice(2, 66)));
    expect(toBlock, `the range ends behind the attestation frontier ${frontier}`).toBeLessThan(frontier);
  }
});
