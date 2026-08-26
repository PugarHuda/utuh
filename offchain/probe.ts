import { JsonRpcProvider } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, CHAIN_KEY, USDC, TRANSFER_SIG, source } from './config';
import { chainInfoAt, blockProverAt } from './lib/chain';
import { scopeFor, scanScope, Metric } from './lib/scope';
import { Prover, planBatches } from './lib/proofs';

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

  const toBlock = frontier - 30;
  const fromBlock = toBlock - 60;
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
  for (const [i, batch] of batches.entries()) {
    const { proofs, continuity } = await prover.proveBatch(batch);
    const heights = proofs.map((p) => p.blockHeight);
    const merkleProofs = proofs.map((p) => ({ root: p.merkleRoot, siblings: p.siblings }));
    const blocks = new Set(heights).size;
    const txCount = new Set(batch.map((e) => e.txHash)).size;

    const ok = await bp.verifyBatch(ck, heights, proofs.map((p) => p.encodedTransaction), merkleProofs, continuity);
    console.log(
      `\nbatch ${i + 1}: ${proofs.length} queries across ${txCount} tx and ${blocks} block(s), ` +
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

  console.log(`\n${checked} Ethereum mainnet events verified by the precompile at ${BLOCK_PROVER}.`);
  console.log('No CTC spent — every call above was an eth_call against the live CC3 testnet.');
}

main().catch((e) => {
  console.error('ERR', e.shortMessage ?? e.message);
  process.exit(1);
});
