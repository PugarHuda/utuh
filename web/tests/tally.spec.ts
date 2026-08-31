import { expect, test } from '@playwright/test';

/// The four numbers above the fold.
///
/// They are read from both registries rather than the selected one, and one of them — the count of
/// claims broken by a refutation — is a number nothing else deployed against this protocol can
/// report, because nothing else has the call. That is the whole reason it is on the page.
///
/// This asserts the strip reaches the chain and reports real figures, not that the figures hold
/// particular values: claims are sealed and broken continuously, so pinning a number here would
/// make an honest day's work turn the suite red.

test('the tally reads both registries live, and refutations are among them', async ({ page }) => {
  test.setTimeout(200_000);
  await page.goto('/');

  const strip = page.locator('[data-testid=tally]');
  await expect(strip).toHaveAttribute('data-ready', 'true', { timeout: 170_000 });

  const num = async (id: string) => Number((await page.locator(`#${id}`).textContent())?.replace(/[^\d.]/g, ''));

  const proven = await num('t-proven');
  const claims = await num('t-claims');
  const refuted = await num('t-refuted');
  const burned = await num('t-burned');

  // Both registries are summed, so the total must exceed what either one holds alone.
  expect(claims, 'claims across both deployments').toBeGreaterThan(20);
  expect(proven, 'events proven into claims').toBeGreaterThan(claims);
  expect(refuted, 'claims broken by a refutation').toBeGreaterThan(0);
  expect(refuted).toBeLessThanOrEqual(claims);
  // A refuted claim slashes a bond, so one cannot be positive while the other is zero.
  expect(burned, 'bond slashed').toBeGreaterThan(0);
});

test('a tally that cannot be read says so instead of showing zero', async ({ page }) => {
  // The failure that matters is a plausible-looking zero: a reader shown "0 refuted" during an RPC
  // outage would draw exactly the wrong conclusion. Blocking the endpoint outright would not test
  // this — boot fails first and the strip never runs — so only the call the tally makes per claim
  // is killed, leaving the rest of the page to load normally.
  const MEMBER_COUNT = '0x6e8165e8'; // memberCount(uint256)
  await page.route('**/rpc.cc3-testnet.creditcoin.network/**', (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes(MEMBER_COUNT)) return route.abort();
    return route.continue();
  });

  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });

  const strip = page.locator('[data-testid=tally]');
  await expect(strip).toHaveAttribute('data-ready', 'failed', { timeout: 120_000 });
  for (const id of ['t-proven', 't-claims', 't-refuted', 't-burned']) {
    await expect(page.locator(`#${id}`)).toHaveText('—');
  }
});
