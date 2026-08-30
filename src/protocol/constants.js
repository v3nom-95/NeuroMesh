/**
 * NeuroMesh Protocol — constants.
 *
 * Single source of truth for every protocol-level literal that the backend, the scripts and any
 * third-party verifier share. Nothing here is configurable at runtime: a change in this file is a
 * protocol change, because these values are baked into hashes (`SPEC_HASH`), into key-derivation
 * domains (`HKDF_INFO_*`), into AAD strings and into the projection identifier.
 *
 * Two hard rules:
 *   1. Every value mirrored from Solidity is transcribed from the real source
 *      (`contracts/libraries/Limits.sol`), never guessed. The mirrored block names the Solidity
 *      member it copies so a reviewer can diff the two files by eye.
 *   2. Every exported object is frozen and the module holds no mutable state, so importing it in
 *      two different processes yields byte-identical values.
 *
 * @module src/protocol/constants
 */

import { keccak256, toUtf8Bytes } from 'ethers';

/* -------------------------------------------------------------------------- */
/* Protocol identity                                                          */
/* -------------------------------------------------------------------------- */

/** Canonical protocol version tag. Appears verbatim in payloads (`payload.v`) and in the AAD. */
export const PROTOCOL_VERSION = 'neuromesh/2.0.0';

/**
 * keccak256 of the UTF-8 version tag. Computed at load time rather than hardcoded so the two can
 * never drift; used as the HKDF salt for every derivation and as the first AAD component.
 *
 * @type {string} 0x-prefixed 32-byte hex
 */
export const SPEC_HASH = keccak256(toUtf8Bytes(PROTOCOL_VERSION));

/**
 * `SPEC_HASH` as raw bytes, for the crypto layer (which never wants hex).
 *
 * Typed arrays cannot be frozen, so this one is shared by convention: never write to it.
 */
export const SPEC_HASH_BYTES = Uint8Array.from(Buffer.from(SPEC_HASH.slice(2), 'hex'));

/* -------------------------------------------------------------------------- */
/* EIP-712 domains — transcribed from the deployed contracts                   */
/* -------------------------------------------------------------------------- */

/**
 * The protocol does NOT use one shared EIP-712 domain. Each contract mixes in OpenZeppelin's
 * `EIP712` under its own name, so there are three distinct domain separators. These strings are
 * copied from the constructor calls:
 *
 *   contracts/AgentIdentity.sol:88        EIP712("NeuroMeshAgentIdentity", "1")
 *   contracts/MemoryLedger.sol:127        EIP712("NeuroMeshMemoryLedger", "1")
 *   contracts/MemoryAccessControl.sol:108 EIP712("NeuroMeshAccessControl", "1")
 *
 * `contracts/ReputationManager.sol` has no EIP712 mixin at all — it has no signed entrypoint, and
 * probing `eip712Domain()` on it reverts. There is deliberately no entry for it here.
 */
export const DOMAIN_NAMES = Object.freeze({
  AgentIdentity: 'NeuroMeshAgentIdentity',
  MemoryLedger: 'NeuroMeshMemoryLedger',
  MemoryAccessControl: 'NeuroMeshAccessControl',
});

/** EIP-712 domain version shared by all three contracts. */
export const DOMAIN_VERSION = '1';

/* -------------------------------------------------------------------------- */
/* Algorithm identifiers and canonical string tags                             */
/* -------------------------------------------------------------------------- */

/** AEAD used for both content sealing and CEK wrapping. */
export const AEAD_ALG = 'aes-256-gcm';

/** Discriminator written into every sealed content block, so the scheme can be changed later. */
export const CONTENT_ALG = 'NM-SEAL-AES256GCM/v1';

/** Discriminator written into every per-recipient key-wrap entry. */
export const ECIES_ALG = 'ECIES-secp256k1-HKDF-SHA256-AES256GCM/v1';

/** HKDF `info` prefix for the per-recipient key-encryption key. */
export const HKDF_INFO_KEK = 'neuromesh/kek/v2';

/** HKDF `info` prefix for the agent's *encryption* keypair, distinct from any signing use. */
export const HKDF_INFO_ENCKEY = 'neuromesh/enckey/v2';

