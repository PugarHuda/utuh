import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/// The console as a hostile judge opens it.
///
/// Not the happy path on a developer's laptop: a phone in the dark, a tablet, a 1080p projector, a
/// link somebody mistyped, a chain that answers slowly, a chain that stops answering halfway
/// through, and a crawler that never renders anything and only reads the head. Every one of these
/// is a way a demonstration goes wrong in the room, and each is cheap to hold the page to.
///
/// Nothing is stubbed but the network conditions. The page under test reads CC3 Testnet as it does
/// for anyone else; a route that delays or refuses a request is the only intervention, and it is the
/// same intervention the world makes on an ordinary afternoon.

const VIEWPORTS = {
  'a phone, 390×844': { width: 390, height: 844 },
  'a tablet, 768×1024': { width: 768, height: 1024 },
  'a laptop, 1280×800': { width: 1280, height: 800 },
  'a projector, 1920×1080': { width: 1920, height: 1080 },
} as const;

/// The two grounds the stylesheet paints, so a scheme that did not switch is caught rather than
/// audited twice under the same palette.
const GROUND = { light: 'rgb(223, 231, 213)', dark: 'rgb(15, 21, 18)' } as const; // DESIGN.md paper / dark-paper

/// Uncaught exceptions and console errors, from the first byte on.
function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });
  return errors;
}

async function ready(page: Page, url = '/app/'): Promise<void> {
  await page.goto(url);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
}

async function sideways(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const [where, viewport] of Object.entries(VIEWPORTS)) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`on ${where}, ${scheme}: boots clean, nothing sideways, nothing clipped`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme });
      const errors = watch(page);
      await ready(page);

      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'palette switched').toBe(
        GROUND[scheme],
      );
      expect(await sideways(page), 'no horizontal scroll').toBeLessThanOrEqual(1);

      // The header's controls fit the width they were given — the deployment picker carries the
      // longest label on the page, and a phone is where it would run off the edge.
      for (const id of ['#deployment', '#connect', '#sweep', '#claim-select']) {
        const box = await page.locator(id).boundingBox();
        expect(box, `${id} is laid out`).not.toBeNull();
        expect(box!.x, `${id} starts on screen`).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width, `${id} ends on screen`).toBeLessThanOrEqual(viewport.width + 1);
      }

      // The claims pane is the widest thing on the page; wherever it is wider than the frame it
      // scrolls inside its own box rather than pushing the frame.
      const claims = page.locator('[data-testid=claims-table]');
      if ((await claims.count()) > 0) {
        const overflow = await claims.evaluate((t) => getComputedStyle(t.parentElement as HTMLElement).overflowX);
        expect(overflow).toBe('auto');
      }

      // Every pane has rendered something the chain said, or a red sentence saying why not — and it
      // must be the former: this page is the demo.
      await expect(page.locator('#attestcoin-body .bad, #registry-body .bad, #credit-body .bad')).toHaveCount(0);
      expect(errors, errors.join('\n')).toEqual([]);
    });
  }
}

test('on a phone in the dark, no WCAG A/AA violations either', async ({ page }) => {
  await page.setViewportSize(VIEWPORTS['a phone, 390×844']);
  await page.emulateMedia({ colorScheme: 'dark' });
  await ready(page);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const named = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
  );
  expect(named, named.join('\n')).toEqual([]);
});

