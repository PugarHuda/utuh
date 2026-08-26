import { AbiCoder, formatEther } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, requirePrivateKey } from './config';
import { artifact, deploy, signer, writeDeployments } from './lib/contracts';
import { MIN_CHALLENGE_WINDOW, LENDER_MAINNET, policy, creditConstructorArgs } from './lib/policy';

async function main() {
  const wallet = signer(CC3_RPC, CC3_CHAIN_ID, requirePrivateKey());
  const balance = await wallet.provider!.getBalance(wallet.address);
  console.log(`deployer ${wallet.address}`);
  console.log(`balance  ${formatEther(balance)} CTC`);
  if (balance === 0n) {
    throw new Error(
      `no CTC. Request from the Creditcoin Discord #token-faucet channel:\n  /faucet address:${wallet.address}`,
    );
  }

  // EvmV1Decoder exposes `public` library functions, so it is deployed once and delegatecalled.
  const decoder = await deploy(wallet, artifact('EvmV1Decoder.sol', 'EvmV1Decoder'));
  const decoderAddress = await decoder.getAddress();
  console.log(`EvmV1Decoder  ${decoderAddress}`);

  const registry = await deploy(wallet, artifact('UtuhRegistry.sol', 'UtuhRegistry'), [MIN_CHALLENGE_WINDOW], {
    EvmV1Decoder: decoderAddress,
  });
  const registryAddress = await registry.getAddress();
  console.log(`UtuhRegistry  ${registryAddress}  (min challenge window ${MIN_CHALLENGE_WINDOW} blocks)`);

  // Aave V3 Repay(address indexed reserve, address indexed user, address indexed repayer,
  // Every spec and every policy figure lives in lib/policy.ts, which verify.ts reads too. They
  // used to be two copies whose only job was to stay byte-identical, and Blockscout rejects a
  // verification whose constructor arguments differ by one byte.
  const args = creditConstructorArgs(registryAddress);
  const credit = await deploy(wallet, artifact('UtuhCredit.sol', 'UtuhCredit'), args, {
    EvmV1Decoder: decoderAddress,
  });
  const creditAddress = await credit.getAddress();
  console.log(`UtuhCredit    ${creditAddress}`);
  console.log(`  repayment must land at ${LENDER_MAINNET} on Ethereum mainnet`);
  console.log(`  lender's stated rate: ${policy().volumeUnitInCtc} CTC wei per USDC unit`);
  console.log(`  accepts underwriting claims with a window of ${MIN_CHALLENGE_WINDOW}+ blocks`);
  console.log(`  terms: repay ${policy().repaymentBps / 100}% within ${policy().repayWindowBlocks} CC3 blocks`);
  console.log('  adverse classes: 1 (Aave V3 LiquidationCall) — add more to require more');

  // Record what was actually passed, so verification does not have to guess it back out of the
  // environment it happened to be run in.
  const creditAbi = artifact('UtuhCredit.sol', 'UtuhCredit').abi.find((f: any) => f.type === 'constructor');
  writeDeployments({
    chainId: CC3_CHAIN_ID,
    deployer: wallet.address,
    decoder: decoderAddress,
    registry: registryAddress,
    credit: creditAddress,
    registryArgs: AbiCoder.defaultAbiCoder().encode(['uint64'], [MIN_CHALLENGE_WINDOW]),
    // The very array that was deployed, not a reconstruction of it.
    creditArgs: AbiCoder.defaultAbiCoder().encode(creditAbi.inputs as any, args),
  });
  console.log('\nwrote deployments.json, constructor arguments included');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
