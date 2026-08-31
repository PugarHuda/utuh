import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runScript } from '../offchain/lib/cli';

/// The whitepaper, on paper.
///
/// `web/whitepaper.html` is the source of truth; this renders it to the PDF the submission form
/// asks for. Chromium is already here for the browser suite, so nothing new is installed to do it,
/// and the deck carries a `@media print` block of its own — this step only asks a browser to
/// honour it.
///
/// The typefaces come from Google's CDN at render time and are embedded into the PDF, so the file
/// that ships reads with no network at all. That is also why the HTML itself is not published: a
/// reader of the PDF fetches nothing, and the console keeps the property its own tests assert —
/// that it asks its host for its own files and nobody else's.
///
/// The PDF is committed, because the workflow that publishes the console has no browser and adding
/// one would install Chromium on every push to render a document that changes monthly. A committed
/// build can go stale, though, so the source's digest is committed beside it and `web:static`
/// refuses to publish a PDF whose source has moved since it was rendered.
///
///   npm run web:pdf      → web/whitepaper.pdf, web/whitepaper.sha256

const WEB = __dirname;

// A document that renders to nothing still writes a valid, tiny PDF, and an empty deck is the one
// failure that would sail through a submission. The real one is an order of magnitude over this.
const FLOOR = 40_000;

async function main(): Promise<void> {
  const source = join(WEB, 'whitepaper.html');
  const out = join(WEB, 'whitepaper.pdf');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
    // Web fonts arrive after `load`, and a PDF taken a moment early sets the whole document in the
    // fallback stack without failing.
    await page.evaluate(() => document.fonts.ready);
    await page.pdf({
      path: out,
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
    });
  } finally {
    await browser.close();
  }

  const { size } = statSync(out);
  if (size < FLOOR) throw new Error(`whitepaper.pdf is ${size} bytes, under the ${FLOOR} floor`);

  const digest = createHash('sha256').update(readFileSync(source)).digest('hex');
  writeFileSync(join(WEB, 'whitepaper.sha256'), digest);
  console.log(`web/whitepaper.pdf  ${(size / 1024).toFixed(0)} KB`);
}

runScript(main);
