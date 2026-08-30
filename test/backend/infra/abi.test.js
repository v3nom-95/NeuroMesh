/**
 * The ABI layer: generated, never hand-written, and able to tell a stale deployment from a live
 * one.
 *
 * The rule under test is that `src/abi/*.js` is a pure function of `artifacts/contracts/`. Two
 * hand-transcribed ABI copies used to live in `server.js` and `scripts/simulate.js`, and they are
 * how `verifyMemory` gaining a trailing `bool revoked`, and `globalReputation` changing units from
 * an unbounded integer to WAD, would have become a silently wrong number on a chart instead of an
 * error.
 *
 * @module test/backend/infra/abi.test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  ABIS,
  CONTRACT_NAMES,
  DEPLOYED_BYTECODE_HASHES,
  DEPLOYED_BYTECODE_SIZES,
  EXPECTED_DOMAINS,
  EXPECTED_TYPEHASHES,
  SUPPORTS_EIP712,
  TYPEHASH_GETTERS,
  expectedTypehash,
  getInterface,
} from '../../../src/abi/index.js';
import { generate, structNameForTypehashGetter } from '../../../scripts/gen-abi.js';
import { DOMAIN_NAMES, DOMAIN_VERSION } from '../../../src/protocol/constants.js';
import { TYPEHASHES } from '../../../src/protocol/eip712.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Read a compiled artifact.
 *
 * @param {string} name Contract name.
 * @returns {Record<string, any>} Parsed artifact.
 */
