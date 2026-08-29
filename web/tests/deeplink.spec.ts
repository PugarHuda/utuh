import { expect, test } from '@playwright/test';

/// A claim has an address.
///
/// `?claim=N` opens claim N on arrival — what a post, a document, or a refuter's message points
/// at — and the address bar follows the picker, so what is on screen is always what the URL says.

async function total(page: import('@playwright/test').Page): Promise<number> {
  const note = await page.locator('#registry-body .note').first().innerText();
  const m = note.match(/of (\d+) claim\(s\) shown/);
  if (!m) throw new Error(`no claim count in: ${note}`);
  return Number(m[1]);
}

test('?claim=N opens that claim on arrival, even one older than the first page', async ({ page }) => {
  await page.goto('/?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  const all = await total(page);
  test.skip(all === 0, 'no claims');
  const firstPage = await page.locator('[data-testid=claims-table] tbody tr').count();

  // The oldest claim: on a registry with more than one page, it is not on screen until asked for.
  await page.goto('/?deployment=mainnet&claim=1');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await expect(page.locator('[data-testid=claim-select]')).toHaveValue('1', { timeout: 60_000 });
  await expect(page.locator('[data-testid=claim-detail]')).toContainText('claim 1', { timeout: 60_000 });
  const rows = page.locator('[data-testid=claims-table] tbody tr');
  await expect(rows).toHaveCount(all);
  if (all > firstPage) expect(await rows.count()).toBeGreaterThan(firstPage);
});

test('a claim id that does not exist is ignored, not an error', async ({ page }) => {
  await page.goto('/?claim=999999');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await expect(page.locator('#registry-body .bad')).toHaveCount(0);
  const select = page.locator('[data-testid=claim-select]');
  await expect(select).not.toHaveValue('999999');
});

test('picking a claim writes it into the address bar; switching deployments drops it', async ({ page }) => {
  await page.goto('/?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  const select = page.locator('[data-testid=claim-select]');
  const options = await select.locator('option').allInnerTexts();
  test.skip(options.length < 2, 'needs two claims to pick between');

  const value = await select.locator('option').nth(1).getAttribute('value');
  await select.selectOption(value!);
  await expect.poll(() => new URL(page.url()).searchParams.get('claim')).toBe(value);
  await expect(page.locator('[data-testid=claim-detail]')).toContainText(`claim ${value}`, { timeout: 60_000 });

  // Reload: the URL is the state.
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await expect(select).toHaveValue(value!, { timeout: 60_000 });

  await page.locator('[data-testid=deployment]').selectOption('sepolia');
  await page.waitForURL((u) => !u.searchParams.has('deployment'));
  expect(new URL(page.url()).searchParams.has('claim')).toBe(false);
});
