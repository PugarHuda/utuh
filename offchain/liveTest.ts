import { Wallet, formatEther, keccak256, concat, toUtf8Bytes, parseEther } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, PROVER_URL, source, requirePrivateKey } from './config';
import { registryAt, creditAt, signer, readDeployments } from './lib/contracts';
import { scanScope, eventKey, type Scope, type Metric } from './lib/scope';
import { Prover, type EventProofStruct, type ContinuityProofStruct } from './lib/proofs';

/// The half of the registry that unit tests cannot reach.
///
/// `forge test` covers everything that runs in a plain EVM, which is everything up to the moment a
/// call touches `0x0FD2` or `0x0FD3`. Those are Creditcoin runtime natives with no bytecode, so a
/// local EVM cannot execute them and a stub would only test the stub. Every guard *after* that
/// point — the state machine, the ordering rule, the window boundaries, who is allowed to do what
/// — therefore has no local coverage at all, and the demo scripts only ever walk the happy path.
///
/// This is that coverage. Most of it costs nothing: a reverting `staticCall` proves a guard holds
/// without spending gas or touching state. Only the steps that have to exist for the later checks
/// to mean anything are sent for real.
///
///   npm run livetest -- [registry] [credit]

let passed = 0;
let failed = 0;

async function expectRevert(name: string, error: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    failed++;
    console.log(`  FAIL  ${name} — expected ${error}, call succeeded`);
  } catch (e: any) {
    const got = e.revert?.name ?? e.shortMessage ?? e.message;
    if (String(got).includes(error)) {
      passed++;
      console.log(`  ok    ${name} → ${error}`);
    } else {
      failed++;
      console.log(`  FAIL  ${name} — expected ${error}, got ${got}`);
    }
  }
}

async function expectOk(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e: any) {
    failed++;
    console.log(`  FAIL  ${name} — ${e.revert?.name ?? e.shortMessage ?? e.message}`);
  }
}

