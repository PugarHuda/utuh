import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/// The Content-Security-Policy the published site can be served with, proven against the page.
///
/// Every origin below is one the browser really calls: the CC3 RPC and Blockscout's proxy for it,
/// Creditcoin Mainnet's RPC (the attestor audit reads its precompile), both attestation indexers,
/// both Proof Builder hostnames, and every independent Ethereum and Sepolia endpoint a sweep asks.
/// Fonts, styles and the bundle are the site's own. Nothing is inline except one hashed redirect
/// script on the landing, and the static build's baked record, which is a JSON data block the
/// browser never executes. There is no 'unsafe-inline' and no 'unsafe-eval'.
///
/// The header is injected through `page.route` onto the static build — the bytes a host serves — and
/// a `securitypolicyviolation` listener installed before the first byte must stay empty while the
/// page boots, audits both attestor sets, sweeps, and falls back to Blockscout.

const REDIRECT = /<script>([\s\S]*?)<\/script>/;

export const CONNECT = [
  'https://rpc.cc3-testnet.creditcoin.network',
  'https://creditcoin-testnet.blockscout.com',
  'https://rpc.cc3-mainnet.creditcoin.network',
  'https://attestations-graphql.cc3-testnet.creditcoin.network',
  'https://attestations-graphql.cc3-mainnet-usc.creditcoin.network',
  'https://prover.cc3-testnet.creditcoin.network',
  'https://proof-gen-api.cc3-testnet.creditcoin.network',
  'https://gateway.tenderly.co',
  'https://sepolia.gateway.tenderly.co',
  'https://0xrpc.io',
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.ethpandaops.io',
];

/// The landing's one inline script, hashed as the browser hashes it: its exact text, whitespace
/// included. Edit that script and this hash, and the header that carries it, must change together.
const REDIRECT_HASH = 'sha256-6jdd9oby6YxJF0wyL886AGjTOSQZmYTkznVuCuYU/bc=';

export const CSP = [
  "default-src 'none'",
  `script-src 'self' '${REDIRECT_HASH}'`,
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  `connect-src 'self' ${CONNECT.join(' ')}`,
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

const ROOT = join(__dirname, '..', '..');

test('the hash in the policy is the hash of the landing script as it is written', () => {
  const script = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8').match(REDIRECT)?.[1];
  expect(script, 'the landing has its inline redirect').toBeDefined();
  const hash = `sha256-${createHash('sha256').update(script!).digest('base64')}`;
  expect(hash, 'web/index.html changed its inline script; update REDIRECT_HASH and the served header').toBe(
    REDIRECT_HASH,
  );
});

test('every origin the page can call is in connect-src, and nothing else is', () => {
  // The browser bundle's own list of hosts, read out of the source it is built from. A new endpoint
  // added to networks.ts without a line here fails this test rather than a visitor's sweep.
  const sources = ['offchain/lib/networks.ts', 'web/chain.ts'].map((f) => readFileSync(join(ROOT, f), 'utf8'));
  const named = new Set<string>();
  for (const s of sources) for (const m of s.matchAll(/'(https:\/\/[^'/]+)[^']*'/g)) named.add(m[1]!);
  // Hosts networks.ts names for people to open, not for the page to call.
  for (const link of [
    'https://eth.blockscout.com',
    'https://eth-sepolia.blockscout.com',
    'https://dashboard.cc3-testnet.creditcoin.network',
  ]) {
    named.delete(link);
  }
  expect([...named].sort()).toEqual([...CONNECT].sort());
});

test('if vercel.json serves a policy, it is this one', () => {
  const file = join(ROOT, 'vercel.json');
  const config = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { headers?: { headers: { key: string; value: string }[] }[] })
    : {};
  const served = (config.headers ?? [])
    .flatMap((h) => h.headers)
    .filter((h) => h.key.toLowerCase() === 'content-security-policy')
    .map((h) => h.value);
  // `frame-ancestors` is header-only and belongs there; everything else must be exactly this policy.
  for (const value of served) {
    expect(value.replace(/;\s*frame-ancestors 'none'/, '')).toBe(CSP);
  }
});

async function underPolicy(page: Page): Promise<string[]> {
  test.skip(!!process.env.PUBLISHED_URL, 'the header is injected onto the local static build');
  await page.route(
    (url) => url.pathname.startsWith('/static'),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': CSP } });
    },
  );
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (e) =>
      seen.push(`${e.effectiveDirective} blocked ${e.blockedURI}`),
    );
  });
  return [];
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test('the landing runs under the policy with no violation', async ({ page }) => {
  await underPolicy(page);
  await page.goto('/static/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  await expect(page.locator('[data-testid=tally]')).toHaveAttribute('data-ready', 'true', { timeout: 170_000 });
  expect(await page.evaluate(() => document.fonts.check('16px Archivo'))).toBe(true);
  expect(await violations(page)).toEqual([]);

  // The redirect script is allowed by its hash, not by accident: a claim link still goes through.
  await page.goto('/static/?claim=5');
  await page.waitForURL((u) => u.pathname.endsWith('/static/app/'));
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
  expect(await violations(page)).toEqual([]);
});

test('the console boots, audits the attestors and sweeps under the policy with no violation', async ({ page }) => {
  test.setTimeout(420_000);
  await underPolicy(page);
  await page.goto('/static/app/?deployment=mainnet');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
  // Both indexers, Creditcoin Mainnet's RPC, and the mainnet endpoints the audit compares against.
  await expect(page.locator('[data-testid=attestors-table-1]')).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#attestors-body .bad')).toHaveCount(0);
  expect(await violations(page)).toEqual([]);

  // A sweep on the Sepolia registry reaches all four Sepolia endpoints.
  await page.goto('/static/app/?claim=5');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 120_000 });
  await page.locator('#sweep').click();
  await expect(page.locator('#log')).toContainText(/no gap found|INCOMPLETE|settles nothing|inconclusive/, {
    timeout: 240_000,
  });
  expect(await violations(page)).toEqual([]);

  // The Proof Builder is only called when a refutation is sent, which needs a signature this suite
  // never gives. So ask both hostnames from the page itself: connect-src decides whether the request
  // leaves, whatever the builder answers.
  const builders = await page.evaluate(
    async (hosts) => {
      const out: string[] = [];
      for (const h of hosts) {
        try {
          await fetch(`${h}/api/v1/proof-by-tx/1/0x${'0'.repeat(64)}`, { signal: AbortSignal.timeout(20_000) });
          out.push('reached');
        } catch (e) {
          out.push(String((e as Error).name));
        }
      }
      return out;
    },
    CONNECT.filter((h) => h.includes('pro')),
  );
  expect(builders.length).toBe(2);
  expect(await violations(page)).toEqual([]);

  // And the policy is live, not vacuous: a host that is not on the list is refused, and reported.
  await page.evaluate(() => fetch('https://example.com/').catch(() => undefined));
  await expect.poll(() => violations(page)).toEqual(['connect-src blocked https://example.com/']);
});

test('with the CC3 RPC down, the Blockscout fallback is inside the policy too', async ({ page }) => {
  test.setTimeout(240_000);
  await underPolicy(page);
  await page.route('**/rpc.cc3-testnet.creditcoin.network/**', (route) => route.abort('connectionrefused'));
  await page.goto('/static/app/');
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 180_000 });
  await expect(page.locator('#rpc-route')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
