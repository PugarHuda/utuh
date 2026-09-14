import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/// The landing page: the thesis, two real claims read from the chain, and every link a judge or
/// the README hands out. Nothing on it is written down, so the tests read the same chain.

const ready = async (page: import('@playwright/test').Page, url = '/') => {
  await page.goto(url);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
};

test('reads both claims live, with the omitted event printed as a row', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await ready(page);

  await expect(page.locator('#live-chain')).toHaveText('102031');
  expect(Number((await page.locator('#live-block').innerText()).replace(/\D/g, ''))).toBeGreaterThan(1_000_000);

  // Claim 5: three members ticked and one exception, in block order.
  const five = page.locator('[data-testid=schedule-members-sepolia-5] tbody tr');
  await expect(five).toHaveCount(4);
  await expect(five.last()).toHaveClass(/struck/);
  await expect(page.locator('[data-testid=schedule-sepolia-5] [data-testid=finding]')).toContainText(/Exception/);
  await expect(page.locator('[data-testid=schedule-sepolia-5] [data-testid=finding]')).toContainText(
    /paid to the refuter/,
  );

  // Claim 20: no members, one exception — the false "never liquidated" claim.
  const twenty = page.locator('[data-testid=schedule-members-mainnet-20] tbody tr');
  await expect(twenty).toHaveCount(1);
  await expect(twenty.first()).toHaveClass(/struck/);
  await expect(page.locator('[data-testid=schedule-mainnet-20] h3')).toContainText(/0 member/);

  // The strips are drawn from the same data.
  expect(await page.locator('[data-testid=schedule-sepolia-5] svg.strip line.member').count()).toBe(3);
  expect(await page.locator('[data-testid=schedule-sepolia-5] svg.strip circle.omitted').count()).toBe(1);

  // Links into the console carry the deployment and the claim.
  await expect(page.locator('[data-testid=open-sepolia-5]')).toHaveAttribute(
    'href',
    'app/?deployment=sepolia&claim=5',
  );
  await expect(page.locator('[data-testid=open-mainnet-20]')).toHaveAttribute(
    'href',
    'app/?deployment=mainnet&claim=20',
  );
  expect(errors, errors.join('\n')).toEqual([]);
});

test('foots the totals across both registries', async ({ page }) => {
  await ready(page);
  await expect(page.locator('[data-testid=tally]')).toHaveAttribute('data-ready', 'true', { timeout: 150_000 });
  const num = async (id: string) => Number((await page.locator(`#${id}`).textContent())?.replace(/[^\d.]/g, ''));
  expect(await num('t-claims')).toBeGreaterThan(10);
  expect(await num('t-refuted')).toBeGreaterThan(1);
  expect(await num('t-burned')).toBeGreaterThan(0);
});

test('a root link that names a claim goes straight into the console, params intact', async ({ page }) => {
  await page.goto('/?claim=5');
  await page.waitForURL((u) => u.pathname.endsWith('/app/') && u.searchParams.get('claim') === '5');
  await expect(page.locator('#claim-select')).toHaveValue('5', { timeout: 90_000 });

  await page.goto('/?deployment=mainnet&claim=20');
  await page.waitForURL((u) => u.pathname.endsWith('/app/') && u.searchParams.get('deployment') === 'mainnet');
  await expect(page.locator('#claim-select')).toHaveValue('20', { timeout: 90_000 });
  await expect(page.locator('[data-testid=claim-standing]')).toContainText(/Refuted by one proof/, {
    timeout: 60_000,
  });
});

test('a deep-linked claim states its standing in words, above the fold or scrolled to', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await ready(page, '/app/?claim=5');
  const standing = page.locator('[data-testid=claim-standing]');
  await expect(standing).toContainText(/Refuted by one proof of an in-scope event at source block \d+/, {
    timeout: 60_000,
  });
  await expect(standing).toContainText(/paid to/);
  const top = await standing.evaluate((e) => e.getBoundingClientRect().top);
  expect(top, 'the standing is on screen on arrival').toBeLessThan(720);
  expect(top).toBeGreaterThan(0);
});

