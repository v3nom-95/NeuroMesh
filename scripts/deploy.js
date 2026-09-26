/**
 * NeuroMesh contract deployment.
 *
 * Deploys the four-contract suite in dependency order, wires the cross-contract
 * references, and writes a machine-readable deployment record to
 * `deployments/<chainId>.json` (plus `contract-addresses.json` for backward
 * compatibility with older tooling).
 *
 * Usage:
 *   npx hardhat run scripts/deploy.js                      # in-process network
 *   npx hardhat run scripts/deploy.js --network localhost
 *   npm run deploy:sepolia                                 # --network sepolia
 *
 * Flags (via env, because `hardhat run` does not forward argv):
 *   FORCE_DEPLOY=1      overwrite an existing deployments/<chainId>.json
 *   TRUST_LOG_CAPACITY  ring-buffer size for ReputationManager (default 1024)
 *   TREASURY_ADDRESS    slashed-stake recipient (default: the deployer)
 *
 * @module scripts/deploy
 */
import fs from 'node:fs';
import path from 'node:path';
import hre from 'hardhat';

/** Ring-buffer capacity for the on-chain trust log. Must be 1..65536 (Limits.sol). */
const DEFAULT_TRUST_LOG_CAPACITY = 1024n;

/** Deployment order matters: later contracts take earlier addresses as constructor args. */
const CONTRACTS = ['AgentIdentity', 'MemoryLedger', 'ReputationManager', 'MemoryAccessControl'];

/**
 * @param {string} name
 * @param {unknown[]} args
 * @returns {Promise<{address: string, txHash: string|null, blockNumber: number|null}>}
 */
async function deployOne(name, args) {
  const { ethers } = /** @type {any} */ (hre);
  const factory = await ethers.getContractFactory(name);
  const instance = await factory.deploy(...args);
  await instance.waitForDeployment();

  const address = await instance.getAddress();
  const tx = instance.deploymentTransaction();
  const receipt = tx ? await tx.wait() : null;

  process.stdout.write(`  ${name.padEnd(20)} ${address}\n`);
  return {
    address,
    txHash: tx ? tx.hash : null,
    blockNumber: receipt ? receipt.blockNumber : null,
  };
}

async function main() {
  const { ethers, network } = /** @type {any} */ (hre);

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error(
      'No signer available. For a live network set PRIVATE_KEY in .env; ' +
        'for a local run use `npx hardhat node` or the in-process network.',
    );
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const balance = await ethers.provider.getBalance(deployer.address);

  process.stdout.write('\nNeuroMesh deployment\n');
  process.stdout.write(`  network   ${network.name} (chainId ${chainId})\n`);
  process.stdout.write(`  deployer  ${deployer.address}\n`);
  process.stdout.write(`  balance   ${ethers.formatEther(balance)} ETH\n\n`);

  if (balance === 0n) {
    throw new Error(`Deployer ${deployer.address} has a zero balance on chain ${chainId}.`);
  }

  const outDir = path.join(process.cwd(), 'deployments');
  const outFile = path.join(outDir, `${chainId}.json`);
  if (fs.existsSync(outFile) && process.env.FORCE_DEPLOY !== '1') {
    throw new Error(
      `${path.relative(process.cwd(), outFile)} already exists. ` +
        'Re-deploying replaces the recorded addresses and orphans every memory committed ' +
        'against the old ones. Set FORCE_DEPLOY=1 if that is what you intend.',
    );
  }

  const treasury = process.env.TREASURY_ADDRESS || deployer.address;
  if (!ethers.isAddress(treasury)) {
    throw new Error(`TREASURY_ADDRESS is not a valid address: ${treasury}`);
  }
  const trustLogCapacity = process.env.TRUST_LOG_CAPACITY
    ? BigInt(process.env.TRUST_LOG_CAPACITY)
    : DEFAULT_TRUST_LOG_CAPACITY;
  if (trustLogCapacity <= 0n || trustLogCapacity > 65536n) {
    throw new Error(`TRUST_LOG_CAPACITY must be 1..65536, got ${trustLogCapacity}`);
  }

  const admin = deployer.address;

  const identity = await deployOne('AgentIdentity', [admin]);
  const ledger = await deployOne('MemoryLedger', [admin, identity.address]);
  const reputation = await deployOne('ReputationManager', [
    admin,
    identity.address,
    treasury,
    trustLogCapacity,
  ]);
  const access = await deployOne('MemoryAccessControl', [admin, ledger.address, identity.address]);

  const deployed = {
    AgentIdentity: identity,
    MemoryLedger: ledger,
    ReputationManager: reputation,
    MemoryAccessControl: access,
  };

  // Verify every address actually carries bytecode before recording it.
  for (const name of CONTRACTS) {
    const code = await ethers.provider.getCode(deployed[name].address);
    if (code === '0x') {
      throw new Error(`${name} reported ${deployed[name].address} but that address has no code.`);
    }
  }

  const solidity = /** @type {any} */ (hre.config).solidity;
  const compiler = Array.isArray(solidity?.compilers) ? solidity.compilers[0] : solidity;

  const record = {
    chainId,
    network: network.name,
    deployer: deployer.address,
    admin,
    treasury,
    trustLogCapacity: trustLogCapacity.toString(),
    deployedAt: new Date().toISOString(),
    compiler: {
      version: compiler?.version ?? 'unknown',
      optimizer: compiler?.settings?.optimizer ?? null,
      evmVersion: compiler?.settings?.evmVersion ?? null,
    },
    contracts: Object.fromEntries(
      CONTRACTS.map((name) => [
        name,
        {
          address: deployed[name].address,
          txHash: deployed[name].txHash,
          blockNumber: deployed[name].blockNumber,
          constructorArgs: constructorArgsFor(name, {
            admin,
            identity: identity.address,
            ledger: ledger.address,
            treasury,
            trustLogCapacity: trustLogCapacity.toString(),
          }),
        },
      ]),
    ),
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);

  // Legacy flat map, still read by older tooling.
  fs.writeFileSync(
    path.join(process.cwd(), 'contract-addresses.json'),
    `${JSON.stringify(
      Object.fromEntries(CONTRACTS.map((n) => [n, deployed[n].address])),
      null,
      2,
    )}\n`,
  );

  process.stdout.write(`\n  record    deployments/${chainId}.json\n`);
  process.stdout.write('  legacy    contract-addresses.json\n');
  if (chainId !== 31337) {
    process.stdout.write('\n  Next: npm run verify   (Etherscan source verification)\n');
  }
  process.stdout.write('\n');
}

/**
 * Constructor arguments per contract, in ABI order — consumed by scripts/verify.js.
 *
 * @param {string} name
 * @param {{admin: string, identity: string, ledger: string, treasury: string, trustLogCapacity: string}} ctx
 * @returns {(string|number)[]}
 */
function constructorArgsFor(name, ctx) {
  switch (name) {
    case 'AgentIdentity':
      return [ctx.admin];
    case 'MemoryLedger':
      return [ctx.admin, ctx.identity];
    case 'ReputationManager':
      return [ctx.admin, ctx.identity, ctx.treasury, ctx.trustLogCapacity];
    case 'MemoryAccessControl':
      return [ctx.admin, ctx.ledger, ctx.identity];
    default:
      return [];
  }
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`\nDeployment failed: ${error instanceof Error ? error.message : String(error)}`);
});
