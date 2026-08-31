import { JsonRpcProvider } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, CHAIN_KEY, USDC, TRANSFER_SIG, source } from './config';
import { chainInfoAt, blockProverAt } from './lib/chain';
import { scopeFor, scanScope, Metric, type ScopedEvent } from './lib/scope';
import { isPayloadTooLarge } from './lib/gasLimit';
import { Prover, planBatches } from './lib/proofs';
import { runScript } from './lib/cli';
import { proofProvider } from '@gluwa/usc-sdk';
import { hashInner, hashLeaf, merkleRootOf } from './lib/merkle';

const BLOCK_PROVER = '0x0000000000000000000000000000000000000FD2';

/// Both `verify` overloads take five arguments, so ethers cannot pick one by arity. The SDK's
/// `PrecompileBlockProver.verifyBatch` names the batch form by its full signature —
/// `verify(uint64,uint64[],bytes[],(bytes32,(bytes32,bool)[])[],(bytes32,bytes32[]))` — which is
/// the one thing this script had to work out by hand before it used the SDK's client.

/// Read-only validation of the proving path, before any CTC is spent.
///
/// The Block Prover exposes a `view` twin of `verifyAndEmit`, so the whole verification can be
/// exercised through `eth_call` against the live testnet with no gas and no funded account.
///
/// What this settles, and no local test could: the batch entrypoint takes one continuity proof
/// spanning a range of blocks and verifies every query against it. Handing that same shared proof
/// to the single-query entrypoint fails with "Merkle root mismatch" for any query outside the
/// first block — which is why UtuhRegistry.appendBatch calls the array form.
async function main() {
  const cc3 = new JsonRpcProvider(CC3_RPC, CC3_CHAIN_ID, { staticNetwork: true });
  const ck = CHAIN_KEY.mainnet;

  const chainInfo = chainInfoAt(cc3);
  const frontier = Number((await chainInfo.getLatestAttestedHeightAndHash(ck)).height);

  // Fixed by default, overridable so a range that failed elsewhere can be replayed here. CI hit
  // a 413 sweeping 25840720..25840780; PROBE_TO=25840780 reproduces it exactly.
  const span = Number(process.env.PROBE_SPAN ?? 60);
  const toBlock = process.env.PROBE_TO ? Number(process.env.PROBE_TO) : frontier - 30;
  const fromBlock = toBlock - span;
  const eth = source(ck);

  const raw = await eth.getLogs({ address: USDC, topics: [TRANSFER_SIG], fromBlock, toBlock });
  const bySender = new Map<string, number>();
  for (const l of raw) {
    const s = '0x' + l.topics[1].slice(26);
    bySender.set(s, (bySender.get(s) ?? 0) + 1);
  }
  const [subject] = [...bySender.entries()].sort((a, b) => b[1] - a[1])[0];

  console.log(`Ethereum mainnet attested on Creditcoin to block ${frontier}`);
  console.log(`sweeping ${fromBlock}..${toBlock}`);
  console.log(`busiest USDC sender in range: ${subject} (${bySender.get(subject)} transfers)`);

  const scope = scopeFor({
    chainKey: ck,
    emitter: USDC,
    eventSig: TRANSFER_SIG,
    subject,
    subjectTopic: 1,
    metric: Metric.DATA_WORD,
    metricArg: 0,
  });

  const events = (await scanScope(eth, scope, fromBlock, toBlock)).slice(0, 24);
  const batches = planBatches(events);
  console.log(`${events.length} events -> ${batches.length} batches of ${batches.map((b) => b.length).join(', ')}`);

  const prover = Prover.withDefaults(ck, 60000);
  await prover.waitAttested(toBlock);

  // The SDK's own precompile client, rather than an ABI held by hand. `verifyBatch` is the view
  // twin of the emitting form, which is what lets this whole script run on an empty wallet.
  const bp = blockProverAt(cc3);

  let checked = 0;

  /// Verify one batch, splitting it if the endpoint will not carry it.
  ///
  /// `MAX_BATCH` caps queries, and ten queries carry ten whole encoded transactions — how many
  /// bytes that is depends on which transactions the source chain happened to put in range. A
  /// window whose busiest sender submits large ones outgrows the proxy in front of the RPC, which
  /// answers 413 before the precompile sees anything. The limit is the endpoint's, so it is found
  /// rather than guessed: halve and retry, down to a single query. Splitting keeps the ordering,
  /// which is what the appending path would need if this read-only one ever wrote.
  async function verify(batch: ScopedEvent[], label: string): Promise<void> {
    const { proofs, continuity } = await prover.proveBatch(batch);
    if (checked === 0 && proofs[0]) checkLocalHashingMatchesTheSdk(proofs[0]);
    const heights = proofs.map((p) => p.blockHeight);
    const merkleProofs = proofs.map((p) => ({ root: p.merkleRoot, siblings: p.siblings }));
    const blocks = new Set(heights).size;
    const txCount = new Set(batch.map((e) => e.txHash)).size;

    let ok: boolean;
    try {
      ok = await bp.verifyBatch(
        ck,
        heights,
        proofs.map((p) => p.encodedTransaction),
        merkleProofs,
        continuity,
      );
    } catch (e) {
      if (!isPayloadTooLarge(e) || batch.length < 2) throw e;
      const half = Math.ceil(batch.length / 2);
      console.log(`\n${label} was refused as too large at ${batch.length} queries — splitting`);
      await verify(batch.slice(0, half), `${label}a`);
      await verify(batch.slice(half), `${label}b`);
      return;
    }

    console.log(
      `\n${label}: ${proofs.length} queries across ${txCount} tx and ${blocks} block(s), ` +
        `${continuity.roots.length} shared continuity roots -> verify=${ok}`,
    );
    if (!ok) throw new Error('batch verification returned false');

    for (let j = 0; j < proofs.length; j++) {
      const txIndex = await bp.computeTransactionIndex(merkleProofs[j]);
      const key = (BigInt(heights[j]) << 96n) | (BigInt(txIndex) << 32n) | BigInt(proofs[j].logIndex);
      console.log(`  block ${heights[j]} tx#${txIndex} log#${proofs[j].logIndex}  key=${key}`);
      checked++;
    }
  }

  for (const [i, batch] of batches.entries()) await verify(batch, `batch ${i + 1}`);

  console.log(`\n${checked} Ethereum mainnet events verified by the precompile at ${BLOCK_PROVER}.`);
  console.log('No CTC spent — every call above was an eth_call against the live CC3 testnet.');
}

