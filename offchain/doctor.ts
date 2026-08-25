import { Contract, JsonRpcProvider, formatEther } from 'ethers';
import chainInfoAbi from '@gluwa/usc-sdk/dist/chain-info/chain_info.json';
import 'dotenv/config';
import {
  CC3_RPC,
  CC3_CHAIN_ID,
  CHAIN_INFO_ADDRESS,
  CHAIN_KEY,
  PROVER_URL,
  SOURCE_RPCS,
  SOURCE_TIMEOUT_MS,
  sources,
  withDeadline,
  requirePrivateKey,
} from './config';
import { signer, readDeployments } from './lib/contracts';
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
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_TOPIC = '0x' + '00'.repeat(32);
const PROBE: Record<number, { address: string; topics: string[] }> = {
  [CHAIN_KEY.mainnet]: {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
    topics: [TRANSFER, ZERO_TOPIC],
  },
  [CHAIN_KEY.sepolia]: {
    address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', // WETH
    topics: [TRANSFER, ZERO_TOPIC],
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

  const chainInfo = new Contract(CHAIN_INFO_ADDRESS, chainInfoAbi as any, cc3);

  for (const [name, key] of Object.entries(CHAIN_KEY)) {
    console.log(`\n${name} (chain key ${key})`);

    let frontier = 0;
    try {
      frontier = Number((await chainInfo.get_latest_attestation_height_and_hash(key))[0]);
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
    const from = Math.max(0, frontier - 400);
    const to = Math.max(0, frontier - 40);
    let answered = 0;
    const counts: number[] = [];

    for (const { url, provider } of sources(key)) {
      try {
        const logs = await withDeadline(
          SOURCE_TIMEOUT_MS,
          provider.getLogs({ address: probe.address, topics: probe.topics, fromBlock: from, toBlock: to }),
        );
        answered++;
        counts.push(logs.length);
        console.log(`  ok    ${host(url)}  scanned ${to - from} blocks, ${logs.length} matched`);
      } catch (e: any) {
        console.log(`  FAIL  ${host(url)}  ${(e.shortMessage ?? e.message).slice(0, 60)}`);
      } finally {
        provider.destroy();
      }
    }

    if (answered < 2) {
      problems++;
      console.log(`  PROBLEM  only ${answered} of ${SOURCE_RPCS[key].length} answered.`);
      console.log('           Sealing a claim needs two. Add endpoints through');
      console.log(`           ${name.toUpperCase()}_RPCS_EXTRA, or replace the list with ${name.toUpperCase()}_RPCS.`);
    } else if (new Set(counts).size > 1) {
      // Not a failure — the union is what gets claimed, and disagreement is exactly what having
      // more than one endpoint is for. Worth seeing, though.
      console.log(`  note  endpoints disagreed on the count (${counts.join(' vs ')})`);
    }

    try {
      const prover = new Prover(key, PROVER_URL, SOURCE_TIMEOUT_MS);
      await prover.waitAttested(to);
      console.log(`  ok    proof builder has block ${to}`);
    } catch (e: any) {
      problems++;
      console.log(`  FAIL  proof builder: ${(e.message ?? '').slice(0, 70)}`);
    }
  }

  const d = readDeployments();
  if (d.registry) {
    console.log('\ndeployments.json');
    for (const [k, v] of Object.entries(d)) console.log(`  ${k.padEnd(9)} ${v}`);
  }

  console.log(problems === 0 ? '\nEverything needed is reachable.' : `\n${problems} problem(s) above.`);
  if (problems > 0) process.exitCode = 1;
}

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
