/**
 * Shared protocol literals for the NeuroMesh contract test-suite.
 *
 * Nothing in the specs re-derives a bound by hand: every limit, role id and default parameter is
 * declared here once, mirroring `contracts/libraries/{Limits,Roles}.sol` and the ReputationManager
 * constructor. If a bound changes in Solidity and not here (or vice versa) the suite fails loudly,
 * which is exactly the tripwire we want.
 */
import hre from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';

const { ethers } = hre;

/* -------------------------------------------------------------------------- */
/* Fixed point                                                                 */
/* -------------------------------------------------------------------------- */

/** 1.0 in the protocol's WAD fixed-point representation. */
export const WAD = 10n ** 18n;

/* -------------------------------------------------------------------------- */
/* Roles (must match contracts/libraries/Roles.sol)                            */
/* -------------------------------------------------------------------------- */

export const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
export const PAUSER_ROLE = ethers.id('NEUROMESH_PAUSER_ROLE');
export const PARAM_ADMIN_ROLE = ethers.id('NEUROMESH_PARAM_ADMIN_ROLE');
export const REGISTRAR_ROLE = ethers.id('NEUROMESH_REGISTRAR_ROLE');
export const MODERATOR_ROLE = ethers.id('NEUROMESH_MODERATOR_ROLE');
export const SLASHER_ROLE = ethers.id('NEUROMESH_SLASHER_ROLE');
export const TREASURER_ROLE = ethers.id('NEUROMESH_TREASURER_ROLE');

/* -------------------------------------------------------------------------- */
/* Limits (must match contracts/libraries/Limits.sol)                          */
/* -------------------------------------------------------------------------- */

export const MIN_PUBLIC_KEY_BYTES = 32;
export const MAX_PUBLIC_KEY_BYTES = 128;
export const MAX_METADATA_URI_BYTES = 256;

export const MIN_CID_BYTES = 8;
export const MAX_CID_BYTES = 100;
export const MAX_MODEL_BYTES = 64;
export const MAX_REASON_BYTES = 128;
export const MAX_WRAPPED_KEY_BYTES = 512;

export const MIN_EMBEDDING_DIM = 1;
export const MAX_EMBEDDING_DIM = 8192;

export const MAX_PAGE_SIZE = 100;
export const MAX_BATCH_SIZE = 50;
export const MAX_CHAIN_WALK = 512;
export const MAX_SIGNATURE_VALIDITY = 30 * 24 * 3600;

export const MIN_HALF_LIFE = 3600;
export const MAX_HALF_LIFE = 3650 * 24 * 3600;
export const MIN_PRIOR_WAD = 10n ** 17n;
export const MAX_PRIOR_WAD = 100n * WAD;
export const MIN_NEG_MULTIPLIER_WAD = WAD;
export const MAX_NEG_MULTIPLIER_WAD = 10n * WAD;
export const MAX_ENDORSER_WEIGHT_WAD = 2n * WAD;
export const MAX_COOLDOWN = 365 * 24 * 3600;
export const MAX_STAKE_LOCK = 365 * 24 * 3600;
export const MAX_TRUST_LOG_CAPACITY = 65536;

/* -------------------------------------------------------------------------- */
/* ReputationManager constructor defaults                                      */
/* -------------------------------------------------------------------------- */

export const HALF_LIFE = 90 * 24 * 3600;
export const PRIOR = 3n * WAD;
export const THRESHOLD = (6n * WAD) / 10n;
export const NEG_MULT = 3n * WAD;
export const BASE_W = WAD / 4n;
export const MAX_W = WAD;
export const ENDORSE_COOLDOWN = 24 * 3600;
export const REPORT_COOLDOWN = 24 * 3600;
export const ACTOR_COOLDOWN = 3600;
export const STAKE_WEI = 0n;
export const STAKE_LOCK = 7 * 24 * 3600;

/** Ring capacity the fixtures deploy with - deliberately tiny so wrap-around is cheap to test. */
export const TRUST_LOG_CAPACITY = 16;

/* -------------------------------------------------------------------------- */
/* EIP-712 domains                                                             */
/* -------------------------------------------------------------------------- */

export const IDENTITY_DOMAIN_NAME = 'NeuroMeshAgentIdentity';
export const LEDGER_DOMAIN_NAME = 'NeuroMeshMemoryLedger';
export const ACCESS_DOMAIN_NAME = 'NeuroMeshAccessControl';
export const DOMAIN_VERSION = '1';

/* -------------------------------------------------------------------------- */
/* Canonical EIP-712 type strings (the exact bytes the typehashes are keccak of) */
/* -------------------------------------------------------------------------- */

export const REGISTRATION_TYPE_STRING =
  'Registration(address agent,bytes32 publicKeyHash,bytes32 metadataURIHash,uint256 nonce,uint256 deadline)';
export const KEY_ROTATION_TYPE_STRING =
  'KeyRotation(address agent,bytes32 publicKeyHash,uint256 nonce,uint256 deadline)';
export const MEMORY_COMMIT_TYPE_STRING =
  'MemoryCommit(address agent,bytes32 cidHash,bytes32 prevCidHash,bytes32 modelHash,uint32 embeddingDim,bool isEncrypted,uint256 nonce,uint256 deadline)';
export const MEMORY_REVOCATION_TYPE_STRING =
  'MemoryRevocation(address agent,bytes32 cidHash,bytes32 reason,uint256 nonce,uint256 deadline)';
export const ACCESS_GRANT_TYPE_STRING =
  'AccessGrant(address owner,bytes32 cidHash,address grantee,bytes32 wrappedKeyHash,uint64 expiresAt,uint256 nonce,uint256 deadline)';

/* -------------------------------------------------------------------------- */
/* Test-data builders                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A well-formed 33-byte "compressed secp256k1" encryption key. Deterministic in `seed` so a test can
 * assert a rotation actually replaced the stored bytes.
 * @param {number|string} seed
 * @returns {string} 0x-prefixed 33-byte hex string
 */
export function validPubKey(seed = 0) {
  return '0x02' + ethers.id(`neuromesh-pubkey-${seed}`).slice(2);
}

/**
 * Hex bytes of an exact length, deterministic in `seed`. Used for the length-bound negative tests.
 * @param {number} len number of bytes
 * @param {number|string} seed
 */
export function bytesOfLength(len, seed = 0) {
  let out = '';
  let i = 0;
  while (out.length < len * 2) {
    out += ethers.id(`neuromesh-bytes-${seed}-${i++}`).slice(2);
  }
  return '0x' + out.slice(0, len * 2);
}

/**
 * A realistic 46-character CIDv0-shaped identifier. Deterministic and collision-free in `n`.
 * @param {number|string} n
 */
export function cid(n) {
  const tail = String(n).padStart(44, 'a');
  return 'Qm' + tail.slice(-44);
}

/** An ASCII string of exactly `len` characters. */
export function strOfLength(len, filler = 'x') {
  return filler.repeat(len);
}

/** Short-string bytes32 identifier, matching Solidity's `bytes32("cid")` literal encoding. */
export function field(name) {
  return ethers.encodeBytes32String(name);
}

/** A signature deadline `offsetSeconds` after the latest block timestamp. */
export async function deadline(offsetSeconds = 3600) {
  return (await time.latest()) + offsetSeconds;
}
