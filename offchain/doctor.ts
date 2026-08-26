import { JsonRpcProvider, formatEther } from 'ethers';
import 'dotenv/config';
import {
  CC3_RPC,
  CC3_CHAIN_ID,
  CHAIN_KEY,
  type ChainKey,
  PROVER_URL,
  SOURCE_TIMEOUT_MS,
  sources,
  withDeadline,
  requirePrivateKey,
} from './config';
import { signer, readDeployments, creditAt } from './lib/contracts';
import { chainInfoAt } from './lib/chain';
import { Prover } from './lib/proofs';

/// Check that the things this depends on are actually there.
///
/// Sealing a claim needs two independent endpoints to answer, so a stale endpoint list does not
/// degrade the system, it stops it. The bundled defaults were verified on the day they were
/// written and endpoints rot; "I checked once" is an assumption wearing the clothes of a fact.
/// This is how anyone finds out before a bond is on the line.
///
///   npm run doctor
/// A representative query per chain: the shape `scanScope` uses.
///
/// Representative matters in both directions. Asking for every log on the chain is a question no
/// endpoint should serve, and probing with it condemns all of them. Asking for every USDC transfer
/// across four hundred blocks is barely better — fifteen thousand logs, and the good endpoints
/// time out. A real scope always pins an indexed topic as well, which is what makes a wide range
/// affordable, so the probe pins one too: transfers *from* the zero address, which are rare
/// enough to come back empty while still making the endpoint scan the whole range.
/// A probe whose right answer is "nothing" cannot tell a working endpoint from a broken one that
/// returns nothing — which is the failure this exists to catch. So each chain gets two questions:
/// a narrow one that must come back with results, and a wide filtered one that must come back at
/// all. The first proves the endpoint is really looking; the second proves it will look far.
const PROVER_TIMEOUT_MS = Number(process.env.PROVER_TIMEOUT_MS ?? 30_000);
/// How far back to ask. Deep enough to cross a typical archive cutoff, shallow enough to answer.
const PROBE_DEPTH = Number(process.env.PROBE_DEPTH ?? 60_000);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/// Keyed by ChainKey rather than number, so adding a chain to CHAIN_KEY without giving it a probe
/// is a compile error rather than doctor crashing on `probe.address` at the moment someone runs it.
const PROBE: Record<ChainKey, { address: string; topics: string[]; narrow: number; wide: number }> = {
  [CHAIN_KEY.mainnet]: {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC, never quiet
    topics: [TRANSFER],
    narrow: 3,
    wide: 400,
  },
  [CHAIN_KEY.sepolia]: {
    address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // WETH, quiet enough to need room
    topics: [TRANSFER],
    narrow: 300,
    wide: 400,
  },
};

