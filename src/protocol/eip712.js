/**
 * NeuroMesh Protocol — EIP-712 typed data.
 *
 * Every struct, field order and domain in this file is **transcribed from the deployed Solidity**,
 * not designed here. The authoritative sources are:
 *
 *   contracts/AgentIdentity.sol:63-68        REGISTRATION_TYPEHASH, KEY_ROTATION_TYPEHASH
 *   contracts/AgentIdentity.sol:88           EIP712("NeuroMeshAgentIdentity", "1")
 *   contracts/MemoryLedger.sol:80-87         MEMORY_COMMIT_TYPEHASH, MEMORY_REVOCATION_TYPEHASH
 *   contracts/MemoryLedger.sol:127           EIP712("NeuroMeshMemoryLedger", "1")
 *   contracts/MemoryLedger.sol:371-393       hashCommit() — the digest this module must reproduce
 *   contracts/MemoryAccessControl.sol:67-70  ACCESS_GRANT_TYPEHASH
 *   contracts/MemoryAccessControl.sol:108    EIP712("NeuroMeshAccessControl", "1")
 *
 * **Field order is part of the typehash.** The EIP-712 type string is built by concatenating fields
 * in declaration order, and the typehash is its keccak256. Reordering a single line here silently
 * changes every digest and every signature stops verifying on chain. Treat the `TYPES` arrays as
 * frozen bytes, not as a config object.
 *
 * There is deliberately no `Endorsement` type: `contracts/ReputationManager.sol` has no EIP712 mixin
 * and no signed entrypoint, so a JS-side Endorsement struct would describe a signature nothing
 * verifies.
 *
 * @module src/protocol/eip712
 */

import { AbiCoder, TypedDataEncoder, getAddress, id, keccak256, verifyTypedData } from 'ethers';

import { DOMAIN_NAMES, DOMAIN_VERSION, SECP256K1_N } from './constants.js';
import { DeadlineExpiredError, SignatureError } from './errors.js';

const abi = AbiCoder.defaultAbiCoder();

/* -------------------------------------------------------------------------- */
/* Domains                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build an EIP-712 domain.
 *
 * The `chainId` / `verifyingContract` binding is what stops a signature produced for the Sepolia
 * ledger from being replayed against a mainnet deployment, or against a different contract on the
 * same chain. Both are mandatory: OpenZeppelin's `EIP712` always includes them.
 *
 * @param {string} name Domain name — use a member of {@link DOMAIN_NAMES}.
 * @param {number|bigint} chainId EVM chain id of the deployment.
 * @param {string} verifyingContract Address of the contract that will `ecrecover` the signature.
 * @param {string} [version] Domain version; every NeuroMesh contract uses "1".
 * @returns {{ name: string, version: string, chainId: number|bigint, verifyingContract: string }}
 */
export function domain(name, chainId, verifyingContract, version = DOMAIN_VERSION) {
  return { name, version, chainId, verifyingContract: getAddress(verifyingContract) };
}

/**
 * Domain for `AgentIdentity`.
 *
 * @param {number|bigint} chainId Chain id.
 * @param {string} address Deployed `AgentIdentity` address.
 * @returns {ReturnType<typeof domain>}
 */
export const identityDomain = (chainId, address) =>
  domain(DOMAIN_NAMES.AgentIdentity, chainId, address);

/**
 * Domain for `MemoryLedger`.
 *
 * @param {number|bigint} chainId Chain id.
 * @param {string} address Deployed `MemoryLedger` address.
 * @returns {ReturnType<typeof domain>}
 */
export const ledgerDomain = (chainId, address) =>
  domain(DOMAIN_NAMES.MemoryLedger, chainId, address);

/**
 * Domain for `MemoryAccessControl`.
 *
 * @param {number|bigint} chainId Chain id.
 * @param {string} address Deployed `MemoryAccessControl` address.
 * @returns {ReturnType<typeof domain>}
 */
export const accessDomain = (chainId, address) =>
  domain(DOMAIN_NAMES.MemoryAccessControl, chainId, address);

/* -------------------------------------------------------------------------- */
/* Types — transcribed verbatim, order is load-bearing                         */
/* -------------------------------------------------------------------------- */

