import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
/// initialize, the listings, completions, both prompts fetched, resources read live off
/// Creditcoin, a page of claims, a real sweep of a claim the chain already broke — which must find
/// the same gap, and must report each step as a logging and a progress notification while it does —
/// and the one tool that spends asked to spend without saying so. No mocks — a mocked MCP client
/// would test the mock.
///
/// It needs no key. `refute_claim` is called deliberately, because the whole point is that it
/// refuses: without `confirm: true` it must answer with an explanation and send nothing.

const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist-mcp');
const BUNDLE = join(DIST, 'utuh-mcp.cjs');

/// A claim Creditcoin has already refuted, so its omission is a matter of record: sweeping it must
/// find the same gap, every time, with no key and no bond at stake.
const REFUTED = { deployment: 'mainnet', claimId: 1 };

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
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
}

/// A client that keeps one server alive across every request, the way a real one does, and keeps
/// every notification the server sends, the way a real one shows them.
class Client {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private waiting = new Map<number, (r: Rpc) => void>();
  private next = 1;
  private exited: number | null = null;
  readonly notifications: Rpc[] = [];

  constructor(command: string, args: string[]) {
    // No PRIVATE_KEY reaches the server: the refusal checked below must not depend on the machine.
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PRIVATE_KEY: '' } });
    // stderr is the server's log channel by design — it reroutes every stray print there so stdout
    // stays a clean JSON-RPC stream. Reading it keeps the pipe from filling and stalling the child.
    this.child.stderr.on('data', () => {});
    // A server that dies is an answer too; waiting the full timeout for a corpse hides the stack trace.
    this.child.on('exit', (code) => {
      this.exited = code ?? -1;
      for (const settle of this.waiting.values())
        settle({ error: { message: `the server exited with code ${code}` } });
    });
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
          else this.notifications.push(message);
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

  request(method: string, params: unknown = {}, timeoutMs = 120_000): Promise<Rpc> {
    const id = this.next++;
    if (this.exited !== null)
      return Promise.resolve({ error: { message: `the server exited with code ${this.exited}` } });
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

  call(name: string, args: Record<string, unknown>, progressToken?: string): Promise<Rpc> {
    return this.request('tools/call', {
      name,
      arguments: args,
      ...(progressToken ? { _meta: { progressToken } } : {}),
    });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

function parse(text: string | undefined): any {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return undefined;
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
    for (const capability of ['tools', 'resources', 'prompts', 'logging', 'completions']) {
      check(`it offers ${capability}`, Boolean(init.result?.capabilities?.[capability]));
    }
    const instructions: string = init.result?.instructions ?? '';
    check(
      'it hands the client instructions that name the one tool that spends',
      instructions.includes('refute_claim') && instructions.includes('confirm: true'),
      instructions.slice(0, 80),
    );
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
      check(`${t.name} carries a title`, typeof t.title === 'string' && t.title.length > 0);
      check(`${t.name} declares an output schema`, t.outputSchema?.type === 'object');
    }

    const resources = (await client.request('resources/list')).result?.resources ?? [];
    const listed = resources.map((r: any) => r.uri).sort();
    check(
      'the tally and both deployments are listed as resources',
      JSON.stringify(listed) === JSON.stringify(['utuh://claims/mainnet', 'utuh://claims/sepolia', 'utuh://tally']),
      listed.join(', '),
    );
    const templates = (await client.request('resources/templates/list')).result?.resourceTemplates ?? [];
    const uris = templates.map((t: any) => t.uriTemplate).sort();
    check(
      'claims are addressable by deployment and by id',
      JSON.stringify(uris) === JSON.stringify(['utuh://claim/{deployment}/{claimId}', 'utuh://claims/{deployment}']),
      uris.join(', '),
    );

    const prompts = (await client.request('prompts/list')).result?.prompts ?? [];
    const promptNames = prompts.map((p: any) => p.name).sort();
    check(
      'both halves of the job are offered as prompts',
      JSON.stringify(promptNames) === JSON.stringify(['hold_the_watcher_role', 'weigh_a_refutation']),
      promptNames.join(', '),
    );
    const got = await client.request('prompts/get', {
      name: 'hold_the_watcher_role',
      arguments: { deployment: 'mainnet' },
    });
    const text = got.result?.messages?.[0]?.content?.text ?? '';
    check('the sweep prompt names the deployment it was asked for', text.includes('mainnet'));
    check('and tells the agent not to spend', /Do not call refute_claim/.test(text));
    const weigh = await client.request('prompts/get', {
      name: 'weigh_a_refutation',
      arguments: { deployment: 'sepolia', claimId: '7' },
    });
    const weighText = weigh.result?.messages?.[0]?.content?.text ?? '';
    check('the decision prompt names the claim it was asked about', weighText.includes('utuh://claim/sepolia/7'));
    check(
      "and makes the send conditional on a yes in the person's words",
      /confirm: true/.test(weighText) && /yes/.test(weighText),
    );

    // Completions: a picker typing "ma" is offered mainnet; typing a claim id on a deployment is
    // offered the ids that exist there, which is a live read.
    const completed = await client.request('completion/complete', {
      ref: { type: 'ref/prompt', name: 'hold_the_watcher_role' },
      argument: { name: 'deployment', value: 'ma' },
    });
    check(
      'a prompt argument completes to the deployment that matches',
      JSON.stringify(completed.result?.completion?.values) === JSON.stringify(['mainnet']),
      JSON.stringify(completed.result ?? completed.error),
    );
    const ids = await client.request('completion/complete', {
      ref: { type: 'ref/resource', uri: 'utuh://claim/{deployment}/{claimId}' },
      argument: { name: 'claimId', value: '1' },
      context: { arguments: { deployment: 'mainnet' } },
    });
    const idValues: string[] = ids.result?.completion?.values ?? [];
    check(
      'a claim id completes to ids that exist on that deployment',
      idValues.includes('1') && idValues.every((v) => v.startsWith('1')),
      JSON.stringify(ids.result ?? ids.error),
    );

    // Live: the bundle carries the registry ABI and both deployment records, and this is the only
    // way to find out that it still does. Reads Creditcoin; needs no key.
    const tally = await client.request('resources/read', { uri: 'utuh://tally' });
    const body = tally.result?.contents?.[0];
    check('the tally resource is JSON', body?.mimeType === 'application/json', tally.error?.message);
    const parsed = parse(body?.text) ?? {};
    check(
      'it reads live claims off Creditcoin',
      Number(parsed.claimsSealed) > 0 && Number(parsed.eventsProvenIntoClaims) > 0,
      body?.text?.slice(0, 120),
    );
    check('and counts refutations among them', Number(parsed.claimsRefuted) > 0);
    const tallyTool = await client.call('tally', {});
    check(
      'the tally tool returns the same numbers as structured content',
      JSON.stringify(tallyTool.result?.structuredContent) === JSON.stringify(parsed),
      JSON.stringify(tallyTool.result?.structuredContent ?? tallyTool.error),
    );
    check(
      'and the serialized form as a text block too',
      tallyTool.result?.content?.some((c: any) => parse(c.text)?.claimsSealed === parsed.claimsSealed),
    );

    // Pagination: a page of three, then the page after it, then a cursor nobody issued.
    const page = await client.call('list_claims', { deployment: REFUTED.deployment, limit: 3 });
    const s = page.result?.structuredContent;
    check(
      'list_claims pages: three asked, three given, a cursor to the rest',
      s?.claims?.length === 3 && s.nextCursor === '4' && s.total > 3,
      JSON.stringify(s ?? page.error).slice(0, 160),
    );
    check(
      'each claim on the page carries its verdict fields',
      s?.claims?.every((c: any) => typeof c.refutable === 'boolean' && typeof c.status === 'string'),
    );
    const page2 = await client.call('list_claims', {
      deployment: REFUTED.deployment,
      limit: 3,
      cursor: s?.nextCursor,
    });
    check(
      'the next page starts where the cursor said',
      page2.result?.structuredContent?.claims?.[0]?.claimId === 4,
      JSON.stringify(page2.result?.structuredContent?.claims?.[0] ?? page2.error),
    );
    const badCursor = await client.call('list_claims', { deployment: REFUTED.deployment, cursor: 'nope' });
    check('a cursor the server never issued is an isError result, not a crash', badCursor.result?.isError === true);
    const badDeployment = await client.call('list_claims', { deployment: 'goerli' });
    check(
      'an unknown deployment fails input validation as an isError result',
      badDeployment.result?.isError === true && /goerli|Invalid/.test(badDeployment.result?.content?.[0]?.text ?? ''),
    );

    // The sweep, for real. The claim was refuted on chain, so its omission is a matter of record:
    // the sweep must find a gap, the structured result must say so, and while it works the server
    // must narrate — logging notifications for every client, progress for the one that asked.
    const before = client.notifications.length;
    const sweep = await client.call('sweep_claim', REFUTED, 'sweep-1');
    const v = sweep.result?.structuredContent;
    check(
      `sweeping refuted ${REFUTED.deployment} claim ${REFUTED.claimId} finds the gap the chain already found`,
      v?.complete === false && v?.omitted?.blockNumber > 0 && typeof v?.omitted?.orderingKey === 'string',
      JSON.stringify(v ?? sweep.error ?? sweep.result).slice(0, 200),
    );
    check('and says the claim is no longer refutable', v?.status === 'Refuted' && v?.refutable === false);
    check(
      'with provenance a reader can weigh',
      v?.provenance?.attempted >= 2 && v?.provenance?.events > 0 && Array.isArray(v?.provenance?.perSource),
      JSON.stringify(v?.provenance),
    );
    check('the prose says INCOMPLETE', /^INCOMPLETE/.test(sweep.result?.content?.[0]?.text ?? ''));
    const during = client.notifications.slice(before);
    const logs = during.filter((n) => n.method === 'notifications/message');
    const progress = during.filter((n) => n.method === 'notifications/progress');
    check(
      'the sweep narrated itself as logging notifications',
      logs.length >= 4 && logs.every((n) => n.params?.logger === 'utuh' && n.params?.level === 'info'),
      `${logs.length} log notification(s)`,
    );
    check(
      'and as progress against the token the client sent',
      progress.length === 4 &&
        progress.every((n) => n.params?.progressToken === 'sweep-1' && n.params?.total === 4) &&
        progress[progress.length - 1]?.params?.progress === 4,
      JSON.stringify(progress.map((n) => n.params)),
    );
    const nothing = await client.call('sweep_claim', { deployment: REFUTED.deployment, claimId: 10_000_000 });
    check(
      'sweeping a claim that does not exist is an isError result with the reason',
      nothing.result?.isError === true && /no claim 10000000/.test(nothing.result?.content?.[0]?.text ?? ''),
      JSON.stringify(nothing.result ?? nothing.error).slice(0, 120),
    );

    // The gate on the only tool that spends. Called for real, with confirm withheld: it must
    // explain itself and send nothing. A key is not needed to prove that, which is the point.
    const unconfirmed = await client.call('refute_claim', REFUTED);
    const answer = unconfirmed.result?.content?.[0]?.text ?? '';
    check('refute_claim without confirm refuses', /confirm: true/.test(answer), answer.slice(0, 120));
    check(
      'and it is an answer, not an error',
      unconfirmed.error === undefined && unconfirmed.result?.isError !== true,
    );
    check(
      'and its structured result says sent: false with the reason',
      unconfirmed.result?.structuredContent?.sent === false &&
        unconfirmed.result?.structuredContent?.txHash === null &&
        /confirm: true/.test(unconfirmed.result?.structuredContent?.reason ?? ''),
    );
    const noKey = await client.call('refute_claim', { ...REFUTED, confirm: true });
    check(
      'confirmed but without a key it still sends nothing, and says so',
      noKey.result?.structuredContent?.sent === false &&
        /PRIVATE_KEY/.test(noKey.result?.structuredContent?.reason ?? ''),
      JSON.stringify(noKey.result?.structuredContent ?? noKey.error),
    );

    const unknown = await client.request('tools/call', { name: 'no_such_tool', arguments: {} });
    check('an unknown tool is an error, not a silence', Boolean(unknown.error) || unknown.result?.isError === true);

    // What the bundle says about itself must be what it serves. The MCPB manifest and the README
    // are written by build-mcp.ts without asking the server; this is where they are asked.
    const manifest = JSON.parse(readFileSync(join(DIST, 'mcpb', 'manifest.json'), 'utf8'));
    check(
      'the MCPB manifest lists exactly the tools the server serves',
      JSON.stringify(manifest.tools.map((t: any) => t.name).sort()) === JSON.stringify(names),
    );
    check(
      'and exactly the prompts',
      JSON.stringify(manifest.prompts.map((p: any) => p.name).sort()) === JSON.stringify(promptNames),
    );
    check('and the version the server reports', manifest.version === version);
    const readme = readFileSync(join(DIST, 'README.md'), 'utf8');
    const snippets = [...readme.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    check(
      'every client snippet in the README is valid JSON that runs the published package',
      snippets.length >= 3 && snippets.every((j) => JSON.stringify(parse(j) ?? {}).includes('"utuh-mcp"')),
      `${snippets.length} snippet(s)`,
    );
  } finally {
    client.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

runScript(main);
