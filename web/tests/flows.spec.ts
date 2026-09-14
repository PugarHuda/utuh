import { expect, test, type Page } from '@playwright/test';
import { Wallet } from 'ethers';
import { injectWallet } from './wallet';

/// What a judge tries that nobody demos: a wallet left on Sepolia, a signature refused, the whole
/// path from the landing to a finished sweep without a mouse, a slow phone network, the back button,
/// a second tab, and the print dialog.
///
/// Nothing signs. Every wallet here is the test injector with `rejectSends: true`; the chain the page
/// reads is the live one.

const SEPOLIA = '0xaa36a7';
const VERDICT = /no gap found|INCOMPLETE|settles nothing|inconclusive/;

async function ready(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
}

/// Every error the page did not handle, on every engine.
///
/// Two sources. An `unhandledrejection` listener, installed before the page's own scripts, reports
/// through the console, so a rejection nothing caught fails the test on Chromium, Firefox and WebKit
/// alike. And `pageerror`, with one thing left out that is not an error at all. WebKit logs the console
/// line "Fetch API cannot load https://<host>/ due to access control checks." for any cross-origin fetch
/// that fails, including one the page caught and one the browser cancelled on navigation. Playwright's
/// WebKit driver turns that log line into a pageerror by splitting it at its first colon: name "Fetch API
/// cannot load https", message "//host/ due to access control checks." (with the fetch's call site as a stack
/// on some paths). Measured 2026-09-14: a fetch caught on the spot still raised it, and the
/// landing-to-console-and-back path raised it while the page recorded zero unhandled rejections. Only that
/// exact shape, about the RPC hosts the page reads, is left out.
const isWebkitFetchLog = (e: Error) =>
  e.name === 'Fetch API cannot load https' &&
  /^\/+\S*(creditcoin|blockscout|tenderly|0xrpc|publicnode|ethpandaops)\S* due to access control checks\.$/.test(
    e.message,
  );

async function errors(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.addInitScript(() => {
    addEventListener('unhandledrejection', (e) => {
      const r = e.reason as { message?: string } | undefined;
      console.log(`UNHANDLED REJECTION: ${r?.message ?? String(e.reason)}`);
    });
  });
  page.on('console', (m) => {
    if (m.text().startsWith('UNHANDLED REJECTION: ')) seen.push(m.text());
  });
  page.on('pageerror', (e) => {
    // Recorded with its parts, so a failure says why it was not the WebKit log line above.
    if (!isWebkitFetchLog(e)) {
      seen.push(
        `pageerror: name=${JSON.stringify(e.name)} message=${JSON.stringify(e.message)} stack=${e.stack ? 'yes' : 'none'}`,
      );
    }
  });
  return seen;
}

const walletCalls = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __utuhWalletCalls: { method: string; params: unknown[] }[] }).__utuhWalletCalls,
  );

test('a wallet on the wrong chain is told so and asked to move to 102031', async ({ page }) => {
  await injectWallet(page, Wallet.createRandom().privateKey, { rejectSends: true, chainId: SEPOLIA });
  await ready(page, '/app/');
  await page.locator('#connect').click();

  await expect(page.locator('[data-testid=log]')).toContainText(
    'this wallet is on chain 11155111; asking it to switch to Creditcoin CC3 Testnet (102031)',
  );
  await expect(page.locator('#connect')).toHaveText(/^0x[0-9a-f]{4}…[0-9a-f]{4}$/i);
  const switches = (await walletCalls(page)).filter((c) => c.method === 'wallet_switchEthereumChain');
  expect(switches.map((c) => c.params)).toEqual([[{ chainId: '0x18e8f' }]]);
});

test('a wallet whose owner refuses the switch is not connected, and the page says why in one sentence', async ({
  page,
}) => {
  await injectWallet(page, Wallet.createRandom().privateKey, {
    rejectSends: true,
    chainId: SEPOLIA,
    rejectSwitch: true,
  });
  await ready(page, '/app/');
  await page.locator('#connect').click();

  const line = page.locator('[data-testid=log] .line').last();
  await expect(line).toHaveText(
    'connect failed: this wallet is on chain 11155111, not Creditcoin CC3 Testnet (102031), and the switch was declined',
  );
  await expect(page.locator('#connect')).toBeEnabled();
  // A refusal is an answer: the page does not go on to offer adding the chain.
  expect((await walletCalls(page)).map((c) => c.method)).not.toContain('wallet_addEthereumChain');
});

