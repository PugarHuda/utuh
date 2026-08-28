import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/// The console has to be usable by someone who cannot see it.
///
/// Not decoration: the page exists so that people who would never run a daemon can still refute a
/// claim or be underwritten, and "people" is not "sighted people with a mouse". axe runs the WCAG
/// 2.x A and AA rules over the rendered page — the real DOM, with the chain's answers in it — and
/// any violation fails the build, named, so the fix is a change to the page rather than a note in
/// a report nobody reads.
test('the rendered console has no WCAG A/AA violations', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();

  const named = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).join('\n    ')}`,
  );
  expect(named, named.join('\n')).toEqual([]);
});

test('the published build passes the same audit', async ({ page }) => {
  await page.goto('/static/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(
    results.violations.map((v) => `${v.id}: ${v.help}`),
    results.violations.map((v) => `${v.id}: ${v.help}`).join('\n'),
  ).toEqual([]);
});
