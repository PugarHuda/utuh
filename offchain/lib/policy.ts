import { ZeroAddress } from 'ethers';
import { Metric } from './scope';
import {
  CHAIN_KEY,
  USDC,
  AAVE_V3_POOL,
  TRANSFER_SIG,
  AAVE_REPAY_SIG,
  AAVE_LIQUIDATION_SIG,
} from '../config';

/// The lender's deployment configuration, in one place.
///
/// `deploy.ts` passed these to the constructor and `verify.ts` rebuilt them from the same
/// environment defaults, in a second copy — thirty-three duplicated lines whose only job was to
/// stay byte-identical to the first. Blockscout rejects a verification whose constructor arguments
/// differ by one byte, and a copy that drifts produces exactly that, with nothing in the output
/// saying why. `deploy.ts` records what it actually used in deployments.json and `verify.ts`
/// prefers that; this module is what they share when there is nothing recorded to prefer.
///
/// `Metric` comes from ./scope rather than being restated here. It was restated here once, and
/// the two copies agreed only by luck: this module builds the HistorySpec that goes into the
/// constructor and is then immutable, while ./scope builds the Scope the watcher sweeps with.
/// Had they drifted, the deployed contract would have measured one thing and every sweep
/// looked for another, with no error anywhere — just claims that never match.
/// `test_theEnumsAreWhatTheOffchainMirrorSays` pins both to the Solidity enum.

export interface HistorySpec {
  chainKey: number;
  emitter: string;
  eventSig: string;
  subjectTopic: number;
  counterpartyTopic: number;
  counterparty: string;
  metric: number;
  metricArg: number;
}

export interface Policy {
  volumeUnitInCtc: bigint;
  minUnderwritingWindow: number;
  minHistoryBlocks: number;
  maxStalenessBlocks: number;
  repaymentBps: number;
  repayWindowBlocks: number;
}

/// Challenge window floor for this deployment, in Creditcoin blocks. The production value is
/// UtuhRegistry.RECOMMENDED_CHALLENGE_WINDOW (5760, ~24h); a lower floor is the default here so a
/// demonstration can watch a window elapse rather than assert that it would have.
export const MIN_CHALLENGE_WINDOW = Number(process.env.MIN_CHALLENGE_WINDOW ?? 25);

/// The lender's Ethereum mainnet address — where borrowers send repayment.
export const LENDER_MAINNET = process.env.LENDER_MAINNET ?? '0x28C6c06298d514Db089934071355E5743bf21d60';

/// CTC wei credited per one unit of the volume reserve asset (USDC, 6 decimals).
///
/// A volume claim aggregates USDC in 1e6 units; a credit line is CTC in 1e18 wei. The conversion
/// is a price, and the contract deliberately has no oracle — so the lender states its rate here,
/// in the open. The default treats 1 USDC as 15 CTC: 15e18 / 1e6 = 1.5e13 wei per USDC unit.
export const policy = (): Policy => ({
  volumeUnitInCtc: BigInt(process.env.VOLUME_UNIT_IN_CTC ?? '15000000000000'),
  minUnderwritingWindow: MIN_CHALLENGE_WINDOW,
  // How much history an underwriting must cover, and how recently it must end. Production values
  // are UtuhCredit.RECOMMENDED_HISTORY_BLOCKS (~30 days) and RECOMMENDED_STALENESS_BLOCKS (~7).
  minHistoryBlocks: Number(process.env.MIN_HISTORY_BLOCKS ?? 216_000),
  maxStalenessBlocks: Number(process.env.MAX_STALENESS_BLOCKS ?? 50_400),
  // What a draw must repay and how long the borrower has. Both belong to the lender, which is why
  // `draw` takes neither of them from the borrower.
  repaymentBps: Number(process.env.REPAYMENT_BPS ?? 10_500),
  repayWindowBlocks: Number(process.env.REPAY_WINDOW_BLOCKS ?? 5_760),
});

/// Aave V3 Pool: Repay(reserve, user, repayer, amount, useATokens). The subject is the user in
/// topic 2, and the reserve is pinned to USDC in topic 1 so an aggregate stays in one asset
/// rather than summing WETH's 18 decimals into USDC's 6.
export const volumeSpec = (): HistorySpec => ({
  chainKey: CHAIN_KEY.mainnet,
  emitter: AAVE_V3_POOL,
  eventSig: AAVE_REPAY_SIG,
  subjectTopic: 2,
  counterpartyTopic: 1,
  counterparty: USDC,
  metric: Metric.DATA_WORD,
  metricArg: 0,
});

/// Aave V3 Pool: LiquidationCall(collateralAsset, debtAsset, user, ...). The subject is the
/// liquidated user in topic 3, and the metric counts rather than sums — a liquidation that
/// happened to carry a zero amount is still a liquidation.
export const cleanSpec = (): HistorySpec => ({
  chainKey: CHAIN_KEY.mainnet,
  emitter: AAVE_V3_POOL,
  eventSig: AAVE_LIQUIDATION_SIG,
  subjectTopic: 3,
  counterpartyTopic: 0,
  counterparty: ZeroAddress,
  metric: Metric.COUNT,
  metricArg: 0,
});

/// USDC Transfer(from, to, value): the borrower is the sender and the lender is pinned as the
/// recipient, so paying oneself proves nothing.
export const repaySpec = (): HistorySpec => ({
  chainKey: CHAIN_KEY.mainnet,
  emitter: USDC,
  eventSig: TRANSFER_SIG,
  subjectTopic: 1,
  counterpartyTopic: 2,
  counterparty: LENDER_MAINNET,
  metric: Metric.DATA_WORD,
  metricArg: 0,
});

/// Exactly what UtuhCredit's constructor takes, in order.
export const creditConstructorArgs = (registry: string): unknown[] => [
  registry,
  policy(),
  volumeSpec(),
  [cleanSpec()],
  repaySpec(),
];
