import { AbiCoder, formatEther, id, ZeroAddress } from 'ethers';
import 'dotenv/config';
import {
  CC3_RPC,
  CC3_CHAIN_ID,
  CHAIN_KEY,
  USDC,
  AAVE_V3_POOL,
  TRANSFER_SIG,
  AAVE_REPAY_SIG,
  AAVE_LIQUIDATION_SIG,
  requirePrivateKey,
} from './config';
import { artifact, deploy, signer, writeDeployments } from './lib/contracts';

const Metric = { COUNT: 0, DATA_WORD: 1 } as const;

/// Challenge window floor for this deployment, in Creditcoin blocks.
/// Production value is UtuhRegistry.RECOMMENDED_CHALLENGE_WINDOW (5760, ~24h). A lower floor is
/// set here so the demonstration can watch a window actually elapse instead of asserting that it
/// would have.
const MIN_CHALLENGE_WINDOW = Number(process.env.MIN_CHALLENGE_WINDOW ?? 25);

/// CTC wei credited per one unit of the volume reserve asset (USDC, 6 decimals).
///
/// A volume claim aggregates USDC in 1e6 units; a credit line is CTC in 1e18 wei. The conversion
/// is a price, and this contract deliberately has no oracle — so the lender states its rate here,
/// in the open. The default treats 1 USDC as 15 CTC: 15e18 / 1e6 = 1.5e13 wei per USDC unit.
const VOLUME_UNIT_IN_CTC = BigInt(process.env.VOLUME_UNIT_IN_CTC ?? '15000000000000');

/// Lender policy: how much history an underwriting must cover, and how recently it must end.
/// Production values are UtuhCredit.RECOMMENDED_HISTORY_BLOCKS (~30 days) and
/// RECOMMENDED_STALENESS_BLOCKS (~7 days).
const MIN_HISTORY_BLOCKS = Number(process.env.MIN_HISTORY_BLOCKS ?? 216_000);
const MAX_STALENESS_BLOCKS = Number(process.env.MAX_STALENESS_BLOCKS ?? 50_400);

/// The lender's terms: what a draw must repay, and how long the borrower has. Both belong to the
/// lender, which is why `draw` takes neither of them from the borrower.
const REPAYMENT_BPS = Number(process.env.REPAYMENT_BPS ?? 10_500); // 105%
const REPAY_WINDOW_BLOCKS = Number(process.env.REPAY_WINDOW_BLOCKS ?? 5_760); // ~24h

/// The lender's Ethereum mainnet address — where borrowers send repayment.
const LENDER_MAINNET = process.env.LENDER_MAINNET ?? '0x28C6c06298d514Db089934071355E5743bf21d60';

async function main() {
  const wallet = signer(CC3_RPC, CC3_CHAIN_ID, requirePrivateKey());
  const balance = await wallet.provider!.getBalance(wallet.address);
  console.log(`deployer ${wallet.address}`);
  console.log(`balance  ${formatEther(balance)} CTC`);
  if (balance === 0n) {
    throw new Error(
      `no CTC. Request from the Creditcoin Discord #token-faucet channel:\n  /faucet address:${wallet.address}`,
    );
  }

  // EvmV1Decoder exposes `public` library functions, so it is deployed once and delegatecalled.
  const decoder = await deploy(wallet, artifact('EvmV1Decoder.sol', 'EvmV1Decoder'));
  const decoderAddress = await decoder.getAddress();
  console.log(`EvmV1Decoder  ${decoderAddress}`);

  const registry = await deploy(wallet, artifact('UtuhRegistry.sol', 'UtuhRegistry'), [MIN_CHALLENGE_WINDOW], {
    EvmV1Decoder: decoderAddress,
  });
  const registryAddress = await registry.getAddress();
  console.log(`UtuhRegistry  ${registryAddress}  (min challenge window ${MIN_CHALLENGE_WINDOW} blocks)`);

  // Aave V3 Repay(address indexed reserve, address indexed user, address indexed repayer,
  //               uint256 amount, bool useATokens) -> user is topic 2, amount is data word 0.
  //
  // The reserve is pinned to USDC. Without that the aggregate would sum raw `amount` values
  // across every reserve at once, adding WETH's 18 decimals to USDC's 6 and producing a number
  // that means nothing. A volume claim is denominated in exactly one asset.
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

  // Aave V3 LiquidationCall(address indexed collateralAsset, address indexed debtAsset,
  //                         address indexed user, ...) -> subject is topic 3, counted not summed.
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

  // USDC Transfer(address indexed from, address indexed to, uint256 value): the borrower is the
  // sender and the lender is pinned as the recipient, so paying oneself proves nothing.
  const repaySpec = {
    chainKey: CHAIN_KEY.mainnet,
    emitter: USDC,
    eventSig: TRANSFER_SIG,
    subjectTopic: 1,
    counterpartyTopic: 2,
    counterparty: LENDER_MAINNET,
    metric: Metric.DATA_WORD,
    metricArg: 0,
  };

  const credit = await deploy(wallet, artifact('UtuhCredit.sol', 'UtuhCredit'), [
    registryAddress,
    {
      volumeUnitInCtc: VOLUME_UNIT_IN_CTC,
      minUnderwritingWindow: MIN_CHALLENGE_WINDOW,
      minHistoryBlocks: MIN_HISTORY_BLOCKS,
      maxStalenessBlocks: MAX_STALENESS_BLOCKS,
      repaymentBps: REPAYMENT_BPS,
      repayWindowBlocks: REPAY_WINDOW_BLOCKS,
    },
    volumeSpec,
    [cleanSpec],
    repaySpec,
  ], { EvmV1Decoder: decoderAddress });
  const creditAddress = await credit.getAddress();
  console.log(`UtuhCredit    ${creditAddress}`);
  console.log(`  repayment must land at ${LENDER_MAINNET} on Ethereum mainnet`);
  console.log(`  lender's stated rate: ${VOLUME_UNIT_IN_CTC} CTC wei per USDC unit`);
  console.log(`  accepts underwriting claims with a window of ${MIN_CHALLENGE_WINDOW}+ blocks`);
  console.log(`  terms: repay ${REPAYMENT_BPS / 100}% within ${REPAY_WINDOW_BLOCKS} CC3 blocks`);
  console.log('  adverse classes: 1 (Aave V3 LiquidationCall) — add more to require more');

  // Record what was actually passed, so verification does not have to guess it back out of the
  // environment it happened to be run in.
  const creditAbi = artifact('UtuhCredit.sol', 'UtuhCredit').abi.find((f: any) => f.type === 'constructor');
  writeDeployments({
    chainId: CC3_CHAIN_ID,
    deployer: wallet.address,
    decoder: decoderAddress,
    registry: registryAddress,
    credit: creditAddress,
    registryArgs: AbiCoder.defaultAbiCoder().encode(['uint64'], [MIN_CHALLENGE_WINDOW]),
    creditArgs: AbiCoder.defaultAbiCoder().encode(creditAbi.inputs as any, [
      registryAddress,
      {
        volumeUnitInCtc: VOLUME_UNIT_IN_CTC,
        minUnderwritingWindow: MIN_CHALLENGE_WINDOW,
        minHistoryBlocks: MIN_HISTORY_BLOCKS,
        maxStalenessBlocks: MAX_STALENESS_BLOCKS,
        repaymentBps: REPAYMENT_BPS,
        repayWindowBlocks: REPAY_WINDOW_BLOCKS,
      },
      volumeSpec,
      [cleanSpec],
      repaySpec,
    ]),
  });
  console.log('\nwrote deployments.json, constructor arguments included');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
