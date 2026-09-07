import type { AttestationIndexer } from './networks';

/// What Creditcoin's attestors signed, read from the public attestation indexer.
///
/// The ChainInfo precompile answers "how far is this chain attested" and "is this height
/// attested", and the hash it hands back is the attestation's own digest rather than the source
/// block's header hash — measured, see `./attest.ts`. So on the precompile alone the attestation
/// layer's word about *Ethereum* is unfalsifiable from outside. This indexer publishes the header
/// hash, which makes it checkable: ask Creditcoin what it attested for source block N, ask an
/// independent endpoint on that source chain what block N's hash actually is, and compare.
///
/// A mismatch would mean the attestors signed a header the source chain does not have. Nothing in
/// this repository can stop that; it can notice it, from a page with no backend, which is the
/// difference between trusting the oracle and checking it.
///
/// That check has one hole, and `digest` closes it: it assumes the indexer's rows are real. An
/// indexer inventing an attestation would be checked against Ethereum, agree with it, and pass.
/// The precompile keeps its own digest-to-height index, so every row carries something the chain
/// itself can confirm — `heightForDigest` in `./attest.ts` is the other half.
///
/// CORS-open and keyless, verified against the live endpoint.

export interface Attestation {
  headerNumber: number;
  headerHash: string;
  /// The digest the attestors signed this header into. `get_attestation_height_for_digest` on the
  /// ChainInfo precompile maps it back to `headerNumber`, and answers `exists: false` for a digest
  /// no attestation carries.
  digest: string;
  timestampMs: number;
}

interface GqlResponse {
  data?: {
    attestations?: {
      totalCount: number;
      nodes: { headerNumber: string; headerHash: string; digest: string; timestamp: string }[];
    };
  };
  errors?: { message: string }[];
}

/// The most recent attestations for a source chain, newest first.
export async function recentAttestations(
  indexer: AttestationIndexer,
  chainKey: number,
  first = 6,
  timeoutMs = 15_000,
): Promise<{ total: number; nodes: Attestation[] }> {
  const query = `{
    attestations(filter: { chainKey: { equalTo: "${chainKey}" } }, orderBy: HEADER_NUMBER_DESC, first: ${first}) {
      totalCount
      nodes { headerNumber headerHash digest timestamp }
    }
  }`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(indexer.graphql, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`the attestation indexer answered ${res.status}`);
    const body = (await res.json()) as GqlResponse;
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
    const a = body.data?.attestations;
    if (!a) throw new Error('the attestation indexer returned no attestations field');
    return {
      total: a.totalCount,
      nodes: a.nodes.map((n) => ({
        headerNumber: Number(n.headerNumber),
        headerHash: n.headerHash,
        digest: n.digest,
        timestampMs: Number(n.timestamp),
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

/// How many attestors the network has registered. The quorum is a subset of this.
export async function attestorCount(indexer: AttestationIndexer, timeoutMs = 15_000): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(indexer.graphql, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ attestors { totalCount } }' }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`the attestation indexer answered ${res.status}`);
    const body = (await res.json()) as { data?: { attestors?: { totalCount: number } } };
    return body.data?.attestors?.totalCount ?? 0;
  } finally {
    clearTimeout(timer);
  }
}

/// The BLS public keys registered to attest a source chain on this network.
///
/// Two Creditcoin networks attest Ethereum mainnet, and the console says so. Whether that is worth
/// anything depends entirely on whether the two attestor sets are actually different people — one
/// set signing on both networks would produce two agreeing records and no independence at all. The
/// indexer publishes each attestor's BLS public key, so the question is answerable rather than
/// assumed: measured 2026-09-07, CC3 Testnet registers 5 keys for Ethereum and Creditcoin Mainnet
/// registers 7, and the intersection is empty.
export async function attestorKeys(indexer: AttestationIndexer, chainKey: number, timeoutMs = 15_000): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(indexer.graphql, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `{ attestors(filter: { chainKey: { equalTo: "${chainKey}" } }) { nodes { blsPublicKey } } }`,
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`the attestation indexer answered ${res.status}`);
    const body = (await res.json()) as { data?: { attestors?: { nodes: { blsPublicKey: string }[] } } };
    return (body.data?.attestors?.nodes ?? []).map((n) => String(n.blsPublicKey).toLowerCase());
  } finally {
    clearTimeout(timer);
  }
}
