import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, sources, withDeadline } from './config';
import { ATTESTATION_INDEXERS, CHAIN_KEY, SWEEP_CHUNK, requireChainKey, type DeploymentName } from './lib/networks';
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
import { modelledGas } from './lib/gasLimit';
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
/// The same server is served over Streamable HTTP by `api/mcp.ts`, for the clients that take a URL
/// rather than a command — Claude.ai connectors, ChatGPT, hosted agents. `createServer` is the one
/// definition of every tool, resource and prompt, and the transport changes exactly two things:
///
///   - Who holds the key. On stdio it is the operator's own machine, so `refute_claim` sends, behind
///     `confirm: true` and PRIVATE_KEY. Over HTTP the server is shared and holds no key at all:
///     `refute_claim` never sends, and returns the unsigned transaction for the caller's wallet.
///   - How long a call may take. A function platform kills a request at its limit, and a killed
///     request tells the client nothing. Over HTTP a sweep has a budget, and a sweep that runs out
///     answers with how far it got, marked inconclusive.
///
/// Every tool answers twice: in prose a model can read, and as `structuredContent` a client can
/// validate against the tool's `outputSchema` and hand to code. The long ones — a sweep, an audit,
/// a refutation — report each step as a logging notification and, when the client sent a progress
/// token, as progress. A failure the caller can act on (no such claim, no usable endpoint) is an
/// `isError` result with an explanation, not a JSON-RPC error and not a stack trace.

