/**
 * Key hierarchy.
 *
 * The property under test is separation: the encryption key must be derivable from the wallet key,
 * must not equal it, must not reveal it, and must change when the version changes. The v1 design
 * failed the first three by construction, because it *was* the wallet key.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SigningKey, Wallet } from 'ethers';

import { KeyError } from '../../../src/protocol/errors.js';
import {
  addressFromPrivateKey,
  assertCompressedPublicKey,
  concatBytes,
  deriveEncryptionKey,
  fromDid,
  importEncryptionKey,
  publicKeyFromHex,
  publicKeyToHex,
  toDid,
  toPrivateKeyBytes,
  uint32be,
  withKey,
  zeroize,
} from '../../../src/protocol/keys.js';

const WALLET = `0x${'11'.repeat(32)}`;
const OTHER = `0x${'22'.repeat(32)}`;
const hex = (bytes) => Buffer.from(bytes).toString('hex');

describe('deriveEncryptionKey', () => {
  it('is deterministic across calls and would be across processes', () => {
    const a = deriveEncryptionKey(WALLET, 1);
    const b = deriveEncryptionKey(WALLET, 1);
    assert.equal(hex(a.privateKey), hex(b.privateKey));
    assert.equal(a.publicKeyHex, b.publicKeyHex);
  });

  it('does NOT equal the wallet signing key — the whole point of the module', () => {
    const derived = deriveEncryptionKey(WALLET, 1);
    assert.notEqual(hex(derived.privateKey), WALLET.slice(2));
    assert.notEqual(derived.publicKeyHex, new SigningKey(WALLET).compressedPublicKey);
  });

  it('leaking the encryption key does not reveal the wallet address', () => {
    // The derived key is an independent identity: it controls a different address entirely, so an
    // attacker who exfiltrates it holds no authority over the agent's on-chain records.
    const derived = deriveEncryptionKey(WALLET, 1);
    assert.notEqual(
      new Wallet(publicKeyToHex(derived.privateKey)).address,
      new Wallet(WALLET).address,
    );
  });

  it('is versioned: bumping keyVersion yields an unrelated keypair', () => {
    const v1 = deriveEncryptionKey(WALLET, 1);
    const v2 = deriveEncryptionKey(WALLET, 2);
    assert.notEqual(hex(v1.privateKey), hex(v2.privateKey));
    assert.equal(v1.keyVersion, 1);
    assert.equal(v2.keyVersion, 2);
  });

  it('separates agents: two wallets never share an encryption key', () => {
    assert.notEqual(
      deriveEncryptionKey(WALLET, 1).publicKeyHex,
      deriveEncryptionKey(OTHER, 1).publicKeyHex,
    );
  });

  it('produces a valid 33-byte compressed public key', () => {
    const { publicKey, publicKeyHex } = deriveEncryptionKey(WALLET, 1);
    assert.equal(publicKey.length, 33);
    assert.doesNotThrow(() => assertCompressedPublicKey(publicKeyHex));
  });

  it('rejects a malformed wallet key rather than deriving from garbage', () => {
    assert.throws(() => deriveEncryptionKey('not-a-key'), KeyError);
    assert.throws(() => deriveEncryptionKey(`0x${'00'.repeat(32)}`), KeyError);
  });

  it('rejects an out-of-range key version', () => {
    assert.throws(() => deriveEncryptionKey(WALLET, -1), KeyError);
    assert.throws(() => deriveEncryptionKey(WALLET, 2 ** 32), KeyError);
  });
});

describe('importEncryptionKey', () => {
  it('accepts an independently generated key and reports the same shape', () => {
    const imported = importEncryptionKey(OTHER, 7);
    assert.equal(imported.keyVersion, 7);
    assert.equal(imported.publicKeyHex, new SigningKey(OTHER).compressedPublicKey);
  });
});

describe('assertCompressedPublicKey', () => {
  it('accepts a real compressed key', () => {
    assert.doesNotThrow(() =>
      assertCompressedPublicKey(new SigningKey(WALLET).compressedPublicKey),
    );
  });

  it('rejects the uncompressed form', () => {
    assert.throws(() => assertCompressedPublicKey(new SigningKey(WALLET).publicKey), {
      code: 'INVALID_PUBLIC_KEY',
    });
  });

  it('rejects a bad prefix byte', () => {
    const real = publicKeyFromHex(new SigningKey(WALLET).compressedPublicKey);
    real[0] = 0x04;
    assert.throws(() => assertCompressedPublicKey(real), /0x02 or 0x03/);
  });

  it('rejects an off-curve x coordinate — the invalid-curve attack surface', () => {
    assert.throws(() => assertCompressedPublicKey(`0x02${'00'.repeat(32)}`), /not a point/);
  });
});

describe('did:pkh', () => {
  it('round-trips and checksums the address', () => {
    const address = addressFromPrivateKey(WALLET);
    const did = toDid(11155111, address);
    assert.equal(did, `did:pkh:eip155:11155111:${address}`);
    assert.deepEqual(fromDid(did), { chainId: 11155111, address });
  });

  it('accepts a lower-case input address and emits the checksummed form', () => {
    const address = addressFromPrivateKey(WALLET);
    assert.equal(toDid(1, address.toLowerCase()), `did:pkh:eip155:1:${address}`);
  });

  it('rejects a non-checksummed DID, so DIDs compare with ===', () => {
    const address = addressFromPrivateKey(WALLET);
    assert.throws(() => fromDid(`did:pkh:eip155:1:${address.toLowerCase()}`), {
      code: 'INVALID_DID',
    });
  });

  it('rejects a malformed DID', () => {
    for (const bad of ['', 'did:key:z6Mk', 'did:pkh:eip155:1:0xzz', undefined]) {
      assert.throws(() => fromDid(bad), { code: 'INVALID_DID' });
    }
  });
});

describe('byte helpers', () => {
  it('uint32be is big-endian and fixed width', () => {
    assert.deepEqual(Array.from(uint32be(1)), [0, 0, 0, 1]);
    assert.deepEqual(Array.from(uint32be(0xdeadbeef)), [0xde, 0xad, 0xbe, 0xef]);
  });

  it('concatBytes joins in order', () => {
    assert.deepEqual(
      Array.from(concatBytes(Uint8Array.from([1]), Uint8Array.from([2, 3]))),
      [1, 2, 3],
    );
  });

  it('zeroize clears a buffer and tolerates null', () => {
    const b = Uint8Array.from([1, 2, 3]);
    zeroize(b);
    assert.deepEqual(Array.from(b), [0, 0, 0]);
    assert.doesNotThrow(() => zeroize(null));
  });

  it('withKey zeroises even when the callback throws', () => {
    const key = Uint8Array.from([9, 9, 9]);
    assert.throws(() => {
      withKey(key, () => {
        throw new Error('boom');
      });
    }, /boom/);
    assert.deepEqual(Array.from(key), [0, 0, 0]);
  });

  it('toPrivateKeyBytes accepts hex with and without the 0x prefix', () => {
    assert.deepEqual(toPrivateKeyBytes(WALLET), toPrivateKeyBytes(WALLET.slice(2)));
  });
});
