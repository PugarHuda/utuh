import { Contract } from 'ethers';
import { claimStatus } from '../offchain/lib/status';
import { DEPLOYMENT_RECORDS, type DeploymentName } from '../offchain/lib/networks';
import { cc3, loadDeployments, within, type Abis } from './chain';

/// Reads both the landing page and the console make, so the two pages cannot disagree about what
/// the registries hold. Everything here is an `eth_call` from the visitor's browser.

/// How many claims to read at once. Public endpoints rate-limit, so this is a batch, not a flood.
export const CLAIM_BATCH = 12;

export interface Tally {
  proven: bigint;
  sealed: number;
  refuted: number;
  burned: bigint;
  /// The newest claim a stranger could still break, and where it lives.
  openNow?: { which: DeploymentName; id: number; blocksLeft: number };
}

export function registryOn(abis: Abis, address: string): Contract {
  return new Contract(address, abis.registry as never, cc3);
}

/// Four numbers summed across both deployments. The refutation count is the only one of its
/// kind on this protocol: nothing else deployed against Attestcoin has a refutation to count.
export async function readTally(abis: Abis): Promise<Tally> {
  const names = Object.keys(DEPLOYMENT_RECORDS) as DeploymentName[];
  const registries = await Promise.all(
    names.map(async (which) => {
      const d = await within(30_000, `${which} deployment record`, loadDeployments(which));
      return d.registry ? registryOn(abis, d.registry) : null;
    }),
  );

  const tally: Tally = { proven: 0n, sealed: 0, refuted: 0, burned: 0n };
  const head = await within(30_000, 'block number', cc3.getBlockNumber());

  for (const [at, registry] of registries.entries()) {
    if (!registry) continue;
    const which = names[at]!;
    const total = Number(await within(30_000, 'nextClaimId', registry.nextClaimId() as Promise<bigint>)) - 1;
    tally.burned += await within(30_000, 'burned', registry.burned() as Promise<bigint>);
    tally.sealed += total;

    const ids = Array.from({ length: total }, (_, i) => i + 1);
    for (let from = 0; from < ids.length; from += CLAIM_BATCH) {
      const slice = await Promise.all(
        ids.slice(from, from + CLAIM_BATCH).map(async (i) => {
          const c = await within(30_000, `claim ${i}`, registry.claim(i));
          return {
            id: i,
            status: Number(c.status),
            until: Number(c.sealedAt) + Number(c.challengeWindow),
            members: await within(30_000, `memberCount ${i}`, registry.memberCount(i) as Promise<bigint>),
          };
        }),
      );
      for (const c of slice) {
        tally.proven += c.members;
        if (claimStatus(c.status) === 'Refuted') tally.refuted += 1;
        if (claimStatus(c.status) === 'Sealed' && c.until > head) {
          const left = c.until - head;
          if (!tally.openNow || left > tally.openNow.blocksLeft)
            tally.openNow = { which, id: c.id, blocksLeft: left };
        }
      }
    }
  }
  return tally;
}

export interface Refutation {
  refuter: string;
  omittedBlock: number;
  reward: bigint;
  tx: string;
  cc3Block: number;
}

/// Who broke a claim, with what, and what it paid. `ClaimRefuted` is the registry's own record of
/// the finding; it can only have landed inside the challenge window, so the log query is bounded
/// to those blocks rather than asked of the whole chain.
export async function readRefutation(
  registry: Contract,
  id: bigint | number,
  sealedAt: number,
  challengeWindow: number,
): Promise<Refutation | undefined> {
  const from = sealedAt;
  const to = sealedAt + challengeWindow + 1;
  const logs = await within(
    30_000,
    `refutation of claim ${id}`,
    registry.queryFilter(registry.filters.ClaimRefuted!(id), from, to),
  );
  const log = logs[0];
  if (!log || !('args' in log)) return undefined;
  const a = log.args as unknown as { refuter: string; omittedKey: bigint; reward: bigint };
  return {
    refuter: a.refuter,
    omittedBlock: Number(a.omittedKey >> 96n),
    reward: a.reward,
    tx: log.transactionHash,
    cc3Block: log.blockNumber,
  };
}

/// A claim as a schedule: its scope, its members by source block, and its finding if broken.
export interface Schedule {
  id: number;
  which: DeploymentName;
  claimant: string;
  status: string;
  fromBlock: number;
  toBlock: number;
  chainKey: number;
  emitter: string;
  members: number;
  memberBlocks: number[];
  aggregate: bigint;
  bondPosted: bigint;
  refutation?: Refutation;
}

export async function readSchedule(
  abis: Abis,
  which: DeploymentName,
  id: number,
  maxMembers = 40,
): Promise<Schedule> {
  const d = await within(30_000, `${which} deployment record`, loadDeployments(which));
  if (!d.registry) throw new Error(`no registry recorded for ${which}`);
  const registry = registryOn(abis, d.registry);
  const [c, count] = await Promise.all([
    within(30_000, `claim ${id}`, registry.claim(id)),
    within(30_000, `memberCount ${id}`, registry.memberCount(id) as Promise<bigint>),
  ]);
  const shown = Math.min(Number(count), maxMembers);
  const keys = await Promise.all(
    Array.from({ length: shown }, (_, i) =>
      within(30_000, `keyAt ${id}/${i}`, registry.keyAt(id, i) as Promise<bigint>),
    ),
  );
  const status = claimStatus(c.status);
  const refutation =
    status === 'Refuted'
      ? await readRefutation(registry, id, Number(c.sealedAt), Number(c.challengeWindow)).catch(() => undefined)
      : undefined;
  return {
    id,
    which,
    claimant: c.claimant,
    status,
    fromBlock: Number(c.fromBlock),
    toBlock: Number(c.toBlock),
    chainKey: Number(c.scope.chainKey),
    emitter: c.scope.emitter,
    members: Number(count),
    memberBlocks: keys.map((k) => Number(k >> 96n)),
    aggregate: c.aggregate,
    bondPosted: c.bondPosted,
    ...(refutation ? { refutation } : {}),
  };
}