function artifact(name) {
  return JSON.parse(
    readFileSync(join(ROOT, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`), 'utf8'),
  );
}

describe('abi: generated, not hand-written', () => {
  it('is byte-identical to a fresh generation from the artifacts', async () => {
    // The same assertion `node scripts/gen-abi.js --check` makes in CI, run inside the suite so a
    // recompile that changes an ABI cannot be committed without regenerating.
    const files = await generate();
    for (const [name, contents] of files) {
      const onDisk = readFileSync(join(ROOT, 'src', 'abi', name), 'utf8');
      assert.equal(onDisk, contents, `src/abi/${name} is stale; run node scripts/gen-abi.js`);
    }
  });

  it('carries every fragment the artifact declares', () => {
    for (const name of CONTRACT_NAMES) {
      assert.equal(
        ABIS[name].length,
        artifact(name).abi.length,
        `${name} ABI length differs from its artifact`,
      );
    }
  });

  it('is frozen so nothing can mutate a shared ABI at runtime', () => {
    for (const name of CONTRACT_NAMES) {
      assert.equal(Object.isFrozen(ABIS[name]), true);
    }
  });

  it('parses into an ethers Interface, memoized', () => {
    const first = getInterface('MemoryLedger');
    assert.equal(getInterface('MemoryLedger'), first, 'the Interface must be memoized');
    assert.ok(first.getFunction('commitMemoryFor'), 'the meta-transaction entrypoint must exist');
  });

  it('refuses an unknown contract name', () => {
    assert.throws(() => getInterface(/** @type {any} */ ('Nope')), /Unknown contract/);
  });
});

describe('abi: typehashes agree with the frozen contracts', () => {
  it('derives a struct name from a getter name', () => {
    assert.equal(structNameForTypehashGetter('MEMORY_COMMIT_TYPEHASH'), 'MemoryCommit');
    assert.equal(structNameForTypehashGetter('KEY_ROTATION_TYPEHASH'), 'KeyRotation');
    assert.equal(structNameForTypehashGetter('ACCESS_GRANT_TYPEHASH'), 'AccessGrant');
    assert.equal(structNameForTypehashGetter('REGISTRATION_TYPEHASH'), 'Registration');
  });

  it('lists exactly the getters the compiled contracts expose', () => {
    assert.deepEqual(TYPEHASH_GETTERS.AgentIdentity, [
      'KEY_ROTATION_TYPEHASH',
      'REGISTRATION_TYPEHASH',
    ]);
    assert.deepEqual(TYPEHASH_GETTERS.MemoryLedger, [
      'MEMORY_COMMIT_TYPEHASH',
      'MEMORY_REVOCATION_TYPEHASH',
    ]);
    assert.deepEqual(TYPEHASH_GETTERS.MemoryAccessControl, ['ACCESS_GRANT_TYPEHASH']);
    assert.deepEqual(
      TYPEHASH_GETTERS.ReputationManager,
      [],
      'ReputationManager has no signed entrypoint',
    );
  });

  it('expects each getter to return the protocol typehash', () => {
    assert.equal(
      expectedTypehash('MemoryLedger', 'MEMORY_COMMIT_TYPEHASH'),
      TYPEHASHES.MemoryCommit,
    );
    assert.equal(
      expectedTypehash('AgentIdentity', 'REGISTRATION_TYPEHASH'),
      TYPEHASHES.Registration,
    );
    assert.equal(
      expectedTypehash('MemoryAccessControl', 'ACCESS_GRANT_TYPEHASH'),
      TYPEHASHES.AccessGrant,
    );
    assert.equal(expectedTypehash('ReputationManager', 'ANYTHING'), null);
  });

  it('covers every getter with an expectation, leaving none unchecked', () => {
    for (const name of CONTRACT_NAMES) {
      for (const getter of TYPEHASH_GETTERS[name]) {
        assert.ok(
          expectedTypehash(name, getter),
          `${name}.${getter} has no expected value, so the boot invariant would skip it`,
        );
      }
    }
  });
});

describe('abi: EIP-712 domains are per contract', () => {
  it('uses the three names the contracts actually declare', () => {
    assert.equal(EXPECTED_DOMAINS.AgentIdentity?.name, 'NeuroMeshAgentIdentity');
    assert.equal(EXPECTED_DOMAINS.MemoryLedger?.name, 'NeuroMeshMemoryLedger');
    assert.equal(EXPECTED_DOMAINS.MemoryAccessControl?.name, 'NeuroMeshAccessControl');
    for (const name of ['AgentIdentity', 'MemoryLedger', 'MemoryAccessControl']) {
      assert.equal(EXPECTED_DOMAINS[name]?.version, DOMAIN_VERSION);
      assert.equal(EXPECTED_DOMAINS[name]?.name, DOMAIN_NAMES[name]);
    }
  });

  it('never probes eip712Domain() on ReputationManager', () => {
    // It has no EIP712 mixin, so the call reverts. A boot invariant that probed every contract
    // uniformly would make a correct deployment fail to start.
    assert.equal(SUPPORTS_EIP712.ReputationManager, false);
    assert.equal(EXPECTED_DOMAINS.ReputationManager, null);
    const iface = getInterface('ReputationManager');
    assert.equal(
      iface.fragments.some((f) => /** @type {any} */ (f).name === 'eip712Domain'),
      false,
    );
  });

  it('does expose eip712Domain() on the three contracts that sign', () => {
    for (const name of ['AgentIdentity', 'MemoryLedger', 'MemoryAccessControl']) {
      assert.equal(SUPPORTS_EIP712[name], true);
      assert.ok(getInterface(name).getFunction('eip712Domain'));
    }
  });
});

describe('abi: detecting the stale deployment', () => {
  it('publishes a bytecode fingerprint for every contract', () => {
    for (const name of CONTRACT_NAMES) {
      assert.match(DEPLOYED_BYTECODE_HASHES[name], /^0x[0-9a-f]{64}$/);
      assert.ok(DEPLOYED_BYTECODE_SIZES[name] > 0);
    }
  });

  it('gives each contract a distinct fingerprint', () => {
    const hashes = CONTRACT_NAMES.map((n) => DEPLOYED_BYTECODE_HASHES[n]);
    assert.equal(new Set(hashes).size, hashes.length);
  });

  it('matches the artifact it was generated from', () => {
    for (const name of CONTRACT_NAMES) {
      const deployed = artifact(name).deployedBytecode;
      assert.equal(DEPLOYED_BYTECODE_SIZES[name], (deployed.length - 2) / 2);
    }
  });

  it('exposes typehashes as the decisive compatibility signal', () => {
    // The v1 contracts at the addresses in contract-addresses.json have no *_TYPEHASH() getters at
    // all, so a call reverts and the node reports contractsCompatible:false. That is the check
    // that must drive the degraded state - a bytecode hash cannot, because immutables and metadata
    // both move it legitimately.
    assert.ok(Object.keys(EXPECTED_TYPEHASHES).length >= 3);
    assert.equal(Object.hasOwn(EXPECTED_TYPEHASHES, 'ReputationManager'), false);
  });
});
