import { JsonRpcProvider } from 'ethers';
import { proofProvider, chainInfo } from '@gluwa/usc-sdk';
import { PROVER_URL, cc3, sources } from '../config';
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

/// How long to wait for the attestation frontier to reach a block, in milliseconds.
///
/// Attestation runs about seventy blocks behind the source-chain head, so a claim that ends near
/// the tip has a real wait in front of it. Fifteen minutes is the hosted builder's own default and
/// is generous enough for both source chains.
export const WAIT_ATTESTED_MS = Number(process.env.WAIT_ATTESTED_MS ?? 900_000);
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

/// A block provider that asks every configured endpoint instead of one.
///
/// The local proof builder needs whole blocks *with receipts* — `eth_getBlockReceipts`, which a
/// good number of public endpoints simply do not serve. Handing it a single provider makes the
/// fallback depend on the first URL in a list happening to be one that does, which is the same
/// single-source assumption the rest of this refuses to make. Ask them all; first real answer wins.
class AnyOfBlockProvider implements proofProvider.raw.blockProvider.BlockProvider {
  private inner: proofProvider.raw.blockProvider.SimpleBlockProvider[];

  constructor(providers: JsonRpcProvider[]) {
    this.inner = providers.map((p) => new proofProvider.raw.blockProvider.SimpleBlockProvider(p));
  }

  private async first<T>(
    what: string,
    call: (p: proofProvider.raw.blockProvider.SimpleBlockProvider) => Promise<T | null>,
  ): Promise<T | null> {
    let last: unknown = null;
    for (const p of this.inner) {
      try {
        const res = await call(p);
        if (res) return res;
      } catch (e) {
        last = e;
      }
    }
    if (last) throw new Error(`${what}: ${(last as any).message ?? last}`);
    return null;
  }

  async getBlockNumber(): Promise<number> {
    const n = await this.first('getBlockNumber', (p) => p.getBlockNumber());
    if (n === null) throw new Error('no endpoint returned a block number');
    return n;
  }

  getTransaction(hash: string) {
    return this.first('getTransaction', (p) => p.getTransaction(hash));
  }

  getBlockWithReceipts(blockNumber: number) {
    return this.first('getBlockWithReceipts', (p) => p.getBlockWithReceipts(blockNumber));
  }
}

/// Did this prover say the chain does not have the transaction, or that it could not tell?
///
/// The two provers say it differently and both have near-misses that mean something else:
///
///   hosted, absent       "Failed to fetch proof: AxiosError: ... status code 404"
///   hosted, unreachable  "Failed to fetch proof: Error: connect ECONNREFUSED ..."
///   local, absent        "Failed to generate merkle proof: Transaction 0x… not found"
///   local, endpoint gap  "... Transaction 0x… not found in block 25834280"
///   local, endpoint gap  "... Block 25834280 not found for transaction 0x…"
///
/// The last two read like absence and are not: they are the local builder failing to fetch a
/// *sibling* transaction, or the block itself, from the source endpoints. Reading either as
/// absence would let a claimant drop an event that is really there. Wrong in that direction costs
/// the bond, wrong in the other costs an aborted claim, so anything ambiguous is not absence.
export function isAbsence(prover: string, message: string): boolean {
  if (prover === 'hosted') return message.includes('status code 404');
  return /Transaction 0x[0-9a-fA-F]{64} not found$/.test(message.trim());
}

export class Prover {
  private builder: proofProvider.service.ProofBuilder;
  private local?: proofProvider.raw.RawProofBuilder;
  private localChainInfo?: chainInfo.PrecompileChainInfoProvider;
  private owned: JsonRpcProvider[] = [];

  constructor(
    private chainKey: number,
    builderUrl: string,
    timeoutMs = 30000,
  ) {
    this.builder = new proofProvider.service.ProofBuilder(chainKey, builderUrl, timeoutMs);
  }

  /// The prover every script should use: hosted, with the local builder already behind it.
  ///
  /// Wiring the fallback by hand at each call site means the one script that forgets is the one
  /// that cannot refute when the hosted service is down. There is no reason for a caller to opt
  /// into working — so this is the default, and `new Prover(...)` stays available for the tests
  /// that deliberately want a prover with nowhere to fall back to.
  ///
  /// Endpoints come from `sources()` rather than `source()` so each source-chain provider declares
  /// its chain id; an undeclared one probes the network forever in the background when it is down.
  static withDefaults(chainKey: number, timeoutMs = 30000, builderUrl = PROVER_URL): Prover {
    const rpcs = sources(chainKey).map((s) => s.provider);
    const cc = cc3();
    const p = new Prover(chainKey, builderUrl, timeoutMs).withLocalFallback(rpcs, cc);
    p.owned = [...rpcs, cc];
    return p;
  }

  /// Release the providers this created. Only meaningful for `withDefaults`; a caller that passed
  /// its own providers to `withLocalFallback` still owns them.
  close(): void {
    for (const p of this.owned) p.destroy();
    this.owned = [];
  }

