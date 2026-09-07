import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { version } from '../package.json';
import { runScript } from './lib/cli';

/// The published MCP server, spoken to over the protocol rather than described.
///
///   npm run mcp:test
///
/// `npx utuh-mcp` is a public artifact with a version number and, by now, an entry in the official
/// MCP Registry. Nothing checked it. The bundle is built by esbuild from `offchain/mcp.ts` with the
/// registry ABI and both deployment records baked in, and every one of those is a thing that can
/// quietly stop being included — an import esbuild cannot inline, a JSON file that moved, a tool
/// renamed on one side of a refactor. A client would find out; CI would not.
///
/// So this spawns the *bundle*, not the source, and speaks real JSON-RPC to it on stdin and stdout:
/// initialize, the three listings, a prompt fetched, a resource read live off Creditcoin, and the
/// one tool that spends asked to spend without saying so. No mocks — a mocked MCP client would test
/// the mock.
///
/// It needs no key. `refute_claim` is called deliberately, because the whole point is that it
/// refuses: without `confirm: true` it must answer with an explanation and send nothing.

const ROOT = join(__dirname, '..');
const BUNDLE = join(ROOT, 'dist-mcp', 'utuh-mcp.cjs');

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

interface Rpc {
  id?: number;
  result?: any;
  error?: { message: string };
}

/// A client that keeps one server alive across every request, the way a real one does.
class Client {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private waiting = new Map<number, (r: Rpc) => void>();
  private next = 1;

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    // stderr is the server's log channel by design — it reroutes every stray print there so stdout
    // stays a clean JSON-RPC stream. Reading it keeps the pipe from filling and stalling the child.
    this.child.stderr.on('data', () => {});
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as Rpc;
          if (message.id !== undefined) this.waiting.get(message.id)?.(message);
        } catch {
          // A line stdout should never have carried. The conformance check below is what says so.
          failed++;
          console.log(`  FAIL  the server wrote a non-JSON line to stdout — ${line.slice(0, 80)}`);
        }
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  request(method: string, params: unknown = {}, timeoutMs = 90_000): Promise<Rpc> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} did not answer in ${timeoutMs / 1000}s`)),
        timeoutMs,
      );
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

async function main(): Promise<void> {
  if (!existsSync(BUNDLE)) {
    throw new Error(`no bundle at ${BUNDLE} — run: npm run mcp:package`);
  }
  console.log(`speaking MCP to ${BUNDLE}\n`);
  const client = new Client(process.execPath, [BUNDLE]);

  try {
    const init = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'utuh-mcp-test', version: '1' },
    });
    check('initialize answers', Boolean(init.result), init.error?.message);
    check('the server names itself utuh', init.result?.serverInfo?.name === 'utuh');
    check(
      `it reports the version it was built from (${version})`,
      init.result?.serverInfo?.version === version,
      `got ${init.result?.serverInfo?.version}`,
    );
    for (const capability of ['tools', 'resources', 'prompts']) {
      check(`it offers ${capability}`, Boolean(init.result?.capabilities?.[capability]));
    }
    client.notify('notifications/initialized');

    const tools = (await client.request('tools/list')).result?.tools ?? [];
    const names = tools.map((t: any) => t.name).sort();
    check(
      'all five tools are listed',
      JSON.stringify(names) ===
        JSON.stringify(['audit_attestors', 'list_claims', 'refute_claim', 'sweep_claim', 'tally']),
      names.join(', '),
    );
    // The annotations are the difference between a client asking for confirmation on the right tool
    // and asking on all five or none.
    for (const t of tools) {
      const a = t.annotations ?? {};
      if (t.name === 'refute_claim') {
        check('refute_claim is annotated as writing', a.readOnlyHint === false && a.destructiveHint === true);
        check('and as not repeatable', a.idempotentHint === false);
      } else {
        check(`${t.name} is annotated read-only`, a.readOnlyHint === true && a.destructiveHint === false);
      }
      check(`${t.name} carries an input schema`, typeof t.inputSchema === 'object');
    }

    const resources = (await client.request('resources/list')).result?.resources ?? [];
    check(
      'the tally is addressable as a resource',
      resources.some((r: any) => r.uri === 'utuh://tally'),
      resources.map((r: any) => r.uri).join(', '),
    );
    const templates = (await client.request('resources/templates/list')).result?.resourceTemplates ?? [];
    const uris = templates.map((t: any) => t.uriTemplate).sort();
    check(
      'claims are addressable by deployment and by id',
      JSON.stringify(uris) === JSON.stringify(['utuh://claim/{deployment}/{claimId}', 'utuh://claims/{deployment}']),
      uris.join(', '),
    );

    const prompts = (await client.request('prompts/list')).result?.prompts ?? [];
    check(
      'the watcher role is offered as a prompt',
      prompts.some((p: any) => p.name === 'hold_the_watcher_role'),
      prompts.map((p: any) => p.name).join(', '),
    );
    const got = await client.request('prompts/get', {
      name: 'hold_the_watcher_role',
      arguments: { deployment: 'mainnet' },
    });
    const text = got.result?.messages?.[0]?.content?.text ?? '';
    check('the prompt names the deployment it was asked for', text.includes('mainnet'));
    check('and tells the agent not to spend', /Do not call refute_claim/.test(text));

    // Live: the bundle carries the registry ABI and both deployment records, and this is the only
    // way to find out that it still does. Reads Creditcoin; needs no key.
    const tally = await client.request('resources/read', { uri: 'utuh://tally' });
    const body = tally.result?.contents?.[0];
    check('the tally resource is JSON', body?.mimeType === 'application/json', tally.error?.message);
    let parsed: any = {};
    try {
      parsed = JSON.parse(body?.text ?? '{}');
    } catch {
      /* the check below reports it */
    }
    check(
      'it reads live claims off Creditcoin',
      Number(parsed.claimsSealed) > 0 && Number(parsed.eventsProvenIntoClaims) > 0,
      body?.text?.slice(0, 120),
    );
    check('and counts refutations among them', Number(parsed.claimsRefuted) > 0);

    // The gate on the only tool that spends. Called for real, with confirm withheld: it must
    // explain itself and send nothing. A key is not needed to prove that, which is the point.
    const unconfirmed = await client.request('tools/call', {
      name: 'refute_claim',
      arguments: { deployment: 'mainnet', claimId: 1 },
    });
    const answer = unconfirmed.result?.content?.[0]?.text ?? '';
    check('refute_claim without confirm refuses', /confirm: true/.test(answer), answer.slice(0, 120));
    check('and it is an answer, not an error', unconfirmed.error === undefined);

    const unknown = await client.request('tools/call', { name: 'no_such_tool', arguments: {} });
    check('an unknown tool is an error, not a silence', Boolean(unknown.error) || unknown.result?.isError === true);
  } finally {
    client.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

runScript(main);
