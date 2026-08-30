/**
 * EIP-712 typed data.
 *
 * The point of this suite is that nothing here is asserted against a value typed twice by the same
 * hand. Three independent sources are cross-checked:
 *
 *   1. `src/protocol/eip712.js`             — the module under test.
 *   2. `ethers.TypedDataEncoder`            — an independent, widely used implementation.
 *   3. `contracts/*.sol`                    — the frozen Solidity, read off disk and regex-extracted,
 *                                             so a transcription error in TYPE_STRINGS fails here.
 *
 * The module's own `digestFromParts` is a fourth path: it rebuilds the digest from
 * `keccak256(0x1901 ‖ domainSeparator ‖ structHash)` with an explicit ABI encode, exactly as
 * `MemoryLedger.hashCommit` does in Solidity.
 *
 * No network and no compiler: the contract sources are plain text.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { TypedDataEncoder, Wallet, id, keccak256, toUtf8Bytes } from 'ethers';

import { DOMAIN_NAMES, DOMAIN_VERSION } from '../../../src/protocol/constants.js';
import {
  TYPEHASHES,
  TYPES,
  TYPE_STRINGS,
  assertCanonicalSignature,
  assertFresh,
  buildAccessGrant,
  buildKeyRotation,
  buildMemoryCommit,
  buildMemoryRevocation,
  buildRegistration,
  digest,
  digestFromParts,
  domainSeparator,
  recoverTypedData,
  signTypedData,
  verifyTypedDataSignature,
} from '../../../src/protocol/eip712.js';
import { DeadlineExpiredError, SignatureError } from '../../../src/protocol/errors.js';

const CHAIN_ID = 11155111;
const LEDGER = '0x1563915e194D8CfBA1943570603F7606A3115508';
const IDENTITY = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const ACCESS = '0x0000000000000000000000000000000000000ACc';
const AGENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const GRANTEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ZERO32 = `0x${'00'.repeat(32)}`;
const DEADLINE = 1900000000;

const wallet = new Wallet(`0x${'11'.repeat(32)}`);

const sol = (name) =>
  readFileSync(new URL(`../../../contracts/${name}.sol`, import.meta.url), 'utf8');

/**
 * Extract a `keccak256("…")` literal for a given struct name out of a Solidity source file.
 * The literal is returned byte for byte: EIP-712 type strings contain single spaces between each
 * type and its field name, and normalising whitespace here would defeat the point of the check.
 *
 * @param {string} source Solidity source text.
 * @param {string} structName Struct name the literal must begin with.
 * @returns {string} The exact type string.
 */
function extractTypeString(source, structName) {
  const match = new RegExp(`"(${structName}\\([^"]*\\))"`, 's').exec(source);
  assert.ok(match, `no keccak256("${structName}(...)") literal found in the Solidity source`);
  return match[1];
}

const commit = () =>
  buildMemoryCommit({
    agent: AGENT,
    chainId: CHAIN_ID,
    ledger: LEDGER,
    cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
    prevCidHash: ZERO32,
    model: 'all-MiniLM-L6-v2',
    embeddingDim: 384,
    isEncrypted: true,
    nonce: 0,
    deadline: DEADLINE,
  });

describe('type strings match the frozen Solidity', () => {
  const sources = {
    Registration: () => sol('AgentIdentity'),
    KeyRotation: () => sol('AgentIdentity'),
    MemoryCommit: () => sol('MemoryLedger'),
    MemoryRevocation: () => sol('MemoryLedger'),
    AccessGrant: () => sol('MemoryAccessControl'),
  };

  for (const name of Object.keys(TYPE_STRINGS)) {
    it(`${name} is transcribed verbatim from the contract`, () => {
      assert.equal(TYPE_STRINGS[name], extractTypeString(sources[name](), name));
    });

    it(`${name} TYPES array reproduces the same type string`, () => {
      // This is the check that catches a reordered or renamed field in TYPES: ethers rebuilds the
      // type string from the array, so the two encodings can only agree if the array is right.
      const encoder = new TypedDataEncoder({ [name]: [...TYPES[name]] });
      assert.equal(encoder.encodeType(name), TYPE_STRINGS[name]);
    });

    it(`${name} typehash is keccak256 of that string`, () => {
      assert.equal(TYPEHASHES[name], keccak256(toUtf8Bytes(TYPE_STRINGS[name])));
    });
  }
});

