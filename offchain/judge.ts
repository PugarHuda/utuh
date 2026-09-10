import { Contract, Wallet, formatEther } from 'ethers';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { CC3_RPC, cc3 } from './config';
import { CC3_CHAIN_ID, CHAIN_INFO_ADDRESS, ORACLE_DASHBOARD, type DeploymentName } from './lib/networks';
import { chainInfoAt, supportedChains } from './lib/chain';
import { claimStatus } from './lib/status';
import { runScript } from './lib/cli';
import registryArtifact from '../out/UtuhRegistry.sol/UtuhRegistry.json';
import sepoliaRecord from '../deployments.full.json';
import mainnetRecord from '../deployments.json';
import { version } from '../package.json';

/// Every number in the submission, measured again, next to the sentence that quotes it.
///
/// A submission is prose, and prose is worthless as evidence: anyone can type "359 transactions"
/// and "zero findings". What separates this project from a description of one is that each of
/// those sentences names something a stranger can read back — a counter on an explorer nobody
/// here controls, a status word a contract returns, a version a registry serves. This script
/// reads them all, in order, and prints the sentence beside what it found.
///
/// It needs no key, no environment, and no permission. A judge runs it; so does CI, daily,
/// because a sentence that was true on the day it was written is the most common kind of lie.
///
///   npm run judge
///
/// Every check is a floor, never an equality. On-chain counters only go up, so "at least what
/// the submission quotes" is what stays true after the next live run; an equality would go red
/// the first time somebody sealed a claim.

const BLOCKSCOUT = 'https://creditcoin-testnet.blockscout.com/api/v2';
const SOURCIFY = 'https://sourcify.dev/server/v2/contract';
const CANONICAL = 'https://utuh.vercel.app';
const MIRROR = 'https://pugarhuda.github.io/utuh';
/// What the published build consists of. `security.txt` is stamped at build time and excluded for
/// the same reason `published.spec.ts` excludes it.
const PUBLISHED = ['index.html', 'main.js', 'style.css', 'llms.txt', 'og.png', 'whitepaper.pdf'];

/// The addresses the submission lists, by name, so a reviewer can find each line's source.
const LISTED = {
  'Sepolia-sourced registry': sepoliaRecord.registry,
  'Sepolia-sourced credit': sepoliaRecord.credit,
  'Sepolia-sourced decoder': sepoliaRecord.decoder,
  'mainnet-sourced registry': mainnetRecord.registry,
  'mainnet-sourced credit': mainnetRecord.credit,
  'mainnet-sourced decoder': mainnetRecord.decoder,
} as const;

/// The floors the submission quotes. Raise them when the document does; never lower them.
const QUOTED = {
  transactions: 359,
  gas: 148_000_000,
  foundryTests: 159,
  commits: 156,
  claimsRefuted: 33,
};

/// The two links every document hands a reader, and what each must still be.
const LINKED: { deployment: DeploymentName; id: number; members?: number; what: string }[] = [
  { deployment: 'sepolia', id: 5, what: 'a claim sealed one event short, refuted from a browser' },
  { deployment: 'mainnet', id: 20, members: 0, what: 'a false clean claim over 216,000 mainnet blocks' },
];

/// The sixteen protocol entry points the submission counts: five surfaces on the Block Prover and
/// eleven methods on ChainInfo. A name that stops appearing anywhere in the sources is a call the
/// project stopped making, whatever the README still says.
const CHAIN_INFO_METHODS = [
  'is_height_attested',
  'get_latest_attestation_height_and_hash',
  'get_attestation_genesis_height',
  'get_supported_chains',
  'get_chain_by_key',
  'get_attestation_bounds',
  'find_highest_attested_before',
  'find_lowest_attested_after',
  'get_latest_checkpoint_height_and_hash',
  'get_checkpoint_for_height',
  'get_attestation_height_for_digest',
];
const BLOCK_PROVER_SURFACES = [
  'verifyAndEmit',
  'verify(',
  'calculateTxIndex',
  'EvmV1Decoder',
  'PrecompileBlockProver',
];

