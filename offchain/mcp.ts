import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, sources } from './config';
import { ATTESTATION_INDEXERS, CHAIN_KEY, type DeploymentName } from './lib/networks';
// Imported rather than read at runtime, so `npm run mcp:package` can bake them into a bundle that
// runs from `npx utuh-mcp` with no repository, no forge artifacts and no cwd to read from. Under
// tsx these imports read the same files the old readFileSync did.
import registryArtifact from '../out/UtuhRegistry.sol/UtuhRegistry.json';
import { version } from '../package.json';
import sepoliaRecord from '../deployments.full.json';
import mainnetRecord from '../deployments.json';
import { scanScopeUnion, eventKey, type Scope, type ScopedEvent } from './lib/scope';
import { toScope } from './lib/specs';
import { Prover } from './lib/proofs';
import { findOmission, refuteClaim } from './lib/claims';
import { attestorKeys, recentAttestations } from './lib/attestations';
import { attestationBefore, checkpointLag, confirmEndpoints, heightForDigest, latestAttestation } from './lib/attest';
import { claimStatus } from './lib/status';
import { runScript } from './lib/cli';

/// The watcher, as a Model Context Protocol server — so an AI agent can be one.
///
/// Everything Utuh guarantees rests on the sentence *anyone may refute a claim by proving one
/// in-scope event it left out*, and "anyone" has so far meant a person: at a console, or at the
/// published page. This puts the same three verbs — look, sweep, refute — behind MCP, which makes
/// the watcher a role an agent can hold. An agent needs no account and no capital to look, and the
/// one that finds an omission is paid half the bond for proving it, which is a business model that
/// fits inside a tool call.
///
/// Nothing here is new machinery. Every tool is the same `offchain/lib` function the daemon and
/// the browser console already run; this file is a transport. That is deliberate twice over: an
/// MCP server with its own logic is a third implementation waiting to drift, and the claim "agents
/// can enforce completeness" is only credible if agents run the code that demonstrably does.
///
///   npm run mcp                # stdio; point Claude Desktop, Cursor, or any MCP client at it
///
/// Reading and sweeping need no key. `refute_claim` sends a real transaction: it requires both
/// `confirm: true` in the call and PRIVATE_KEY in the environment, and without either it explains
/// itself instead of acting.
///
/// Every tool answers twice: in prose a model can read, and as `structuredContent` a client can
/// validate against the tool's `outputSchema` and hand to code. The long ones — a sweep, an audit,
/// a refutation — report each step as a logging notification and, when the client sent a progress
/// token, as progress. A failure the caller can act on (no such claim, no usable endpoint) is an
/// `isError` result with an explanation, not a JSON-RPC error and not a stack trace.

/// stdout is the protocol channel. One stray print — and the SDK's attestation waiter does print —
/// is a corrupted JSON-RPC stream, so everything chatty is rerouted to stderr up front.
console.log = (...a: unknown[]) => console.error(...a);
console.info = (...a: unknown[]) => console.error(...a);
console.warn = (...a: unknown[]) => console.error(...a);

const provider = new JsonRpcProvider(CC3_RPC, CC3_CHAIN_ID, { staticNetwork: true });

/// The ChainInfo precompile lives on both Creditcoin networks, and the audit reads both. One
/// provider per network, built once: this server is long-lived, and a new provider per tool call
/// leaves a socket behind every time an agent asks.
const networks = new Map<string, JsonRpcProvider>();
function networkFor(indexer: { rpc: string; chainId: number }): JsonRpcProvider {
  const had = networks.get(indexer.rpc);
  if (had) return had;
  const made = new JsonRpcProvider(indexer.rpc, indexer.chainId, { staticNetwork: true });
  networks.set(indexer.rpc, made);
  return made;
}

const DEPLOYMENTS = ['sepolia', 'mainnet'] as const;
const DEPLOYMENT = z
  .enum(DEPLOYMENTS)
  .describe('Which deployment: "sepolia" is the completed loop, "mainnet" underwrites real Aave history');

const RECORDS: Record<DeploymentName, { registry?: string }> = {
  sepolia: sepoliaRecord,
  mainnet: mainnetRecord,
};

function registryAddress(which: DeploymentName): string {
  const address = RECORDS[which].registry;
  if (!address) throw new Error(`the ${which} deployment record names no registry`);
  return address;
}

function registryFor(which: DeploymentName): Contract {
  // Reads need no signer; refute attaches one. A random unfunded wallet is exactly right for a
  // read-only surface: it can sign nothing anyone would accept.
  return new Contract(registryAddress(which), registryArtifact.abi, Wallet.createRandom().connect(provider));
}

