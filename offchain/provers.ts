import { Contract, JsonRpcProvider } from 'ethers';
import 'dotenv/config';
import {
  CC3_RPC,
  CC3_CHAIN_ID,
  CHAIN_INFO_ADDRESS,
  CHAIN_KEY,
  PROVER_URL,
  sources,
} from './config';
import { Prover } from './lib/proofs';
import { chainInfoAt } from './lib/chain';

/// Prove the same transaction both ways, and time it.
///
/// The claim that refutation does not depend on a hosted service is only worth as much as the
/// evidence for it, and "the code path exists" is not evidence. This takes a real recently
/// attested transaction, proves it through the hosted Proof Builder and then through the local
/// builder with the hosted one pointed at a dead port, and prints both.
///
/// The timing is the part worth knowing. The local builder re-fetches every sibling transaction
/// in the block and every block in the continuity range, so it is correct and roughly two orders
/// of magnitude slower. That is fine for a claimant and it is the thing a refuter has to size a
/// challenge window against.
///
///   npm run provers                 # Sepolia
///   npm run provers -- mainnet
async function main() {
  const which = (process.argv[2] ?? 'sepolia') as keyof typeof CHAIN_KEY;
  const chainKey = CHAIN_KEY[which];
  if (chainKey === undefined) throw new Error(`unknown chain ${which} — use sepolia or mainnet`);

  const cc3 = new JsonRpcProvider(CC3_RPC, CC3_CHAIN_ID, { staticNetwork: true });
  const chainInfo = chainInfoAt(cc3);
  const frontier = Number((await chainInfo.getLatestAttestedHeightAndHash(chainKey)).height);

  // Step back from the frontier so the block is comfortably attested, then take a real
  // transaction out of it. Nothing is hardcoded, so there is no fixture here to go stale.
  const { url, provider } = sources(chainKey)[0];
  let height = frontier - 50;
  let txHash: string | undefined;
  for (let i = 0; i < 20 && !txHash; i++, height--) {
    const block = await provider.send('eth_getBlockByNumber', ['0x' + height.toString(16), false]);
    if (block?.transactions?.length) txHash = block.transactions[0];
  }
  if (!txHash) throw new Error('no transaction found near the attestation frontier');
  height += 1;

  const block = await provider.send('eth_getBlockByNumber', ['0x' + height.toString(16), false]);
  console.log(`${which} block ${height}, ${block.transactions.length} transaction(s), via ${new URL(url).host}`);
  console.log(`proving ${txHash}\n`);
  provider.destroy();

  const event = { blockNumber: height, txHash, txIndex: 0, logIndexInTx: 0, value: 0n } as any;
  const results: Record<string, { roots: number; seconds: number }> = {};

  for (const [name, prover] of [
    // The hosted builder alone, so a hosted outage shows up as a hosted failure.
    ['hosted', new Prover(chainKey, PROVER_URL, 180_000)],
    // The local builder alone: same wiring as everything else, with the hosted URL sent nowhere.
    ['local', Prover.withDefaults(chainKey, 180_000, 'http://127.0.0.1:1')],
  ] as const) {
    const started = process.hrtime.bigint();
    try {
      const { continuity } = await prover.proveOne(event);
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      results[name] = { roots: continuity.roots.length, seconds };
      console.log(`  ${name.padEnd(7)} ok    ${seconds.toFixed(1)}s   ${continuity.roots.length} continuity roots`);
    } catch (e: any) {
      console.log(`  ${name.padEnd(7)} FAIL  ${String(e.message ?? e).slice(0, 100)}`);
    }
    prover.close();
  }

  cc3.destroy();

  if (results.hosted && results.local) {
    const agree = results.hosted.roots === results.local.roots;
    console.log(
      `\n${agree ? 'Both' : 'The two'} proofs carry ${agree ? 'the same' : 'different'} continuity roots` +
        `${agree ? '' : ` (${results.hosted.roots} vs ${results.local.roots})`}.`,
    );
    console.log(
      `The local path is ${(results.local.seconds / results.hosted.seconds).toFixed(0)}x slower. ` +
        'Size the challenge window for it, not for the fast one.',
    );
    if (!agree) process.exitCode = 1;
  } else {
    console.log('\nOne of the two could not answer, which is the situation the other exists for.');
  }
}

main().catch((e) => {
  console.error('\n' + (e.stack ?? e.message));
  process.exit(1);
});
