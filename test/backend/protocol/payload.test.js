/**
 * The canonical v2 memory payload.
 *
 * The property under test is that a payload is a *function* of its logical content: the same logical
 * memory must always produce the same bytes, therefore the same CID, therefore the same on-chain
 * `cidHash`. That is the whole basis on which a third party can re-derive the CID from the content
 * and check it against the ledger — and it is what the v1 pipeline gave away by handing a JS object
 * to Pinata and writing whatever hash came back on chain.
 *
 * These tests require no network, no key, no model weights and no `.env`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalBytes, cidFromBytes, verifyCid } from '../../../src/protocol/canonical.js';
import { MAX_PAYLOAD_BYTES, PROTOCOL_VERSION } from '../../../src/protocol/constants.js';
import { SchemaValidationError } from '../../../src/protocol/errors.js';
import {
  addressPayload,
  computeContentId,
  computePolicyId,
  embeddingDigest,
  encodeEmbedding,
  parseMemoryPayload,
  serializePayload,
  serializePayloadBytes,
} from '../../../src/protocol/payload.js';

const AGENT_DID = 'did:pkh:eip155:11155111:0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const CONTENT_ID = `0x${'ab'.repeat(16)}`;
const MODEL_ID = `0x${'11'.repeat(32)}`;
const DIGEST = `0x${'22'.repeat(32)}`;

const POLICY = {
  embeddingVisibility: 'grantees',
  redistribution: 'forbidden',
  retentionUntil: 0,
};

/** A sealed payload: `cipher` present, `context` absent, one recipient. */
function sealedPayload(overrides = {}) {
  return {
    v: PROTOCOL_VERSION,
    contentId: CONTENT_ID,
    agentDid: AGENT_DID,
    keyVersion: 1,
    createdAt: 1735689600,
    prevCid: null,
    model: { id: MODEL_ID, uri: 'hf:Xenova/all-MiniLM-L6-v2@sha256:beef', dim: 384 },
    alignment: {
      projectionId: 'neuromesh-proj/v1/achlioptas-s3/aes-256-ctr/384-384/deadbeef',
      dim: 384,
    },
    embedding: {
      visibility: 'grantees',
      encoding: 'f32-b64',
      dim: 4,
      data: null,
      dataDigest: DIGEST,
    },
    lsh: null,
    policy: POLICY,
    cipher: {
      alg: 'NM-SEAL-AES256GCM/v1',
      iv: 'AAAAAAAAAAAAAAAA',
      ct: 'q80',
      tag: 'AAAAAAAAAAAAAAAAAAAAAA',
    },
    context: null,
    recipients: [
      {
        alg: 'ECIES-secp256k1-HKDF-SHA256-AES256GCM/v1',
        addr: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        keyVersion: 1,
        epk: `0x02${'33'.repeat(32)}`,
        iv: 'AAAAAAAAAAAAAAAA',
        ct: 'q80',
        tag: 'AAAAAAAAAAAAAAAAAAAAAA',
      },
    ],
    ...overrides,
  };
}

/** A public payload: `context` present, `cipher` absent, embedding published. */
function publicPayload(overrides = {}) {
  const vector = [0.25, -0.5, 0.75, 1];
  return sealedPayload({
    cipher: null,
    context: 'the user prefers dark mode',
    recipients: [],
    policy: { ...POLICY, embeddingVisibility: 'public' },
    embedding: {
      visibility: 'public',
      encoding: 'f32-b64',
      dim: 4,
      data: encodeEmbedding(vector),
      dataDigest: embeddingDigest(vector),
    },
    ...overrides,
  });
}