/// What a client is told at `initialize`, before it has seen a tool. An agent handed five tools
/// and nothing else will usually sweep one claim and stop; this is the job in five sentences, and
/// the one rule about spending.
const INSTRUCTIONS =
  'Utuh bonds the claim that a set of Ethereum events is complete; anyone who proves one omitted ' +
  'event takes half the bond. This server is the watcher. Start from utuh://claims/{deployment} ' +
  '(or list_claims) and take the claims whose "refutable" is true — a claim outside its challenge ' +
  'window cannot be broken no matter what it left out. Call sweep_claim on each: it spends nothing ' +
  'and reports either the omitted event or "complete", and "complete" is provenance, not proof — it ' +
  'is only as strong as the endpoints that vouched, which the result counts. refute_claim is the one ' +
  'tool that spends: it needs confirm: true and a funded PRIVATE_KEY, sends an irreversible ' +
  'transaction that slashes a real bond, and should be called only after a person has seen the ' +
  'finding and said yes. Deployments: "sepolia" is the completed loop, "mainnet" underwrites real ' +
  'Aave history.';

// The version a client sees is the one that was published, not one typed twice — `build-mcp.ts`
// stamps the same field into the npm package, and a server announcing a version it is not is a
// small lie that survives every release.
const server = new McpServer(
  { name: 'utuh', version },
  { instructions: INSTRUCTIONS, capabilities: { logging: {} } },
);

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/// One line to three places: stderr for whoever tails it, the client's log as a `notifications/message`,
/// and — when the request carried a progress token — the client's progress bar. A sweep of a wide
/// range or a refutation waiting on the Block Prover is silent for many seconds otherwise, and a
/// client that hears nothing assumes a hang.
function reporter(extra: Extra, total?: number): (message: string) => Promise<void> {
  let step = 0;
  return async (message) => {
    console.error(message);
    await server.sendLoggingMessage({ level: 'info', logger: 'utuh', data: message });
    const progressToken = extra._meta?.progressToken;
    if (progressToken === undefined) return;
    step++;
    await extra.sendNotification({
      method: 'notifications/progress',
      params: { progressToken, progress: step, ...(total === undefined ? {} : { total }), message },
    });
  };
}

