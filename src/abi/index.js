/**
 * Single import surface for contract ABIs, expected typehashes and build fingerprints.
 *
 * ## The hard rule
 *
 * No ABI fragment is written by hand anywhere in this repository. Every array under `src/abi/` is
 * emitted by `node scripts/gen-abi.js` from `artifacts/contracts/`, and `node scripts/gen-abi.js
 * --check` fails when the tree and the artifacts disagree. The two hand-transcribed copies that
 * used to live in `server.js` and `scripts/simulate.js` are exactly how `verifyMemory` gaining a
 * trailing `bool revoked`, and `globalReputation` changing units from an unbounded integer to WAD,
 * would have become silently wrong numbers on a dashboard rather than a loud failure.
 *
 * ## Detecting the stale deployment
 *
 * `contract-addresses.json` currently points at v1 contracts whose ABI does not match these. The
 * chain service is expected to treat that as a DEGRADED state, not a crash: read-only routes and
 * the dashboard keep working while `/readyz` and the status route report
 * `chain: { reachable: true, contractsCompatible: false }`. This module gives that check its
 * inputs: {@link EXPECTED_TYPEHASHES} (what the deployed contract's `*_TYPEHASH()` getters must
 * return), {@link DEPLOYED_BYTECODE_HASHES} and {@link DEPLOYED_BYTECODE_SIZES} (what
 * `eth_getCode` should look like), and {@link SUPPORTS_EIP712} (which contracts may be probed with
 * `eip712Domain()` at all).
 *
 * @module src/abi
 */
import { createRequire } from 'node:module';
import { Interface } from 'ethers';

import { DOMAIN_NAMES, DOMAIN_VERSION } from '../protocol/constants.js';
import { TYPEHASHES } from '../protocol/eip712.js';

import {
  AgentIdentityAbi,
  AgentIdentityDeployedBytecodeHash,
  AgentIdentityDeployedBytecodeSize,
  AgentIdentityTypehashGetters,
} from './AgentIdentity.js';
import {
  MemoryLedgerAbi,
  MemoryLedgerDeployedBytecodeHash,
  MemoryLedgerDeployedBytecodeSize,
  MemoryLedgerTypehashGetters,
} from './MemoryLedger.js';
import {
  ReputationManagerAbi,
  ReputationManagerDeployedBytecodeHash,
  ReputationManagerDeployedBytecodeSize,
  ReputationManagerTypehashGetters,
} from './ReputationManager.js';
import {
  MemoryAccessControlAbi,
  MemoryAccessControlDeployedBytecodeHash,
  MemoryAccessControlDeployedBytecodeSize,
  MemoryAccessControlTypehashGetters,
} from './MemoryAccessControl.js';

export { AgentIdentityAbi, MemoryLedgerAbi, ReputationManagerAbi, MemoryAccessControlAbi };

const require = createRequire(import.meta.url);

/**
 * `contract -> getter name -> expected typehash`, generated alongside the ABIs.
 *
 * The values are computed from `src/protocol/eip712.js` TYPE_STRINGS, so this file is the
 * *locally derived* expectation. The chain service calls the getters on the deployed contract and
 * compares; a difference means the deployment does not implement the structs this backend signs.
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
export const EXPECTED_TYPEHASHES = Object.freeze(
  /** @type {Record<string, Record<string, string>>} */ (require('./typehashes.json')),
);

/**
 * The four contracts this backend talks to, in deployment order.
 *
 * @type {ReadonlyArray<'AgentIdentity'|'MemoryLedger'|'ReputationManager'|'MemoryAccessControl'>}
 */
export const CONTRACT_NAMES = Object.freeze(
  /** @type {const} */ ([
    'AgentIdentity',
    'MemoryLedger',
    'ReputationManager',
    'MemoryAccessControl',
  ]),
);

/**
 * @typedef {(typeof CONTRACT_NAMES)[number]} ContractName
 */

/**
 * Every ABI, keyed by contract name.
 *
 * @type {Readonly<Record<ContractName, ReadonlyArray<any>>>}
 */
export const ABIS = Object.freeze({
  AgentIdentity: AgentIdentityAbi,
  MemoryLedger: MemoryLedgerAbi,
  ReputationManager: ReputationManagerAbi,
  MemoryAccessControl: MemoryAccessControlAbi,
});

