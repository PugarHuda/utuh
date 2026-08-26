import { formatEther, Contract } from 'ethers';
import 'dotenv/config';
import { CC3_RPC, CC3_CHAIN_ID, CHAIN_KEY, requirePrivateKey } from './config';
import { signer, readDeployments } from './lib/contracts';
import { chainInfoAt } from './lib/chain';

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

  const chainInfo = chainInfoAt(provider);
  for (const [name, key] of Object.entries(CHAIN_KEY)) {
    const r = await chainInfo.getLatestAttestedHeightAndHash(key);
    console.log(`attested   ${name.padEnd(8)} chainKey ${key}  height ${r.height}`);
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
