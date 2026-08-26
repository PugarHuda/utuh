import { JsonRpcProvider } from 'ethers';
import { chainInfo, blockProver } from '@gluwa/usc-sdk';
import { CHAIN_INFO_ADDRESS } from '../config';

/// One way to ask Creditcoin what it has attested.
///
/// Six scripts used to build their own `new Contract(CHAIN_INFO, chainInfoAbi, ...)` out of the
/// SDK's raw ABI json, which meant six copies of the address, six copies of the snake_case method
/// names, and no types on any of them. The SDK ships `PrecompileChainInfoProvider` for exactly
/// this — it is the same precompile, reached through an interface that names things and returns
/// numbers rather than ethers `Result` tuples.
///
/// The Solidity side keeps its own `IChainInfo`, because a contract cannot import a TypeScript
/// class and the on-chain call has to be snake_case to match the ABI.
export function chainInfoAt(provider: JsonRpcProvider): chainInfo.PrecompileChainInfoProvider {
  return new chainInfo.PrecompileChainInfoProvider(provider, CHAIN_INFO_ADDRESS);
}

/// The Block Prover precompile, through the SDK rather than through a hand-held ABI.
///
/// `verifySingle` and `verifyBatch` are `view` twins of the emitting forms, which is what makes
/// the entire proving path exercisable over `eth_call` with an empty wallet — see `npm run probe`.
export function blockProverAt(provider: JsonRpcProvider): blockProver.PrecompileBlockProver {
  return new blockProver.PrecompileBlockProver(provider);
}

/// Is `height` attested for `chainKey` yet?
///
/// The precompile answers this directly on-chain, and the registry calls it that way — an
/// unattested range is the one thing that makes a challenge window unsound. Off-chain there is no
/// `is_height_attested` on the SDK provider, and there does not need to be: the frontier answers
/// the same question and is worth printing when it says no.
export async function attested(
  provider: JsonRpcProvider,
  chainKey: number,
  height: number,
): Promise<{ ok: boolean; frontier: number }> {
  const frontier = Number((await chainInfoAt(provider).getLatestAttestedHeightAndHash(chainKey)).height);
  return { ok: height <= frontier, frontier };
}
