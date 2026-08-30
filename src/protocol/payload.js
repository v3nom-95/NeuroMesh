/**
 * NeuroMesh Protocol — the canonical IPFS memory payload, v2.
 *
 * ## Why this file is the centre of the proof chain
 *
 * The on-chain record is a hash of a CID, the CID is a hash of these bytes, and this module is the
 * only thing that decides what those bytes are. If two implementations disagree here by one byte,
 * they disagree on the CID, and every "verifiable" claim above them collapses. So the serialisation
 * is fixed by construction rather than by convention:
 *
 *   - `serializePayload` is deterministic: keys are emitted in ascending UTF-16 order, arrays keep
 *     their order, and there is exactly one spelling for every value.
 *   - **No non-integer JSON numbers exist anywhere in a payload.** Embeddings and any other real
 *     values travel as base64url of a little-endian `Float32Array`. This removes the single largest
 *     source of cross-language canonicalisation disagreement — float printing — at the cost of a
 *     payload that is slightly less pleasant to read by eye. For a document whose hash *is* the
 *     proof, that is the right trade.
 *   - The schema is strict: an unknown top-level key is an error, not a passthrough, because a
 *     verifier that ignored unknown keys would hash bytes it did not understand.
 *
 * ## Embedding visibility
 *
 * `policy.embeddingVisibility` is an explicit, per-memory decision with three values and a default
 * of `grantees`, because publishing a plaintext embedding alongside an encrypted context protects
 * very little: sentence embeddings are substantially invertible (Song & Raghunathan, CCS 2020;
 * Morris et al., "Text Embeddings Reveal (Almost) As Much As Text", EMNLP 2023, recovering 92% of
 * 32-token inputs from a 768-d vector). `public` is documented as approximately equivalent to
 * publishing the text.
 *
 * @module src/protocol/payload
 */

import { z } from 'zod';

import {
  b64u,
  canonicalBytes,
  canonicalize,
  cidFromBytes,
  payloadHash,
  sha256,
} from './canonical.js';
import { CONTENT_ID_BYTES, PROTOCOL_VERSION } from './constants.js';
import { SchemaValidationError } from './errors.js';

/* -------------------------------------------------------------------------- */
/* Primitive schemas                                                           */
/* -------------------------------------------------------------------------- */

/** 0x-prefixed 32-byte hex. */
export const Bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'expected 0x + 64 lower-case hex');

/** 0x-prefixed 16-byte hex — the content identifier. */
export const ContentId = z.string().regex(/^0x[0-9a-f]{32}$/, 'expected 0x + 32 lower-case hex');

/** Unpadded base64url. */
export const B64Url = z.string().regex(/^[A-Za-z0-9_-]*$/, 'expected unpadded base64url');

/** `did:pkh:eip155:<chainId>:<checksummed address>`. */
export const DidPkh = z
  .string()
  .regex(/^did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}$/, 'expected a did:pkh:eip155 identifier');

/* -------------------------------------------------------------------------- */
/* Block schemas                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The embedding model, pinned by a digest rather than by a human-readable name.
 *
 * A model *name* is not a version: `all-MiniLM-L6-v2` can be re-uploaded, re-quantised or re-exported
 * to ONNX, and every such change moves the embedding space while the name stays put. `id` is the
 * keccak of the canonical URI, and `uri` carries the resolved weights digest so a verifier can check
 * which weights actually produced the vector.
 */
export const ModelRef = z.strictObject({
  id: Bytes32,
  uri: z.string().min(1).max(512),
  dim: z.int().min(1).max(8192),
});

/** Which deterministic projection the aligned vector was produced by. */
export const AlignmentRef = z.strictObject({
  projectionId: z.string().min(1).max(160),
  dim: z.int().min(1).max(8192),
});

/**
 * The aligned embedding.
 *
 * `data` is present only when `visibility === 'public'`; otherwise the vector lives inside the
 * sealed content block and only `dataDigest` (sha2-256 over the decoded float32 bytes) is published,
 * so a recipient can check that the vector they decrypt is the one the author committed to.
 */
