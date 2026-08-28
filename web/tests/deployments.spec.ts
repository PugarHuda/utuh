import { expect, test } from '@playwright/test';

/// The mainnet-sourced deployment, and what a claim looks like when you open it up.
///
/// The Sepolia deployment is the one a browser can borrow on; the mainnet one is where the claims
/// about real Aave borrowers live — dozens of them, built by the daily live suite and the mainnet
/// demo — and until now the console could not show it. These read that registry, page through it,
/// open a claim to its members, and sweep one of them from the browser against Ethereum mainnet.

test('switches to the mainnet-sourced deployment and reads the right registry', async ({ page }) => {
  await page.goto('/?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  await expect(page.locator('[data-testid=deployment]')).toHaveValue('mainnet');

  const record = await (await page.request.get('/deployments/mainnet.json')).json();
  const link = page.locator('[data-testid=addresses-table] a').first();
  await expect(link).toHaveAttribute('title', record.registry);

  // Every claim on this deployment is about Ethereum mainnet, and the table says so.
  const chains = await page.locator('[data-testid=claims-table] tbody tr td:nth-child(5)').allInnerTexts();
  expect(chains.length).toBeGreaterThan(0);
  for (const c of chains) expect(c).toBe('Ethereum mainnet');
});

test('pages through a registry with more claims than fit on one screen', async ({ page }) => {
  await page.goto('/?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  const rows = page.locator('[data-testid=claims-table] tbody tr');
  const first = await rows.count();
  const more = page.locator('[data-testid=more-claims]');
  test.skip((await more.count()) === 0, 'this registry fits on one screen');

  await more.click();
  await expect(rows).not.toHaveCount(first, { timeout: 60_000 });
  expect(await rows.count()).toBeGreaterThan(first);
});

test('switching deployments is a navigation, and the other way back', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await page.locator('[data-testid=deployment]').selectOption('mainnet');
  await page.waitForURL(/deployment=mainnet/);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  await page.locator('[data-testid=deployment]').selectOption('sepolia');
  await page.waitForURL((u) => !u.searchParams.has('deployment'));
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  const record = await (await page.request.get('/deployments/sepolia.json')).json();
  await expect(page.locator('[data-testid=addresses-table] a').first()).toHaveAttribute('title', record.registry);
});

test('opens a claim to its members, each linked to the block it came from', async ({ page }) => {
  await page.goto('/?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  // A claim with members — the option text says how many.
  const options = await page.locator('[data-testid=claim-select] option').all();
  let picked: string | undefined;
  for (const o of options) {
    const text = await o.innerText();
    const m = text.match(/(\d+) member/);
    if (m && Number(m[1]) > 0) {
      picked = (await o.getAttribute('value')) ?? undefined;
      break;
    }
  }
  test.skip(picked === undefined, 'no claim with members on this registry');

  await page.locator('[data-testid=claim-select]').selectOption(picked!);
  const detail = page.locator('[data-testid=claim-detail]');
  await expect(detail).toContainText(`claim ${picked}`, { timeout: 60_000 });
  await expect(detail).toContainText(/member\(s\), aggregate/);

  const members = detail.locator('[data-testid=members-table] tbody tr');
  await expect(members).not.toHaveCount(0, { timeout: 60_000 });

  // Each row: a source block that is a link into the explorer, a transaction index, a log index,
  // and the packed key the registry actually stores — which must decode to the first three.
  const cells = await members.first().locator('td').allInnerTexts();
  const block = BigInt(cells[1]!);
  const tx = BigInt(cells[2]!.replace(/\D/g, ''));
  const log = BigInt(cells[3]!.replace(/\D/g, ''));
  const key = BigInt(cells[4]!);
  expect(key).toBe((block << 96n) | (tx << 32n) | log);

  const href = await members.first().locator('a').getAttribute('href');
  expect(href).toBe(`https://eth.blockscout.com/block/${block}`);

  await expect(detail).toContainText("Creditcoin's oracle dashboard");
});

test('sweeps a mainnet claim from the browser', async ({ page }) => {
  test.setTimeout(10 * 60_000);
  await page.goto('/?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  // The shortest range on screen: mainnet sweeps are real work, and this is a check that they
  // work from a browser at all, not a benchmark.
  const rows = page.locator('[data-testid=claims-table] tbody tr');
  const n = await rows.count();
  let best: { id: string; span: number } | undefined;
  for (let i = 0; i < n; i++) {
    const cells = await rows.nth(i).locator('td').allInnerTexts();
    const m = cells[3]!.match(/(\d+)\.\.(\d+)/);
    if (!m) continue;
    const span = Number(m[2]) - Number(m[1]);
    if (best === undefined || span < best.span) best = { id: cells[0]!, span };
  }
  test.skip(best === undefined, 'no claims');

  await page.locator('[data-testid=claim-select]').selectOption(best!.id);
  await page.locator('[data-testid=sweep]').click();

  const log = page.locator('[data-testid=log]');
  await expect(log).toContainText('on chain key 3', { timeout: 60_000 });
  await expect(log).toContainText('answered:', { timeout: 8 * 60_000 });
  await expect(log).toContainText(/no gap found|INCOMPLETE|inconclusive|settles nothing/, { timeout: 60_000 });
});
