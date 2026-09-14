import { spawn } from 'node:child_process';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Interface, Wallet } from 'ethers';
import registryArtifact from '../out/UtuhRegistry.sol/UtuhRegistry.json';
import mainnetRecord from '../deployments.json';
import { version } from '../package.json';
import { CC3_CHAIN_ID } from './config';
import { runScript } from './lib/cli';

/// The remote MCP endpoint, spoken to over HTTP rather than described.
///
///   npm run mcp:http-test                              # the built function, on 127.0.0.1:4176
///   tsx offchain/mcpHttpTest.ts --deployment <url>     # the same assertions against a deployment
///
/// `mcpTest.ts` proves the stdio bundle. This proves the other one, `dist-mcp/api/mcp.js` — the file
/// the deploy stages as a Vercel function — by running it behind a plain node:http server and
/// speaking Streamable HTTP to it the way a remote client does: a preflight, an `initialize` with no
/// session to come back to, listings, live reads of Creditcoin, a sweep that narrates itself over
/// the response stream, a sweep that runs out of budget and must say so, and `refute_claim`, which
/// must build a real transaction and send nothing.
///
/// The environment is hostile on purpose. PRIVATE_KEY is set to a real (unfunded) key before the
/// function loads, because "the server holds no key" is only worth something if it holds true when
/// a key is lying around — which is exactly how the first stdio client refuted a claim by accident.
///
/// Against a deployment, requests go through `vercel curl`, which carries the logged-in CLI user
/// through Vercel's deployment protection. The budget case is skipped there: the deployed budget is
/// the platform's, and cannot be shortened from outside.

const ROOT = join(__dirname, '..');
const BUNDLE = join(ROOT, 'dist-mcp', 'api', 'mcp.js');
const PORT = 4176;

/// Refuted on chain, so its omission is a matter of record and its refutation must now revert.
const REFUTED = { deployment: 'mainnet', claimId: 1 };
/// Finalized over 216,002 source blocks: far more than a few seconds of sweeping.
const WIDE = { deployment: 'mainnet', claimId: 17 };

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

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type Send = (method: string, headers: Record<string, string>, body?: string) => Promise<Reply>;

function local(url: string): Send {
  return async (method, headers, body) => {
    const r = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }) });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
  };
}

