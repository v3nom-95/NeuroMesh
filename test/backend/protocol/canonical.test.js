/**
 * Canonicalisation, hashing and content addressing.
 *
 * These are known-answer tests wherever an external answer exists, because this module is the one
 * place where "our bytes" must equal "everyone else's bytes". No network, no filesystem, no env.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCanonical,
  b64ToF32,
  b64u,
  canonicalBytes,
  canonicalize,
  cidFromBytes,
  digestFromCid,
  f32ToB64,
  payloadHash,
  sha256Hex,
  unb64u,
  verifyCid,
} from '../../../src/protocol/canonical.js';
import { CanonicalizationError, CidMismatchError } from '../../../src/protocol/errors.js';

const enc = (s) => new TextEncoder().encode(s);

describe('canonicalize', () => {
  it('sorts object keys and is stable regardless of insertion order', () => {
    const a = { zeta: 1, alpha: 2, mid: { b: 1, a: 2 } };
    const b = { mid: { a: 2, b: 1 }, alpha: 2, zeta: 1 };
    assert.equal(canonicalize(a), '{"alpha":2,"mid":{"a":2,"b":1},"zeta":1}');
    assert.equal(canonicalize(a), canonicalize(b));
  });

  it('preserves array order', () => {
    assert.equal(canonicalize([3, 1, 2]), '[3,1,2]');
    assert.notEqual(canonicalize([3, 1, 2]), canonicalize([1, 2, 3]));
  });

  it('produces byte-identical output across 100 shuffles of the same logical object', () => {
    const keys = ['v', 'contentId', 'agentDid', 'keyVersion', 'createdAt', 'model', 'zz', 'a'];
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const reference = canonicalize(Object.fromEntries(keys.map((k, i) => [k, values[i]])));
    for (let n = 0; n < 100; n += 1) {
      const order = [...keys.keys()].sort(() => ((n * 31 + 7) % 3) - 1);
      const shuffled = Object.fromEntries(order.map((i) => [keys[i], values[i]]));
      assert.equal(canonicalize(shuffled), reference);
    }
  });

  it('sorts by UTF-16 code unit, which is what RFC 8785 specifies', () => {
    // 'Z' (0x5A) sorts before 'a' (0x61); 'a' before 'ä' (0xE4).
    assert.equal(canonicalize({ ä: 1, a: 2, Z: 3 }), '{"Z":3,"a":2,"ä":1}');
  });

  it('escapes strings the way JSON.stringify does', () => {
    assert.equal(canonicalize({ s: 'a"b\\c\nd' }), '{"s":"a\\"b\\\\c\\nd"}');
    assert.equal(canonicalize('日本語 🌍'), '"日本語 🌍"');
  });

  it('rejects every value the restricted profile forbids', () => {
    const cases = [
      ['float', { x: 1.5 }],
      ['NaN', { x: NaN }],
      ['Infinity', { x: Infinity }],
      ['negative zero', { x: -0 }],
      ['unsafe integer', { x: 2 ** 53 }],
      ['undefined', { x: undefined }],
      ['function', { x: () => 1 }],
      ['symbol', { x: Symbol('s') }],
      ['bigint', { x: 1n }],
    ];
    for (const [label, value] of cases) {
      assert.throws(() => canonicalize(value), CanonicalizationError, `should reject ${label}`);
    }
  });

  it('rejects a string containing the AAD separator U+001F', () => {
    assert.throws(
      () => canonicalize({ s: `a${String.fromCharCode(0x1f)}b` }),
      /U\+001F/,
      'a payload field must not be able to forge an AAD boundary',
    );
  });

  it('rejects cycles instead of overflowing the stack', () => {
    const a = { name: 'a' };
    a.self = a;
    assert.throws(() => canonicalize(a), /Cyclic/);
  });

  it('rejects class instances, which have no canonical JSON form', () => {
    assert.throws(() => canonicalize({ d: new Date(0) }), CanonicalizationError);
  });

  it('accepts null, booleans and nested empties', () => {
    assert.equal(
      canonicalize({ a: null, b: true, c: false, d: [], e: {} }),
      '{"a":null,"b":true,"c":false,"d":[],"e":{}}',
    );
  });
});

describe('assertCanonical', () => {
  it('accepts bytes produced by canonicalBytes', () => {
    assert.doesNotThrow(() => assertCanonical(canonicalBytes({ b: 1, a: 2 })));
  });

  it('rejects semantically equal but differently ordered bytes', () => {
    assert.throws(() => assertCanonical(enc('{"b":1,"a":2}')), /not in canonical form/);
  });

  it('rejects non-JSON bytes', () => {
    assert.throws(() => assertCanonical(enc('{oops')), /not valid JSON/);
  });
});

describe('CIDv1 (raw, sha2-256)', () => {
  it('matches the canonical IPFS answer for "hello world"', () => {
    // `echo -n "hello world" | ipfs add --cid-version=1 --raw-leaves -n`
    const { cid } = cidFromBytes(enc('hello world'));
    assert.equal(cid, 'bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e');
  });

  it('matches the canonical IPFS answer for the empty payload', () => {
    const { cid } = cidFromBytes(new Uint8Array(0));
    assert.equal(cid, 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
  });

  it('round-trips the digest through digestFromCid', () => {
    const { cid, digest } = cidFromBytes(enc('neuromesh'));
    assert.equal(digestFromCid(cid), digest);
    assert.equal(digest, sha256Hex(enc('neuromesh')));
  });

  it('rejects a CIDv0, which addresses dag-pb rather than the payload bytes', () => {
    assert.throws(() => digestFromCid('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'), /CIDv0/);
  });

  it('rejects an unknown multibase prefix', () => {
    assert.throws(() => digestFromCid('zabcdef'), /multibase/);
  });

  it('rejects a dag-pb CIDv1 rather than mis-parsing it', () => {
    // bafybei… is CIDv1 with codec dag-pb (0x70), not raw (0x55).
    assert.throws(
      () => digestFromCid('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'),
      /not v1\/raw\/sha2-256/,
    );
  });

  it('verifyCid throws CidMismatchError when a third party reports a different CID', () => {
    const bytes = enc('payload');
    assert.doesNotThrow(() => verifyCid(bytes, cidFromBytes(bytes).cid));
    assert.throws(
      () => verifyCid(bytes, cidFromBytes(enc('other')).cid),
      CidMismatchError,
      'the pinning service must not be trusted for the CID',
    );
  });
});

describe('payloadHash', () => {
  it('is keccak256, matching what Solidity computes', () => {
    // keccak256("") — the well-known empty-input digest.
    assert.equal(
      payloadHash(new Uint8Array(0)),
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
  });
});

describe('codecs', () => {
  it('base64url round-trips and is unpadded', () => {
    const bytes = Uint8Array.from([0xfb, 0xff, 0x00, 0x01, 0x02]);
    const text = b64u(bytes);
    assert.ok(!text.includes('='), 'no padding');
    assert.ok(!/[+/]/.test(text), 'url alphabet');
    assert.deepEqual(unb64u(text), bytes);
  });

  it('float32 round-trips through an explicit little-endian encoding', () => {
    const v = Float32Array.from([0, 1, -1, 0.5, 1e-8, -3.25]);
    const decoded = b64ToF32(f32ToB64(v));
    assert.deepEqual(Array.from(decoded), Array.from(v));
  });

  it('encodes little-endian regardless of host order', () => {
    // 1.0f is 0x3F800000; little-endian bytes are 00 00 80 3F.
    assert.deepEqual(Array.from(unb64u(f32ToB64([1]))), [0x00, 0x00, 0x80, 0x3f]);
  });

  it('rejects a float32 blob whose length is not a multiple of 4', () => {
    assert.throws(() => b64ToF32(b64u(Uint8Array.from([1, 2, 3]))), CanonicalizationError);
  });
});