test('every document and evidence link is present', async ({ page }) => {
  await ready(page);
  for (const href of [
    'app/',
    'whitepaper.pdf',
    'deck.pdf',
    'https://github.com/PugarHuda/utuh',
    'https://www.npmjs.com/package/utuh-mcp',
    'https://dashboard.cc3-testnet.creditcoin.network/transaction-verifications',
    'llms.txt',
  ]) {
    expect(await page.locator(`a[href="${href}"]`).count(), href).toBeGreaterThan(0);
  }
  await expect(page.locator('#copy-mcp')).toHaveAttribute('data-copy', 'npx -y utuh-mcp');
  // Four verified contracts, each linked to its Sourcify full match (and to Blockscout beside it).
  await expect(page.locator('#check a[href^="https://repo.sourcify.dev/102031/0x"]')).toHaveCount(4);
});

test('has no WCAG A/AA violations, one h1, and no sideways scroll at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal scroll on a phone').toBeLessThanOrEqual(1);
  expect(await page.locator('h1').count()).toBe(1);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const named = results.violations.map(
    (v) => `${v.id}: ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
  );
  expect(named, named.join('\n')).toEqual([]);
});

test('the static build of the landing asks its host for nothing but its files', async ({ page }) => {
  test.skip(!!process.env.PUBLISHED_URL, 'the /static/ mirror exists only on the local server');
  const asked: string[] = [];
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') asked.push(url.pathname);
  });
  await ready(page, '/static/');
  expect(asked.sort()).toEqual(['/static/', '/static/fonts/archivo.woff2', '/static/main.js', '/static/style.css']);
});

test('the "Check it yourself" block: every link answers, every address is a deployed one, every row is read', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await ready(page);
  const block = page.locator('#check');
  await expect(page.locator('a[href="#check"]')).toHaveCount(1);

  // The rows the page fills from reads it already makes.
  await expect(block.locator('[data-testid=check-refutation-sepolia-5] a[href*="/tx/0x"]')).toHaveCount(1);
  await expect(block.locator('[data-testid=check-refutation-mainnet-20] a[href*="/tx/0x"]')).toHaveCount(1);
  await expect(page.locator('[data-testid=tally]')).toHaveAttribute('data-ready', 'true', { timeout: 170_000 });
  await expect(block.locator('[data-testid=check-tally]')).toHaveText(
    /^\d[\d,]* of \d[\d,]* claims refuted, (sent from \d+ distinct address(es)?|with the refuting addresses not all readable right now)$/,
  );

  // Every contract linked is one of the four the deployment records name, each on Blockscout and on
  // Sourcify, and nothing else.
  const root = join(__dirname, '..', '..');
  const records = ['deployments.full.json', 'deployments.json'].map(
    (f) => JSON.parse(readFileSync(join(root, f), 'utf8')) as { registry: string; credit: string },
  );
  const deployed = records
    .flatMap((r) => [r.registry, r.credit])
    .map((a) => a.toLowerCase())
    .sort();
  const hrefs = await block.locator('a[href]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  const on = (prefix: string) =>
    hrefs
      .filter((h) => h.startsWith(prefix))
      .map((h) => h.slice(prefix.length).toLowerCase())
      .sort();
  expect(on('https://creditcoin-testnet.blockscout.com/address/'), 'Blockscout addresses').toEqual(
    expect.arrayContaining(deployed),
  );
  expect(on('https://repo.sourcify.dev/102031/'), 'Sourcify addresses').toEqual(deployed);

  // And every link answers. HEAD, because Sourcify's page streams a megabyte and once took more than
  // thirty seconds to finish sending a 200; a host that refuses HEAD is asked with GET. Explorers
  // rate-limit a burst, so one at a time, and a 429 is asked again.
  for (const href of [...new Set(hrefs)]) {
    let status = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      status = (await page.request.fetch(href, { method: 'HEAD', timeout: 60_000, maxRedirects: 5 })).status();
      if (status === 405) status = (await page.request.get(href, { timeout: 60_000, maxRedirects: 5 })).status();
      if (status !== 429) break;
      await page.waitForTimeout(5_000 * (attempt + 1));
    }
    expect(status, href).toBeLessThan(400);
  }
});

test('the "Check it yourself" block fits 320px and passes the same audit', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await ready(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no sideways scroll at 320px').toBeLessThanOrEqual(1);
  const results = await new AxeBuilder({ page })
    .include('#check')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
