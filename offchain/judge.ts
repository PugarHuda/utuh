import { Contract, Wallet, formatEther } from 'ethers';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { CC3_RPC, cc3 } from './config';
import {
  ATTESTATION_INDEXERS,
  CC3_CHAIN_ID,
  CHAIN_INFO_ADDRESS,
  ORACLE_DASHBOARD,
  type DeploymentName,
} from './lib/networks';
import { verifiedIn, verifiedTotal } from './lib/attestations';
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
  foundryTests: 193,
  commits: 156,
  claimsRefuted: 33,
  /// TransactionVerified events the network's indexer attributes to the listed addresses.
  verified: 224,
};

/// A contract nobody here wrote the rules for, that reads Utuh anyway: `examples/completeness-gate`.
/// The address is the one fact quoted; what lives there, whether its source is published, and what
/// it is wired to are all read live below.
const CONSUMER = {
  name: 'NeverLiquidatedGate',
  address: '0xcA6228C30607F26253Fffc2A4013a801DEEB5D09',
  /// The allowance it granted on a finalized mainnet-sourced claim, and the transaction that did it.
  claimId: 72,
  grant: '0x82fe073a1de45d11e644ec1147630303851d87253a3c276ced6ec9d151e01a53',
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

/// Every transaction sent to an address, by hash, following Blockscout's paging to the end.
async function transactionsTo(address: string): Promise<string[]> {
  const out: string[] = [];
  let page = '';
  for (;;) {
    const r = await json<{ items: { hash: string }[]; next_page_params: Record<string, unknown> | null }>(
      `${BLOCKSCOUT}/addresses/${address}/transactions?filter=to${page}`,
    );
    out.push(...r.items.map((i) => i.hash));
    if (!r.next_page_params) return out;
    page = '&' + new URLSearchParams(Object.entries(r.next_page_params).map(([k, v]) => [k, String(v)])).toString();
  }
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
    let verified: string;
    let matched: string;
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

  // ── A third-party consumer is deployed, verified, and reads the published contracts ──────────
  {
    const code = await provider.getCode(CONSUMER.address);
    // Blockscout rate-limits silently, so one refusal is asked again before it is called unknown.
    let bs: { is_verified?: boolean; name?: string } | null = null;
    for (let i = 0; i < 3 && !bs; i++) {
      bs = await json<{ is_verified?: boolean; name?: string }>(
        `${BLOCKSCOUT}/smart-contracts/${CONSUMER.address}`,
      ).catch(() => null);
      if (!bs) await new Promise((r) => setTimeout(r, 3000));
    }
    const gate = new Contract(
      CONSUMER.address,
      [
        'function REGISTRY() view returns (address)',
        'function CONTROL() view returns (address)',
        'function MIN_HISTORY_BLOCKS() view returns (uint64)',
        'function claimUsed(uint256) view returns (bool)',
      ],
      provider,
    );
    let wired = 'not read';
    let wiredOk = false;
    try {
      // The history floor is compared with the mainnet-sourced credit line's own, read now: the gate
      // is meant to ask no less of a claim than the lender it sits beside.
      const lender = new Contract(
        mainnetRecord.credit,
        ['function MIN_HISTORY_BLOCKS() view returns (uint64)'],
        provider,
      );
      const [registry, control, floor, lenderFloor] = await Promise.all([
        gate.REGISTRY(),
        gate.CONTROL(),
        gate.MIN_HISTORY_BLOCKS(),
        lender.MIN_HISTORY_BLOCKS(),
      ]);
      wiredOk =
        String(registry).toLowerCase() === mainnetRecord.registry.toLowerCase() &&
        String(control).toLowerCase() === sepoliaRecord.credit.toLowerCase() &&
        floor === lenderFloor;
      wired = `REGISTRY() ${registry}, CONTROL() ${control}, MIN_HISTORY_BLOCKS ${floor} (the credit line's ${lenderFloor})`;
    } catch (e) {
      wired = `wiring unreadable (${(e as Error).message.slice(0, 40)})`;
    }
    note(
      `${CONSUMER.name}, a consumer outside the protocol, is deployed and verified at ${CONSUMER.address} and reads the ` +
        'mainnet-sourced registry and the Sepolia-sourced credit line',
      `${code !== '0x' ? `${(code.length - 2) / 2} bytes of code` : 'NO CODE'}; ` +
        `${bs ? `Blockscout: ${bs.is_verified ? 'verified' : 'NOT verified'} as ${bs.name ?? '?'}` : 'Blockscout unreachable — unknown, not unverified'}; ` +
        wired,
      code !== '0x' && bs?.is_verified === true && bs.name === CONSUMER.name && wiredOk,
    );

    // And it has acted on one: the grant succeeded, spent the claim, and the claim is Finalized on the
    // registry the submission lists — so a contract outside the protocol underwrote on Utuh's word.
    let used: boolean | string = 'not read';
    let status = 'not read';
    let receiptOk = false;
    try {
      const [receipt, spent, claim] = await Promise.all([
        provider.getTransactionReceipt(CONSUMER.grant),
        gate.claimUsed(CONSUMER.claimId),
        new Contract(mainnetRecord.registry, registryArtifact.abi, provider).claim(CONSUMER.claimId),
      ]);
      receiptOk = receipt?.status === 1 && receipt.to?.toLowerCase() === CONSUMER.address.toLowerCase();
      used = spent as boolean;
      status = claimStatus(claim.status);
    } catch (e) {
      status = `unreadable (${(e as Error).message.slice(0, 40)})`;
    }
    note(
      `${CONSUMER.name} granted an allowance on mainnet-sourced claim ${CONSUMER.claimId}, which is Finalized`,
      `grant ${CONSUMER.grant.slice(0, 12)}… ${receiptOk ? 'succeeded, sent to the gate' : 'NOT a successful call to the gate'}; ` +
        `claimUsed(${CONSUMER.claimId}) ${used}; registry claim ${CONSUMER.claimId} ${status}`,
      receiptOk && used === true && status === 'Finalized',
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

  // ── The oracle's own count of what Utuh proved, not Utuh's count of itself ────────────────────
  // The registries say how many events they hold. The network's attestation indexer says how many
  // `TransactionVerified` events the Block Prover emitted inside the registries' transactions —
  // the same number, kept by somebody else. Blockscout pages the hashes; the indexer counts them.
  try {
    const hashes: string[] = [];
    for (const address of [
      sepoliaRecord.registry,
      sepoliaRecord.credit,
      mainnetRecord.registry,
      mainnetRecord.credit,
    ]) {
      hashes.push(...(await transactionsTo(address)));
    }
    const [mine, total] = await Promise.all([
      verifiedIn(ATTESTATION_INDEXERS.testnet, hashes),
      verifiedTotal(ATTESTATION_INDEXERS.testnet),
    ]);
    note(
      `at least ${QUOTED.verified} TransactionVerified events the network's indexer attributes to the listed addresses`,
      `${mine} of ${total.toLocaleString()} ever recorded on CC3 Testnet (${((100 * mine) / total).toFixed(2)}%), across ` +
        `${hashes.length} transactions; the registries hold ${proven} members and ${refuted} refutations, one ` +
        `verification each, and the rest are proveControl bindings`,
      mine >= QUOTED.verified && BigInt(mine) >= proven + BigInt(refuted),
    );
  } catch (e) {
    note(
      `at least ${QUOTED.verified} TransactionVerified events the network's indexer attributes to the listed addresses`,
      `unknown, not zero: ${(e as Error).message.slice(0, 80)}`,
      false,
    );
  }

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
    // The number a stranger sees: `forge test` reports invariant campaigns as one test each, so
    // it prints 193 where `--list` counts 203 functions. The prose quotes what the run prints,
    // and so does this. The suite takes about three seconds.
    const run = execFileSync('forge', ['test'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = run.match(/(\d+) tests? passed, (\d+) failed, \d+ skipped \((\d+) total tests?\)/);
    const tests = m ? Number(m[3]) : NaN;
    const failedTests = m ? Number(m[2]) : NaN;
    note(
      `at least ${QUOTED.foundryTests} Foundry tests`,
      m ? `forge test → ${tests} total, ${failedTests} failed` : 'forge test printed no summary line',
      tests >= QUOTED.foundryTests && failedTests === 0,
    );
  } catch {
    note(`at least ${QUOTED.foundryTests} Foundry tests`, 'forge not on PATH — install Foundry to count them', false);
  }
  try {
    // A shallow clone — CI's default checkout — has one commit and would call the sentence false.
    // The history is public, so ask GitHub for the count instead: `per_page=1` makes the `last`
    // page number in the Link header the number of commits.
    const shallow =
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true';
    if (shallow) {
      const res = await fetch('https://api.github.com/repos/PugarHuda/utuh/commits?per_page=1&sha=master', {
        signal: AbortSignal.timeout(20_000),
        headers: { 'user-agent': 'utuh-judge' },
      });
      const last = (res.headers.get('link') ?? '').match(/[?&]page=(\d+)>;\s*rel="last"/);
      const commits = last ? Number(last[1]) : NaN;
      note(
        `at least ${QUOTED.commits} commits, built in the open`,
        Number.isFinite(commits)
          ? `shallow clone; GitHub counts ${commits} on master`
          : `shallow clone and GitHub answered ${res.status}`,
        commits >= QUOTED.commits,
      );
    } else {
      const commits = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim());
      note(
        `at least ${QUOTED.commits} commits, built in the open`,
        `git rev-list --count HEAD → ${commits}`,
        commits >= QUOTED.commits,
      );
    }
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
