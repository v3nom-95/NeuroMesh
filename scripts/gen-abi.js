#!/usr/bin/env node
/**
 * Generate `src/abi/<Name>.js` from the Hardhat artifacts in `artifacts/contracts/`.
 *
 * ## Why this exists
 *
 * The v1 code hand-transcribed the same three human-readable ABI arrays into `server.js` and
 * `scripts/simulate.js`. Hand-written fragments drift silently: `verifyMemory` gained a trailing
 * `bool revoked` and `globalReputation` changed units from an unbounded integer to WAD, and ethers
 * v6 decodes a shortened tuple without complaining in several of those cases — so the dashboard
 * would have shown a number inflated by ~1e15 with no error anywhere.
 *
 * The rule this script enforces: no ABI fragment is written by hand anywhere in the repository.
 *
 * ## Determinism
 *
 * Entries are sorted by `(type, name, input signature)` before emission so that regenerating from
 * an unchanged artifact is byte-identical, which is what makes `--check` a usable CI guard.
 *
 * ## Usage
 *
 *     node scripts/gen-abi.js              # write src/abi/*.js and src/abi/typehashes.json
 *     node scripts/gen-abi.js --check      # regenerate in memory, exit 1 if the tree differs
 *     node scripts/gen-abi.js --out <dir>  # write somewhere else
 *
 * @module scripts/gen-abi
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'ethers';

import { format, resolveConfig } from 'prettier';

import { TYPEHASHES } from '../src/protocol/eip712.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** Contracts whose ABI the runtime needs, in the order the generated index lists them. */
export const CONTRACT_NAMES = Object.freeze([
  'AgentIdentity',
  'MemoryLedger',
  'ReputationManager',
  'MemoryAccessControl',
]);

/**
 * Map a Solidity `*_TYPEHASH()` getter name to the protocol struct name it should equal.
 *
 * `MEMORY_COMMIT_TYPEHASH` becomes `MemoryCommit`.
 *
 * @param {string} getter Getter name from the ABI.
 * @returns {string} PascalCase struct name.
 */
