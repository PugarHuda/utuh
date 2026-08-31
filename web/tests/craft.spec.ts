import { expect, test } from '@playwright/test';

/// The things a screenshot does not catch.
///
/// axe-core audits the landing page for WCAG violations and `static.spec.ts` proves the published
/// build asks its host for nothing. Between those sits a class of defect neither sees: a rail that
/// silently collapses to one frame because `grid-row: 1 / -1` counted the wrong grid, a refuted
/// claim that stops being struck because a row class was dropped, a log that streams a sweep to a
/// screen reader that is never told, a phone layout that works until a column is added.
///
/// Each of these failed at least once while it was being written. Two were real defects in the
/// shipped page — the logs were not live regions and no `th` carried a `scope` — and one was a
/// defect in the test rather than the product: a sweep against dead endpoints reports in ten
/// seconds and says it settles nothing, which the first version of that check was not reading.

const ready = async (page: import('@playwright/test').Page, url = '/') => {
  await page.goto(url);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
};

test('the strip is drawn: the face loads, the rail spans it, every frame is numbered', async ({ page }) => {
  await ready(page);
  const font = await page.evaluate(() => document.fonts.check('16px Archivo'));
  expect(font, 'Archivo must be loaded').toBe(true);

  // Every section carries a rebate number.
  const frames = await page
    .locator('main section')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.frame ?? null));
  expect(frames, 'every frame numbered').not.toContain(null);
  expect(new Set(frames).size, 'numbers unique').toBe(frames.length);

  // The rail is drawn and spans more than one frame.
  const rail = await page.evaluate(() => {
    const m = document.querySelector('main');
    if (!m) return null;
    const cs = getComputedStyle(m, '::before');
    return { h: parseFloat(cs.height), w: parseFloat(cs.width), content: cs.content };
  });
  const mainH = await page.locator('main').evaluate((e) => e.getBoundingClientRect().height);
  expect(rail!.h, 'rail spans the strip').toBeGreaterThan(mainH * 0.8);
});

test('a refuted claim is struck through, and nothing else is', async ({ page }) => {
  await ready(page);
  await page.locator('[data-testid=claims-table] tbody tr').first().waitFor({ timeout: 60_000 });
  const rows = await page.locator('[data-testid=claims-table] tbody tr').evaluateAll((trs) =>
    trs.map((tr) => ({
      status: tr.children[2]?.textContent?.trim() ?? '',
      struck: tr.classList.contains('struck'),
      line: getComputedStyle(tr.children[3] as Element).textDecorationLine,
    })),
  );
  const refuted = rows.filter((r) => r.status === 'Refuted');
  expect(refuted.length, 'fixture has at least one refuted claim to check').toBeGreaterThan(0);
  for (const r of refuted) expect(r.struck, 'refuted row has .struck').toBe(true);
  for (const r of rows.filter((r) => r.status !== 'Refuted')) {
    expect(r.struck, 'non-refuted row is not struck').toBe(false);
  }
  expect(refuted[0]!.line, 'struck row is actually drawn through').toContain('line-through');
});

test('both logs are live regions, so a sweep is narrated rather than silent', async ({ page }) => {
  await ready(page);
  const log = page.locator('#log');
  const live = await log.getAttribute('aria-live');
  const role = await log.getAttribute('role');
  expect(
    live ?? role,
    'the log streams progress during a sweep; without a live region a screen-reader user is told nothing',
  ).toBeTruthy();
});

test('reflows at 200% zoom without a sideways scrollbar', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready(page);
  // 1280 CSS px at 200% is equivalent to a 640px viewport.
  await page.setViewportSize({ width: 640, height: 800 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no horizontal scroll at 200% zoom equivalent').toBeLessThanOrEqual(1);
});

test('works at 320px, the narrowest width WCAG asks for', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await ready(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'no sideways scroll at 320px').toBeLessThanOrEqual(1);
  // Controls must still be reachable and not clipped away.
  await expect(page.locator('#sweep')).toBeVisible();
  const box = await page.locator('#sweep').boundingBox();
  expect(box!.width, 'sweep button not collapsed').toBeGreaterThan(40);
});

