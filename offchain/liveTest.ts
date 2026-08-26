import {
  Wallet,
  formatEther,
  keccak256,
  concat,
  toUtf8Bytes,
  parseEther,
  zeroPadValue,
  getAddress,
  type JsonRpcProvider,
} from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, source, requirePrivateKey } from './config';
import { registryAt, creditAt, signer, readDeployments } from './lib/contracts';
import type { Scope } from './lib/scope';
import { scopeFor, plainSpec, sameScope } from './lib/specs';
import { sweepForClaim } from './lib/claims';
import { answersTheQuestion } from './lib/scope';
import { Prover, isAbsence, type EventProofStruct, type ContinuityProofStruct } from './lib/proofs';
import { calldataGas, modelledGas, isChainRejection } from './lib/gasLimit';

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
  const spec = plainSpec(await credit.volumeSpec());
  const chainKey = Number(spec.chainKey);
  const eth = source(chainKey);
  const prover = Prover.withDefaults(chainKey, 60_000);
  const head = await eth.getBlockNumber();

  // A bounded window, anchored where the events are. Taking everything since LIVE_FROM up to the
  // current head grows a little every hour until it is ten thousand blocks wide and only the
  // strongest endpoint will serve it — at which point the two-source minimum stops the suite for
  // reasons that have nothing to do with what it is testing.
  const anchor = process.env.LIVE_FROM ? Number(process.env.LIVE_FROM) : head - 3_040;
  const fromBlock = anchor;
  const toBlock = Math.min(anchor + Number(process.env.LIVE_SPAN ?? 400), head - 40);

  // Find a subject that actually has a history in this window, rather than asserting one.
  //
  // The suite used to underwrite a wallet derived from the operator's key, which has never
  // repaid a loan on Ethereum and never will — so every run past this point needed the Sepolia
  // deployment and an explicit argument, and `npm run livetest` on its own could not get here at
  // all. A hardcoded borrower would only move the problem: addresses go quiet, and a fixture that
  // rots fails the suite for a reason that has nothing to do with the registry. So ask the chain
  // who was active in this exact range and take the busiest answer.
  const subject = process.env.LIVE_SUBJECT ?? (await busiestSubject(eth, spec, fromBlock, toBlock));
  console.log(`subject ${subject}`);
  const scope: Scope = await scopeFor(credit, 'volume', subject);

  // ------------------------------------------------------------------
  // An endpoint's answer is not automatically an answer to the question. These cost nothing and
  // guard the point where untrusted data first enters: a log claiming a block above the
  // attestation frontier would become a candidate that cannot be proven and cannot be ruled
  // absent, which aborts the whole claim. One hostile endpoint would stop anyone sealing anything.
  console.log('what a sweep will accept from an endpoint');
  {
    // Built from the scope's own pinned topics, so the positive case is a log this scope really
    // would accept rather than one that happens to look plausible.
    const topics: string[] = [scope.eventSig];
    for (let i = 0; i < 3; i++) {
      topics.push((scope.topicMask & (1 << i)) !== 0 ? scope.topics[i] : '0x' + '11'.repeat(32));
    }
    const good = { blockNumber: 100, address: scope.emitter, topics, index: 0, transactionIndex: 0 };
    const cases: [string, any, boolean][] = [
      ['a log that matches the filter', good, true],
      ['a log below the range', { ...good, blockNumber: 99 }, false],
      ['a log above the range', { ...good, blockNumber: 201 }, false],
      ['a log from another contract', { ...good, address: '0x' + '22'.repeat(20) }, false],
      ['a log with another signature', { ...good, topics: ['0x' + '33'.repeat(32)] }, false],
      ['a log with no topics at all', { ...good, topics: [] }, false],
      // A raw endpoint can hand back hex strings where ethers would give numbers, and
      // `'0x5f5e0ff' < 100` is false rather than an error — a range check that looks total.
      ['a height smuggled in as a hex string', { ...good, blockNumber: '0x5f5e0ff' }, false],
      ['a height that is not a number at all', { ...good, blockNumber: 'soon' }, false],
      ['a negative transaction index', { ...good, transactionIndex: -1 }, false],
      ['a fractional log index', { ...good, index: 1.5 }, false],
    ];
    for (const [name, log, want] of cases) {
      const got = answersTheQuestion(scope, log, 100, 200);
      if (got === want) {
        passed++;
        console.log(`  ok    ${name} → ${got ? 'accepted' : 'discarded'}`);
      } else {
        failed++;
        console.log(`  FAIL  ${name} → ${got ? 'accepted' : 'discarded'}, expected the opposite`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Scope equality, checked against scopes the contract itself built. `finishLine` uses this to
  // decide whether the claim it is resuming already exists; say no when the answer is yes and it
  // stakes a second bond on a duplicate.
  console.log('');
  console.log('deciding whether two scopes are the same one');
  {
    const other = new Wallet(keccak256(concat([master, toUtf8Bytes('utuh/other-subject')]))).address;
    const mine = await credit.expectedScope(spec, subject);
    const again = await credit.expectedScope(spec, subject);
    const theirs = await credit.expectedScope(spec, other);
    const repay = await credit.expectedScope(plainSpec(await credit.repaySpec()), subject);

    const cases: [string, boolean, boolean][] = [
      ['the same scope, asked for twice', sameScope(mine, again), true],
      ['a different subject', sameScope(mine, theirs), false],
      ['a different spec for the same subject', sameScope(mine, repay), false],
      // ethers hands a struct back named or positional depending on the ABI, and a node may
      // checksum an address the previous one returned lowercase. Neither is a different scope.
      ['the same scope, positionally', sameScope(mine, [...mine]), true],
      ['the same scope, emitter lowercased', sameScope(mine, { ...toPlain(mine), emitter: String(mine.emitter).toLowerCase() }), true],
      ['the same scope, eventSig uppercased', sameScope(mine, { ...toPlain(mine), eventSig: String(mine.eventSig).toUpperCase().replace('0X', '0x') }), true],
      ['one topic changed', sameScope(mine, { ...toPlain(mine), topics: ['0x' + '22'.repeat(32), mine.topics[1], mine.topics[2]] }), false],
      ['a different metric', sameScope(mine, { ...toPlain(mine), metric: Number(mine.metric) === 0 ? 1 : 0 }), false],
    ];
    for (const [name, got, want] of cases) {
      if (got === want) {
        passed++;
        console.log(`  ok    ${name} → ${got ? 'same' : 'different'}`);
      } else {
        failed++;
        console.log(`  FAIL  ${name} → ${got ? 'same' : 'different'}, expected the opposite`);
      }
    }
  }

  // ------------------------------------------------------------------
  // Whether a failure came from the chain or from the wire. `buildClaim` drops an event the
  // registry rejects, because one the registry will not take is one no refuter could use against
  // the claim either — but an RPC that timed out has said nothing about the event, and dropping it
  // there seals a claim short of a real member and forfeits the bond for it.
  console.log('');
  console.log('telling a rejection apart from a failure to ask');
  {
    const rejection = { code: 'CALL_EXCEPTION', revert: { name: 'EventOutOfScope' } };
    const encoded = { code: 'CALL_EXCEPTION', revert: null, data: registry.interface.encodeErrorResult('NotClaimant') };
    const cases: [string, any, boolean][] = [
      ['a decoded revert', rejection, true],
      ['revert data this ABI can parse', encoded, true],
      ['a revert with no data at all', { code: 'CALL_EXCEPTION', revert: null, data: '0x' }, false],
      ['revert data from some other contract', { code: 'CALL_EXCEPTION', revert: null, data: '0xdeadbeef' }, false],
      ['the endpoint timed out', { code: 'TIMEOUT', message: 'timeout' }, false],
      ['the endpoint was unreachable', { code: 'NETWORK_ERROR', message: 'could not detect network' }, false],
      ['the endpoint returned nonsense', { code: 'SERVER_ERROR', message: '502' }, false],
      ['nothing at all', undefined, false],
    ];
    for (const [name, err, want] of cases) {
      const got = isChainRejection(registry, err);
      if (got === want) {
        passed++;
        console.log(`  ok    ${name} → ${got ? 'the chain refused' : 'we failed to ask'}`);
      } else {
        failed++;
        console.log(`  FAIL  ${name} → ${got ? 'the chain refused' : 'we failed to ask'}, expected the opposite`);
      }
    }
  }

  // ------------------------------------------------------------------
  // The gas model that carries a refutation when a node will not estimate one. Wrong low and the
  // transaction runs out; wrong high and no block will hold it.
  console.log('');
  console.log('the fallback gas model');
  {
    const check = (name: string, ok: boolean) => {
      if (ok) {
        passed++;
        console.log(`  ok    ${name}`);
      } else {
        failed++;
        console.log(`  FAIL  ${name}`);
      }
    };
    check('empty calldata costs nothing', calldataGas('0x') === 0n);
    check('a zero byte costs 4', calldataGas('0x00') === 4n);
    check('a non-zero byte costs 16', calldataGas('0xff') === 16n);
    check('mixed bytes add up', calldataGas('0x00ff00') === 4n + 16n + 4n);
    check('the 0x prefix is optional', calldataGas('ff') === calldataGas('0xff'));

    const small = modelledGas('0x' + 'ff'.repeat(100), 1);
    const wide = modelledGas('0x' + 'ff'.repeat(1000), 1);
    const many = modelledGas('0x' + 'ff'.repeat(100), 10);
    check('more calldata costs more', wide > small);
    check('more members cost more', many > small);
    // A single append measured 453,592 gas at its cheapest. The model has to clear that or the
    // fallback loses the transaction it exists to save.
    check('a one-member append is budgeted above what one really cost', small > 500_000n);
    // And a full batch has to stay inside a block.
    check('a ten-member append still fits a 75M block', modelledGas('0x' + 'ff'.repeat(100_000), 10) < 75_000_000n);
  }

  // ------------------------------------------------------------------
  // Which failures mean "the chain does not have it" and which mean "I could not tell". Getting
  // this backwards either forfeits a bond or lets one bad endpoint stop every honest claimant, and
  // it is decided by reading strings — the exact thing that silently broke once already when a
  // regex meant to match 404 was mangled into literal backspace characters.
  console.log('');
  console.log('telling absence apart from not knowing');
  {
    const hash = '0x' + 'ab'.repeat(32);
    const cases: [string, string, string, boolean][] = [
      ['hosted 404', 'hosted', 'Failed to fetch proof: AxiosError: Request failed with status code 404', true],
      ['hosted refused', 'hosted', 'Failed to fetch proof: Error: connect ECONNREFUSED 127.0.0.1:1', false],
      ['hosted 503', 'hosted', 'Failed to fetch proof: AxiosError: Request failed with status code 503', false],
      ['local absent', 'local', `Failed to generate merkle proof: Transaction ${hash} not found`, true],
      ['local sibling missing', 'local', `Failed to generate merkle proof: Transaction ${hash} not found in block 25834280`, false],
      ['local block missing', 'local', `Failed to generate merkle proof: Block 25834280 not found for transaction ${hash}`, false],
      ['local pending', 'local', `Failed to generate merkle proof: Transaction ${hash} is pending and not yet included in a block`, false],
      ['local unreachable', 'local', 'getBlockWithReceipts: fetch failed', false],
    ];
    for (const [name, prover, message, want] of cases) {
      const got = isAbsence(prover, message);
      if (got === want) {
        passed++;
        console.log(`  ok    ${name} → ${got ? 'absent' : 'unknown'}`);
      } else {
        failed++;
        console.log(`  FAIL  ${name} → ${got ? 'absent' : 'unknown'}, expected the opposite`);
      }
    }
  }

  console.log('');
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
  // One source is accepted here and nowhere else. This suite is exercising the registry's guards,
  // not asserting a history to anyone: its claims are refuted or finalized within the run, and a
  // short sweep costs it nothing. A real claimant staking a bond on completeness gets the default
  // of two, which is why that default exists.
  const events = await sweepForClaim(scope, fromBlock, toBlock, {
    minSources: 1,
    log: (m) => console.log('  ' + m),
  });
  console.log(`\nrange ${fromBlock}..${toBlock}: ${events.length} in-scope event(s)`);
  if (events.length < 2) throw new Error('need at least 2 events — widen LIVE_SPAN');

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

  // The refund path. finalize stopped sending and started crediting, and until now nothing
  // asserted that a bond ever actually comes back: the unit tests cannot create a claim at all,
  // and everything above this line ends in a refutation. A money path nobody checks is a money
  // path nobody has checked.
  console.log('');
  console.log('finalize and withdraw');
  const honestOpen = await (await registry.open(scope, fromBlock, toBlock, window, { value: bond })).wait();
  const honestId = readClaimId(registry, honestOpen);
  const whole = await prover.proveBatch(events.slice(0, Math.min(events.length, 10)));
  await (await registry.appendBatch(honestId, whole.proofs, whole.continuity)).wait();
  await (await registry.seal(honestId)).wait();
  console.log(`  claim ${honestId} sealed complete with ${whole.proofs.length} member(s)`);

  await waitForBlock(owner.provider!, Number(await registry.challengeUntil(honestId)) + 1);

  await expectOk('finalize after the window', async () => {
    await (await registry.finalize(honestId)).wait();
  });

  const credited: bigint = await registry.withdrawable(owner.address);
  if (credited === bond) {
    passed++;
    console.log(`  ok    the bond was credited, not sent (${formatEther(credited)} CTC)`);
  } else {
    failed++;
    console.log(`  FAIL  credited ${formatEther(credited)} CTC, expected ${formatEther(bond)}`);
  }

  const balBefore = await owner.provider!.getBalance(owner.address);
  await expectOk('withdraw', async () => {
    await (await registry.withdraw()).wait();
  });
  const balAfter = await owner.provider!.getBalance(owner.address);
  if (balAfter > balBefore) {
    passed++;
    console.log(`  ok    balance rose by ${formatEther(balAfter - balBefore)} CTC, net of gas`);
  } else {
    failed++;
    console.log('  FAIL  balance did not rise after withdraw');
  }

  await expectRevert('withdrawing twice', 'NothingToWithdraw', () => registry.withdraw.staticCall());
  await expectRevert('refuting something finalized', 'WrongStatus', () =>
    registry.refute.staticCall(honestId, one.proof, one.continuity),
  );

  const settled = await registry.claim(honestId);
  console.log(`  claim ${honestId}: ${statusName(settled.status)}`);

  // Sweeping the union of independent endpoints means a claimant can be handed a candidate no
  // chain has. Appending everything swept would then abort the claim, so one misbehaving endpoint
  // could stop every honest claimant. The Block Prover decides: what it cannot prove is dropped,
  // which is safe precisely because a refuter cannot refute with it either.
  console.log('');
  console.log('a candidate the chain does not have');
  const phantom = {
    blockNumber: events[0].blockNumber,
    txHash: '0x' + 'ab'.repeat(32),
    txIndex: events[0].txIndex,
    logIndexInTx: 0,
    value: 0n,
  };
  const attempt = await prover.tryProveOne(phantom, 2, 2000);
  if (attempt.ok) {
    failed++;
    console.log('  FAIL  a fabricated transaction produced a proof');
  } else if (attempt.authoritative) {
    passed++;
    console.log('  ok    the prover answered definitely, so the candidate can be dropped');
  } else {
    failed++;
    console.log(`  FAIL  expected a definite answer, got: ${attempt.reason.slice(0, 70)}`);
  }

  // The other half of the distinction: an unreachable prover must never look like absence.
  const blind = new Prover(chainKey, 'http://127.0.0.1:1', 3000);
  const unreachable = await blind.tryProveOne(events[0], 1, 0);
  if (!unreachable.ok && !unreachable.authoritative) {
    passed++;
    console.log('  ok    an unreachable prover is not mistaken for absence');
  } else {
    failed++;
    console.log('  FAIL  an unreachable prover was treated as a definite answer');
  }


  // ------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

async function waitForBlock(provider: any, target: number): Promise<void> {
  for (;;) {
    const now = await provider.getBlockNumber();
    if (now >= target) return;
    console.log(`  waiting for CC3 block ${target}, at ${now}`);
    await new Promise((r) => setTimeout(r, 10000));
  }
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

/// Ask the source chain which address the spec's subject topic saw most often in a range.
///
/// Only the emitter, the signature and the spec's pinned counterparty are filtered on — the
/// subject slot is left open, which is the one query a real claim never makes. Nothing here is
/// asserted; it only picks the fixture the rest of the suite then treats as untrusted input.
async function busiestSubject(
  eth: JsonRpcProvider,
  spec: any,
  fromBlock: number,
  toBlock: number,
): Promise<string> {
  const subjectSlot = Number(spec.subjectTopic);
  const counterpartySlot = Number(spec.counterpartyTopic);
  const topics: (string | null)[] = [spec.eventSig, null, null, null];
  if (counterpartySlot > 0) topics[counterpartySlot] = zeroPadValue(getAddress(spec.counterparty), 32);
  while (topics.length && topics[topics.length - 1] === null) topics.pop();

  const logs = await eth.getLogs({ address: spec.emitter, topics, fromBlock, toBlock });
  const tally = new Map<string, number>();
  for (const l of logs) {
    const t = l.topics[subjectSlot];
    if (t) tally.set(t, (tally.get(t) ?? 0) + 1);
  }
  const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) {
    throw new Error(
      `no address has 2+ events in ${fromBlock}..${toBlock} — widen LIVE_SPAN or set LIVE_SUBJECT`,
    );
  }
  return getAddress('0x' + best[0].slice(26));
}

/// ethers `Result` objects are frozen, so a case that varies one field has to copy first.
function toPlain(s: any) {
  return {
    chainKey: s.chainKey,
    emitter: s.emitter,
    eventSig: s.eventSig,
    topics: [s.topics[0], s.topics[1], s.topics[2]],
    topicMask: s.topicMask,
    metric: s.metric,
    metricArg: s.metricArg,
  };
}

function statusName(s: bigint | number): string {
  return ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'][Number(s)] ?? String(s);
}

main().catch((e) => {
  console.error('\n' + (e.stack ?? e.message));
  process.exit(1);
});
