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
function argsFor(recorded: string | undefined, rebuild: () => string, what: string): string {
  if (recorded) return recorded;
  console.log(`  (no ${what} recorded in deployments.json — rebuilding from the environment)`);
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
      () => AbiCoder.defaultAbiCoder().encode(['uint64'], [MIN_CHALLENGE_WINDOW]),
      'registry arguments',
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
    argsFor(d.creditArgs, () => encodeCreditArgs(d.registry!), 'credit arguments'),
    '--libraries',
    `${DECODER_PATH}:${d.decoder}`,
    ...common,
  ]);

  const ledger = process.env.LEDGER;
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