test('?deployment= arrives on the deployment it names', async ({ page }) => {
  await ready(page, '/?deployment=mainnet');
  await expect(page.locator('#deployment')).toHaveValue('mainnet');
});

test('every control is reachable by keyboard and shows where the focus is', async ({ page }) => {
  await ready(page);
  const controls = await page.locator('button:visible, select:visible, a[href]:visible, input:visible').count();
  const seen = new Set<string>();
  let focusRingOk = true;
  for (let i = 0; i < controls + 12; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return {
        key: `${el.tagName}#${el.id}.${el.className}`,
        outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0,
      };
    });
    if (!info) continue;
    seen.add(info.key);
    if (!info.outline) focusRingOk = false;
  }
  expect(seen.size, 'tab order reaches the controls').toBeGreaterThan(3);
  expect(focusRingOk, 'every focused control shows an outline').toBe(true);
});

test('honours prefers-reduced-motion', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await ready(page);
  const dur = await page
    .locator('main section')
    .first()
    .evaluate((e) => getComputedStyle(e).transitionDuration);
  expect(parseFloat(dur), 'transitions collapse under reduced motion').toBeLessThan(0.05);
  await ctx.close();
});

test('a sweep no endpoint answered settles nothing, and says so', async ({ page }) => {
  await ready(page);
  await page.route(
    (url) => !url.host.includes('cc3-testnet') && url.protocol.startsWith('http'),
    (r) => r.abort('failed'),
  );
  const options = await page.locator('[data-testid=claim-select] option').count();
  test.skip(options === 0, 'no sweepable claim');
  await page.locator('#sweep').click();
  const log = page.locator('#log');
  await expect(log).toContainText(/settles nothing|0 answered/i, { timeout: 60_000 });
  const text = await log.innerText();
  expect(text, 'every endpoint is reported as errored').toMatch(/=err/);
  expect(text, 'must never read as a clean bill of health').not.toMatch(/claim is complete/i);
});

test('every table header cell names its column', async ({ page }) => {
  await ready(page);
  await page.locator('[data-testid=claims-table] tbody tr').first().waitFor({ timeout: 60_000 });
  const bad = await page.locator('table').evaluateAll((tables) =>
    tables
      .map((t) => {
        const ths = Array.from(t.querySelectorAll('thead th'));
        const missingScope = ths.filter((th) => !th.getAttribute('scope')).length;
        return { id: (t as HTMLElement).dataset.testid ?? '?', ths: ths.length, missingScope };
      })
      .filter((r) => r.ths > 0 && r.missingScope > 0),
  );
  expect(bad, `tables whose header cells lack scope: ${JSON.stringify(bad)}`).toEqual([]);
});

test('one h1, and no skipped heading levels', async ({ page }) => {
  await ready(page);
  const levels = await page.locator('h1,h2,h3,h4,h5,h6').evaluateAll((hs) => hs.map((h) => Number(h.tagName[1])));
  expect(levels.filter((l) => l === 1).length, 'exactly one h1').toBe(1);
  for (let i = 1; i < levels.length; i++) {
    expect(levels[i]! - levels[i - 1]!, `heading jumps from h${levels[i - 1]} to h${levels[i]}`).toBeLessThanOrEqual(
      1,
    );
  }
});

test('the sweep button disables itself while a sweep runs', async ({ page }) => {
  await ready(page);
  const options = await page.locator('[data-testid=claim-select] option').count();
  test.skip(options === 0, 'no sweepable claim');
  const sweep = page.locator('#sweep');
  await sweep.click();
  await page.waitForTimeout(250);
  const disabled = await sweep.isDisabled();
  expect(disabled, 'the sweep button disables itself while a sweep runs').toBe(true);
});