export const EmbeddingBlock = z
  .strictObject({
    visibility: z.enum(['public', 'grantees', 'lsh-only']),
    encoding: z.literal('f32-b64'),
    dim: z.int().min(1).max(8192),
    data: B64Url.nullable().default(null),
    dataDigest: Bytes32,
  })
  .superRefine((value, ctx) => {
    if (value.visibility === 'public' && value.data === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'embedding.data is required when visibility is "public"',
        path: ['data'],
      });
    }
    if (value.visibility !== 'public' && value.data !== null) {
      ctx.addIssue({
        code: 'custom',
        message:
          'embedding.data must be null unless visibility is "public"; a non-public embedding ' +
          'travels inside the sealed content block',
        path: ['data'],
      });
    }
    if (value.data !== null) {
      const bytes = Buffer.from(value.data, 'base64url');
      if (bytes.length !== value.dim * 4) {
        ctx.addIssue({
          code: 'custom',
          message: `embedding.data decodes to ${bytes.length} bytes; dim ${value.dim} requires ${value.dim * 4}`,
          path: ['data'],
        });
      }
    }
  });

/** Optional locality-sensitive signature published for candidate retrieval. */
export const LshBlock = z.strictObject({
  alg: z.literal('simhash'),
  bits: z.int().min(8).max(4096),
  sig: B64Url,
});

/** A sealed content block. */
export const CipherBlockSchema = z.strictObject({
  alg: z.string().min(1).max(64),
  iv: B64Url,
  ct: B64Url,
  tag: B64Url,
});

/** One recipient's ECIES-wrapped copy of the CEK. */
export const RecipientEntrySchema = z.strictObject({
  alg: z.string().min(1).max(96),
  addr: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  keyVersion: z.int().min(0).max(4294967295),
  epk: z.string().regex(/^0x0[23][0-9a-f]{64}$/),
  iv: B64Url,
  ct: B64Url,
  tag: B64Url,
});

/** The per-memory policy. Hashed into `policyId`, which is bound into the content AAD. */
export const PolicyBlock = z.strictObject({
  embeddingVisibility: z.enum(['public', 'grantees', 'lsh-only']),
  /** Whether the author permits grantees to re-share the CEK. Advisory: unenforceable off-chain. */
  redistribution: z.enum(['forbidden', 'grantees', 'public']),
  /** Unix seconds after which the author asks consumers to stop serving the memory; 0 = never. */
  retentionUntil: z.int().min(0),
});

/* -------------------------------------------------------------------------- */
/* The payload                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The canonical v2 memory payload.
 *
 * `createdAt` is a signer-asserted timestamp and is explicitly **not** proof of when the memory was
 * formed. The only temporal fact anyone can verify is the block timestamp of the commit, which is an
 * upper bound on inclusion time (proposer-chosen within consensus bounds, +/- one slot), not a
 * statement about authorship time.
 */
export const MemoryPayloadV2 = z.strictObject({
  v: z.literal(PROTOCOL_VERSION),
  contentId: ContentId,
  agentDid: DidPkh,
  keyVersion: z.int().min(0).max(4294967295),
  createdAt: z.int().min(0),
  prevCid: z.string().min(1).max(100).nullable().default(null),
  model: ModelRef,
  alignment: AlignmentRef,
  embedding: EmbeddingBlock,
  lsh: LshBlock.nullable().default(null),
  policy: PolicyBlock,
  /** Present iff the context is sealed. Mutually exclusive with `context`. */
  cipher: CipherBlockSchema.nullable().default(null),
  /** Plaintext context. Present only for a deliberately public memory. */
  context: z.string().max(65536).nullable().default(null),
  recipients: z.array(RecipientEntrySchema).max(256).default([]),
});

/**
 * @typedef {z.infer<typeof MemoryPayloadV2>} MemoryPayload
 */

/**
 * Parse and validate an unknown value as a v2 memory payload.
 *
 * Beyond the schema, two cross-field invariants are enforced, because either one being wrong makes
 * the payload self-contradictory rather than merely odd:
 *   - exactly one of `cipher` / `context` is present;
 *   - a sealed payload has at least one recipient, otherwise nobody — including its own author — can
 *     ever open it, and the memory is write-only garbage occupying a paid pin.
 *
 * @param {unknown} value Candidate payload.
 * @returns {MemoryPayload} The validated payload.
 * @throws {SchemaValidationError} With `details.issues` carrying zod's issue list.
 */