describe('schema validation', () => {
  it('accepts a well-formed sealed payload and a well-formed public payload', () => {
    assert.equal(parseMemoryPayload(sealedPayload()).contentId, CONTENT_ID);
    assert.equal(parseMemoryPayload(publicPayload()).context, 'the user prefers dark mode');
  });

  it('rejects a payload that is both sealed and public', () => {
    assert.throws(
      () => parseMemoryPayload(sealedPayload({ context: 'also plaintext' })),
      (err) => err instanceof SchemaValidationError && /Exactly one of/.test(err.message),
    );
  });

  it('rejects a payload that is neither sealed nor public', () => {
    assert.throws(
      () => parseMemoryPayload(sealedPayload({ cipher: null, recipients: [] })),
      (err) => err instanceof SchemaValidationError && /Exactly one of/.test(err.message),
    );
  });

  it('rejects a sealed payload with no recipients — nobody, not even the author, could open it', () => {
    assert.throws(
      () => parseMemoryPayload(sealedPayload({ recipients: [] })),
      (err) => err instanceof SchemaValidationError && /can never be opened/.test(err.message),
    );
  });

  it('rejects an unknown top-level field rather than dropping it', () => {
    // Dropping it would mean the bytes a verifier re-canonicalises differ from the bytes pinned.
    assert.throws(() => parseMemoryPayload(sealedPayload({ extra: 1 })), SchemaValidationError);
  });

  it('rejects a wrong protocol version', () => {
    assert.throws(
      () => parseMemoryPayload(sealedPayload({ v: 'neuromesh/1.0.0' })),
      SchemaValidationError,
    );
  });

  it('rejects a public embedding whose base64 length contradicts its declared dim', () => {
    assert.throws(
      () =>
        parseMemoryPayload(
          publicPayload({
            embedding: {
              visibility: 'public',
              encoding: 'f32-b64',
              dim: 8, // claims 8 floats = 32 bytes; data below carries 4 floats = 16 bytes
              data: encodeEmbedding([1, 2, 3, 4]),
              dataDigest: DIGEST,
            },
          }),
        ),
      SchemaValidationError,
    );
  });

  it('rejects a non-public embedding that nevertheless publishes its data', () => {
    assert.throws(
      () =>
        parseMemoryPayload(
          sealedPayload({
            embedding: {
              visibility: 'grantees',
              encoding: 'f32-b64',
              dim: 4,
              data: encodeEmbedding([1, 2, 3, 4]),
              dataDigest: DIGEST,
            },
          }),
        ),
      SchemaValidationError,
    );
  });
});

