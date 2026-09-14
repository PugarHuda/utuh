// Read a Utuh claim's standing the way a frontend would: plain views, no key, no proofs.
// Usage: npx tsx read.ts [claimId] [exposureCTC]
import { Contract, JsonRpcProvider, formatEther, parseEther } from 'ethers';

const RPC = process.env.CC3_RPC ?? 'https://rpc.cc3-testnet.creditcoin.network';
const REGISTRY = '0x8FA0BD5301D998Be873E31453E53d114929a5Fac'; // mainnet-sourced registry
const STATUS = ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'];

const registry = new Contract(
  REGISTRY,
  [
    'function claim(uint256) view returns (tuple(address claimant, uint8 status, uint64 fromBlock, uint64 toBlock, uint64 sealedAt, uint64 challengeWindow, uint256 bond, uint256 bondPosted, uint256 aggregate, uint256 lastKey, tuple(uint64 chainKey, address emitter, bytes32 eventSig, bytes32[3] topics, uint8 topicMask, uint8 metric, uint8 metricArg) scope))',
    'function memberCount(uint256) view returns (uint256)',
    'function enforceableLoss(uint256) view returns (uint256)',
    'function isUsable(uint256, uint256) view returns (bool)',
    'function challengeUntil(uint256) view returns (uint64)',
  ],
  new JsonRpcProvider(RPC, 102031, { staticNetwork: true }),
);

const id = BigInt(process.argv[2] ?? 72);
const exposure = parseEther(process.argv[3] ?? '0.5');

const [c, members, loss, usable, until, now] = await Promise.all([
  registry.claim(id),
  registry.memberCount(id),
  registry.enforceableLoss(id),
  registry.isUsable(id, exposure),
  registry.challengeUntil(id),
  registry.runner!.provider!.getBlockNumber(),
]);
const s = c.scope;
const pinned = [0, 1, 2].filter((i) => (Number(s.topicMask) >> i) & 1).map((i) => `topic${i + 1}=${s.topics[i]}`);

console.log(`claim ${id}: ${STATUS[Number(c.status)]}, ${members} member(s)`);
console.log(`  scope    chainKey ${s.chainKey}, emitter ${s.emitter}, event ${s.eventSig}`);
console.log(`           ${pinned.join(', ') || 'no topics pinned'}`);
console.log(`  range    source blocks ${c.fromBlock}..${c.toBlock} (${c.toBlock - c.fromBlock} blocks)`);
console.log(`  window   ${c.challengeWindow} CC3 blocks, until ${until} (now ${now})`);
console.log(`  bond     ${formatEther(c.bondPosted)} CTC posted, enforceableLoss ${formatEther(loss)} CTC`);
console.log(`  isUsable(${formatEther(exposure)} CTC) = ${usable}`);