export interface ServeOptions {
  transport: 'stdio' | 'http';
  /// Milliseconds one tool call may spend before it answers with what it has. Unset means no
  /// limit, which is right for a process the operator runs themselves.
  budgetMs?: number;
}

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
/// the one rule about spending — which is a different rule when the server holds no key.
function instructions(remote: boolean): string {
  return (
    'Utuh bonds the claim that a set of Ethereum events is complete; anyone who proves one omitted ' +
    'event takes half the bond. This server is the watcher. Start from utuh://claims/{deployment} ' +
    '(or list_claims) and take the claims whose "refutable" is true — a claim outside its challenge ' +
    'window cannot be broken no matter what it left out. Call sweep_claim on each: it spends nothing ' +
    'and reports either the omitted event or "complete", and "complete" is provenance, not proof — it ' +
    'is only as strong as the endpoints that vouched, which the result counts. ' +
    (remote
      ? 'This remote server holds no key and sends nothing: refute_claim returns the exact unsigned ' +
        "transaction — target, calldata built from a real proof, chain id and gas — for the person's " +
        'own wallet to sign. Signing it slashes a real bond, so hand it over only after a person has ' +
        'seen the finding and said yes. A sweep here has a time budget; one marked "inconclusive" ran ' +
        'out of it and says how far it got. '
      : 'refute_claim is the one tool that spends: it needs confirm: true and a funded PRIVATE_KEY, sends ' +
        'an irreversible transaction that slashes a real bond, and should be called only after a person ' +
        'has seen the finding and said yes. ') +
    'Deployments: "sepolia" is the completed loop, "mainnet" underwrites real Aave history.'
  );
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/// One line to three places: stderr for whoever tails it, the client's log as a `notifications/message`,
/// and — when the request carried a progress token — the client's progress bar. A sweep of a wide
/// range or a refutation waiting on the Block Prover is silent for many seconds otherwise, and a
/// client that hears nothing assumes a hang.
///
/// The log line goes out through `extra`, tied to the request, rather than `sendLoggingMessage`. Over
/// stdio the two are the same; over stateless HTTP an unrelated notification has only the standalone
/// GET stream to travel on, which does not exist, so it would be dropped without a word. The level a
/// client set with `logging/setLevel` is still honoured, through the SDK's own check.
function reporter(server: McpServer, extra: Extra, total?: number): (message: string) => Promise<void> {
  let step = 0;
  return async (message) => {
    console.error(message);
    if (!server.server['isMessageIgnored']('info', extra.sessionId)) {
      await extra.sendNotification({
        method: 'notifications/message',
        params: { level: 'info', logger: 'utuh', data: message },
      });
    }
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

const DIGEST = z.enum(['on chain', 'wrong height', 'not on chain']);

const completeDeployment = (value: string) => DEPLOYMENTS.filter((d) => d.startsWith(value));

/// A prompt argument that completes. `completable` marks the schema it is handed, so each prompt gets
/// its own copy rather than a shared DEPLOYMENT marked twice — the second marking throws at load.
const deploymentArg = () =>
  completable(z.enum(DEPLOYMENTS).describe(DEPLOYMENT.description ?? ''), completeDeployment);

/// The whole server: every tool, resource and prompt, for either transport.
///
/// Over HTTP it is built once per request — the stateless Streamable HTTP pattern, where nothing
/// survives between calls but the module-level providers and the tally cache — so it has to be
/// cheap, and it is: registration is bookkeeping, and every read happens inside a handler.
export function createServer({ transport, budgetMs }: ServeOptions): McpServer {
  const remote = transport === 'http';

  // The version a client sees is the one that was published, not one typed twice — `build-mcp.ts`
  // stamps the same field into the npm package, and a server announcing a version it is not is a
  // small lie that survives every release.
  const server = new McpServer(
    { name: 'utuh', version },
    { instructions: instructions(remote), capabilities: { logging: {} } },
  );

  server.registerTool(
    'tally',
    {
      title: 'What the registries have done',
      description:
        'The four numbers across both deployments: events proven into claims, claims sealed, claims ' +
        'broken by a refutation, and bond slashed. Read live from Creditcoin CC3 Testnet, and served ' +
        `again for up to ${TALLY_TTL_MS / 1000}s so a busy client does not re-read every claim on every call.`,
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
        'swept too, for the record; open ones are still being built and cannot.' +
        (budgetMs === undefined
          ? ''
          : ` This server gives a sweep ${Math.round(budgetMs / 1000)}s; a range too wide for that ` +
            'answers inconclusive, with the block it swept through.'),
      inputSchema: { deployment: DEPLOYMENT, claimId: z.number().int().positive() },
      outputSchema: {
        deployment: DEPLOYMENT,
        claimId: z.number().int(),
        status: z.string(),
        refutable: z.boolean(),
        bondCTC: z.string(),
        complete: z
          .boolean()
          .describe('Every event in the whole range is in the claim — as far as these endpoints saw'),
        inconclusive: z
          .boolean()
          .describe('The time budget ran out before the whole range was swept, and no omission was found in time'),
        sweptThrough: z
          .number()
          .int()
          .describe('The last source block the sweep covered; toBlock unless the budget ran out'),
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
      const deadline = budgetMs === undefined ? Infinity : Date.now() + budgetMs;
      const report = reporter(server, extra, 4);
      const r = registryFor(deployment);
      const [c, head] = await Promise.all([r.claim(claimId), provider.getBlockNumber()]);
      const status = claimStatus(c.status);
      if (status === 'None') return refuse(`there is no claim ${claimId} on the ${deployment} deployment`);
      if (status === 'Open')
        return refuse(`claim ${claimId} is still Open — it is being built, and can be swept once sealed`);
      const refutable = status === 'Sealed' && Number(c.sealedAt) + Number(c.challengeWindow) > head;
      await report(`claim ${claimId} on ${deployment}: ${status}, source blocks ${c.fromBlock}..${c.toBlock}`);
      const sweep = await sweepClaim(
        r,
        claimId,
        toScope(c.scope),
        Number(c.fromBlock),
        Number(c.toBlock),
        deadline,
        report,
      );
      if (typeof sweep === 'string') return refuse(sweep);
      const { gap } = sweep;
      const inconclusive = gap === null && sweep.inconclusive;
      await report(
        gap
          ? `claim ${claimId} omits the event at block ${gap.blockNumber}`
          : inconclusive
            ? `claim ${claimId} contains every event through block ${sweep.sweptThrough}; the rest was not reached`
            : `claim ${claimId} contains every event`,
      );
      const rejectedNote = sweep.rejected.length
        ? `\n${sweep.rejected.length} endpoint(s) rejected: ${sweep.rejected.map((x) => `${x.url} ${x.why}`).join('; ')}`
        : '';
      const provenance =
        `union of ${sweep.events} event(s) from ${sweep.vouched}/${sweep.attempted} endpoint(s) that saw everything ` +
        `(${sweep.perSource.join(', ')}), on ${sweep.chainName} confirmed by chain id${rejectedNote}`;
      const bondCTC = formatEther(c.bondPosted);
      const next = refutable
        ? `One proof of that event takes half the ${bondCTC} CTC bond: call refute_claim.`
        : `The claim is ${status}, so nothing can be done about it now.`;
      const text = gap
        ? `INCOMPLETE: claim ${claimId} does not contain the event at source block ${gap.blockNumber}, ` +
          `tx #${gap.txIndex}, log #${gap.logIndexInTx} (ordering key ${eventKey(gap)}).\n${provenance}\n${next}`
        : inconclusive
          ? `INCONCLUSIVE: the ${Math.round((budgetMs ?? 0) / 1000)}s budget ran out after source blocks ` +
            `${c.fromBlock}..${sweep.sweptThrough} of ${c.fromBlock}..${c.toBlock}. Every event found in that part ` +
            `is in the claim; blocks ${sweep.sweptThrough + 1}..${c.toBlock} were not looked at, so nothing is ` +
            `concluded about them.\n${provenance}\nA sweep with no budget covers the whole range: run \`npx -y utuh-mcp\`.`
          : `complete as far as these endpoints saw: every swept event is in the claim.\n${provenance}\n` +
            `"No gap found" is only as strong as the endpoints that looked; it is provenance, not proof.`;
      return answer(text, {
        deployment,
        claimId,
        status,
        refutable,
        bondCTC,
        complete: gap === null && !inconclusive,
        inconclusive,
        sweptThrough: sweep.sweptThrough,
        omitted: gap ? omittedJson(gap) : null,
        provenance: {
          events: sweep.events,
          vouched: sweep.vouched,
          attempted: sweep.attempted,
          perSource: sweep.perSource,
          chain: sweep.chainName,
          rejected: sweep.rejected,
        },
      });
    },
  );

  server.registerTool(
    'refute_claim',
    {
      title: remote ? 'Build the transaction that refutes a claim' : 'Refute an incomplete claim',
      description: remote
        ? 'Prove one omitted in-scope event through the Proof Builder and return the unsigned transaction ' +
          'that breaks the claim: the registry address, calldata carrying the real proof, the chain id ' +
          'and a gas limit. This server holds no key and sends nothing — whoever signs it from their own ' +
          'wallet on Creditcoin CC3 Testnet is paid half the bond. The call is checked with eth_call ' +
          'first, and wouldRevert says why the registry would reject it if it would.'
        : 'Prove one omitted in-scope event through the Block Prover precompile and break the claim. ' +
          'Sends a real transaction on Creditcoin CC3 Testnet and pays the caller half the bond. ' +
          'Requires PRIVATE_KEY in the environment with a little CTC for gas. Answers with sent: false ' +
          'and a reason whenever it did not send.',
      inputSchema: {
        deployment: DEPLOYMENT,
        claimId: z.number().int().positive(),
        confirm: z
          .boolean()
          .default(false)
          .describe(
            remote
              ? 'Not needed here: this server never sends. Accepted so one call shape works on both transports.'
              : 'Must be true. This sends an irreversible transaction that slashes a real bond.',
          ),
        from: z
          .string()
          .regex(/^0x[0-9a-fA-F]{40}$/)
          .optional()
          .describe(
            remote
              ? 'The address that will sign. The eth_call check and the gas estimate run as it; omit to run them from no address.'
              : 'Not used on stdio: the transaction is sent from PRIVATE_KEY.',
          ),
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
        transaction: z
          .object({
            to: z.string().describe('The registry'),
            data: z.string().describe('refute(claimId, proof, continuity), ABI-encoded'),
            value: z.string().describe('Wei, decimal; always 0'),
            chainId: z.number().int().describe('Creditcoin CC3 Testnet'),
            gas: z.string().nullable().describe('Gas limit, decimal; null when the call would revert'),
            gasSource: z
              .enum(['eth_estimateGas', 'model'])
              .nullable()
              .describe('"model" when the node refused to estimate a call eth_call accepts — a known pallet-evm gap'),
          })
          .nullable()
          .describe('Over HTTP, the unsigned transaction for your own wallet; always null on stdio, which sends'),
        wouldRevert: z
          .string()
          .nullable()
          .describe('The registry error eth_call returns for this transaction now; null when it would go through'),
      },
      // The one tool that spends. `destructiveHint` is not decoration here: a refutation burns half
      // of somebody's bond and marks their claim broken for good, and a client that surfaces a
      // confirmation for exactly one of these five tools should surface it for this one. It is not
      // idempotent either — the second call against a refuted claim reverts.
      //
      // Over HTTP it spends nothing: it proves and encodes, and the signature that would spend is the
      // caller's, in a wallet that asks them itself. Read-only is the honest annotation there.
      annotations: remote
        ? LOOKING
        : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ deployment, claimId, confirm, from }, extra) => {
      const nothing = { txHash: null, rewardCTC: null, refuter: null, transaction: null, wouldRevert: null };
      const notSent = (reason: string, omitted: ScopedEvent | null = null) =>
        answer(reason, {
          deployment,
          claimId,
          sent: false,
          reason,
          omitted: omitted ? omittedJson(omitted) : null,
          ...nothing,
        });

      if (remote) {
        const start = Date.now();
        const budget = budgetMs ?? Infinity;
        const report = reporter(server, extra);
        const r = registryFor(deployment);
        const c = await r.claim(claimId);
        const status = claimStatus(c.status);
        if (status === 'None') return refuse(`there is no claim ${claimId} on the ${deployment} deployment`);
        if (status === 'Open')
          return notSent(`claim ${claimId} is still Open — nothing to refute until it is sealed`);
        const scope: Scope = toScope(c.scope);
        // Half the budget to find the gap, the rest to prove it. A gap with no proof is still a
        // finding, and sweep_claim is the tool that reports one.
        await report(`sweeping claim ${claimId} on ${deployment} for an omission to prove`);
        const sweep = await sweepClaim(
          r,
          claimId,
          scope,
          Number(c.fromBlock),
          Number(c.toBlock),
          start + budget / 2,
          report,
        );
        if (typeof sweep === 'string') return refuse(sweep);
        const gap = sweep.gap;
        if (!gap) {
          return notSent(
            sweep.inconclusive
              ? `Nothing built: the sweep's share of the budget ran out at source block ${sweep.sweptThrough} of ` +
                  `${c.toBlock} without finding an omission, so there is nothing to prove yet. Run sweep_claim, or ` +
                  '`npx -y utuh-mcp` locally for a sweep with no budget.'
              : `Nothing built: no omission found in claim ${claimId}, and a refutation without one would only revert.`,
          );
        }
        await report(`claim ${claimId} omits the event at block ${gap.blockNumber}; asking for its proof`);
        const prover = Prover.withDefaults(scope.chainKey);
        let proven;
        try {
          proven = await withDeadline(Math.max(1, start + budget - Date.now()), prover.proveOne(gap));
        } catch (e) {
          return notSent(
            `Nothing built: claim ${claimId} omits the event at source block ${gap.blockNumber}, but its proof ` +
              `could not be had in time (${e instanceof Error ? e.message : String(e)}). Call again.`,
            gap,
          );
        } finally {
          prover.close();
        }
        const to = registryAddress(deployment);
        const data = r.interface.encodeFunctionData('refute', [claimId, proven.proof, proven.continuity]);
        const call = { to, data, ...(from ? { from } : {}) };
        // The order `sendChecked` uses, for the same reason: eth_call settles whether the call would
        // go through, and only then is a gas limit worth anything. pallet-evm can refuse to estimate
        // a call that reaches a precompile and would succeed, so a refusal after a clean eth_call
        // gets the measured model rather than no number.
        let wouldRevert: string | null = null;
        let gas: bigint | null = null;
        let gasSource: 'eth_estimateGas' | 'model' | null = null;
        try {
          await provider.call(call);
          try {
            gas = await provider.estimateGas(call);
            gasSource = 'eth_estimateGas';
          } catch {
            gas = modelledGas(data, 0);
            gasSource = 'model';
          }
        } catch (e: any) {
          const decoded = typeof e?.data === 'string' ? r.interface.parseError(e.data) : null;
          wouldRevert = decoded?.name ?? String(e?.shortMessage ?? e?.message ?? e);
        }
        await report(
          wouldRevert
            ? `eth_call: the registry would reject it with ${wouldRevert}`
            : `eth_call accepts it; gas ${gas}`,
        );
        const bondCTC = formatEther(c.bondPosted);
        const text =
          'Nothing was sent: this server holds no key. ' +
          (wouldRevert
            ? `The transaction below proves the event at source block ${gap.blockNumber} that claim ${claimId} ` +
              `omits, but the registry would reject it now with ${wouldRevert} (the claim is ${status}) — do not sign it.`
            : `Sign and send the transaction below from your own wallet on Creditcoin CC3 Testnet (chain id ` +
              `${CC3_CHAIN_ID}). It proves the event at source block ${gap.blockNumber}, tx #${gap.txIndex}, ` +
              `log #${gap.logIndexInTx} that claim ${claimId} omits, breaks the claim, and pays half the ` +
              `${bondCTC} CTC bond to the sender. It is irreversible.`) +
          `\nto: ${to}\nchainId: ${CC3_CHAIN_ID}\ngas: ${gas ?? '—'}${gasSource ? ` (${gasSource})` : ''}\ndata: ${data}`;
        return answer(text, {
          deployment,
          claimId,
          sent: false,
          reason: wouldRevert
            ? `the registry would reject it: ${wouldRevert}`
            : 'this server holds no key; the transaction is for your own wallet to sign',
          omitted: omittedJson(gap),
          ...nothing,
          transaction: {
            to,
            data,
            value: '0',
            chainId: CC3_CHAIN_ID,
            gas: gas === null ? null : gas.toString(),
            gasSource,
          },
          wouldRevert,
        });
      }

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
      const report = reporter(server, extra);
      const wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
      const r = new Contract(registryAddress(deployment), registryArtifact.abi, wallet);
      const c = await r.claim(claimId);
      if (claimStatus(c.status) !== 'Sealed') {
        return notSent(`claim ${claimId} is ${claimStatus(c.status)} — nothing to refute`);
      }
      const scope: Scope = toScope(c.scope);
      await report(`sweeping claim ${claimId} on ${deployment} before spending anything`);
      const sweep = await sweepClaim(r, claimId, scope, Number(c.fromBlock), Number(c.toBlock), Infinity, report);
      if (typeof sweep === 'string') return notSent(sweep);
      const gap = sweep.gap;
      if (!gap) {
        return notSent(`no omission found in claim ${claimId} — a refutation without one would only cost gas`);
      }
      await report(
        `claim ${claimId} omits the event at block ${gap.blockNumber}; proving it through the Block Prover`,
      );
      const prover = Prover.withDefaults(scope.chainKey);
      const done = await refuteClaim(r, prover, BigInt(claimId), gap, report).finally(() => prover.close());
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
          txHash: done.txHash,
          rewardCTC,
          refuter: wallet.address,
          transaction: null,
          wouldRevert: null,
        },
      );
    },
  );

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
      const report = reporter(server, extra, 3);
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
              'verdict in "complete", the gap in "omitted", and the endpoint counts in "provenance".' +
              (remote
                ? ' If "inconclusive" is true the sweep ran out of time: report how far it got, not a verdict.'
                : '') +
              '\n3. Treat an omission as a finding, not a verdict: report the omitted event, the claim it ' +
              'belongs to, and the bond at stake. Treat "complete" as provenance — it is only as ' +
              'strong as the number of endpoints that vouched, which the result tells you.\n' +
              (remote
                ? '4. Do not call refute_claim. Here it only builds an unsigned transaction, but signing one ' +
                  "slashes a real bond and whether to is the person's call — the weigh_a_refutation prompt is for that.\n\n"
                : '4. Do not call refute_claim. It sends a real transaction that slashes a real bond; bring the ' +
                  'finding back and let the person decide — the weigh_a_refutation prompt is for that.\n\n') +
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
        (remote
          ? 'and pay, and build the transaction for your wallet only on an explicit yes.'
          : 'and pay, and send it only on an explicit yes.'),
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
              (remote
                ? '4. Ask me, in one sentence, whether to build the transaction, and which address I will sign ' +
                  'from. Do not call refute_claim until I have answered yes in my own words; "proceed if it ' +
                  'looks fine" is not a yes.\n' +
                  '5. On a yes, call refute_claim with from set to my address. This server holds no key and ' +
                  'sends nothing: it returns the unsigned transaction. If "wouldRevert" is set, report it and ' +
                  'stop. Otherwise give me "to", "data", "chainId" and "gas" to sign in my own wallet, and say ' +
                  'plainly that sending it is irreversible.'
                : '4. Ask me, in one sentence, whether to send it. Do not call refute_claim until I have answered ' +
                  'yes in my own words; "proceed if it looks fine" is not a yes.\n' +
                  '5. On a yes, call refute_claim with confirm: true. If it answers sent: false, report the ' +
                  'reason and stop. If it sent, report the transaction hash, the reward, and the address paid.'),
          },
        },
      ],
    }),
  );

  return server;
}

