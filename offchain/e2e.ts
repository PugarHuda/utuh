import { Contract, formatEther, parseEther } from 'ethers';
import chainInfoAbi from '@gluwa/usc-sdk/dist/chain-info/chain_info.json';
import 'dotenv/config';
import {
  CC3_RPC,
  CC3_CHAIN_ID,
  CHAIN_KEY,
  USDC,
  TRANSFER_SIG,
  source,
  requirePrivateKey,
} from './config';
import { readDeployments, registryAt, signer } from './lib/contracts';
import { scopeFor, scanScope, eventKey, Metric } from './lib/scope';
import { Prover } from './lib/proofs';
import { buildClaim, findOmission, refuteClaim } from './lib/claims';

const CHAIN_INFO = '0x0000000000000000000000000000000000000fD3';

/// Left unset, the demo picks whichever mainnet address moved the most USDC inside the window,
/// so a short range still yields enough in-scope events to hide one among.
const SUBJECT = process.env.SUBJECT;
const RANGE_BLOCKS = Number(process.env.RANGE_BLOCKS ?? 60);
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS ?? 12);
const BOND = parseEther(process.env.BOND ?? '2');

async function main() {
  const d = readDeployments();
  if (!d.registry) throw new Error('no deployments.json — run: npm run deploy');

  const wallet = signer(CC3_RPC, CC3_CHAIN_ID, requirePrivateKey());
  const registry = registryAt(d.registry, wallet);
  const chainInfo = new Contract(CHAIN_INFO, chainInfoAbi as any, wallet.provider!);
  const ck = CHAIN_KEY.mainnet;

  const frontier = Number((await chainInfo.get_latest_attestation_height_and_hash(ck))[0]);
  const toBlock = frontier - 30;
  const fromBlock = toBlock - RANGE_BLOCKS + 1;

  console.log(`Ethereum mainnet attested on Creditcoin up to block ${frontier}`);
  console.log(`claim range: ${fromBlock}..${toBlock}\n`);

  const eth = source(ck);
  const subject = SUBJECT ?? (await busiestSender(eth, fromBlock, toBlock));
  console.log(`subject: ${subject}`);

  // USDC transfers sent by the subject. Real contract, real chain, real money moving.
  const scope = scopeFor({
    chainKey: ck,
    emitter: USDC,
    eventSig: TRANSFER_SIG,
    subject,
    subjectTopic: 1,
    metric: Metric.DATA_WORD,
    metricArg: 0,
  });

  const events = (await scanScope(eth, scope, fromBlock, toBlock)).slice(0, MAX_MEMBERS);
  console.log(`swept the range independently: ${events.length} in-scope events found`);
  if (events.length < 2) throw new Error('need at least 2 events; widen RANGE_BLOCKS or pick a busier SUBJECT');
  for (const e of events) {
    console.log(`  block ${e.blockNumber} tx#${e.txIndex} log#${e.logIndexInTx}  value ${e.value}`);
  }

  const prover = Prover.withDefaults(ck);
  const minWindow = Number(await registry.MIN_CHALLENGE_WINDOW());

  // ------------------------------------------------------------------
  console.log('\n=== 1. an honest claim ===');
  const honest = await buildClaim(registry, prover, scope, fromBlock, toBlock, events, {
    bond: BOND,
    challengeWindow: minWindow,
    log: (m) => console.log(m),
  });
  const honestClaim = await registry.claim(honest.claimId);
  console.log(`  members ${await registry.memberCount(honest.claimId)}  aggregate ${honestClaim.aggregate}`);

  const stillMissing = await findOmission(registry, honest.claimId, events);
  console.log(`  watcher swept it: ${stillMissing === null ? 'nothing omitted — no refutation exists' : 'FOUND A GAP'}`);
  if (stillMissing !== null) throw new Error('honest claim should be complete');

  // ------------------------------------------------------------------
  console.log('\n=== 2. a dishonest claim ===');
  const hidden = events[events.length - 1];
  console.log(`  hiding block ${hidden.blockNumber} tx#${hidden.txIndex} log#${hidden.logIndexInTx} (value ${hidden.value})`);

  const liar = await buildClaim(registry, prover, scope, fromBlock, toBlock, events, {
    bond: BOND,
    challengeWindow: minWindow,
    omit: new Set([eventKey(hidden)]),
    log: (m) => console.log(m),
  });
  const liarClaim = await registry.claim(liar.claimId);
  console.log(`  members ${await registry.memberCount(liar.claimId)}  aggregate ${liarClaim.aggregate}  (understated)`);

  console.log('\n  watcher sweeps the same range...');
  const omission = await findOmission(registry, liar.claimId, events);
  if (omission === null) throw new Error('watcher failed to spot the omission');
  console.log(`  gap found at block ${omission.blockNumber} tx#${omission.txIndex} log#${omission.logIndexInTx}`);

  const before = await wallet.provider!.getBalance(wallet.address);
  const { reward, key } = await refuteClaim(registry, prover, liar.claimId, omission);
  const after = await wallet.provider!.getBalance(wallet.address);

  const refuted = await registry.claim(liar.claimId);
  console.log(`  refuted with one proof. key ${key}`);
  console.log(`  status ${statusName(refuted.status)}  reward ${formatEther(reward)} CTC`);
  console.log(`  burned so far ${formatEther(await registry.burned())} CTC`);
  console.log(`  refuter balance ${formatEther(before)} -> ${formatEther(after)} CTC`);
  if (Number(refuted.status) !== 4) throw new Error('claim should be Refuted');

  // ------------------------------------------------------------------
  console.log('\n=== 3. finalizing the honest claim ===');
  const until = Number(await registry.challengeUntil(honest.claimId));
  console.log(`  window closes at Creditcoin block ${until}`);
  await waitForBlock(wallet, until + 1);

  await (await registry.finalize(honest.claimId)).wait();
  const finalized = await registry.claim(honest.claimId);
  console.log(`  status ${statusName(finalized.status)}  aggregate ${finalized.aggregate}`);

  // finalize credits, it does not send. A claimant that cannot receive ether would otherwise have
  // left its own claim stuck in Sealed forever, and anything waiting on that claim with it — so
  // the refund is pulled. Printing the balance across `finalize` alone would show it *falling* by
  // the gas and read as a bond lost.
  const owed = await registry.withdrawable(wallet.address);
  console.log(
    `  this claim's ${formatEther(finalized.bondPosted)} CTC credited, ` +
      `${formatEther(owed)} CTC owed in total — pulled rather than pushed`,
  );
  const balBefore = await wallet.provider!.getBalance(wallet.address);
  await (await registry.withdraw()).wait();
  const balAfter = await wallet.provider!.getBalance(wallet.address);
  console.log(`  withdrawn: ${formatEther(balBefore)} -> ${formatEther(balAfter)} CTC, net of gas`);

  // What the claim is worth to a lender is not the bond. Half of it is recoverable by a claimant
  // who front-runs their own refutation from a second address; only the burned half is guaranteed.
  const enforceable = await registry.enforceableLoss(honest.claimId);
  console.log(`  bond ${formatEther(finalized.bondPosted)} CTC, but enforceableLoss ${formatEther(enforceable)} CTC`);
  console.log(`  usable at exposure ${formatEther(enforceable)} CTC: ${await registry.isUsable(honest.claimId, enforceable)}`);
  console.log(`  usable at one wei more than that: ${await registry.isUsable(honest.claimId, enforceable + 1n)}`);

  console.log('\nDone. Presence proven by Attestcoin; absence held up by a bond nobody could take.');
}

/// Whoever sent the most USDC inside the window. Keeps the demo self-contained: no address is
/// baked in that might go quiet by the time anyone runs this.
async function busiestSender(eth: any, fromBlock: number, toBlock: number): Promise<string> {
  const logs = await eth.getLogs({ address: USDC, topics: [TRANSFER_SIG], fromBlock, toBlock });
  const counts = new Map<string, number>();
  for (const l of logs) {
    const from = '0x' + l.topics[1].slice(26);
    counts.set(from, (counts.get(from) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) throw new Error('no USDC transfers in range');
  return ranked[0][0];
}

function statusName(s: bigint | number): string {
  return ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'][Number(s)] ?? String(s);
}

async function waitForBlock(wallet: any, target: number): Promise<void> {
  for (;;) {
    const now = await wallet.provider.getBlockNumber();
    if (now >= target) return;
    process.stdout.write(`\r  waiting for block ${target}, at ${now}   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + (e.stack ?? e.message));
    process.exit(1);
  });
