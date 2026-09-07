import { expect, test } from '@playwright/test';

/// The pane that audits the oracle.
///
/// Every other test on this page checks that Utuh read Creditcoin correctly. This one checks that
/// Creditcoin read Ethereum correctly, which nothing else here does and nothing in the protocol
/// offers on its own: the ChainInfo precompile reports how far a chain is attested and hands back
/// the attestation's digest rather than the header the attestors signed, so on the precompile alone
/// the attestors cannot be contradicted about Ethereum. The indexer publishes the header hash, and
/// the page compares it against the independent endpoints the watcher already sweeps.
///
/// The digest is not useless, though — it is the second check. Every row's digest goes back to the
/// precompile's own digest index on that network, which answers with the height it belongs to. A
/// row the indexer invented has nowhere to resolve, and that is the hole the Ethereum comparison
/// cannot see.
///
/// A row that read MISMATCH would mean the attestors signed a header Ethereum does not have. That
/// is a larger failure than anything else this repository can detect, and it would be found from a
/// browser with no backend.
///
/// Both Creditcoin networks are audited. The contracts are on CC3 Testnet; Creditcoin Mainnet
/// attests Ethereum mainnet as well, under a different chain key and by a different attestor set,
/// and leaving the production oracle unchecked by the only page that can check it would be the
/// wrong half to skip.

/// The two tables the pane renders, keyed by the chain key Ethereum mainnet has on each network.
const TABLES = [
  { testid: 'attestors-table-3', network: 'Creditcoin CC3 Testnet' },
  { testid: 'attestors-table-1', network: 'Creditcoin Mainnet' },
];

test('every recent attestation on both Creditcoin networks matches the header Ethereum really has', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.goto('/?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  for (const { testid, network } of TABLES) {
    const t = page.locator(`[data-testid=${testid}]`);
    await t.waitFor({ timeout: 120_000 });

    const rows = await t
      .locator('tbody tr')
      .evaluateAll((trs) => trs.map((tr) => Array.from(tr.children).map((c) => c.textContent?.trim() ?? '')));

    expect(rows.length, `${network} returned attestations to check`).toBeGreaterThan(0);

    for (const r of rows) {
      // `matches n/n` is the only acceptable verdict. "no endpoint answered" is a failed check, not
      // a pass — a sweep nothing answered settles nothing here for the same reason it settles
      // nothing in the watcher.
      expect(r[3], `${network} attestation ${r[0]} — ${r.join(' | ')}`).toMatch(/^matches (\d+)\/\1$/);
      // The digest index has to place the row at exactly the height it was reported at. Anything
      // else — NOT ON CHAIN, a different height, an unreadable precompile — is a failed audit.
      expect(r[4], `${network} attestation ${r[0]} in Creditcoin's own digest index`).toBe(`at ${r[0]}`);
    }
  }

  // The two networks attest the same chain here, so the same block should carry the same hash on
  // both. Where their recent ranges overlap, a disagreement is one attestor set contradicting the
  // other about Ethereum — which the per-row checks would already have caught, but which is worth
  // stating as the thing that must not happen.
  const byNetwork = await Promise.all(
    TABLES.map(({ testid }) =>
      page
        .locator(`[data-testid=${testid}] tbody tr`)
        .evaluateAll((trs) => trs.map((tr) => Array.from(tr.children).map((c) => c.textContent?.trim() ?? ''))),
    ),
  );
  const [testnet, mainnet] = byNetwork.map((rows) => new Map(rows.map((r) => [r[0], r[1]])));
  let overlap = 0;
  for (const [block, hash] of testnet!) {
    const other = mainnet!.get(block);
    if (other === undefined) continue;
    overlap += 1;
    expect(other, `both networks attested Ethereum block ${block}`).toBe(hash);
  }
  console.log(`the two attestor sets overlapped on ${overlap} Ethereum block(s)`);

  const notes = page.locator('#attestors-body p.note');
  await expect(notes.first()).toContainText(/attestations indexed/);
  await expect(notes.first()).toContainText(/under chain key/);
  await expect(notes.first()).toContainText(/last checkpoint at/);
  await expect(page.locator('#attestors-body h3')).toHaveCount(2);

  // The closing line is the strongest claim on the page and the cheapest to check: two networks,
  // two attestor sets with nothing in common, one identical digest for the same Ethereum block.
  // It renders as `bad` when the digests disagree or the sets overlap, so the class is the assert.
  const cross = page.locator('#attestors-body > p').last();
  await expect(cross).toContainText(/signed Ethereum block .* into the same digest/);
  await expect(cross).toContainText(/0 shared/);
  await expect(cross).toHaveClass(/note/);
});