interface Sweep {
  chainName: string;
  rejected: { url: string; why: string }[];
  /// The first in-scope event the claim does not contain, among those swept.
  gap: ScopedEvent | null;
  events: number;
  vouched: number;
  attempted: number;
  perSource: string[];
  sweptThrough: number;
  /// The deadline stopped the sweep before `toBlock`.
  inconclusive: boolean;
}

/// Sweep a claim's range for the first event it omits, stopping at a deadline if one is set.
///
/// With no deadline this is one union sweep of the whole range, as it always was. With one, the range
/// is swept in windows and each window is checked against the claim before the next begins, so a
/// budget that runs out leaves a real partial answer — every block through `sweptThrough` looked at,
/// and any gap found is a gap — rather than a request the platform killed. A window the deadline cut
/// into does not count as swept: an endpoint it cut off has said nothing about that window.
///
/// Provenance stays exact across windows. The windows are disjoint, so an endpoint saw everything in
/// the whole union exactly when it saw everything in every window. `perSource` has one entry per
/// endpoint, in the order they were asked, which is how the windows' entries are matched up.
///
/// A string return is the reason nothing could be swept at all.
async function sweepClaim(
  r: Contract,
  claimId: number,
  scope: Scope,
  fromBlock: number,
  toBlock: number,
  deadline: number,
  report: (message: string) => Promise<void>,
): Promise<Sweep | string> {
  // The same guard the browser and the daemon apply, for the same reason: an endpoint serving
  // another chain returns no in-scope logs, and no logs reads exactly like a complete claim.
  const { chain, usable, rejected } = await confirmEndpoints(provider, scope.chainKey, sources(scope.chainKey));
  const chainName = chain?.name ?? `chain key ${scope.chainKey}`;
  if (usable.length === 0) {
    return `every endpoint is serving some chain other than ${chainName} — nothing can be concluded about claim ${claimId}`;
  }
  await report(`${usable.length} endpoint(s) confirmed serving ${chainName}, ${rejected.length} rejected`);

  const urls = usable.map((u) => u.url);
  // `scanScopeUnion` destroys the providers it is handed, so each window after the first gets new
  // ones for the same endpoints, in the same order.
  const again = () => {
    const all = sources(scope.chainKey);
    for (const s of all) if (!urls.includes(s.url)) s.provider.destroy();
    return urls.map((url) => all.find((s) => s.url === url)!);
  };
  const chunk = SWEEP_CHUNK[requireChainKey(scope.chainKey)];
  const bounded = Number.isFinite(deadline);
  // ponytail: four chunks per window. A window is the unit a budget can lose, so a narrower one
  // loses less work to the deadline at the cost of more round trips.
  const span = bounded ? chunk * 4 : toBlock - fromBlock + 1;
  const tallies = urls.map(() => ({ host: '', seen: 0, err: false, all: true }));
  let events = 0;
  let gap: ScopedEvent | null = null;
  let sweptThrough = fromBlock - 1;

  for (let lo = fromBlock; lo <= toBlock && gap === null && Date.now() < deadline; lo += span) {
    const hi = Math.min(toBlock, lo + span - 1);
    const w = await scanScopeUnion(
      lo === fromBlock ? usable : again(),
      scope,
      lo,
      hi,
      chunk,
      bounded ? (work) => withDeadline(Math.max(1, deadline - Date.now()), work) : undefined,
    );
    // An event found is real whether or not its window finished, and one the claim lacks is a gap.
    gap = await findOmission(r, BigInt(claimId), w.events);
    if (bounded && Date.now() >= deadline && w.perSource.some((p) => p.endsWith('=err'))) break;
    sweptThrough = hi;
    events += w.events.length;
    w.perSource.forEach((p, i) => {
      const t = tallies[i]!;
      const at = p.lastIndexOf('=');
      const count = p.slice(at + 1);
      t.host = p.slice(0, at);
      if (count === 'err') t.err = true;
      else t.seen += Number(count);
      if (Number(count) !== w.events.length) t.all = false;
    });
  }
  const swept = sweptThrough >= fromBlock;
  const vouched = swept ? tallies.filter((t) => t.all && !t.err).length : 0;
  await report(
    `${events} in-scope event(s) in the union, ${vouched}/${urls.length} vouched` +
      (sweptThrough < toBlock ? `, through block ${sweptThrough} of ${toBlock} when the budget ran out` : ''),
  );
  return {
    chainName,
    rejected: rejected.map((x) => ({ url: x.url, why: x.why ?? x.verdict })),
    gap,
    events,
    vouched,
    attempted: urls.length,
    perSource: swept ? tallies.map((t) => `${t.host}=${t.err ? 'err' : t.seen}`) : [],
    sweptThrough,
    inconclusive: sweptThrough < toBlock,
  };
}

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

