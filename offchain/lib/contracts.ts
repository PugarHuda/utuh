import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, ContractFactory, Wallet, JsonRpcProvider } from 'ethers';

const ROOT = join(__dirname, '..', '..');
const OUT = join(ROOT, 'out');
/// Which deployment record to read and write.
///
/// `npm run full` writes its own to deployments.full.json, and until now nothing could read it —
/// so verifying that deployment meant reconstructing its constructor arguments by hand, which is
/// exactly what recording them was supposed to prevent. `DEPLOYMENTS=deployments.full.json npm run
/// verify` now works.
const DEPLOYMENTS = join(ROOT, process.env.DEPLOYMENTS ?? 'deployments.json');

export interface Artifact {
  abi: any[];
  bytecode: { object: string; linkReferences?: Record<string, Record<string, { start: number; length: number }[]>> };
}

export function artifact(file: string, name: string): Artifact {
  const path = join(OUT, file, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing artifact ${path} — run: forge build`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/// EvmV1Decoder exposes `public` library functions, so it is a deployed library reached by
/// delegatecall rather than inlined code. Its address has to be patched into the consumer's
/// bytecode at the offsets the compiler recorded.
function link(art: Artifact, libraries: Record<string, string>): string {
  let hex = art.bytecode.object;
  const refs = art.bytecode.linkReferences ?? {};
  for (const [, byName] of Object.entries(refs)) {
    for (const [libName, spots] of Object.entries(byName)) {
      const addr = libraries[libName];
      if (!addr) throw new Error(`no address supplied for library ${libName}`);
      const clean = addr.toLowerCase().replace(/^0x/, '');
      for (const spot of spots) {
        const start = 2 + spot.start * 2;
        hex = hex.slice(0, start) + clean + hex.slice(start + spot.length * 2);
      }
    }
  }
  if (hex.includes('__$')) throw new Error('bytecode still has unresolved library placeholders');
  return hex;
}

export async function deploy(
  wallet: Wallet,
  art: Artifact,
  args: any[] = [],
  libraries: Record<string, string> = {},
): Promise<Contract> {
  const bytecode = link(art, libraries);
  const factory = new ContractFactory(art.abi, bytecode, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract as unknown as Contract;
}

export function signer(rpc: string, chainId: number, privateKey: string): Wallet {
  const provider = new JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  return new Wallet(privateKey, provider);
}

export interface Deployments {
  decoder?: string;
  registry?: string;
  credit?: string;
  chainId?: number;
  deployer?: string;
  /// ABI-encoded constructor arguments, exactly as they were passed.
  ///
  /// `npm run verify` has to reproduce these byte for byte or Blockscout rejects the source. It
  /// used to rebuild them from the same environment defaults `deploy.ts` reads, which works right
  /// up until someone deploys with `VOLUME_UNIT_IN_CTC` set and verifies without it — at which
  /// point verification fails and nothing says why. A deployment should remember what it was.
  registryArgs?: string;
  creditArgs?: string;
  /// Written by `npm run full`, which also deploys a SettlementLedger on the source chain and
  /// records which chain that was. `npm run verify` reads them so verifying that deployment does
  /// not mean remembering an address and a chain key by hand.
  ledger?: string;
  sourceChainKey?: number;
  challengeWindow?: number;
}

export function readDeployments(): Deployments {
  if (!existsSync(DEPLOYMENTS)) return {};
  return JSON.parse(readFileSync(DEPLOYMENTS, 'utf8'));
}

export function writeDeployments(d: Deployments): void {
  writeFileSync(DEPLOYMENTS, JSON.stringify(d, null, 2) + '\n');
}

export function registryAt(address: string, wallet: Wallet): Contract {
  return new Contract(address, artifact('UtuhRegistry.sol', 'UtuhRegistry').abi, wallet);
}

export function creditAt(address: string, wallet: Wallet): Contract {
  return new Contract(address, artifact('UtuhCredit.sol', 'UtuhCredit').abi, wallet);
}
