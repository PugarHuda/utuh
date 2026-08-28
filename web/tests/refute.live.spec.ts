import { expect, test } from '@playwright/test';
// The key lives in .env like every other script's does; a spec that only read the shell would
// skip itself silently and read as "nothing to test" rather than "not configured".
import 'dotenv/config';
import { injectWallet } from './wallet';

/// Refuting a claim, through the page, with a real wallet, on the live chain.
///
/// This is the one test here that spends money, so it is off unless asked for:
///
///   UTUH_LIVE_UI=1 npm run web:test -- refute.live
///
/// It needs an incomplete claim to break. `DEPLOYMENTS=deployments.full.json npm run bait` files
/// one deliberately — a sealed claim short by exactly one in-scope event — which is what the
/// watcher daemon is tested against too. If no sealed claim has a gap, the test says so and skips
/// rather than inventing one.
///
/// What stands in for MetaMask is `./wallet` — a real key in this process, real transactions on the
/// real chain. The refutation that comes out the other end is verified by the real Block Prover
/// precompile, and it really slashes a bond.

const KEY = process.env.PRIVATE_KEY;
const ENABLED = process.env.UTUH_LIVE_UI === '1' && Boolean(KEY);

test.describe('refuting an incomplete claim from the browser', () => {
  test.skip(!ENABLED, 'set UTUH_LIVE_UI=1 and PRIVATE_KEY — this spends CTC on the live testnet');

  test('finds the omitted event, proves it, and takes half the bond', async ({ page }) => {
    const account = await injectWallet(page, KEY!.startsWith('0x') ? KEY! : `0x${KEY!}`);

    await page.goto('/');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

    await page.locator('#connect').click();
    await expect(page.locator('#connect')).toBeDisabled();
    await expect(page.locator('#connect')).toContainText(account.slice(0, 6));

    // Sweep each sealed claim until one turns out to be short.
    const options = page.locator('[data-testid=claim-select] option');
    const labels = await options.allInnerTexts();
    const sealed = labels.map((label, index) => ({ label, index })).filter(({ label }) => label.includes('Sealed'));
    test.skip(sealed.length === 0, 'no sealed claim on this deployment — nothing is challengeable');

    const log = page.locator('[data-testid=log]');
    let broken: string | undefined;
    for (const { index, label } of sealed) {
      await page.locator('[data-testid=claim-select]').selectOption({ index });
      await page.locator('[data-testid=sweep]').click();
      await expect(log).toContainText(/no gap found|INCOMPLETE|sweep failed/, { timeout: 120_000 });
      if ((await log.innerText()).includes('INCOMPLETE')) {
        broken = label.match(/claim (\d+)/)?.[1];
        break;
      }
    }
    test.skip(
      broken === undefined,
      'every sealed claim is complete — run: DEPLOYMENTS=deployments.full.json npm run bait',
    );

    const refuteButton = page.locator('[data-testid=refute]');
    await expect(refuteButton).toBeEnabled();
    await refuteButton.click();

    await expect(log).toContainText('fetching a proof', { timeout: 30_000 });
    await expect(log).toContainText('the registry accepts it', { timeout: 120_000 });
    await expect(log).toContainText(/refuted — 0x[0-9a-f]{64}/, { timeout: 180_000 });

    // And the chain agrees: the page re-reads the registry after a send, so the row must have moved.
    // Found by its id rather than by position — the table is newest-first, not claim-one-first.
    const row = page
      .locator('[data-testid=claims-table] tbody tr')
      .filter({ has: page.locator(`td:first-child:text-is("${broken}")`) });
    await expect(row).toContainText('Refuted', { timeout: 60_000 });
  });
});
