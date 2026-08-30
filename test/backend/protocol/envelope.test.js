/**
 * Envelope encryption.
 *
 * The negative cases carry most of the value here: every one of them is an attack the v1 design
 * permitted. Sealing with no AAD let an attacker lift a ciphertext into their own payload; deriving
 * the AES key from the wallet key made sharing equivalent to key disclosure; a blanket 403 on
 * decryption failure was an ownership oracle. Each is now a distinct, asserted failure.
 *
 * No network, no filesystem, no env, no model downloads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DecryptionError, KeyError, ProtocolError } from '../../../src/protocol/errors.js';
import {
  buildAad,
  findEntry,
  generateCek,
  generateContentId,
  open,
  openContent,
  seal,
  sealContent,
  sortRecipients,
  timingSafeEqualBytes,
  unwrapCek,
  wrapCek,
} from '../../../src/protocol/envelope.js';
import { addressFromPrivateKey, deriveEncryptionKey, toDid } from '../../../src/protocol/keys.js';

const CHAIN_ID = 11155111;

/**
 * A deterministic test agent: wallet key, address, DID, and its derived encryption keypair.
 *
 * @param {string} tag Two hex characters repeated to form the wallet key.
 * @returns {{ wallet: string, address: string, did: string, enc: ReturnType<typeof deriveEncryptionKey> }}
 */
function agent(tag) {
  const wallet = `0x${tag.repeat(32)}`;
  const address = addressFromPrivateKey(wallet);
  return {
    wallet,
    address,
    did: toDid(CHAIN_ID, address),
    enc: deriveEncryptionKey(wallet, 1),
  };
}

const alice = agent('11');
const bob = agent('22');
const carol = agent('33');

const CONTENT_ID = '0x0102030405060708090a0b0c0d0e0f10';
const MODEL_ID = `0x${'ab'.repeat(32)}`;

const aadFor = (overrides = {}) =>
  buildAad({
    agentDid: alice.did,
    contentId: CONTENT_ID,
    modelId: MODEL_ID,
    keyVersion: 1,
    ...overrides,
  });

describe('content sealing', () => {
  it('round-trips a Unicode string containing emoji and CJK', () => {
    const cek = generateCek();
    const aad = aadFor();
    const plaintext = 'agent memory: 日本語 · Ελληνικά · 🌍🔐 · line\nbreak';
    const sealed = seal(plaintext, { cek, aad });
    assert.equal(new TextDecoder().decode(open(sealed, { cek, aad })), plaintext);
  });

  it('uses a 12-byte GCM nonce and a 16-byte tag, not the v1 16-byte IV', () => {
    const sealed = seal('x', { cek: generateCek(), aad: aadFor() });
    assert.equal(Buffer.from(sealed.iv, 'base64url').length, 12);
    assert.equal(Buffer.from(sealed.tag, 'base64url').length, 16);
  });

  it('carries an algorithm discriminator so the scheme can be changed later', () => {
    assert.equal(seal('x', { cek: generateCek(), aad: aadFor() }).alg, 'NM-SEAL-AES256GCM/v1');
  });

  it('is randomised: sealing the same plaintext twice gives different ciphertext', () => {
    const cek = generateCek();
    const aad = aadFor();
    assert.notEqual(seal('same', { cek, aad }).ct, seal('same', { cek, aad }).ct);
  });

  it('round-trips a JSON object through the canonical serialiser', () => {
    const cek = generateCek();
    const aad = aadFor();
    const content = { context: 'hello', dims: 384, tags: ['a', 'b'] };
    assert.deepEqual(openContent(sealContent(content, { cek, aad }), { cek, aad }), content);
  });

  it('refuses to seal without an AAD, which is what the v1 design did', () => {
    assert.throws(() => seal('x', { cek: generateCek(), aad: new Uint8Array(0) }), ProtocolError);
  });

  it('refuses a CEK that is not 32 bytes', () => {
    assert.throws(() => seal('x', { cek: new Uint8Array(16), aad: aadFor() }), KeyError);
  });

  it('rejects a v1-shaped 16-byte IV with an actionable message', () => {
    const cek = generateCek();
    const aad = aadFor();
    const sealed = seal('x', { cek, aad });
    sealed.iv = Buffer.alloc(16).toString('base64url');
    assert.throws(() => open(sealed, { cek, aad }), /12 bytes/);
  });
});