  /// Add a locally-built prover to fall back on.
  ///
  /// Everything here refuses to trust a single source of anything — except, until now, the one
  /// that matters most. Merkle and continuity proofs came only from Gluwa's hosted Proof Builder,
  /// so if that service is down or rate-limiting, no claim can be built and, far worse, **no claim
  /// can be refuted**. The entire enforcement mechanism sat behind one hosted endpoint.
  ///
  /// The SDK ships a RawProofBuilder that constructs the same proofs from a source-chain RPC and
  /// the ChainInfo precompile — no hosted service involved. It needs whole blocks with receipts,
  /// which not every endpoint will serve, so it is a fallback rather than the default.
  withLocalFallback(sourceRpc: JsonRpcProvider | JsonRpcProvider[], cc3: JsonRpcProvider, encoding = 1): this {
    this.localChainInfo = new chainInfo.PrecompileChainInfoProvider(cc3);
    this.local = new proofProvider.raw.RawProofBuilder(
      this.chainKey,
      new AnyOfBlockProvider(Array.isArray(sourceRpc) ? sourceRpc : [sourceRpc]),
      this.localChainInfo,
      encoding,
    );
    return this;
  }

  /// Ask the hosted builder, then the local one. A 404 from the hosted service is not a reason to
  /// stop asking — it may simply not have indexed the transaction — but it is a reason to believe
  /// the local answer if that comes back empty too.
  ///
  /// The thrown error carries `definite`: true only when *every* prover consulted said the chain
  /// does not have this transaction. A claimant drops candidates it cannot prove, so this flag is
  /// the difference between a correct claim and an incomplete one with a forfeit bond, and one
  /// prover answering while the other is unreachable is not agreement.
  private async ask(hashes: string[], batch: boolean): Promise<any> {
    const provers: [string, proofProvider.ProofProvider | undefined][] = [
      ['hosted', this.builder],
      ['local', this.local],
    ];
    let last = 'no prover available';
    let asked = 0;
    let denials = 0;
    for (const [name, provider] of provers) {
      if (!provider) continue;
      asked++;
      let message: string;
      try {
        const res = batch ? await provider.getBatchProof(hashes) : await provider.getProof(hashes[0]);
        if (res.success && res.data) return res.data;
        message = String(res.error);
      } catch (e: any) {
        message = String(e.message ?? e);
      }
      if (isAbsence(name, message)) denials++;
      last = `${name}: ${message}`;
    }
    const err: any = new Error(`proof failed: ${last}`);
    err.definite = asked > 0 && denials === asked;
    throw err;
  }

  /// Block until Creditcoin has attested `height` on the source chain, which is what makes a
  /// proof for that block generatable at all.
  ///
  /// The ChainInfo precompile is where this fact lives; the hosted builder only relays it. When a
  /// local fallback is wired, ask the chain directly — otherwise a hosted outage stalls a claimant
  /// at the one step that has no reason to depend on a hosted service at all.
  ///
  /// Both budgets are stated rather than defaulted, because the SDK's two implementations disagree
  /// about them: the hosted builder waits fifteen minutes, the precompile provider one. Switching
  /// to the precompile without saying so silently turned a fifteen-minute wait into a one-minute
  /// one, and a claimant thirty blocks behind the frontier simply gave up.
  async waitAttested(height: number, timeoutMs = WAIT_ATTESTED_MS, pollMs = 15_000): Promise<void> {
    const provider = this.localChainInfo ?? this.builder;
    await provider.waitUntilHeightAttested(this.chainKey, height, pollMs, timeoutMs);
  }

  /// Prove a group of events that share a batch.
  async proveBatch(events: ScopedEvent[]): Promise<ProvenBatch> {
    const txHashes = [...new Set(events.map((e) => e.txHash))];

    if (txHashes.length === 1) {
      const d = await this.ask(txHashes, false);
      return {
        continuity: {
          lowerEndpointDigest: d.continuityProof.lowerEndpointDigest,
          roots: d.continuityProof.roots,
        },
        proofs: events.map((e) => ({
          blockHeight: d.headerNumber,
          encodedTransaction: d.txBytes,
          merkleRoot: d.merkleProof.root,
          siblings: d.merkleProof.siblings.map((s: any) => ({ hash: s.hash, isLeft: s.isLeft })),
          logIndex: e.logIndexInTx,
        })),
      };
    }

    const d = await this.ask(txHashes, true);

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
  /// A claimant drops candidates that cannot be proven, so the difference between "the chain does
  /// not have this transaction" and "I could not ask" is the difference between a correct claim
  /// and an incomplete one with a forfeit bond. `ask` decides that, across every prover wired up;
  /// see `isAbsence` for how each one says it.
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
        if (e?.definite === true) return { ok: false, authoritative: true, reason: last };
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
      }
    }
    return { ok: false, authoritative: false, reason: last };
  }
}
