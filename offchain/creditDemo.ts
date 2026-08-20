import { Contract, formatEther, formatUnits, parseEther, getAddress, zeroPadValue } from 'ethers';
import chainInfoAbi from '@gluwa/usc-sdk/dist/chain-info/chain_info.json';
import 'dotenv/config';
import {
  CC3_RPC,
  CC3_CHAIN_ID,
  CHAIN_KEY,
  PROVER_URL,
  AAVE_V3_POOL,
  USDC,
  AAVE_REPAY_SIG,
  AAVE_LIQUIDATION_SIG,
  source,
  requirePrivateKey,
} from './config';
import { readDeployments, registryAt, creditAt, signer } from './lib/contracts';
import { scopeFor, scanScope, Metric, type Scope, type ScopedEvent } from './lib/scope';
import { Prover } from './lib/proofs';
import { buildClaim, refuteClaim } from './lib/claims';

const CHAIN_INFO = '0x0000000000000000000000000000000000000fD3';
const BOND = parseEther(process.env.BOND ?? '2');

/// Mirrors UtuhCredit.MIN_HISTORY_BLOCKS: a clean window shorter than this says very little.
const HISTORY_BLOCKS = 216_001;
/// Stay behind the attestation frontier so every block in the range is provable.
const FRONTIER_LAG = 60;