/** HKDF hash for every derivation in the protocol. */
export const HKDF_HASH = 'sha256';

/**
 * ASCII UNIT SEPARATOR (U+001F). The AAD is a concatenation of variable-length strings, so it needs
 * an unambiguous separator. U+001F is chosen because it cannot occur in a DID, a hex digest, a model
 * URI or a decimal integer, and every builder rejects components containing it rather than silently
 * producing an ambiguous encoding.
 */
export const UNIT_SEP = '\u001f';

/** Placeholder policy id used when a caller seals without an explicit policy block. */
export const POLICY_ID_NONE = '0x0000000000000000000000000000000000000000000000000000000000000000';

/* -------------------------------------------------------------------------- */
/* Cryptographic sizes                                                         */
/* -------------------------------------------------------------------------- */

/**
 * GCM's native nonce size. 12 bytes, never 16 — a non-96-bit IV is folded through GHASH to derive
 * J0, which is slower and silently non-interoperable with implementations that accept only the
 * standard nonce. The v1 code used 16 and is one of the defects this module exists to remove.
 */
export const AES_IV_BYTES = 12;

/** GCM authentication tag length in bytes (128-bit tag). */
export const AES_TAG_BYTES = 16;

/** Content-encryption key length (AES-256). */
export const CEK_BYTES = 32;

/** Length of a `contentId` in bytes; 128 bits is ample for an identifier. */
export const CONTENT_ID_BYTES = 16;

/** secp256k1 private-key length. */
export const SECP256K1_PRIVKEY_BYTES = 32;

/** secp256k1 compressed-public-key length (0x02/0x03 prefix plus the 32-byte x coordinate). */
export const SECP256K1_COMPRESSED_PUBKEY_BYTES = 33;

/** secp256k1 group order. A derived scalar is valid only in [1, N-1]. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/* -------------------------------------------------------------------------- */
/* Payload limits                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 1 MiB cap on the canonical payload bytes. This is what keeps a memory object a *single* raw IPFS
 * block, which in turn keeps CID computation a four-line function (no UnixFS chunking, no DAG) that
 * any verifier can reimplement in any language.
 */
export const MAX_PAYLOAD_BYTES = 1048576;

/**
 * CIDv1 prefix for `raw` content (codec 0x55) hashed with sha2-256 (0x12) at 32 bytes (0x20).
 * A full CID is `CID_PREFIX || sha256(bytes)`, multibase base32-lower with a leading `b`.
 */
export const CID_PREFIX = Uint8Array.from([0x01, 0x55, 0x12, 0x20]);

/* -------------------------------------------------------------------------- */
/* Limits mirrored from contracts/libraries/Limits.sol                         */
/* -------------------------------------------------------------------------- */

/** Fixed-point scale used for every on-chain ratio: 1.0 === 1e18. Mirrors `Limits.WAD`. */
export const WAD = 1000000000000000000n;

/**
 * Byte-for-byte mirror of `contracts/libraries/Limits.sol`. Durations are seconds and WAD
 * quantities are BigInt, matching the Solidity types. Any divergence is a bug in this file, not in
 * the contract — the contracts are frozen.
 */
