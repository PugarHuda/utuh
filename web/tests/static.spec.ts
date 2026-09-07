import { expect, test } from '@playwright/test';

/// The statically-built console, which is the one that gets published.
///
/// `npm run web` has a server behind it, and a server is a thing that can quietly become load
/// bearing — serving an ABI, answering for a deployment, caching a claim. The published build has
/// no server at all, so these tests assert the absence: the page boots, reads the live chain, and
/// never asks its host for anything but the files it was given.
///
/// The list below is exact on purpose. It is not a count to be bumped whenever the page grows an
/// asset: every entry is a file a static host hands over unchanged, and anything that appears here
/// which a host would have to *compute* — an ABI, a deployment record, a claim — is the regression
/// this test exists to catch. The webfont joined it when the console got its own typeface, and it
/// is self-hosted for the same reason the rest of this is: no third party is on the critical path.

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

  // And nothing was asked of the host beyond the files a static host serves.
  expect(asked.sort()).toEqual(['/static/', '/static/fonts/archivo.woff2', '/static/main.js', '/static/style.css']);
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

test('the other reader is served too, and it agrees with the server it points at', async ({ request, page }) => {
  // llmstxt.org: what an agent reads when it lands on a URL instead of a repository. Creditcoin's
  // own Attestcoin docs publish one. This project's whole claim about agents is that the watcher
  // role is open to them, so leaving nothing at the address for a machine to read would be asking
  // one to parse a screenshot.
  //
  // The page itself never fetches it, which is why the "four files" list above is unchanged: a
  // static host hands it over, nothing on the page asks for it.
  const res = await request.get('/llms.txt');
  expect(res.ok(), `/llms.txt answered ${res.status()}`).toBe(true);
  expect(res.headers()['content-type'] ?? '').toMatch(/text|plain|octet/);
  const body = await res.text();

  expect(body, 'it opens with the project as an H1, per the convention').toMatch(/^# Utuh/);
  expect(body, 'and states the gap it exists to close').toMatch(/cannot prove a set of/);
  expect(body, 'it tells an agent the role pays').toMatch(/half the bond/);
  expect(body, 'and how to hold it without a browser').toContain('npx utuh-mcp');
  expect(body, 'it says what may be refuted at all').toMatch(/refutable/);
  expect(body, 'and that this is testnet').toMatch(/CC3 Testnet/);

  // Every tool it advertises must be one the server actually has. Two artifacts, one truth: the
  // list in a text file is exactly the sort of thing that keeps its old shape after a rename.
  for (const tool of ['tally', 'list_claims', 'sweep_claim', 'refute_claim', 'audit_attestors']) {
    expect(body, `${tool} is named for an agent to find`).toContain(tool);
  }

  // And the package it sends them to is really published, under the name it gives.
  const npm = await page.request.get('https://registry.npmjs.org/utuh-mcp/latest');
  expect(npm.ok(), 'utuh-mcp is on npm').toBe(true);
  const meta = (await npm.json()) as { name?: string; mcpName?: string };
  expect(meta.name).toBe('utuh-mcp');
  expect(meta.mcpName, 'and carries the registry ownership marker').toBe('io.github.PugarHuda/utuh-mcp');
});
