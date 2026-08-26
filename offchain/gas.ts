import { JsonRpcProvider, Interface } from 'ethers';
import { utils } from '@gluwa/usc-sdk';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID } from './config';
import { artifact, readDeployments } from './lib/contracts';

/// What the registry actually costs, measured rather than reasoned about.
///
/// The design argument turns on a specific claim: one storage write per event means a claim of any
/// size settles with one proof, but building it does not scale for free. That claim was written
/// from first principles, and first principles do not know what a Block Prover verification costs.
/// This reads the real receipts of every registry transaction on chain and says.
///
/// It is deliberately independent of any explorer API: the transactions are found from the
/// registry's own logs and the costs come from `eth_getTransactionReceipt`, so it answers on any
/// node and keeps answering if Blockscout is down.
///
///   npm run gas                       # the deployed registry from deployments.json
///   npm run gas -- <registry> [more]  # any registries you like
const LOOKBACK = Number(process.env.GAS_LOOKBACK ?? 100_000);
/// CC3's RPC gives up on a wide eth_getLogs, the same way the watcher's source-chain sweep has to
/// be chunked.
const CHUNK = Number(process.env.GAS_LOG_CHUNK ?? 2_000);

interface Row {
  method: string;
  members: number;
  /// Continuity roots carried by the call, for reporting.
  roots: number;
  /// What the EVM charges for this call's calldata alone: 16 gas per non-zero byte, 4 per zero.
  /// This turns out to be the dominant term by a distance — an append carrying one fat mainnet
  /// transaction costs more than one carrying three small ones — which is why a model built on
  /// member count alone produces nonsense.
  calldataGas: number;
  gasUsed: bigint;
}

async function main() {
  const args = process.argv.slice(2);
  const registries = args.length ? args : [readDeployments().registry].filter(Boolean) as string[];
  if (!registries.length) throw new Error('no registry — pass one, or run npm run deploy');

  const cc3 = new JsonRpcProvider(CC3_RPC, CC3_CHAIN_ID, { staticNetwork: true });
  const iface = new Interface(artifact('UtuhRegistry.sol', 'UtuhRegistry').abi);
  const head = await cc3.getBlockNumber();
  const from = Math.max(0, head - LOOKBACK);
  console.log(`CC3 blocks ${from}..${head}\n`);

  const rows: Row[] = [];

  for (const registry of registries) {
    // Which transactions touched this registry, and what each one did. `EventAppended` is the only
    // event emitted more than once per transaction, so counting it per transaction is exactly the
    // batch size — the number this is trying to price.
    const appendsByTx = new Map<string, number>();
    const methodByTx = new Map<string, string>();

    for (let start = from; start <= head; start += CHUNK) {
      const end = Math.min(start + CHUNK - 1, head);
      const logs = await cc3.getLogs({ address: registry, fromBlock: start, toBlock: end });
      for (const log of logs) {
        let name: string;
        try {
          name = iface.parseLog({ topics: [...log.topics], data: log.data })?.name ?? 'unknown';
        } catch {
          continue;
        }
        if (name === 'EventAppended') {
          appendsByTx.set(log.transactionHash, (appendsByTx.get(log.transactionHash) ?? 0) + 1);
          methodByTx.set(log.transactionHash, 'appendBatch');
        } else if (!methodByTx.has(log.transactionHash) || methodByTx.get(log.transactionHash) === 'appendBatch') {
          // ClaimOpened and the rest are one per transaction. An appendBatch never emits them, so
          // whichever arrives is the method, and appendBatch only wins if EventAppended is present.
          if (!appendsByTx.has(log.transactionHash)) methodByTx.set(log.transactionHash, name);
        }
      }
    }

    if (methodByTx.size === 0) {
      console.log(`${registry}: no transactions in this range — widen GAS_LOOKBACK`);
      continue;
    }

    for (const [txHash, name] of methodByTx) {
      const [receipt, tx] = await Promise.all([cc3.getTransactionReceipt(txHash), cc3.getTransaction(txHash)]);
      if (!receipt) continue;
      rows.push({
        method: nameToMethod(name),
        members: appendsByTx.get(txHash) ?? 0,
        roots: tx ? continuityRoots(iface, tx.data) : 0,
        calldataGas: tx ? calldataGas(tx.data) : 0,
        gasUsed: receipt.gasUsed,
      });
    }
    console.log(`${registry}: ${methodByTx.size} transaction(s)`);
  }

  cc3.destroy();
  if (!rows.length) throw new Error('nothing measured');

  console.log('\noperation             n      gas      % of a 75M block');
  const byMethod = new Map<string, Row[]>();
  for (const r of rows) {
    const label = r.method === 'appendBatch' ? `appendBatch(${r.members})` : r.method;
    byMethod.set(label, [...(byMethod.get(label) ?? []), r]);
  }
  for (const [label, group] of [...byMethod.entries()].sort()) {
    const mean = group.reduce((a, r) => a + r.gasUsed, 0n) / BigInt(group.length);
    console.log(
      `  ${label.padEnd(20)} ${String(group.length).padStart(2)}  ${String(mean).padStart(9)}` +
        `  ${utils.gas.gasAsPercentageOfMax(mean).toFixed(2)}%`,
    );
  }

  // gas = fixed + a*calldataGas + b*members, least-squares over the appends actually on chain.
  //
  // The first regressor is not a proxy: it is exactly what the EVM charges for the bytes of the
  // call, so a well-behaved fit should land its coefficient near 1.0, and that is the check on
  // whether the model means anything. What is left over is execution — decoding the transaction,
  // running the Block Prover, and one storage write per member.
  const appends = rows.filter((r) => r.method === 'appendBatch' && r.members > 0);
  const fit = solve3(appends);
  if (fit) {
    const [fixed, perCalldataGas, perMember] = fit;
    const residual = (r: Row) => Number(r.gasUsed) - (fixed + perCalldataGas * r.calldataGas + perMember * r.members);
    const worst = Math.max(...appends.map((a) => Math.abs(residual(a))));
    const meanGas = appends.reduce((a, r) => a + Number(r.gasUsed), 0) / appends.length;

    console.log(`${chr10}fitted over ${appends.length} append transaction(s):`);
    console.log(`  ${r0(fixed)} gas fixed`);
    console.log(`  ${perCalldataGas.toFixed(2)} x the call's own calldata gas  (1.00 would be exact)`);
    console.log(`  ${r0(perMember)} gas per member on top of its bytes`);
    console.log(`  worst residual ${r0(worst)} gas, ${((worst / meanGas) * 100).toFixed(0)}% of the mean append`);

    // The claim this is here to settle. A member's own cost is small; what a claim really pays for
    // is the size of the transactions it proves, and that is not something the claimant chooses.
    const medianBytes = median(appends.map((r) => r.calldataGas / r.members));
    console.log(`${chr10}median ${r0(medianBytes)} gas of calldata per member, on the claims measured here:`);
    for (const size of [100, 1_000, 10_000]) {
      const batches = Math.ceil(size / 10);
      const total = fixed * batches + perCalldataGas * medianBytes * size + perMember * size;
      console.log(
        `  a ${size.toLocaleString()}-event claim: ${batches} batches, ` +
          `~${(total / 1e6).toFixed(1)}M gas, ${(total / Number(utils.gas.MAX_GAS_CAP)).toFixed(1)} full block(s) of it`,
      );
    }
    console.log(`${chr10}Refutation does not move with any of this: one proof and a binary search.`);
  } else {
    console.log(`${chr10}Not enough variety in the appends on chain to fit a cost model.`);
  }
}

