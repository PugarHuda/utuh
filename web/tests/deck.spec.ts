import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/// The deck is a PDF nobody reads in a browser, which is exactly why it needs a test.
///
/// Each slide is one fixed 1280x720 page. Overflowing content is not an error, a warning, or a
/// scrollbar — it slides silently under the footer rule and prints that way, and the first person
/// to notice is a judge. Editing one sentence is enough to cause it. So: every slide's content
/// must end above its own footer, measured in a real browser at the size the PDF is rendered at.
///
/// Anything clipped by an `overflow: hidden` ancestor is skipped, because a cropped screenshot is
/// deliberately larger than its frame and is not what this is looking for.
test('no slide overflows its own page', async ({ page }) => {
  await page.goto(pathToFileURL(join(process.cwd(), 'web', 'deck.html')).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);

  const slides = page.locator('.slide');
  await expect(slides).toHaveCount(12);

  const overflowing = await page.evaluate(() =>
    [...document.querySelectorAll('.slide')]
      .map((s, i) => {
        const foot = s.querySelector('.foot')!.getBoundingClientRect();
        let worst = 0;
        let who = '';
        for (const el of (s.querySelector('.fill') ?? s).querySelectorAll('*')) {
          const r = el.getBoundingClientRect();
          if (r.height === 0) continue;
          let clipped = false;
          for (let a = el.parentElement; a && a !== s; a = a.parentElement) {
            if (getComputedStyle(a).overflow === 'hidden') {
              clipped = true;
              break;
            }
          }
          if (clipped) continue;
          const past = Math.round(r.bottom - foot.top + 8);
          if (past > worst) {
            worst = past;
            who = el.tagName.toLowerCase() + (el.className ? `.${el.className}` : '');
          }
        }
        return { slide: i + 1, past: worst, who };
      })
      .filter((o) => o.past > 0)
      .map((o) => `slide ${o.slide}: ${o.who} runs ${o.past}px past the footer`),
  );

  expect(overflowing, 'a slide printed over its own footer — shorten it or shrink the type').toEqual([]);
});