type Tally = z.infer<z.ZodObject<typeof TALLY>>;

/// How long one read of the tally is served again. The tally reads every claim on both registries —
/// a hundred-odd `claim` and `memberCount` calls — and a remote endpoint answers whoever asks, so
/// without this every client that polls it spends the public RPC's rate limit on numbers that change
/// a few times a day. Concurrent callers share the read in flight. A failed read is not kept.
///
/// ponytail: per process. A warm serverless instance reuses it and a cold one reads afresh; a shared
/// store is the upgrade if cold starts ever dominate the traffic.
const TALLY_TTL_MS = 60_000;
let tallyMemo: { at: number; value: Promise<Tally> } | undefined;

/// The four numbers, shared by the `tally` tool and the `utuh://tally` resource.
function tally(): Promise<Tally> {
  if (tallyMemo && Date.now() - tallyMemo.at < TALLY_TTL_MS) return tallyMemo.value;
  const memo = { at: Date.now(), value: readTally() };
  tallyMemo = memo;
  memo.value.catch(() => {
    if (tallyMemo === memo) tallyMemo = undefined;
  });
  return memo.value;
}

async function readTally(): Promise<Tally> {
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
  // stdout is the protocol channel. One stray print — and the SDK's attestation waiter does print —
  // is a corrupted JSON-RPC stream, so everything chatty is rerouted to stderr before connecting.
  console.log = (...a: unknown[]) => console.error(...a);
  console.info = (...a: unknown[]) => console.error(...a);
  console.warn = (...a: unknown[]) => console.error(...a);
  await createServer({ transport: 'stdio' }).connect(new StdioServerTransport());
  console.error(
    'utuh mcp server on stdio — tools: tally, list_claims, sweep_claim, refute_claim, audit_attestors; ' +
      'resources: utuh://tally, utuh://claims/{deployment}, utuh://claim/{deployment}/{claimId}; ' +
      'prompts: hold_the_watcher_role, weigh_a_refutation',
  );
  // A stdio server lives until its client hangs up; resolving here would let runScript exit.
  await new Promise<never>(() => {});
}

// Only as the entry point. `api/mcp.ts` imports `createServer` from here, and a script that calls
// runScript at load runs when imported — the stdio server would start inside the HTTP function.
if (require.main === module) runScript(main);
