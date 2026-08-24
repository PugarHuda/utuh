import { Wallet, formatEther, keccak256, concat, toUtf8Bytes, parseEther, getAddress } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, PROVER_URL, source, requirePrivateKey } from './config';
import { registryAt, creditAt, signer, readDeployments } from './lib/contracts';
import { scanScope, eventKey, type Scope, type Metric } from './lib/scope';
import { Prover } from './lib/proofs';
import { buildClaim } from './lib/claims';

/// File a claim that is deliberately incomplete, so a watcher has something real to catch.
///
/// A watcher that has only ever seen honest claims has not been tested. This seals a claim over a
/// range it does not fully cover and then walks away — whether anything happens next is the whole
/// question, and it is not this script's business to answer.
///
///   npm run bait -- <registry> <credit> <subject>
async function main() {
  const [registryArg, creditArg, subjectArg] = process.argv.slice(2);
  const d = readDeployments();
  const registryAddress = registryArg ?? d.registry;
  const creditAddress = creditArg ?? d.credit;
  if (!registryAddress || !creditAddress) throw new Error('usage: npm run bait -- <registry> <credit> [subject]');

  const master = requirePrivateKey();
  const lender = signer(CC3_RPC, CC3_CHAIN_ID, master);

  // The liar is a separate party from the watcher, or the test proves nothing.
  const liar = new Wallet(keccak256(concat([master, toUtf8Bytes('utuh/defaulter')])), lender.provider!);
  const subject = getAddress(
    subjectArg ?? new Wallet(keccak256(concat([master, toUtf8Bytes('utuh/borrower')]))).address,
  );

  const registry = registryAt(registryAddress, liar);
  const credit = creditAt(creditAddress, lender);

  const bond = parseEther(process.env.BOND ?? '2');
  const balance = await lender.provider!.getBalance(liar.address);
  console.log(`liar    ${liar.address}  (${formatEther(balance)} CTC)`);
  console.log(`subject ${subject}`);
  if (balance < bond + parseEther('1')) {
    const need = bond + parseEther('1') - balance;
    await (await lender.sendTransaction({ to: liar.address, value: need })).wait();
    console.log(`  topped up ${formatEther(need)} CTC`);
  }

  const spec = await credit.volumeSpec();
  const raw = await credit.expectedScope(
    {
      chainKey: spec.chainKey,
      emitter: spec.emitter,
      eventSig: spec.eventSig,
      subjectTopic: spec.subjectTopic,
      counterpartyTopic: spec.counterpartyTopic,
      counterparty: spec.counterparty,
      metric: spec.metric,
      metricArg: spec.metricArg,
    },
    subject,
  );
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
  const prover = new Prover(chainKey, PROVER_URL, 60_000);

  const head = await eth.getBlockNumber();
  const toBlock = head - 3;
  const fromBlock = Number(process.env.BAIT_FROM ?? toBlock - 3_000);

  const events = await scanScope(eth, scope, fromBlock, toBlock, 500);
  console.log(`\nrange ${fromBlock}..${toBlock}: ${events.length} in-scope event(s)`);
  if (events.length < 2) throw new Error('need at least 2 events to hide one — widen BAIT_FROM');

  const hidden = events[events.length - 1];
  console.log(`hiding block ${hidden.blockNumber} tx#${hidden.txIndex} log#${hidden.logIndexInTx}`);

  await prover.waitAttested(toBlock);
  const window = Number(await registry.MIN_CHALLENGE_WINDOW());
  const built = await buildClaim(registry, prover, scope, fromBlock, toBlock, events, {
    bond,
    challengeWindow: window,
    omit: new Set([eventKey(hidden)]),
    log: (m) => console.log('  ' + m),
  });

  console.log(`\nclaim ${built.claimId} is sealed and short by one.`);
  console.log(`window closes at CC3 block ${await registry.challengeUntil(built.claimId)}`);
  console.log('nobody has been told. run: npm run watch');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + (e.stack ?? e.message));
    process.exit(1);
  });
