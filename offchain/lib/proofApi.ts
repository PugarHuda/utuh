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

/// A fetch that comes back, whatever the server does.
///
/// The hosted builder's answer to a request for a proof it has not built yet is to hold the
/// connection open while it builds — measured at over three minutes for a block attested seconds
/// earlier, then under three seconds for the same proof afterwards. A page that waits on that with
/// nothing on screen has, as far as the person looking at it can tell, crashed. So the abort
/// signal is one guard and a timer racing the whole exchange is the other, and the error names
/// the likely cause rather than just the clock.
async function fetchWithin(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `no answer in ${Math.round(timeoutMs / 1000)}s — the builder may still be building this ` +
                  `proof, which can take minutes right after attestation; try again shortly`,
              ),
            ),
          timeoutMs + 500,
        ),
      ),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSingleProof(chainKey: number, txHash: string, timeoutMs = 60_000): Promise<SingleProof> {
  const failures: string[] = [];

  for (const host of proofHosts()) {
    const url = `${host.replace(/\/$/, '')}/api/v1/proof-by-tx/${chainKey}/${txHash}`;
    try {
      const res = await fetchWithin(url, {}, timeoutMs);
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

/// How far the hosted builder's own index has got, which is not the same question as how far the
/// precompile has attested.
///
/// The SDK's `waitUntilHeightAttested` asks the builder; the precompile can answer "attested" for
/// a block the builder has not indexed yet, and a proof request in that gap comes back 422 from the
/// batch endpoint — measured, on a block the precompile had attested a minute earlier. Anything
/// that is about to ask for proofs waits on this as well.
export async function builderAttestedHeight(chainKey: number): Promise<number> {
  const failures: string[] = [];
  for (const host of proofHosts()) {
    try {
      const res = await fetchWithin(`${host.replace(/\/$/, '')}/api/v1/attested-height/${chainKey}`, {}, 20_000);
      if (!res.ok) {
        failures.push(`${hostOf(host)} → ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { attestedHeight?: number };
      if (typeof body.attestedHeight === 'number') return body.attestedHeight;
      failures.push(`${hostOf(host)} → no height in the response`);
    } catch (e) {
      failures.push(`${hostOf(host)} → ${(e as Error).message}`);
    }
  }
  throw new Error(`no proof builder answered: ${failures.join('; ')}`);
}

/// One proof for each of up to {MAX_BATCH_SIZE} transactions, sharing a continuity proof.
///
/// This is the shape `appendBatch` is built around: the array form of `verifyAndEmit` takes one
/// continuity chain spanning the batch's block range and a Merkle proof per query. The service
/// keys the Merkle proofs by header number and then by transaction index, so a caller has to know
/// which block and which position each of its events came from — which the sweep already knows.
export interface BatchProof {
  chainKey: number;
  fromHeader: number;
  toHeader: number;
  continuityProof: { lowerEndpointDigest: string; roots: string[] };
  merkleProofs: Record<string, Record<string, { txHash: string; txBytes: string; merkleProof: MerkleProof }>>;
}

export interface MerkleProof {
  root: string;
  siblings: MerkleProofEntry[];
}

export async function fetchBatchProof(
  chainKey: number,
  txHashes: string[],
  timeoutMs = 120_000,
): Promise<BatchProof> {
  const failures: string[] = [];

  for (const host of proofHosts()) {
    const url = `${host.replace(/\/$/, '')}/api/v1/proof-batch-by-tx/${chainKey}`;
    try {
      const res = await fetchWithin(
        url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(txHashes) },
        timeoutMs,
      );
      if (res.status === 422) {
        // The builder knows the block is attested and has not indexed it yet. Not an error about
        // the request — the same request answered 200 a minute later — so it is retried, here,
        // rather than handed back as a failed build with a bond left in an open claim.
        throw new NotIndexedYet(`${hostOf(host)} has not indexed these transactions yet`);
      }
      if (!res.ok) {
        failures.push(`${hostOf(host)} → ${res.status}`);
        continue;
      }
      const body = (await res.json()) as BatchProof & { data?: BatchProof };
      const proof = body.merkleProofs ? body : body.data;
      if (!proof?.merkleProofs || !proof.continuityProof) {
        failures.push(`${hostOf(host)} → the response carried no proofs`);
        continue;
      }
      return proof;
    } catch (e) {
      if (e instanceof NotIndexedYet) throw e;
      failures.push(`${hostOf(host)} → ${(e as Error).message}`);
    }
  }

  throw new Error(`no proof builder answered: ${failures.join('; ')}`);
}

/// The builder has the block attested but not indexed. Retry, do not fail.
export class NotIndexedYet extends Error {}

/// `fetchBatchProof`, retried while the builder catches up — bounded, and saying so each time.
export async function fetchBatchProofPatiently(
  chainKey: number,
  txHashes: string[],
  log: (line: string) => void,
  attempts = 20,
): Promise<BatchProof> {
  for (let i = 1; ; i++) {
    try {
      return await fetchBatchProof(chainKey, txHashes);
    } catch (e) {
      if (!(e instanceof NotIndexedYet) || i >= attempts) throw e;
      log(`${e.message} — asking again in 15s (${i}/${attempts})`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

/// Pull one transaction's proof out of a batch response.
///
/// Absence here is not "the chain does not have it" — the caller asked for these hashes by name.
/// It means the service answered about a different set than it was asked about, which is worth
/// failing on rather than skipping, because a skipped event is an incomplete claim and a forfeit
/// bond.
export function proofFromBatch(
  batch: BatchProof,
  blockNumber: number,
  txIndex: number,
): { txBytes: string; merkleProof: MerkleProof } {
  const atHeight = batch.merkleProofs[String(blockNumber)];
  const found = atHeight?.[String(txIndex)];
  if (!found) {
    throw new Error(`the batch proof has nothing at block ${blockNumber} tx#${txIndex}`);
  }
  return { txBytes: found.txBytes, merkleProof: found.merkleProof };
}