/// Prose first, for the model; then the same answer as JSON, for the client. The spec asks for the
/// serialized form in a text block as well as in `structuredContent`, so a client that predates
/// structured results still gets it.
function answer<T extends Record<string, unknown>>(text: string, structured: T) {
  return {
    content: [
      { type: 'text' as const, text },
      { type: 'text' as const, text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
}

/// A failure the caller can act on, in the protocol's own shape for one.
function refuse(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

/// Four of the five tools only read: a chain, an indexer, a public Ethereum endpoint. Saying so in
/// the protocol's own words is what lets a client run them without asking a person first, and
/// reserve the confirmation for the one that spends. `openWorldHint` is true because every one of
/// them talks to the outside world and can therefore fail for reasons the caller did not cause.
const LOOKING = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const CLAIM = {
  claimId: z.number().int(),
  status: z.string().describe('Open, Sealed, Finalized or Refuted'),
  members: z.number().int().describe('Events proven into the claim'),
  fromBlock: z.number().int(),
  toBlock: z.number().int(),
  bondCTC: z.string(),
  claimant: z.string(),
  challengeBlocksLeft: z
    .number()
    .int()
    .nullable()
    .describe('Creditcoin blocks left in the window; null unless Sealed'),
  refutable: z.boolean().describe('Sealed and still inside its challenge window'),
};

const OMITTED = z.object({
  blockNumber: z.number().int(),
  txIndex: z.number().int(),
  logIndexInTx: z.number().int(),
  orderingKey: z.string().describe('The uint256 key the registry stores members under, as a decimal string'),
});

const TALLY = {
  eventsProvenIntoClaims: z.number().int(),
  claimsSealed: z.number().int(),
  claimsRefuted: z.number().int(),
  bondSlashedCTC: z.string(),
};

server.registerTool(
  'tally',
  {
    title: 'What the registries have done',
    description:
      'The four numbers across both deployments: events proven into claims, claims sealed, claims ' +
      'broken by a refutation, and bond slashed. Read live from Creditcoin CC3 Testnet.',
    inputSchema: {},
    outputSchema: TALLY,
    annotations: LOOKING,
  },
  async () => {
    const t = await tally();
    return answer(
      `events proven into claims: ${t.eventsProvenIntoClaims}\nclaims sealed: ${t.claimsSealed}\n` +
        `claims broken by a refutation: ${t.claimsRefuted}\nbond slashed: ${t.bondSlashedCTC} CTC`,
      t,
    );
  },
);

server.registerTool(
  'list_claims',
  {
    title: 'List claims',
    description:
      'A page of claims on a deployment, by id, each with its status, member count, bond, and — for ' +
      'sealed ones — how many Creditcoin blocks remain in the challenge window. Sealed claims inside ' +
      'their window are the ones a watcher can still act on. Pass the returned nextCursor to get the ' +
      'next page; utuh://claims/{deployment} is the same list in one read.',
    inputSchema: {
      deployment: DEPLOYMENT,
      cursor: z.string().optional().describe('The nextCursor of the previous page; omit for the first'),
      limit: z.number().int().min(1).max(100).default(25).describe('Claims per page, 1..100'),
    },
    outputSchema: {
      deployment: DEPLOYMENT,
      registry: z.string(),
      head: z.number().int().describe('The Creditcoin block the windows were measured against'),
      total: z.number().int().describe('Claims on the deployment'),
      claims: z.array(z.object(CLAIM)),
      nextCursor: z.string().nullable().describe('null on the last page'),
    },
    annotations: LOOKING,
  },
  async ({ deployment, cursor, limit }) => {
    const start = cursor === undefined ? 1 : Number(cursor);
    if (!Number.isInteger(start) || start < 1) return refuse(`cursor "${cursor}" is not one this server issued`);
    const r = registryFor(deployment);
    const [head, total] = await Promise.all([provider.getBlockNumber(), claimCount(r)]);
    const ids = [];
    for (let i = start; i <= Math.min(total, start + limit - 1); i++) ids.push(i);
    const claims = await claimsJson(r, ids, head);
    const nextCursor = start + limit <= total ? String(start + limit) : null;
    const lines = claims.map(
      (c) =>
        `claim ${c.claimId}: ${c.status}, ${c.members} member(s), source ${c.fromBlock}..${c.toBlock}, ` +
        `bond ${c.bondCTC} CTC, ${
          c.status === 'Sealed' ? (c.refutable ? `${c.challengeBlocksLeft} blocks left` : 'window closed') : '—'
        }`,
    );
    if (nextCursor) lines.push(`… ${total - (start + limit - 1)} more; call again with cursor "${nextCursor}"`);
    return answer(lines.join('\n') || 'no claims yet', {
      deployment,
      registry: registryAddress(deployment),
      head,
      total,
      claims,
      nextCursor,
    });
  },
);

server.registerTool(
  'sweep_claim',
  {
    title: 'Sweep a claim for completeness',
    description:
      "Sweep the source chain across independent endpoints for every in-scope event in a claim's " +
      'range, take the union, and check each event against the claim on-chain. Needs no key and ' +
      'spends nothing. Reports complete with provenance, or the omitted event — which refute_claim ' +
      'can then prove, if the claim is still inside its window. Finalized and refuted claims can be ' +
      'swept too, for the record; open ones are still being built and cannot.',
    inputSchema: { deployment: DEPLOYMENT, claimId: z.number().int().positive() },
    outputSchema: {
      deployment: DEPLOYMENT,
      claimId: z.number().int(),
      status: z.string(),
      refutable: z.boolean(),
      bondCTC: z.string(),
      complete: z.boolean().describe('Every swept event is in the claim — as far as these endpoints saw'),
      omitted: OMITTED.nullable().describe('The first in-scope event the claim does not contain'),
      provenance: z.object({
        events: z.number().int().describe('Distinct in-scope events in the union'),
        vouched: z.number().int().describe('Endpoints that saw every event in the union'),
        attempted: z.number().int(),
        perSource: z.array(z.string()),
        chain: z.string(),
        rejected: z.array(z.object({ url: z.string(), why: z.string() })),
      }),
    },
    annotations: LOOKING,
  },
  async ({ deployment, claimId }, extra) => {
    const report = reporter(extra, 4);
    const r = registryFor(deployment);
    const [c, head] = await Promise.all([r.claim(claimId), provider.getBlockNumber()]);
    const status = claimStatus(c.status);
    if (status === 'None') return refuse(`there is no claim ${claimId} on the ${deployment} deployment`);
    if (status === 'Open')
      return refuse(`claim ${claimId} is still Open — it is being built, and can be swept once sealed`);
    const refutable = status === 'Sealed' && Number(c.sealedAt) + Number(c.challengeWindow) > head;
    const scope: Scope = toScope(c.scope);
    await report(`claim ${claimId} on ${deployment}: ${status}, source blocks ${c.fromBlock}..${c.toBlock}`);
    // The same guard the browser and the daemon apply, for the same reason: an endpoint serving
    // another chain returns no in-scope logs, and no logs reads exactly like a complete claim.
    const { chain, usable, rejected } = await confirmEndpoints(provider, scope.chainKey, sources(scope.chainKey));
    const chainName = chain?.name ?? `chain key ${scope.chainKey}`;
    if (usable.length === 0) {
      return refuse(
        `every endpoint is serving some chain other than ${chainName} — nothing can be concluded about claim ${claimId}`,
      );
    }
    await report(`${usable.length} endpoint(s) confirmed serving ${chainName}, ${rejected.length} rejected`);
    const sweep = await scanScopeUnion(usable, scope, Number(c.fromBlock), Number(c.toBlock));
    await report(
      `${sweep.events.length} in-scope event(s) in the union, ${sweep.vouched}/${sweep.attempted} vouched`,
    );
    const gap = await findOmission(r, BigInt(claimId), sweep.events);
    await report(
      gap ? `claim ${claimId} omits the event at block ${gap.blockNumber}` : `claim ${claimId} contains every event`,
    );
    const rejectedNote = rejected.length
      ? `\n${rejected.length} endpoint(s) rejected: ${rejected.map((x) => `${x.url} ${x.why}`).join('; ')}`
      : '';
    const provenance =
      `union of ${sweep.events.length} event(s) from ${sweep.vouched}/${sweep.attempted} endpoint(s) that saw everything ` +
      `(${sweep.perSource.join(', ')}), on ${chainName} confirmed by chain id${rejectedNote}`;
    const bondCTC = formatEther(c.bondPosted);
    const next = refutable
      ? `One proof of that event takes half the ${bondCTC} CTC bond: call refute_claim.`
      : `The claim is ${status}, so nothing can be done about it now.`;
    const text = gap
      ? `INCOMPLETE: claim ${claimId} does not contain the event at source block ${gap.blockNumber}, ` +
        `tx #${gap.txIndex}, log #${gap.logIndexInTx} (ordering key ${eventKey(gap)}).\n${provenance}\n${next}`
      : `complete as far as these endpoints saw: every swept event is in the claim.\n${provenance}\n` +
        `"No gap found" is only as strong as the endpoints that looked; it is provenance, not proof.`;
    return answer(text, {
      deployment,
      claimId,
      status,
      refutable,
      bondCTC,
      complete: gap === null,
      omitted: gap ? omittedJson(gap) : null,
      provenance: {
        events: sweep.events.length,
        vouched: sweep.vouched,
        attempted: sweep.attempted,
        perSource: sweep.perSource,
        chain: chainName,
        rejected: rejected.map((x) => ({ url: x.url, why: x.why ?? x.verdict })),
      },
    });
  },
);

server.registerTool(
  'refute_claim',
  {
    title: 'Refute an incomplete claim',
    description:
      'Prove one omitted in-scope event through the Block Prover precompile and break the claim. ' +
      'Sends a real transaction on Creditcoin CC3 Testnet and pays the caller half the bond. ' +
      'Requires PRIVATE_KEY in the environment with a little CTC for gas. Answers with sent: false ' +
      'and a reason whenever it did not send.',
    inputSchema: {
      deployment: DEPLOYMENT,
      claimId: z.number().int().positive(),
      confirm: z
        .boolean()
        .default(false)
        .describe('Must be true. This sends an irreversible transaction that slashes a real bond.'),
    },
    outputSchema: {
      deployment: DEPLOYMENT,
      claimId: z.number().int(),
      sent: z.boolean(),
      reason: z.string().nullable().describe('Why nothing was sent; null when it was'),
      omitted: OMITTED.nullable().describe('The event proven, or that would have been'),
      txHash: z.string().nullable(),
      rewardCTC: z.string().nullable(),
      refuter: z.string().nullable().describe('The address paid'),
    },
    // The one tool that spends. `destructiveHint` is not decoration here: a refutation burns half
    // of somebody's bond and marks their claim broken for good, and a client that surfaces a
    // confirmation for exactly one of these five tools should surface it for this one. It is not
    // idempotent either — the second call against a refuted claim reverts.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  async ({ deployment, claimId, confirm }, extra) => {
    const notSent = (reason: string, omitted: ScopedEvent | null = null) =>
      answer(reason, {
        deployment,
        claimId,
        sent: false,
        reason,
        omitted: omitted ? omittedJson(omitted) : null,
        txHash: null,
        rewardCTC: null,
        refuter: null,
      });
    // The guard is structural, not environmental. The first client ever pointed at this server
    // refuted a standing claim during its own smoke test, because the key it was not supposed to
    // have arrived through dotenv instead of the environment the transport had stripped. An
    // agent's "let me just try the tool" must cost a deliberate second call, not a bond.
    if (!confirm) {
      return notSent(
        `Not sent. Refuting claim ${claimId} is an irreversible on-chain transaction: it ` +
          'proves the omitted event through the Block Prover, slashes the bond, and pays half ' +
          'to the caller. Call again with confirm: true to proceed, or use sweep_claim first ' +
          'to see what would be proven.',
      );
    }
    const key = process.env.PRIVATE_KEY;
    if (!key) {
      return notSent(
        'No PRIVATE_KEY in the environment. Sweeping is free, but a refutation is a real ' +
          'transaction: set PRIVATE_KEY to a funded CC3 testnet key (faucet: Creditcoin ' +
          'Discord #token-faucet) and call this again.',
      );
    }
    const report = reporter(extra);
    const wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
    const r = new Contract(registryAddress(deployment), registryArtifact.abi, wallet);
    const c = await r.claim(claimId);
    if (claimStatus(c.status) !== 'Sealed') {
      return notSent(`claim ${claimId} is ${claimStatus(c.status)} — nothing to refute`);
    }
    const scope: Scope = toScope(c.scope);
    await report(`sweeping claim ${claimId} on ${deployment} before spending anything`);
    const sweep = await scanScopeUnion(sources(scope.chainKey), scope, Number(c.fromBlock), Number(c.toBlock));
    const gap = await findOmission(r, BigInt(claimId), sweep.events);
    if (!gap) {
      return notSent(`no omission found in claim ${claimId} — a refutation without one would only cost gas`);
    }
    await report(`claim ${claimId} omits the event at block ${gap.blockNumber}; proving it through the Block Prover`);
    const prover = Prover.withDefaults(scope.chainKey);
    // `txHash` is read as optional so this compiles whether or not lib/claims has grown it yet.
    const done: { reward: bigint; key: bigint; txHash?: string } = await refuteClaim(
      r,
      prover,
      BigInt(claimId),
      gap,
      report,
    );
    const rewardCTC = formatEther(done.reward);
    return answer(
      `claim ${claimId} refuted with the event at source block ${gap.blockNumber} ` +
        `(ordering key ${done.key}). Reward: ${rewardCTC} CTC to ${wallet.address}.`,
      {
        deployment,
        claimId,
        sent: true,
        reason: null,
        omitted: omittedJson(gap),
        txHash: done.txHash ?? null,
        rewardCTC,
        refuter: wallet.address,
      },
    );
  },
);

const DIGEST = z.enum(['on chain', 'wrong height', 'not on chain']);

server.registerTool(
  'audit_attestors',
  {
    title: "Audit Creditcoin's attestors",
    description:
      'Ask both Creditcoin networks (CC3 Testnet and Creditcoin Mainnet) what header hashes their ' +
      'attestors signed for recent Ethereum blocks, then check each three ways: against independent ' +
      "Ethereum endpoints, against that network's own ChainInfo digest index, and against the other " +
      'network. A MISMATCH would mean attestors signed a block Ethereum does not have; NOT ON CHAIN ' +
      'would mean the indexer published an attestation the chain does not hold.',
    inputSchema: {},
    outputSchema: {
      networks: z.array(
        z.object({
          network: z.string(),
          chainKey: z.number().int(),
          attestationsIndexed: z.number().int(),
          attestedTo: z.number().int().describe('Highest Ethereum block attested'),
          checkpoint: z.number().int().nullable().describe('Last checkpointed Ethereum block; null if none yet'),
          blocks: z.array(
            z.object({
              height: z.number().int(),
              headerHash: z.string(),
              ethereumAnswered: z.number().int().describe('Endpoints that returned the block'),
              ethereumAgree: z.number().int().describe('Of those, how many returned this hash'),
              digest: DIGEST,
            }),
          ),
        }),
      ),
      crossNetwork: z.object({
        compared: z.boolean(),
        height: z.number().int().nullable().describe('The Ethereum block both networks were compared at'),
        identicalDigest: z.boolean().nullable(),
        attestorKeys: z
          .object({ testnet: z.number().int(), mainnet: z.number().int(), shared: z.number().int() })
          .nullable(),
        note: z.string(),
      }),
    },
    annotations: LOOKING,
  },
  async (_args, extra) => {
    const report = reporter(extra, 3);
    const out: string[] = [];
    const networksOut = [];
    for (const [label, indexer, chainKey] of [
      ['CC3 Testnet', ATTESTATION_INDEXERS.testnet, CHAIN_KEY.mainnet],
      ['Creditcoin Mainnet', ATTESTATION_INDEXERS.mainnet, ATTESTATION_INDEXERS.mainnet.ethereumKey],
    ] as const) {
      const network = networkFor(indexer);
      const [{ total, nodes }, lag] = await Promise.all([
        recentAttestations(indexer, chainKey, 4),
        checkpointLag(network, chainKey),
      ]);
      out.push(`${label}: ${total.toLocaleString()} attestations of Ethereum indexed (chain key ${chainKey})`);
      out.push(
        lag.exists
          ? `  attested to ${lag.attestationHeight.toLocaleString()}, last checkpoint ` +
              `${lag.checkpointHeight.toLocaleString()} (${lag.lag} source blocks behind)`
          : `  attested to ${lag.attestationHeight.toLocaleString()}, not checkpointed yet`,
      );
      const blocks = [];
      for (const a of nodes) {
        const answers = await Promise.all(
          sources(CHAIN_KEY.mainnet).map(async (e) => {
            try {
              return (await e.provider.getBlock(a.headerNumber))?.hash?.toLowerCase() ?? null;
            } catch {
              return null;
            }
          }),
        );
        const seen = answers.filter((h): h is string => h !== null);
        const agree = seen.filter((h) => h === a.headerHash.toLowerCase()).length;
        // The second leg: the chain's own digest index. Checking the header against Ethereum
        // catches attestors signing a block Ethereum does not have, and cannot catch an indexer
        // inventing a row Ethereum would happily agree with. A digest that resolves to the height
        // it was reported at came from the chain.
        const indexed = await heightForDigest(network, chainKey, a.digest);
        const digest: z.infer<typeof DIGEST> = !indexed.exists
          ? 'not on chain'
          : indexed.height === a.headerNumber
            ? 'on chain'
            : 'wrong height';
        blocks.push({
          height: a.headerNumber,
          headerHash: a.headerHash,
          ethereumAnswered: seen.length,
          ethereumAgree: agree,
          digest,
        });
        out.push(
          `  block ${a.headerNumber}: ${
            seen.length === 0
              ? 'no endpoint answered'
              : agree === seen.length
                ? `matches ${agree}/${seen.length}`
                : `MISMATCH ${agree}/${seen.length}`
          } · digest ${digest === 'wrong height' ? `WRONG HEIGHT ${indexed.height}` : digest.toUpperCase()}`,
        );
      }
      networksOut.push({
        network: label,
        chainKey,
        attestationsIndexed: total,
        attestedTo: lag.attestationHeight,
        checkpoint: lag.exists ? lag.checkpointHeight : null,
        blocks,
      });
      await report(`${label}: ${nodes.length} recent attestations checked against Ethereum and the digest index`);
    }
    const cross = await crossNetwork();
    await report('the two networks compared at a height both have reached');
    out.push(cross.note);
    return answer(out.join('\n'), { networks: networksOut, crossNetwork: cross });
  },
);

/// Claims as data, not as prose.
///
/// Tools were the whole server, and a tool answers in text a model has to re-read every turn.
/// Resources are the protocol's other half: a client can attach one to a conversation, hand it back
/// unchanged as often as it likes, and re-read it when it changes. A watcher deciding whether a
/// claim is worth refuting wants the claim — its scope, its range, its bond, what remains of its
/// window — as JSON it can hold, not as a paragraph it has to parse. So the same reads the tools do
/// are also addressable:
///
///   utuh://tally                      the four numbers across both deployments
///   utuh://claims/{deployment}        every claim, with status and remaining window
///   utuh://claim/{deployment}/{id}    one claim in full, scope included
///
/// The two templated ones list their deployments under `resources/list`, so a client that never
/// expands templates still finds them, and complete their variables, so a person typing one in a
/// picker is offered "sepolia" and "mainnet" and then the claim ids that exist.
/// Nothing here is a second implementation — they read the same contracts through the same helpers.
server.registerResource(
  'tally',
  'utuh://tally',
  {
    title: 'Registry tally',
    description: 'Events proven, claims sealed, claims refuted and bond slashed, across both deployments.',
    mimeType: 'application/json',
  },
  async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await tally(), null, 2) }],
  }),
);

