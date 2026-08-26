import { AbiCoder, formatEther } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, requirePrivateKey } from './config';
import { artifact, deploy, signer, creditAt, readDeployments, writeDeployments } from './lib/contracts';
import { plainSpec } from './lib/specs';
import { runScript } from './lib/cli';

/// Replace the UtuhCredit a deployment record points at, keeping its registry and its terms.
///
/// The published contracts were built at the commit that wrote deployments.json and three later
/// commits changed UtuhCredit.sol — `backingFor`, its twin in `settle`, and `withdrawTo`. The
/// deployed bytecode was 29,076 characters, which is exactly what that commit builds; HEAD builds
/// 29,422. So the addresses in the README named contracts without the fixes the README described.
/// UtuhRegistry, EvmV1Decoder and SettlementLedger were untouched, so only the credit moves.
///
/// The new contract is configured from the old one's own state rather than from lib/policy.ts.
/// Only the mainnet record kept its constructor arguments; the one `npm run full` wrote did not,
/// and rebuilding those from environment defaults is the guess that `deployments.json` started
/// recording arguments to avoid. Everything the constructor takes is readable on chain, so it is
/// read, passed back, and then compared field by field against the contract it came from.
///
///   DEPLOYMENTS=deployments.full.json npm run redeploy:credit

/// A spec as one comparable string. `JSON.stringify` cannot do this: `chainKey` and the topic
/// indices come back from ethers as BigInt, which it throws on rather than serialises.
function specText(s: ReturnType<typeof plainSpec>): string {
  return [
    s.chainKey,
    s.emitter,
    s.eventSig,
    s.subjectTopic,
    s.counterpartyTopic,
    s.counterparty,
    s.metric,
    s.metricArg,
  ]
    .map((v) => String(v).toLowerCase())
    .join('|');
}

async function main() {
  const d = readDeployments();
  if (!d.registry || !d.credit || !d.decoder) {
    throw new Error('the deployment record needs a registry, a credit and a decoder before one can be replaced');
  }

  const wallet = signer(CC3_RPC, CC3_CHAIN_ID, requirePrivateKey());
  const old = creditAt(d.credit, wallet);

  // LENDER is msg.sender at construction, not a constructor argument, so deploying from a
  // different key would quietly hand the credit line to somebody else.
  const lender: string = await old.LENDER();
  if (lender.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `${d.credit} has lender ${lender}, but this key is ${wallet.address}. ` +
        `Deploying from here would make a different address the lender.`,
    );
  }

  const registry: string = await old.REGISTRY();
  if (registry.toLowerCase() !== d.registry.toLowerCase()) {
    throw new Error(`${d.credit} points at registry ${registry}, but the record says ${d.registry}`);
  }

  const policy = {
    volumeUnitInCtc: await old.VOLUME_UNIT_IN_CTC(),
    minUnderwritingWindow: await old.MIN_UNDERWRITING_WINDOW(),
    minHistoryBlocks: await old.MIN_HISTORY_BLOCKS(),
    maxStalenessBlocks: await old.MAX_STALENESS_BLOCKS(),
    repaymentBps: await old.REPAYMENT_BPS(),
    repayWindowBlocks: await old.REPAY_WINDOW_BLOCKS(),
  };

  const volume = plainSpec(await old.volumeSpec());
  const repay = plainSpec(await old.repaySpec());
  const clean = [];
  for (let i = 0; i < Number(await old.cleanSpecCount()); i++) {
    clean.push(plainSpec(await old.cleanSpecAt(i)));
  }

  console.log(`replacing ${d.credit}`);
  console.log(`  registry   ${registry}`);
  console.log(`  lender     ${lender}`);
  console.log(`  terms      repay ${Number(policy.repaymentBps) / 100}% within ${policy.repayWindowBlocks} blocks`);
  console.log(`  adverse    ${clean.length} class(es)`);

  const args = [registry, policy, volume, clean, repay];
  const fresh = await deploy(wallet, artifact('UtuhCredit.sol', 'UtuhCredit'), args, { EvmV1Decoder: d.decoder });
  const address = await fresh.getAddress();
  console.log(`\nUtuhCredit ${address}`);

  // Deploying is not the same as deploying the same thing. Read the new one back.
  const checks: [string, unknown, unknown][] = [
    ['REGISTRY', await fresh.REGISTRY(), registry],
    ['LENDER', await fresh.LENDER(), lender],
    ['VOLUME_UNIT_IN_CTC', await fresh.VOLUME_UNIT_IN_CTC(), policy.volumeUnitInCtc],
    ['MIN_UNDERWRITING_WINDOW', await fresh.MIN_UNDERWRITING_WINDOW(), policy.minUnderwritingWindow],
    ['MIN_HISTORY_BLOCKS', await fresh.MIN_HISTORY_BLOCKS(), policy.minHistoryBlocks],
    ['MAX_STALENESS_BLOCKS', await fresh.MAX_STALENESS_BLOCKS(), policy.maxStalenessBlocks],
    ['REPAYMENT_BPS', await fresh.REPAYMENT_BPS(), policy.repaymentBps],
    ['REPAY_WINDOW_BLOCKS', await fresh.REPAY_WINDOW_BLOCKS(), policy.repayWindowBlocks],
    ['volumeSpec', specText(plainSpec(await fresh.volumeSpec())), specText(volume)],
    ['repaySpec', specText(plainSpec(await fresh.repaySpec())), specText(repay)],
    ['cleanSpecCount', await fresh.cleanSpecCount(), BigInt(clean.length)],
  ];
  for (const [name, got, want] of checks) {
    const same =
      typeof got === 'string' && typeof want === 'string' ? got.toLowerCase() === want.toLowerCase() : got === want;
    if (!same) throw new Error(`the new contract disagrees about ${name}: ${got} vs ${want}`);
  }
  for (let i = 0; i < clean.length; i++) {
    const got = specText(plainSpec(await fresh.cleanSpecAt(i)));
    if (got !== specText(clean[i]!)) throw new Error(`the new contract disagrees about cleanSpecAt(${i})`);
  }
  console.log(`  ${checks.length + clean.length} fields read back and matched`);

  // A retired address holding capital is capital nobody is watching, so say what it holds. This
  // reports rather than sweeps: the lender's own `withdraw` is one call and it is their decision,
  // and a migration script that moves money on its own is a worse thing to have around.
  const stranded: bigint = await old.available();
  const lines: bigint = (await old.nextLineId()) - 1n;
  console.log(`\n${d.credit} holds ${formatEther(stranded)} CTC of undrawn liquidity across ${lines} line(s).`);
  if (stranded > 0n) {
    console.log(`  withdraw it to the lender before retiring that address — the lines themselves do not move.`);
  }

  const ctor = artifact('UtuhCredit.sol', 'UtuhCredit').abi.find((f: { type: string }) => f.type === 'constructor');
  writeDeployments({
    ...d,
    credit: address,
    creditArgs: AbiCoder.defaultAbiCoder().encode(ctor.inputs, args),
  });
  console.log('\nrecord updated, constructor arguments included. Verify with: npm run verify');
}

runScript(main);
