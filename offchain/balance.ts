import { formatEther, Contract } from 'ethers';
import chainInfoAbi from '@gluwa/usc-sdk/dist/chain-info/chain_info.json';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, CHAIN_KEY, requirePrivateKey } from './config';
import { signer, readDeployments } from './lib/contracts';

async function main() {
  const wallet = signer(CC3_RPC, CC3_CHAIN_ID, requirePrivateKey());
  const provider = wallet.provider!;
  const [balance, blockNumber, network] = await Promise.all([
    provider.getBalance(wallet.address),
    provider.getBlockNumber(),
    provider.getNetwork(),
  ]);

  console.log(`address    ${wallet.address}`);
  console.log(`chain id   ${network.chainId}`);
  console.log(`cc3 block  ${blockNumber}`);
  console.log(`balance    ${formatEther(balance)} CTC`);

  const chainInfo = new Contract('0x0000000000000000000000000000000000000fD3', chainInfoAbi as any, provider);
  for (const [name, key] of Object.entries(CHAIN_KEY)) {
    const r = await chainInfo.get_latest_attestation_height_and_hash(key);
    console.log(`attested   ${name.padEnd(8)} chainKey ${key}  height ${r[0]}`);
  }

  const d = readDeployments();
  if (d.registry) {
    console.log(`\nregistry   ${d.registry}`);
    console.log(`credit     ${d.credit}`);
  }

  if (balance === 0n) {
    console.log(`\nNo CTC yet. In the Creditcoin Discord #token-faucet channel:`);
    console.log(`  /faucet address:${wallet.address}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
