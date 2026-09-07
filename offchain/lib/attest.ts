import { Contract, toUtf8String, type JsonRpcProvider, type Provider } from 'ethers';
import chainInfoAbi from '@gluwa/usc-sdk/dist/chain-info/chain_info.json';
import { CHAIN_INFO_ADDRESS } from './networks';

/// The rest of the ChainInfo precompile — the seven entry points nothing here used to call.
///
/// `offchain/lib/chain.ts` reaches the precompile through the SDK's `PrecompileChainInfoProvider`,
/// which wraps four of its eleven methods and is the right thing for a node script. Three of the
/// remaining seven (`find_highest_attested_before`, `find_lowest_attested_after`,
/// `get_latest_checkpoint_height_and_hash`) have no wrapper at all, and the SDK provider wants a
/// `JsonRpcApiProvider` while the console holds a failover provider of its own. So this module
/// binds the precompile's *published* ABI — the one shipped inside `@gluwa/usc-sdk`, not a copy
/// pasted into this repository — to whatever provider it is handed, and works the same in node and
/// in a browser bundle.
///
/// `src/interfaces/IChainInfo.sol` deliberately still declares only what the contracts call.
/// Adding functions there would change UtuhRegistry's compilation metadata, and the deployed
/// registries are verified by that metadata hash — a fuller interface would cost a full match on
/// Sourcify for nothing the contracts use.
///
/// Everything below was measured against CC3 Testnet and Creditcoin Mainnet on 2026-09-07; the
/// surprises are written down where they bite, because none of them are in the docs.

/// What the network says a chain key means. `exists` is false for a key it does not attest —
/// `get_chain_by_key` answers rather than reverting, so an unknown key is data, not an exception.
export interface SourceChain {
  chainKey: number;
  chainId: number;
  name: string;
  encoding: number;
}

/// An attestation point: a source height the attestors signed, and the digest they signed it into.
///
/// **The `hash` a `HeightHashResult` carries is the attestation digest, not the source block's
/// header hash.** Measured: at Ethereum height 25,925,380 the precompile returns
/// `0x8786ef14…`, the attestation indexer's `digest` field for that height returns the same
/// `0x8786ef14…`, and Ethereum's own header hash for that block is `0xd5ea7299…`. Reading it as a
/// header hash and comparing it to the source chain produces a MISMATCH row about a healthy
/// oracle. Header hashes come from the indexer (`./attestations`), and only from there.
export interface AttestationPoint {
  height: number;
  digest: string;
  isAttestation: boolean;
  exists: boolean;
}

function precompile(provider: Provider): Contract {
  return new Contract(CHAIN_INFO_ADDRESS, chainInfoAbi as never, provider);
}

/// What this network says a single chain key is, without enumerating every chain it attests.
///
/// `get_supported_chains` answers the same question for all keys at once and `./chain.ts` uses it
/// to check this build's hardcoded table. This is the one-key form, for the places that hold a
/// scope and need the EVM chain id behind its `chainKey` — a scope names a chain key, and a chain
/// key is a Creditcoin-internal number that means different chains on different Creditcoin
/// networks.
export async function chainOf(provider: Provider, chainKey: number): Promise<SourceChain | null> {
  const r = await precompile(provider).get_chain_by_key(chainKey);
  if (!r.exists) return null;
  return {
    chainKey: Number(r.info.chainKey),
    chainId: Number(r.info.chainId),
    // chainName is hex-encoded bytes: 0x457468657265756d is "Ethereum". Decoded with ethers
    // rather than Buffer, because this module is bundled into the console and a browser has no
    // Buffer — esbuild does not polyfill it, and the failure is a blank pane at runtime.
    name: toUtf8String(r.info.chainName),
    encoding: Number(r.info.chainEncoding),
  };
}

/// Whether a source height can be proven yet, and if not, the height at which it can.
///
/// `get_attestation_bounds` answers for one height what the frontier only implies: the attestation
/// points either side of it and whether the height itself is covered. Attestations land every ten
/// source blocks and checkpoints every hundred, so a height is almost never an attestation point
/// itself — `isAttested` is the honest answer, and `parent`/`child` are the window that covers it.
///
/// When it is not attested yet, `find_lowest_attested_after` names the height that will cover it,
/// which is what a person waiting actually wants to be told. Both are one `eth_call`.
export interface Provability {
  attested: boolean;
  /// The attestation at or below the height, when one exists.
  parentHeight: number;
  /// The attestation above it. Zero when the chain has not reached that far.
  childHeight: number;
  /// The height that must be attested before this one can be proven — 0 when it already can be.
  waitFor: number;
}