describe('AAD binding — one negative case per component', () => {
  const components = {
    agentDid: toDid(CHAIN_ID, bob.address),
    contentId: '0x999999999999999999999999999999ff',
    modelId: `0x${'cd'.repeat(32)}`,
    keyVersion: 2,
    policyId: `0x${'11'.repeat(32)}`,
  };

  for (const [name, tampered] of Object.entries(components)) {
    it(`a different ${name} fails tag verification`, () => {
      const cek = generateCek();
      const sealed = seal('secret', { cek, aad: aadFor() });
      assert.throws(
        () => open(sealed, { cek, aad: aadFor({ [name]: tampered }) }),
        (error) => {
          assert.ok(error instanceof DecryptionError);
          assert.equal(error.code, 'TAG_VERIFY_FAILED');
          return true;
        },
      );
    });
  }

  it('flipping one byte of the ciphertext fails tag verification', () => {
    const cek = generateCek();
    const aad = aadFor();
    const sealed = seal('secret payload', { cek, aad });
    const ct = Buffer.from(sealed.ct, 'base64url');
    ct[0] ^= 0xff;
    sealed.ct = ct.toString('base64url');
    assert.throws(() => open(sealed, { cek, aad }), /TAG_VERIFY_FAILED|tag verification/);
  });

  it('the wrong CEK fails tag verification', () => {
    const aad = aadFor();
    const sealed = seal('secret', { cek: generateCek(), aad });
    assert.throws(() => open(sealed, { cek: generateCek(), aad }), DecryptionError);
  });

  it('rejects an AAD component containing the separator rather than encoding it ambiguously', () => {
    assert.throws(
      () => aadFor({ agentDid: `did:pkh${String.fromCharCode(0x1f)}forged` }),
      /U\+001F/,
    );
  });

  it('rejects a missing AAD component instead of stringifying undefined', () => {
    assert.throws(() => buildAad({ contentId: CONTENT_ID, modelId: MODEL_ID, keyVersion: 1 }), {
      code: 'AAD_COMPONENT_MISSING',
    });
  });

  it('binds the protocol version, so a v1 and a v2 AAD can never collide', () => {
    const aad = Buffer.from(aadFor()).toString('utf8');
    assert.ok(aad.startsWith('neuromesh/2.0.0'));
    assert.equal(aad.split(String.fromCharCode(0x1f)).length, 7);
  });
});

describe('per-recipient key wrapping', () => {
  const wrapFor = (cek, recipient) =>
    wrapCek({
      cek,
      recipientPublicKey: recipient.enc.publicKeyHex,
      recipientAddress: recipient.address,
      grantorDid: alice.did,
      contentId: CONTENT_ID,
      recipientKeyVersion: 1,
    });

  it('a SECOND recipient unwraps the same CEK and recovers identical plaintext', () => {
    const cek = generateCek();
    const aad = aadFor();
    const sealed = seal('shared memory', { cek, aad });

    const recipients = [wrapFor(cek, alice), wrapFor(cek, bob)];

    const bobCek = unwrapCek({
      entry: findEntry(recipients, bob.address, 1),
      recipientPrivateKey: bob.enc.privateKey,
      grantorDid: alice.did,
      contentId: CONTENT_ID,
    });
    assert.deepEqual(Array.from(bobCek), Array.from(cek), 'Bob recovers the exact CEK');
    assert.equal(new TextDecoder().decode(open(sealed, { cek: bobCek, aad })), 'shared memory');
  });

  it('the author self-wrap is what makes the memory recoverable at all', () => {
    const cek = generateCek();
    const recipients = [wrapFor(cek, alice), wrapFor(cek, bob)];
    const aliceEntry = findEntry(recipients, alice.address, 1);
    assert.ok(aliceEntry, 'sealing with a grantee must still wrap for the author');
    const back = unwrapCek({
      entry: aliceEntry,
      recipientPrivateKey: alice.enc.privateKey,
      grantorDid: alice.did,
      contentId: CONTENT_ID,
    });
    assert.deepEqual(Array.from(back), Array.from(cek));
  });

  it('a non-recipient gets "not shared with me", NOT a tag failure', () => {
    const cek = generateCek();
    const recipients = [wrapFor(cek, alice), wrapFor(cek, bob)];
    // Carol is a perfectly valid agent; she was simply never granted access.
    assert.equal(
      findEntry(recipients, carol.address, 1),
      null,
      'the two failure modes must stay distinguishable, or the 403 becomes an ownership oracle',
    );
  });

  it("Carol cannot unwrap Bob's entry even though her keypair is valid", () => {
    const cek = generateCek();
    const entry = wrapFor(cek, bob);
    assert.throws(
      () =>
        unwrapCek({
          entry,
          recipientPrivateKey: carol.enc.privateKey,
          grantorDid: alice.did,
          contentId: CONTENT_ID,
        }),
      { code: 'TAG_VERIFY_FAILED' },
    );
  });

  it('a wrap is bound to its contentId and cannot be replayed onto another memory', () => {
    const cek = generateCek();
    const entry = wrapFor(cek, bob);
    assert.throws(
      () =>
        unwrapCek({
          entry,
          recipientPrivateKey: bob.enc.privateKey,
          grantorDid: alice.did,
          contentId: generateContentId(),
        }),
      { code: 'TAG_VERIFY_FAILED' },
    );
  });

  it('a wrap is bound to the grantor DID', () => {
    const cek = generateCek();
    const entry = wrapFor(cek, bob);
    assert.throws(
      () =>
        unwrapCek({
          entry,
          recipientPrivateKey: bob.enc.privateKey,
          grantorDid: bob.did,
          contentId: CONTENT_ID,
        }),
      { code: 'TAG_VERIFY_FAILED' },
    );
  });

  it('a wrap cannot be re-addressed to another recipient', () => {
    const cek = generateCek();
    const entry = { ...wrapFor(cek, bob), addr: carol.address };
    assert.throws(
      () =>
        unwrapCek({
          entry,
          recipientPrivateKey: bob.enc.privateKey,
          grantorDid: alice.did,
          contentId: CONTENT_ID,
        }),
      { code: 'TAG_VERIFY_FAILED' },
    );
  });

  it('flipping one byte of a wrapped CEK fails', () => {
    const cek = generateCek();
    const entry = wrapFor(cek, bob);
    const ct = Buffer.from(entry.ct, 'base64url');
    ct[0] ^= 0xff;
    assert.throws(
      () =>
        unwrapCek({
          entry: { ...entry, ct: ct.toString('base64url') },
          recipientPrivateKey: bob.enc.privateKey,
          grantorDid: alice.did,
          contentId: CONTENT_ID,
        }),
      { code: 'TAG_VERIFY_FAILED' },
    );
  });

  it('rejects an off-curve recipient public key rather than doing invalid-curve ECDH', () => {
    assert.throws(
      () =>
        wrapCek({
          cek: generateCek(),
          recipientPublicKey: `0x02${'00'.repeat(32)}`,
          recipientAddress: bob.address,
          grantorDid: alice.did,
          contentId: CONTENT_ID,
        }),
      { code: 'INVALID_PUBLIC_KEY' },
    );
  });

  it('uses a fresh ephemeral key per wrap, so two wraps never share a KEK', () => {
    const cek = generateCek();
    assert.notEqual(wrapFor(cek, bob).epk, wrapFor(cek, bob).epk);
  });

  it('a wrapped entry fits inside Limits.MAX_WRAPPED_KEY_BYTES', () => {
    const entry = wrapFor(generateCek(), bob);
    const wire = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    assert.ok(wire < 512, `wrapped entry is ${wire} bytes, over the 512-byte on-chain bound`);
  });
});

