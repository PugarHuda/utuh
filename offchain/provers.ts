import { JsonRpcProvider } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, CHAIN_KEY, PROVER_URL, sources } from './config';
import type { ContinuityProofStruct, EventProofStruct } from './lib/proofs';
import { Prover } from './lib/proofs';
import { chainInfoAt } from './lib/chain';
import { runScript } from './lib/cli';

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
  /// The whole proof, not a summary of it. Comparing `roots.length` was what this did first, and a
  /// count is not agreement: two builders returning different root hashes, a different lower
  /// endpoint and different transaction bytes agree on the number of roots as long as both arrays
  /// are the same length. The README's claim is that the two paths produce the *same proof*, so
  /// what gets compared is the proof.
  const results: Record<string, { proof: EventProofStruct; continuity: ContinuityProofStruct; seconds: number }> = {};

  for (const [name, prover] of [
    // The hosted builder alone, so a hosted outage shows up as a hosted failure.
    ['hosted', new Prover(chainKey, PROVER_URL, 180_000)],
    // The local builder alone: same wiring as everything else, with the hosted URL sent nowhere.
    ['local', Prover.withDefaults(chainKey, 180_000, 'http://127.0.0.1:1')],
  ] as const) {
    const started = process.hrtime.bigint();
    try {
      const { proof, continuity } = await prover.proveOne(event);
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      results[name] = { proof, continuity, seconds };
      console.log(`  ${name.padEnd(7)} ok    ${seconds.toFixed(1)}s   ${continuity.roots.length} continuity roots`);
    } catch (e: any) {
      console.log(`  ${name.padEnd(7)} FAIL  ${String(e.message ?? e).slice(0, 100)}`);
    }
    prover.close();
  }

  cc3.destroy();

  if (results.hosted && results.local) {
    const differences = compare(results.hosted, results.local);
    const rootCount = results.hosted.continuity.roots.length;
    if (differences.length === 0) {
      console.log(
        `${chr10}Both proofs are byte-for-byte identical: same lower endpoint, same ${rootCount} continuity ` +
          `root(s), same transaction bytes, same Merkle root, same ${results.hosted.proof.siblings.length} sibling(s).`,
      );
    } else {
      console.log(`${chr10}The two proofs DISAGREE:`);
      for (const d of differences) console.log(`  ${d}`);
    }
    console.log(
      `The local path is ${(results.local.seconds / results.hosted.seconds).toFixed(0)}x slower. ` +
        'Size the challenge window for it, not for the fast one.',
    );
    if (differences.length > 0) process.exitCode = 1;
  } else {
    console.log('\nOne of the two could not answer, which is the situation the other exists for.');
  }
}

const chr10 = String.fromCharCode(10);

/// Every field of the two proofs, named individually so a failure says which one moved.
function compare(
  a: { proof: EventProofStruct; continuity: ContinuityProofStruct },
  b: { proof: EventProofStruct; continuity: ContinuityProofStruct },
): string[] {
  const out: string[] = [];
  const eq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();

  if (!eq(a.continuity.lowerEndpointDigest, b.continuity.lowerEndpointDigest)) {
    out.push(`lower endpoint digest: ${a.continuity.lowerEndpointDigest} vs ${b.continuity.lowerEndpointDigest}`);
  }
  if (a.continuity.roots.length !== b.continuity.roots.length) {
    out.push(`continuity root count: ${a.continuity.roots.length} vs ${b.continuity.roots.length}`);
  } else {
    for (const [i, root] of a.continuity.roots.entries()) {
      if (!eq(root, b.continuity.roots[i]!)) out.push(`continuity root ${i}: ${root} vs ${b.continuity.roots[i]}`);
    }
  }
  if (a.proof.blockHeight !== b.proof.blockHeight) {
    out.push(`block height: ${a.proof.blockHeight} vs ${b.proof.blockHeight}`);
  }
  if (!eq(a.proof.encodedTransaction, b.proof.encodedTransaction)) {
    out.push(`encoded transaction differs in bytes`);
  }
  if (!eq(a.proof.merkleRoot, b.proof.merkleRoot)) {
    out.push(`merkle root: ${a.proof.merkleRoot} vs ${b.proof.merkleRoot}`);
  }
  if (a.proof.siblings.length !== b.proof.siblings.length) {
    out.push(`sibling count: ${a.proof.siblings.length} vs ${b.proof.siblings.length}`);
  } else {
    for (const [i, sib] of a.proof.siblings.entries()) {
      const t = b.proof.siblings[i]!;
      if (!eq(sib.hash, t.hash) || sib.isLeft !== t.isLeft) {
        out.push(`sibling ${i}: ${sib.hash}/${sib.isLeft} vs ${t.hash}/${t.isLeft}`);
      }
    }
  }
  return out;
}

runScript(main);
