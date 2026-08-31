import { buildSync } from 'esbuild';
import { createHash } from 'node:crypto';
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

  // The whitepaper, as the submission form asks for it. Rendered by `npm run web:pdf` from
  // `web/whitepaper.html` and committed, because a browser is the only thing that can make it and
  // this workflow has no browser. Nothing on the page links to it: it is here so the document has
  // an address that is not a private artifact, and so the PDF a reader downloads was built from a
  // file in this repository rather than from something nobody can check.
  // Recomputed here rather than imported from build-pdf.ts, which calls runScript at module
  // scope: importing it would run it. The two lines cannot drift silently, because a disagreement
  // about how to hash shows up as the mismatch this throws on.
  const source = createHash('sha256')
    .update(readFileSync(join(WEB, 'whitepaper.html')))
    .digest('hex');
  if (readFileSync(join(WEB, 'whitepaper.sha256'), 'utf8').trim() !== source) {
    throw new Error('web/whitepaper.html has changed since the PDF was rendered — npm run web:pdf');
  }
  copyFileSync(join(WEB, 'whitepaper.pdf'), join(DEST, 'whitepaper.pdf'));

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

  // The page names one address and every host repeats it. The same bytes are served from Pages and
  // from Vercel, and letting each build claim its own host split one page into two identities —
  // two canonical URLs, two link previews, two things for a crawler to rank against each other.
  // Pages is the address the README and the submission give out, so Pages is the one the page
  // says, wherever it happens to be served from.
  const html = readFileSync(join(WEB, 'index.html'), 'utf8')
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

  // RFC 9116. SECURITY.md tells a person where to report; this tells a scanner, and a researcher
  // who finds the deployed page rather than the repository. `Expires` is required by the RFC and is
  // set a year out from the build, so a stale file says so rather than looking maintained.
  const expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  mkdirSync(join(DEST, '.well-known'), { recursive: true });
  writeFileSync(
    join(DEST, '.well-known', 'security.txt'),
    [
      '# Utuh — a completeness layer for the Attestcoin Protocol.',
      '# Testnet software. The contracts hold testnet CTC and no mainnet funds.',
      'Contact: https://github.com/PugarHuda/utuh/security/advisories/new',
      `Expires: ${expires}`,
      'Preferred-Languages: en',
      'Canonical: https://utuh.vercel.app/.well-known/security.txt',
      'Policy: https://github.com/PugarHuda/utuh/blob/master/SECURITY.md',
      '',
    ].join(String.fromCharCode(10)),
  );

  console.log(`static console in ${DEST}`);
  console.log(`  registry ${String(deployments.registry)}`);
  console.log(`  credit   ${String(deployments.credit)}`);
  console.log(`  ${Object.values(baked.abis).reduce((n, a) => n + a.length, 0)} ABI entries baked in`);
  return Promise.resolve();
}

runScript(main);
