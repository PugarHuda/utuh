import { AbiCoder, Contract, JsonRpcProvider, Wallet, formatEther, keccak256, concat, toUtf8Bytes } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, source, requirePrivateKey } from './config';
import { artifact, deploy, signer, creditAt, peersOf, registryAt, readDeployments } from './lib/contracts';
import { plainSpec } from './lib/specs';
import { Prover } from './lib/proofs';
import { sendChecked } from './lib/gasLimit';
import { waitForBlock } from './lib/chain';
import { lineStatus } from './lib/status';
import { runScript } from './lib/cli';

/// Default and cure, on chain, with nothing skipped.
///
/// A default that costs nothing but the line it happened on is not a credit event. `defaultsOf`
/// counts the ones still standing and `openLine` refuses while any do; `cure` is the way back, and
/// it demands exactly what `settle` demands. All of that is covered by `test/Lifecycle.t.sol`, but
/// a local test cannot reach `0x0FD2`, and this repository's rule is that the parts which need the
/// precompile are shown on the real chain rather than asserted in prose.
///
///   DEPLOYMENTS=deployments.full.json npm run cure
///
/// It runs against the claims `npm run full` already finalized. Claims are the registry's;
/// `claimSpent`, `underwrittenThrough` and `settledThrough` all belong to the credit contract — so
/// a fresh UtuhCredit over the same registry can underwrite the same history again, which is what
/// makes this cost one deployment and one Sepolia transaction rather than a second full loop.
///
/// The only thing changed from the recorded deployment's policy is the repayment window, which is
/// dropped to the shortest thing a demonstration can wait out. Everything else — the rate, the
/// terms, the specs, the registry — is read off the deployed contract and passed back unchanged.

const DEMO_REPAY_WINDOW = 20n; // ~5 minutes at 15s CC3 blocks
const DRAW = 10n ** 19n; // 10 CTC, the same figure the full flow draws

function derive(master: string, role: string): Wallet {
  return new Wallet(keccak256(concat([master, toUtf8Bytes(role)])));
}