async function main() {
  const [registryArg, creditArg] = process.argv.slice(2);
  const d = readDeployments();
  const registryAddress = registryArg ?? d.registry!;
  const creditAddress = creditArg ?? d.credit!;

  const master = requirePrivateKey();
  const owner = signer(CC3_RPC, CC3_CHAIN_ID, master);
  const stranger = new Wallet(keccak256(concat([master, toUtf8Bytes('utuh/stranger')])), owner.provider!);

  const registry = registryAt(registryAddress, owner);
  const asStranger = registryAt(registryAddress, stranger);
  const credit = creditAt(creditAddress, owner);

  console.log(`registry ${registryAddress}`);
  console.log(`owner    ${owner.address}`);
  console.log(`stranger ${stranger.address}\n`);

  const bond = parseEther('2');
  const window = Number(await registry.MIN_CHALLENGE_WINDOW());

  // Build the scope from the credit contract's own spec, so these are the shapes the system uses.
  const spec = await credit.volumeSpec();
  const subject = new Wallet(keccak256(concat([master, toUtf8Bytes('utuh/borrower')]))).address;
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

  const chainKey = scope.chainKey;
  const eth = source(chainKey);
  const prover = new Prover(chainKey, PROVER_URL, 60_000);
  const head = await eth.getBlockNumber();

  // ------------------------------------------------------------------
  console.log('opening a claim — the checks that need no state');

  await expectRevert('bond below the minimum', 'BondTooSmall', () =>
    registry.open.staticCall(scope, head - 500, head - 10, window, { value: 1n }),
  );
  await expectRevert('challenge window below the floor', 'BadChallengeWindow', () =>
    registry.open.staticCall(scope, head - 500, head - 10, 1, { value: bond }),
  );
  await expectRevert('range ends after the last attested block', 'RangeNotAttested', () =>
    registry.open.staticCall(scope, head - 500, head, window, { value: bond }),
  );
  await expectRevert('range runs backwards', 'EmptyRange', () =>
    registry.open.staticCall(scope, head - 10, head - 500, window, { value: bond }),
  );

  // ------------------------------------------------------------------
  const toBlock = head - 40;
  const fromBlock = Number(process.env.LIVE_FROM ?? toBlock - 3_000);
  const events = await scanScope(eth, scope, fromBlock, toBlock, 500);
  console.log(`\nrange ${fromBlock}..${toBlock}: ${events.length} in-scope event(s)`);
  if (events.length < 2) throw new Error('need at least 2 events — widen LIVE_FROM');

  await prover.waitAttested(toBlock);
  const included = events.slice(0, events.length - 1);
  const omitted = events[events.length - 1];

  console.log('\nappending — the guards around who and in what order');
  const opened = await (await registry.open(scope, fromBlock, toBlock, window, { value: bond })).wait();
  const claimId = readClaimId(registry, opened);
  console.log(`  claim ${claimId} open, will hold ${included.length} of ${events.length}`);

  const { proofs, continuity } = await prover.proveBatch(included);

  await expectRevert('a stranger appends', 'NotClaimant', () =>
    asStranger.appendBatch.staticCall(claimId, proofs, continuity),
  );
  await expectRevert('an empty batch', 'EmptyBatch', () =>
    registry.appendBatch.staticCall(claimId, [], continuity),
  );
  await expectRevert('a member outside the claimed range', 'BlockOutOfRange', () =>
    registry.appendBatch.staticCall(claimId, [{ ...proofs[0], blockHeight: fromBlock - 1 }], continuity),
  );
  await expectRevert('refuting a claim that is still open', 'WrongStatus', () =>
    registry.refute.staticCall(claimId, proofs[0], continuity),
  );

  await expectOk('the real append', async () => {
    await (await registry.appendBatch(claimId, proofs, continuity)).wait();
  });

  if (proofs.length > 1) {
    await expectRevert('members out of order', 'KeysOutOfOrder', () =>
      registry.appendBatch.staticCall(claimId, [proofs[0]], continuity),
    );
  }

  // ------------------------------------------------------------------
  console.log('\nsealing');
  await expectRevert('a stranger seals', 'NotClaimant', () => asStranger.seal.staticCall(claimId));
  await expectOk('the real seal', async () => {
    await (await registry.seal(claimId)).wait();
  });
  await expectRevert('appending after the seal', 'WrongStatus', () =>
    registry.appendBatch.staticCall(claimId, proofs, continuity),
  );
  await expectRevert('abandoning after the seal', 'WrongStatus', () => registry.abandon.staticCall(claimId));
  await expectRevert('finalizing inside the window', 'ChallengeWindowOpen', () =>
    registry.finalize.staticCall(claimId),
  );

  // ------------------------------------------------------------------
  console.log('\nrefuting');
  const one = await prover.proveOne(omitted);
  await expectRevert('refuting with a member already in the set', 'EventAlreadyInSet', () =>
    registry.refute.staticCall(claimId, proofs[0], continuity),
  );

  const burnedBefore: bigint = await registry.burned();
  await expectOk('the real refutation', async () => {
    await (await registry.refute(claimId, one.proof, one.continuity)).wait();
  });
  const burnedAfter: bigint = await registry.burned();

  const claim = await registry.claim(claimId);
  console.log(`  claim ${claimId} is now ${statusName(claim.status)}`);
  console.log(`  burned ${formatEther(burnedBefore)} -> ${formatEther(burnedAfter)} CTC`);
  console.log(`  enforceableLoss ${formatEther(await registry.enforceableLoss(claimId))} CTC`);

  await expectRevert('refuting twice', 'WrongStatus', () =>
    registry.refute.staticCall(claimId, one.proof, one.continuity),
  );
  await expectRevert('finalizing something refuted', 'WrongStatus', () => registry.finalize.staticCall(claimId));

  if (Number(claim.status) !== 4) {
    failed++;
    console.log('  FAIL  claim should be Refuted');
  }

  // ------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

function readClaimId(registry: any, receipt: any): bigint {
  for (const log of receipt.logs) {
    try {
      const parsed = registry.interface.parseLog(log);
      if (parsed?.name === 'ClaimOpened') return parsed.args[0] as bigint;
    } catch {
      /* not ours */
    }
  }
  throw new Error('ClaimOpened not found');
}

function statusName(s: bigint | number): string {
  return ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'][Number(s)] ?? String(s);
}

main().catch((e) => {
  console.error('\n' + (e.stack ?? e.message));
  process.exit(1);
});
