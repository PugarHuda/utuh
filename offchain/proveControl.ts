import { Wallet, formatEther, getAddress } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, CHAIN_KEY, PROVER_URL, source, requirePrivateKey } from './config';
import { readDeployments, creditAt, signer } from './lib/contracts';
import { Prover } from './lib/proofs';

/// Which source chain to send the commitment on.
///
/// Sepolia by default. An EOA address is derived from its public key and is identical on every
/// EVM chain, so proving control there proves control of the same address on mainnet — for
/// testnet gas rather than real gas.
const SOURCE = Number(process.env.CONTROL_CHAIN_KEY ?? CHAIN_KEY.sepolia);

/// Complete the loop UtuhCredit's underwriting refuses to skip: bind a source-chain address to a
/// Creditcoin account by proving a transaction only that address's key could have sent.
async function main() {
  const d = readDeployments();
  if (!d.credit) throw new Error('no deployments.json — run: npm run deploy');

  const cc = signer(CC3_RPC, CC3_CHAIN_ID, requirePrivateKey());
  const credit = creditAt(d.credit, cc);

  const eth = source(SOURCE);
  const onSource = new Wallet(requirePrivateKey(), eth);
  const subject = getAddress(onSource.address);
  const account = getAddress(cc.address);

  const commitment: string = await credit.controlCommitment(account);
  console.log(`binding source address ${subject}`);
  console.log(`      to Creditcoin account ${account}`);
  console.log(`calldata ${commitment}`);

  const balance = await eth.getBalance(subject);
  console.log(`source balance ${formatEther(balance)} ETH`);
  if (balance === 0n) {
    throw new Error(
      `no gas on chain key ${SOURCE} for ${subject}.\n` +
        `Send a little Sepolia ETH there, or set CONTROL_CHAIN_KEY=3 to use mainnet.`,
    );
  }

  const existing = await credit.controllerOf(subject);
  if (existing !== '0x0000000000000000000000000000000000000000') {
    console.log(`already bound to ${existing}`);
    if (getAddress(existing) === account) return;
  }

  // The transaction carries nothing but the commitment. Where it goes does not matter — the tag
  // and the named account are what make it unforgeable — so it goes back to the sender.
  console.log('\nsending the commitment transaction...');
  const sent = await onSource.sendTransaction({ to: subject, value: 0n, data: commitment });
  const receipt = await sent.wait();
  if (!receipt) throw new Error('no receipt');
  console.log(`  ${sent.hash} in block ${receipt.blockNumber}`);

  const prover = new Prover(SOURCE, PROVER_URL, 60000);
  console.log(`waiting for Creditcoin to attest block ${receipt.blockNumber}...`);
  await prover.waitAttested(receipt.blockNumber);

  const { proof, continuity } = await prover.proveOne({
    blockNumber: receipt.blockNumber,
    txHash: sent.hash,
    txIndex: receipt.index,
    logIndexInTx: 0,
    value: 0n,
  });

  console.log('proving control on Creditcoin...');
  const tx = await credit.proveControl(
    {
      chainKey: SOURCE,
      blockHeight: proof.blockHeight,
      encodedTransaction: proof.encodedTransaction,
      merkleRoot: proof.merkleRoot,
      siblings: proof.siblings,
    },
    continuity,
  );
  await tx.wait();

  const bound = await credit.controllerOf(subject);
  console.log(`\ncontrollerOf(${subject}) = ${bound}`);
  if (getAddress(bound) !== account) throw new Error('binding did not take');
  console.log('bound. openLine will now accept this subject from this account.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\n' + (e.message ?? e));
    process.exit(1);
  });