/// The two links every document hands a reader. Both open a claim somebody broke, and the page has
/// to show it broken: selected in the watch pane, decoded underneath, and struck through in the
/// table above.
for (const [what, path, id, deployment] of [
  ['the claim sealed one event short', '/?claim=5', '5', 'sepolia'],
  ['the false clean claim over real Aave history', '/?deployment=mainnet&claim=20', '20', 'mainnet'],
] as const) {
  test(`${path} opens ${what}, refuted`, async ({ page }) => {
    const errors = watch(page);
    await ready(page, path);
    await expect(page.locator('#deployment')).toHaveValue(deployment);
    await expect(page.locator('#claim-select')).toHaveValue(id, { timeout: 60_000 });
    await expect(page.locator('[data-testid=claim-detail]')).toContainText(`claim ${id}:`, { timeout: 60_000 });

    const row = page.locator('[data-testid=claims-table] tbody tr', {
      has: page.locator(`td:first-child:text-is("${id}")`),
    });
    await expect(row).toHaveCount(1);
    await expect(row.locator('td').nth(2)).toHaveText('Refuted');
    await expect(row).toHaveClass(/struck/);

    // Anyone may still sweep it — the button is live, and the log says so when pressed.
    await expect(page.locator('#sweep')).toBeEnabled();
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('a mangled query string is ignored, not an error, and nothing in it reaches the page as markup', async ({
  page,
}) => {
  const errors = watch(page);
  await ready(page, '/?claim=abc&claim=&deployment=%3Cscript%3Ealert(1)%3C%2Fscript%3E&%ZZ=1&claim=-3');
  await expect(page.locator('#deployment')).toHaveValue('sepolia');
  await expect(page.locator('#attestcoin-body .bad, #registry-body .bad, #credit-body .bad')).toHaveCount(0);
  await expect(page.locator('#boot-error')).toBeEmpty();
  await expect(page.locator('[data-testid=claims-table] tbody tr').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain('<script>alert');
  expect(errors, errors.join('\n')).toEqual([]);
});

test('a slow chain: the page says what it is waiting for, then finishes', async ({ page }) => {
  await page.route('**/rpc.cc3-testnet.creditcoin.network/**', async (route) => {
    await new Promise((r) => setTimeout(r, 3_000));
    await route.continue();
  });
  const errors = watch(page);
  await page.goto('/app/');

  // Every pane names what it is doing while it waits, rather than sitting blank.
  await expect(page.locator('#attestcoin-body')).toContainText('reading the ChainInfo precompile');
  await expect(page.locator('#registry-body')).toContainText('reading the registry');
  await expect(page.locator('#credit-body')).toContainText('reading the credit contract');
  await expect(page.locator('[data-testid=invitation]')).toContainText('Reading both registries');
  await expect(page.locator('#connect')).toHaveText(/no wallet/);

  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 150_000 });
  await expect(page.locator('#chain-id')).toHaveText('102031');
  // Not asserted: that the fallback stayed out of it. Three seconds is under the primary's
  // seven-second deadline, but the delay is added to whatever the real endpoint does that minute,
  // and one parked answer sends one read through Blockscout — correct, and not this test's subject.
  expect(errors, errors.join('\n')).toEqual([]);
});

test('going offline mid-session: a sweep fails in a sentence, and nothing is thrown', async ({ page, context }) => {
  const errors = watch(page);
  await ready(page);
  test.skip((await page.locator('[data-testid=claim-select] option').count()) === 0, 'no claim to sweep');

  await context.setOffline(true);
  try {
    await page.locator('#sweep').click();
    await expect(page.locator('#log')).toContainText(/sweep failed:/, { timeout: 90_000 });
    await expect(page.locator('#sweep')).toBeEnabled();
  } finally {
    await context.setOffline(false);
  }
  // Every engine logs each request it refused while offline as a console error of its own, in its own
  // words, and those are the outage, not the page: Chromium's net::ERR_INTERNET_DISCONNECTED, Firefox's
  // "CORS request did not succeed" with no status, WebKit's "internal error". What must not appear is an
  // exception the page failed to catch, which arrives as a pageerror and is never filtered here.
  const refused = [
    /Failed to load resource: net::ERR_INTERNET_DISCONNECTED/,
    /Cross-Origin Request Blocked: .*\(Reason: CORS request did not succeed\)\. Status code: \(null\)/,
    /Failed to load resource: WebKit encountered an internal error/,
  ];
  const ours = errors.filter((e) => !(e.startsWith('console: ') && refused.some((r) => r.test(e))));
  expect(ours, ours.join('\n')).toEqual([]);
});

test('what a crawler, a link preview, an agent and a scanner each read is there', async ({
  page,
  request,
  baseURL,
}) => {
  await page.goto('/app/');
  await expect(page).toHaveTitle(/Utuh/);
  for (const [selector, pattern] of [
    ['meta[name="description"]', /Attestcoin/],
    ['meta[property="og:type"]', /^website$/],
    ['meta[property="og:title"]', /Utuh/],
    ['meta[property="og:description"]', /complete/],
    ['meta[property="og:url"]', /^https:\/\/utuh\.vercel\.app\/app\/$/],
    ['meta[property="og:image"]', /^https:\/\/utuh\.vercel\.app\/og\.png$/],
    ['meta[property="og:image:alt"]', /console/],
    ['meta[name="twitter:card"]', /^summary_large_image$/],
    ['link[rel="canonical"]', /^https:\/\/utuh\.vercel\.app\/app\/$/],
    ['link[rel="icon"]', /^data:image\/svg\+xml/],
    ['meta[name="viewport"]', /width=device-width/],
  ] as const) {
    const attr = selector.startsWith('link') ? 'href' : 'content';
    await expect(page.locator(selector).first(), selector).toHaveAttribute(attr, pattern);
  }
  await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
  expect(await page.locator('html').getAttribute('lang')).toBe('en');

  // The files a static host serves beside the page, none of which the page itself asks for.
  for (const [path, type, opens] of [
    ['llms.txt', /text\/plain/, /^# Utuh/],
    // The README first, under its path, and then its own first heading: the long form is the documents.
    ['llms-full.txt', /text\/plain/, /^# README\.md\n\n# Utuh\n/],
    ['.well-known/security.txt', /text\/plain/, /^Contact: https:\/\/github\.com\/PugarHuda\/utuh\/security/m],
    ['whitepaper.pdf', /application\/pdf/, /^%PDF-/],
    ['deck.pdf', /application\/pdf/, /^%PDF-/],
    ['og.png', /image\/png/, /^\x89PNG/],
    ['robots.txt', /text\/plain/, /^User-agent: \*/],
    ['sitemap.xml', /xml/, /<urlset/],
    ['.well-known/agent-registration.json', /json/, /"type": "https:\/\/eips\.ethereum\.org\/EIPS\/eip-8004/],
  ] as const) {
    const res = await request.get(new URL(path, baseURL!).href);
    expect(res.status(), `${path} answers`).toBe(200);
    expect(res.headers()['content-type'] ?? '', `${path} is typed`).toMatch(type);
    expect((await res.body()).toString('latin1'), `${path} is the file`).toMatch(opens);
  }
  // security.txt is only as good as its clock.
  const security = await (await request.get(new URL('.well-known/security.txt', baseURL!).href)).text();
  const expires = new Date(security.match(/^Expires: (.+)$/m)![1]!);
  expect(expires.getTime(), 'security.txt has not expired').toBeGreaterThan(Date.now());
});

test('the first paint is fast: LCP under 2.5s, before the chain has said a word', async ({ page }) => {
  await page.goto('/app/');
  // The candidate that stands when the chain has answered nothing yet — the page's own frame, its
  // heading and its placeholders. Everything the chain adds later is content, and a slow public
  // endpoint must not be able to make this page look slow to paint.
  const lcp = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          resolve(entries[entries.length - 1]?.startTime ?? -1);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        setTimeout(() => resolve(-1), 5_000);
      }),
  );
  const fcp = await page.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1);
  console.log(`first contentful paint ${Math.round(fcp)}ms, largest contentful paint ${Math.round(lcp)}ms`);
  expect(fcp, 'a first paint happened').toBeGreaterThan(0);
  expect(lcp, 'a largest paint was recorded').toBeGreaterThan(0);
  expect(lcp).toBeLessThan(2_500);
});