describe('findEntry and sortRecipients', () => {
  it('returns null for an unknown address rather than throwing', () => {
    assert.equal(findEntry([], alice.address), null);
    assert.equal(findEntry(null, alice.address), null);
  });

  it('matches on the checksummed address regardless of input casing', () => {
    const entry = { addr: bob.address, keyVersion: 1 };
    assert.equal(findEntry([entry], bob.address.toLowerCase(), 1), entry);
  });

  it('selects the highest key version when none is specified', () => {
    const v1 = { addr: bob.address, keyVersion: 1 };
    const v3 = { addr: bob.address, keyVersion: 3 };
    assert.equal(findEntry([v1, v3], bob.address), v3);
    assert.equal(findEntry([v1, v3], bob.address, 1), v1);
    assert.equal(findEntry([v1, v3], bob.address, 2), null);
  });

  it('sorts recipients into a canonical order so payload bytes depend on the set, not the order', () => {
    const entries = [alice, bob, carol].map((a) => ({ addr: a.address, keyVersion: 1 }));
    const forward = sortRecipients(entries).map((e) => e.addr);
    const reverse = sortRecipients([...entries].reverse()).map((e) => e.addr);
    assert.deepEqual(forward, reverse);
    assert.deepEqual(forward, [...forward].sort());
  });
});

describe('timingSafeEqualBytes', () => {
  it('compares equal and unequal values without throwing on a length mismatch', () => {
    assert.equal(timingSafeEqualBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 2])), true);
    assert.equal(timingSafeEqualBytes(Uint8Array.from([1, 2]), Uint8Array.from([1, 3])), false);
    assert.equal(timingSafeEqualBytes(Uint8Array.from([1]), Uint8Array.from([1, 2])), false);
  });
});

describe('the removed v1 API', () => {
  it('lib/encryption.js encryptMemory/decryptMemory throw REMOVED_UNSAFE_API', async () => {
    const legacy = await import('../../../lib/encryption.js');
    assert.throws(() => legacy.encryptMemory('x', 'pk'), { code: 'REMOVED_UNSAFE_API' });
    assert.throws(() => legacy.decryptMemory({}, 'pk'), { code: 'REMOVED_UNSAFE_API' });
  });

  it('lib/encryption.js still re-exports the safe v2 surface', async () => {
    const legacy = await import('../../../lib/encryption.js');
    for (const name of ['seal', 'open', 'wrapCek', 'unwrapCek', 'buildAad', 'generateCek']) {
      assert.equal(typeof legacy[name], 'function', `${name} should be re-exported`);
    }
  });
});