async function main() {
  let problems = 0;

  console.log('Creditcoin');
  const wallet = signer(CC3_RPC, CC3_CHAIN_ID, requirePrivateKey());
  const cc3 = wallet.provider as JsonRpcProvider;
  try {
    const [block, balance, net] = await Promise.all([
      cc3.getBlockNumber(),
      cc3.getBalance(wallet.address),
      cc3.getNetwork(),
    ]);
    console.log(`  ok    ${CC3_RPC}  chain ${net.chainId}  block ${block}`);
    console.log(`  ${balance > 0n ? 'ok   ' : 'WARN '} ${wallet.address}  ${formatEther(balance)} CTC`);
    if (balance === 0n) {
      problems++;
      console.log('        request from the Creditcoin Discord #token-faucet channel');
    }
  } catch (e: any) {
    problems++;
    console.log(`  FAIL  ${CC3_RPC}  ${e.shortMessage ?? e.message}`);
  }

  const chainInfo = chainInfoAt(cc3);

  for (const [name, key] of Object.entries(CHAIN_KEY)) {
    console.log(`\n${name} (chain key ${key})`);

    let frontier = 0;
    try {
      frontier = Number((await chainInfo.getLatestAttestedHeightAndHash(key)).height);
      console.log(`  ok    attested to block ${frontier}`);
    } catch (e: any) {
      problems++;
      console.log(`  FAIL  ChainInfo precompile: ${e.shortMessage ?? e.message}`);
      continue;
    }

    // Every endpoint gets the same question, and it has to be the question the sweeps actually
    // ask: one contract, one event signature, a modest range. An unfiltered query for every log
    // on the chain is one no endpoint should serve, and probing with it would condemn all of them.
    const probe = PROBE[key];
    // Probe where the sweeps actually go, not where it is easy to answer.
    //
    // Underwriting reads {MIN_HISTORY_BLOCKS} of history — hundreds of thousands of blocks — and
    // an endpoint can be perfectly correct near the head and silently empty past its archive
    // cutoff. publicnode on Sepolia agrees with tenderly at depths of 100, 5,000 and 20,000, and
    // returns zero at 60,000 where tenderly returns 22. A probe near the tip would have called it
    // healthy and a claimant would have found out by losing a bond.
    const to = Math.max(0, frontier - PROBE_DEPTH);
    const from = to - probe.narrow;
    const endpoints = sources(key);

    // Reachability is the easy half. The half that matters is whether an endpoint tells the truth
    // about a filtered query, and there is no need for a reference answer to find that out —
    // endpoints can be compared against each other. Whoever reports the most has seen the most,
    // and anyone reporting less than that is either behind or wrong.
    const seen: { url: string; narrow: number | null; scoped: number | null }[] = [];
    let subjectTopic: string | null = null;

    for (const { url, provider } of endpoints) {
      let narrow: number | null = null;
      try {
        const logs = await withDeadline(
          SOURCE_TIMEOUT_MS,
          provider.getLogs({ address: probe.address, topics: probe.topics, fromBlock: from, toBlock: to }),
        );
        narrow = logs.length;
        // Borrow a real indexed topic from whatever came back, so the second question is the shape
        // a real scope uses rather than a filter nothing can match.
        if (!subjectTopic) subjectTopic = logs.find((l: any) => l.topics?.length > 1)?.topics[1] ?? null;
      } catch {
        /* recorded as null below */
      }
      seen.push({ url, narrow, scoped: null });
      provider.destroy();
    }

    if (subjectTopic) {
      for (const row of seen) {
        const provider = sources(key).find((e) => e.url === row.url)!.provider;
        try {
          row.scoped = (
            await withDeadline(
              SOURCE_TIMEOUT_MS,
              provider.getLogs({
                address: probe.address,
                topics: [...probe.topics, subjectTopic],
                fromBlock: from,
                toBlock: to,
              }),
            )
          ).length;
        } catch {
          /* stays null */
        }
        provider.destroy();
      }
    }

    const best = Math.max(0, ...seen.map((r) => r.scoped ?? -1));
    let answered = 0;

    for (const row of seen) {
      if (row.narrow === null) {
        console.log(`  FAIL  ${host(row.url)}  unreachable or refused the query`);
        continue;
      }
      if (row.narrow === 0) {
        problems++;
        console.log(`  FAIL  ${host(row.url)}  returned nothing where there is certainly something`);
        continue;
      }
      if (row.scoped !== null && row.scoped < best) {
        problems++;
        console.log(`  WRONG ${host(row.url)}  ${row.narrow} unfiltered, but only ${row.scoped} of ${best} with a topic pinned`);
        console.log('        It answers, and what it answers is untrue. Redundancy that includes');
        console.log('        this endpoint is smaller than it looks.');
        continue;
      }
      answered++;
      console.log(`  ok    ${host(row.url)}  ${row.narrow} unfiltered, ${row.scoped ?? '-'} with a topic pinned`);
    }

    if (answered < 2) {
      problems++;
      console.log(`  PROBLEM  only ${answered} endpoint(s) can be relied on, and sealing a claim needs two.`);
      console.log(`           Add one through ${name.toUpperCase()}_RPCS_EXTRA.`);
    }

    // waitUntilHeightAttested polls for up to fifteen minutes by default. That is right for a
    // claimant waiting on the frontier and wrong for a preflight, which should answer now.
    try {
      // Its own deadline: the prover is a different service with different latency, and reusing
      // the endpoint budget would report it down whenever that budget is tightened for the sweeps.
      // Deliberately the bare hosted builder — `withDefaults` would answer this from the ChainInfo
      // precompile and report the hosted service healthy while it is down.
      const prover = new Prover(key, PROVER_URL, PROVER_TIMEOUT_MS);
      await withDeadline(PROVER_TIMEOUT_MS, prover.waitAttested(to));
      console.log(`  ok    hosted proof builder has block ${to}`);
    } catch (e: any) {
      problems++;
      console.log(`  FAIL  hosted proof builder: ${(e.message ?? '').slice(0, 70)}`);
    }

    // The hosted builder is a convenience; the local one is what makes refutation independent of
    // it. Building proofs locally needs whole blocks *with* receipts, and `eth_getBlockReceipts` is
    // a method plenty of public endpoints decline. An endpoint list that answers every sweep and
    // serves no receipts leaves the fallback looking wired and doing nothing, so ask each one.
    let receipts = 0;
    for (const { url, provider } of sources(key)) {
      try {
        const res = await withDeadline(SOURCE_TIMEOUT_MS, provider.send('eth_getBlockReceipts', [hex(to)]));
        if (Array.isArray(res)) {
          receipts++;
          console.log(`  ok    ${host(url)}  serves eth_getBlockReceipts`);
        } else {
          console.log(`  ...   ${host(url)}  eth_getBlockReceipts returned nothing usable`);
        }
      } catch (e: any) {
        console.log(`  ...   ${host(url)}  no eth_getBlockReceipts (${(e.shortMessage ?? e.message ?? '').slice(0, 40)})`);
      }
      provider.destroy();
    }
    if (receipts === 0) {
      problems++;
      console.log('  PROBLEM  no endpoint serves eth_getBlockReceipts, so the local proof builder');
      console.log(`           cannot run and refutation depends entirely on ${new URL(PROVER_URL).host}.`);
    }
  }

  const d = readDeployments();
  if (d.registry) {
    console.log('');
    console.log('deployments.json');
    // `deployer` is an account, not a contract, and expecting code at it would report a problem
    // that is not one. Only the entries that are meant to hold bytecode are checked for it.
    const CONTRACTS = new Set(['decoder', 'registry', 'credit']);
    for (const [k, v] of Object.entries(d)) {
      if (!CONTRACTS.has(k) || typeof v !== 'string') {
        // The recorded constructor arguments are a kilobyte of hex. Printing them in full buries
        // the findings this whole report exists to surface.
        // Above an address's 42 characters, so addresses still print in full.
        const shown = typeof v === 'string' && v.length > 44 ? `${v.slice(0, 12)}…${v.slice(-6)} (${v.length} chars)` : v;
        console.log(`  ...  ${k.padEnd(12)} ${shown}`);
        continue;
      }
      // An address written in a file is not a contract. Redeploy elsewhere, or keep a stale file,
      // and every script downstream aims confidently at nothing.
      const code = await cc3.getCode(v);
      if (code === '0x') problems++;
      console.log(`  ${code === '0x' ? 'FAIL' : 'ok  '} ${k.padEnd(12)} ${v}`);
    }

    // A credit contract holds the registry it was deployed against, and nothing keeps that in step
    // with this file. Redeploy the registry alone — which `npm run deploy` will happily do — and
    // every script reads the new one while the credit contract still checks claims against the
    // old, so a perfectly good finalized claim comes back `ClaimNotUsable` and nothing says why.
    // The contracts cannot drift on their precompiles, which come from a hardcoded library, but
    // this pointer is a constructor argument and drifts silently.
    if (d.credit && d.registry) {
      try {
        const wired = await creditAt(d.credit, wallet).REGISTRY();
        const same = wired.toLowerCase() === d.registry.toLowerCase();
        if (!same) problems++;
        console.log(`  ${same ? 'ok  ' : 'FAIL'} credit -> registry ${wired}`);
        if (!same) {
          console.log('        The credit contract checks claims against a different registry than');
          console.log('        the one every script here files them with. Redeploy both together.');
        }
      } catch (e: any) {
        problems++;
        console.log(`  FAIL  credit does not answer REGISTRY(): ${(e.shortMessage ?? e.message ?? '').slice(0, 60)}`);
      }
    }
  }

  console.log(problems === 0 ? '\nEverything needed is reachable.' : `\n${problems} problem(s) above.`);
  if (problems > 0) process.exitCode = 1;
}

const hex = (n: number) => '0x' + n.toString(16);

function host(url: string): string {
  try {
    return new URL(url).host.padEnd(38);
  } catch {
    return url;
  }
}

main().catch((e) => {
  console.error('\n' + (e.stack ?? e.message));
  process.exit(1);
});
