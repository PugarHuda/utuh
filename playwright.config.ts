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
    baseURL: `http://127.0.0.1:${process.env.WEB_PORT ?? 5173}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run web',
    url: `http://127.0.0.1:${process.env.WEB_PORT ?? 5173}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
  },
});
