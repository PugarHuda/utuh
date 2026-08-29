import { expect, test } from '@playwright/test';
import { Wallet } from 'ethers';
import { injectWallet } from './wallet';

/// Two wallets, one `window.ethereum`.
///
/// A person with MetaMask and Rabby both installed has whichever loaded last in `window.ethereum`,
/// and a page that reads only that slot connects to a wallet nobody chose. EIP-6963 is what the
/// wallets agreed on instead: each announces itself by name, the page lists them, the person
/// picks. These put two announcing wallets on the page — the test wallet, and a decoy that also
/// grabs the legacy slot, the way a second real wallet would — and check the page asks.

const DECOY = `(() => {
  const provider = {
    request: async () => { throw Object.assign(new Error('the decoy is locked'), { code: -32002 }); },
    on() {},
    removeListener() {},
  };
  window.ethereum = provider;
  const detail = Object.freeze({
    info: { uuid: 'decoy-0000-0000', name: 'Decoy', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'test.decoy' },
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;

test('two wallets announce themselves; the page names both and connects with the one picked', async ({ page }) => {
  await injectWallet(page, Wallet.createRandom().privateKey, { announce: 'Utuh Test Wallet', rejectSends: true });
  await page.addInitScript({ content: DECOY });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  // The legacy slot belongs to the decoy — what the page would have used without asking.
  expect(
    await page.evaluate(
      () => (window as unknown as { ethereum: { isUtuhTestWallet?: boolean } }).ethereum.isUtuhTestWallet,
    ),
  ).toBeUndefined();

  await page.locator('#connect').click();
  const choice = page.locator('[data-testid=wallet-choice] button');
  await expect(choice).toHaveCount(2);
  await expect(choice.nth(0)).toHaveText('Utuh Test Wallet');
  await expect(choice.nth(1)).toHaveText('Decoy');
  await expect(choice.nth(0)).toBeFocused();

  await choice.nth(0).click();
  await expect(page.locator('#connect')).toHaveText(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/i);
  await expect(page.locator('#connect')).toBeDisabled();
  await expect(choice).toHaveCount(0);
});

test('the decoy, picked, fails in its own words and leaves the other wallet one click away', async ({ page }) => {
  await injectWallet(page, Wallet.createRandom().privateKey, { announce: 'Utuh Test Wallet', rejectSends: true });
  await page.addInitScript({ content: DECOY });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  await page.locator('#connect').click();
  await page.locator('[data-testid=wallet-choice] button', { hasText: 'Decoy' }).click();
  await expect(page.locator('[data-testid=log]')).toContainText('connect failed: the decoy is locked');
  await expect(page.locator('#connect')).toBeEnabled();

  await page.locator('#connect').click();
  await page.locator('[data-testid=wallet-choice] button', { hasText: 'Utuh Test Wallet' }).click();
  await expect(page.locator('#connect')).toHaveText(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/i);
});

test('a wallet that only announces itself, and never touches window.ethereum, connects without a menu', async ({
  page,
}) => {
  await injectWallet(page, Wallet.createRandom().privateKey, {
    announce: 'Announcing Only',
    noLegacy: true,
    rejectSends: true,
  });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  expect(await page.evaluate(() => 'ethereum' in window)).toBe(false);

  await expect(page.locator('#connect')).toBeEnabled();
  await page.locator('#connect').click();
  await expect(page.locator('[data-testid=wallet-choice] button')).toHaveCount(0);
  await expect(page.locator('#connect')).toHaveText(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/i);
});
