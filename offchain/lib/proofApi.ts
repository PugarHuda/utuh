import { PROVER_URL_ALTERNATE, PROVER_URL_DEFAULT } from './networks';

/// One proof, from the hosted Proof Builder, over plain HTTP.
///
/// The SDK's `proofProvider.service.ProofBuilder` does this with axios and is what the node scripts
/// use for batches. The browser console needs the single-transaction case only — a refutation is
/// always one proof — and reaching for a bundled HTTP client to make one GET would be the kind of
/// weight that has to justify itself. `fetch` is in both runtimes.
///
/// The shape below is the service's published response, the same one the SDK's own docstring
/// records: `/api/v1/proof-by-tx/{chainKey}/{txHash}`.

export interface MerkleProofEntry {
  hash: string;
  isLeft: boolean;
}

export interface SingleProof {
  chainKey: number;
  headerNumber: number;
  txIndex: number;
  txHash: string;
  txBytes: string;
  continuityProof: { lowerEndpointDigest: string; roots: string[] };
  merkleProof: { root: string; siblings: MerkleProofEntry[] };
}

/// Both published hostnames for the CC3 testnet builder, in the order they are tried.
export function proofHosts(): string[] {
  return [...new Set([PROVER_URL_DEFAULT, PROVER_URL_ALTERNATE])];
}

/// Did the service say the chain does not have this transaction, or that it could not tell?
///
/// 404 is the service's answer for "no such transaction". Everything else — a timeout, a 5xx, a
/// name that no longer resolves — means the question was not answered, and moving on to the next
/// host is right. Treating an unanswered question as absence is how a watcher drops a real event.
export class ProofAbsent extends Error {}

export async function fetchSingleProof(chainKey: number, txHash: string, timeoutMs = 60_000): Promise<SingleProof> {
  const failures: string[] = [];

  for (const host of proofHosts()) {
    const url = `${host.replace(/\/$/, '')}/api/v1/proof-by-tx/${chainKey}/${txHash}`;
    const stop = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(url, { signal: stop });
      if (res.status === 404) {
        throw new ProofAbsent(`the proof builder has no transaction ${txHash} on chain key ${chainKey}`);
      }
      if (!res.ok) {
        failures.push(`${hostOf(host)} → ${res.status}`);
        continue;
      }
      // The service answers with the proof itself, flat. The SDK's docstring shows a
      // `{ success, data }` envelope, which is the shape of its own return value rather than of
      // the HTTP body — believing the docstring is how this first asked for `.data` and got
      // nothing on a response that was perfectly good. Both are accepted, and the field that has
      // to be there either way is `txBytes`.
      const body = (await res.json()) as SingleProof & { data?: SingleProof };
      const proof = body.txBytes ? body : body.data;
      if (!proof?.txBytes || !proof.merkleProof || !proof.continuityProof) {
        failures.push(`${hostOf(host)} → the response carried no proof`);
        continue;
      }
      return proof;
    } catch (e) {
      if (e instanceof ProofAbsent) throw e;
      failures.push(`${hostOf(host)} → ${(e as Error).message}`);
    }
  }

  throw new Error(`no proof builder answered: ${failures.join('; ')}`);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
