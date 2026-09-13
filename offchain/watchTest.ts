import { byDeadline, conclude, decodeState, encodeState, startBlock } from './lib/watchState';
import { isTransportFailure } from './lib/gasLimit';
import { runScript } from './lib/cli';

/// The watcher's rules, asserted without a chain.
///
/// `npm run watch` cannot be unit-tested: it runs at import and everything it does is an RPC call.
/// What *can* be tested is every decision it makes with the answers — and those are the decisions
/// the README promises: it resumes from where it stopped, it looks at the claim closest to its
/// deadline first, it retires a claim only on a verdict that cannot change, and one failed
/// refutation leaves it watching. Each promise is one assertion here.
///
///   npx tsx offchain/watchTest.ts

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}

const REGISTRY = '0x26880c8980Cd54827543bD34c6c613253c69347b';

async function main() {
  console.log('the mark');
  const text = encodeState(REGISTRY, 4_321_000, ['7', '9']);
  const back = decodeState(text, REGISTRY);
  check(
    'a saved state round-trips through the file format',
    JSON.stringify(back) === JSON.stringify({ registry: REGISTRY, lastScanned: 4_321_000, pending: ['7', '9'] }),
  );
  check(
    'the next run starts one past the mark, not at the lookback',
    startBlock(back, 4_400_000, 5_000) === 4_321_001,
  );
  check('a lower-case registry is still the same registry', decodeState(text, REGISTRY.toLowerCase()) !== null);
  check(
    "another registry's progress is not resumed from",
    decodeState(text, '0x8FA0BD5301D998Be873E31453E53d114929a5Fac') === null,
  );
  check(
    'a state with no mark is no state',
    decodeState(JSON.stringify({ registry: REGISTRY, pending: [] }), REGISTRY) === null,
  );
  check(
    'a mark that is not an integer is no state',
    decodeState(JSON.stringify({ registry: REGISTRY, lastScanned: '12' }), REGISTRY) === null,
  );
  check('a file that is not JSON is no state', decodeState('', REGISTRY) === null);
  check(
    'with no state the watcher starts the lookback behind the head',
    startBlock(null, 4_400_000, 5_000) === 4_395_000,
  );
  check('and never before the genesis block', startBlock(null, 100, 5_000) === 0);
  check('the queue comes back with the mark', back?.pending.length === 2);

  console.log('the order');
  const ordered = byDeadline([
    { id: 1n, until: 900 },
    { id: 2n, until: 3 },
    { id: 3n, until: 900 },
    { id: 4n, until: 50 },
  ]).map((x) => x.id);
  check('the claim about to close is inspected first', ordered[0] === 2n);
  check('the rest follow by deadline', ordered.join() === '2,4,1,3');

  console.log('the verdicts');
  const pending = new Set(['1', '2', '3', '4', '5', '6']);
  check('refuted retires the claim', conclude(pending, 1n, 'refuted') === 'refuted' && !pending.has('1'));
  check('settled elsewhere retires it', conclude(pending, 2n, 'settled') === 'settled' && !pending.has('2'));
  check('complete retires it', conclude(pending, 3n, 'complete') === 'complete' && !pending.has('3'));
  check('a closed window retires it', conclude(pending, 4n, 'expired') === 'expired' && !pending.has('4'));
  check('inconclusive keeps it queued', conclude(pending, 5n, 'inconclusive') === 'inconclusive' && pending.has('5'));

  const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
  check('a refutation that threw is inconclusive, not a crash', conclude(pending, 6n, timeout) === 'inconclusive');
  check('and the claim it belonged to is still queued', pending.has('6'));
  check('an endpoint timing out is a transport failure, not a verdict', isTransportFailure(timeout));
  check(
    'a revert is not a transport failure',
    !isTransportFailure(Object.assign(new Error('revert'), { code: 'CALL_EXCEPTION' })),
  );
  check('one failure retired nothing else', pending.size === 2);

  console.log(failed ? `\n${failed} FAILED` : '\nall held');
  if (failed > 0) process.exitCode = 1;
}

runScript(main);
