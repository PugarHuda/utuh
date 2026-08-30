import { buildSync } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScript } from '../offchain/lib/cli';
import { DEPLOYMENT_RECORDS } from '../offchain/lib/networks';

/// Build the console as files a static host can serve, with no server of its own.
///
/// `npm run web` runs a tiny node server whose only job is to hand over three things the
/// filesystem already has: the ABIs out of forge's artifacts, and the deployment record. A static
/// host has no such server, so those three are baked into the page instead — read from the same
/// artifacts at build time, so they cannot drift from what was compiled.
///
/// Everything else is unchanged, and that is the point worth checking: the page still talks to
/// `rpc.cc3-testnet.creditcoin.network`, to the public source-chain endpoints and to the Proof
/// Builder, directly from the visitor's browser. Nothing is proxied, nothing is cached, and the
/// host serves bytes and holds nothing.
///
///   npm run web:static      → web/static/
///
/// Not committed. The Pages workflow runs this on every push and uploads what it produces, so the
/// published console is built from the artifacts of that commit rather than from whatever was in
/// the tree when somebody last remembered to rebuild.

const ROOT = join(__dirname, '..');
const WEB = __dirname;
const OUT = join(ROOT, 'out');
const DEST = join(ROOT, process.env.STATIC_OUT ?? join('web', 'static'));

const ABIS: Record<string, [string, string]> = {
  registry: ['UtuhRegistry.sol', 'UtuhRegistry'],
  credit: ['UtuhCredit.sol', 'UtuhCredit'],
  chainInfo: ['IChainInfo.sol', 'IChainInfo'],
};

function abi(file: string, name: string): unknown[] {
  const path = join(OUT, file, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing artifact ${path} — run: forge build`);
  return (JSON.parse(readFileSync(path, 'utf8')) as { abi: unknown[] }).abi;
}

function main(): Promise<void> {
  const record = process.env.DEPLOYMENTS ?? 'deployments.full.json';
  const deploymentsPath = join(ROOT, record);
  if (!existsSync(deploymentsPath)) {
    throw new Error(`no deployment record at ${deploymentsPath} — run npm run full, or set DEPLOYMENTS`);
  }
  const deployments = JSON.parse(readFileSync(deploymentsPath, 'utf8')) as Record<string, unknown>;

  mkdirSync(DEST, { recursive: true });

  // esbuild's own API rather than its CLI through `npx`: every path here has a space in it on the
  // machine this was written on, and shelling out to find that out is a worse way to learn it.
  buildSync({
    entryPoints: [join(WEB, 'main.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    outfile: join(DEST, 'main.js'),
  });

  copyFileSync(join(WEB, 'style.css'), join(DEST, 'style.css'));
  // The link-preview image. Not something the page ever requests — crawlers fetch it.
  copyFileSync(join(WEB, 'og.png'), join(DEST, 'og.png'));

  // The one webfont, self-hosted. A page whose argument is that it needs no server should not open
  // a connection to a font CDN to render its own name, so the file ships with the page. The
  // stylesheet asks for it at `./fonts/`, which resolves the same from a subpath as from a root.
  mkdirSync(join(DEST, 'fonts'), { recursive: true });
  copyFileSync(join(WEB, 'fonts', 'archivo.woff2'), join(DEST, 'fonts', 'archivo.woff2'));

  // Both published deployments, so the page can switch between them without a server.
  const records: Record<string, unknown> = {};
  for (const [name, file] of Object.entries(DEPLOYMENT_RECORDS)) {
    const at = join(ROOT, file);
    if (existsSync(at)) records[name] = JSON.parse(readFileSync(at, 'utf8'));
  }
  const baked = {
    abis: Object.fromEntries(Object.entries(ABIS).map(([k, [file, name]]) => [k, abi(file, name)])),
    deployments: records,
  };

  // Where this build will actually live. The source hardcodes the Pages URL because that is where
  // the console has always been published, but the same bytes are now served from Vercel too, and a
  // page telling a crawler its address is somewhere else gets a link preview for the other site.
  // `SITE_URL` is what each host's build passes; the default keeps Pages exactly as it was.
  const site = (process.env.SITE_URL ?? 'https://pugarhuda.github.io/utuh/').replace(/\/*$/, '/');

  const html = readFileSync(join(WEB, 'index.html'), 'utf8')
    .replaceAll('https://pugarhuda.github.io/utuh/', site)
    .replace('href="/style.css"', 'href="./style.css"')
    .replace(
      '<script type="module" src="/dist/main.js"></script>',
      `<script>window.__UTUH__ = ${JSON.stringify(baked)};</script>\n` +
        '    <script type="module" src="./main.js"></script>',
    );
  writeFileSync(join(DEST, 'index.html'), html);

  // Pages runs Jekyll over a folder unless told not to, and Jekyll skips files beginning with an
  // underscore — which nothing here has, today. The marker costs nothing and removes the class of
  // problem entirely.
  writeFileSync(join(DEST, '.nojekyll'), '');

  console.log(`static console in ${DEST}`);
  console.log(`  registry ${String(deployments.registry)}`);
  console.log(`  credit   ${String(deployments.credit)}`);
  console.log(`  ${Object.values(baked.abis).reduce((n, a) => n + a.length, 0)} ABI entries baked in`);
  return Promise.resolve();
}

runScript(main);
