import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Contract, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, sources } from './config';
import { ATTESTATION_INDEXERS, CHAIN_KEY, type DeploymentName } from './lib/networks';
// Imported rather than read at runtime, so `npm run mcp:package` can bake them into a bundle that
// runs from `npx utuh-mcp` with no repository, no forge artifacts and no cwd to read from. Under
// tsx these imports read the same files the old readFileSync did.
import registryArtifact from '../out/UtuhRegistry.sol/UtuhRegistry.json';
import sepoliaRecord from '../deployments.full.json';
import mainnetRecord from '../deployments.json';
import { scanScopeUnion, eventKey, type Scope } from './lib/scope';
import { toScope } from './lib/specs';
import { Prover } from './lib/proofs';
import { findOmission, refuteClaim } from './lib/claims';
import { recentAttestations } from './lib/attestations';
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

/// stdout is the protocol channel. One stray print — and the SDK's attestation waiter does print —
/// is a corrupted JSON-RPC stream, so everything chatty is rerouted to stderr up front.
console.log = (...a: unknown[]) => console.error(...a);
console.info = (...a: unknown[]) => console.error(...a);
console.warn = (...a: unknown[]) => console.error(...a);

const provider = new JsonRpcProvider(CC3_RPC, CC3_CHAIN_ID, { staticNetwork: true });

const DEPLOYMENT = z
  .enum(['sepolia', 'mainnet'])
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

const server = new McpServer({ name: 'utuh', version: '0.1.0' });

server.registerTool(
  'tally',
  {
    title: 'What the registries have done',
    description:
      'The four numbers across both deployments: events proven into claims, claims sealed, claims ' +
      'broken by a refutation, and bond slashed. Read live from Creditcoin CC3 Testnet.',
    inputSchema: {},
  },
  async () => {
    let proven = 0n;
    let sealed = 0;
    let refuted = 0;
    let burned = 0n;
    for (const which of Object.keys(RECORDS) as DeploymentName[]) {
      const r = registryFor(which);
      const total = Number(await r.nextClaimId()) - 1;
      sealed += total;
      burned += (await r.burned()) as bigint;
      for (let i = 1; i <= total; i++) {
        proven += (await r.memberCount(i)) as bigint;
        if (claimStatus((await r.claim(i)).status) === 'Refuted') refuted++;
      }
    }
    return {
      content: [
        {
          type: 'text',
          text:
            `events proven into claims: ${proven}\nclaims sealed: ${sealed}\n` +
            `claims broken by a refutation: ${refuted}\nbond slashed: ${formatEther(burned)} CTC`,
        },
      ],
    };
  },
);

server.registerTool(
  'list_claims',
  {
    title: 'List claims',
    description:
      'Every claim on a deployment with its status, member count, bond, and — for sealed ones — ' +
      'how many Creditcoin blocks remain in the challenge window. Sealed claims are the ones a ' +
      'watcher can still act on.',
    inputSchema: { deployment: DEPLOYMENT },
  },
  async ({ deployment }) => {
    const r = registryFor(deployment);
    const head = await provider.getBlockNumber();
    const total = Number(await r.nextClaimId()) - 1;
    const lines: string[] = [];
    for (let i = 1; i <= total; i++) {
      const c = await r.claim(i);
      const status = claimStatus(c.status);
      const until = Number(c.sealedAt) + Number(c.challengeWindow);
      const window = status === 'Sealed' ? (until > head ? `${until - head} blocks left` : 'window closed') : '—';
      lines.push(
        `claim ${i}: ${status}, ${await r.memberCount(i)} member(s), ` +
          `source ${c.fromBlock}..${c.toBlock}, bond ${formatEther(c.bondPosted)} CTC, ${window}`,
      );
    }
    return { content: [{ type: 'text', text: lines.join('\n') || 'no claims yet' }] };
  },
);