export function parseMemoryPayload(value) {
  const result = MemoryPayloadV2.safeParse(value);
  if (!result.success) {
    throw new SchemaValidationError(
      'Memory payload failed schema validation.',
      result.error.issues,
    );
  }
  const payload = result.data;
  const sealed = payload.cipher !== null;
  if (sealed === (payload.context !== null)) {
    throw new SchemaValidationError(
      'Exactly one of `cipher` and `context` must be present: a payload is either sealed or public.',
      [],
    );
  }
  if (sealed && payload.recipients.length === 0) {
    throw new SchemaValidationError(
      'A sealed payload with no recipients can never be opened, not even by its author.',
      [],
    );
  }
  return payload;
}

/* -------------------------------------------------------------------------- */
/* Canonical serialisation                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Serialise a payload to its canonical JSON string.
 *
 * The payload is validated first, so a malformed object can never reach the hash. The same logical
 * payload always yields the same string, therefore the same bytes, therefore the same CID — which is
 * the property that lets a stranger re-derive the CID from the content and check the ledger.
 *
 * @param {unknown} payload Payload to serialise.
 * @returns {string} Canonical JSON.
 */
export function serializePayload(payload) {
  return canonicalize(parseMemoryPayload(payload));
}

/**
 * Canonical UTF-8 bytes of a payload.
 *
 * @param {unknown} payload Payload to serialise.
 * @returns {Uint8Array} Canonical bytes; never exceeds 1 MiB (a larger payload throws).
 */
export function serializePayloadBytes(payload) {
  return canonicalBytes(parseMemoryPayload(payload));
}

/**
 * Everything derived from a payload's bytes, in one call.
 *
 * @param {unknown} payload Payload to address.
 * @returns {{ bytes: Uint8Array, cid: string, cidDigest: string, payloadHash: string }} The exact
 *   bytes to pin, the locally computed CIDv1, its sha2-256 digest, and the keccak256 the chain uses.
 */
export function addressPayload(payload) {
  const bytes = serializePayloadBytes(payload);
  const { cid, digest } = cidFromBytes(bytes);
  return { bytes, cid, cidDigest: digest, payloadHash: payloadHash(bytes) };
}

/* -------------------------------------------------------------------------- */
/* Content identifiers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic content identifier for a *logical* memory.
 *
 * Takes the **plaintext content object** — not the assembled payload — and returns the first 16
 * bytes of `sha256(canonicalBytes(content))`. Deriving it from the plaintext rather than from the
 * payload is not a stylistic choice: `contentId` is bound into the encryption AAD, the AAD produces
 * the ciphertext, the ciphertext goes into the payload, and the payload produces the CID. Deriving
 * `contentId` from the payload would close that loop into a cycle with no fixed point.
 *
 * Determinism means re-authoring the same content twice produces the same `contentId`, which makes
 * duplicate commits detectable. When that linkability is unwanted — because `contentId` is public
 * and a deterministic id lets an observer test a guessed plaintext — use
 * `envelope.generateContentId()` instead, which draws 16 random bytes.
 *
 * @param {object} content The plaintext content object (e.g. `{ context, embedding, modelId }`).
 * @returns {string} 0x-prefixed 16-byte hex.
 */
export function computeContentId(content) {
  const digest = sha256(canonicalBytes(content));
  return `0x${Buffer.from(digest.subarray(0, CONTENT_ID_BYTES)).toString('hex')}`;
}

/**
 * keccak256 of a canonicalised policy block — the `policyId` bound into the content AAD.
 *
 * @param {unknown} policy Policy block.
 * @returns {string} 0x-prefixed 32-byte hex.
 */
export function computePolicyId(policy) {
  return payloadHash(canonicalBytes(PolicyBlock.parse(policy)));
}

/**
 * sha2-256 over the little-endian float32 encoding of a vector — the value published as
 * `embedding.dataDigest`, so a recipient can verify the vector they decrypt is the committed one.
 *
 * @param {ArrayLike<number>} vector Aligned embedding.
 * @returns {string} 0x-prefixed 32-byte hex.
 */
export function embeddingDigest(vector) {
  const buf = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < vector.length; i += 1) view.setFloat32(i * 4, vector[i], true);
  const bytes = new Uint8Array(buf);
  return `0x${Buffer.from(sha256(bytes)).toString('hex')}`;
}

/**
 * base64url of the little-endian float32 encoding of a vector.
 *
 * @param {ArrayLike<number>} vector Aligned embedding.
 * @returns {string} base64url.
 */
export function encodeEmbedding(vector) {
  const buf = new ArrayBuffer(vector.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < vector.length; i += 1) view.setFloat32(i * 4, vector[i], true);
  return b64u(new Uint8Array(buf));
}
