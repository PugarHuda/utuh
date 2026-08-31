import { expect, test } from '@playwright/test';

/// The console people actually open.
///
/// Every other suite drives a local server. This one drives whatever `PUBLISHED_URL` names — the
/// GitHub Pages build — and asks the questions a person arriving there would: does it load, does it
/// say which chain it is on, are the numbers this hour's, do both deployments read, is any pane
/// broken. The watch workflow runs it hourly, because Pages can serve a stale or broken build with
/// nothing in CI noticing, and a console that lies quietly is worse than one that is down.
///
///   PUBLISHED_URL=https://utuh.vercel.app/ npx playwright test published

const PUBLISHED = process.env.PUBLISHED_URL;
test.skip(!PUBLISHED, 'set PUBLISHED_URL to the console to smoke');

test('loads, reads the live chain, and is not stale', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('./');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await expect(page.locator('#chain-id')).toHaveText('102031');

  // This hour's block, not a baked one: within a few minutes of what the RPC says right now.
  const shown = Number(await page.locator('#cc3-block').innerText());
  const res = await page.request.post('https://rpc.cc3-testnet.creditcoin.network', {
    data: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
  });
  const head = Number((await res.json()).result);
  expect(Math.abs(head - shown)).toBeLessThan(40);

  await expect(page.locator('[data-testid=attestcoin-table]')).toContainText('Ethereum');
  await expect(page.locator('[data-testid=claims-table] tbody tr').first()).toBeVisible();
  await expect(page.locator('[data-testid=policy-table]')).toContainText('loan-to-value');
  await expect(page.locator('#attestcoin-body .bad, #registry-body .bad, #credit-body .bad')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});

test('the mainnet-sourced deployment reads from the published build too', async ({ page }) => {
  await page.goto('./?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await expect(page.locator('[data-testid=deployment]')).toHaveValue('mainnet');
  const chains = await page.locator('[data-testid=claims-table] tbody tr td:nth-child(5)').allInnerTexts();
  expect(chains.length).toBeGreaterThan(0);
  for (const c of chains) expect(c).toBe('Ethereum mainnet');
  await expect(page.locator('[data-testid=policy-table]')).toContainText('loan-to-value');
  await expect(page.locator('#attestcoin-body .bad, #registry-body .bad, #credit-body .bad')).toHaveCount(0);
});

test('the link preview is a real photograph of the page, and it is served', async ({ page }) => {
  await page.goto('./');
  const image = await page.locator('meta[property="og:image"]').getAttribute('content');
  // Absolute, and to the canonical host on purpose: a crawler that finds the mirror still has to
  // resolve one picture, and pointing it at PUBLISHED would make the mirror advertise its own.
  expect(image).toBe('https://utuh.vercel.app/og.png');
  const res = await page.request.get(image!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/png');
  expect((await res.body()).length).toBeGreaterThan(50_000);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
});

test('the whitepaper is served as a PDF, and it is the document', async ({ page }) => {
  // The submission form asks for a deck or whitepaper. This is the address given for it, so a
  // published build that forgot the file is a broken deliverable rather than a cosmetic miss.
  const res = await page.request.get(new URL('whitepaper.pdf', PUBLISHED!).toString());
  expect(res.status()).toBe(200);
  const body = await res.body();
  expect(body.subarray(0, 5).toString()).toBe('%PDF-');
  expect(body.length).toBeGreaterThan(40_000);
});

test('asks its host for nothing but its own four files', async ({ page }) => {
  const host = new URL(PUBLISHED!).host;
  const asked: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.host === host) asked.push(u.pathname.split('/').pop() || 'index.html');
  });
  await page.goto('./');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  expect([...new Set(asked)].sort()).toEqual(['archivo.woff2', 'index.html', 'main.js', 'style.css']);
});