test('a refused signature is reported in one sentence, and nothing is left disabled', async ({ page }) => {
  await injectWallet(page, Wallet.createRandom().privateKey, { rejectSends: true });
  await ready(page, '/app/');
  await page.locator('#connect').click();
  await expect(page.locator('#connect')).toBeDisabled();

  const send = page.locator('[data-testid=send-commitment]');
  // 120s, not 60: after connect the borrow pane re-reads the chain, and on an afternoon when the CC3 RPC
  // stalls those reads go through Blockscout's rationed proxy. Measured 2026-09-14: 26s on the primary, and
  // still drawing at 60s via Blockscout. Degraded is the page's contract; this waits for it.
  await expect(send).toBeVisible({ timeout: 120_000 });
  await send.click();
  const line = page.locator('[data-testid=borrow-log] .line').last();
  await expect(line).toHaveText('could not send it: you declined it in your wallet, so nothing was sent', {
    timeout: 60_000,
  });
  await expect(send).toBeEnabled();
  expect((await walletCalls(page)).map((c) => c.method)).toContain('eth_sendTransaction');
});

test('from the landing to a finished sweep on the keyboard alone, with reduced motion', async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const seen = await errors(page);
  await page.goto('/');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

  // Landing: the first Tab is the skip link, Enter puts focus on the console link, Enter follows it.
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip a')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#console-link')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => u.pathname.endsWith('/app/'));
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  // Console: skip to the watcher, which is the sweep stamp itself, and press it.
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip a').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#sweep')).toBeFocused();
  await page.keyboard.press('Enter');

  const log = page.locator('[data-testid=log]');
  await expect(log).toContainText('sweeping', { timeout: 30_000 });
  await expect(log).toContainText(VERDICT, { timeout: 240_000 });
  await expect(page.locator('#sweep')).toBeEnabled();
  expect(seen, seen.join('\n')).toEqual([]);
  await context.close();
});

/// Chrome DevTools' "Slow 3G" preset, applied through the DevTools protocol, which only Chromium
/// speaks — hence the tag. 400 kbit/s each way and 2 s of latency on every request.
for (const [what, path] of [
  ['the landing', '/'],
  ['the console', '/app/'],
] as const) {
  test(`@chromium on slow 3G, ${what} paints its largest element in budget and nothing jumps`, async ({
    page,
    context,
  }) => {
    test.setTimeout(300_000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 2_000,
      downloadThroughput: 50_000,
      uploadThroughput: 50_000,
    });
    await page.addInitScript(() => {
      const w = window as unknown as { __lcp: number; __cls: number };
      w.__lcp = -1;
      w.__cls = 0;
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__lcp = e.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => {
        for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
          if (!e.hadRecentInput) w.__cls += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    await page.goto(path, { timeout: 120_000 });
    // Layout shift is counted across the whole load, including every pane the chain fills in —
    // that is where a page like this jumps, not in its first paint.
    await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 240_000 });
    const { lcp, cls } = await page.evaluate(() => {
      const w = window as unknown as { __lcp: number; __cls: number };
      return { lcp: w.__lcp, cls: w.__cls };
    });
    console.log(`${what} on slow 3G: LCP ${Math.round(lcp)}ms, CLS ${cls.toFixed(4)}`);
    expect(lcp, 'a largest paint was recorded').toBeGreaterThan(0);
    // Two render-blocking round trips at 2 s latency (the document, then the stylesheet and font),
    // plus their bytes at 50 kB/s from a server that does not compress. Lighthouse's "poor" line is
    // 4 s on a far faster profile; this is the same page on a far slower one.
    expect(lcp, 'largest contentful paint').toBeLessThan(8_000);
    expect(cls, 'cumulative layout shift').toBeLessThan(0.1);
  });
}

/// The swap from the fallback face to Archivo must not move the page. On the Linux CI runner the
/// system fallback is DejaVu Sans, whose wide Vera metrics made the hero reflow when Archivo arrived: a
/// layout shift of 0.1138, failing the slow-3G test above. The stylesheet's 'Archivo Fallback' faces set
/// Arial (or Liberation Sans, its Linux twin) to Archivo's measured widths and vertical metrics. This
/// serves the real stylesheet with only the generic tail of the stack swapped for a wide Vera-family face,
/// delays the webfont so the swap is a separate paint, and measures the shift at that moment. Without the
/// fallback faces it was 0.1046; with them, 0.0001. Chromium only, because only Chromium reports
/// layout-shift entries.
test('@chromium Archivo swapping in over its fallback moves nothing', async ({ page }) => {
  await page.route(/creditcoin|blockscout|tenderly|0xrpc|publicnode|ethpandaops/, (r) => r.abort());
  await page.route('**/style.css', async (route) => {
    const response = await route.fetch();
    const css = await response.text();
    const stack = css.match(/--face: ([^;]+);/)?.[1] ?? '';
    expect(stack, 'the face stack names the metric-matched fallback second').toMatch(
      /^'Archivo', 'Archivo Fallback',/,
    );
    await route.fulfill({
      response,
      body: css.replace(
        /--face: [^;]+;/,
        "--face: 'Archivo', 'Archivo Fallback', Verdana, 'DejaVu Sans', sans-serif;",
      ),
    });
  });
  await page.route('**/archivo.woff2', async (route) => {
    await new Promise((wake) => setTimeout(wake, 2_500));
    await route.continue();
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __shifts: [number, number][]; __fontAt?: number };
    w.__shifts = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as (PerformanceEntry & { value: number })[])
        w.__shifts.push([e.startTime, e.value]);
    }).observe({ type: 'layout-shift', buffered: true });
    document.fonts.addEventListener('loadingdone', () => (w.__fontAt = performance.now()));
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.waitForFunction(() => (window as unknown as { __fontAt?: number }).__fontAt !== undefined, null, {
    timeout: 20_000,
  });
  await page.waitForTimeout(1_000);
  const shift = await page.evaluate(() => {
    const w = window as unknown as { __shifts: [number, number][]; __fontAt: number };
    return w.__shifts.filter(([t]) => Math.abs(t - w.__fontAt) < 600).reduce((sum, [, v]) => sum + v, 0);
  });
  expect(await page.evaluate(() => document.fonts.check('16px Archivo')), 'Archivo did load').toBe(true);
  expect(shift, 'layout shift at the moment Archivo replaced its fallback').toBeLessThan(0.01);
});