async function main() {
  const d = readDeployments();
  if (!d.registry || !d.credit || !d.decoder) {
    throw new Error(
      'needs a recorded registry, credit and decoder — run: DEPLOYMENTS=deployments.full.json npm run full',
    );
  }
  const [volumeArg, cleanArg, repayArg] = process.argv.slice(2);

  const master = requirePrivateKey();
  const lender = signer(CC3_RPC, CC3_CHAIN_ID, master);
  const cc3 = lender.provider as JsonRpcProvider;
  const borrower = derive(master, 'utuh/borrower');
  const borrowerCc3 = borrower.connect(cc3);

  const old = creditAt(d.credit, lender);
  const registry = registryAt(d.registry, lender);
  const sourceChainKey = Number(d.sourceChainKey ?? (await old.volumeSpec()).chainKey);
  const eth = source(sourceChainKey);
  const borrowerEth = borrower.connect(eth);

  console.log(`lender    ${lender.address}`);
  console.log(`borrower  ${borrower.address}`);
  console.log(`registry  ${d.registry}`);

  // ------------------------------------------------------------------
  // Which claims to underwrite on. The recorded loop leaves a finalized volume claim and a
  // finalized empty clean claim; find them rather than making the operator remember two ids.
  const { volumeClaimId, cleanClaimId, repayClaimId } = await findClaims(registry, old, borrower.address, {
    ...(volumeArg ? { volume: BigInt(volumeArg) } : {}),
    ...(cleanArg ? { clean: BigInt(cleanArg) } : {}),
    ...(repayArg ? { repay: BigInt(repayArg) } : {}),
  });
  console.log(`claims    volume ${volumeClaimId}, clean ${cleanClaimId}, repayment ${repayClaimId}`);

  // ------------------------------------------------------------------
  console.log('\n=== 1. a lender whose patience is measured in minutes ===');
  const policy = {
    volumeUnitInCtc: await old.VOLUME_UNIT_IN_CTC(),
    minUnderwritingWindow: await old.MIN_UNDERWRITING_WINDOW(),
    minHistoryBlocks: await old.MIN_HISTORY_BLOCKS(),
    maxStalenessBlocks: await old.MAX_STALENESS_BLOCKS(),
    repaymentBps: await old.REPAYMENT_BPS(),
    repayWindowBlocks: DEMO_REPAY_WINDOW,
    // Read off the contract this one stands in for, so a lender that honoured someone else's
    // books goes on honouring them in the demonstration.
    peers: await peersOf(old),
  };
  const clean = [];
  for (let i = 0; i < Number(await old.cleanSpecCount()); i++) clean.push(plainSpec(await old.cleanSpecAt(i)));
  const args = [d.registry, policy, plainSpec(await old.volumeSpec()), clean, plainSpec(await old.repaySpec())];

  const credit = await deploy(lender, artifact('UtuhCredit.sol', 'UtuhCredit'), args, { EvmV1Decoder: d.decoder });
  const creditAddress = await credit.getAddress();
  console.log(`  UtuhCredit ${creditAddress}`);
  console.log(`  repayment window ${await credit.REPAY_WINDOW_BLOCKS()} CC3 blocks, everything else as deployed`);
  console.log(
    `  constructor args ${AbiCoder.defaultAbiCoder()
      .encode(
        artifact('UtuhCredit.sol', 'UtuhCredit').abi.find((f: { type: string }) => f.type === 'constructor').inputs,
        args,
      )
      .slice(0, 18)}…`,
  );

  const asBorrower = creditAt(creditAddress, borrowerCc3);

  // ------------------------------------------------------------------
  console.log('\n=== 2. the borrower binds their address to this lender ===');
  // `controlProofUsed` is this contract's own mapping, so the commitment has to be a new one — and
  // it must be, because a binding that could be replayed onto a fresh contract by anyone else
  // would not be a binding.
  const commitment: string = await credit.controlCommitment(borrower.address);
  const bindTx = await borrowerEth.sendTransaction({ to: borrower.address, value: 0n, data: commitment });
  const bindReceipt = await bindTx.wait();
  console.log(`  sent from ${borrower.address} in source block ${bindReceipt!.blockNumber}`);

  const prover = Prover.withDefaults(sourceChainKey, 60_000);
  try {
    await prover.waitAttested(bindReceipt!.blockNumber);
    const bindProof = await prover.proveOne({
      blockNumber: bindReceipt!.blockNumber,
      txHash: bindTx.hash,
      txIndex: bindReceipt!.index,
      logIndexInTx: 0,
      value: 0n,
    });
    await (
      await sendChecked(
        asBorrower,
        'proveControl',
        [
          {
            chainKey: sourceChainKey,
            blockHeight: bindProof.proof.blockHeight,
            encodedTransaction: bindProof.proof.encodedTransaction,
            merkleRoot: bindProof.proof.merkleRoot,
            siblings: bindProof.proof.siblings,
          },
          bindProof.continuity,
        ],
        { members: 0, log: (m) => console.log(m) },
      )
    ).wait();
  } finally {
    prover.close();
  }
  console.log(`  controllerOf(${borrower.address}) = ${await credit.controllerOf(borrower.address)}`);

  // ------------------------------------------------------------------
  console.log('\n=== 3. the line opens on history the registry already holds ===');
  await (await asBorrower.openLine(borrower.address, volumeClaimId, [cleanClaimId])).wait();
  const lineId = 1n;
  let line = await credit.line(lineId);
  console.log(`  limit ${formatEther(line.limit)} CTC`);
  console.log(`  underwrittenThrough(${borrower.address}) = ${await credit.underwrittenThrough(borrower.address)}`);

  const draw = DRAW < line.limit ? DRAW : line.limit;
  await (await credit.fund({ value: draw })).wait();
  await (await asBorrower.draw(lineId, draw)).wait();
  line = await credit.line(lineId);
  console.log(`  drew ${formatEther(line.drawn)} CTC, owes ${line.repayRequired} source units`);
  console.log(`  due at CC3 block ${line.dueBlock}`);

  // ------------------------------------------------------------------
  console.log('\n=== 4. the deadline passes and nothing is proven ===');
  await waitForBlock(cc3, Number(line.dueBlock) + 1, { label: 'CC3 block' });
  await (await credit.markDefault(lineId)).wait();
  line = await credit.line(lineId);
  console.log(`  line ${lineId}: ${lineStatus(line.status)}`);
  console.log(`  defaultsOf(${borrower.address}) = ${await credit.defaultsOf(borrower.address)}`);

  // The guard that makes a default cost more than the line it happened on. Asked, not asserted:
  // openLine checks the caller's binding and then the standing defaults, both before it looks at
  // a single claim, so any ids at all reach the refusal.
  await expectRevert('opening another line while a default stands', 'SubjectInDefault', () =>
    asBorrower.openLine.staticCall(borrower.address, volumeClaimId, [cleanClaimId]),
  );

  // ------------------------------------------------------------------
  console.log('\n=== 5. the borrower proves the repayment late ===');
  console.log(`  curing with claim ${repayClaimId}, which the registry finalized during the full loop`);
  const cureTx = await asBorrower.cure(lineId, repayClaimId);
  const cured = await cureTx.wait();
  line = await credit.line(lineId);
  console.log(`  line ${lineId}: ${lineStatus(line.status)}   (tx ${cured!.hash})`);
  console.log(`  defaultsOf(${borrower.address}) = ${await credit.defaultsOf(borrower.address)}`);
  console.log(`  settledThrough(${borrower.address}) = ${await credit.settledThrough(borrower.address)}`);

  if (Number(line.status) !== 2) throw new Error('a cured line should read Settled');
  if ((await credit.defaultsOf(borrower.address)) !== 0n) throw new Error('the default should no longer stand');

  // And the record is clear enough to borrow against again — refused now for a different reason,
  // which is worth showing rather than glossing. Two guards stack here and the claim's is reached
  // first: `openLine` marks each claim spent before it looks at the history watermark, so reusing
  // these two says ClaimAlreadySpent. `underwrittenThrough` is what would refuse a *fresh* pair of
  // claims built over the same range, which is the path `test_theSameHistoryCannotUnderwriteTwice`
  // covers, because building a second pair here would cost two more bonds and two more windows to
  // demonstrate a guard that has already been demonstrated.
  await expectRevert('the same claims opening a second line', 'ClaimAlreadySpent', () =>
    asBorrower.openLine.staticCall(borrower.address, volumeClaimId, [cleanClaimId]),
  );
  console.log(
    `  underwrittenThrough(${borrower.address}) = ${await credit.underwrittenThrough(borrower.address)} — ` +
      `a fresh claim over that range would be refused too`,
  );

  console.log('\nA default recorded, then made good on the terms it was owed. Nothing was forgiven');
  console.log('for being late, and nothing stays held against a borrower who paid.');
}

