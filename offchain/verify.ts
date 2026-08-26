import { execFileSync } from 'node:child_process';
import { AbiCoder, ZeroAddress } from 'ethers';
import 'dotenv/config';
import {
  CHAIN_KEY,
  USDC,
  AAVE_V3_POOL,
  TRANSFER_SIG,
  AAVE_REPAY_SIG,
  AAVE_LIQUIDATION_SIG,
} from './config';
import { artifact, readDeployments } from './lib/contracts';

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

const Metric = { COUNT: 0, DATA_WORD: 1 } as const;

/// No `shell: true`. Node deprecated passing arguments through a shell (DEP0190) precisely because
/// they are concatenated rather than escaped, and constructor arguments are the sort of long
/// attacker-influenced string that should never be pasted into a command line. `forge` resolves
/// without one on every platform this runs on.
function forge(args: string[]): void {
  execFileSync('forge', args, { stdio: 'inherit' });
}

function creditConstructorArgs(registry: string): string {
  // Rebuilt exactly as deploy.ts passes them. If those defaults are overridden by environment
  // when deploying, the same overrides have to be present here or the encoding will not match.
  const volumeSpec = {
    chainKey: CHAIN_KEY.mainnet,
    emitter: AAVE_V3_POOL,
    eventSig: AAVE_REPAY_SIG,
    subjectTopic: 2,
    counterpartyTopic: 1,
    counterparty: USDC,
    metric: Metric.DATA_WORD,
    metricArg: 0,
  };
  const cleanSpec = {
    chainKey: CHAIN_KEY.mainnet,
    emitter: AAVE_V3_POOL,
    eventSig: AAVE_LIQUIDATION_SIG,
    subjectTopic: 3,
    counterpartyTopic: 0,
    counterparty: ZeroAddress,
    metric: Metric.COUNT,
    metricArg: 0,
  };
  const repaySpec = {
    chainKey: CHAIN_KEY.mainnet,
    emitter: USDC,
    eventSig: TRANSFER_SIG,
    subjectTopic: 1,
    counterpartyTopic: 2,
    counterparty: process.env.LENDER_MAINNET ?? '0x28C6c06298d514Db089934071355E5743bf21d60',
    metric: Metric.DATA_WORD,
    metricArg: 0,
  };
  const policy = {
    volumeUnitInCtc: BigInt(process.env.VOLUME_UNIT_IN_CTC ?? '15000000000000'),
    minUnderwritingWindow: Number(process.env.MIN_CHALLENGE_WINDOW ?? 25),
    minHistoryBlocks: Number(process.env.MIN_HISTORY_BLOCKS ?? 216_000),
    maxStalenessBlocks: Number(process.env.MAX_STALENESS_BLOCKS ?? 50_400),
    repaymentBps: Number(process.env.REPAYMENT_BPS ?? 10_500),
    repayWindowBlocks: Number(process.env.REPAY_WINDOW_BLOCKS ?? 5_760),
  };

  const ctor = artifact('UtuhCredit.sol', 'UtuhCredit').abi.find((f: any) => f.type === 'constructor');
  return AbiCoder.defaultAbiCoder().encode(ctor.inputs as any, [
    registry,
    policy,
    volumeSpec,
    [cleanSpec],
    repaySpec,
  ]);
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

function main(): void {
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
      () => AbiCoder.defaultAbiCoder().encode(['uint64'], [Number(process.env.MIN_CHALLENGE_WINDOW ?? 25)]),
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
    argsFor(d.creditArgs, () => creditConstructorArgs(d.registry!), 'credit arguments'),
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

main();