server.registerTool(
  'sweep_claim',
  {
    title: 'Sweep a claim for completeness',
    description:
      'Sweep the source chain across independent endpoints for every in-scope event in a sealed ' +
      "claim's range, take the union, and check each event against the claim on-chain. Needs no " +
      'key and spends nothing. Reports COMPLETE with provenance, or INCOMPLETE with the omitted ' +
      'event — which refute_claim can then prove.',
    inputSchema: { deployment: DEPLOYMENT, claimId: z.number().int().positive() },
  },
  async ({ deployment, claimId }) => {
    const r = registryFor(deployment);
    const c = await r.claim(claimId);
    const status = claimStatus(c.status);
    if (status !== 'Sealed') {
      return {
        content: [{ type: 'text', text: `claim ${claimId} is ${status} — only a Sealed claim can be swept` }],
      };
    }
    const scope: Scope = toScope(c.scope);
    const sweep = await scanScopeUnion(sources(scope.chainKey), scope, Number(c.fromBlock), Number(c.toBlock));
    const gap = await findOmission(r, BigInt(claimId), sweep.events);
    const provenance = `union of ${sweep.events.length} event(s) from ${sweep.vouched}/${sweep.attempted} endpoint(s) that saw everything (${sweep.perSource.join(', ')})`;
    const text = gap
      ? `INCOMPLETE: claim ${claimId} does not contain the event at source block ${gap.blockNumber}, ` +
        `tx #${gap.txIndex}, log #${gap.logIndexInTx} (ordering key ${eventKey(gap)}).\n${provenance}\n` +
        `One proof of that event takes half the ${formatEther(c.bondPosted)} CTC bond: call refute_claim.`
      : `complete as far as these endpoints saw: every swept event is in the claim.\n${provenance}\n` +
        `"No gap found" is only as strong as the endpoints that looked; it is provenance, not proof.`;
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'refute_claim',
  {
    title: 'Refute an incomplete claim',
    description:
      'Prove one omitted in-scope event through the Block Prover precompile and break the claim. ' +
      'Sends a real transaction on Creditcoin CC3 Testnet and pays the caller half the bond. ' +
      'Requires PRIVATE_KEY in the environment with a little CTC for gas.',
    inputSchema: {
      deployment: DEPLOYMENT,
      claimId: z.number().int().positive(),
      confirm: z
        .boolean()
        .default(false)
        .describe('Must be true. This sends an irreversible transaction that slashes a real bond.'),
    },
  },
  async ({ deployment, claimId, confirm }) => {
    // The guard is structural, not environmental. The first client ever pointed at this server
    // refuted a standing claim during its own smoke test, because the key it was not supposed to
    // have arrived through dotenv instead of the environment the transport had stripped. An
    // agent's "let me just try the tool" must cost a deliberate second call, not a bond.
    if (!confirm) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Not sent. Refuting claim ${claimId} is an irreversible on-chain transaction: it ` +
              'proves the omitted event through the Block Prover, slashes the bond, and pays half ' +
              'to the caller. Call again with confirm: true to proceed, or use sweep_claim first ' +
              'to see what would be proven.',
          },
        ],
      };
    }
    const key = process.env.PRIVATE_KEY;
    if (!key) {
      return {
        content: [
          {
            type: 'text',
            text:
              'No PRIVATE_KEY in the environment. Sweeping is free, but a refutation is a real ' +
              'transaction: set PRIVATE_KEY to a funded CC3 testnet key (faucet: Creditcoin ' +
              'Discord #token-faucet) and call this again.',
          },
        ],
      };
    }
    const wallet = new Wallet(key.startsWith('0x') ? key : `0x${key}`, provider);
    const r = new Contract(registryAddress(deployment), registryArtifact.abi, wallet);
    const c = await r.claim(claimId);
    if (claimStatus(c.status) !== 'Sealed') {
      return {
        content: [{ type: 'text', text: `claim ${claimId} is ${claimStatus(c.status)} — nothing to refute` }],
      };
    }
    const scope: Scope = toScope(c.scope);
    const sweep = await scanScopeUnion(sources(scope.chainKey), scope, Number(c.fromBlock), Number(c.toBlock));
    const gap = await findOmission(r, BigInt(claimId), sweep.events);
    if (!gap) {
      return {
        content: [
          {
            type: 'text',
            text: `no omission found in claim ${claimId} — a refutation without one would only cost gas`,
          },
        ],
      };
    }
    const prover = Prover.withDefaults(scope.chainKey);
    const { reward, key: omittedKey } = await refuteClaim(r, prover, BigInt(claimId), gap, (m) => console.error(m));
    return {
      content: [
        {
          type: 'text',
          text:
            `claim ${claimId} refuted with the event at source block ${gap.blockNumber} ` +
            `(ordering key ${omittedKey}). Reward: ${formatEther(reward)} CTC to ${wallet.address}.`,
        },
      ],
    };
  },
);

server.registerTool(
  'audit_attestors',
  {
    title: "Audit Creditcoin's attestors",
    description:
      'Ask both Creditcoin networks (CC3 Testnet and Creditcoin Mainnet) what header hashes their ' +
      'attestors signed for recent Ethereum blocks, then check each against independent Ethereum ' +
      'endpoints. A MISMATCH would mean attestors signed a block Ethereum does not have.',
    inputSchema: {},
  },
  async () => {
    const out: string[] = [];
    for (const [label, indexer, chainKey] of [
      ['CC3 Testnet', ATTESTATION_INDEXERS.testnet, CHAIN_KEY.mainnet],
      ['Creditcoin Mainnet', ATTESTATION_INDEXERS.mainnet, ATTESTATION_INDEXERS.mainnet.ethereumKey],
    ] as const) {
      const { total, nodes } = await recentAttestations(indexer, chainKey, 4);
      out.push(`${label}: ${total.toLocaleString()} attestations of Ethereum indexed (chain key ${chainKey})`);
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
        out.push(
          `  block ${a.headerNumber}: ${
            seen.length === 0
              ? 'no endpoint answered'
              : agree === seen.length
                ? `matches ${agree}/${seen.length}`
                : `MISMATCH ${agree}/${seen.length}`
          }`,
        );
      }
    }
    return { content: [{ type: 'text', text: out.join('\n') }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error('utuh mcp server on stdio — tools: tally, list_claims, sweep_claim, refute_claim, audit_attestors');
  // A stdio server lives until its client hangs up; resolving here would let runScript exit.
  await new Promise<never>(() => {});
}

runScript(main);
