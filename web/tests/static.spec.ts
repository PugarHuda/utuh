import { expect, test } from '@playwright/test';

/// The statically-built console, which is the one that gets published.
///
/// `npm run web` has a server behind it, and a server is a thing that can quietly become load
/// bearing — serving an ABI, answering for a deployment, caching a claim. The published build has
/// no server at all, so these tests assert the absence: the page boots, reads the live chain, and
/// never asks its host for anything but the three files it was given.

test('boots with no server behind it', async ({ page }) => {
  const asked: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.host === '127.0.0.1:5173' || url.host === 'localhost:5173') asked.push(url.pathname);
  });

  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/static/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  // Live chain, same as the served build.
  await expect(page.locator('#chain-id')).toHaveText('102031');
  expect(Number(await page.locator('#cc3-block').innerText())).toBeGreaterThan(1_000_000);
  await expect(page.locator('[data-testid=attestcoin-table]')).toContainText('Ethereum');

  // And nothing was asked of the host beyond the three files a static host serves.
  expect(asked.sort()).toEqual(['/static/', '/static/main.js', '/static/style.css']);
  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('never scrolls the page sideways, whatever the tables hold', async ({ page }) => {
  // The claims table has ten columns and no wrapping. It has to scroll inside its own box; if it
  // scrolls the window instead, every phone and half the laptops get a page that slides.
  await page.setViewportSize({ width: 900, height: 800 });
  await page.goto('/static/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
});

test('carries the same deployment the served build does', async ({ page }) => {
  const record = await (await page.request.get('/deployments.json')).json();

  await page.goto('/static/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  const table = page.locator('[data-testid=addresses-table]');
  const registryLink = table.locator('a', { hasText: new RegExp(record.registry.slice(0, 6), 'i') }).first();
  await expect(registryLink).toHaveAttribute('title', record.registry);
});

test('offers borrowing, and says what it needs first', async ({ page }) => {
  await page.goto('/static/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  // No wallet in this browser, so the pane explains rather than pretending.
  await expect(page.locator('#borrow-body')).toContainText(/connect a wallet/i);
  await expect(page.locator('[data-testid=build-volume]')).toHaveCount(0);
});
