import hre from 'hardhat';
import fs from 'fs';

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log('Deploying contracts with the account:', deployer?.address || 'Unknown');

  const AgentIdentity = await hre.ethers.getContractFactory('AgentIdentity');
  const identity = await AgentIdentity.deploy();
  await identity.waitForDeployment();
  const identityAddress = await identity.getAddress();
  console.log('AgentIdentity deployed to:', identityAddress);

  const MemoryLedger = await hre.ethers.getContractFactory('MemoryLedger');
  const ledger = await MemoryLedger.deploy();
  await ledger.waitForDeployment();
  const ledgerAddress = await ledger.getAddress();
  console.log('MemoryLedger deployed to:', ledgerAddress);

  const ReputationManager = await hre.ethers.getContractFactory('ReputationManager');
  const reputation = await ReputationManager.deploy(identityAddress);
  await reputation.waitForDeployment();
  const reputationAddress = await reputation.getAddress();
  console.log('ReputationManager deployed to:', reputationAddress);

  // Auto-save contract addresses
  const addresses = {
    AgentIdentity: identityAddress,
    MemoryLedger: ledgerAddress,
    ReputationManager: reputationAddress,
  };
  fs.writeFileSync('contract-addresses.json', JSON.stringify(addresses, null, 2));
  console.log('Contract addresses saved to contract-addresses.json');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