const completeDeployment = (value: string) => DEPLOYMENTS.filter((d) => d.startsWith(value));

/// A prompt argument that completes. `completable` marks the schema it is handed, so each prompt gets
/// its own copy rather than a shared DEPLOYMENT marked twice — the second marking throws at load.
const deploymentArg = () =>
  completable(z.enum(DEPLOYMENTS).describe(DEPLOYMENT.description ?? ''), completeDeployment);

server.registerResource(
  'claims',
  new ResourceTemplate('utuh://claims/{deployment}', {
    list: async () => ({
      resources: DEPLOYMENTS.map((d) => ({
        uri: `utuh://claims/${d}`,
        name: `claims-${d}`,
        title: `Claims on ${d}`,
        mimeType: 'application/json',
      })),
    }),
    complete: { deployment: completeDeployment },
  }),
  {
    title: 'Claims on a deployment',
    description: 'Every claim with its status, members, source range, bond and remaining challenge window.',
    mimeType: 'application/json',
  },
  async (uri, { deployment }) => {
    const which = DEPLOYMENT.parse(deployment);
    const r = registryFor(which);
    const [head, total] = await Promise.all([provider.getBlockNumber(), claimCount(r)]);
    const ids = Array.from({ length: total }, (_, i) => i + 1);
    const claims = await claimsJson(r, ids, head);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ deployment: which, registry: registryAddress(which), head, claims }, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  'claim',
  new ResourceTemplate('utuh://claim/{deployment}/{claimId}', {
    list: undefined,
    complete: {
      deployment: completeDeployment,
      // The ids that exist on the deployment already chosen, narrowed by what has been typed.
      claimId: async (value, context) => {
        const which = DEPLOYMENT.safeParse(context?.arguments?.deployment);
        if (!which.success) return [];
        const total = await claimCount(registryFor(which.data));
        return Array.from({ length: total }, (_, i) => String(i + 1))
          .filter((id) => id.startsWith(value))
          .slice(0, 20);
      },
    },
  }),
  {
    title: 'One claim',
    description: 'A single claim in full, including the scope it bonded — what a refuter needs to sweep it.',
    mimeType: 'application/json',
  },
  async (uri, { deployment, claimId }) => {
    const which = DEPLOYMENT.parse(deployment);
    const r = registryFor(which);
    const head = await provider.getBlockNumber();
    const id = Number(claimId);
    const c = await r.claim(id);
    const scope = toScope(c.scope);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              deployment: which,
              registry: registryAddress(which),
              ...(await claimJson(r, id, head)),
              scope: {
                chainKey: scope.chainKey,
                emitter: scope.emitter,
                eventSig: scope.eventSig,
                topics: scope.topics,
                topicMask: scope.topicMask,
                metric: scope.metric,
                metricArg: scope.metricArg,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

async function claimCount(r: Contract): Promise<number> {
  return Number(await r.nextClaimId()) - 1;
}

/// One claim, as the shape both resources and both listing tools hand back.
async function claimJson(r: Contract, id: number, head: number): Promise<z.infer<z.ZodObject<typeof CLAIM>>> {
  const [c, members] = await Promise.all([r.claim(id), r.memberCount(id)]);
  const status = claimStatus(c.status);
  const until = Number(c.sealedAt) + Number(c.challengeWindow);
  return {
    claimId: id,
    status,
    members: Number(members),
    fromBlock: Number(c.fromBlock),
    toBlock: Number(c.toBlock),
    bondCTC: formatEther(c.bondPosted),
    claimant: c.claimant,
    // Only a sealed claim has a window that means anything; a refuter reads this first.
    challengeBlocksLeft: status === 'Sealed' ? Math.max(0, until - head) : null,
    refutable: status === 'Sealed' && until > head,
  };
}

/// Many claims, ten at a time. Read one after another, seventy claims took forty seconds over the
/// public RPC; read all at once they are one oversized batch it may refuse. Ten is a page the
/// endpoint answers in a round trip.
async function claimsJson(r: Contract, ids: number[], head: number) {
  const out = [];
  for (let i = 0; i < ids.length; i += 10) {
    out.push(...(await Promise.all(ids.slice(i, i + 10).map((id) => claimJson(r, id, head)))));
  }
  return out;
}

function omittedJson(e: ScopedEvent): z.infer<typeof OMITTED> {
  return {
    blockNumber: e.blockNumber,
    txIndex: e.txIndex,
    logIndexInTx: e.logIndexInTx,
    orderingKey: eventKey(e).toString(),
  };
}

/// The four numbers, shared by the `tally` tool and the `utuh://tally` resource.
async function tally(): Promise<z.infer<z.ZodObject<typeof TALLY>>> {
  let proven = 0;
  let sealed = 0;
  let refuted = 0;
  let burned = 0n;
  for (const which of Object.keys(RECORDS) as DeploymentName[]) {
    const r = registryFor(which);
    const [head, total, b] = await Promise.all([
      provider.getBlockNumber(),
      claimCount(r),
      r.burned() as Promise<bigint>,
    ]);
    sealed += total;
    burned += b;
    for (const c of await claimsJson(
      r,
      Array.from({ length: total }, (_, i) => i + 1),
      head,
    )) {
      proven += c.members;
      if (c.status === 'Refuted') refuted++;
    }
  }
  return {
    eventsProvenIntoClaims: proven,
    claimsSealed: sealed,
    claimsRefuted: refuted,
    bondSlashedCTC: formatEther(burned),
  };
}

/// The watcher's job, written down once so a client does not have to invent it.
///
/// An agent handed five tools and no instructions will usually sweep one claim and stop. The job is
/// a loop with a stopping rule and a spending rule, and both matter: sweep only what is still
/// inside its window, believe a gap only when the endpoints that saw everything agree, and never
/// send the transaction without being told to. A prompt is where that belongs in this protocol —
/// two of them, because the job has two halves: the free one, and the one that spends.
server.registerPrompt(
  'hold_the_watcher_role',
  {
    title: 'Hold the watcher role',
    description: 'Sweep every refutable claim on a deployment and report the gaps, without spending anything.',
    argsSchema: { deployment: deploymentArg() },
  },
  ({ deployment }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Hold the watcher role on the ${deployment} deployment of the Utuh registry.\n\n` +
            `1. Read utuh://claims/${deployment} and take every claim whose "refutable" is true — a claim ` +
            'outside its challenge window cannot be broken no matter what it left out.\n' +
            '2. For each, call sweep_claim. It sweeps the source chain across independent endpoints and ' +
            'checks every event it finds against the claim on-chain; its structured result carries the ' +
            'verdict in "complete", the gap in "omitted", and the endpoint counts in "provenance".\n' +
            '3. Treat an omission as a finding, not a verdict: report the omitted event, the claim it ' +
            'belongs to, and the bond at stake. Treat "complete" as provenance — it is only as ' +
            'strong as the number of endpoints that vouched, which the result tells you.\n' +
            '4. Do not call refute_claim. It sends a real transaction that slashes a real bond; bring the ' +
            'finding back and let the person decide — the weigh_a_refutation prompt is for that.\n\n' +
            'Finish with a table of every claim you swept, its verdict, and the provenance behind it.',
        },
      },
    ],
  }),
);

