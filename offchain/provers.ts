import { Contract } from 'ethers';
import 'dotenv/config';
import { CHAIN_KEY, PROVER_URL, cc3 as cc3Provider, sources, withDeadline } from './config';
import type { ContinuityProofStruct, EventProofStruct } from './lib/proofs';
import { Prover } from './lib/proofs';
import { chainInfoAt } from './lib/chain';
import { artifact } from './lib/contracts';
import { runScript } from './lib/cli';
import sepoliaRecord from '../deployments.full.json';
import mainnetRecord from '../deployments.json';

/// Prove the same transaction both ways, and time it.
///
/// The claim that refutation does not depend on a hosted service is only worth as much as the
/// evidence for it, and "the code path exists" is not evidence. This takes a real recently
/// attested transaction, proves it through the hosted Proof Builder and then through the local
/// builder with the hosted one pointed at a dead port, and prints both.
///
/// The timing is the part worth knowing. The local builder used to re-fetch every sibling transaction
/// in the block and every block in the continuity range, so it is correct and roughly two orders
/// of magnitude slower. That is fine for a claimant and it is the thing a refuter has to size a
/// challenge window against.
///
///   npm run provers                 # Sepolia
///   npm run provers -- mainnet
///   npm run provers -- --sample 3   # the newest 3 claim members, both builders, exit 1 on any difference
///                                   # (PROVERS_DEADLINE_MS per proof, default 1200000)
async function main() {
  const at = process.argv.indexOf('--sample');
  if (at !== -1) return sample(Number(process.argv[at + 1]));

  const which = (process.argv[2] ?? 'sepolia') as keyof typeof CHAIN_KEY;
  const chainKey = CHAIN_KEY[which];
  if (chainKey === undefined) throw new Error(`unknown chain ${which} — use sepolia or mainnet`);

  const cc3 = cc3Provider();
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

  // The local builder alone. This used to be `withDefaults` with the primary hosted URL sent to a
  // dead port — which still wires the *alternate* hosted hostname, so the "local" timing was the
  // hosted service under its other name, and the README repeated a 1x that measured nothing. Wired
  // by hand here: no hosted builder at all, source RPCs and the precompile only.
  const localRpcs = sources(chainKey).map((s) => s.provider);
  const local = new Prover(chainKey, 'http://127.0.0.1:1', 180_000).withLocalFallback(localRpcs, cc3);

  for (const [name, prover] of [
    // The hosted builder alone, so a hosted outage shows up as a hosted failure.
    ['hosted', new Prover(chainKey, PROVER_URL, 180_000)],
    ['local', local],
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

  for (const p of localRpcs) p.destroy();
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

type Proven = { proof: EventProofStruct; continuity: ContinuityProofStruct; seconds: number };

/// How long either builder gets for one sampled member: long enough that a correct build finishes, because
/// this is a check of agreement, not of speed. The local builder fetches each of the hundred continuity
/// blocks whole, with every receipt and a 500 ms pause the SDK hardcodes, so a busy block costs minutes, not
/// the 20–30 seconds a quiet one does. Measured 2026-09-14 on Sepolia claim 13's member 11582696/107/0:
/// hosted 5.0 s, local 400.1 s, identical. Twenty minutes is three times that.
const SAMPLE_DEADLINE_MS = Number(process.env.PROVERS_DEADLINE_MS ?? 1_200_000);

/// Cross-check the two builders on events a claim already holds.
///
/// The single-transaction run above proves *a* transaction both ways; this proves the ones that
/// matter — members the Block Prover already accepted into a published claim — and fails on any byte
/// of difference. A local proof costs 20–30 seconds, which is why this is a sample on a schedule and
/// not a step on the refutation path.
///
/// Members come from the registries' own `keyAt`, newest claim first, alternating between the two
/// published deployments so both source chains are exercised. A key is `block << 96 | txIndex << 32 |
/// logIndex`, and the transaction hash is read back from the source chain at that position. A member
/// either builder could not prove is unknown, not agreement, and fails the run like a mismatch.
async function sample(n: number): Promise<void> {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('usage: npm run provers -- --sample <N>, where N is how many claim members to cross-check');
  }
  const cc3 = cc3Provider();
  const abi = artifact('UtuhRegistry.sol', 'UtuhRegistry').abi;

  type Member = { deployment: string; claimId: number; chainKey: number; key: bigint };
  const perRegistry: Member[][] = [];
  // Mainnet first: it is the chain the real claims are about, and the one whose endpoints serve a busy
  // block's receipts in one answer. Sepolia's refuse them as too large often enough that its local proofs
  // can outrun the deadline below — which the run then reports rather than waits out.
  for (const [deployment, record] of [
    ['mainnet', mainnetRecord],
    ['sepolia', sepoliaRecord],
  ] as const) {
    const registry = new Contract(record.registry, abi, cc3);
    const found: Member[] = [];
    for (let id = Number(await registry.nextClaimId()) - 1; id >= 1 && found.length < n; id--) {
      const count = Number(await registry.memberCount(id));
      if (count === 0) continue;
      const chainKey = Number((await registry.claim(id)).scope.chainKey);
      for (let i = count - 1; i >= 0 && found.length < n; i--) {
        found.push({ deployment, claimId: id, chainKey, key: BigInt(await registry.keyAt(id, i)) });
      }
    }
    perRegistry.push(found);
  }
  const picked: Member[] = [];
  for (let i = 0; picked.length < n && perRegistry.some((r) => r[i]); i++) {
    for (const r of perRegistry) if (r[i] && picked.length < n) picked.push(r[i]!);
  }
  if (picked.length === 0) throw new Error('neither published registry holds a claim member to cross-check');

  let agreed = 0;
  const failures: string[] = [];
  for (const m of picked) {
    const blockNumber = Number(m.key >> 96n);
    const txIndex = Number((m.key >> 32n) & 0xffffffffn);
    const logIndexInTx = Number(m.key & 0xffffffffn);
    const where = `${m.deployment} claim ${m.claimId} member ${blockNumber}/${txIndex}/${logIndexInTx}`;
    const fail = (why: string) => {
      failures.push(`${where}: ${why}`);
      console.log(`  FAIL  ${where}  ${why}`);
    };

    const endpoints = sources(m.chainKey);
    let txHash: string | undefined;
    for (const { provider } of endpoints) {
      try {
        const hex = '0x' + blockNumber.toString(16);
        const block = await withDeadline(20_000, provider.send('eth_getBlockByNumber', [hex, false]));
        txHash = block?.transactions?.[txIndex];
        if (txHash) break;
      } catch {
        /* the next endpoint */
      }
    }
    if (!txHash) {
      for (const { provider } of endpoints) provider.destroy();
      fail('no source endpoint returned the block — unknown, not agreement');
      continue;
    }

    const event = { blockNumber, txHash, txIndex, logIndexInTx, value: 0n };
    const got: { hosted?: Proven; local?: Proven } = {};
    for (const name of ['hosted', 'local'] as const) {
      const prover =
        name === 'hosted'
          ? new Prover(m.chainKey, PROVER_URL, 180_000)
          : new Prover(m.chainKey, 'http://127.0.0.1:1', 180_000).withLocalFallback(
              endpoints.map((e) => e.provider),
              cc3,
            );
      const started = process.hrtime.bigint();
      try {
        // A deadline per proof, because a builder that never finishes is not a builder that agreed: past it the
        // member is unknown and the run fails saying so. Sepolia endpoints answer some `eth_getBlockReceipts`
        // with "response too large", and the builder then walks the endpoint list block by block.
        const r = await withDeadline(SAMPLE_DEADLINE_MS, prover.proveOne(event));
        got[name] = { ...r, seconds: Number(process.hrtime.bigint() - started) / 1e9 };
      } catch (e: any) {
        fail(`${name} builder could not prove it (${String(e.message ?? e).slice(0, 80)}) — unknown, not agreement`);
      }
      prover.close();
    }
    for (const { provider } of endpoints) provider.destroy();
    if (!got.hosted || !got.local) continue;

    const differences = compare(got.hosted, got.local);
    if (got.hosted.proof.logIndex !== logIndexInTx) {
      differences.push(`log index ${got.hosted.proof.logIndex}, the claim's key says ${logIndexInTx}`);
    }
    if (differences.length === 0) {
      agreed++;
      console.log(
        `  ok    ${where}  identical: ${got.hosted.continuity.roots.length} continuity root(s), ` +
          `${got.hosted.proof.siblings.length} sibling(s); hosted ${got.hosted.seconds.toFixed(1)}s, ` +
          `local ${got.local.seconds.toFixed(1)}s`,
      );
    } else {
      fail(`the builders DISAGREE: ${differences.join('; ')}`);
    }
  }
  cc3.destroy();

  console.log(
    `${chr10}${agreed} of ${picked.length} claim member(s) proven byte-for-byte identically by the hosted and local builders`,
  );
  if (failures.length > 0) process.exitCode = 1;
}

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
