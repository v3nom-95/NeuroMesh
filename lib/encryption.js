/**
 * NeuroMesh — encryption compatibility facade.
 *
 * @deprecated This module is a thin, path-preserving shim over `src/protocol/envelope.js`. New code
 * MUST import from `src/protocol/index.js` directly. This file exists only so that an existing
 * `lib/encryption.js` import keeps resolving; it will be removed once no caller references it.
 *
 * ## What was here before, and why none of it survived
 *
 * The v1 module derived the AES key from the agent's wallet private key:
 *
 *     deriveKey(passphrase = process.env.PRIVATE_KEY, salt) = pbkdf2(passphrase, salt, 100000, 32, 'sha512')
 *
 * Four separate defects, every one of them fatal:
 *
 *   1. **Sharing a memory meant sharing the signing key.** The only way for agent B to decrypt agent
 *      A's memory was for A to hand over the PBKDF2 input — A's secp256k1 identity key. The
 *      documented feature "share a memory with another agent" was, as implemented, an instruction to
 *      destroy your own identity.
 *   2. **No domain separation.** One 256-bit secret served as both an ECDSA scalar and a KDF input.
 *   3. **Wrong primitive, real cost.** PBKDF2 stretches low-entropy passwords; the input here was
 *      already uniformly random, so 100 000 SHA-512 iterations bought nothing and cost ~53 ms per
 *      memory — which is essentially the whole of the "~69 ms AES-256-GCM encryption" figure the
 *      project published as a benchmark. The replacement measures 0.027 ms.
 *   4. **AEAD misuse.** A 16-byte GCM IV (the standard nonce is 12), no AAD at all, no algorithm or
 *      version discriminator, and hex output. With no AAD, an attacker could lift Alice's
 *      `encrypted_context` object verbatim into their own payload under their own DID and the tag
 *      would still verify.
 *
 * The replacement is envelope encryption: a random per-payload CEK, AES-256-GCM with a 12-byte IV
 * and mandatory AAD binding `(agentDid, contentId, policyId, modelId, keyVersion)`, and the CEK
 * ECIES-wrapped per recipient under a *separate* encryption keypair. See
 * `src/protocol/envelope.js` and `src/protocol/keys.js`.
 *
 * @module lib/encryption
 */

import { RemovedApiError } from '../src/protocol/errors.js';

export {
  buildAad,
  buildWrapAad,
  findEntry,
  generateCek,
  generateContentId,
  open,
  openContent,
  seal,
  sealContent,
  sortRecipients,
  timingSafeEqualBytes,
  unwrapCEK,
  unwrapCek,
  wrapCEKFor,
  wrapCek,
} from '../src/protocol/envelope.js';

export { deriveEncryptionKey, importEncryptionKey } from '../src/protocol/keys.js';

const REPLACEMENT =
  'Use envelope encryption instead: generateCek() + seal(plaintext, { cek, aad: buildAad({ agentDid, ' +
  'contentId, modelId, keyVersion, policyId }) }) + wrapCek({ cek, recipientPublicKey, ... }). ' +
  'See src/protocol/envelope.js.';

/**
 * Removed. Encrypting under a key derived from the wallet private key is unsafe by construction.
 *
 * @deprecated Always throws.
 * @returns {never} Never returns.
 * @throws {RemovedApiError} Always.
 */
export function encryptMemory() {
  throw new RemovedApiError(
    'REMOVED_UNSAFE_API',
    "encryptMemory() has been removed. It derived an AES key from the agent's wallet private key " +
      'via PBKDF2, so sharing a memory required sharing the signing key, and it produced ' +
      `ciphertext with a 16-byte GCM IV, no AAD and no version tag. ${REPLACEMENT}`,
  );
}

/**
 * Removed. This was the primitive behind the unauthenticated decryption oracle at `POST
 * /api/decrypt`, which returned the plaintext of any ciphertext a caller supplied.
 *
 * @deprecated Always throws.
 * @returns {never} Never returns.
 * @throws {RemovedApiError} Always.
 */
export function decryptMemory() {
  throw new RemovedApiError(
    'REMOVED_UNSAFE_API',
    "decryptMemory() has been removed. It decrypted caller-supplied ciphertext under the node's own " +
      'private key, which is what made POST /api/decrypt an unauthenticated decryption oracle. ' +
      'Decryption is now an authenticated, per-CID operation that unwraps only the CEK envelope ' +
      `addressed to the caller's registered encryption key. ${REPLACEMENT}`,
  );
}