server.registerPrompt(
  'weigh_a_refutation',
  {
    title: 'Weigh a refutation',
    description:
      'Take one claim from finding to decision: confirm the gap, lay out what a refutation would cost ' +
      'and pay, and send it only on an explicit yes.',
    argsSchema: {
      deployment: deploymentArg(),
      claimId: z.string().describe('The claim id, as sweep_claim or list_claims reported it'),
    },
  },
  ({ deployment, claimId }) => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text:
            `Weigh a refutation of claim ${claimId} on the ${deployment} deployment of the Utuh registry.\n\n` +
            `1. Read utuh://claim/${deployment}/${claimId}. If "refutable" is false, stop and say why: a ` +
            'claim that is Finalized, Refuted, or past its window cannot be broken.\n' +
            '2. Call sweep_claim on it. If "complete" is true, stop: a refutation without an omission ' +
            'reverts and only costs gas.\n' +
            '3. Otherwise lay it out: the omitted event (block, transaction index, log index), how many ' +
            'endpoints vouched for the union it came from, the bond posted, and that the reward is half ' +
            'that bond, paid to whichever key sends the proof. Gas on Creditcoin CC3 Testnet is a fraction ' +
            'of a CTC.\n' +
            '4. Ask me, in one sentence, whether to send it. Do not call refute_claim until I have answered ' +
            'yes in my own words; "proceed if it looks fine" is not a yes.\n' +
            '5. On a yes, call refute_claim with confirm: true. If it answers sent: false, report the ' +
            'reason and stop. If it sent, report the transaction hash, the reward, and the address paid.',
        },
      },
    ],
  }),
);

