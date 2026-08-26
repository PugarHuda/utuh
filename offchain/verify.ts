import { execFileSync } from 'node:child_process';
import { AbiCoder } from 'ethers';
import 'dotenv/config';
import { artifact, readDeployments } from './lib/contracts';
import { MIN_CHALLENGE_WINDOW, creditConstructorArgs } from './lib/policy';

/// Publish the source of every deployed contract to the block explorer.
///
/// An unverified address is a wall of bytecode. Anyone assessing this — a judge, an auditor, a
/// lender deciding whether to trust a registry — has to be able to read what they are trusting,
/// and "the source is on GitHub" is not the same claim as "this address runs that source".
///
/// Blockscout reports a *partial* match here: the runtime bytecode agrees, the trailing metadata
/// hash does not, which is what happens when the compilation environment is not reproduced
/// byte-for-byte. The code is readable and the functions are callable, which is the point.
///
///   npm run verify
const EXPLORER = process.env.EXPLORER_URL ?? 'https://creditcoin-testnet.blockscout.com/api';
const SEPOLIA_EXPLORER = process.env.SEPOLIA_EXPLORER_URL ?? 'https://eth-sepolia.blockscout.com/api';
const DEPLOYMENTS_FILE = process.env.DEPLOYMENTS ?? 'deployments.json';
const DECODER_PATH = 'node_modules/@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol:EvmV1Decoder';

function forge(args: string[]): void {
  execFileSync('forge', args, { stdio: 'inherit' });
}

/// Blockscout indexes a deployment a little after the chain has it, and until it does it answers
/// `Address is not a smart-contract` — which reads like the deployment failed rather than like the
/// explorer has not caught up. Running verify straight after deploy hits this every time.
async function waitUntilIndexed(explorerApi: string, address: string): Promise<void> {
  const base = explorerApi.replace(/[/]api[/]?$/, '');
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${base}/api/v2/addresses/${address}`);
      if (res.ok && (await res.json()).is_contract === true) return;
    } catch {
      /* the explorer being unreachable is worth one more try, not a crash */
    }
    if (i === 0) console.log(`  waiting for the explorer to index ${address}...`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log(`  the explorer still does not see ${address} as a contract — trying anyway`);
}

/// Encode UtuhCredit's constructor arguments the way deploy.ts passed them.
///
/// The specs and the policy come from lib/policy.ts, which deploy.ts reads too. They used to be
/// thirty-three duplicated lines here whose only job was to stay byte-identical to that file, and
/// Blockscout rejects a verification whose constructor arguments differ by one byte.
function encodeCreditArgs(registry: string): string {
  const ctor = artifact('UtuhCredit.sol', 'UtuhCredit').abi.find((f: any) => f.type === 'constructor');
  return AbiCoder.defaultAbiCoder().encode(ctor.inputs as any, creditConstructorArgs(registry));
}

/// Prefer what the deployment recorded over what this environment would guess.
///
/// Blockscout needs the constructor arguments byte for byte. Rebuilding them from environment
/// defaults works right up until someone deploys with `VOLUME_UNIT_IN_CTC` set and verifies
/// without it, at which point verification fails for a reason nothing in the output mentions.
/// `deploy.ts` now writes them down; the fallback is only for deployment files written before it
/// did, and it says so when it is used.
function argsFor(
  recorded: string | undefined,
  rebuild: () => string,
  what: string,
  ledger?: string,
  from = 'the environment',
): string {
  if (recorded) return recorded;
  // The rebuild reads lib/policy.ts, which describes a lender underwriting Aave on Ethereum
  // mainnet. A deployment that carries a `ledger` is a full-flow one: its specs point at that
  // SettlementLedger on a testnet instead, so the rebuild is not merely unrecorded, it is known to
  // be wrong. Blockscout would reject the result for a byte mismatch and say nothing about why.
  if (ledger) {
    throw new Error(
      `no ${what} recorded in ${DEPLOYMENTS_FILE}, and this deployment carries a ledger ` +
        `(${ledger}) — so its specs point at that contract, not at Aave, and rebuilding them from ` +
        `lib/policy.ts would produce arguments that are simply not the ones it was deployed with. ` +
        `Redeploy with \`npm run full\`, which records them, or pass --constructor-args to forge ` +
        `verify-contract by hand.`,
    );
  }
  console.log(`  (no ${what} recorded in ${DEPLOYMENTS_FILE} — rebuilding from ${from})`);
  return rebuild();
}

async function main(): Promise<void> {
  const d = readDeployments();
  if (!d.decoder || !d.registry || !d.credit) throw new Error('no deployments.json — run: npm run deploy');

  const common = [
    '--compiler-version',
    '0.8.28',
    '--num-of-optimizations',
    '200',
    '--verifier',
    'blockscout',
    '--watch',
  ];

  for (const [name, address] of [
    ['decoder', d.decoder],
    ['registry', d.registry],
    ['credit', d.credit],
  ] as const) {
    if (address) await waitUntilIndexed(EXPLORER, address);
    void name;
  }

  console.log('EvmV1Decoder');
  forge(['verify-contract', d.decoder, DECODER_PATH, '--verifier-url', EXPLORER, ...common]);

  console.log('\nUtuhRegistry');
  forge([
    'verify-contract',
    d.registry,
    'src/UtuhRegistry.sol:UtuhRegistry',
    '--verifier-url',
    EXPLORER,
    '--constructor-args',
    argsFor(
      d.registryArgs,
      // The registry takes one argument and the record carries it, so this is reconstruction from
      // what was written down rather than from the ambient environment.
      () => AbiCoder.defaultAbiCoder().encode(['uint64'], [d.challengeWindow ?? MIN_CHALLENGE_WINDOW]),
      'registry arguments',
      d.challengeWindow === undefined ? d.ledger : undefined,
      d.challengeWindow === undefined ? 'the environment' : `the recorded challenge window of ${d.challengeWindow}`,
    ),
    '--libraries',
    `${DECODER_PATH}:${d.decoder}`,
    ...common,
  ]);

  console.log('\nUtuhCredit');
  forge([
    'verify-contract',
    d.credit,
    'src/UtuhCredit.sol:UtuhCredit',
    '--verifier-url',
    EXPLORER,
    '--constructor-args',
    argsFor(d.creditArgs, () => encodeCreditArgs(d.registry!), 'credit arguments', d.ledger),
    '--libraries',
    `${DECODER_PATH}:${d.decoder}`,
    ...common,
  ]);

  // Recorded by `npm run full`; the environment variable is the fallback for a deployment made
  // before that was written down.
  const ledger = d.ledger ?? process.env.LEDGER;
  if (ledger) {
    console.log('\nSettlementLedger (source chain)');
    forge([
      'verify-contract',
      ledger,
      'src/source/SettlementLedger.sol:SettlementLedger',
      '--verifier-url',
      SEPOLIA_EXPLORER,
      ...common,
    ]);
  } else {
    console.log('\nSettlementLedger: set LEDGER=<address> to verify the source-chain contract too');
  }

  console.log('\nhttps://creditcoin-testnet.blockscout.com/address/' + d.registry);
}

main().catch((e) => {
  console.error('\n' + (e.message ?? e));
  process.exit(1);
});
