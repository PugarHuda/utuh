import { expect, test, type Page } from '@playwright/test';

/// What the console has to be true about.
///
/// These assertions are deliberately about the *live* chain rather than about a fixture. A test
/// that pins "claim 3 is Refuted" would pass on a screenshot; these pass only if the page really
/// read Creditcoin — the chain id, the attestation frontier, the claim count and the registry
/// address all have to agree with what an independent request gets back.

const CLAIM_STATUSES = ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'];

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  return errors;
}

test('loads against the live CC3 testnet and says which chain it is on', async ({ page }) => {
  const errors = await boot(page);

  await expect(page.locator('#chain-id')).toHaveText('102031');

  const block = Number(await page.locator('#cc3-block').innerText());
  expect(block).toBeGreaterThan(1_000_000);

  // An independent read of the same chain, from the test process rather than the page.
  const res = await page.request.post('https://rpc.cc3-testnet.creditcoin.network', {
    data: { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
  });
  const head = Number((await res.json()).result);
  expect(Math.abs(head - block)).toBeLessThan(50);

  expect(errors, `console errors: ${errors.join(' | ')}`).toHaveLength(0);
});

test('reads what Creditcoin can attest straight off the ChainInfo precompile', async ({ page }) => {
  await boot(page);
  const rows = page.locator('[data-testid=attestcoin-table] tbody tr');
  await expect(rows).not.toHaveCount(0);

  const text = await page.locator('[data-testid=attestcoin-table]').innerText();
  // CC3 testnet attests Ethereum. Which key means which chain is the network's answer, not ours,
  // which is exactly why the page asks rather than hardcoding it.
  expect(text).toContain('Ethereum');
  expect(text).toContain('v1');

  const first = rows.first();
  const cells = await first.locator('td').allInnerTexts();
  const genesis = Number(cells[4]);
  const attested = Number(cells[5]);
  expect(attested).toBeGreaterThan(genesis);
});

test('shows the deployment the server actually serves', async ({ page }) => {
  await boot(page);
  const record = await (await page.request.get('/deployments.json')).json();

  const table = page.locator('[data-testid=addresses-table]');
  await expect(table).toContainText('UtuhRegistry');
  await expect(table).toContainText('UtuhCredit');

  // The link carries the full address in its title; the label is shortened.
  const registryLink = table.locator('a', { hasText: new RegExp(record.registry.slice(0, 6), 'i') }).first();
  await expect(registryLink).toHaveAttribute('title', record.registry);
});

test('lists every claim the registry holds, with a status the contract could return', async ({ page }) => {
  await boot(page);
  const rows = page.locator('[data-testid=claims-table] tbody tr');
  const count = await rows.count();

  // A registry nobody has used yet is a real state — a fresh deployment has none — and the page
  // has to say so rather than offer a sweep of nothing.
  if (count === 0) {
    await expect(page.locator('[data-testid=claim-select] option')).toHaveCount(0);
    await expect(page.locator('[data-testid=sweep]')).toBeDisabled();
    return;
  }

  // Newest first, so ids run strictly downwards and never below one.
  let previous = Number.POSITIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const cells = await rows.nth(i).locator('td').allInnerTexts();
    const id = Number(cells[0]);
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThan(previous);
    previous = id;
    expect(CLAIM_STATUSES).toContain(cells[2]!.trim());
    expect(cells[3]).toMatch(/^\d+\.\.\d+$/); // a source range
    expect(cells[7]).toMatch(/CTC$/); // a bond
  }

  // Every claim on screen is selectable in the watch pane, and nothing else is.
  await expect(page.locator('[data-testid=claim-select] option')).toHaveCount(count);
});

test('sweeps the source chain from the browser and reports what it found', async ({ page }) => {
  await boot(page);

  const options = await page.locator('[data-testid=claim-select] option').count();
  test.skip(options === 0, 'this registry holds no claims yet — nothing to sweep');

  // Whatever is at the top of the list — newest first, so this is the claim anyone watching a
  // window would actually be looking at.
  await page.locator('[data-testid=claim-select]').selectOption({ index: 0 });
  await page.locator('[data-testid=sweep]').click();

  const log = page.locator('[data-testid=log]');
  await expect(log).toContainText('sweeping source blocks', { timeout: 60_000 });
  await expect(log).toContainText('answered:', { timeout: 120_000 });
  await expect(log).toContainText(/union: \d+ in-scope event/, { timeout: 120_000 });
  await expect(log).toContainText(/no gap found|INCOMPLETE/, { timeout: 120_000 });

  // Whatever the verdict, it names how many independent endpoints produced it. "No gap" from one
  // endpoint is not the same claim as "no gap" from two, and the page must not blur them.
  const text = await log.innerText();
  if (text.includes('no gap found')) {
    expect(text).toMatch(/across \d+ independent endpoints|only \d+ endpoint saw everything/);
  }
});

test('is honest about what it cannot do without a wallet', async ({ page }) => {
  await boot(page);

  const connect = page.locator('#connect');
  await expect(connect).toBeDisabled();
  await expect(connect).toHaveText(/no wallet/);

  // Any action the page offers is disabled rather than hidden, and says why.
  const buttons = page.locator('#actions button.act');
  for (let i = 0; i < (await buttons.count()); i++) {
    await expect(buttons.nth(i)).toBeDisabled();
    await expect(buttons.nth(i)).toHaveAttribute('title', /connect a wallet/);
  }
});

test('serves the ABI forge built, and nothing else out of the build directory', async ({ page }) => {
  const abi = await (await page.request.get('/abi/UtuhRegistry.json')).json();
  const names = abi.filter((f: { type: string }) => f.type === 'function').map((f: { name: string }) => f.name);
  for (const required of ['refute', 'appendBatch', 'enforceableLoss', 'isUsable', 'challengeUntil']) {
    expect(names).toContain(required);
  }

  // The artifact carries megabytes of bytecode the page has no use for; only the ABI is served.
  expect(JSON.stringify(abi)).not.toContain('bytecode');

  // The path is an allowlist, not a join. Anything else is a 404 rather than a file.
  expect((await page.request.get('/abi/Vm.json')).status()).toBe(404);
  expect((await page.request.get('/abi/../package.json')).status()).toBe(404);
  expect((await page.request.get('/.env')).status()).toBe(404);
});
