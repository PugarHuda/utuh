import { ATTESTATIONS_GRAPHQL } from './networks';

/// What Creditcoin's attestors signed, read from the public attestation indexer.
///
/// The ChainInfo precompile answers "how far is this chain attested" and "is this height
/// attested". It does not return the attested header hash, so on the precompile alone the
/// attestation layer's word is unfalsifiable from outside. This indexer publishes the hash, which
/// makes it checkable: ask Creditcoin what it attested for source block N, ask an independent
/// endpoint on that source chain what block N's hash actually is, and compare.
///
/// A mismatch would mean the attestors signed a header the source chain does not have. Nothing in
/// this repository can stop that; it can notice it, from a page with no backend, which is the
/// difference between trusting the oracle and checking it.
///
/// CORS-open and keyless, verified against the live endpoint.

export interface Attestation {
  headerNumber: number;
  headerHash: string;
  timestampMs: number;
}

interface GqlResponse {
  data?: { attestations?: { totalCount: number; nodes: { headerNumber: string; headerHash: string; timestamp: string }[] } };
  errors?: { message: string }[];
}

/// The most recent attestations for a source chain, newest first.
export async function recentAttestations(
  chainKey: number,
  first = 6,
  timeoutMs = 15_000,
): Promise<{ total: number; nodes: Attestation[] }> {
  const query = `{
    attestations(filter: { chainKey: { equalTo: "${chainKey}" } }, orderBy: HEADER_NUMBER_DESC, first: ${first}) {
      totalCount
      nodes { headerNumber headerHash timestamp }
    }
  }`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ATTESTATIONS_GRAPHQL, {
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
        timestampMs: Number(n.timestamp),
      })),
    };
  } finally {
    clearTimeout(timer);
  }
}

/// How many attestors the network has registered. The quorum is a subset of this.
export async function attestorCount(timeoutMs = 15_000): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ATTESTATIONS_GRAPHQL, {
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