export async function provable(provider: Provider, chainKey: number, height: number): Promise<Provability> {
  const b = await precompile(provider).get_attestation_bounds(chainKey, height);
  const attested = Boolean(b.isAttested);
  if (attested) {
    return { attested, parentHeight: Number(b.parentHeight), childHeight: Number(b.childHeight), waitFor: 0 };
  }
  const next = await attestationAfter(provider, chainKey, height);
  return {
    attested,
    parentHeight: Number(b.parentHeight),
    childHeight: Number(b.childHeight),
    // `exists` is false past the frontier: nothing above this height is attested yet, so the
    // next attestation point is the next multiple of ten — which is a guess, and saying 0 is not.
    waitFor: next.exists ? next.height : 0,
  };
}

/// The newest attestation for a source chain: the frontier, and the digest that closes it.
export async function latestAttestation(provider: Provider, chainKey: number): Promise<AttestationPoint> {
  return point(await precompile(provider).get_latest_attestation_height_and_hash(chainKey));
}

/// The last attestation *strictly before* `height`.
///
/// **The bound is exclusive**, which the name does not say and the docs do not either. Measured:
/// height 25,925,400 is itself an attestation point, and `find_highest_attested_before(3,
/// 25925400)` returns 25,925,390. Passing the frontier therefore steps back one full attestation
/// interval — which is exactly what a claimant wants (the frontier's own attestation is the one
/// still settling), and exactly wrong for anyone using it to ask "is this height attested".
export async function attestationBefore(provider: Provider, chainKey: number, height: number): Promise<AttestationPoint> {
  return point(await precompile(provider).find_highest_attested_before(chainKey, height));
}

/// The first attestation at or after `height`; `exists` is false once it is past the frontier.
export async function attestationAfter(provider: Provider, chainKey: number, height: number): Promise<AttestationPoint> {
  return point(await precompile(provider).find_lowest_attested_after(chainKey, height));
}

function point(r: { height: bigint; hash: string; isAttestation: boolean; exists: boolean }): AttestationPoint {
  return {
    height: Number(r.height),
    digest: r.hash,
    isAttestation: Boolean(r.isAttestation),
    exists: Boolean(r.exists),
  };
}

/// How far the checkpoints trail the attestations.
///
/// Two cadences run at once: attestors sign every ten source blocks, and every tenth attestation is
/// checkpointed — a hundred source blocks apart, which is what bounds a continuity proof to a
/// hundred hashes. Only the attestation frontier is ever quoted, and it is the optimistic one. The
/// gap between the two is the honest measure of how far behind the *settled* view is, and nothing
/// published anywhere shows it.
///
/// `get_checkpoint_for_height` is an exact lookup, not a covering one: measured, it answers
/// `exists: false` for any height that is not itself a checkpoint. It is used here to confirm the
/// reported checkpoint really is one, which is the only thing an exact lookup is good for.
export interface CheckpointLag {
  attestationHeight: number;
  checkpointHeight: number;
  /// Source blocks between the newest checkpoint and the newest attestation.
  lag: number;
  /// True when the precompile confirms its own reported checkpoint height by digest.
  confirmed: boolean;
  /// False on a chain attested but not yet checkpointed — a real state on a young chain, and one
  /// that would otherwise read as a checkpoint at height zero and a lag of twenty-five million.
  exists: boolean;
}

export async function checkpointLag(provider: Provider, chainKey: number): Promise<CheckpointLag> {
  const ci = precompile(provider);
  const [latest, checkpoint] = await Promise.all([
    ci.get_latest_attestation_height_and_hash(chainKey),
    ci.get_latest_checkpoint_height_and_hash(chainKey),
  ]);
  const checkpointHeight = Number(checkpoint.height);
  if (!checkpoint.exists) {
    return { attestationHeight: Number(latest.height), checkpointHeight: 0, lag: 0, confirmed: false, exists: false };
  }
  const exact = await ci.get_checkpoint_for_height(chainKey, checkpointHeight);
  return {
    attestationHeight: Number(latest.height),
    checkpointHeight,
    lag: Number(latest.height) - checkpointHeight,
    confirmed: Boolean(exact.exists) && String(exact.hash).toLowerCase() === String(checkpoint.hash).toLowerCase(),
    exists: true,
  };
}

