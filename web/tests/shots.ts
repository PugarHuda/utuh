import { chromium } from '@playwright/test';
import { Wallet, concat, keccak256, toUtf8Bytes } from 'ethers';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { injectWallet } from './wallet';

/// Real screenshots of the live pages, for the supporting material. Nothing is staged: the pages
/// are the published ones, served locally, reading CC3 Testnet as they draw.
///
///   npx tsx web/tests/shots.ts <outDir>
///
/// Produces: landing (light, dark, phone), the console with claim 20 open on the mainnet-sourced
/// registry, the console with `?claim=5` after a sweep, the borrow pane connected as the
/// browser-borrower (a key derived from the operator's, with a wallet that never signs), the watch
/// pane — and `web/og.png`, the link preview, photographed from the landing at 1200×630.

const ROOT = process.cwd();
const OUT = process.argv[2] ?? join(ROOT, 'web', 'static', 'shots');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';
const DESK = { width: 1180, height: 820 };

async function ready(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.state === 'ready', null, { timeout: 90_000 });
}

/// The footed totals walk every claim on both registries; a landing shot with "…" in them is a
/// photograph of a page still loading.
async function footed(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(() => document.getElementById('tally')?.dataset.ready !== 'false', null, {
    timeout: 150_000,
  });
  await page.waitForTimeout(900);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  // 1. The landing, light and dark, and the link preview.
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: DESK, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await context.newPage();
    await ready(page, `${BASE}/`);
    await footed(page);
    await page.screenshot({ path: join(OUT, `landing-${scheme}.png`), clip: { x: 0, y: 0, ...DESK } });
    if (scheme === 'light') {
      // og.png is what every share of this URL shows; written from the same capture, in the same
      // run, so it cannot drift behind the page it claims to be.
      await page.setViewportSize({ width: 1200, height: 630 });
      await page.waitForTimeout(300);
      await page.screenshot({
        path: join(ROOT, 'web', 'og.png'),
        clip: { x: 0, y: 0, width: 1200, height: 630 },
        scale: 'css',
      });
    }
    await context.close();
  }

  // 2. The landing on a phone.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await ready(page, `${BASE}/`);
    await footed(page);
    await page.screenshot({ path: join(OUT, 'landing-mobile.png'), clip: { x: 0, y: 0, width: 390, height: 844 } });
    await context.close();
  }

  const context = await browser.newContext({ viewport: DESK, deviceScaleFactor: 2 });

  // 3. The console, mainnet-sourced, with the false "never liquidated" claim open and its standing.
  let page = await context.newPage();
  await ready(page, `${BASE}/app/?deployment=mainnet&claim=20`);
  await page
    .locator('[data-testid=claim-standing]')
    .filter({ hasText: /Refuted/ })
    .waitFor({ timeout: 60_000 });
  await page.locator('[data-testid=claims-table] tbody tr').first().waitFor({ timeout: 60_000 });
  await footed(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: join(OUT, 'console-mainnet-20.png'), clip: { x: 0, y: 0, ...DESK } });
  await page.close();

  // 4. The watcher on `?claim=5`: a sweep from the browser, with its verdict and provenance.
  page = await context.newPage();
  await ready(page, `${BASE}/app/?claim=5`);
  await page.locator('[data-testid=sweep]').click();
  await page
    .locator('[data-testid=log]')
    .filter({ hasText: /no gap found|INCOMPLETE|settles nothing/ })
    .waitFor({ timeout: 120_000 });
  await page.evaluate(() => document.getElementById('claim-detail')!.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -120));
  await page.screenshot({ path: join(OUT, 'console-claim-5-sweep.png'), clip: { x: 0, y: 0, ...DESK } });
  await page.evaluate(() => document.getElementById('log')!.scrollIntoView({ block: 'end' }));
  await page.evaluate(() => window.scrollBy(0, 40));
  await page.screenshot({ path: join(OUT, 'watch.png'), clip: { x: 0, y: 0, ...DESK } });
  await page.close();

  // 5. The borrow pane, connected, reading the borrower's own settled line off the chain.
  const master = (process.env.PRIVATE_KEY ?? '').startsWith('0x')
    ? process.env.PRIVATE_KEY!
    : `0x${process.env.PRIVATE_KEY}`;
  page = await context.newPage();
  const key = keccak256(concat([master, toUtf8Bytes('utuh/browser-borrower')]));
  await injectWallet(page, key, { rejectSends: true });
  await ready(page, `${BASE}/app/`);
  await page.locator('#connect').click();
  await page
    .locator('#borrow-body')
    .filter({ hasText: /line \d+ is Settled/ })
    .waitFor({ timeout: 90_000 });
  await page.evaluate(() => document.getElementById('borrow-body')!.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -120));
  await page.screenshot({ path: join(OUT, 'borrow.png'), clip: { x: 0, y: 0, ...DESK } });
  console.log(`connected as ${new Wallet(key).address}`);
  await page.close();

  await browser.close();
  console.log(`screenshots in ${OUT}, link preview in web/og.png`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
