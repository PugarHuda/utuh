import { chromium } from '@playwright/test';
import { Wallet, concat, keccak256, toUtf8Bytes } from 'ethers';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { injectWallet } from './wallet';

/// Real screenshots of the live console, for the supporting material. Nothing is staged: the page
/// is the published one, served locally, reading CC3 Testnet as it draws.
///
///   npx tsx web/tests/shots.ts <outDir>
///
/// The borrow pane is shown connected as the browser-borrower — a key derived from the operator's,
/// which has two settled lines on the Sepolia deployment — with a wallet that never signs.

const OUT = process.argv[2] ?? join(process.cwd(), 'web', 'static', 'shots');
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5173';

async function ready(page: import('@playwright/test').Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.state === 'ready', null, { timeout: 90_000 });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2 });

  // 1. The registry, mainnet-sourced: real Aave borrowers, with a claim opened to its members.
  let page = await context.newPage();
  await ready(page, `${BASE}/?deployment=mainnet`);
  const options = await page.locator('[data-testid=claim-select] option').all();
  for (const o of options) {
    const m = (await o.innerText()).match(/(\d+) member/);
    if (m && Number(m[1]) >= 3) {
      await page.locator('[data-testid=claim-select]').selectOption((await o.getAttribute('value'))!);
      break;
    }
  }
  await page.locator('[data-testid=members-table] tbody tr').first().waitFor({ timeout: 60_000 });
  await page.locator('[data-testid=claims-table]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(OUT, 'mainnet-claims.png'), clip: { x: 0, y: 0, width: 1180, height: 820 } });
  await page.evaluate(() => document.getElementById('claim-detail')!.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -140));
  await page.screenshot({ path: join(OUT, 'claim-detail.png'), clip: { x: 0, y: 0, width: 1180, height: 820 } });
  await page.close();

  // 2. The watcher, Sepolia: a sweep from the browser, with its verdict and provenance.
  page = await context.newPage();
  await ready(page, `${BASE}/`);
  await page.locator('[data-testid=claim-select]').selectOption({ index: 0 });
  await page.locator('[data-testid=sweep]').click();
  await page
    .locator('[data-testid=log]')
    .filter({ hasText: /no gap found|INCOMPLETE|settles nothing/ })
    .waitFor({
      timeout: 120_000,
    });
  await page.evaluate(() => document.getElementById('log')!.scrollIntoView({ block: 'end' }));
  await page.evaluate(() => window.scrollBy(0, 40));
  await page.screenshot({ path: join(OUT, 'watch.png'), clip: { x: 0, y: 0, width: 1180, height: 820 } });
  await page.close();

  // 3. The borrow pane, connected, reading the borrower's own settled line off the chain.
  const master = (process.env.PRIVATE_KEY ?? '').startsWith('0x')
    ? process.env.PRIVATE_KEY!
    : `0x${process.env.PRIVATE_KEY}`;
  const key = keccak256(concat([master, toUtf8Bytes('utuh/browser-borrower')]));
  page = await context.newPage();
  await injectWallet(page, key, { rejectSends: true });
  await ready(page, `${BASE}/`);
  await page.locator('#connect').click();
  await page
    .locator('#borrow-body')
    .filter({ hasText: /line \d+ is Settled/ })
    .waitFor({ timeout: 90_000 });
  await page.evaluate(() => document.getElementById('borrow-body')!.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -120));
  await page.screenshot({ path: join(OUT, 'borrow.png'), clip: { x: 0, y: 0, width: 1180, height: 820 } });
  console.log(`connected as ${new Wallet(key).address}`);
  await page.close();

  // 4. The top of the page: what Creditcoin attests, the deployment, the claims.
  page = await context.newPage();
  await ready(page, `${BASE}/`);
  await page.screenshot({ path: join(OUT, 'top.png'), clip: { x: 0, y: 0, width: 1180, height: 820 } });
  await page.close();

  await browser.close();
  console.log(`screenshots in ${OUT}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