describe('domains match the frozen Solidity', () => {
  const expected = {
    AgentIdentity: 'AgentIdentity',
    MemoryLedger: 'MemoryLedger',
    MemoryAccessControl: 'MemoryAccessControl',
  };

  for (const [key, file] of Object.entries(expected)) {
    it(`${key} uses EIP712("${DOMAIN_NAMES[key]}", "${DOMAIN_VERSION}")`, () => {
      const match = /EIP712\("([^"]+)",\s*"([^"]+)"\)/.exec(sol(file));
      assert.ok(match, `no EIP712(name, version) constructor call found in ${file}.sol`);
      assert.equal(match[1], DOMAIN_NAMES[key]);
      assert.equal(match[2], DOMAIN_VERSION);
    });
  }

  it('has no domain entry for ReputationManager, which has no EIP712 mixin', () => {
    assert.equal(DOMAIN_NAMES.ReputationManager, undefined);
    assert.ok(
      !/EIP712\(/.test(sol('ReputationManager')),
      'if ReputationManager gains an EIP712 mixin, DOMAIN_NAMES must gain an entry',
    );
  });

  it('domainSeparator matches TypedDataEncoder.hashDomain', () => {
    const typed = commit();
    assert.equal(domainSeparator(typed.domain), TypedDataEncoder.hashDomain(typed.domain));
  });
});

describe('digests', () => {
  const builders = {
    MemoryCommit: commit,
    MemoryRevocation: () =>
      buildMemoryRevocation({
        agent: AGENT,
        chainId: CHAIN_ID,
        ledger: LEDGER,
        cidHash: id('cid'),
        reason: id('spam').slice(0, 66),
        nonce: 3,
        deadline: DEADLINE,
      }),
    Registration: () =>
      buildRegistration({
        agent: AGENT,
        chainId: CHAIN_ID,
        identity: IDENTITY,
        publicKey: `0x02${'ab'.repeat(32)}`,
        metadataURI: 'ipfs://meta',
        nonce: 0,
        deadline: DEADLINE,
      }),
    KeyRotation: () =>
      buildKeyRotation({
        agent: AGENT,
        chainId: CHAIN_ID,
        identity: IDENTITY,
        publicKey: `0x03${'cd'.repeat(32)}`,
        nonce: 1,
        deadline: DEADLINE,
      }),
    AccessGrant: () =>
      buildAccessGrant({
        owner: AGENT,
        chainId: CHAIN_ID,
        access: ACCESS,
        cidHash: id('cid'),
        grantee: GRANTEE,
        wrappedKey: `0x${'ee'.repeat(64)}`,
        expiresAt: 0,
        nonce: 2,
        deadline: DEADLINE,
      }),
  };

  for (const [name, build] of Object.entries(builders)) {
    it(`${name}: digest() equals an independent TypedDataEncoder computation`, () => {
      const typed = build();
      const independent = TypedDataEncoder.hash(
        typed.domain,
        { [name]: [...TYPES[name]] },
        typed.value,
      );
      assert.equal(digest(typed), independent);
    });

    it(`${name}: digest() equals keccak256(0x1901 ‖ separator ‖ structHash)`, () => {
      const typed = build();
      assert.equal(digest(typed), digestFromParts(typed));
    });
  }

  it('MemoryCommit hashes the CID and model as UTF-8 strings, as the contract does', () => {
    const typed = commit();
    assert.equal(
      typed.value.cidHash,
      id('bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e'),
    );
    assert.equal(typed.value.modelHash, id('all-MiniLM-L6-v2'));
  });

  it('is bound to chainId: the same message on another chain has a different digest', () => {
    const a = commit();
    const b = buildMemoryCommit({
      agent: AGENT,
      chainId: 1,
      ledger: LEDGER,
      cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
      prevCidHash: ZERO32,
      model: 'all-MiniLM-L6-v2',
      embeddingDim: 384,
      isEncrypted: true,
      nonce: 0,
      deadline: DEADLINE,
    });
    assert.notEqual(digest(a), digest(b));
  });

  it('is bound to verifyingContract: another ledger address has a different digest', () => {
    const b = buildMemoryCommit({
      agent: AGENT,
      chainId: CHAIN_ID,
      ledger: IDENTITY,
      cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
      prevCidHash: ZERO32,
      model: 'all-MiniLM-L6-v2',
      embeddingDim: 384,
      isEncrypted: true,
      nonce: 0,
      deadline: DEADLINE,
    });
    assert.notEqual(digest(commit()), digest(b));
  });

  it('is bound to the nonce, so a signature cannot be replayed', () => {
    const b = buildMemoryCommit({
      agent: AGENT,
      chainId: CHAIN_ID,
      ledger: LEDGER,
      cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
      prevCidHash: ZERO32,
      model: 'all-MiniLM-L6-v2',
      embeddingDim: 384,
      isEncrypted: true,
      nonce: 1,
      deadline: DEADLINE,
    });
    assert.notEqual(digest(commit()), digest(b));
  });
});

describe('signing and recovery', () => {
  it('recovers the signer', async () => {
    const typed = commit();
    const signature = await signTypedData(wallet, typed);
    assert.equal(recoverTypedData(typed, signature), wallet.address);
    assert.doesNotThrow(() => verifyTypedDataSignature(typed, signature, wallet.address));
  });

  it('rejects a signature over a different message', async () => {
    const typed = commit();
    const signature = await signTypedData(wallet, typed);
    const other = buildMemoryCommit({
      agent: AGENT,
      chainId: CHAIN_ID,
      ledger: LEDGER,
      cid: 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e',
      prevCidHash: ZERO32,
      model: 'all-MiniLM-L6-v2',
      embeddingDim: 768,
      isEncrypted: true,
      nonce: 0,
      deadline: DEADLINE,
    });
    assert.throws(() => verifyTypedDataSignature(other, signature, wallet.address), SignatureError);
  });

  it('rejects a malleable high-s signature, which OZ ECDSA also rejects on chain', () => {
    // N/2 + 1, the smallest high-s value.
    const highS = (0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n >> 1n) + 1n;
    const forged = `0x${'11'.repeat(32)}${highS.toString(16).padStart(64, '0')}1b`;
    assert.throws(() => assertCanonicalSignature(forged), /high `s`/);
  });

  it('rejects a malformed signature', () => {
    assert.throws(() => assertCanonicalSignature('0xdead'), SignatureError);
  });
});

describe('assertFresh', () => {
  it('passes before the deadline and throws after it', () => {
    assert.doesNotThrow(() => assertFresh({ deadline: 100 }, 99));
    assert.doesNotThrow(() => assertFresh({ deadline: 100 }, 100));
    assert.throws(() => assertFresh({ deadline: 100 }, 101), DeadlineExpiredError);
  });
});
