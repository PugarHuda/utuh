import { Contract, JsonRpcProvider, formatEther } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, PROVER_URL, sources, withDeadline, SOURCE_TIMEOUT_MS, requirePrivateKey } from './config';
import { readDeployments, registryAt, signer } from './lib/contracts';
import { scanScope, eventKey, type Scope, type Metric } from './lib/scope';
import { Prover } from './lib/proofs';
import { refuteClaim } from './lib/claims';

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

interface Seen {
  checked: Set<string>;
}

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
  const seen: Seen = { checked: new Set() };

  for (;;) {
    const to = await cc3.getBlockNumber();
    for (let start = from; start <= to; start += LOG_CHUNK) {
      const end = Math.min(start + LOG_CHUNK - 1, to);
      const sealed = await registry.queryFilter(registry.filters.ClaimSealed(), start, end);
      for (const log of sealed) {
        const claimId: bigint = (log as any).args[0];
        if (seen.checked.has(claimId.toString())) continue;
        seen.checked.add(claimId.toString());
        await inspect(registry, wallet, claimId, dry);
      }
    }
    from = to + 1;
    if (once) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

async function inspect(registry: Contract, wallet: any, claimId: bigint, dry: boolean): Promise<void> {
  const claim = await registry.claim(claimId);
  if (Number(claim.status) !== 2) {
    console.log(`\nclaim ${claimId}: ${statusName(claim.status)} — nothing to check`);
    return;
  }

  const until = Number(await registry.challengeUntil(claimId));
  const now = await wallet.provider.getBlockNumber();
  const members = Number(await registry.memberCount(claimId));

  console.log(`\nclaim ${claimId}: sealed with ${members} member(s), bond ${formatEther(claim.bondPosted)} CTC`);
  console.log(`  range ${claim.fromBlock}..${claim.toBlock} on chain key ${claim.scope.chainKey}`);
  console.log(`  window closes at CC3 block ${until} (now ${now}, ${until - now} to go)`);

  if (now > until) {
    console.log('  window already closed — too late to refute');
    return;
  }

  const scope: Scope = {
    chainKey: Number(claim.scope.chainKey),
    emitter: claim.scope.emitter,
    eventSig: claim.scope.eventSig,
    topics: [claim.scope.topics[0], claim.scope.topics[1], claim.scope.topics[2]],
    topicMask: Number(claim.scope.topicMask),
    metric: Number(claim.scope.metric) as Metric,
    metricArg: Number(claim.scope.metricArg),
  };

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
  const endpoints = sources(scope.chainKey);
  const byKey = new Map<bigint, any>();
  const counts: string[] = [];
  let answered = 0;

  for (const { url, provider } of endpoints) {
    try {
      const seen = await withDeadline(
        SOURCE_TIMEOUT_MS,
        scanScope(provider, scope, Number(claim.fromBlock), Number(claim.toBlock), 500),
      );
      answered++;
      counts.push(`${host(url)}=${seen.length}`);
      for (const e of seen) byKey.set(eventKey(e), e);
    } catch {
      counts.push(`${host(url)}=err`);
    } finally {
      // Release the endpoint's sockets and timers. An abandoned provider keeps retrying on its
      // own and would stop the process from ever exiting.
      provider.destroy();
    }
  }

  if (answered === 0) {
    console.log('  no endpoint answered — cannot say anything about this claim');
    return;
  }

  const events = [...byKey.values()].sort((a, b) => (eventKey(a) < eventKey(b) ? -1 : 1));
  const agreed = new Set(counts.filter((c) => !c.endsWith('=err')).map((c) => c.split('=')[1])).size <= 1;
  console.log(`  swept independently: ${counts.join('  ')}${agreed ? '' : '  <-- endpoints disagree'}`);
  console.log(`  union: ${events.length} in-scope event(s)`);

  const gaps = [];
  for (const e of events) {
    if (!(await registry.contains(claimId, eventKey(e)))) gaps.push(e);
  }

  if (gaps.length === 0) {
    if (answered < 2) {
      console.log(`  no gap found — but only ${answered} endpoint answered, so this is inconclusive`);
    } else {
      console.log(`  no gap found across ${answered} independent endpoints`);
    }
    return;
  }

  const gap = gaps[0];
  console.log(`  INCOMPLETE: ${gaps.length} event(s) missing`);
  console.log(`  first gap at block ${gap.blockNumber} tx#${gap.txIndex} log#${gap.logIndexInTx}`);

  if (dry) {
    console.log('  dry run — leaving it');
    return;
  }

  const prover = new Prover(scope.chainKey, PROVER_URL, 60_000);
  const { reward, key } = await refuteClaim(registry, prover, claimId, gap);
  console.log(`  refuted with one proof. key ${key}`);
  console.log(`  reward ${formatEther(reward)} CTC`);
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function statusName(s: bigint | number): string {
  return ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'][Number(s)] ?? String(s);
}

main().catch((e) => {
  console.error('\n' + (e.stack ?? e.message));
  process.exit(1);
});