/**
 * keccak256 of each artifact's `deployedBytecode`.
 *
 * A mismatch against `eth_getCode` is evidence of a different build, not proof of one: immutables
 * are zeroed in the artifact and populated on chain, and metadata hashes move with compiler
 * settings. Treat a mismatch as "unverified", and rely on {@link EXPECTED_TYPEHASHES} for the
 * decisive compatibility answer.
 *
 * @type {Readonly<Record<ContractName, string>>}
 */
export const DEPLOYED_BYTECODE_HASHES = Object.freeze({
  AgentIdentity: AgentIdentityDeployedBytecodeHash,
  MemoryLedger: MemoryLedgerDeployedBytecodeHash,
  ReputationManager: ReputationManagerDeployedBytecodeHash,
  MemoryAccessControl: MemoryAccessControlDeployedBytecodeHash,
});

/**
 * Byte length of each artifact's deployed bytecode. `eth_getCode` returning `0x` (length 0) at a
 * configured address means there is no contract there at all, which is a different and much more
 * actionable failure than "wrong build".
 *
 * @type {Readonly<Record<ContractName, number>>}
 */
export const DEPLOYED_BYTECODE_SIZES = Object.freeze({
  AgentIdentity: AgentIdentityDeployedBytecodeSize,
  MemoryLedger: MemoryLedgerDeployedBytecodeSize,
  ReputationManager: ReputationManagerDeployedBytecodeSize,
  MemoryAccessControl: MemoryAccessControlDeployedBytecodeSize,
});

/**
 * `*_TYPEHASH()` getters each contract actually exposes, taken from the compiled ABI.
 *
 * @type {Readonly<Record<ContractName, ReadonlyArray<string>>>}
 */
export const TYPEHASH_GETTERS = Object.freeze({
  AgentIdentity: AgentIdentityTypehashGetters,
  MemoryLedger: MemoryLedgerTypehashGetters,
  ReputationManager: ReputationManagerTypehashGetters,
  MemoryAccessControl: MemoryAccessControlTypehashGetters,
});

/**
 * The EIP-712 domain each contract declares, or `null` when it has no EIP712 mixin.
 *
 * `ReputationManager` is `null` deliberately: it has no signed entrypoint, and calling
 * `eip712Domain()` on it reverts. A boot invariant that probes every contract uniformly would make
 * a *correct* deployment fail to start.
 *
 * @type {Readonly<Record<ContractName, {name: string, version: string}|null>>}
 */
export const EXPECTED_DOMAINS = Object.freeze({
  AgentIdentity: Object.freeze({ name: DOMAIN_NAMES.AgentIdentity, version: DOMAIN_VERSION }),
  MemoryLedger: Object.freeze({ name: DOMAIN_NAMES.MemoryLedger, version: DOMAIN_VERSION }),
  ReputationManager: null,
  MemoryAccessControl: Object.freeze({
    name: DOMAIN_NAMES.MemoryAccessControl,
    version: DOMAIN_VERSION,
  }),
});

/**
 * Whether a contract may be probed with `eip712Domain()`.
 *
 * @type {Readonly<Record<ContractName, boolean>>}
 */
export const SUPPORTS_EIP712 = Object.freeze({
  AgentIdentity: true,
  MemoryLedger: true,
  ReputationManager: false,
  MemoryAccessControl: true,
});

/** @type {Map<ContractName, Interface>} */
const interfaceCache = new Map();

/**
 * Memoized `ethers.Interface` for a contract.
 *
 * Building an Interface parses the whole ABI, so it is cached: the chain service and the tx queue
 * both want one and there is no reason to pay twice.
 *
 * @param {ContractName} name Contract name.
 * @returns {Interface} The parsed interface.
 * @throws {Error} When `name` is not one of {@link CONTRACT_NAMES}.
 */
export function getInterface(name) {
  const cached = interfaceCache.get(name);
  if (cached) return cached;
  const abi = ABIS[name];
  if (!abi) {
    throw new Error(`Unknown contract "${name}". Known: ${CONTRACT_NAMES.join(', ')}.`);
  }
  const iface = new Interface(/** @type {any} */ (abi));
  interfaceCache.set(name, iface);
  return iface;
}

/**
 * The protocol typehash a given `*_TYPEHASH()` getter should return.
 *
 * @param {ContractName} contract Contract name.
 * @param {string} getter Getter name, e.g. `MEMORY_COMMIT_TYPEHASH`.
 * @returns {string|null} 0x-prefixed 32-byte hash, or `null` when the pair is unknown.
 */
export function expectedTypehash(contract, getter) {
  return EXPECTED_TYPEHASHES[contract]?.[getter] ?? null;
}

export { TYPEHASHES as PROTOCOL_TYPEHASHES };
