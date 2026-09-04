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
        description:
          'The Utuh watcher as an MCP server: sweep bonded completeness claims on Creditcoin CC3 ' +
          'Testnet against Ethereum, and refute an incomplete one for half its bond. Five tools, ' +
          'no account, no server — an AI agent can hold the watcher role.',
        bin: { 'utuh-mcp': './utuh-mcp.cjs' },
        license: 'MIT',
        repository: { type: 'git', url: 'git+https://github.com/PugarHuda/utuh.git' },
        homepage: 'https://utuh.vercel.app/',
        keywords: ['mcp', 'model-context-protocol', 'creditcoin', 'attestcoin', 'watcher', 'completeness'],
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

\`\`\`json
{ "mcpServers": { "utuh": { "command": "npx", "args": ["-y", "utuh-mcp"] } } }
\`\`\`

Five tools, each the same function the daemon and the [live console](https://utuh.vercel.app/) run:

- **tally** — what both registries have done, read live from Creditcoin CC3 Testnet
- **list_claims** — every claim with its status, bond, and remaining challenge window
- **sweep_claim** — sweep Ethereum across independent endpoints and check a claim's completeness
- **refute_claim** — prove one omitted event and take half the bond (needs \`confirm: true\` and a
  funded \`PRIVATE_KEY\` — everything else needs no key and spends nothing)
- **audit_attestors** — check what Creditcoin's attestors signed against Ethereum itself

The first MCP client ever connected to this server found the gap in a standing claim and refuted
it — a real slashed bond, during its own smoke test.
`,
  );

  console.log(`dist-mcp/ written — utuh-mcp@${version}`);
}

void main();