/// The claims a cure needs, found on the registry rather than remembered by the operator.
///
/// A volume claim and an empty clean claim over the same range, both finalized and both about this
/// borrower; and a finalized repayment claim starting after them. Any of the three can be pinned
/// by argument when the registry holds more than one candidate.
async function findClaims(
  registry: Contract,
  credit: Contract,
  subject: string,
  pinned: { volume?: bigint; clean?: bigint; repay?: bigint },
): Promise<{ volumeClaimId: bigint; cleanClaimId: bigint; repayClaimId: bigint }> {
  const volumeScopeId = await credit.expectedScope(plainSpec(await credit.volumeSpec()), subject);
  const cleanScopeId = await credit.expectedScope(plainSpec(await credit.cleanSpecAt(0)), subject);
  const idOf = (s: { chainKey: bigint; emitter: string; eventSig: string }) =>
    `${s.chainKey}|${s.emitter.toLowerCase()}|${s.eventSig.toLowerCase()}`;

  const next = Number(await registry.nextClaimId());
  let volume: bigint | undefined = pinned.volume;
  let clean: bigint | undefined = pinned.clean;
  let repay: bigint | undefined = pinned.repay;
  let volumeTo = 0n;

  for (let i = 1n; i < BigInt(next); i++) {
    const c = await registry.claim(i);
    if (Number(c.status) !== 3) continue; // Finalized only
    const scope = idOf(c.scope);
    const members = await registry.memberCount(i);
    if (volume === undefined && scope === idOf(volumeScopeId) && members > 0n && c.aggregate > 0n) {
      volume = i;
      volumeTo = c.toBlock;
    } else if (clean === undefined && scope === idOf(cleanScopeId) && members === 0n) {
      clean = i;
    } else if (
      repay === undefined &&
      scope === idOf(volumeScopeId) &&
      volume !== undefined &&
      c.fromBlock >= volumeTo
    ) {
      repay = i;
    }
  }

  if (volume === undefined || clean === undefined || repay === undefined) {
    throw new Error(
      `this registry does not hold the three finalized claims a cure needs (volume=${volume}, ` +
        `clean=${clean}, repayment=${repay}). Run npm run full first, or pass the ids: ` +
        `npm run cure -- <volume> <clean> <repayment>`,
    );
  }
  return { volumeClaimId: volume, cleanClaimId: clean, repayClaimId: repay };
}

async function expectRevert(what: string, error: string, call: () => Promise<unknown>): Promise<void> {
  try {
    await call();
  } catch (e: unknown) {
    const named = String(
      (e as { revert?: { name?: string }; shortMessage?: string; message?: string }).revert?.name ?? '',
    );
    const text = String((e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message);
    if (named === error || text.includes(error)) {
      console.log(`  ${what} → ${error}`);
      return;
    }
    throw e;
  }
  throw new Error(`${what} was allowed, and should have reverted with ${error}`);
}

runScript(main);