describe('canonical serialisation is stable', () => {
  it('key insertion order does not change a single byte', () => {
    const forward = sealedPayload();
    // Rebuild the identical logical payload with the keys inserted in reverse order.
    const reversed = Object.fromEntries(Object.entries(forward).reverse());
    assert.notDeepEqual(Object.keys(forward), Object.keys(reversed), 'orders must actually differ');
    assert.equal(serializePayload(reversed), serializePayload(forward));
  });

  it('serialising twice yields identical bytes and identical CIDs', () => {
    const a = addressPayload(sealedPayload());
    const b = addressPayload(sealedPayload());
    assert.equal(Buffer.from(a.bytes).toString('hex'), Buffer.from(b.bytes).toString('hex'));
    assert.equal(a.cid, b.cid);
    assert.equal(a.cidDigest, b.cidDigest);
    assert.equal(a.payloadHash, b.payloadHash);
  });

  it('the canonical form has sorted keys and no whitespace', () => {
    const json = serializePayload(sealedPayload());
    assert.ok(!/\s(?=(?:[^"]*"[^"]*")*[^"]*$)/.test(json), 'no whitespace outside strings');
    assert.ok(
      json.startsWith('{"agentDid":'),
      `expected the alphabetically first key first: ${json.slice(0, 40)}`,
    );
  });

  it('a one-character change to the context changes the CID', () => {
    const a = addressPayload(publicPayload());
    const b = addressPayload(publicPayload({ context: 'the user prefers dark modE' }));
    assert.notEqual(a.cid, b.cid);
  });

  it('the locally computed CID actually addresses the bytes that were serialised', () => {
    const { bytes, cid, cidDigest } = addressPayload(sealedPayload());
    assert.doesNotThrow(() => verifyCid(bytes, cid));
    assert.equal(cidFromBytes(bytes).digest, cidDigest);
    assert.ok(cid.startsWith('b'), 'CIDv1 base32-lower is multibase-prefixed with "b"');
  });

  it('defaults are applied identically whether an optional field is absent or explicitly null', () => {
    const explicit = sealedPayload();
    const implicit = sealedPayload();
    delete implicit.prevCid;
    delete implicit.lsh;
    delete implicit.context;
    assert.equal(serializePayload(implicit), serializePayload(explicit));
  });

  it('a payload over 1 MiB is refused rather than silently chunked into a DAG', () => {
    const huge = publicPayload({ context: 'x'.repeat(MAX_PAYLOAD_BYTES) });
    assert.throws(() => serializePayloadBytes(huge), { code: 'SCHEMA_INVALID' });
    // (the 64 KiB context cap fires first; the byte cap is asserted directly below)
    assert.throws(() => canonicalBytes({ blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) }), {
      code: 'PAYLOAD_TOO_LARGE',
    });
  });
});

describe('computeContentId', () => {
  it('is deterministic and 16 bytes', () => {
    const content = { context: 'hello', modelId: MODEL_ID, embedding: [1, 2, 3] };
    const id = computeContentId(content);
    assert.match(id, /^0x[0-9a-f]{32}$/);
    assert.equal(computeContentId(content), id);
  });

  it('ignores key order, because it hashes the canonical bytes', () => {
    assert.equal(
      computeContentId({ a: 1, b: 'two', c: [3] }),
      computeContentId({ c: [3], b: 'two', a: 1 }),
    );
  });

  it('changes when any field changes', () => {
    assert.notEqual(computeContentId({ context: 'a' }), computeContentId({ context: 'b' }));
  });

  it('is derived from the plaintext, not from the payload, so the AAD is not a cycle', () => {
    // contentId -> AAD -> ciphertext -> payload -> CID. Deriving contentId from the payload would
    // close that chain into a loop with no fixed point.
    const content = { context: 'hello' };
    const id = computeContentId(content);
    const withCipher = sealedPayload({ contentId: id });
    assert.equal(parseMemoryPayload(withCipher).contentId, id);
    assert.equal(
      computeContentId(content),
      id,
      'assembling the payload must not move the contentId',
    );
  });
});

describe('computePolicyId', () => {
  it('is the keccak of the canonical policy block and is order-independent', () => {
    const id = computePolicyId(POLICY);
    assert.match(id, /^0x[0-9a-f]{64}$/);
    assert.equal(
      computePolicyId({
        retentionUntil: 0,
        redistribution: 'forbidden',
        embeddingVisibility: 'grantees',
      }),
      id,
    );
  });

  it('differs for a different visibility, so the AAD binds the policy that was in force', () => {
    assert.notEqual(
      computePolicyId(POLICY),
      computePolicyId({ ...POLICY, embeddingVisibility: 'public' }),
    );
  });
});

describe('embedding encoding', () => {
  it('round-trips exactly for float32-representable values', () => {
    const vector = [0.25, -0.5, 0.75, 1];
    const bytes = Buffer.from(encodeEmbedding(vector), 'base64url');
    assert.equal(bytes.length, vector.length * 4);
    const back = Array.from({ length: vector.length }, (_, i) => bytes.readFloatLE(i * 4));
    assert.deepEqual(back, vector);
  });

  it('dataDigest commits to the vector, so a recipient can check what it decrypts', () => {
    assert.equal(embeddingDigest([1, 2, 3]), embeddingDigest([1, 2, 3]));
    assert.notEqual(embeddingDigest([1, 2, 3]), embeddingDigest([1, 2, 3.0001]));
  });
});