export function structNameForTypehashGetter(getter) {
  return getter
    .replace(/_TYPEHASH$/, '')
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/**
 * Stable sort key for an ABI entry.
 *
 * @param {Record<string, any>} entry ABI fragment.
 * @returns {string} Comparable key.
 */
function sortKey(entry) {
  const inputs = Array.isArray(entry.inputs) ? entry.inputs : [];
  const sig = inputs.map((/** @type {any} */ i) => i.type ?? '').join(',');
  return `${entry.type ?? ''} ${entry.name ?? ''} ${sig}`;
}

/**
 * @typedef {object} AbiArtifact
 * @property {any[]} abi Contract ABI.
 * @property {string} deployedBytecode Runtime bytecode as produced by solc.
 */

/**
 * Read one Hardhat artifact.
 *
 * @param {string} name Contract name.
 * @returns {AbiArtifact} The artifact fields this generator uses.
 */
export function readArtifact(name) {
  const file = join(ROOT, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`);
  if (!existsSync(file)) {
    throw new Error(
      `Artifact not found: ${file}\n` +
        'Run `npm run compile` first - src/abi/*.js is generated from the compiled contracts and ' +
        'must never be written by hand.',
    );
  }
  const artifact = JSON.parse(readFileSync(file, 'utf8'));
  return { abi: artifact.abi, deployedBytecode: artifact.deployedBytecode };
}

/**
 * Render the generated module for one contract.
 *
 * @param {string} name Contract name.
 * @param {AbiArtifact} artifact Artifact fields.
 * @returns {string} File contents, already Prettier-shaped.
 */
export function renderModule(name, artifact) {
  const abi = [...artifact.abi].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  const deployed = artifact.deployedBytecode ?? '0x';
  const hash = keccak256(deployed);
  const size = Math.max(0, (deployed.length - 2) / 2);
  const typehashGetters = abi
    .filter((e) => e.type === 'function' && /_TYPEHASH$/.test(e.name ?? ''))
    .map((e) => e.name)
    .sort();

  const json = JSON.stringify(abi, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');

  return `/**
 * GENERATED FILE - DO NOT EDIT.
 *
 * Produced by \`node scripts/gen-abi.js\` from \`artifacts/contracts/${name}.sol/${name}.json\`.
 * Edit the Solidity and recompile; never edit this file. \`node scripts/gen-abi.js --check\`
 * fails CI when the tree and the artifacts disagree.
 *
 * @module src/abi/${name}
 */

/**
 * ABI of the ${name} contract, sorted deterministically.
 *
 * @type {ReadonlyArray<any>}
 */
export const ${name}Abi = Object.freeze(${json});

/**
 * keccak256 of the artifact's \`deployedBytecode\`.
 *
 * Compare against \`eth_getCode\` to detect that a configured address holds a different build of
 * this contract. Two caveats, both deliberate and both treated by the chain service as DEGRADED
 * rather than fatal: immutable variables are zeroed in the artifact but populated on chain, so a
 * contract with immutables never matches byte-for-byte; and metadata hashes differ across compiler
 * settings. A mismatch therefore means "cannot prove this is the build we know", not "wrong".
 *
 * @type {string}
 */
export const ${name}DeployedBytecodeHash = '${hash}';

/**
 * Byte length of the artifact's deployed bytecode. A length of 0 at an address means no contract.
 *
 * @type {number}
 */
export const ${name}DeployedBytecodeSize = ${size};

/**
 * Names of this contract's public \`*_TYPEHASH()\` getters, used by the boot invariant.
 *
 * @type {ReadonlyArray<string>}
 */
export const ${name}TypehashGetters = Object.freeze(${JSON.stringify(typehashGetters)});

export default ${name}Abi;
`;
}

/**
 * Render `src/abi/typehashes.json`: contract -> getter name -> locally computed typehash.
 *
 * @param {Map<string, AbiArtifact>} artifacts Loaded artifacts.
 * @returns {string} File contents.
 */
export function renderTypehashes(artifacts) {
  /** @type {Record<string, Record<string, string>>} */
  const out = {};
  for (const name of CONTRACT_NAMES) {
    const artifact = artifacts.get(name);
    if (!artifact) continue;
    /** @type {Record<string, string>} */
    const entries = {};
    for (const fragment of artifact.abi) {
      if (fragment.type !== 'function' || !/_TYPEHASH$/.test(fragment.name ?? '')) continue;
      const struct = structNameForTypehashGetter(fragment.name);
      const expected = /** @type {Record<string, string>} */ (TYPEHASHES)[struct];
      if (!expected) {
        throw new Error(
          `Contract ${name} exposes ${fragment.name} but src/protocol/eip712.js has no ` +
            `TYPEHASHES.${struct}. Transcribe the type string before regenerating.`,
        );
      }
      entries[fragment.name] = expected;
    }
    if (Object.keys(entries).length > 0) out[name] = entries;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Format generated source with the repository's own Prettier configuration.
 *
 * The emitter produces well-shaped but not Prettier-identical output, and `npm run format:check`
 * covers `src/**`. Rather than hand-tuning the emitter to match Prettier's object wrapping - which
 * would silently drift the first time the style config changed - the generator simply runs the
 * formatter over its own output. Prettier is deterministic, so `--check` stays byte-stable.
 *
 * Prettier is a devDependency and this is a dev-only script. If it cannot be loaded the raw text
 * is used, which is still valid JavaScript; only `format:check` would then complain.
 *
 * @param {string} source Generated source.
 * @param {string} filepath Path the source will be written to, so Prettier picks the right parser.
 * @returns {Promise<string>} Formatted source.
 */
async function prettify(source, filepath) {
  try {
    const options = (await resolveConfig(filepath)) ?? {};
    return await format(source, { ...options, filepath });
  } catch {
    return source;
  }
}

/**
 * Build every output file in memory.
 *
 * @returns {Promise<Map<string, string>>} Relative filename to contents.
 */
export async function generate() {
  /** @type {Map<string, AbiArtifact>} */
  const artifacts = new Map();
  /** @type {Map<string, string>} */
  const files = new Map();
  for (const name of CONTRACT_NAMES) {
    const artifact = readArtifact(name);
    artifacts.set(name, artifact);
    files.set(
      `${name}.js`,
      await prettify(renderModule(name, artifact), join(ROOT, 'src', 'abi', `${name}.js`)),
    );
  }
  files.set(
    'typehashes.json',
    await prettify(renderTypehashes(artifacts), join(ROOT, 'src', 'abi', 'typehashes.json')),
  );
  return files;
}

/**
 * CLI entry point.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {Promise<number>} Process exit code.
 */
export async function main(argv) {
  const check = argv.includes('--check');
  const outIndex = argv.indexOf('--out');
  const outDir = outIndex >= 0 ? resolve(argv[outIndex + 1]) : join(ROOT, 'src', 'abi');

  const files = await generate();

  if (check) {
    /** @type {string[]} */
    const stale = [];
    for (const [name, contents] of files) {
      const path = join(outDir, name);
      const actual = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (actual !== contents) stale.push(name);
    }
    if (stale.length > 0) {
      console.error(
        `src/abi is stale for: ${stale.join(', ')}\n` +
          'Run `node scripts/gen-abi.js` and commit the result.',
      );
      return 1;
    }
    console.log(`src/abi is up to date (${files.size} files).`);
    return 0;
  }

  mkdirSync(outDir, { recursive: true });
  for (const [name, contents] of files) {
    writeFileSync(join(outDir, name), contents, 'utf8');
  }
  console.log(`Wrote ${files.size} files to ${outDir}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