/// Which source height an attestation digest belongs to, according to the chain itself.
///
/// This is the leg that was missing from the attestor audit. The audit reads attestations from the
/// indexer and checks each one's header hash against the source chain — which catches attestors
/// signing a header Ethereum does not have, and catches nothing at all if the *indexer* invented
/// the row. The precompile keeps its own index from digest to height, so a fabricated attestation
/// has nowhere to resolve: measured, an unknown digest answers `exists: false` rather than
/// reverting, and every one of the indexer's own digests resolves to exactly the height it
/// reported, on both Creditcoin networks.
export async function heightForDigest(
  provider: Provider,
  chainKey: number,
  digest: string,
): Promise<{ height: number; exists: boolean }> {
  const r = await precompile(provider).get_attestation_height_for_digest(chainKey, digest);
  return { height: Number(r.height), exists: Boolean(r.exists) };
}

/// Endpoints that are not demonstrably serving some *other* chain than the scope names.
///
/// A sweep is only evidence about the chain it swept. Every provider in this repository is built
/// with ethers' `staticNetwork`, which makes the chain id an *assertion* — the endpoint is never
/// asked. An endpoint that quietly starts answering for a different chain (a URL edited by hand, a
/// gateway repointed, a testnet path on a mainnet host) then returns zero in-scope logs, and zero
/// logs is indistinguishable from a claim with nothing left out. That is a false "complete", on the
/// one verdict this project exists to make.
///
/// So: ask the Creditcoin network what EVM chain id the scope's chain key means, and ask every
/// endpoint what chain it is actually on. `eth_chainId` costs one round trip and is the cheapest
/// call any endpoint serves.
///
/// **Only a mismatch disqualifies an endpoint.** One that does not answer at all is unreachable,
/// not wrong, and the sweep already handles unreachable endpoints properly: it reports them as
/// errored and refuses to call a claim complete on fewer than two endpoints that saw everything.
/// Dropping them here instead would replace that honest, tested "this settles nothing" with a
/// thrown error — a worse answer to the same situation, and a different one to the case this check
/// exists for.
export interface EndpointCheck {
  url: string;
  chainId: number | null;
  verdict: 'confirmed' | 'mismatch' | 'unreachable';
  why?: string;
}

export async function confirmEndpoints<T extends { url: string; provider: JsonRpcProvider }>(
  cc3: Provider,
  chainKey: number,
  endpoints: T[],
  timeoutMs = 8000,
): Promise<{ chain: SourceChain | null; checks: EndpointCheck[]; usable: T[]; rejected: EndpointCheck[] }> {
  const chain = await chainOf(cc3, chainKey);
  const checks = await Promise.all(
    endpoints.map(async (e): Promise<EndpointCheck> => {
      try {
        const got = await withTimeout(timeoutMs, e.provider.send('eth_chainId', []).then((hex: string) => Number(hex)));
        if (!chain) {
          return {
            url: e.url,
            chainId: got,
            verdict: 'mismatch',
            why: `Creditcoin does not attest chain key ${chainKey}, so nothing can be swept for it`,
          };
        }
        return got === chain.chainId
          ? { url: e.url, chainId: got, verdict: 'confirmed' }
          : {
              url: e.url,
              chainId: got,
              verdict: 'mismatch',
              why: `serves chain id ${got}, not ${chain.chainId} (${chain.name})`,
            };
      } catch (err) {
        return { url: e.url, chainId: null, verdict: 'unreachable', why: reason(err) };
      }
    }),
  );
  return {
    chain,
    checks,
    usable: endpoints.filter((_, i) => checks[i]?.verdict !== 'mismatch'),
    rejected: checks.filter((c) => c.verdict === 'mismatch'),
  };
}

/// `getNetwork()` on a `staticNetwork` provider answers from memory without a request — it would
/// hand back the id this build asserted and call it confirmation. The check sends `eth_chainId`
/// itself, or it checks nothing.
async function withTimeout<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