async function main() {
  const d = readDeployments();
  if (!d.registry || !d.credit) throw new Error('no deployments.json — run: npm run deploy');

  const wallet = signer(CC3_RPC, CC3_CHAIN_ID, requirePrivateKey());
  const registry = registryAt(d.registry, wallet);
  const credit = creditAt(d.credit, wallet);
  const chainInfo = new Contract(CHAIN_INFO, chainInfoAbi as any, wallet.provider!);
  const ck = CHAIN_KEY.mainnet;
  const eth = source(ck);
  const prover = new Prover(ck, PROVER_URL, 60000);
  const minWindow = Number(await registry.MIN_CHALLENGE_WINDOW());

  const frontier = Number((await chainInfo.get_latest_attestation_height_and_hash(ck))[0]);
  const toBlock = frontier - FRONTIER_LAG;
  const fromBlock = toBlock - HISTORY_BLOCKS;
  console.log(`Ethereum mainnet attested up to ${frontier}`);
  console.log(`underwriting window ${fromBlock}..${toBlock} (${HISTORY_BLOCKS} blocks, ~30 days)\n`);

  // ------------------------------------------------------------------
  // Sweep the window once. Both roles read the same chain: the borrower to assemble a claim, the
  // watcher to check one.
  // ------------------------------------------------------------------
  console.log('sweeping Aave V3 Pool over the window...');
  // Only the USDC reserve. Repay carries `amount` in the reserve asset's own decimals, so summing
  // across reserves would add WETH's 18 decimals to USDC's 6 and call the result a credit history.
  const allRepays = await eth.getLogs({
    address: AAVE_V3_POOL,
    topics: [AAVE_REPAY_SIG, zeroPadValue(USDC, 32)],
    fromBlock,
    toBlock,
  });
  const allLiquidations = await eth.getLogs({
    address: AAVE_V3_POOL,
    topics: [AAVE_LIQUIDATION_SIG],
    fromBlock,
    toBlock,
  });
  console.log(`  ${allRepays.length} USDC Repay events, ${allLiquidations.length} LiquidationCall events`);

  const liquidatedUsers = new Set(allLiquidations.map((l) => getAddress('0x' + l.topics[3].slice(26))));
  const repayCount = new Map<string, number>();
  for (const l of allRepays) {
    const user = getAddress('0x' + l.topics[2].slice(26));
    repayCount.set(user, (repayCount.get(user) ?? 0) + 1);
  }

  const goodBorrower =
    (process.env.BORROWER && getAddress(process.env.BORROWER)) ||
    pickBorrower(repayCount, liquidatedUsers);
  if (!goodBorrower) throw new Error('no borrower with 2-6 repayments and no liquidation in this window');

  const liquidatedBorrower = [...liquidatedUsers].find((u) => (repayCount.get(u) ?? 0) > 0) ?? [...liquidatedUsers][0];

  console.log(`\n  clean borrower     ${goodBorrower}  (${repayCount.get(goodBorrower)} repayments, 0 liquidations)`);
  console.log(`  liquidated address ${liquidatedBorrower}  (appears in LiquidationCall)`);

  const volumeScope = (subject: string): Scope =>
    scopeFor({
      chainKey: ck,
      emitter: AAVE_V3_POOL,
      eventSig: AAVE_REPAY_SIG,
      subject,
      subjectTopic: 2,
      pin: { topic: 1, value: USDC },
      metric: Metric.DATA_WORD,
      metricArg: 0,
    });
  const cleanScope = (subject: string): Scope =>
    scopeFor({
      chainKey: ck,
      emitter: AAVE_V3_POOL,
      eventSig: AAVE_LIQUIDATION_SIG,
      subject,
      subjectTopic: 3,
      metric: Metric.COUNT,
    });

  // ------------------------------------------------------------------
  console.log('\n=== 1. underwriting a real borrower ===');
  const volumeEvents = await scanScope(eth, volumeScope(goodBorrower), fromBlock, toBlock, HISTORY_BLOCKS);
  const cleanEvents = await scanScope(eth, cleanScope(goodBorrower), fromBlock, toBlock, HISTORY_BLOCKS);
  console.log(`  volume: ${volumeEvents.length} proven Aave USDC repayments`);
  for (const e of volumeEvents) {
    console.log(`    block ${e.blockNumber}  ${formatUnits(e.value, 6)} USDC`);
  }
  console.log(`  clean:  ${cleanEvents.length} liquidations — the claim asserts this set is empty`);

  console.log('\n  building volume claim (each member verified by the Block Prover)...');
  const volumeClaim = await buildClaim(registry, prover, volumeScope(goodBorrower), fromBlock, toBlock, volumeEvents, {
    bond: BOND,
    challengeWindow: minWindow,
    log: (m) => console.log('   ' + m),
  });

  console.log('  building clean claim (empty set, bonded)...');
  const cleanClaim = await buildClaim(registry, prover, cleanScope(goodBorrower), fromBlock, toBlock, cleanEvents, {
    bond: BOND,
    challengeWindow: minWindow,
    log: (m) => console.log('   ' + m),
  });

  // ------------------------------------------------------------------
  console.log('\n=== 2. a false clean claim, and what happens to it ===');
  const realLiquidations = await scanScope(
    eth,
    cleanScope(liquidatedBorrower),
    fromBlock,
    toBlock,
    HISTORY_BLOCKS,
  );
  console.log(`  ${liquidatedBorrower} was liquidated ${realLiquidations.length} time(s) in this window`);
  console.log('  filing a clean claim anyway — asserting the set is empty');

  const falseClaim = await buildClaim(
    registry,
    prover,
    cleanScope(liquidatedBorrower),
    fromBlock,
    toBlock,
    [],
    { bond: BOND, challengeWindow: minWindow, log: (m) => console.log('   ' + m) },
  );

  const before = await wallet.provider!.getBalance(wallet.address);
  const { reward, key } = await refuteClaim(registry, prover, falseClaim.claimId, realLiquidations[0]);
  const after = await wallet.provider!.getBalance(wallet.address);
  const refuted = await registry.claim(falseClaim.claimId);

  console.log(`  refuted with one real liquidation proof. key ${key}`);
  console.log(`  status ${statusName(refuted.status)}  reward ${formatEther(reward)} CTC`);
  console.log(`  watcher balance ${formatEther(before)} -> ${formatEther(after)} CTC`);
  if (Number(refuted.status) !== 4) throw new Error('false clean claim should be Refuted');

  // ------------------------------------------------------------------
  console.log('\n=== 3. finalizing the honest claims ===');
  const until = Number(await registry.challengeUntil(cleanClaim.claimId));
  await waitForBlock(wallet, until + 1);
  for (const [name, id] of [
    ['volume', volumeClaim.claimId],
    ['clean', cleanClaim.claimId],
  ] as const) {
    const tx = await registry.finalize(id);
    await tx.wait();
    const c = await registry.claim(id);
    const shown = name === 'volume' ? `${formatUnits(c.aggregate, 6)} USDC` : `${c.aggregate}`;
    console.log(`  ${name} claim ${id}: ${statusName(c.status)}  aggregate ${shown}`);
  }

  // ------------------------------------------------------------------
  console.log('\n=== 4. opening the credit line ===');
  const volumeAggregate: bigint = (await registry.claim(volumeClaim.claimId)).aggregate;
  const cleanBond: bigint = (await registry.claim(cleanClaim.claimId)).bondPosted;
  const openTx = await credit.openLine(goodBorrower, volumeClaim.claimId, cleanClaim.claimId);
  const openReceipt = await openTx.wait();
  const lineId = readLineId(credit, openReceipt);
  const line = await credit.line(lineId);
  console.log(`  line ${lineId} for ${goodBorrower}`);
  const rate = await credit.VOLUME_UNIT_IN_CTC();
  const uncapped = (volumeAggregate * BigInt(rate) * 2000n) / 10_000n;
  console.log(`  proven volume ${formatUnits(volumeAggregate, 6)} USDC at ${rate} wei/unit`);
  console.log(`  20% of that = ${formatEther(uncapped)} CTC`);
  console.log(`  bond cap    = ${formatEther(cleanBond * 10n)} CTC  (10x the clean claim's bond)`);
  console.log(`  limit ${formatEther(line.limit)} CTC`);

  const fundAmount = line.limit;
  const bal = await wallet.provider!.getBalance(wallet.address);
  if (bal > fundAmount + parseEther('1')) {
    await (await credit.fund({ value: fundAmount })).wait();
    console.log(`  lender funded ${formatEther(fundAmount)} CTC`);

    const drawTx = await credit.draw(lineId, fundAmount, 1_000_000n, 30);
    await drawTx.wait();
    const drawn = await credit.line(lineId);
    console.log(`  borrower drew ${formatEther(drawn.drawn)} CTC on Creditcoin`);
    console.log(`  must prove 1.0 USDC repaid to the lender on Ethereum by CC3 block ${drawn.dueBlock}`);
    console.log('  no proof by then and the line defaults — the contract never has to show a payment was missed');
  } else {
    console.log('  skipping draw: not enough CTC left to fund the line');
  }

  console.log('\nDone.');
}

function pickBorrower(repayCount: Map<string, number>, liquidated: Set<string>): string | null {
  for (const [user, n] of repayCount) {
    if (n >= 2 && n <= 6 && !liquidated.has(user)) return user;
  }
  return null;
}

function readLineId(credit: Contract, receipt: any): bigint {
  for (const rawLog of receipt.logs) {
    try {
      const parsed = credit.interface.parseLog(rawLog);
      if (parsed?.name === 'LineOpened') return parsed.args[0] as bigint;
    } catch {
      /* not ours */
    }
  }
  throw new Error('LineOpened not found');
}

function statusName(s: bigint | number): string {
  return ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'][Number(s)] ?? String(s);
}

async function waitForBlock(wallet: any, target: number): Promise<void> {
  for (;;) {
    const now = await wallet.provider.getBlockNumber();
    if (now >= target) {
      process.stdout.write('\r');
      return;
    }
    process.stdout.write(`\r  waiting for CC3 block ${target}, at ${now}   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + (e.stack ?? e.message));
    process.exit(1);
  });
