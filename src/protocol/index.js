/**
 * NeuroMesh Protocol — public barrel.
 *
 * This is the single import surface for the backend, the scripts and any standalone verifier.
 * Consumers import from `src/protocol/index.js`, never from an individual module, so that the
 * internal file layout can change without touching call sites.
 *
 * The modules, and what each one is responsible for:
 *
 *   constants   Every protocol literal, including the block mirrored from `Limits.sol`.
 *   errors      Typed errors; callers branch on `error.code`, never on message text.
 *   canonical   RFC 8785 canonicalisation, hashing, CIDv1, base64url and float32 codecs.
 *   eip712      The five signed structs, transcribed from the deployed Solidity.
 *   keys        did:pkh, and derivation of an encryption keypair separate from the signing key.
 *   envelope    Envelope encryption: AEAD content sealing with AAD, ECIES per-recipient key wrap.
 *   payload     The canonical v2 memory payload: zod schema, deterministic serialiser, content id.
 *   projection  Deterministic, seeded, versioned cross-model projection.
 *   similarity  Cosine similarity and the trust-weighted retrieval ranking.
 *
 * @module src/protocol
 */

export * as canonical from './canonical.js';
export * as constants from './constants.js';
export * as eip712 from './eip712.js';
export * as envelope from './envelope.js';
export * as keys from './keys.js';
export * as payload from './payload.js';
export * as projection from './projection.js';
export * as similarity from './similarity.js';

export {
  CanonicalizationError,
  CidMismatchError,
  DeadlineExpiredError,
  DecryptionError,
  DimensionMismatchError,
  KeyError,
  PayloadTooLargeError,
  ProtocolError,
  RemovedApiError,
  SchemaValidationError,
  SignatureError,
} from './errors.js';

export { PROTOCOL_VERSION, SPEC_HASH } from './constants.js';
