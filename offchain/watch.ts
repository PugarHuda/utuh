import { Contract, JsonRpcProvider, formatEther } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, sources, withDeadline, SOURCE_TIMEOUT_MS, requirePrivateKey } from './config';
import { readDeployments, registryAt, signer } from './lib/contracts';
import { scanScopeUnion, eventKey, type Scope } from './lib/scope';
import { toScope } from './lib/specs';
import { Prover } from './lib/proofs';
import { refuteClaim } from './lib/claims';
import { isTransportFailure } from './lib/gasLimit';

/// The watcher.
///
/// Every guarantee Utuh makes rests on one sentence: *anyone may refute a claim by proving one
/// in-scope event it left out*. Until something is actually watching, that sentence describes a
/// possibility rather than a fact — a bond nobody is trying to take is not a deterrent, it is a
/// deposit.
///
/// This is that something. It follows `ClaimSealed`, rebuilds each claim's scope from what the
/// registry stores, sweeps the source chain itself, and refutes anything incomplete before the
/// window closes. It trusts the claimant for nothing: the range, the scope and the membership
/// test all come from the chain, and the sweep is its own.
///
///   npm run watch              follow new claims until stopped
///   npm run watch -- --once    sweep what is already sealed and exit
///   npm run watch -- --dry     report gaps without spending the gas to refute

const POLL_MS = Number(process.env.WATCH_POLL_MS ?? 20_000);
const LOOKBACK = Number(process.env.WATCH_LOOKBACK ?? 5_000);
/// CC3's RPC gives up on a wide eth_getLogs after ten seconds, so the catch-up sweep is chunked
/// the same way the source-chain sweep is.
const LOG_CHUNK = Number(process.env.WATCH_LOG_CHUNK ?? 2_000);

/// What an inspection concluded. Only a terminal verdict retires a claim from the queue — a
/// watcher that forgets a claim it failed to check is blind to it for good.
type Verdict = 'settled' | 'refuted' | 'complete' | 'expired' | 'inconclusive';

const NL = String.fromCharCode(10);

