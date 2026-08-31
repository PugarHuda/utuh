import { expect, test } from '@playwright/test';

/// The pane that audits the oracle.
///
/// Every other test on this page checks that Utuh read Creditcoin correctly. This one checks that
/// Creditcoin read Ethereum correctly, which nothing else here does and nothing in the protocol
/// offers: the ChainInfo precompile reports how far a chain is attested and will not say with what
/// hash, so on the precompile alone the attestors cannot be contradicted. The indexer publishes the
/// hash, and the page compares it against the independent endpoints the watcher already sweeps.
///
/// A row that read MISMATCH would mean the attestors signed a header Ethereum does not have. That
/// is a larger failure than anything else this repository can detect, and it would be found from a
/// browser with no backend.

test('every recent attestation matches the header the source chain really has', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  const t = page.locator('[data-testid=attestors-table]');
  await t.waitFor({ timeout: 120_000 });

  const rows = await t
    .locator('tbody tr')
    .evaluateAll((trs) => trs.map((tr) => Array.from(tr.children).map((c) => c.textContent?.trim() ?? '')));

  expect(rows.length, 'the indexer returned attestations to check').toBeGreaterThan(0);

  for (const r of rows) {
    // `matches n/n` is the only acceptable verdict. "no endpoint answered" is a failed check, not
    // a pass — a sweep nothing answered settles nothing here for the same reason it settles
    // nothing in the watcher.
    expect(r[3], `attestation ${r[0]} — ${r.join(' | ')}`).toMatch(/^matches (\d+)\/\1$/);
  }

  await expect(page.locator('#attestors-body p.note')).toContainText(/attestations indexed/);
  await expect(page.locator('#attestors-body p.note')).toContainText(/registered attestor/);
});