/// The two networks compared at a height both have reached.
///
/// They do not run in lockstep — measured 2026-09-07, the testnet frontier ran 30 Ethereum blocks
/// ahead of the mainnet's — so the comparison is taken at the lower frontier, and
/// `find_highest_attested_before` is exclusive, hence the `+ 1`. Comparing at either network's own
/// frontier asks the other about a digest it has not indexed yet, which reads as a disagreement and
/// is only a lag.
async function crossNetwork(): Promise<{
  compared: boolean;
  height: number | null;
  identicalDigest: boolean | null;
  attestorKeys: { testnet: number; mainnet: number; shared: number } | null;
  note: string;
}> {
  const t = ATTESTATION_INDEXERS.testnet;
  const m = ATTESTATION_INDEXERS.mainnet;
  try {
    const netT = networkFor(t);
    const netM = networkFor(m);
    const [latestT, latestM] = await Promise.all([
      latestAttestation(netT, CHAIN_KEY.mainnet),
      latestAttestation(netM, m.ethereumKey),
    ]);
    const common = Math.min(latestT.height, latestM.height) + 1;
    const [pointT, pointM, keysT, keysM] = await Promise.all([
      attestationBefore(netT, CHAIN_KEY.mainnet, common),
      attestationBefore(netM, m.ethereumKey, common),
      attestorKeys(t, CHAIN_KEY.mainnet).catch(() => [] as string[]),
      attestorKeys(m, m.ethereumKey).catch(() => [] as string[]),
    ]);
    const shared = keysT.filter((k) => keysM.includes(k)).length;
    const same = pointT.height === pointM.height && pointT.digest.toLowerCase() === pointM.digest.toLowerCase();
    return {
      compared: true,
      height: pointT.height,
      identicalDigest: same,
      attestorKeys: { testnet: keysT.length, mainnet: keysM.length, shared },
      note:
        `both networks at Ethereum block ${pointT.height.toLocaleString()}: ` +
        `${same ? 'identical digest' : `DIGESTS DIFFER (${pointT.digest.slice(0, 12)}… vs ${pointM.digest.slice(0, 12)}…)`}, ` +
        `${keysT.length} vs ${keysM.length} registered attestor keys, ${shared} shared`,
    };
  } catch (e) {
    return {
      compared: false,
      height: null,
      identicalDigest: null,
      attestorKeys: null,
      note: `the two networks could not be compared: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(
    'utuh mcp server on stdio — tools: tally, list_claims, sweep_claim, refute_claim, audit_attestors; ' +
      'resources: utuh://tally, utuh://claims/{deployment}, utuh://claim/{deployment}/{claimId}; ' +
      'prompts: hold_the_watcher_role, weigh_a_refutation',
  );
  // A stdio server lives until its client hangs up; resolving here would let runScript exit.
  await new Promise<never>(() => {});
}

runScript(main);
