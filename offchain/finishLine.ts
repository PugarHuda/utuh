import { JsonRpcProvider, Wallet, formatEther, keccak256, concat, toUtf8Bytes } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, requirePrivateKey } from './config';
import { registryAt, creditAt, signer } from './lib/contracts';

/// Finish a line whose repayment claim is already sealed.
///
/// `npm run full` builds the whole thing in one process, which means an interrupted run leaves a
/// sealed claim and an open line behind rather than losing them — the state lives on Creditcoin,
/// not in the script. This picks that state back up.
///
///   npm run finish -- <registry> <credit> <claimId> <lineId>
async function main() {
  const [registryAddress, creditAddress, claimIdArg, lineIdArg] = process.argv.slice(2);
  if (!registryAddress || !creditAddress || !claimIdArg || !lineIdArg) {
    throw new Error('usage: npm run finish -- <registry> <credit> <repayClaimId> <lineId>');
  }
  const claimId = BigInt(claimIdArg);
  const lineId = BigInt(lineIdArg);

  const master = requirePrivateKey();
  const lender = signer(CC3_RPC, CC3_CHAIN_ID, master);
  const cc3 = lender.provider as JsonRpcProvider;

  // Same derivation as fullFlow.ts — the borrower is the one who must settle.
  const borrower = new Wallet(keccak256(concat([master, toUtf8Bytes('utuh/borrower')])), cc3);

  const registry = registryAt(registryAddress, borrower);
  const registryRead = registryAt(registryAddress, lender);
  const credit = creditAt(creditAddress, borrower);
  const creditRead = creditAt(creditAddress, lender);

  const claim = await registryRead.claim(claimId);
  console.log(`repay claim ${claimId}: ${statusName(claim.status)}  aggregate ${formatEther(claim.aggregate)} ETH`);

  if (Number(claim.status) === 2) {
    const until = Number(await registryRead.challengeUntil(claimId));
    console.log(`  challenge window closes at CC3 block ${until}`);
    await waitForBlock(cc3, until + 1);
    await (await registry.finalize(claimId)).wait();
    console.log(`  finalized: ${statusName((await registryRead.claim(claimId)).status)}`);
  }

  let line = await creditRead.line(lineId);
  console.log(`\nline ${lineId}: ${lineStatusName(line.status)}  drawn ${formatEther(line.drawn)} CTC`);
  console.log(`  requires ${formatEther(line.repayRequired)} ETH proven, due at CC3 block ${line.dueBlock}`);
  console.log(`  now at block ${await cc3.getBlockNumber()}`);

  await (await credit.settle(lineId, claimId)).wait();
  line = await creditRead.line(lineId);
  console.log(`\nline ${lineId}: ${lineStatusName(line.status)}`);
  if (Number(line.status) !== 2) throw new Error('line should be Settled');

  console.log('\nThe loop is closed. Credit issued on Creditcoin against proven Sepolia history,');
  console.log('repaid on Sepolia, and settled on Creditcoin. Nothing bridged.');
}

async function waitForBlock(provider: JsonRpcProvider, target: number): Promise<void> {
  for (;;) {
    const now = await provider.getBlockNumber();
    if (now >= target) {
      process.stdout.write('\r');
      return;
    }
    process.stdout.write(`\r  waiting for CC3 block ${target}, at ${now}   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function statusName(s: bigint | number): string {
  return ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'][Number(s)] ?? String(s);
}

function lineStatusName(s: bigint | number): string {
  return ['None', 'Active', 'Settled', 'Defaulted'][Number(s)] ?? String(s);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + (e.stack ?? e.message));
    process.exit(1);
  });
