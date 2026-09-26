/**
 * Etherscan source verification for a recorded NeuroMesh deployment.
 *
 * Reads `deployments/<chainId>.json` (written by scripts/deploy.js), then submits
 * each contract's source and constructor arguments to the block explorer.
 *
 * Exits 0 — with a notice rather than an error — when there is nothing it can do:
 * no ETHERSCAN_API_KEY, a local chain, or no deployment record. That keeps
 * `npm run verify` safe to call from CI without conditioning the pipeline on secrets.
 *
 * Usage:  npm run verify        (implies --network sepolia)
 *
 * @module scripts/verify
 */
import fs from 'node:fs';
import path from 'node:path';
import hre from 'hardhat';

/** Chains where source verification is meaningless. */
const LOCAL_CHAIN_IDS = new Set([31337, 1337]);

/** @param {string} msg */
function notice(msg) {
  process.stdout.write(`  ${msg}\n`);
}

async function main() {
  const { ethers, network, run } = /** @type {any} */ (hre);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  process.stdout.write('\nNeuroMesh source verification\n');
  process.stdout.write(`  network   ${network.name} (chainId ${chainId})\n\n`);

  if (LOCAL_CHAIN_IDS.has(chainId)) {
    notice(`Chain ${chainId} is a local network — nothing to verify. Skipping.`);
    return;
  }

  if (!process.env.ETHERSCAN_API_KEY) {
    notice('ETHERSCAN_API_KEY is not set, so source verification cannot run.');
    notice('Set it in .env (see .env.example) and re-run `npm run verify`.');
    return;
  }

  const recordPath = path.join(process.cwd(), 'deployments', `${chainId}.json`);
  if (!fs.existsSync(recordPath)) {
    notice(`No deployment record at deployments/${chainId}.json.`);
    notice('Deploy first: npm run deploy:sepolia');
    return;
  }

  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const entries = Object.entries(
    /** @type {Record<string, {address: string, constructorArgs?: unknown[]}>} */ (
      record.contracts ?? {}
    ),
  );

  if (entries.length === 0) {
    notice(`deployments/${chainId}.json records no contracts.`);
    return;
  }

  let verified = 0;
  let alreadyVerified = 0;
  /** @type {string[]} */
  const failures = [];

  for (const [name, info] of entries) {
    const code = await ethers.provider.getCode(info.address);
    if (code === '0x') {
      failures.push(`${name}: no bytecode at ${info.address} on chain ${chainId}`);
      process.stdout.write(`  ${name.padEnd(20)} SKIP (no code on chain)\n`);
      continue;
    }

    try {
      await run('verify:verify', {
        address: info.address,
        constructorArguments: info.constructorArgs ?? [],
      });
      verified += 1;
      process.stdout.write(`  ${name.padEnd(20)} verified\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/already verified/i.test(message)) {
        alreadyVerified += 1;
        process.stdout.write(`  ${name.padEnd(20)} already verified\n`);
        continue;
      }
      failures.push(`${name}: ${message.split('\n')[0]}`);
      process.stdout.write(`  ${name.padEnd(20)} FAILED\n`);
    }
  }

  process.stdout.write(
    `\n  ${verified} verified, ${alreadyVerified} already verified, ${failures.length} failed\n`,
  );

  if (failures.length > 0) {
    process.stdout.write('\n  Failures:\n');
    for (const f of failures) process.stdout.write(`    - ${f}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('\n');
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`\nVerification failed: ${error instanceof Error ? error.message : String(error)}`);
});
