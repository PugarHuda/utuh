import { isCallException, isError } from 'ethers';
import type { Contract } from 'ethers';

/// Send a registry call even when gas estimation refuses to answer.
///
/// `pallet-evm` does not always propagate revert reasons in estimation mode, so `eth_estimateGas`
/// on a call that reaches a precompile can fail on a call that would have succeeded. Gluwa's own
/// SDK ships a workaround for this, which is how it is known rather than guessed at. Left
/// unhandled it means a claimant cannot append — and, much worse, **a refuter cannot refute**, so
/// a liar keeps a bond because a node declined to do arithmetic.
///
/// The order here matters. `eth_call` first: it is free, it does not run in estimation mode, and
/// it settles whether the call would actually succeed. Only then is a gas limit computed and the
/// transaction sent. Without that first step, forcing a limit past a failed estimate would send
/// doomed transactions and burn gas on them.
///
/// The fallback is not the SDK's heuristic. That one is `21000 + roots*5000 + 20000`, which for a
/// ten-member append comes to about 146,000 gas against a measured 2,150,000 — it would run out
/// and lose the transaction it was meant to save. These constants are the fit `npm run gas`
/// produces from every registry transaction on chain:
///
///     314,503 gas fixed
///       2.33 x the call's own calldata gas
///     20,526 gas per member
///
/// rounded up, with the worst observed residual folded in, then a further third on top.
const FIXED = 400_000n;
const PER_CALLDATA_GAS = 3n;
const PER_MEMBER = 30_000n;
/// Creditcoin's block gas cap. A limit above it is not a limit, it is a transaction no block can
/// hold, and it is better to fail loudly here than to have one silently never mined.
const MAX_GAS_CAP = 75_000_000n;

/// Did the *chain* refuse this call, or did we merely fail to ask?
///
/// Callers act on the difference. `buildClaim` drops an event the registry rejects, because an
/// event the registry will not take is one no refuter could use against the claim either — but an
/// RPC that timed out has said nothing about the event, and dropping it there seals a claim short
/// of a real member and forfeits the bond. Same distinction as the prover's 404, one layer down.
///
/// Only a decoded revert counts. `CALL_EXCEPTION` with no revert data is what ethers also returns
/// for a call to an address holding no code, which is a misconfiguration rather than a verdict.
export function isChainRejection(contract: Contract, e: unknown): boolean {
  // ethers ships the type guard this used to hand-roll as `e?.code !== 'CALL_EXCEPTION'`, and it
  // narrows to CallExceptionError — so `revert` and `data` are typed here rather than read off an
  // `any`. Its own definition of a call exception is also the one to trust over a copy of it.
  if (!isCallException(e)) return false;
  if (e.revert != null) return true;
  try {
    return e.data != null && e.data !== '0x' && contract.interface.parseError(e.data) != null;
  } catch {
    return false;
  }
}

/// Did this fail because the endpoint never answered?
///
/// Distinct from a rejection: nothing was decided. ethers classifies its own transport failures,
/// which is more reliable than matching on message text and covers codes a hand-written list
/// would miss — `SERVER_ERROR` for a 502, `BAD_DATA` for a malformed response, `CANCELLED` for a
/// destroyed provider.
export function isTransportFailure(e: unknown): boolean {
  return (
    isError(e, 'TIMEOUT') ||
    isError(e, 'NETWORK_ERROR') ||
    isError(e, 'SERVER_ERROR') ||
    isError(e, 'BAD_DATA') ||
    isError(e, 'CANCELLED')
  );
}

/// What the EVM charges for these bytes: 16 per non-zero, 4 per zero, per EIP-2028.
export function calldataGas(data: string): bigint {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  let gas = 0n;
  for (let i = 0; i + 1 < hex.length; i += 2) gas += hex[i] === '0' && hex[i + 1] === '0' ? 4n : 16n;
  return gas;
}

export function modelledGas(data: string, members: number): bigint {
  const raw = FIXED + PER_CALLDATA_GAS * calldataGas(data) + PER_MEMBER * BigInt(members);
  return (raw * 4n) / 3n;
}

export interface SendOptions {
  /// How many claim members this call records. `refute` records none; an append records one per
  /// proof it carries.
  members: number;
  log?: (message: string) => void;
}

/// Call `method` on `contract` with `args`, and get it mined whether or not the node will estimate.
///
/// Every write in this repo that touches a precompile goes through here — the registry's appends
/// and refutations, and the credit contract's control binding. They share the failure.
export async function sendChecked(
  registry: Contract,
  method: string,
  args: unknown[],
  { members, log = () => {} }: SendOptions,
) {
  const fn = registry.getFunction(method);

  // Free, and not subject to the estimation-mode problem. If this reverts, the call is genuinely
  // bad and the error is the real one — worth surfacing rather than papering over with a gas limit.
  await fn.staticCall(...args);

  try {
    // A fallback nothing ever takes is a fallback nobody has tested. Setting FORCE_MODELLED_GAS
    // makes every call take it, so the modelled limit is exercised on real transactions against
    // the real chain rather than trusted because the arithmetic looks right.
    if (process.env.FORCE_MODELLED_GAS) throw new Error('FORCE_MODELLED_GAS');
    const estimate = await fn.estimateGas(...args);
    return await fn(...args, { gasLimit: (estimate * 135n) / 100n });
  } catch (e: any) {
    const data = registry.interface.encodeFunctionData(method, args);
    const limit = modelledGas(data, members);
    if (limit > MAX_GAS_CAP) {
      throw new Error(
        `${method} needs an estimated ${limit} gas, above Creditcoin's ${MAX_GAS_CAP} block cap — send a smaller batch`,
      );
    }
    const why = process.env.FORCE_MODELLED_GAS
      ? 'estimation skipped by FORCE_MODELLED_GAS'
      : `gas estimation refused (${String(e.shortMessage ?? e.message).slice(0, 60)})`;
    log(`  ${why} — the call succeeds under eth_call, sending ${method} with ${limit} gas from the measured model`);
    return await fn(...args, { gasLimit: limit });
  }
}
