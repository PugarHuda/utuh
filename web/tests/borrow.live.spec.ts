import { expect, test, type Page } from '@playwright/test';
import { Contract, JsonRpcProvider, Wallet, concat, formatEther, keccak256, parseEther, toUtf8Bytes } from 'ethers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import {
  CC3_CHAIN_ID,
  CC3_RPC_DEFAULT,
  CHAIN_INFO_ADDRESS,
  CHAIN_KEY,
  PROVER_URL_DEFAULT,
  SOURCE_CHAIN_ID,
  SOURCE_RPC_DEFAULT,
} from '../../offchain/lib/networks';
import { injectWallet } from './wallet';

/// The whole underwriting, through the page, with a real wallet, on the live chain.
///
/// This is the test that makes the Borrow pane a claim rather than a hope. A borrower who has never
/// touched this repository, holding nothing but a key with a little Sepolia ETH and a little CTC,
/// pays a lender three times on Sepolia, binds their address from the page, builds the volume and
/// clean claims from the page, waits out the challenge window, opens a line and draws — and every
/// one of those is a real transaction against the published contracts.
///
/// It spends money and takes forty minutes, so it is off unless asked for:
///
///   UTUH_LIVE_UI=1 npm run web:test -- borrow.live
///
/// The borrower is a fresh key derived from the operator's, so a rerun reuses the same address and
/// nothing is stranded. Its history is made here, on purpose: nobody is underwritten on nothing,
/// and the three settlements are what the volume claim then proves.

const KEY = process.env.PRIVATE_KEY;
const ENABLED = process.env.UTUH_LIVE_UI === '1' && Boolean(KEY);

const ROOT = join(__dirname, '..', '..');
const SETTLEMENT = parseEther('0.001');
const BORROWER_SEPOLIA = parseEther('0.006');
const BORROWER_CTC = parseEther('8');
const LENDER_LIQUIDITY = parseEther('5');

function derive(master: string, role: string): string {
  return keccak256(concat([master, toUtf8Bytes(role)]));
}

function abi(file: string, name: string): unknown[] {
  return (JSON.parse(readFileSync(join(ROOT, 'out', file, `${name}.json`), 'utf8')) as { abi: unknown[] }).abi;
}

/// Wait for a step's log to say something, or for it to say it failed — and fail loudly on the
/// latter rather than timing out with no idea why.
async function untilLogged(page: Page, pattern: RegExp, timeout: number): Promise<string> {
  const log = page.locator('[data-testid=borrow-log]');
  await expect(log).toContainText(new RegExp(pattern.source + '|failed:|could not send'), { timeout });
  const text = await log.innerText();
  if (!pattern.test(text)) throw new Error(`the page reported a failure:\n${text}`);
  return text;
}

test.describe('a borrower in a fresh browser', () => {
  test.skip(!ENABLED, 'set UTUH_LIVE_UI=1 and PRIVATE_KEY');

  /// Read-only, one minute. The page has to show a borrower their own history from the chain
  /// alone — a settled line in a browser that never opened it — because the alternative, found by
  /// the run above, was a pane that forgot the line the moment it was paid off.
  test('sees their last line, settled or not, with nothing remembered', async ({ page }) => {
    const master = KEY!.startsWith('0x') ? KEY! : `0x${KEY!}`;
    const borrowerKey = derive(master, 'utuh/browser-borrower');
    const borrower = new Wallet(borrowerKey).address;
    const cc3 = new JsonRpcProvider(CC3_RPC_DEFAULT, CC3_CHAIN_ID, { staticNetwork: true });
    const record = JSON.parse(readFileSync(join(ROOT, 'deployments.full.json'), 'utf8')) as { credit: string };
    const credit = new Contract(record.credit, abi('UtuhCredit.sol', 'UtuhCredit') as never, cc3);

    const next = (await credit.nextLineId()) as bigint;
    let latest = 0n;
    for (let id = next - 1n; id >= 1n; id--) {
      if ((await credit.line(id)).subject.toLowerCase() === borrower.toLowerCase()) {
        latest = id;
        break;
      }
    }
    test.skip(latest === 0n, 'this borrower has never had a line');
    const status = ['None', 'Active', 'Settled', 'Defaulted', 'Closed'][Number((await credit.line(latest)).status)];

    await injectWallet(page, borrowerKey);
    await page.goto('/');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
    await page.locator('#connect').click();

    const pane = page.locator('#borrow-body');
    await expect(pane).toContainText(`line ${latest}`, { timeout: 90_000 });
    if (status !== 'Active') await expect(pane).toContainText(`line ${latest} is ${status}`);
  });
});

