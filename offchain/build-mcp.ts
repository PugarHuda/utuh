import { build } from 'esbuild';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/// Package the MCP watcher so `npx utuh-mcp` is the whole install.
///
/// `npm run mcp` already puts the watcher behind the Model Context Protocol, but it asks for a
/// cloned repository, an `npm install` and forge artifacts first — which is a checkout, and the
/// whole point of the watcher role is that holding it costs nothing. This bundles `offchain/mcp.ts`
/// and everything it imports — the registry ABI and both deployment records included, which is why
/// mcp.ts imports them instead of reading files — into one node script with no dependencies, plus
/// the package.json, README and LICENSE that make it publishable.
///
///   npm run mcp:package        # writes dist-mcp/
///   cd dist-mcp && npm publish # the deliberate, human step
///
/// The version is the repository's own, so a republish is a visible bump rather than a silent
/// overwrite — npm would refuse the overwrite anyway.

import { version } from '../package.json';

const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist-mcp');

async function main(): Promise<void> {
  mkdirSync(DIST, { recursive: true });

  await build({
    entryPoints: [join(ROOT, 'offchain', 'mcp.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: join(DIST, 'utuh-mcp.cjs'),
    banner: { js: '#!/usr/bin/env node' },
    logLevel: 'warning',
  });

  writeFileSync(
    join(DIST, 'package.json'),
    JSON.stringify(
      {
        name: 'utuh-mcp',
        version,
        // The MCP Registry's ownership check for npm packages: it fetches the published tarball and
        // requires this field to equal the server name being claimed. Without it the registry
        // refuses the publish with "Registry validation failed for package", and with it nobody
        // else can claim `io.github.PugarHuda/utuh-mcp` — the npm package is the proof.
        mcpName: 'io.github.PugarHuda/utuh-mcp',
        description:
          'The Utuh watcher as an MCP server: sweep bonded completeness claims on Creditcoin CC3 ' +
          'Testnet against Ethereum, and refute an incomplete one for half its bond. Five tools, ' +
          'no account, no server — an AI agent can hold the watcher role.',
        bin: { 'utuh-mcp': './utuh-mcp.cjs' },
        license: 'MIT',
        repository: { type: 'git', url: 'git+https://github.com/PugarHuda/utuh.git' },
        homepage: 'https://utuh.vercel.app/',
        // The two spellings the directories that crawl npm key on (Glama, mcp.so, PulseMCP, LobeHub)
        // are `mcp-server` and `modelcontextprotocol`; none of them listed the package without.
        keywords: [
          'mcp',
          'mcp-server',
          'model-context-protocol',
          'modelcontextprotocol',
          'creditcoin',
          'attestcoin',
          'ethereum',
          'blockchain',
          'ai-agent',
          'watcher',
          'completeness',
        ],
        engines: { node: '>=20' },
      },
      null,
      2,
    ) + '\n',
  );

  copyFileSync(join(ROOT, 'LICENSE'), join(DIST, 'LICENSE'));

  writeFileSync(
    join(DIST, 'README.md'),
    `# utuh-mcp

The [Utuh](https://github.com/PugarHuda/utuh) watcher as a Model Context Protocol server, so an
AI agent can hold the role. Utuh bonds the claim that a set of source-chain events is complete;
anyone who proves one omitted event takes half the bond. This server is the "anyone".

## Connect a client

No clone, no key, no build: every client below runs \`npx -y utuh-mcp\` and gets the same server.
Add \`"env": { "PRIVATE_KEY": "0x…" }\` to the entry only if you want \`refute_claim\` to be able to
send; the other four tools read the chain and spend nothing.

**Claude Desktop** — \`claude_desktop_config.json\` (Settings → Developer → Edit Config), or install
\`utuh-mcp.mcpb\` from the [releases](https://github.com/PugarHuda/utuh/releases) with one click:

\`\`\`json
{ "mcpServers": { "utuh": { "command": "npx", "args": ["-y", "utuh-mcp"] } } }
\`\`\`

**Claude Code**:

\`\`\`bash
claude mcp add utuh -- npx -y utuh-mcp
\`\`\`

**Cursor** — \`.cursor/mcp.json\` in the project, or \`~/.cursor/mcp.json\` for every project:

\`\`\`json
{ "mcpServers": { "utuh": { "command": "npx", "args": ["-y", "utuh-mcp"] } } }
\`\`\`

**VS Code** — \`.vscode/mcp.json\` in the workspace (Copilot agent mode):

\`\`\`json
{ "servers": { "utuh": { "type": "stdio", "command": "npx", "args": ["-y", "utuh-mcp"] } } }
\`\`\`

**Any other client** — it is a stdio server: run \`npx -y utuh-mcp\` and speak JSON-RPC on its
stdin and stdout. It is listed in the official MCP Registry as \`io.github.PugarHuda/utuh-mcp\`.

## What it serves

Five tools, each the same function the daemon and the [live console](https://utuh.vercel.app/) run:

- **tally** — what both registries have done, read live from Creditcoin CC3 Testnet
- **list_claims** — a page of claims with status, bond, and remaining challenge window; pass the
  returned \`nextCursor\` for the next page
- **sweep_claim** — sweep Ethereum across independent endpoints and check a claim's completeness
- **refute_claim** — prove one omitted event and take half the bond (needs \`confirm: true\` and a
  funded \`PRIVATE_KEY\` — everything else needs no key and spends nothing)
- **audit_attestors** — check what Creditcoin's attestors signed three ways: against Ethereum
  itself, against each network's own ChainInfo digest index, and against the other Creditcoin
  network. Both networks attest Ethereum mainnet from disjoint attestor sets, and the tool reports
  whether their digests for the same block agree

Every tool answers in prose and as \`structuredContent\` validated against its \`outputSchema\`, so
a client can hand the verdict to code. Every tool carries its annotations, so a client knows which
four only read and which one sends a transaction that slashes a real bond. A sweep, an audit and a
refutation report each step as a logging notification and, when the call carried a progress token,
as progress. A failure the caller can act on — no such claim, no usable endpoint — comes back as an
\`isError\` result with an explanation rather than a JSON-RPC error.

Claims are addressable as resources too, so an agent can hold one as context instead of re-reading
a paragraph: \`utuh://tally\`, \`utuh://claims/{deployment}\`, \`utuh://claim/{deployment}/{id}\` —
live JSON, read from the same contracts. The templates list their deployments and complete their
variables, so a picker offers \`sepolia\`, \`mainnet\`, and then the claim ids that exist.

The watcher's job is written down as two prompts: \`hold_the_watcher_role\` sweeps every claim still
inside its window and reports the gaps without spending anything, and \`weigh_a_refutation\` takes
one claim from finding to decision — confirm the gap, lay out the bond and the reward, and send only
on an explicit yes. The server's \`instructions\` at \`initialize\` say the same in five sentences,
for a client that never reads a prompt.

## Privacy Policy

utuh-mcp runs on your machine and keeps nothing. It collects no telemetry and stores no data between
runs. Every tool reads public chain state over JSON-RPC from Creditcoin CC3 Testnet and public
Ethereum endpoints; those endpoints see your IP address and the requests, as any RPC provider does,
and \`sweep_claim\` and \`audit_attestors\` name the endpoints they used in their results. The only
secret it can hold is \`PRIVATE_KEY\`, which you supply, which is read from the environment, never
written anywhere, and used only by \`refute_claim\` after \`confirm: true\`. Nothing is shared with the
authors or any third party. Questions: open an issue at https://github.com/PugarHuda/utuh or use
the contact in that repository's SECURITY.md.

The first MCP client ever connected to this server found the gap in a standing claim and refuted
it — a real slashed bond, during its own smoke test.
`,
  );

  // The same server as an MCP Bundle. `.mcpb` is the format Claude Desktop installs with one
  // click and the one Smithery accepts for a stdio server — npm is not a route into either. The
  // bundle is the bundled script plus a manifest; nothing is built twice.
  const bundle = join(DIST, 'mcpb');
  mkdirSync(join(bundle, 'server'), { recursive: true });
  copyFileSync(join(DIST, 'utuh-mcp.cjs'), join(bundle, 'server', 'utuh-mcp.cjs'));
  writeFileSync(
    join(bundle, 'manifest.json'),
    JSON.stringify(
      {
        manifest_version: '0.3',
        name: 'utuh-mcp',
        display_name: 'Utuh watcher',
        version,
        description:
          'Sweep bonded completeness claims on Creditcoin against Ethereum, and refute one that omits an event.',
        long_description:
          'Utuh bonds the claim that a set of source-chain events is complete; anyone who proves one omitted ' +
          'event takes half the bond. This server is the "anyone". Four tools read and spend nothing; ' +
          'refute_claim sends a real transaction and refuses without confirm: true.',
        author: { name: 'Pugar Huda Mantoro', url: 'https://github.com/PugarHuda' },
        repository: { type: 'git', url: 'https://github.com/PugarHuda/utuh' },
        homepage: 'https://utuh.vercel.app/',
        license: 'MIT',
        // The Claude Connectors Directory rejects a bundle without one. The README ships in the npm
        // tarball, so npm renders it at a URL that outlives any branch.
        privacy_policies: ['https://www.npmjs.com/package/utuh-mcp#privacy-policy'],
        keywords: ['creditcoin', 'attestcoin', 'ethereum', 'watcher', 'completeness', 'credit'],
        server: {
          type: 'node',
          entry_point: 'server/utuh-mcp.cjs',
          mcp_config: {
            command: 'node',
            args: ['${__dirname}/server/utuh-mcp.cjs'],
            env: { PRIVATE_KEY: '${user_config.private_key}' },
          },
        },
        user_config: {
          private_key: {
            type: 'string',
            title: 'Creditcoin CC3 Testnet private key (optional)',
            description:
              'Needed only by refute_claim, which also demands confirm: true. Every other tool reads the chain and spends nothing. Leave empty to hold the role read-only.',
            sensitive: true,
            required: false,
          },
        },
        tools: [
          { name: 'tally', description: 'What both registries have done, read live from Creditcoin' },
          { name: 'list_claims', description: 'A page of claims with status, bond and remaining challenge window' },
          {
            name: 'sweep_claim',
            description: 'Sweep Ethereum across independent endpoints and check a claim for omitted events',
          },
          {
            name: 'refute_claim',
            description: 'Prove one omitted event and take half the bond — sends a transaction, needs confirm',
          },
          { name: 'audit_attestors', description: "Check what Creditcoin's attestors signed, three ways" },
        ],
        // Names must match what the server lists — `mcpTest.ts` compares this file with tools/list
        // and prompts/list over the wire, so a tool added on one side fails the build on the other.
        prompts: [
          {
            name: 'hold_the_watcher_role',
            description: 'The watcher job: sweep every open claim, report gaps, spend nothing',
            arguments: ['deployment'],
            text: 'Hold the Utuh watcher role. List every claim still inside its challenge window on the given deployment, sweep each one, and report any claim whose sweep shows an in-scope event it does not contain, with the claim id, the omitted event, and how many independent endpoints vouched for it. Do not call refute_claim; it sends a real transaction.',
          },
          {
            name: 'weigh_a_refutation',
            description:
              'One claim from finding to decision: confirm the gap, lay out cost and reward, send only on a yes',
            arguments: ['deployment', 'claimId'],
            text: 'Weigh a refutation of the given claim. Read it, sweep it, and if it omits an event lay out the omitted event, the endpoints that vouched, the bond and the half of it paid as reward. Ask whether to send, and call refute_claim with confirm: true only after an explicit yes.',
          },
        ],
        compatibility: {
          claude_desktop: '>=0.10.0',
          platforms: ['darwin', 'win32', 'linux'],
          runtimes: { node: '>=20.0.0' },
        },
      },
      null,
      2,
    ) + '\n',
  );

  // The release is a hand sequence, because npm publish needs a login this repository does not
  // hold: written where the person about to run it is standing.
  writeFileSync(
    join(DIST, 'RELEASE.md'),
    `# Releasing utuh-mcp@${version}

Everything below is checked before it is announced, and nothing is automated past the point where a
login is needed.

1. Version. \`package.json\` at the repository root and \`server.json\` both say \`${version}\`; this
   directory was generated from the former, and \`npm run mcp:test\` asserts the bundle reports it.
   npm refuses to overwrite a published version, so a change to the server is a bump first.
2. Build and prove: \`npm run mcp:test\` — rebuilds this directory and speaks the protocol to the
   bundle, live against Creditcoin. Nothing ships that did not pass.
3. Publish to npm, from here, with your login:
   \`cd dist-mcp && npm publish\`. Then check: \`npm view utuh-mcp version\` prints \`${version}\`.
4. Tag: \`git tag v${version} && git push origin v${version}\`. The tag runs
   \`.github/workflows/mcp-registry.yml\`, which refuses to list a version npm does not serve,
   checks the tarball carries \`mcpName: io.github.PugarHuda/utuh-mcp\`, authenticates to the
   official MCP Registry over GitHub OIDC (no secret to store), publishes \`server.json\`, and reads
   the listing back: \`https://registry.modelcontextprotocol.io/v0/servers?search=io.github.PugarHuda/utuh-mcp\`.
5. Claude Desktop bundle: \`npx -y @anthropic-ai/mcpb pack dist-mcp/mcpb dist-mcp/utuh-mcp.mcpb\`
   and attach \`utuh-mcp.mcpb\` to the GitHub release for \`v${version}\`. The manifest validates with
   \`npx -y @anthropic-ai/mcpb validate dist-mcp/mcpb/manifest.json\`.
6. From a clean cache, the way a judge would: \`npx -y utuh-mcp@${version}\` and send it
   \`initialize\` — it must report \`"version": "${version}"\`.
`,
  );

  console.log(
    `dist-mcp/ written — utuh-mcp@${version}, plus dist-mcp/mcpb/ for \`mcpb pack\` and dist-mcp/RELEASE.md`,
  );
}

void main();