test('back from a claim in the console returns a live landing, and forward returns the claim', async ({ page }) => {
  const seen = await errors(page);
  await page.addInitScript(() => {
    addEventListener('pageshow', (e) => {
      (window as unknown as { __restored: boolean }).__restored = e.persisted;
    });
  });
  await ready(page, '/');
  await page.locator('[data-testid=open-sepolia-5-again]').click();
  await page.waitForURL((u) => u.pathname.endsWith('/app/') && u.searchParams.get('claim') === '5');
  await expect(page.locator('#claim-select')).toHaveValue('5', { timeout: 90_000 });

  await page.goBack();
  await page.waitForURL((u) => !u.pathname.includes('/app/'));
  // Restored from the cache or loaded again, the landing must be the whole landing: both schedules
  // drawn, the chips holding a real block, and no redirect back into the console.
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await expect(page.locator('[data-testid=schedule-members-sepolia-5] tbody tr')).toHaveCount(4);
  await expect(page.locator('#live-block')).toHaveText(/^[\d,.\s]+$/);
  const restored = await page.evaluate(() => (window as unknown as { __restored?: boolean }).__restored);
  test.info().annotations.push({ type: 'bfcache', description: restored ? 'restored from cache' : 'reloaded' });

  await page.goForward();
  await page.waitForURL((u) => u.searchParams.get('claim') === '5');
  await expect(page.locator('#claim-select')).toHaveValue('5', { timeout: 90_000 });
  expect(seen, seen.join('\n')).toEqual([]);
});

test('a second tab opened on a claim while the first is sweeping gets its own whole page', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000);
  const seen = await errors(page);
  await ready(page, '/app/');
  await page.locator('#sweep').click();
  await expect(page.locator('[data-testid=log]')).toContainText('sweeping', { timeout: 30_000 });

  const second = await context.newPage();
  const seenSecond = await errors(second);
  await ready(second, '/app/?claim=5');
  await expect(second.locator('#claim-select')).toHaveValue('5', { timeout: 60_000 });
  await expect(second.locator('[data-testid=claim-standing]')).toContainText(/Refuted/, { timeout: 60_000 });
  // The second tab's log is its own: the sweep running next door does not narrate into it.
  await expect(second.locator('[data-testid=log]')).toBeEmpty();

  await expect(page.locator('[data-testid=log]')).toContainText(VERDICT, { timeout: 240_000 });
  expect([...seen, ...seenSecond], [...seen, ...seenSecond].join('\n')).toEqual([]);
});

test('the landing prints as a working paper: light stock and dark ink, no controls, no schedule split', async ({
  page,
}) => {
  // Dark on screen on purpose: the print has to come back to the light palette regardless.
  await page.emulateMedia({ colorScheme: 'dark' });
  await ready(page, '/');
  await page.emulateMedia({ colorScheme: 'dark', media: 'print' });

  const printed = await page.evaluate(() => {
    const cs = (sel: string) => getComputedStyle(document.querySelector(sel)!);
    return {
      ground: cs('body').backgroundColor,
      ink: cs('body').color,
      skip: cs('.skip').display,
      nav: cs('.head nav').display,
      chips: cs('.chip-row').display,
      copy: cs('#copy-mcp').display,
      schedule: cs('.schedule').breakInside,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(printed).toEqual({
    ground: 'rgb(223, 231, 213)',
    ink: 'rgb(22, 32, 26)',
    skip: 'none',
    nav: 'none',
    chips: 'none',
    copy: 'none',
    schedule: 'avoid',
    overflow: 0,
  });
  // The schedules themselves are what a printed copy is for.
  await expect(page.locator('[data-testid=schedule-members-sepolia-5]')).toBeVisible();
});