/**
 * The five signed structs the protocol actually has on chain.
 *
 * @type {Readonly<Record<string, ReadonlyArray<{ name: string, type: string }>>>}
 */
export const TYPES = Object.freeze({
  /** AgentIdentity.registerFor / AgentIdentity.sol:63-65 */
  Registration: Object.freeze([
    { name: 'agent', type: 'address' },
    { name: 'publicKeyHash', type: 'bytes32' },
    { name: 'metadataURIHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ]),
  /** AgentIdentity.rotateKeyFor / AgentIdentity.sol:67-68 */
  KeyRotation: Object.freeze([
    { name: 'agent', type: 'address' },
    { name: 'publicKeyHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ]),
  /** MemoryLedger.commitMemoryFor / MemoryLedger.sol:80-83 */
  MemoryCommit: Object.freeze([
    { name: 'agent', type: 'address' },
    { name: 'cidHash', type: 'bytes32' },
    { name: 'prevCidHash', type: 'bytes32' },
    { name: 'modelHash', type: 'bytes32' },
    { name: 'embeddingDim', type: 'uint32' },
    { name: 'isEncrypted', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ]),
  /** MemoryLedger.revokeMemoryFor / MemoryLedger.sol:86-87 */
  MemoryRevocation: Object.freeze([
    { name: 'agent', type: 'address' },
    { name: 'cidHash', type: 'bytes32' },
    { name: 'reason', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ]),
  /** MemoryAccessControl.grantAccessFor / MemoryAccessControl.sol:67-70 */
  AccessGrant: Object.freeze([
    { name: 'owner', type: 'address' },
    { name: 'cidHash', type: 'bytes32' },
    { name: 'grantee', type: 'address' },
    { name: 'wrappedKeyHash', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ]),
});

/**
 * The exact byte strings the Solidity `keccak256("…")` literals hash. Kept alongside `TYPES` so a
 * test can prove the two encodings agree, which is what catches a reordered field.
 *
 * @type {Readonly<Record<keyof typeof TYPES, string>>}
 */
export const TYPE_STRINGS = Object.freeze({
  Registration:
    'Registration(address agent,bytes32 publicKeyHash,bytes32 metadataURIHash,uint256 nonce,uint256 deadline)',
  KeyRotation: 'KeyRotation(address agent,bytes32 publicKeyHash,uint256 nonce,uint256 deadline)',
  MemoryCommit:
    'MemoryCommit(address agent,bytes32 cidHash,bytes32 prevCidHash,bytes32 modelHash,uint32 embeddingDim,bool isEncrypted,uint256 nonce,uint256 deadline)',
  MemoryRevocation:
    'MemoryRevocation(address agent,bytes32 cidHash,bytes32 reason,uint256 nonce,uint256 deadline)',
  AccessGrant:
    'AccessGrant(address owner,bytes32 cidHash,address grantee,bytes32 wrappedKeyHash,uint64 expiresAt,uint256 nonce,uint256 deadline)',
});

/**
 * Precomputed typehashes. The backend asserts these against the contracts' public
 * `*_TYPEHASH()` getters at boot, so a redeployment with a changed struct fails fast instead of
 * producing signatures nothing accepts.
 *
 * @type {Readonly<Record<keyof typeof TYPES, string>>}
 */
export const TYPEHASHES = Object.freeze(
  /** @type {Record<string, string>} */ (
    Object.fromEntries(Object.entries(TYPE_STRINGS).map(([name, str]) => [name, id(str)]))
  ),
);

/* -------------------------------------------------------------------------- */
/* Value builders                                                              */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} TypedData
 * @property {ReturnType<typeof domain>} domain EIP-712 domain.
 * @property {Record<string, ReadonlyArray<{ name: string, type: string }>>} types Single-entry map
 *   containing only the struct being signed, which is the shape `ethers` v6 `signTypedData` wants.
 * @property {Record<string, unknown>} value The message.
 * @property {string} primaryType Name of the struct.
 */

/**
 * @param {keyof typeof TYPES} primaryType Struct name.
 * @param {ReturnType<typeof domain>} dom Domain.
 * @param {Record<string, unknown>} value Message.
 * @returns {TypedData}
 */
function bundle(primaryType, dom, value) {
  return {
    domain: dom,
    types: { [primaryType]: TYPES[primaryType] },
    value,
    primaryType,
  };
}

/**
 * Build the `MemoryCommit` typed data for `MemoryLedger.commitMemoryFor`.
 *
 * `cidHash` and `modelHash` are keccak256 of the **UTF-8 string** exactly as the contract computes
 * them (`keccak256(bytes(input.cid))`, `keccak256(bytes(input.model))`), which is what `ethers.id`
 * does. Passing a pre-hashed value here would produce a digest the contract disagrees with.
 *
 * @param {object} args Commit arguments.
 * @param {string} args.agent Address whose signature authorises the commit; becomes the record owner.
 * @param {number|bigint} args.chainId Chain id.
 * @param {string} args.ledger Deployed `MemoryLedger` address.
 * @param {string} args.cid CID string, exactly as it will be stored on chain.
 * @param {string} args.prevCidHash bytes32 of the parent record, or 32 zero bytes for a root.
 * @param {string} args.model Model identifier string, exactly as it will be stored on chain.
 * @param {number} args.embeddingDim Declared embedding dimension (uint32).
 * @param {boolean} args.isEncrypted Whether the payload's context is sealed.
 * @param {number|bigint} args.nonce The agent's current ledger nonce.
 * @param {number|bigint} args.deadline Unix seconds after which the authorisation is void.
 * @returns {TypedData}
 */
export function buildMemoryCommit({
  agent,
  chainId,
  ledger,
  cid,
  prevCidHash,
  model,
  embeddingDim,
  isEncrypted,
  nonce,
  deadline,
}) {
  return bundle('MemoryCommit', ledgerDomain(chainId, ledger), {
    agent: getAddress(agent),
    cidHash: id(cid),
    prevCidHash,
    modelHash: id(model),
    embeddingDim,
    isEncrypted,
    nonce,
    deadline,
  });
}

/**
 * Build the `MemoryRevocation` typed data.
 *
 * @param {object} args Revocation arguments.
 * @param {string} args.agent Record owner.
 * @param {number|bigint} args.chainId Chain id.
 * @param {string} args.ledger Deployed `MemoryLedger` address.
 * @param {string} args.cidHash bytes32 key of the record being revoked.
 * @param {string} args.reason bytes32 short-string reason code.
 * @param {number|bigint} args.nonce Current ledger nonce.
 * @param {number|bigint} args.deadline Unix seconds.
 * @returns {TypedData}
 */
export function buildMemoryRevocation({
  agent,
  chainId,
  ledger,
  cidHash,
  reason,
  nonce,
  deadline,
}) {
  return bundle('MemoryRevocation', ledgerDomain(chainId, ledger), {
    agent: getAddress(agent),
    cidHash,
    reason,
    nonce,
    deadline,
  });
}

/**
 * Build the `Registration` typed data for `AgentIdentity`.
 *
 * @param {object} args Registration arguments.
 * @param {string} args.agent Address being registered.
 * @param {number|bigint} args.chainId Chain id.
 * @param {string} args.identity Deployed `AgentIdentity` address.
 * @param {string} args.publicKey 0x-hex **bytes** of the encryption public key (hashed with
 *   `keccak256(bytes)`, matching the contract, NOT `ethers.id`).
 * @param {string} args.metadataURI Metadata URI **string** (hashed as UTF-8, matching the contract).
 * @param {number|bigint} args.nonce Current identity nonce.
 * @param {number|bigint} args.deadline Unix seconds.
 * @returns {TypedData}
 */
export function buildRegistration({
  agent,
  chainId,
  identity,
  publicKey,
  metadataURI,
  nonce,
  deadline,
}) {
  return bundle('Registration', identityDomain(chainId, identity), {
    agent: getAddress(agent),
    publicKeyHash: keccak256(publicKey),
    metadataURIHash: id(metadataURI),
    nonce,
    deadline,
  });
}

/**
 * Build the `KeyRotation` typed data for `AgentIdentity`.
 *
 * @param {object} args Rotation arguments.
 * @param {string} args.agent Address rotating its key.
 * @param {number|bigint} args.chainId Chain id.
 * @param {string} args.identity Deployed `AgentIdentity` address.
 * @param {string} args.publicKey 0x-hex bytes of the new encryption public key.
 * @param {number|bigint} args.nonce Current identity nonce.
 * @param {number|bigint} args.deadline Unix seconds.
 * @returns {TypedData}
 */
export function buildKeyRotation({ agent, chainId, identity, publicKey, nonce, deadline }) {
  return bundle('KeyRotation', identityDomain(chainId, identity), {
    agent: getAddress(agent),
    publicKeyHash: keccak256(publicKey),
    nonce,
    deadline,
  });
}

/**
 * Build the `AccessGrant` typed data for `MemoryAccessControl`.
 *
 * @param {object} args Grant arguments.
 * @param {string} args.owner Record owner granting access.
 * @param {number|bigint} args.chainId Chain id.
 * @param {string} args.access Deployed `MemoryAccessControl` address.
 * @param {string} args.cidHash bytes32 key of the record.
 * @param {string} args.grantee Address receiving access.
 * @param {string} args.wrappedKey 0x-hex bytes of the ECIES-wrapped CEK for the grantee.
 * @param {number|bigint} args.expiresAt uint64 unix seconds; 0 means "never expires".
 * @param {number|bigint} args.nonce Current access-control nonce.
 * @param {number|bigint} args.deadline Unix seconds.
 * @returns {TypedData}
 */
export function buildAccessGrant({
  owner,
  chainId,
  access,
  cidHash,
  grantee,
  wrappedKey,
  expiresAt,
  nonce,
  deadline,
}) {
  return bundle('AccessGrant', accessDomain(chainId, access), {
    owner: getAddress(owner),
    cidHash,
    grantee: getAddress(grantee),
    wrappedKeyHash: keccak256(wrappedKey),
    expiresAt,
    nonce,
    deadline,
  });
}

/* -------------------------------------------------------------------------- */
/* Digests                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * EIP-712 digest of a typed-data bundle, via `ethers.TypedDataEncoder`.
 *
 * @param {TypedData} typed Bundle from one of the `build*` functions.
 * @returns {string} 0x-prefixed 32-byte digest — the value `ecrecover` is called with on chain.
 */
export function digest(typed) {
  return TypedDataEncoder.hash(
    typed.domain,
    /** @type {Record<string, Array<{name: string, type: string}>>} */ (
      /** @type {unknown} */ (typed.types)
    ),
    typed.value,
  );
}

/**
 * The EIP-712 domain separator, computed from first principles.
 *
 * This mirrors OpenZeppelin's `_domainSeparatorV4()`:
 * `keccak256(abi.encode(TYPE_HASH, keccak256(name), keccak256(version), chainId, address))`.
 *
 * @param {ReturnType<typeof domain>} dom Domain.
 * @returns {string} 0x-prefixed 32-byte separator.
 */
export function domainSeparator(dom) {
  const typeHash = id(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
  );
  return keccak256(
    abi.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [typeHash, id(dom.name), id(dom.version), dom.chainId, dom.verifyingContract],
    ),
  );
}

/**
 * The struct hash, computed from first principles as `keccak256(abi.encode(TYPEHASH, …fields))`.
 *
 * This exists to be an *independent* implementation of what `TypedDataEncoder` does: it walks the
 * `TYPES` array in declaration order and ABI-encodes each field, exactly the way the Solidity in
 * `MemoryLedger.hashCommit` does. A test asserts the two agree, which is the tripwire that catches a
 * transcription error in `TYPES` or `TYPE_STRINGS`.
 *
 * Only the primitive field types the protocol actually uses are supported — there are no nested
 * structs, arrays, `string` or `bytes` fields in any NeuroMesh struct (every variable-length value
 * is pre-hashed into a bytes32 by the caller), so no recursive encoding is needed.
 *
 * @param {TypedData} typed Bundle from one of the `build*` functions.
 * @returns {string} 0x-prefixed 32-byte struct hash.
 */
export function structHash(typed) {
  const fields = TYPES[/** @type {keyof typeof TYPES} */ (typed.primaryType)];
  const types = ['bytes32', ...fields.map((f) => f.type)];
  const values = [
    TYPEHASHES[/** @type {keyof typeof TYPES} */ (typed.primaryType)],
    ...fields.map((f) => typed.value[f.name]),
  ];
  return keccak256(abi.encode(types, values));
}

/**
 * The EIP-712 digest recomputed from first principles: `keccak256(0x1901 ‖ separator ‖ structHash)`.
 *
 * @param {TypedData} typed Bundle from one of the `build*` functions.
 * @returns {string} 0x-prefixed 32-byte digest. Must equal {@link digest}.
 */
export function digestFromParts(typed) {
  return keccak256(`0x1901${domainSeparator(typed.domain).slice(2)}${structHash(typed).slice(2)}`);
}

/* -------------------------------------------------------------------------- */
/* Signing and verification                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sign a typed-data bundle with any ethers v6 signer.
 *
 * @param {{ signTypedData: (d: object, t: object, v: object) => Promise<string> }} signer Signer.
 * @param {TypedData} typed Bundle from one of the `build*` functions.
 * @returns {Promise<string>} 65-byte 0x-hex signature.
 */
export async function signTypedData(signer, typed) {
  return signer.signTypedData(typed.domain, typed.types, typed.value);
}

/**
 * Recover the signer address from a typed-data signature.
 *
 * High-`s` (malleable) signatures are rejected before recovery. OpenZeppelin's `ECDSA.recover`
 * rejects them on chain, so accepting one here would let this module report a signer for a signature
 * the contract will refuse.
 *
 * @param {TypedData} typed Bundle from one of the `build*` functions.
 * @param {string} signature 65-byte 0x-hex signature.
 * @returns {string} Checksummed recovered address.
 * @throws {SignatureError} On a malformed or malleable signature.
 */
export function recoverTypedData(typed, signature) {
  assertCanonicalSignature(signature);
  try {
    return verifyTypedData(
      typed.domain,
      /** @type {Record<string, Array<{name: string, type: string}>>} */ (
        /** @type {unknown} */ (typed.types)
      ),
      typed.value,
      signature,
    );
  } catch (cause) {
    throw new SignatureError('Signature could not be recovered.', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

/**
 * Assert that a typed-data signature was produced by `expectedSigner`.
 *
 * @param {TypedData} typed Bundle from one of the `build*` functions.
 * @param {string} signature 65-byte 0x-hex signature.
 * @param {string} expectedSigner Address that must have signed.
 * @returns {void}
 * @throws {SignatureError} On mismatch.
 */
export function verifyTypedDataSignature(typed, signature, expectedSigner) {
  const recovered = recoverTypedData(typed, signature);
  if (recovered !== getAddress(expectedSigner)) {
    throw new SignatureError(
      `Signature recovers to ${recovered}, not ${getAddress(expectedSigner)}.`,
      { recovered, expected: getAddress(expectedSigner) },
    );
  }
}

/**
 * Reject non-canonical (high-`s`) ECDSA signatures.
 *
 * secp256k1 signatures come in pairs `(r, s)` and `(r, N - s)` that both verify. OpenZeppelin's
 * `ECDSA` library accepts only the low half, so a high-`s` signature would be recoverable here and
 * rejected on chain — a difference worth failing loudly on.
 *
 * @param {string} signature 65-byte 0x-hex signature.
 * @returns {void}
 * @throws {SignatureError} When malformed or malleable.
 */
export function assertCanonicalSignature(signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new SignatureError('Signature must be 65 bytes of 0x-prefixed hex.');
  }
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  if (s > SECP256K1_N / 2n) {
    throw new SignatureError(
      'Signature has a high `s` value. OpenZeppelin ECDSA rejects malleable signatures on chain, ' +
        'so this one would never verify against the contract.',
      { half: 'high-s' },
    );
  }
}

/**
 * Assert that a signed authorisation has not expired.
 *
 * @param {{ deadline: number|bigint }} message Any message carrying a `deadline`.
 * @param {number} [now] Unix seconds; defaults to the current wall clock.
 * @returns {void}
 * @throws {DeadlineExpiredError} When `now > deadline`.
 */
export function assertFresh(message, now = Math.floor(Date.now() / 1000)) {
  if (BigInt(now) > BigInt(message.deadline)) {
    throw new DeadlineExpiredError(message.deadline, now);
  }
}
