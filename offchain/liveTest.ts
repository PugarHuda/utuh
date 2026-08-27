import { existsSync, readFileSync } from 'node:fs';
import {
  makeError,
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
import { CC3_RPC, CC3_CHAIN_ID, source, requirePrivateKey, CHAIN_KEY, SOURCE_CHAIN_ID } from './config';
import { registryAt, creditAt, signer, readDeployments } from './lib/contracts';
import { scopeFromCredit, plainSpec, sameScope } from './lib/specs';
import { sweepForClaim } from './lib/claims';
import { answersTheQuestion, valueOf, type Scope } from './lib/scope';
import { supportedChains, verifyChainKeys } from './lib/chain';
import { Prover, isAbsence } from './lib/proofs';
import { calldataGas, modelledGas, isChainRejection, isTransportFailure, isPayloadTooLarge } from './lib/gasLimit';
import { waitForBlock } from './lib/chain';
import { claimStatus } from './lib/status';
import { runScript } from './lib/cli';

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

const NL = String.fromCharCode(10);

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

/// Report a plain boolean check. `expectOk` and `expectRevert` cover calls; this covers the pure
/// decisions — was this hex accepted, did that classifier answer the way it must.
function check(name: string, ok: boolean): void {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
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
  let fromBlock = anchor;
  const toBlock = Math.min(anchor + Number(process.env.LIVE_SPAN ?? 400), head - 40);

  // Find a subject that actually has a history in this window, rather than asserting one.
  //
  // The suite used to underwrite a wallet derived from the operator's key, which has never
  // repaid a loan on Ethereum and never will — so every run past this point needed the Sepolia
  // deployment and an explicit argument, and `npm run livetest` on its own could not get here at
  // all. A hardcoded borrower would only move the problem: addresses go quiet, and a fixture that
  // rots fails the suite for a reason that has nothing to do with the registry. So ask the chain
  // who was active in this exact range and take the busiest answer.
  let subject: string;
  if (process.env.LIVE_SUBJECT) {
    subject = process.env.LIVE_SUBJECT;
  } else {
    const found = await busiestSubject(eth, spec, fromBlock, toBlock);
    subject = found.subject;
    fromBlock = found.fromBlock;
  }
  console.log(`subject ${subject}`);
  const scope: Scope = await scopeFromCredit(credit, 'volume', subject);

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
    // A real log always carries a payload field, even when it is empty. The fixture did not, which
    // is what a fixture is for: it caught the guard, and the guard was right.
    const good = { blockNumber: 100, address: scope.emitter, topics, index: 0, transactionIndex: 0, data: '0x' };
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
      // The payload is where a number gets read out, so its shape is part of the question.
      ['a payload that is not hex', { ...good, data: '0xzz' }, false],
      ['a payload of half a byte', { ...good, data: '0x123' }, false],
      ['a payload with no 0x', { ...good, data: '00'.repeat(32) }, false],
      ['a payload that is missing', { ...good, data: undefined }, false],
      ['an empty payload', { ...good, data: '0x' }, true],
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
  // The line lifecycle's refusals, against a line that really exists.
  //
  // Everything past `openLine` is behind `proveControl`, and that is behind `0x0FD2`, so a local
  // test cannot reach any of it. The completed loop left a real settled line on chain, though, and
  // a settled line is exactly the state in which draw, settle and markDefault must all refuse.
  // `staticCall` asks without spending anything.
  {
    const full = existsSync('deployments.full.json')
      ? (JSON.parse(readFileSync('deployments.full.json', 'utf8')) as { credit?: string })
      : {};
    if (!full.credit) {
      console.log(`${NL}no completed loop recorded — skipping the line lifecycle guards`);
    } else {
      console.log('');
      console.log(`refusals on a settled line (${full.credit})`);
      const settledCredit = creditAt(full.credit, owner);
      const line = await settledCredit.line(1);
      console.log(`  line 1 is ${['None', 'Active', 'Settled', 'Defaulted'][Number(line.status)]}`);

      // `draw` checks who is asking before it checks the line's state, which is the right order
      // and is worth pinning: this suite is not the borrower, so it never reaches the status. The
      // first version of this asserted WrongLineStatus and was asserting the wrong thing.
      await expectRevert('a stranger drawing on a settled line', 'NotBorrower', () =>
        settledCredit.draw.staticCall(1, 1n),
      );
      await expectRevert('settling a settled line again', 'WrongLineStatus', () =>
        settledCredit.settle.staticCall(1, 4),
      );
      await expectRevert('defaulting a settled line', 'WrongLineStatus', () =>
        settledCredit.markDefault.staticCall(1),
      );
      // An unopened line has no borrower, so nobody is its borrower — a better answer than a
      // status complaint about a line that does not exist.
      await expectRevert('drawing on a line that was never opened', 'NotBorrower', () =>
        settledCredit.draw.staticCall(9_999, 1n),
      );
      // Curing is for a line that defaulted. A settled one has nothing to make good, and letting
      // it through would be a second discharge of a debt that is already gone.
      await expectRevert('curing a line that never defaulted', 'WrongLineStatus', () =>
        settledCredit.cure.staticCall(1, 4),
      );

      // The two watermarks that stop one history, and one payment, being spent twice. Both are
      // written by the loop that produced this line, and both are read back here rather than
      // asserted in prose.
      const underwritten: bigint = await settledCredit.underwrittenThrough(line.subject);
      const settled: bigint = await settledCredit.settledThrough(line.subject);
      check('the underwritten history is consumed past the range it covered', underwritten > line.repayFrom);
      check('the repayment range is consumed too', settled > underwritten);
      check('a settled borrower carries no standing default', (await settledCredit.defaultsOf(line.subject)) === 0n);
    }
  }

  // ------------------------------------------------------------------
  // What the network says about its own chain keys, against what this build assumes.
  //
  // Chain keys are per network. gluwa's networks.json has key 3 meaning Sepolia on usc-devnet
  // while it means Ethereum mainnet here, so a CC3_RPC pointed at another Creditcoin network
  // would leave everything underwriting one chain and reporting another — with every proof still
  // verifying, because the proofs would be perfectly valid for the chain they came from.
  console.log('');
  console.log('the chain keys this build assumes, against the ones the network attests');
  {
    const chains = await supportedChains(owner.provider!);
    for (const c of chains)
      console.log(`  network says key ${c.chainKey} = "${c.name}" (EVM ${c.chainId}), encoding v${c.encoding}`);

    const right = [
      { chainKey: CHAIN_KEY.mainnet, label: 'Ethereum mainnet', chainId: SOURCE_CHAIN_ID[CHAIN_KEY.mainnet] },
      { chainKey: CHAIN_KEY.sepolia, label: 'Sepolia', chainId: SOURCE_CHAIN_ID[CHAIN_KEY.sepolia] },
    ];
    let agreed = true;
    try {
      await verifyChainKeys(owner.provider!, right);
    } catch {
      agreed = false;
    }
    check('what this build assumes is what the network attests', agreed);

    // And the guard has to fire when it is wrong, or it is decoration.
    const wrongId = [{ chainKey: CHAIN_KEY.mainnet, label: 'Ethereum mainnet', chainId: 999_999 }];
    let caughtId = false;
    try {
      await verifyChainKeys(owner.provider!, wrongId);
    } catch {
      caughtId = true;
    }
    check('an EVM chain id that does not match is refused', caughtId);

    const unknownKey = [{ chainKey: 77, label: 'a chain this network does not attest', chainId: 1 }];
    let caughtKey = false;
    try {
      await verifyChainKeys(owner.provider!, unknownKey);
    } catch {
      caughtKey = true;
    }
    check('a chain key the network does not attest is refused', caughtKey);
  }

  // ------------------------------------------------------------------
  // Reading a number out of a log's payload. The window is a fixed 64 characters at a fixed
  // offset, and the offset used to be counted from the whole string — so a payload arriving
  // without its `0x` shifted every window two characters early. With three data words that is not
  // a short read any length check would catch: it is a different number, returned in silence.
  console.log('');
  console.log('reading a value out of a payload');
  {
    const word = (n: bigint) => n.toString(16).padStart(64, '0');
    const three = '0x' + word(0xaan) + word(1234567n) + word(0n);
    // valueOf reads nothing from a scope but its metric and which word to take.
    const dataScope = { ...scope, metric: 1, metricArg: 1 } as Scope;
    check('the second word of three reads as itself', valueOf(dataScope, three) === 1234567n);
    let threw = false;
    try {
      valueOf(dataScope, three.slice(2));
    } catch {
      threw = true;
    }
    check('the same payload without its 0x is refused, not misread', threw);
    check(
      'a COUNT scope does not read the payload at all',
      valueOf({ ...dataScope, metric: 0 } as Scope, '0x') === 1n,
    );
    let short = false;
    try {
      valueOf({ ...dataScope, metricArg: 9 } as Scope, three);
    } catch {
      short = true;
    }
    check('a word past the end of the payload is refused', short);
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
      [
        'the same scope, emitter lowercased',
        sameScope(mine, { ...toPlain(mine), emitter: String(mine.emitter).toLowerCase() }),
        true,
      ],
      [
        'the same scope, eventSig uppercased',
        sameScope(mine, { ...toPlain(mine), eventSig: String(mine.eventSig).toUpperCase().replace('0X', '0x') }),
        true,
      ],
      [
        'one topic changed',
        sameScope(mine, { ...toPlain(mine), topics: ['0x' + '22'.repeat(32), mine.topics[1], mine.topics[2]] }),
        false,
      ],
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
    const encoded = {
      code: 'CALL_EXCEPTION',
      revert: null,
      data: registry.interface.encodeErrorResult('NotClaimant'),
    };
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
    // ethers builds these, so the guards are checked against what it actually produces rather than
    // against a hand-written idea of the shape.
    const transport: [string, unknown, boolean][] = [
      ['a timeout', makeError('timed out', 'TIMEOUT'), true],
      ['an unreachable endpoint', makeError('no network', 'NETWORK_ERROR'), true],
      ['a 502 from the endpoint', makeError('bad gateway', 'SERVER_ERROR'), true],
      ['a malformed response', makeError('bad data', 'BAD_DATA'), true],
      ['a destroyed provider', makeError('cancelled', 'CANCELLED'), true],
      ['a revert', makeError('reverted', 'CALL_EXCEPTION'), false],
      ['not enough funds', makeError('insufficient funds', 'INSUFFICIENT_FUNDS'), false],
      // Nullish input is the case that found the bug: ethers' isError is a type predicate, so
      // TypeScript believes it returns a boolean, and for a nullish argument it returns the
      // argument. An `||` chain of those yielded `undefined` from a function typed `boolean`.
      // Compared with `===` here rather than for truthiness, which is why it showed up at all.
      ['nothing at all', undefined, false],
      ['null', null, false],
      ['an object that is not an error', {}, false],
    ];
    // A 413 is a SERVER_ERROR as well, so the narrowing has to read what the endpoint actually
    // said rather than the code. CI found this one: a batch of ten queries whose ten in-scope logs
    // all came from a single large transaction sends that transaction ten times over, and the
    // proxy in front of the RPC refused the body before the precompile saw any of it. A timeout is
    // worth retrying unchanged; this never is, because the same bytes get the same answer.
    // ethers types SERVER_ERROR's info as { request, response }, but the object JsonRpcProvider
    // actually throws carries requestUrl, responseStatus and responseBody — which is what the
    // guard reads, so that is what these are built with.
    const served = (message: string, responseStatus: string, responseBody: string): unknown =>
      Object.assign(makeError(message, 'SERVER_ERROR'), {
        info: { requestUrl: 'https://rpc.cc3-testnet.creditcoin.network', responseStatus, responseBody },
      });

    const oversize: [string, unknown, boolean][] = [
      [
        'nginx 413',
        served(
          'server response 413 Request Entity Too Large',
          '413 Request Entity Too Large',
          '<html><head><title>413 Request Entity Too Large</title></head></html>',
        ),
        true,
      ],
      ['a 502 is not too large', served('bad gateway', '502 Bad Gateway', ''), false],
      // The status is read from its start for this reason: a body is arbitrary content and a bare
      // 413 in it may be a block number, not a verdict on the request that carried it.
      [
        'a 500 whose body merely contains 413',
        served('server error', '500 Internal Server Error', '{"error":"no block at height 413"}'),
        false,
      ],
      ['a timeout is not too large', makeError('timed out', 'TIMEOUT'), false],
      ['a revert is not too large', makeError('reverted', 'CALL_EXCEPTION'), false],
      ['a SERVER_ERROR with no info', makeError('unknown', 'SERVER_ERROR'), false],
      ['nothing at all', undefined, false],
    ];
    for (const [name, err, want] of oversize) {
      const got = isPayloadTooLarge(err);
      if (got === want) {
        passed++;
        console.log(`  ok    ${name} → ${got ? 'split and retry' : 'not a size problem'}`);
      } else {
        failed++;
        console.log(`  FAIL  ${name} → ${got ? 'split and retry' : 'not a size problem'}, expected the opposite`);
      }
    }

    for (const [name, err, want] of transport) {
      const got = isTransportFailure(err);
      if (got === want) {
        passed++;
        console.log(`  ok    ${name} → ${got ? 'never answered' : 'answered'}`);
      } else {
        failed++;
        console.log(`  FAIL  ${name} → ${got ? 'never answered' : 'answered'}, expected the opposite`);
      }
    }
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
      [
        'local sibling missing',
        'local',
        `Failed to generate merkle proof: Transaction ${hash} not found in block 25834280`,
        false,
      ],
      [
        'local block missing',
        'local',
        `Failed to generate merkle proof: Block 25834280 not found for transaction ${hash}`,
        false,
      ],
      [
        'local pending',
        'local',
        `Failed to generate merkle proof: Transaction ${hash} is pending and not yet included in a block`,
        false,
      ],
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
  await expectRevert('an empty batch', 'EmptyBatch', () => registry.appendBatch.staticCall(claimId, [], continuity));
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
  console.log(`  claim ${claimId} is now ${claimStatus(claim.status)}`);
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

  await waitForBlock(owner.provider!, Number(await registry.challengeUntil(honestId)) + 1, { label: 'CC3 block' });

  // What finalizing adds, not what the account happens to be owed.
  //
  // This compared `withdrawable` against the bond outright, which is only the same number when
  // nothing else is owed. The registry is shared — `npm run credit` finalising two claims of its
  // own an hour earlier is enough to make it read 6 CTC instead of 2 — so the assertion passed or
  // failed on history that has nothing to do with what it is checking.
  const owedBefore: bigint = await registry.withdrawable(owner.address);
  await expectOk('finalize after the window', async () => {
    await (await registry.finalize(honestId)).wait();
  });

  const owedAfter: bigint = await registry.withdrawable(owner.address);
  const credited = owedAfter - owedBefore;
  if (credited === bond) {
    passed++;
    console.log(`  ok    the bond was credited, not sent (${formatEther(credited)} CTC)`);
  } else {
    failed++;
    console.log(`  FAIL  finalizing credited ${formatEther(credited)} CTC, expected ${formatEther(bond)}`);
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
  console.log(`  claim ${honestId}: ${claimStatus(settled.status)}`);

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
): Promise<{ subject: string; fromBlock: number }> {
  const subjectSlot = Number(spec.subjectTopic);
  const counterpartySlot = Number(spec.counterpartyTopic);
  const topics: (string | null)[] = [spec.eventSig, null, null, null];
  if (counterpartySlot > 0) topics[counterpartySlot] = zeroPadValue(getAddress(spec.counterparty), 32);
  while (topics.length && topics[topics.length - 1] === null) topics.pop();

  // Widen until somebody qualifies, rather than failing on how busy the chain happened to be.
  //
  // A fixed window found nobody with two repayments often enough to matter: the suite then failed
  // with a message about LIVE_SPAN, which is accurate and is still a suite that fails for reasons
  // that have nothing to do with the registry. Aave's rate varies by the hour; the window should
  // follow it. Each attempt doubles the range, and the last one is wide enough that finding
  // nobody would mean Aave had stopped.
  const tally = new Map<string, number>();
  let span = toBlock - fromBlock;
  let from = fromBlock;

  for (let attempt = 0; attempt < 5; attempt++) {
    const logs = await eth.getLogs({ address: spec.emitter, topics, fromBlock: from, toBlock });
    tally.clear();
    for (const l of logs) {
      const t = l.topics[subjectSlot];
      if (t) tally.set(t, (tally.get(t) ?? 0) + 1);
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) {
      if (attempt > 0) console.log(`  widened to ${toBlock - from} blocks to find a subject with a history`);
      // The range comes back with the subject. Returning only the address meant the claim below
      // still swept the original window, where the subject found in a widened one has fewer
      // events than the suite needs — a failure the widening itself created.
      return { subject: getAddress('0x' + best[0].slice(26)), fromBlock: from };
    }
    span *= 2;
    from = Math.max(0, toBlock - span);
  }

  throw new Error(
    `no address has 2+ ${spec.emitter} events in the ${toBlock - from} blocks before ${toBlock} — ` +
      `set LIVE_SUBJECT to one you know of`,
  );
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

runScript(main);