const chr10 = String.fromCharCode(10);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/// What the EVM charges for these bytes: 16 per non-zero, 4 per zero, per EIP-2028.
function calldataGas(data: string): number {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  let gas = 0;
  for (let i = 0; i + 1 < hex.length; i += 2) gas += hex[i] === '0' && hex[i + 1] === '0' ? 4 : 16;
  return gas;
}

const r0 = (n: number) => Math.round(n).toLocaleString();

/// How many continuity roots this call carried, read straight out of its calldata.
function continuityRoots(iface: Interface, data: string): number {
  try {
    const parsed = iface.parseTransaction({ data });
    for (const arg of parsed?.args ?? []) {
      const roots = (arg as any)?.roots;
      if (Array.isArray(roots)) return roots.length;
    }
  } catch {
    /* a call this ABI does not know is not worth a crash */
  }
  return 0;
}

/// Least squares for gas = c0 + c1*calldataGas + c2*members, by Gaussian elimination on the 3x3
/// normal equations. Returns null when the observations do not span enough directions to determine
/// them, which is the honest answer to "what does a member cost" after one batch shape.
function solve3(rows: Row[]): [number, number, number] | null {
  if (rows.length < 3) return null;
  const basis = (r: Row) => [1, r.calldataGas, r.members];
  const A = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (const r of rows) {
    const x = basis(r);
    const y = Number(r.gasUsed);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) A[i][j] += x[i] * x[j];
      A[i][3] += x[i] * y;
    }
  }
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    if (Math.abs(A[pivot][col]) < 1e-9) return null;
    [A[col], A[pivot]] = [A[pivot], A[col]];
    for (let row = 0; row < 3; row++) {
      if (row === col) continue;
      const f = A[row][col] / A[col][col];
      for (let k = col; k < 4; k++) A[row][k] -= f * A[col][k];
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
}

function nameToMethod(event: string): string {
  return (
    {
      ClaimOpened: 'open',
      ClaimSealed: 'seal',
      ClaimFinalized: 'finalize',
      ClaimRefuted: 'refute',
      ClaimAbandoned: 'abandon',
      Withdrawn: 'withdraw',
      EventAppended: 'appendBatch',
    } as Record<string, string>
  )[event] ?? event;
}

main().catch((e) => {
  console.error('\n' + (e.stack ?? e.message));
  process.exit(1);
});
