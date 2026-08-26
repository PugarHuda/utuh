import { formatEther, formatUnits, parseEther, getAddress, zeroPadValue } from 'ethers';
import 'dotenv/config';
import {
  CC3_RPC,
  CC3_CHAIN_ID,
  CHAIN_KEY,
  AAVE_V3_POOL,
  USDC,
  AAVE_REPAY_SIG,
  AAVE_LIQUIDATION_SIG,
  source,
  requirePrivateKey,
} from './config';
import { readDeployments, registryAt, creditAt, signer } from './lib/contracts';
import { chainInfoAt, waitForBlock } from './lib/chain';
import { scopeFor, scanScope, Metric, type Scope } from './lib/scope';
import { Prover } from './lib/proofs';
import { buildClaim, refuteClaim } from './lib/claims';
import { claimStatus } from './lib/status';
import { runScript } from './lib/cli';

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
  const chainInfo = chainInfoAt(wallet.provider!);
  const ck = CHAIN_KEY.mainnet;
  const eth = source(ck);
  const prover = Prover.withDefaults(ck, 60000);
  const minWindow = Number(await registry.MIN_CHALLENGE_WINDOW());

  const frontier = Number((await chainInfo.getLatestAttestedHeightAndHash(ck)).height);
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

  // Read an indexed address out of a log, or nothing.
  //
  // These logs come from an endpoint, filtered only by signature, and reading `topics[3]` off one
  // that carries three topics throws `Cannot read properties of undefined` from inside a `.slice`
  // — a crash with nothing in it about what went wrong. A log that does not carry the topic this
  // scope is about is not a log this scope can use, so it is skipped and counted.
  let skipped = 0;
  const addressAt = (log: { topics: readonly string[] }, index: number): string | null => {
    const topic = log.topics[index];
    if (typeof topic !== 'string' || topic.length !== 66) {
      skipped++;
      return null;
    }
    return getAddress('0x' + topic.slice(26));
  };

  const liquidatedUsers = new Set(allLiquidations.map((l) => addressAt(l, 3)).filter((a): a is string => a !== null));
  const repayCount = new Map<string, number>();
  for (const l of allRepays) {
    const user = addressAt(l, 2);
    if (user === null) continue;
    repayCount.set(user, (repayCount.get(user) ?? 0) + 1);
  }

  const goodBorrower =
    (process.env.BORROWER && getAddress(process.env.BORROWER)) || pickBorrower(repayCount, liquidatedUsers);
  if (!goodBorrower) throw new Error('no borrower with 2-6 repayments and no liquidation in this window');

  const liquidatedBorrower =
    [...liquidatedUsers].find((u) => (repayCount.get(u) ?? 0) > 0) ?? [...liquidatedUsers][0];

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
  const volumeClaim = await buildClaim(
    registry,
    prover,
    volumeScope(goodBorrower),
    fromBlock,
    toBlock,
    volumeEvents,
    {
      bond: BOND,
      challengeWindow: minWindow,
      log: (m) => console.log('   ' + m),
    },
  );

  console.log('  building clean claim (empty set, bonded)...');
  const cleanClaim = await buildClaim(registry, prover, cleanScope(goodBorrower), fromBlock, toBlock, cleanEvents, {
    bond: BOND,
    challengeWindow: minWindow,
    log: (m) => console.log('   ' + m),
  });

  // ------------------------------------------------------------------
  console.log('\n=== 2. a false clean claim, and what happens to it ===');
  const realLiquidations = await scanScope(eth, cleanScope(liquidatedBorrower), fromBlock, toBlock, HISTORY_BLOCKS);
  console.log(`  ${liquidatedBorrower} was liquidated ${realLiquidations.length} time(s) in this window`);
  console.log('  filing a clean claim anyway — asserting the set is empty');

  const falseClaim = await buildClaim(registry, prover, cleanScope(liquidatedBorrower), fromBlock, toBlock, [], {
    bond: BOND,
    challengeWindow: minWindow,
    log: (m) => console.log('   ' + m),
  });

  const before = await wallet.provider!.getBalance(wallet.address);
  const { reward, key } = await refuteClaim(registry, prover, falseClaim.claimId, realLiquidations[0]);
  const after = await wallet.provider!.getBalance(wallet.address);
  const refuted = await registry.claim(falseClaim.claimId);

  console.log(`  refuted with one real liquidation proof. key ${key}`);
  console.log(`  status ${claimStatus(refuted.status)}  reward ${formatEther(reward)} CTC`);
  console.log(`  watcher balance ${formatEther(before)} -> ${formatEther(after)} CTC`);
  if (Number(refuted.status) !== 4) throw new Error('false clean claim should be Refuted');

  // ------------------------------------------------------------------
  console.log('\n=== 3. finalizing the honest claims ===');
  const until = Number(await registry.challengeUntil(cleanClaim.claimId));
  await waitForBlock(wallet.provider!, until + 1, { label: 'CC3 block' });
  for (const [name, id] of [
    ['volume', volumeClaim.claimId],
    ['clean', cleanClaim.claimId],
  ] as const) {
    const tx = await registry.finalize(id);
    await tx.wait();
    const c = await registry.claim(id);
    const shown = name === 'volume' ? `${formatUnits(c.aggregate, 6)} USDC` : `${c.aggregate}`;
    console.log(`  ${name} claim ${id}: ${claimStatus(c.status)}  aggregate ${shown}`);
  }

  // ------------------------------------------------------------------
  console.log('\n=== 4. the line is refused, and that is the point ===');
  const volumeAggregate: bigint = (await registry.claim(volumeClaim.claimId)).aggregate;

  // Ask the contracts for their own arithmetic instead of restating it here. This line printed
  // ten times the *bond* and called it the cap, which is twice what the contract would allow: a
  // claimant can front-run their own refutation from a second address and take the refuter's half
  // back, so only the burned half is enforceable, and it is the enforceable half that lends.
  const [rate, ltvBps, multiple, enforceable] = await Promise.all([
    credit.VOLUME_UNIT_IN_CTC(),
    credit.LTV_BPS(),
    credit.BOND_MULTIPLE(),
    registry.enforceableLoss(cleanClaim.claimId),
  ]);
  const cleanBond: bigint = (await registry.claim(cleanClaim.claimId)).bondPosted;

  console.log(`  proven volume ${formatUnits(volumeAggregate, 6)} USDC at ${rate} wei/unit`);
  console.log(`  ${Number(ltvBps) / 100}% of that = ${formatEther((volumeAggregate * rate * ltvBps) / 10_000n)} CTC`);
  console.log(
    `  bond cap    = ${formatEther(enforceable * multiple)} CTC  ` +
      `(${multiple}x enforceableLoss ${formatEther(enforceable)}, not the ${formatEther(cleanBond)} CTC bond)`,
  );

  // Everything above was read off a public chain. Reading a history is not the same as holding
  // the key that wrote it, so the line must not open for whoever happens to ask.
  try {
    await credit.openLine.staticCall(goodBorrower, volumeClaim.claimId, [cleanClaim.claimId]);
    throw new Error('openLine should have refused: control of the subject was never proven');
  } catch (e: any) {
    const named = String(e.revert?.name ?? e.shortMessage ?? e.message);
    if (!named.includes('SubjectNotControlled')) throw e;
    console.log('  openLine reverted: SubjectNotControlled');
    console.log(`    subject ${goodBorrower}`);
    console.log(`    caller  ${wallet.address}`);
  }

  const commitment: string = await credit.controlCommitment(wallet.address);
  console.log('\n  to finish the loop the borrower sends one Ethereum transaction from their own');
  console.log('  address, carrying exactly this calldata:');
  console.log(`    ${commitment}`);
  console.log('  then calls proveControl() with its Attestcoin proof — see npm run control.');

  console.log('\nDone.');
}

function pickBorrower(repayCount: Map<string, number>, liquidated: Set<string>): string | null {
  for (const [user, n] of repayCount) {
    if (n >= 2 && n <= 6 && !liquidated.has(user)) return user;
  }
  return null;
}

runScript(main);