test.describe('borrowing from the browser', () => {
  test.skip(!ENABLED, 'set UTUH_LIVE_UI=1 and PRIVATE_KEY — this spends CTC and Sepolia ETH on live testnets');
  test.setTimeout(60 * 60_000);

  test('a stranger with a key is underwritten, opens a line and draws', async ({ page }) => {
    const master = KEY!.startsWith('0x') ? KEY! : `0x${KEY!}`;
    const borrowerKey = derive(master, 'utuh/browser-borrower');

    const cc3 = new JsonRpcProvider(CC3_RPC_DEFAULT, CC3_CHAIN_ID, { staticNetwork: true });
    const sepolia = new JsonRpcProvider(SOURCE_RPC_DEFAULT[CHAIN_KEY.sepolia], SOURCE_CHAIN_ID[CHAIN_KEY.sepolia], {
      staticNetwork: true,
    });
    const lenderCc3 = new Wallet(master, cc3);
    const lenderSepolia = new Wallet(master, sepolia);
    const borrowerSepolia = new Wallet(borrowerKey, sepolia);
    const borrower = borrowerSepolia.address;

    const record = JSON.parse(readFileSync(join(ROOT, 'deployments.full.json'), 'utf8')) as {
      registry: string;
      credit: string;
      ledger: string;
    };
    const credit = new Contract(record.credit, abi('UtuhCredit.sol', 'UtuhCredit') as never, lenderCc3);
    const registry = new Contract(record.registry, abi('UtuhRegistry.sol', 'UtuhRegistry') as never, cc3);
    const chainInfo = new Contract(CHAIN_INFO_ADDRESS, abi('IChainInfo.sol', 'IChainInfo') as never, cc3);
    const ledger = new Contract(
      record.ledger,
      abi('SettlementLedger.sol', 'SettlementLedger') as never,
      borrowerSepolia,
    );

    // ---------------------------------------------------------------- the world before
    // A borrower that already has a drawn line open — the last run of this test, interrupted
    // after drawing — picks up at repayment, because that is what a person would do, and because
    // the one-line rule would refuse a second underwriting until the first is closed.
    const existing = (await credit.activeLineOf(borrower)) as bigint;
    const resume = existing !== 0n && (await credit.line(existing)).drawn > 0n;
    console.log(`borrower ${borrower}${resume ? ` — resuming line ${existing}` : ''}`);
    await topUp(lenderSepolia, borrower, BORROWER_SEPOLIA, 'Sepolia ETH');
    await topUp(lenderCc3, borrower, BORROWER_CTC, 'CTC');

    // ---------------------------------------------------------------- a history to be underwritten on
    const blocks: number[] = [];
    for (let i = 0; i < (resume ? 0 : 3); i++) {
      const r = await (await ledger.settle(lenderCc3.address, { value: SETTLEMENT })).wait();
      blocks.push(r!.blockNumber);
      console.log(
        `settlement ${i + 1}: ${formatEther(SETTLEMENT)} ETH to the lender, Sepolia block ${r!.blockNumber}`,
      );
    }

    // The lender funds what the line will draw on. Master is LENDER on this deployment.
    await (await credit.fund({ value: LENDER_LIQUIDITY })).wait();

    // ---------------------------------------------------------------- the page
    await injectWallet(page, borrowerKey);
    await page.goto('/');
    await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
    await page.locator('#connect').click();
    await expect(page.locator('#connect')).toContainText(borrower.slice(0, 6));

    const pane = page.locator('#borrow-body');
    let lineId: bigint;
    if (resume) {
      lineId = existing;
    } else {
      // A borrower bound by an earlier run stays bound; the page shows that and skips the step.
      const alreadyBound = (await credit.controllerOf(borrower)).toLowerCase() === borrower.toLowerCase();
      let bindBlock = Math.max(...blocks);
      if (alreadyBound) {
        await expect(pane).toContainText(`Bound: controllerOf(${borrower})`, { timeout: 60_000 });
      } else {
        await expect(pane.locator('[data-testid=send-commitment]')).toBeVisible({ timeout: 60_000 });

        // ---------------------------------------------------------------- 1. bind, from the page
        await pane.locator('[data-testid=send-commitment]').click();
        const sent = await untilLogged(page, /sent on Ethereum Sepolia: (0x[0-9a-f]{64})/, 120_000);
        const bindHash = sent.match(/sent on Ethereum Sepolia: (0x[0-9a-f]{64})/)![1]!;
        await expect(pane.locator('[data-testid=bind-hash]')).toHaveValue(bindHash);

        // The wallet answers with the hash the moment it has broadcast, the way a wallet does; the
        // block comes later. Asking for the receipt before it exists got `null` here, once.
        bindBlock = (await sepolia.waitForTransaction(bindHash))!.blockNumber;
        console.log(`commitment in Sepolia block ${bindBlock}; waiting for Creditcoin to attest it`);
        await attested(chainInfo, CHAIN_KEY.sepolia, bindBlock);

        // The precompile saying "attested" and the hosted builder having the proof ready are two
        // different moments, and the builder's answer to a request in between is to hold the
        // connection while it builds — measured at over three minutes once, then three seconds for
        // the same proof afterwards. The page tells a person to wait and press again; this does the
        // same, and asks the builder directly first so the press lands on a proof that exists.
        await proofReady(CHAIN_KEY.sepolia, bindHash);
        for (let attempt = 1; ; attempt++) {
          const logged = (await page.locator('[data-testid=borrow-log]').innerText()).length;
          await pane.locator('[data-testid=prove-control]').click();
          const outcome = await expect
            .poll(
              async () => {
                if ((await pane.innerText()).includes(`Bound: controllerOf(${borrower})`)) return 'bound';
                const fresh = (await page.locator('[data-testid=borrow-log]').innerText()).slice(logged);
                return /binding failed/.test(fresh) ? `failed: ${fresh.trim()}` : 'pending';
              },
              { timeout: 150_000, intervals: [2_000] },
            )
            .not.toBe('pending')
            .then(async () => ((await pane.innerText()).includes('Bound:') ? 'bound' : 'failed'))
            .catch(() => 'pending');
          if (outcome === 'bound') break;
          if (attempt >= 6) throw new Error(`the commitment never bound after ${attempt} attempts`);
          console.log(`prove attempt ${attempt} did not bind (${outcome}); pressing again in 20s`);
          await page.reload();
          await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 90_000 });
          await page.locator('#connect').click();
          await expect(pane.locator('[data-testid=prove-control]')).toBeVisible({ timeout: 60_000 });
          await pane.locator('[data-testid=bind-hash]').fill(bindHash);
          await new Promise((r) => setTimeout(r, 20_000));
        }
        expect((await credit.controllerOf(borrower)).toLowerCase()).toBe(borrower.toLowerCase());
      }

      // ---------------------------------------------------------------- 2. the two claims, from the page
      // At least the lender's minimum span — the settlements sit in consecutive blocks, and a range
      // that only just covers them is shorter than that. The page now refuses such a range before
      // any bond is posted; this is the number it checks against.
      const minHistory = Number(await credit.MIN_HISTORY_BLOCKS());
      const from = Math.min(...blocks) - 1;
      const to = Math.max(bindBlock, ...blocks, from + minHistory) + 1;
      await pane.locator('[data-testid=range-from]').fill(String(from));
      await pane.locator('[data-testid=range-to]').fill(String(to));

      await pane.locator('[data-testid=build-volume]').click();
      await untilLogged(page, /claim (\d+) sealed/, 15 * 60_000);
      await expect(pane.locator('[data-testid=build-volume]')).toContainText(/volume claim \d+ built/, {
        timeout: 60_000,
      });

      // The pane re-renders after a build, so the range has to be set again for the second one.
      await pane.locator('[data-testid=range-from]').fill(String(from));
      await pane.locator('[data-testid=range-to]').fill(String(to));
      await pane.locator('[data-testid=build-clean]').click();
      await expect(pane.locator('[data-testid=build-clean]')).toContainText(/clean claim\(s\) \d+ built/, {
        timeout: 15 * 60_000,
      });

      const volumeId = BigInt((await pane.locator('[data-testid=build-volume]').innerText()).match(/\d+/)![0]);
      const cleanId = BigInt((await pane.locator('[data-testid=build-clean]').innerText()).match(/\d+/)![0]);
      console.log(`volume claim ${volumeId}, clean claim ${cleanId}`);

      // What the registry holds is what was swept: three proven settlements, and nothing adverse.
      expect(await registry.memberCount(volumeId)).toBe(3n);
      expect((await registry.claim(volumeId)).aggregate).toBe(3n * SETTLEMENT);
      expect(await registry.memberCount(cleanId)).toBe(0n);

      // ---------------------------------------------------------------- 3. the window, and finalizing
      const until = Math.max(
        Number(await registry.challengeUntil(volumeId)),
        Number(await registry.challengeUntil(cleanId)),
      );
      console.log(`challenge windows close at CC3 block ${until}`);
      await waitForBlock(cc3, until + 1);

      await expect(pane.locator('[data-testid=finalize-claims]')).toBeVisible();
      await pane.locator('[data-testid=finalize-claims]').click();
      await expect(pane.locator('[data-testid=open-line]')).toBeVisible({ timeout: 180_000 });
      expect(Number((await registry.claim(volumeId)).status)).toBe(3);
      expect(Number((await registry.claim(cleanId)).status)).toBe(3);

      // ---------------------------------------------------------------- 4. the line, and a draw
      await pane.locator('[data-testid=open-line]').click();
      await untilLogged(page, /line (\d+) open, limit ([\d.]+) CTC/, 180_000);
      await expect(pane.locator('[data-testid=draw]')).toBeVisible({ timeout: 60_000 });

      lineId = await credit.activeLineOf(borrower);
      expect(lineId).not.toBe(0n);
      const line = await credit.line(lineId);
      // 0.003 ETH at 20,000 CTC/ETH and 20% LTV would justify 12 CTC; a 1 CTC bond guarantees a
      // 0.5 CTC loss, times BOND_MULTIPLE 10, caps it at 5. The guarantee is what lends.
      expect(line.limit).toBe(parseEther('5'));

      await pane.locator('[data-testid=draw-amount]').fill('1');
      await pane.locator('[data-testid=draw]').click();
      await untilLogged(page, /drawn\. \d+ source units must be proven repaid/, 180_000);

      expect((await credit.line(lineId)).drawn).toBe(parseEther('1'));
      console.log(`line ${lineId}: limit ${formatEther(line.limit)} CTC, drew 1 CTC, from a browser`);
    }

    // ---------------------------------------------------------------- 5. repay, prove it, settle
    // The other half of the loop, also from the page: pay the lender through the ledger with the
    // same wallet, build the repayment claim, wait out its window, settle. Drawing 1 CTC at 20,000
    // CTC/ETH and 105% obliges 0.0000525 ETH back — the page's own figure, read off the line.
    const owed = (await credit.line(lineId)).repayRequired as bigint;
    await pane.locator('[data-testid=pay-ledger]').click();
    const paid = await untilLogged(page, /sent on Ethereum Sepolia: (0x[0-9a-f]{64})/, 120_000);
    const payHash = paid
      .match(/sent on Ethereum Sepolia: (0x[0-9a-f]{64})/g)!
      .pop()!
      .slice(-66);
    const payBlock = (await sepolia.waitForTransaction(payHash))!.blockNumber;
    console.log(`repaid ${formatEther(owed)} ETH in Sepolia block ${payBlock}`);

    await pane.locator('[data-testid=repay-from]').fill(String(payBlock - 1));
    await pane.locator('[data-testid=repay-to]').fill(String(payBlock + 1));
    await pane.locator('[data-testid=build-repay]').click();
    await untilLogged(page, /claim (\d+) sealed/, 15 * 60_000);
    await expect(pane.locator('[data-testid=finalize-repay]')).toBeVisible({ timeout: 60_000 });

    const repayId = BigInt((await pane.innerText()).match(/repayment claim (\d+)/)![1]!);
    expect((await registry.claim(repayId)).aggregate).toBe(owed);
    console.log(`repayment claim ${repayId} proves ${owed} — waiting out its window`);
    await waitForBlock(cc3, Number(await registry.challengeUntil(repayId)) + 1);

    await pane.locator('[data-testid=finalize-repay]').click();
    await expect(pane.locator('[data-testid=settle-line]')).toBeVisible({ timeout: 180_000 });
    await pane.locator('[data-testid=settle-line]').click();
    await untilLogged(page, /settling line \d+ with claim \d+/, 180_000);
    await expect(pane).toContainText(`line ${lineId} is Settled`, { timeout: 120_000 });

    expect(Number((await credit.line(lineId)).status)).toBe(2);
    expect(await credit.activeLineOf(borrower)).toBe(0n);
    expect(Number(await credit.settledThrough(borrower))).toBe(payBlock + 2);
    console.log(`line ${lineId} settled from the browser; the slot is free again`);
  });
});

/// Ask the hosted builder for the proof until it hands one over, with a short leash per ask.
async function proofReady(chainKey: number, txHash: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`${PROVER_URL_DEFAULT}/api/v1/proof-by-tx/${chainKey}/${txHash}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok && (await res.json()).txBytes) return;
    } catch {
      /* still building, or still not indexed */
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error(`the proof builder never produced a proof for ${txHash}`);
}

async function topUp(from: Wallet, to: string, target: bigint, what: string): Promise<void> {
  const have = await from.provider!.getBalance(to);
  if (have >= target) return;
  await (await from.sendTransaction({ to, value: target - have })).wait();
  console.log(`sent ${formatEther(target - have)} ${what} to the borrower`);
}

async function attested(chainInfo: Contract, chainKey: number, height: number): Promise<void> {
  for (;;) {
    const frontier = Number((await chainInfo.get_latest_attestation_height_and_hash(chainKey)).height);
    if (frontier >= height) return;
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

async function waitForBlock(provider: JsonRpcProvider, target: number): Promise<void> {
  while ((await provider.getBlockNumber()) < target) await new Promise((r) => setTimeout(r, 10_000));
}