async function main() {
  const once = process.argv.includes('--once');
  const dry = process.argv.includes('--dry');

  const d = readDeployments();
  const registryAddress = process.env.REGISTRY ?? d.registry;
  if (!registryAddress) throw new Error('no registry — set REGISTRY or run npm run deploy');

  const wallet = signer(CC3_RPC, CC3_CHAIN_ID, requirePrivateKey());
  const cc3 = wallet.provider as JsonRpcProvider;
  const registry = registryAt(registryAddress, wallet);

  console.log(`watching ${registryAddress}`);
  console.log(`as        ${wallet.address}${dry ? '  (dry run — will not refute)' : ''}`);

  const head = await cc3.getBlockNumber();
  let from = Math.max(0, head - LOOKBACK);

  /// Claims seen sealed and not yet resolved. A claim leaves this only on a verdict that cannot
  /// change — refuted, finalized by someone else, proven complete by more than one endpoint, or
  /// past its window. Anything short of that (every endpoint down, an RPC hiccup, a lost race)
  /// leaves it in, because the alternative is deciding a claim is fine on the strength of never
  /// having managed to look at it.
  const pending = new Set<string>();

  /// What this watcher has done since it started.
  ///
  /// A daemon that only ever prints the claim in front of it cannot answer the question anyone
  /// actually has of it — has it been working, and has it caught anything. `refuted` is the number
  /// that matters: a watcher reporting zero refutations after a week is either watching an honest
  /// world or is quietly broken, and the other counters are what tell those apart.
  const tally = { seen: 0, refuted: 0, complete: 0, settled: 0, expired: 0, inconclusive: 0, sweeps: 0 };

  /// Find newly sealed claims and order them by how soon their windows close.
  async function discover(): Promise<bigint[]> {
    const to = await cc3.getBlockNumber();
    for (let start = from; start <= to; start += LOG_CHUNK) {
      const end = Math.min(start + LOG_CHUNK - 1, to);
      const sealed = await registry.queryFilter(registry.filters.ClaimSealed(), start, end);
      for (const log of sealed) pending.add(String((log as any).args[0]));
    }
    from = to + 1;
    // Soonest deadline first. A claim with three blocks left cannot wait behind one with five
    // thousand just because it was discovered second.
    return byDeadline(registry, [...pending]);
  }

  for (;;) {
    // Discovery is three RPC calls — the head, the ClaimSealed sweep, and reading each queued
    // claim's deadline — and none of them were protected. Inspection was: a lost race or an
    // endpoint failing mid-sweep left the watcher running. But a single hiccup while *finding*
    // claims escaped to the top and ended the process, which is the same failure the per-claim
    // guard exists to prevent, in the half of the loop nobody wrapped.
    //
    // `from` only advances on a clean sweep, so a failure re-reads the range rather than skipping
    // over claims sealed inside it, and `pending` is untouched.
    let queue: bigint[];
    try {
      queue = await discover();
    } catch (e: any) {
      console.log(`${NL}looking for claims failed — ${e.shortMessage ?? e.message}`);
      console.log(`  will re-read from block ${from}; ${pending.size} claim(s) still queued`);
      if (once) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }


    for (const claimId of queue) {
      tally.seen++;
      let verdict: Verdict;
      try {
        verdict = await inspect(registry, wallet, claimId, dry);
      } catch (e: any) {
        // A lost race, a reverted refutation, an endpoint failing mid-sweep. None of these are
        // reasons to stop watching, and none of them settle anything.
        const kind = isTransportFailure(e) ? 'an endpoint never answered' : 'inspection failed';
        console.log(`${NL}claim ${claimId}: ${kind} — ${e.shortMessage ?? e.message}`);
        verdict = 'inconclusive';
      }
      tally[verdict]++;
      if (verdict !== 'inconclusive') pending.delete(String(claimId));
    }
    tally.sweeps++;

    console.log(
      `${NL}${tally.sweeps} sweep(s): ${tally.seen} claim(s) seen, ${tally.refuted} refuted, ` +
        `${tally.complete} complete, ${tally.settled} settled elsewhere, ${tally.expired} expired, ` +
        `${tally.inconclusive} inconclusive, ${pending.size} still queued`,
    );
    if (once) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/// Order a batch of claim ids by how soon their windows close.
async function byDeadline(registry: Contract, ids: string[]): Promise<bigint[]> {
  const withUntil = await Promise.all(
    ids.map(async (id) => ({ id: BigInt(id), until: Number(await registry.challengeUntil(id)) })),
  );
  withUntil.sort((a, b) => a.until - b.until);
  return withUntil.map((x) => x.id);
}

async function inspect(registry: Contract, wallet: any, claimId: bigint, dry: boolean): Promise<Verdict> {
  const claim = await registry.claim(claimId);
  if (Number(claim.status) !== 2) {
    console.log(`\nclaim ${claimId}: ${statusName(claim.status)} — nothing to check`);
    return Number(claim.status) === 4 ? 'refuted' : 'settled';
  }

  const until = Number(await registry.challengeUntil(claimId));
  const now = await wallet.provider.getBlockNumber();
  const members = Number(await registry.memberCount(claimId));

  console.log(`\nclaim ${claimId}: sealed with ${members} member(s), bond ${formatEther(claim.bondPosted)} CTC`);
  console.log(`  range ${claim.fromBlock}..${claim.toBlock} on chain key ${claim.scope.chainKey}`);
  console.log(`  window closes at CC3 block ${until} (now ${now}, ${until - now} to go)`);

  if (now > until) {
    console.log('  window already closed — too late to refute');
    return 'expired';
  }

  // Rebuilt from what the chain holds, through the same conversion every other script uses. This
  // was a second copy of `toScope` written out by hand, which is one more place for the watcher's
  // idea of a scope to drift from the claimant's — and a watcher sweeping a slightly different
  // scope than the one bonded finds gaps that are not there, or misses ones that are.
  const scope: Scope = toScope(claim.scope);

  // Sweep every endpoint we have, and take the union rather than a vote.
  //
  // A watcher that asks one node whether a claim is complete has swapped trusting the claimant for
  // trusting a node operator — the same problem, one layer down. Voting would not fix it either,
  // since a majority of endpoints can be wrong together or captured.
  //
  // What makes this tractable is that a refutation verifies itself. If any single endpoint
  // mentions an event the claim omits, the Block Prover settles whether it is real; a fabricated
  // one simply fails to prove and costs the watcher its gas. So the widest possible set of
  // candidates is the right input, and no endpoint has to be trusted for the *positive* case.
  //
  // The negative case is the one that stays soft. "No gap found" is only ever as strong as the
  // endpoints that looked, which is why it is reported with its provenance rather than as a fact.
  const sweep = await scanScopeUnion(
    sources(scope.chainKey),
    scope,
    Number(claim.fromBlock),
    Number(claim.toBlock),
    500,
    (work) => withDeadline(SOURCE_TIMEOUT_MS, work),
  );

  if (sweep.answered === 0) {
    console.log('  no endpoint answered — cannot say anything about this claim, will retry');
    return 'inconclusive';
  }

  const events = sweep.events;
  console.log(`  swept independently: ${sweep.perSource.join('  ')}`);
  for (const c of sweep.conflicts) console.log(`  ENDPOINT CONFLICT: ${c}`);
  console.log(`  union: ${events.length} in-scope event(s)`);

  const gaps = [];
  for (const e of events) {
    if (!(await registry.contains(claimId, eventKey(e)))) gaps.push(e);
  }

  if (gaps.length === 0) {
    if (sweep.answered < 2) {
      console.log(`  no gap found — but only ${sweep.answered} endpoint answered, so this is inconclusive`);
      return 'inconclusive';
    }
    console.log(`  no gap found across ${sweep.answered} independent endpoints`);
    return 'complete';
  }

  const gap = gaps[0];
  console.log(`  INCOMPLETE: ${gaps.length} event(s) missing`);
  console.log(`  first gap at block ${gap.blockNumber} tx#${gap.txIndex} log#${gap.logIndexInTx}`);

  if (dry) {
    console.log('  dry run — leaving it');
    return 'inconclusive';
  }

  const prover = Prover.withDefaults(scope.chainKey, 60_000);
  // The watcher outlives the refutation, so the providers this prover opened have to be closed or
  // each catch leaves another set of sockets behind for the rest of the run.
  const { reward, key } = await refuteClaim(registry, prover, claimId, gap, (m) => console.log(m)).finally(() =>
    prover.close(),
  );
  console.log(`  refuted with one proof. key ${key}`);
  console.log(`  reward ${formatEther(reward)} CTC`);
  return 'refuted';
}

function statusName(s: bigint | number): string {
  return ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'][Number(s)] ?? String(s);
}

// A watcher is the one thing here that has to stay up, and Node ends a process on an unhandled
// rejection. Anything that escapes the loop's own guards would otherwise take the watcher down
// between claims, silently. Logged and survived: the claim it belonged to is still in `pending`.
process.on('unhandledRejection', (reason) => {
  console.error(`${NL}unhandled rejection, still watching — ${(reason as any)?.message ?? reason}`);
});

main().catch((e) => {
  console.error('\n' + (e.stack ?? e.message));
  process.exit(1);
});
