import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  formatEther,
  getAddress,
  id,
  keccak256,
  parseEther,
  toUtf8Bytes,
  concat,
  ZeroAddress,
} from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, CHAIN_KEY, source, requirePrivateKey } from './config';
import { writeFileSync } from 'node:fs';
import { artifact, deploy, signer, registryAt, creditAt } from './lib/contracts';
import { scopeFor, scanScope, Metric, type Scope } from './lib/scope';
import { Prover } from './lib/proofs';
import { buildClaim, refuteClaim, sweepForClaim } from './lib/claims';

/// The whole product, end to end, with two parties who actually act.
///
/// The mainnet demonstration (npm run credit) reads Aave, because that is where real borrowers
/// already have real histories — and it stops at SubjectNotControlled, correctly, because nobody
/// can prove control of a stranger's address. This flow closes the loop instead: a borrower we
/// control transacts on Sepolia, binds their address, is underwritten on what they did, draws, and
/// repays. Every event is a real log in a real block, proven by the same precompile.

const SOURCE = CHAIN_KEY.sepolia;
const CHALLENGE_WINDOW = 20; // the registry's absolute floor; ~5 minutes at 15s CC3 blocks
const BOND = parseEther('2');

const SETTLED_SIG = id('Settled(address,address,uint256)');
const ADVERSE_SIG = id('Adverse(address,uint256)');

const SETTLEMENT = parseEther('0.001');
const BORROWER_SEPOLIA = parseEther('0.012');
const BORROWER_CTC = parseEther('12');
const DEFAULTER_CTC = parseEther('4');

/// wei of CTC per wei of settled ether. Three settlements of 0.001 ETH at 20000 give a headline
/// limit of 12 CTC, which the bond cap then has something to actually bite on.
const RATE = 20_000n;

/// Deterministic side accounts, so a rerun reuses the same two parties instead of stranding funds
/// in fresh ones. Same key material, different roles — nothing here is a shared secret.
function derive(master: string, role: string): Wallet {
  return new Wallet(keccak256(concat([master, toUtf8Bytes(role)])));
}