export const LIMITS = Object.freeze({
  // ---- identity field bounds ----
  /** Limits.MIN_PUBLIC_KEY_BYTES — X25519 raw = 32 bytes. */
  MIN_PUBLIC_KEY_BYTES: 32,
  /** Limits.MAX_PUBLIC_KEY_BYTES — secp256k1 compressed = 33, uncompressed = 65. */
  MAX_PUBLIC_KEY_BYTES: 128,
  /** Limits.MAX_METADATA_URI_BYTES */
  MAX_METADATA_URI_BYTES: 256,

  // ---- memory field bounds ----
  /** Limits.MIN_CID_BYTES */
  MIN_CID_BYTES: 8,
  /** Limits.MAX_CID_BYTES — CIDv0 base58 = 46 chars, CIDv1 base32 = 59 chars. */
  MAX_CID_BYTES: 100,
  /** Limits.MAX_MODEL_BYTES — note: a full `hf:<repo>@sha256:<64hex>?...` URI does NOT fit. */
  MAX_MODEL_BYTES: 64,
  /** Limits.MAX_REASON_BYTES */
  MAX_REASON_BYTES: 128,
  /** Limits.MAX_WRAPPED_KEY_BYTES — ECIES envelope over a 32-byte AES key. */
  MAX_WRAPPED_KEY_BYTES: 512,
  /** Limits.MIN_EMBEDDING_DIM */
  MIN_EMBEDDING_DIM: 1,
  /** Limits.MAX_EMBEDDING_DIM */
  MAX_EMBEDDING_DIM: 8192,

  // ---- call-shape bounds ----
  /** Limits.MAX_PAGE_SIZE */
  MAX_PAGE_SIZE: 100,
  /** Limits.MAX_BATCH_SIZE */
  MAX_BATCH_SIZE: 50,
  /** Limits.MAX_SIGNATURE_VALIDITY — 30 days, in seconds. */
  MAX_SIGNATURE_VALIDITY: 2592000,
  /** Limits.MAX_CHAIN_WALK */
  MAX_CHAIN_WALK: 512,

  // ---- governed parameter bounds ----
  /** Limits.MIN_HALF_LIFE — 1 hour. */
  MIN_HALF_LIFE: 3600,
  /** Limits.MAX_HALF_LIFE — 3650 days. */
  MAX_HALF_LIFE: 315360000,
  /** Limits.MIN_PRIOR_WAD — 0.1. */
  MIN_PRIOR_WAD: 100000000000000000n,
  /** Limits.MAX_PRIOR_WAD — 100.0. */
  MAX_PRIOR_WAD: 100000000000000000000n,
  /** Limits.MIN_NEG_MULTIPLIER_WAD — 1.0. */
  MIN_NEG_MULTIPLIER_WAD: 1000000000000000000n,
  /** Limits.MAX_NEG_MULTIPLIER_WAD — 10.0. */
  MAX_NEG_MULTIPLIER_WAD: 10000000000000000000n,
  /** Limits.MAX_ENDORSER_WEIGHT_WAD — 2.0. */
  MAX_ENDORSER_WEIGHT_WAD: 2000000000000000000n,
  /** Limits.MAX_COOLDOWN — 365 days. */
  MAX_COOLDOWN: 31536000,
  /** Limits.MAX_STAKE_LOCK — 365 days. */
  MAX_STAKE_LOCK: 31536000,
  /** Limits.MAX_TRUST_LOG_CAPACITY */
  MAX_TRUST_LOG_CAPACITY: 65536,
});

/* -------------------------------------------------------------------------- */
/* Retrieval ranking parameters                                                */
/* -------------------------------------------------------------------------- */

/**
 * Trust floor. An agent with zero calibrated reputation still contributes `RANK_THETA` of its
 * cosine, so a brand-new agent ranks low rather than becoming unreachable — reputation is a
 * re-ranking signal here, never an access-control mechanism.
 */
export const RANK_THETA = 0.2;

/** Concavity of the trust term: `tau ** RANK_PHI`, phi < 1, so early reputation is worth more. */
export const RANK_PHI = 0.5;

/** Half-life, in days, of the recency term in the retrieval score. */
export const RECENCY_HALFLIFE_DAYS = 180;

/** Minimum calibrated trust for a candidate to survive the retrieval hard filter. */
export const TAU_MIN = 0;

/* -------------------------------------------------------------------------- */
/* Cross-model projection                                                      */
/* -------------------------------------------------------------------------- */

/** Family name of the deterministic projection. Part of every `projectionId`. */
export const PROJECTION_ALG = 'achlioptas-s3';

/** Version of the projection construction. Bumping it changes every `projectionId`. */
export const PROJECTION_VERSION = 'v1';

/** Name of the deterministic keystream the projection matrix is drawn from. */
export const PROJECTION_PRNG = 'aes-256-ctr';

/** Domain-separation label mixed into the projection seed. */
export const PROJECTION_SEED_LABEL = 'neuromesh/projection/v1';

/** Shared semantic dimensionality every model is aligned into by default. */
export const SHARED_EMBEDDING_DIM = 384;

/** Number of SimHash bits published for candidate retrieval over encrypted embeddings. */
export const SIMHASH_BITS = 256;
