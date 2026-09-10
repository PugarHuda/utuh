import { Contract, keccak256, solidityPacked, toBeHex, zeroPadValue } from 'ethers';

/// A claim's members, and the witness that a key is not among them.
///
/// The registry keeps a root over its members rather than the members themselves, and emits every
/// key it accepts in `EventAppended`. So the members of a claim are a log read — bounded by the
/// block the claim was opened at and the block it was sealed at, both of which the claim records —
/// and a refutation carries, beside the proof that the omitted event happened, the two members
/// that bracket its key. This is the browser-safe half: two hashes and some arithmetic, no SDK.
///
/// The tree is the deposit contract's shape at depth 32, leaves left to right, unused positions
/// zero subtrees; `IncrementalMerkle.sol` is the on-chain half and `test/support/Adjacency.sol`
/// is the same construction in Solidity, so three implementations have to agree before a proof
/// is worth sending.

export const DEPTH = 32;

export interface Adjacency {
  index: bigint;
  lower: bigint;
  lowerProof: string[];
  upper: bigint;
  upperProof: string[];
}

const ZERO = '0x' + '00'.repeat(32);

function hash(a: string, b: string): string {
  return keccak256(solidityPacked(['bytes32', 'bytes32'], [a, b]));
}

function leaf(k: bigint): string {
  return zeroPadValue(toBeHex(k), 32);
}

const zeros: string[] = [ZERO];
for (let h = 1; h <= DEPTH; h++) zeros.push(hash(zeros[h - 1]!, zeros[h - 1]!));

/// Node at (height, position) over `keys`, positions past the leaves being zero subtrees.
function node(keys: bigint[], h: number, pos: number, memo: Map<string, string>): string {
  if (h === 0) return pos < keys.length ? leaf(keys[pos]!) : ZERO;
  if (pos * 2 ** h >= keys.length) return zeros[h]!;
  const id = `${h}:${pos}`;
  const seen = memo.get(id);
  if (seen) return seen;
  const v = hash(node(keys, h - 1, pos * 2, memo), node(keys, h - 1, pos * 2 + 1, memo));
  memo.set(id, v);
  return v;
}

/// The root the registry holds for exactly these members, in this order.
export function treeRoot(keys: bigint[]): string {
  return node(keys, DEPTH, 0, new Map());
}

function proofFor(keys: bigint[], index: number, memo: Map<string, string>): string[] {
  const p: string[] = [];
  let pos = index;
  for (let h = 0; h < DEPTH; h++) {
    p.push(node(keys, h, pos ^ 1, memo));
    pos >>= 1;
  }
  return p;
}

const empty = (): string[] => Array.from({ length: DEPTH }, () => ZERO);

/// The witness that `k` is not among `keys` (strictly ascending). For an empty claim no witness
/// is needed and an empty one is returned; for a `k` that *is* a member there is no honest
/// witness, and `null` says so rather than handing back something the registry will refuse.
export function adjacencyFor(keys: bigint[], k: bigint): Adjacency | null {
  const none: Adjacency = { index: 0n, lower: 0n, lowerProof: empty(), upper: 0n, upperProof: empty() };
  const n = keys.length;
  if (n === 0) return none;
  let i = 0;
  while (i < n && keys[i]! < k) i++;
  if (i < n && keys[i] === k) return null;
  const memo = new Map<string, string>();
  if (i === 0) return { ...none, index: 0n, lower: keys[0]!, lowerProof: proofFor(keys, 0, memo) };
  if (i === n) return { ...none, index: BigInt(n - 1), lower: keys[n - 1]!, lowerProof: proofFor(keys, n - 1, memo) };
  return {
    index: BigInt(i - 1),
    lower: keys[i - 1]!,
    lowerProof: proofFor(keys, i - 1, memo),
    upper: keys[i]!,
    upperProof: proofFor(keys, i, memo),
  };
}

/// Every key a claim accepted, in order, read from `EventAppended` between the block the claim
/// was opened at and the block it was sealed at (or the head, while it is still open).
///
/// CC3's RPC gives up on a wide `eth_getLogs`, so the read is chunked the way the watcher's
/// discovery sweep is. The keys come back ascending because the registry refused any other order
/// on the way in; the root is checked against `claimRoot` before they are trusted, so a log
/// endpoint that dropped one cannot hand a refuter a witness that reverts on chain.
export async function memberKeys(registry: Contract, claimId: bigint | number, chunk = 2_000): Promise<bigint[]> {
  const c = await registry.claim(claimId);
  const from = Number(c.openedAt);
  const sealedAt = Number(c.sealedAt);
  const to = sealedAt > 0 ? sealedAt : await registry.runner!.provider!.getBlockNumber();
  const keys: bigint[] = [];
  for (let start = from; start <= to; start += chunk) {
    const end = Math.min(start + chunk - 1, to);
    const logs = await registry.queryFilter(registry.filters.EventAppended(claimId), start, end);
    for (const log of logs) keys.push((log as { args: bigint[] }).args[1]!);
  }
  const expected: string = await registry.claimRoot(claimId);
  const got = treeRoot(keys);
  if (got !== expected) {
    throw new Error(
      `the ${keys.length} EventAppended key(s) read for claim ${claimId} fold to ${got.slice(0, 12)}…, ` +
        `the registry holds ${expected.slice(0, 12)}… — the log endpoint dropped or reordered one`,
    );
  }
  return keys;
}
