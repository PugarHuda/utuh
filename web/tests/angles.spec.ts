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

test('with Creditcoin unreachable, the page fails loudly instead of showing stale numbers', async ({ page }) => {
  await page.route('**/rpc.cc3-testnet.creditcoin.network/**', (route) => route.abort('connectionrefused'));
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
