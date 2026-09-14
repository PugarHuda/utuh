import { defineConfig, devices } from '@playwright/test';

/// The console's tests drive a real browser against the live CC3 testnet.
///
/// Nothing is stubbed: the page under test talks to `rpc.cc3-testnet.creditcoin.network` and to
/// public Ethereum endpoints exactly as it does for anyone else, so a red run means either this
/// repository broke or the chain did — and both are worth knowing. That also sets the timeouts,
/// which are generous because a source-chain sweep is a real sweep.
export default defineConfig({
  testDir: './web/tests',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // One page at a time. The suite reads a shared chain, and parallel sweeps against free public
  // endpoints earn rate limits rather than speed.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    // PUBLISHED_URL points the suite at the console GitHub Pages serves rather than at a local
    // server — the smoke test the watch workflow runs hourly against the thing people actually open.
    baseURL: process.env.PUBLISHED_URL ?? `http://127.0.0.1:${process.env.WEB_PORT ?? 5173}`,
    trace: 'retain-on-failure',
    // A Vercel preview sits behind Vercel Authentication. CI fetches the bypass cookie and hands it
    // over as a storage state — a cookie, scoped to the preview's own host, rather than a header that
    // would ride on every cross-origin RPC fetch and draw CORS preflights the public endpoints refuse.
    ...(process.env.PW_STORAGE_STATE ? { storageState: process.env.PW_STORAGE_STATE } : {}),
  },
  // Baselines live beside the specs, one per project, and carry no platform suffix: they are
  // rendered on Chromium and compared with a small pixel tolerance, so a font hinting difference
  // is noise and a moved column is not.
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}{ext}',
  // Three engines. Safari's is the one a judge on a Mac opens, and the one that disagrees about
  // `color-mix`, variable-font stretch and `scrollIntoView`. A test that can only mean something on
  // Chromium (the DevTools protocol, or a baseline rendered there) carries `@chromium` in its title
  // with the reason beside it, and the other two projects skip it by that tag.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grepInvert: /@chromium/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grepInvert: /@chromium/ },
  ],
  // No local server when the target is the published page — spread in rather than set to
  // undefined, because `exactOptionalPropertyTypes` is on and means it.
  ...(process.env.PUBLISHED_URL
    ? {}
    : {
        webServer: {
          command: 'npm run web',
          url: `http://127.0.0.1:${process.env.WEB_PORT ?? 5173}`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          stdout: 'pipe' as const,
        },
      }),
});
