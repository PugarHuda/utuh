import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { runScript } from '../offchain/lib/cli';

/// The console's static server.
///
/// There is no framework here on purpose. The page needs three things the filesystem already has —
/// its own files, the ABIs forge writes into `out/`, and the deployment record — and everything
/// else it does it does against public endpoints directly from the browser. A server that only
/// serves files cannot be the thing that makes the demonstration work, which is the point: what
/// the page shows is what the chain says, reachable by anyone from their own machine.

const ROOT = join(__dirname, '..');
const WEB = __dirname;
const OUT = join(ROOT, 'out');
const PORT = Number(process.env.WEB_PORT ?? 5173);
const HOST = process.env.WEB_HOST ?? '127.0.0.1';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/// Which artifacts the page may read, by name. An allowlist rather than a path join, because the
/// alternative is serving whatever `out/` happens to contain to whoever asks.
const ABIS: Record<string, string> = {
  'UtuhRegistry.json': join(OUT, 'UtuhRegistry.sol', 'UtuhRegistry.json'),
  'UtuhCredit.json': join(OUT, 'UtuhCredit.sol', 'UtuhCredit.json'),
  'IChainInfo.json': join(OUT, 'IChainInfo.sol', 'IChainInfo.json'),
};

/// Which deployment the console shows.
///
/// `DEPLOYMENTS` names one explicitly. Otherwise the full-flow record comes first, because it is
/// the one with a completed loop in it — a console pointed at the mainnet-sourced deployment shows
/// claims and no line, which is correct and reads like something is broken.
function deploymentRecord(): string | undefined {
  const named = process.env.DEPLOYMENTS;
  if (named) {
    const file = join(ROOT, named);
    return existsSync(file) ? file : undefined;
  }
  return ['deployments.full.json', 'deployments.json'].map((f) => join(ROOT, f)).find((f) => existsSync(f));
}

async function serveFile(path: string, res: import('node:http').ServerResponse): Promise<void> {
  if (!existsSync(path)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`not found: nothing at ${path}`);
    return;
  }
  const body = await readFile(path);
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
  res.end(body);
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    // `URL` has already collapsed `..` and `.` for us. Running the result through `path.normalize`
    // would be the natural next move and is wrong on Windows, where it turns "/" into "\" and every
    // route stops matching — which is how this served 404 for its own index page.
    const path = new URL(req.url ?? '/', `http://${HOST}:${PORT}`).pathname;

    void (async () => {
      try {
        if (path === '/' || path === '/index.html') return await serveFile(join(WEB, 'index.html'), res);
        if (path === '/style.css') return await serveFile(join(WEB, 'style.css'), res);
        if (path === '/dist/main.js' || path === '/dist/main.js.map') {
          return await serveFile(join(WEB, 'dist', path.slice('/dist/'.length)), res);
        }

        if (path.startsWith('/abi/')) {
          const file = ABIS[path.slice('/abi/'.length)];
          if (!file) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            return res.end('no such artifact');
          }
          if (!existsSync(file)) {
            res.writeHead(503, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'run: forge build' }));
          }
          // Only the ABI. The bytecode is megabytes the browser has no use for.
          const artifact = JSON.parse(await readFile(file, 'utf8')) as { abi: unknown };
          res.writeHead(200, { 'content-type': TYPES['.json']! });
          return res.end(JSON.stringify(artifact.abi));
        }

        if (path === '/deployments.json') {
          const file = deploymentRecord();
          if (!file) {
            res.writeHead(503, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'no deployment record — run npm run full, or set DEPLOYMENTS' }));
          }
          return await serveFile(file, res);
        }

        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(String((e as Error).message ?? e));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(PORT, HOST, resolve));
  console.log(`utuh console on http://${HOST}:${PORT}`);
  if (!existsSync(join(WEB, 'dist', 'main.js'))) {
    console.log('  no bundle yet — run: npm run web:build');
  }

  // `runScript` exits the process the moment `main` resolves, which is right for the one-shot
  // commands and wrong for exactly two things here: the watcher, and this. Returning would take
  // the server down a millisecond after it started listening.
  await new Promise<never>(() => {});
}

runScript(main);