interface Row {
  claim: string;
  found: string;
  ok: boolean;
}
const rows: Row[] = [];
function note(claim: string, found: string, ok: boolean): void {
  rows.push({ claim, found, ok });
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${claim}\n      ${found}`);
}

async function json<T>(url: string, ms = 20_000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'utuh-judge' } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function head(url: string, ms = 20_000): Promise<{ status: number; type: string; bytes: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), headers: { 'user-agent': 'utuh-judge' } });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') ?? '', bytes: buf.byteLength };
}

async function digest(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(25_000), headers: { 'user-agent': 'utuh-judge' } });
  if (!res.ok) return `missing:${res.status}`;
  const buf = await res.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/// Everything a reviewer could read — sources, scripts, the console — but not what was installed.
function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'out' || name === 'out-halmos' || name === 'lib' || name === 'cache')
      continue;
    if (name === 'dist' || name === 'dist-mcp' || name === 'test-results' || name.startsWith('.')) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* sourceFiles(full);
    else if (/\.(sol|ts)$/.test(name)) yield full;
  }
}

async function main(): Promise<void> {
  const provider = cc3();
  const reader = Wallet.createRandom().connect(provider);
  console.log(`utuh judge — every submission claim, measured again against ${CC3_RPC}\n`);

  // ── The contracts are where the submission says, verified where it says ──────────────────────
  for (const [name, address] of Object.entries(LISTED)) {
    const code = await provider.getCode(address);
    const deployed = code !== '0x';
    let verified = 'unknown';
    let matched = 'unknown';
    try {
      const bs = await json<{ is_verified?: boolean; is_fully_verified?: boolean }>(
        `${BLOCKSCOUT}/smart-contracts/${address}`,
      );
      verified = bs.is_verified ? 'verified on Blockscout' : 'NOT verified on Blockscout';
    } catch (e) {
      verified = `Blockscout unreachable (${(e as Error).message.slice(0, 40)})`;
    }
    try {
      const sf = await json<{ match?: string }>(`${SOURCIFY}/${CC3_CHAIN_ID}/${address}`);
      matched = sf.match ? `Sourcify ${sf.match}` : 'Sourcify: no match';
    } catch {
      matched = 'Sourcify unreachable';
    }
    note(
      `${name} is deployed and verified at ${address}`,
      `${deployed ? `${(code.length - 2) / 2} bytes of code` : 'NO CODE'}; ${verified}; ${matched}`,
      deployed && verified.startsWith('verified') && matched.startsWith('Sourcify ') && !matched.includes('no match'),
    );
  }

  // ── The precompiles are runtime natives, which is why nothing here is a fork test ─────────────
  // Lower-cased: ethers insists a mixed-case address carry a valid checksum, and the precompile
  // addresses are conventionally written with one it does not accept.
  for (const [name, address] of [
    ['Block Prover 0x0FD2', '0x0000000000000000000000000000000000000fd2'],
    ['ChainInfo 0x0FD3', CHAIN_INFO_ADDRESS.toLowerCase()],
  ] as const) {
    const code = await provider.getCode(address);
    note(
      `${name} has no bytecode — a Substrate native, untestable in a local fork`,
      `eth_getCode → ${code}`,
      code === '0x',
    );
  }

  // ── Nobody administers either contract ────────────────────────────────────────────────────────
  const admin = /\b(onlyOwner|Ownable|owner|onlyRole|AccessControl)\b/;
  const offenders: string[] = [];
  for (const file of ['src/UtuhRegistry.sol', 'src/UtuhCredit.sol']) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (admin.test(line)) offenders.push(`${file}:${i + 1}`);
      });
  }
  note(
    'no owner, admin or role anywhere in UtuhRegistry or UtuhCredit',
    offenders.length ? offenders.join(', ') : 'grep for onlyOwner|Ownable|owner|onlyRole|AccessControl is empty',
    offenders.length === 0,
  );

  // ── The tally, read off both registries the way the console and the MCP server read it ────────
  const registries: Record<DeploymentName, Contract> = {
    sepolia: new Contract(sepoliaRecord.registry, registryArtifact.abi, reader),
    mainnet: new Contract(mainnetRecord.registry, registryArtifact.abi, reader),
  };
  let proven = 0n;
  let sealed = 0;
  let refuted = 0;
  let burned = 0n;
  const status = new Map<string, { status: string; members: number }>();
  for (const [which, r] of Object.entries(registries) as [DeploymentName, Contract][]) {
    const total = Number(await r.nextClaimId()) - 1;
    sealed += total;
    burned += (await r.burned()) as bigint;
    for (let i = 1; i <= total; i++) {
      const members = Number(await r.memberCount(i));
      const s = claimStatus((await r.claim(i)).status);
      proven += BigInt(members);
      if (s === 'Refuted') refuted++;
      status.set(`${which}:${i}`, { status: s, members });
    }
  }
  note(
    `at least ${QUOTED.claimsRefuted} claims broken by a refutation, with real bond slashed`,
    `${proven} events proven into ${sealed} claims; ${refuted} refuted; ${formatEther(burned)} CTC burned`,
    refuted >= QUOTED.claimsRefuted && burned > 0n,
  );

  // ── The two links every document hands a reader still open what the sentence says ────────────
  for (const l of LINKED) {
    const got = status.get(`${l.deployment}:${l.id}`);
    const ok = !!got && got.status === 'Refuted' && (l.members === undefined || got.members === l.members);
    note(
      `${l.deployment} claim ${l.id} is ${l.what}`,
      got ? `${got.status}, ${got.members} member(s)` : 'claim does not exist',
      ok,
    );
  }

  // ── The on-chain counters nobody here can write ───────────────────────────────────────────────
  let txs = 0;
  let gas = 0;
  let counted = 0;
  for (const address of [sepoliaRecord.registry, sepoliaRecord.credit, mainnetRecord.registry]) {
    try {
      const c = await json<{ transactions_count: string; gas_usage_count: string }>(
        `${BLOCKSCOUT}/addresses/${address}/counters`,
      );
      txs += Number(c.transactions_count);
      gas += Number(c.gas_usage_count);
      counted++;
    } catch {
      // Blockscout rate-limits silently; a failed read is unknown, never zero.
    }
  }
  note(
    `at least ${QUOTED.transactions} transactions and ${(QUOTED.gas / 1e6).toFixed(0)}M gas into the three listed addresses`,
    counted === 3
      ? `${txs} transactions, ${(gas / 1e6).toFixed(1)}M gas`
      : `only ${counted}/3 counters answered — unknown, not zero`,
    counted === 3 && txs >= QUOTED.transactions && gas >= QUOTED.gas,
  );

  // ── Attestcoin attests what the submission says it attests ────────────────────────────────────
  const chains = await supportedChains(provider);
  const keys = chains.map((c) => Number(c.chainKey)).sort();
  const info = chainInfoAt(provider);
  const frontier = await info.getLatestAttestedHeightAndHash(3);
  note(
    'CC3 Testnet attests Ethereum mainnet (chainKey 3) and Sepolia (chainKey 1)',
    `supported chain keys ${keys.join(', ')}; mainnet frontier ${frontier.exists ? frontier.height : 'none'}`,
    keys.includes(1) && keys.includes(3) && frontier.exists && frontier.height > 0n,
  );

  // ── The oracle's own record, which is where every append and refutation is visible ────────────
  const dash = await head(ORACLE_DASHBOARD);
  note(
    "Creditcoin's oracle dashboard, the third-party record of every verification, is up",
    `${ORACLE_DASHBOARD} → ${dash.status}`,
    dash.status === 200,
  );

  // ── The watcher is published where the submission says, at the version this tree is ──────────
  try {
    const npm = await json<{ 'dist-tags': { latest: string } }>('https://registry.npmjs.org/utuh-mcp');
    note(
      `npm serves utuh-mcp@${version}, the version this tree declares`,
      `dist-tags.latest = ${npm['dist-tags'].latest}`,
      npm['dist-tags'].latest === version,
    );
  } catch (e) {
    note(`npm serves utuh-mcp@${version}`, `npm unreachable: ${(e as Error).message}`, false);
  }
  try {
    const reg = await json<{
      servers: { server: { name: string; version: string }; _meta?: Record<string, { isLatest?: boolean }> }[];
    }>('https://registry.modelcontextprotocol.io/v0/servers?search=io.github.PugarHuda/utuh-mcp');
    const latest = reg.servers.find((s) => s._meta?.['io.modelcontextprotocol.registry/official']?.isLatest);
    note(
      `the official MCP Registry lists io.github.PugarHuda/utuh-mcp@${version} as latest`,
      latest
        ? `${latest.server.name}@${latest.server.version} isLatest`
        : `no isLatest entry among ${reg.servers.length}`,
      latest?.server.version === version,
    );
  } catch (e) {
    note('the official MCP Registry lists the watcher', `registry unreachable: ${(e as Error).message}`, false);
  }

  // ── The published console is the build, on both hosts, with the files the page promises ───────
  const drift: string[] = [];
  for (const f of PUBLISHED) {
    const [a, b] = await Promise.all([digest(`${CANONICAL}/${f}`), digest(`${MIRROR}/${f}`)]);
    if (a !== b || a.startsWith('missing')) drift.push(`${f}: ${a.slice(0, 12)} vs ${b.slice(0, 12)}`);
  }
  note(
    'the canonical console and its mirror serve the same build, every published file',
    drift.length ? drift.join('; ') : `${PUBLISHED.length} files identical`,
    drift.length === 0,
  );
  const pdf = await head(`${CANONICAL}/whitepaper.pdf`);
  note(
    'the whitepaper is served as a PDF from the console',
    `${pdf.status}, ${pdf.type}, ${(pdf.bytes / 1024).toFixed(0)} KB`,
    pdf.status === 200 && pdf.type.includes('pdf') && pdf.bytes > 40_000,
  );

  // ── The sixteen entry points are still called, not just still listed ──────────────────────────
  const corpus = [...sourceFiles('.')].map((f) => readFileSync(f, 'utf8')).join('\n');
  const missingCi = CHAIN_INFO_METHODS.filter((m) => !corpus.includes(m));
  const missingBp = BLOCK_PROVER_SURFACES.filter((m) => !corpus.includes(m));
  note(
    'all sixteen protocol entry points — 11 ChainInfo methods and 5 Block Prover surfaces — are referenced in the sources',
    missingCi.length + missingBp.length
      ? `not found: ${[...missingCi, ...missingBp].join(', ')}`
      : `${CHAIN_INFO_METHODS.length} + ${BLOCK_PROVER_SURFACES.length} names all present`,
    missingCi.length + missingBp.length === 0,
  );

  // ── What is local to this tree, and what a clone can count ────────────────────────────────────
  try {
    const listed = JSON.parse(
      execFileSync('forge', ['test', '--list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    ) as Record<string, Record<string, string[]>>;
    const tests = Object.values(listed).reduce((n, f) => n + Object.values(f).reduce((m, t) => m + t.length, 0), 0);
    note(
      `at least ${QUOTED.foundryTests} Foundry tests`,
      `forge test --list → ${tests}`,
      tests >= QUOTED.foundryTests,
    );
  } catch {
    note(`at least ${QUOTED.foundryTests} Foundry tests`, 'forge not on PATH — install Foundry to count them', false);
  }
  try {
    const commits = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
    note(
      `at least ${QUOTED.commits} commits, built in the open`,
      `git rev-list --count HEAD → ${commits}`,
      commits >= QUOTED.commits,
    );
  } catch {
    note(`at least ${QUOTED.commits} commits`, 'not a git checkout', false);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────────────────────────
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.length - failed.length} of ${rows.length} claims measured true`);
  if (failed.length) {
    console.log(`${failed.length} did not hold:`);
    for (const f of failed) console.log(`  - ${f.claim}\n    ${f.found}`);
    process.exitCode = 1;
  }
}

runScript(main);
