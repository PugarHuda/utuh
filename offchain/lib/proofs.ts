import { proofProvider } from '@gluwa/usc-sdk';
import type { ScopedEvent } from './scope';

/// Mirrors UtuhRegistry.EventProof.
export interface EventProofStruct {
  blockHeight: number;
  encodedTransaction: string;
  merkleRoot: string;
  siblings: { hash: string; isLeft: boolean }[];
  logIndex: number;
}

/// Mirrors IBlockProver.ContinuityProof.
export interface ContinuityProofStruct {
  lowerEndpointDigest: string;
  roots: string[];
}

export interface ProvenBatch {
  proofs: EventProofStruct[];
  continuity: ContinuityProofStruct;
}

/// Attestcoin's batch endpoint shares one continuity proof across a batch, but only within these
/// bounds. Both come from the SDK's own limits and are the reason claims are built incrementally
/// rather than in one shot.
export const MAX_BATCH_SIZE = 10;
export const MAX_BATCH_RANGE = 1000;

/// Split events into batches the Block Prover will actually accept.
///
/// The cap is on *queries*, not transactions: a transaction carrying three in-scope logs spends
/// three of the ten slots even though it needs only one proof. Counting transactions instead is
/// how you earn `heights: Value is too large for length` from the precompile.
export function planBatches(events: ScopedEvent[]): ScopedEvent[][] {
  const batches: ScopedEvent[][] = [];
  let current: ScopedEvent[] = [];
  let txCount = 0;
  let firstBlock = 0;
  let lastTx = '';

  for (const e of events) {
    const wouldExceedQueries = current.length + 1 > MAX_BATCH_SIZE;
    const wouldExceedRange = current.length > 0 && e.blockNumber - firstBlock + 1 > MAX_BATCH_RANGE;

    if (current.length > 0 && (wouldExceedQueries || wouldExceedRange)) {
      batches.push(current);
      current = [];
      txCount = 0;
      lastTx = '';
    }
    if (current.length === 0) firstBlock = e.blockNumber;
    if (e.txHash !== lastTx) {
      txCount++;
      lastTx = e.txHash;
    }
    current.push(e);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export class Prover {
  private builder: proofProvider.service.ProofBuilder;

  constructor(
    private chainKey: number,
    builderUrl: string,
    timeoutMs = 30000,
  ) {
    this.builder = new proofProvider.service.ProofBuilder(chainKey, builderUrl, timeoutMs);
  }

  /// Block until Creditcoin has attested `height` on the source chain, which is what makes a
  /// proof for that block generatable at all.
  async waitAttested(height: number): Promise<void> {
    await this.builder.waitUntilHeightAttested(this.chainKey, height);
  }

  /// Prove a group of events that share a batch.
  async proveBatch(events: ScopedEvent[]): Promise<ProvenBatch> {
    const txHashes = [...new Set(events.map((e) => e.txHash))];

    if (txHashes.length === 1) {
      const res = await this.builder.getProof(txHashes[0]);
      if (!res.success || !res.data) throw new Error(`proof failed: ${res.error}`);
      const d = res.data;
      return {
        continuity: {
          lowerEndpointDigest: d.continuityProof.lowerEndpointDigest,
          roots: d.continuityProof.roots,
        },
        proofs: events.map((e) => ({
          blockHeight: d.headerNumber,
          encodedTransaction: d.txBytes,
          merkleRoot: d.merkleProof.root,
          siblings: d.merkleProof.siblings.map((s) => ({ hash: s.hash, isLeft: s.isLeft })),
          logIndex: e.logIndexInTx,
        })),
      };
    }

    const res = await this.builder.getBatchProof(txHashes);
    if (!res.success || !res.data) throw new Error(`batch proof failed: ${res.error}`);
    const d = res.data;

    const byTx = new Map<string, { blockHeight: number; txBytes: string; root: string; siblings: any[] }>();
    for (const [blockHeight, byIndex] of d.merkleProofs.entries()) {
      for (const entry of byIndex.values()) {
        byTx.set(entry.txHash.toLowerCase(), {
          blockHeight: Number(blockHeight),
          txBytes: entry.txBytes,
          root: entry.merkleProof.root,
          siblings: entry.merkleProof.siblings,
        });
      }
    }

    return {
      continuity: {
        lowerEndpointDigest: d.continuityProof.lowerEndpointDigest,
        roots: d.continuityProof.roots,
      },
      proofs: events.map((e) => {
        const p = byTx.get(e.txHash.toLowerCase());
        if (!p) throw new Error(`batch proof missing tx ${e.txHash}`);
        return {
          blockHeight: p.blockHeight,
          encodedTransaction: p.txBytes,
          merkleRoot: p.root,
          siblings: p.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft })),
          logIndex: e.logIndexInTx,
        };
      }),
    };
  }

  /// Prove exactly one event — what a refutation needs, and all it needs.
  async proveOne(event: ScopedEvent): Promise<{ proof: EventProofStruct; continuity: ContinuityProofStruct }> {
    const batch = await this.proveBatch([event]);
    return { proof: batch.proofs[0], continuity: batch.continuity };
  }

  /// Try to prove one event, and say *why* if it fails.
  ///
  /// A claimant drops candidates that cannot be proven, so the difference between "the prover
  /// says there is no such transaction" and "the prover could not be reached" is the difference
  /// between a correct claim and an incomplete one with a forfeit bond. Both arrive from the SDK
  /// as `success: false` with a message, so they are told apart by what the API answered: a 404
  /// is the prover speaking about the chain, anything else is a failure to ask.
  ///
  ///   404                  -> "Failed to fetch proof: AxiosError: ... status code 404"
  ///   unreachable prover   -> "Failed to fetch proof: Error: connect ECONNREFUSED ..."
  async tryProveOne(
    event: ScopedEvent,
    attempts = 3,
    backoffMs = 4000,
  ): Promise<
    | { ok: true; proof: EventProofStruct; continuity: ContinuityProofStruct }
    | { ok: false; authoritative: boolean; reason: string }
  > {
    let last = 'unknown';
    for (let i = 0; i < attempts; i++) {
      try {
        const { proof, continuity } = await this.proveOne(event);
        return { ok: true, proof, continuity };
      } catch (e: any) {
        last = String(e.message ?? e);
        // A definite answer is not worth retrying.
        if (last.includes('status code 404')) return { ok: false, authoritative: true, reason: last };
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
      }
    }
    return { ok: false, authoritative: false, reason: last };
  }
}