async function main() {
  const master = requirePrivateKey();
  const lender = signer(CC3_RPC, CC3_CHAIN_ID, master);
  const cc3 = lender.provider as JsonRpcProvider;
  const eth = source(SOURCE);

  const lenderEth = new Wallet(master, eth);
  const borrower = derive(master, 'utuh/borrower');
  const defaulter = derive(master, 'utuh/defaulter');
  const borrowerCc3 = borrower.connect(cc3);
  const borrowerEth = borrower.connect(eth);
  const defaulterCc3 = defaulter.connect(cc3);

  console.log('lender    ', lender.address);
  console.log('borrower  ', borrower.address);
  console.log('defaulter ', defaulter.address);
  console.log();

  // ------------------------------------------------------------------
  console.log('=== 1. funding the parties ===');
  await topUpSepolia(lenderEth, borrower.address, BORROWER_SEPOLIA);
  await topUpCtc(lender, borrower.address, BORROWER_CTC);
  await topUpCtc(lender, defaulter.address, DEFAULTER_CTC);

  // ------------------------------------------------------------------
  console.log('\n=== 2. the source chain ===');
  const ledgerArtifact = artifact('SettlementLedger.sol', 'SettlementLedger');
  const ledger = await deploy(lenderEth, ledgerArtifact);
  const ledgerAddress = await ledger.getAddress();
  console.log(`  SettlementLedger on Sepolia at ${ledgerAddress}`);

  const asBorrower = new Contract(ledgerAddress, ledgerArtifact.abi, borrowerEth);
  const blocks: number[] = [];
  for (let i = 0; i < 3; i++) {
    const tx = await asBorrower.settle(lender.address, { value: SETTLEMENT });
    const r = await tx.wait();
    blocks.push(r!.blockNumber);
    console.log(`  settlement ${i + 1}: ${formatEther(SETTLEMENT)} ETH paid to the lender, block ${r!.blockNumber}`);
  }

  const adverseTx = await (ledger as any).recordAdverse(defaulter.address, parseEther('0.5'));
  const adverseReceipt = await adverseTx.wait();
  console.log(`  adverse event recorded against the defaulter, block ${adverseReceipt.blockNumber}`);

  const fromBlock = Math.min(...blocks) - 2;
  const toBlock = Math.max(...blocks, adverseReceipt.blockNumber) + 2;
  console.log(`  underwriting range ${fromBlock}..${toBlock}`);

  // ------------------------------------------------------------------
  console.log('\n=== 3. deploying Utuh against this source chain ===');
  const decoder = await deploy(lender, artifact('EvmV1Decoder.sol', 'EvmV1Decoder'));
  const decoderAddress = await decoder.getAddress();
  const registryContract = await deploy(lender, artifact('UtuhRegistry.sol', 'UtuhRegistry'), [CHALLENGE_WINDOW], {
    EvmV1Decoder: decoderAddress,
  });
  const registryAddress = await registryContract.getAddress();

  const volumeSpec = {
    chainKey: SOURCE,
    emitter: ledgerAddress,
    eventSig: SETTLED_SIG,
    subjectTopic: 1,
    counterpartyTopic: 2,
    counterparty: lender.address,
    metric: Metric.DATA_WORD,
    metricArg: 0,
  };
  const cleanSpec = {
    chainKey: SOURCE,
    emitter: ledgerAddress,
    eventSig: ADVERSE_SIG,
    subjectTopic: 1,
    counterpartyTopic: 0,
    counterparty: ZeroAddress,
    metric: Metric.COUNT,
    metricArg: 0,
  };

  const creditContract = await deploy(
    lender,
    artifact('UtuhCredit.sol', 'UtuhCredit'),
    [
      registryAddress,
      {
        volumeUnitInCtc: RATE,
        minUnderwritingWindow: CHALLENGE_WINDOW,
        minHistoryBlocks: 5,
        maxStalenessBlocks: 5000,
        repaymentBps: 10_500, // 105% — principal plus the lender's spread
        repayWindowBlocks: 400,
      },
      volumeSpec,
      [cleanSpec],
      volumeSpec, // repayment is the same relationship, later in time
    ],
    { EvmV1Decoder: decoderAddress },
  );
  const creditAddress = await creditContract.getAddress();
  console.log(`  UtuhRegistry ${registryAddress}`);
  console.log(`  UtuhCredit   ${creditAddress}`);
  console.log(`  EvmV1Decoder ${decoderAddress}`);

  // Write down what was deployed, because a run that only prints it leaves nothing to verify
  // against. The library address in particular is needed to reproduce the bytecode and is not
  // recoverable from anywhere except the linked runtime code itself. Its own file, so a full-flow
  // run never overwrites the deployment the other scripts point at.
  writeFileSync(
    'deployments.full.json',
    JSON.stringify(
      {
        chainId: CC3_CHAIN_ID,
        decoder: decoderAddress,
        registry: registryAddress,
        credit: creditAddress,
        ledger: ledgerAddress,
        sourceChainKey: SOURCE,
        challengeWindow: CHALLENGE_WINDOW,
        deployer: lender.address,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('  written to deployments.full.json');

  const registry = registryAt(registryAddress, lender);
  const registryAsBorrower = registryAt(registryAddress, borrowerCc3);
  const registryAsDefaulter = registryAt(registryAddress, defaulterCc3);
  const credit = creditAt(creditAddress, lender);
  const creditAsBorrower = creditAt(creditAddress, borrowerCc3);

  const prover = Prover.withDefaults(SOURCE, 60000);

  // ------------------------------------------------------------------
  console.log('\n=== 4. the borrower binds their Sepolia address ===');
  const commitment: string = await credit.controlCommitment(borrower.address);
  console.log(`  calldata ${commitment}`);
  const bindTx = await borrowerEth.sendTransaction({ to: borrower.address, value: 0n, data: commitment });
  const bindReceipt = await bindTx.wait();
  console.log(`  sent from ${borrower.address} in block ${bindReceipt!.blockNumber}`);

  await prover.waitAttested(bindReceipt!.blockNumber);
  const bindProof = await prover.proveOne({
    blockNumber: bindReceipt!.blockNumber,
    txHash: bindTx.hash,
    txIndex: bindReceipt!.index,
    logIndexInTx: 0,
    value: 0n,
  });
  await (
    await creditAsBorrower.proveControl(
      {
        chainKey: SOURCE,
        blockHeight: bindProof.proof.blockHeight,
        encodedTransaction: bindProof.proof.encodedTransaction,
        merkleRoot: bindProof.proof.merkleRoot,
        siblings: bindProof.proof.siblings,
      },
      bindProof.continuity,
    )
  ).wait();
  console.log(`  controllerOf(${borrower.address}) = ${await credit.controllerOf(borrower.address)}`);

  // ------------------------------------------------------------------
  console.log('\n=== 5. claims ===');
  await prover.waitAttested(toBlock);

  const volumeScope: Scope = scopeFor({
    chainKey: SOURCE,
    emitter: ledgerAddress,
    eventSig: SETTLED_SIG,
    subject: borrower.address,
    subjectTopic: 1,
    pin: { topic: 2, value: lender.address },
    metric: Metric.DATA_WORD,
    metricArg: 0,
  });
  const cleanScopeFor = (subject: string): Scope =>
    scopeFor({
      chainKey: SOURCE,
      emitter: ledgerAddress,
      eventSig: ADVERSE_SIG,
      subject,
      subjectTopic: 1,
      metric: Metric.COUNT,
    });

  // Sealing needs two independent endpoints agreeing to have looked. Free Sepolia endpoints are
  // unreliable enough that this genuinely blocks sometimes, so there is an escape hatch — set
  // ALLOW_SINGLE_SOURCE=1 — with the cost stated: a claim built on one node's word is only as
  // complete as that node, and being wrong about that is what the bond pays for.
  const volumeEvents = await sweepForClaim(volumeScope, fromBlock, toBlock, {
    minSources: process.env.ALLOW_SINGLE_SOURCE === '1' ? 1 : 2,
    log: (m) => console.log('  ' + m),
  });
  console.log(`  the borrower's settlements to the lender: ${volumeEvents.length}`);

  const volumeClaim = await buildClaim(registryAsBorrower, prover, volumeScope, fromBlock, toBlock, volumeEvents, {
    bond: BOND,
    challengeWindow: CHALLENGE_WINDOW,
    log: (m) => console.log('   ' + m),
  });
  const cleanClaim = await buildClaim(
    registryAsBorrower,
    prover,
    cleanScopeFor(borrower.address),
    fromBlock,
    toBlock,
    [],
    { bond: BOND, challengeWindow: CHALLENGE_WINDOW, log: (m) => console.log('   ' + m) },
  );

  console.log('\n  the defaulter files a clean claim too, and it is false:');
  const falseClaim = await buildClaim(
    registryAsDefaulter,
    prover,
    cleanScopeFor(defaulter.address),
    fromBlock,
    toBlock,
    [],
    { bond: BOND, challengeWindow: CHALLENGE_WINDOW, log: (m) => console.log('   ' + m) },
  );
  const adverseEvents = await scanScope(eth, cleanScopeFor(defaulter.address), fromBlock, toBlock, 500);
  const { reward } = await refuteClaim(registry, prover, falseClaim.claimId, adverseEvents[0]);
  console.log(`   refuted by the lender with one proof. reward ${formatEther(reward)} CTC`);

  // ------------------------------------------------------------------
  console.log('\n=== 6. finalizing ===');
  await waitForBlock(cc3, Number(await registry.challengeUntil(cleanClaim.claimId)) + 1);
  for (const [name, cid] of [
    ['volume', volumeClaim.claimId],
    ['clean', cleanClaim.claimId],
  ] as const) {
    await (await registryAsBorrower.finalize(cid)).wait();
    const c = await registry.claim(cid);
    console.log(`  ${name} claim ${cid}: ${statusName(c.status)}  aggregate ${c.aggregate}`);
  }

  // Refunds are credited, not sent — finalize is permissionless and pays the claimant, so pushing
  // would let a claimant that cannot receive ether brick their own claim.
  const refund: bigint = await registry.withdrawable(borrower.address);
  await (await registryAsBorrower.withdraw()).wait();
  console.log(`  borrower withdrew ${formatEther(refund)} CTC of returned bonds`);

  // ------------------------------------------------------------------
  console.log('\n=== 7. the line opens ===');
  await (await creditAsBorrower.openLine(borrower.address, volumeClaim.claimId, [cleanClaim.claimId])).wait();
  const lineId = 1n;
  let line = await credit.line(lineId);
  console.log(`  limit ${formatEther(line.limit)} CTC`);

  await (await credit.fund({ value: line.limit })).wait();
  console.log(`  lender funded ${formatEther(line.limit)} CTC`);

  const owed: bigint = await credit.repaymentFor(line.limit);
  console.log(`  drawing ${formatEther(line.limit)} CTC obliges ${formatEther(owed)} ETH back, at the lender's terms`);

  const before = await cc3.getBalance(borrower.address);
  await (await creditAsBorrower.draw(lineId, line.limit)).wait();
  line = await credit.line(lineId);
  const after = await cc3.getBalance(borrower.address);
  console.log(`  borrower drew ${formatEther(line.drawn)} CTC  (${formatEther(before)} -> ${formatEther(after)})`);
  console.log(`  owes ${formatEther(line.repayRequired)} ETH on Sepolia by CC3 block ${line.dueBlock}`);

  // ------------------------------------------------------------------
  console.log('\n=== 8. repayment, proven back ===');
  const repayTx = await asBorrower.settle(lender.address, { value: line.repayRequired });
  const repayReceipt = await repayTx.wait();
  console.log(`  paid ${formatEther(line.repayRequired)} ETH to the lender, Sepolia block ${repayReceipt.blockNumber}`);

  const repayFrom = Number(line.repayFrom);
  const repayTo = repayReceipt.blockNumber + 2;
  await prover.waitAttested(repayTo);
  const repayEvents = await scanScope(eth, volumeScope, repayFrom, repayTo, 500);
  console.log(`  settlements in ${repayFrom}..${repayTo}: ${repayEvents.length}`);

  const repayClaim = await buildClaim(registryAsBorrower, prover, volumeScope, repayFrom, repayTo, repayEvents, {
    bond: BOND,
    challengeWindow: CHALLENGE_WINDOW,
    log: (m) => console.log('   ' + m),
  });

  await waitForBlock(cc3, Number(await registry.challengeUntil(repayClaim.claimId)) + 1);
  await (await registryAsBorrower.finalize(repayClaim.claimId)).wait();
  const rc = await registry.claim(repayClaim.claimId);
  console.log(`  repay claim ${repayClaim.claimId}: ${statusName(rc.status)}  aggregate ${formatEther(rc.aggregate)} ETH`);

  await (await creditAsBorrower.settle(lineId, repayClaim.claimId)).wait();
  line = await credit.line(lineId);
  console.log(`  line ${lineId}: ${lineStatusName(line.status)}`);
  if (Number(line.status) !== 2) throw new Error('line should be Settled');

  console.log('\nThe loop is closed. Credit issued on Creditcoin against proven Sepolia history,');
  console.log('repaid on Sepolia, and settled on Creditcoin. Nothing bridged.');
}

// ------------------------------------------------------------------

async function topUpSepolia(from: Wallet, to: string, target: bigint): Promise<void> {
  const have = await from.provider!.getBalance(to);
  if (have >= target) {
    console.log(`  borrower already holds ${formatEther(have)} Sepolia ETH`);
    return;
  }
  const tx = await from.sendTransaction({ to, value: target - have });
  await tx.wait();
  console.log(`  sent ${formatEther(target - have)} Sepolia ETH to ${to}`);
}

async function topUpCtc(from: Wallet, to: string, target: bigint): Promise<void> {
  const have = await from.provider!.getBalance(to);
  if (have >= target) {
    console.log(`  ${to} already holds ${formatEther(have)} CTC`);
    return;
  }
  const tx = await from.sendTransaction({ to, value: target - have });
  await tx.wait();
  console.log(`  sent ${formatEther(target - have)} CTC to ${to}`);
}

async function waitForBlock(provider: JsonRpcProvider, target: number): Promise<void> {
  for (;;) {
    const now = await provider.getBlockNumber();
    if (now >= target) {
      process.stdout.write('\r');
      return;
    }
    process.stdout.write(`\r  waiting for CC3 block ${target}, at ${now}   `);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function statusName(s: bigint | number): string {
  return ['None', 'Open', 'Sealed', 'Finalized', 'Refuted'][Number(s)] ?? String(s);
}

function lineStatusName(s: bigint | number): string {
  return ['None', 'Active', 'Settled', 'Defaulted'][Number(s)] ?? String(s);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + (e.stack ?? e.message));
    process.exit(1);
  });