/// The console cannot import the SDK's hashing, so this proves the copy that replaced it.
///
/// `offchain/lib/merkle.ts` re-states `hashLeaf` and `hashInner` against the ESM ethers the browser
/// bundle already carries. Importing them from `@gluwa/usc-sdk` instead — CommonJS only, no
/// `module` field — pulls a second copy of ethers in beside the first and took the console from
/// 312 KB to 827 KB, half a megabyte for two keccaks on a page whose whole argument is that a
/// stranger can open it and refute a claim.
///
/// A re-stated rule that nothing checks is a rule that drifts. This runs the SDK's own functions
/// beside the local ones over a proof this script has just fetched from the live builder, so the
/// SDK stays the definition and a divergence is a red daily job rather than a silent wrong hash.
/// It costs no extra network call: the proof is one the probe already had in hand.
function checkLocalHashingMatchesTheSdk(proof: {
  encodedTransaction: string;
  merkleRoot: string;
  siblings: { hash: string; isLeft: boolean }[];
}): void {
  const sdk = proofProvider.merkle;

  if (sdk.hashLeaf(proof.encodedTransaction) !== hashLeaf(proof.encodedTransaction)) {
    throw new Error('hashLeaf no longer agrees with the SDK — see offchain/lib/merkle.ts');
  }
  for (const s of proof.siblings) {
    if (sdk.hashInner(s.hash, proof.merkleRoot) !== hashInner(s.hash, proof.merkleRoot)) {
      throw new Error('hashInner no longer agrees with the SDK — see offchain/lib/merkle.ts');
    }
  }

  const folded = merkleRootOf(proof.encodedTransaction, proof.siblings);
  if (folded.toLowerCase() !== proof.merkleRoot.toLowerCase()) {
    throw new Error(`a proof fetched just now does not fold to its own root: ${folded} vs ${proof.merkleRoot}`);
  }
  console.log(
    `Local Merkle hashing agrees with @gluwa/usc-sdk over ${proof.siblings.length} sibling(s), ` +
      'and the proof folds to the root the builder shipped.',
  );
}

runScript(main);