/// `vercel curl <path> --deployment <url> -- <curl args>`, with `-i` so the status line and headers
/// come back in the output.
function throughVercel(deployment: string): Send {
  return (method, headers, body) =>
    new Promise((resolve, reject) => {
      const args = ['vercel', 'curl', '/api/mcp', '--deployment', deployment, '--', '-sS', '-i', '-X', method];
      for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
      if (body !== undefined) args.push('--data-binary', '@-');
      // On Windows npx is a .cmd, which Node runs only through a shell, and the shell splits on the
      // spaces every header value has. None of these arguments contains a double quote.
      const win = process.platform === 'win32';
      const child = spawn('npx', win ? args.map((x) => `"${x}"`) : args, { shell: win });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', () => {});
      child.on('error', reject);
      child.on('close', () => {
        // The last HTTP status block wins: curl prints one per hop when it follows anything.
        const start = out.lastIndexOf('HTTP/');
        const text = start < 0 ? out : out.slice(start);
        const split = text.search(/\r?\n\r?\n/);
        const head = split < 0 ? text : text.slice(0, split);
        const rest = split < 0 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
        const [statusLine, ...lines] = head.split(/\r?\n/);
        const out2: Record<string, string> = {};
        for (const line of lines) {
          const at = line.indexOf(':');
          if (at > 0) out2[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
        }
        resolve({ status: Number(statusLine?.split(' ')[1] ?? 0), headers: out2, body: rest });
      });
      if (body !== undefined) child.stdin.end(body);
      else child.stdin.end();
    });
}

/// A Streamable HTTP client: every JSON-RPC message in the response, whether it came back as one
/// JSON body or as a stream of server-sent events carrying notifications before the result.
class Client {
  private next = 1;
  constructor(private send: Send) {}

  async rpc(method: string, params: unknown = {}): Promise<{ reply: Reply; result: Rpc; notes: Rpc[] }> {
    const id = this.next++;
    const reply = await this.send(
      'POST',
      {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    );
    const messages: Rpc[] = [];
    if ((reply.headers['content-type'] ?? '').includes('text/event-stream')) {
      for (const event of reply.body.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data) messages.push(JSON.parse(data) as Rpc);
      }
    } else if (reply.body) {
      messages.push(JSON.parse(reply.body) as Rpc);
    }
    return {
      reply,
      result: messages.find((m) => m.id === id) ?? { error: { message: `no answer (HTTP ${reply.status})` } },
      notes: messages.filter((m) => m.id === undefined),
    };
  }

  call(name: string, args: Record<string, unknown>, progressToken?: string) {
    return this.rpc('tools/call', { name, arguments: args, ...(progressToken ? { _meta: { progressToken } } : {}) });
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
  const at = process.argv.indexOf('--deployment');
  const deployment = at > 0 ? process.argv[at + 1] : undefined;
  let close = () => {};
  let send: Send;

  if (deployment) {
    console.log(`speaking MCP over HTTP to ${deployment}/api/mcp, through vercel curl\n`);
    send = throughVercel(deployment);
  } else {
    if (!existsSync(BUNDLE)) throw new Error(`no bundle at ${BUNDLE} — run: npm run mcp:package`);
    // Before the function loads: a key in the environment it must never use.
    process.env.PRIVATE_KEY = Wallet.createRandom().privateKey;
    const handler = (require(BUNDLE) as { default: (req: IncomingMessage, res: ServerResponse) => Promise<void> })
      .default;
    const server = createHttpServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
    close = () => server.close();
    console.log(`speaking MCP over HTTP to ${BUNDLE} on http://127.0.0.1:${PORT}/api/mcp\n`);
    send = local(`http://127.0.0.1:${PORT}/api/mcp`);
  }
  const client = new Client(send);
  const iface = new Interface(registryArtifact.abi);

  try {
    // Transport: what a browser-based client and a strict one each need before any JSON-RPC.
    const preflight = await send('OPTIONS', {
      origin: 'https://inspector.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, mcp-protocol-version',
    });
    check(
      'a CORS preflight is answered for any origin',
      preflight.status === 204 && preflight.headers['access-control-allow-origin'] === '*',
      `${preflight.status} ${JSON.stringify(preflight.headers)}`.slice(0, 200),
    );
    check(
      'and allows the headers the protocol sends',
      /mcp-protocol-version/.test(preflight.headers['access-control-allow-headers'] ?? '') &&
        /content-type/.test(preflight.headers['access-control-allow-headers'] ?? ''),
    );
    const get = await send('GET', { accept: 'text/event-stream' });
    check('GET is 405: a stateless server has no stream to open', get.status === 405, `HTTP ${get.status}`);

    const init = await client.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'utuh-mcp-http-test', version: '1' },
    });
    check(
      'initialize answers over HTTP',
      init.reply.status === 200 && Boolean(init.result.result),
      init.result.error?.message,
    );
    check('the server names itself utuh', init.result.result?.serverInfo?.name === 'utuh');
    check(`it reports version ${version}`, init.result.result?.serverInfo?.version === version);
    check('no session is issued: every request stands alone', init.reply.headers['mcp-session-id'] === undefined);
    check('the response carries CORS too', init.reply.headers['access-control-allow-origin'] === '*');
    const instructions: string = init.result.result?.instructions ?? '';
    check(
      'the instructions say this server holds no key and returns unsigned transactions',
      /holds no key/.test(instructions) && /unsigned/.test(instructions) && !/PRIVATE_KEY/.test(instructions),
      instructions.slice(0, 120),
    );

    const tools = (await client.rpc('tools/list')).result.result?.tools ?? [];
    const names = tools.map((t: any) => t.name).sort();
    check(
      'all five tools are listed',
      JSON.stringify(names) ===
        JSON.stringify(['audit_attestors', 'list_claims', 'refute_claim', 'sweep_claim', 'tally']),
      names.join(', '),
    );
    const refuteTool = tools.find((t: any) => t.name === 'refute_claim');
    check(
      'refute_claim is annotated read-only here, because nothing here can send',
      refuteTool?.annotations?.readOnlyHint === true && refuteTool?.annotations?.destructiveHint === false,
    );
    check(
      'and its output schema carries the unsigned transaction',
      Boolean(refuteTool?.outputSchema?.properties?.transaction) &&
        Boolean(refuteTool?.outputSchema?.properties?.wouldRevert),
    );
    const sweepTool = tools.find((t: any) => t.name === 'sweep_claim');
    check(
      'sweep_claim states its budget',
      /\d+s/.test(sweepTool?.description ?? '') && Boolean(sweepTool?.outputSchema?.properties?.inconclusive),
    );

    const resources = (await client.rpc('resources/list')).result.result?.resources ?? [];
    check(
      'the resources are listed',
      JSON.stringify(resources.map((r: any) => r.uri).sort()) ===
        JSON.stringify(['utuh://claims/mainnet', 'utuh://claims/sepolia', 'utuh://tally']),
    );
    const templates = (await client.rpc('resources/templates/list')).result.result?.resourceTemplates ?? [];
    check('and both templates', templates.length === 2);
    const prompts = (await client.rpc('prompts/list')).result.result?.prompts ?? [];
    check(
      'both prompts are offered',
      JSON.stringify(prompts.map((p: any) => p.name).sort()) ===
        JSON.stringify(['hold_the_watcher_role', 'weigh_a_refutation']),
    );
    const weigh = await client.rpc('prompts/get', {
      name: 'weigh_a_refutation',
      arguments: { deployment: 'mainnet', claimId: '1' },
    });
    const weighText: string = weigh.result.result?.messages?.[0]?.content?.text ?? '';
    check(
      'the decision prompt hands over an unsigned transaction instead of sending one',
      /sends\s+nothing/.test(weighText) && /own wallet/.test(weighText) && !/confirm: true/.test(weighText),
      weighText.slice(-200),
    );

    // The tally, twice: live from Creditcoin, then from the cache the second time.
    let t0 = Date.now();
    const tallyTool = await client.call('tally', {});
    const cold = Date.now() - t0;
    const numbers = tallyTool.result.result?.structuredContent;
    check(
      'tools/call tally reads live claims off Creditcoin',
      Number(numbers?.claimsSealed) > 0 && Number(numbers?.eventsProvenIntoClaims) > 0,
      JSON.stringify(tallyTool.result.result ?? tallyTool.result.error).slice(0, 160),
    );
    t0 = Date.now();
    const tallyRead = await client.rpc('resources/read', { uri: 'utuh://tally' });
    const warm = Date.now() - t0;
    const body = tallyRead.result.result?.contents?.[0];
    check(
      'resources/read utuh://tally returns the same numbers as JSON',
      body?.mimeType === 'application/json' && JSON.stringify(parse(body?.text)) === JSON.stringify(numbers),
      body?.text?.slice(0, 120),
    );
    if (!deployment) {
      check(
        `and serves them from the cache: ${cold}ms cold, ${warm}ms warm`,
        warm < cold / 2 || warm < 50,
        `${cold}ms then ${warm}ms`,
      );
    }

    const page = await client.call('list_claims', { deployment: 'mainnet', limit: 3 });
    check('list_claims pages over HTTP', page.result.result?.structuredContent?.claims?.length === 3);

    // A sweep that finds the gap the chain already found, narrating itself on the response stream.
    const sweep = await client.call('sweep_claim', REFUTED, 'sweep-http');
    const v = sweep.result.result?.structuredContent;
    check(
      `sweep_claim on refuted ${REFUTED.deployment} claim ${REFUTED.claimId} finds its gap`,
      v?.complete === false && v?.inconclusive === false && v?.omitted?.blockNumber > 0,
      JSON.stringify(v ?? sweep.result).slice(0, 200),
    );
    const progress = sweep.notes.filter((n) => n.method === 'notifications/progress');
    const logs = sweep.notes.filter((n) => n.method === 'notifications/message');
    check(
      'and its progress and log notifications arrive on the same response',
      progress.length === 4 && progress.every((n) => n.params?.progressToken === 'sweep-http') && logs.length >= 4,
      `${progress.length} progress, ${logs.length} log`,
    );

    // The budget, locally, where it can be made short: a 216,002-block sweep given six seconds must
    // come back inside a reasonable margin of them, say how far it got, and claim nothing about the rest.
    if (!deployment) {
      const wideClaim = parse(
        (await client.rpc('resources/read', { uri: `utuh://claim/${WIDE.deployment}/${WIDE.claimId}` })).result.result
          ?.contents?.[0]?.text,
      );
      process.env.UTUH_MCP_BUDGET_MS = '6000';
      t0 = Date.now();
      const wide = await client.call('sweep_claim', WIDE);
      const took = Date.now() - t0;
      delete process.env.UTUH_MCP_BUDGET_MS;
      const w = wide.result.result?.structuredContent;
      check(
        `a sweep over budget answers inconclusive instead of timing out (${(took / 1000).toFixed(1)}s for a 6s budget)`,
        w?.inconclusive === true && w?.complete === false && w?.omitted === null && took < 40_000,
        JSON.stringify(w ?? wide.result).slice(0, 200),
      );
      check(
        'and says how far it got',
        typeof w?.sweptThrough === 'number' &&
          w.sweptThrough < wideClaim?.toBlock &&
          w.sweptThrough >= wideClaim?.fromBlock &&
          /^INCONCLUSIVE/.test(wide.result.result?.content?.[0]?.text ?? ''),
        `swept through ${w?.sweptThrough} of ${wideClaim?.fromBlock}..${wideClaim?.toBlock}`,
      );
    } else {
      t0 = Date.now();
      const wide = await client.call('sweep_claim', WIDE);
      const took = Date.now() - t0;
      const w = wide.result.result?.structuredContent;
      check(
        `a 216,002-block sweep answers before the platform limit (${(took / 1000).toFixed(1)}s), complete or marked inconclusive`,
        wide.reply.status === 200 &&
          typeof w?.inconclusive === 'boolean' &&
          (w.inconclusive || w.complete || w.omitted !== null),
        JSON.stringify(w ?? wide.result).slice(0, 200),
      );
    }

    // The refutation, which over HTTP is a transaction for someone else's wallet.
    const refute = await client.call('refute_claim', { ...REFUTED, confirm: true });
    const s = refute.result.result?.structuredContent;
    const tx = s?.transaction;
    check(
      'refute_claim sends nothing, even confirmed, even with a key in the environment',
      s?.sent === false &&
        s?.txHash === null &&
        /Nothing was sent/.test(refute.result.result?.content?.[0]?.text ?? ''),
      JSON.stringify(s ?? refute.result).slice(0, 200),
    );
    check(
      'it returns an unsigned transaction to the registry on Creditcoin CC3 Testnet',
      tx?.to === mainnetRecord.registry && tx?.chainId === CC3_CHAIN_ID && tx?.value === '0',
      JSON.stringify(tx ?? null).slice(0, 160),
    );
    let decoded: ReturnType<Interface['parseTransaction']> = null;
    try {
      decoded = iface.parseTransaction({ data: tx?.data ?? '0x' });
    } catch {
      decoded = null;
    }
    check(
      'whose calldata decodes against the registry ABI as refute(claimId, proof, continuity)',
      decoded?.name === 'refute' && decoded.args[0] === BigInt(REFUTED.claimId),
      decoded ? `${decoded.name}(${decoded.args[0]})` : 'did not decode',
    );
    check(
      'carrying a proof of the very event the sweep found omitted',
      decoded !== null &&
        Number(decoded.args[1].blockHeight) === v?.omitted?.blockNumber &&
        Number(decoded.args[1].blockHeight) === s?.omitted?.blockNumber &&
        String(decoded.args[1].encodedTransaction).length > 2 &&
        decoded.args[2].roots.length > 0,
      decoded ? `proof at ${decoded.args[1].blockHeight}, omitted at ${v?.omitted?.blockNumber}` : '',
    );
    check(
      'and eth_call says the registry would now reject it with one of its own errors, so no gas is offered',
      typeof s?.wouldRevert === 'string' && iface.getError(s.wouldRevert) !== null && tx?.gas === null,
      `wouldRevert ${s?.wouldRevert}, gas ${tx?.gas}`,
    );
    const none = await client.call('refute_claim', { deployment: 'mainnet', claimId: 10_000_000 });
    check('refuting a claim that does not exist is an isError result', none.result.result?.isError === true);

    const unknown = await client.rpc('tools/call', { name: 'no_such_tool', arguments: {} });
    check(
      'an unknown tool is an error, not a silence',
      Boolean(unknown.result.error) || unknown.result.result?.isError === true,
    );
  } finally {
    close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

runScript(main);
