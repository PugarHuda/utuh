import { JsonRpcProvider, Wallet, formatEther, keccak256, concat, toUtf8Bytes, parseEther } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, PROVER_URL, source, requirePrivateKey } from './config';
import { registryAt, creditAt, signer } from './lib/contracts';
import { scanScope, type Scope, type Metric } from './lib/scope';
import { Prover } from './lib/proofs';
import { buildClaim } from './lib/claims';

/// Resume a line from wherever `npm run full` stopped.
///
/// The flow takes half an hour, most of it spent waiting on attestations and challenge windows,
/// and a long-running process is the least reliable part of it. None of that state lives in the
/// script though — the claims, the line and the watermark are all on Creditcoin — so picking it
/// back up is a matter of reading what is there and doing whatever is still missing.
///
///   npm run finish -- <registry> <credit> <lineId> [repayClaimId]
async function main() {
  const [registryAddress, creditAddress, lineIdArg, claimIdArg] = process.argv.slice(2);
  if (!registryAddress || !creditAddress || !lineIdArg) {
    throw new Error('usage: npm run finish -- <registry> <credit> <lineId> [repayClaimId]');
  }
  const lineId = BigInt(lineIdArg);

  const master = requirePrivateKey();
  const lender = signer(CC3_RPC, CC3_CHAIN_ID, master);
  const cc3 = lender.provider as JsonRpcProvider;

  // Same derivation as fullFlow.ts — the borrower is the one who settles.
  const borrower = new Wallet(keccak256(concat([master, toUtf8Bytes('utuh/borrower')])), cc3);

  const registryRead = registryAt(registryAddress, lender);
  const registryAsBorrower = registryAt(registryAddress, borrower);
  const creditRead = creditAt(creditAddress, lender);
  const creditAsBorrower = creditAt(creditAddress, borrower);

  let line = await creditRead.line(lineId);
  console.log(`line ${lineId}: ${lineStatusName(line.status)}  drawn ${formatEther(line.drawn)} CTC`);
  if (Number(line.status) !== 1) {
    console.log('nothing to do.');
    return;
  }
  console.log(`  owes ${formatEther(line.repayRequired)} on the source chain, due at CC3 block ${line.dueBlock}`);

  let claimId = claimIdArg ? BigInt(claimIdArg) : await findRepayClaim(registryRead, creditRead, line);

  if (claimId === 0n) {
    console.log('\nno repayment claim yet — building one');
    claimId = await buildRepayClaim(registryRead, registryAsBorrower, creditRead, line);
  }

  const claim = await registryRead.claim(claimId);
  console.log(`\nrepay claim ${claimId}: ${statusName(claim.status)}  aggregate ${formatEther(claim.aggregate)}`);

  if (Number(claim.status) === 2) {
    const until = Number(await registryRead.challengeUntil(claimId));
    await waitForBlock(cc3, until + 1);
    await (await registryAsBorrower.finalize(claimId)).wait();
    console.log(`  finalized: ${statusName((await registryRead.claim(claimId)).status)}`);
  }

  await (await creditAsBorrower.settle(lineId, claimId)).wait();
  line = await creditRead.line(lineId);
  console.log(`\nline ${lineId}: ${lineStatusName(line.status)}`);
  console.log(`settledThrough(${line.subject}) = ${await creditRead.settledThrough(line.subject)}`);
  if (Number(line.status) !== 2) throw new Error('line should be Settled');

  console.log('\nThe loop is closed. Credit issued on Creditcoin against proven source-chain');
  console.log('history, repaid on the source chain, and settled on Creditcoin. Nothing bridged.');
}

/// A claim already built for this line, if the run got that far before stopping.
async function findRepayClaim(registry: any, credit: any, line: any): Promise<bigint> {
  const next: bigint = await registry.nextClaimId();
  for (let id = next - 1n; id >= 1n; id--) {
    const c = await registry.claim(id);
    if (Number(c.status) !== 2 && Number(c.status) !== 3) continue;
    if (c.fromBlock < line.repayFrom) continue;
    const scopeId = await credit.expectedScope(plainSpec(await credit.repaySpec()), line.subject);
    // Compare the aggregate's scope by rebuilding the id the contract would compute.
    if (scopeIdOf(c.scope) === scopeIdOf(scopeId)) return id;
  }
  return 0n;
}

function plainSpec(s: any) {
  return {
    chainKey: s.chainKey,
    emitter: s.emitter,
    eventSig: s.eventSig,
    subjectTopic: s.subjectTopic,
    counterpartyTopic: s.counterpartyTopic,
    counterparty: s.counterparty,
    metric: s.metric,
    metricArg: s.metricArg,
  };
}

function scopeIdOf(s: any): string {
  return JSON.stringify([
    Number(s.chainKey ?? s[0]),
    String(s.emitter ?? s[1]).toLowerCase(),
    String(s.eventSig ?? s[2]),
    [...(s.topics ?? s[3])].map(String),
    Number(s.topicMask ?? s[4]),
    Number(s.metric ?? s[5]),
    Number(s.metricArg ?? s[6]),
  ]);
}

async function buildRepayClaim(registry: any, registryAsBorrower: any, credit: any, line: any): Promise<bigint> {
  // ethers hands struct returns back as a frozen Result, and passing one straight into another
  // call fails while it resolves arguments. Copy it into a plain object first.
  const spec = plainSpec(await credit.repaySpec());
  const raw = await credit.expectedScope(spec, line.subject);
  const scope: Scope = {
    chainKey: Number(raw.chainKey),
    emitter: raw.emitter,
    eventSig: raw.eventSig,
    topics: [raw.topics[0], raw.topics[1], raw.topics[2]],
    topicMask: Number(raw.topicMask),
    metric: Number(raw.metric) as Metric,
    metricArg: Number(raw.metricArg),
  };

  const chainKey = Number(spec.chainKey);
  const eth = source(chainKey);
  const prover = new Prover(chainKey, PROVER_URL, 60000);

  const head = await eth.getBlockNumber();
  const fromBlock = Number(line.repayFrom);
  const toBlock = head - 3;
  console.log(`  sweeping ${fromBlock}..${toBlock} on chain key ${chainKey}`);

  const events = await scanScope(eth, scope, fromBlock, toBlock, 500);
  console.log(`  payments found: ${events.length}`);
  if (events.length === 0) throw new Error('no repayment on the source chain to prove');

  await prover.waitAttested(toBlock);
  const window = Number(await registry.MIN_CHALLENGE_WINDOW());
  const built = await buildClaim(registryAsBorrower, prover, scope, fromBlock, toBlock, events, {
    bond: parseEther(process.env.BOND ?? '2'),
    challengeWindow: window,
    log: (m) => console.log('   ' + m),
  });
  return built.claimId;
}

async function waitForBlock(provider: JsonRpcProvider, target: number): Promise<void> {
  for (;;) {
    const now = await provider.getBlockNumber();
    if (now >= target) {
      process.stdout.write('\r');
      return;
    }
    process.stdout.write(`\r  waiting for CC3 block ${target}, at ${now}   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function statusName(s: bigint | number): string {
  return ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'][Number(s)] ?? String(s);
}

function lineStatusName(s: bigint | number): string {
  return ['None', 'Active', 'Settled', 'Defaulted'][Number(s)] ?? String(s);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + (e.stack ?? e.message));
    process.exit(1);
  });
