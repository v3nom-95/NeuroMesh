/**
 * NeuroMesh Protocol — key hierarchy.
 *
 * ## Why this module exists
 *
 * The v1 design used the wallet's secp256k1 signing key directly as the PBKDF2 input for the AES
 * key. That has three consequences, all fatal:
 *
 *   1. **Sharing a memory required sharing the signing key.** The only way for agent B to decrypt
 *      agent A's memory was for A to hand over the KDF input — which is A's identity.
 *   2. **No domain separation.** One 256-bit secret was simultaneously an ECDSA scalar and a KDF
 *      input, so a weakness or leak in either path compromised both.
 *   3. **Wrong primitive.** PBKDF2 stretches *low-entropy* passwords. The input was already a
 *      uniformly random 256-bit scalar, so 100 000 SHA-512 iterations bought nothing and cost ~53 ms
 *      per memory.
 *
 * ## The replacement
 *
 * A **separate encryption keypair**, derived from the wallet key by HKDF-SHA256 under an info string
 * that is used for nothing else:
 *
 *     ikm  = wallet private key (32 bytes)
 *     salt = SPEC_HASH                                  (keccak256 of the protocol version tag)
 *     info = "neuromesh/enckey/v2" ‖ uint32be(keyVersion) ‖ uint32be(counter)
 *     d_enc = int(HKDF-SHA256(ikm, salt, info, 32)) , rejection-sampled into [1, n-1]
 *
 * The direction of the derivation matters and is the point of the design: HKDF-Expand is built on
 * HMAC-SHA256, so recovering `ikm` from `d_enc` is a preimage problem. **A leaked encryption key
 * therefore yields nothing about the signing key**, while a leaked signing key does yield the
 * encryption key — which is the correct asymmetry, because the signing key is the identity and its
 * compromise is already total.
 *
 * `keyVersion` is a first-class input, so rotating the encryption key is a one-integer change that
 * produces an entirely unrelated keypair without touching the wallet, the address or the DID. The
 * new public key is published on chain through `AgentIdentity.rotateKeyFor`.
 *
 * ## Handling rules
 *
 * The values this module returns are key material. They must never be logged, never returned by an
 * HTTP route, and never persisted. Use {@link withKey} where you can so that zeroisation is
 * structural rather than remembered.
 *
 * @module src/protocol/keys
 */

import { hkdfSync } from 'node:crypto';

import { SigningKey, computeAddress, getAddress } from 'ethers';

import {
  HKDF_HASH,
  HKDF_INFO_ENCKEY,
  SECP256K1_COMPRESSED_PUBKEY_BYTES,
  SECP256K1_N,
  SECP256K1_PRIVKEY_BYTES,
  SPEC_HASH_BYTES,
} from './constants.js';
import { KeyError } from './errors.js';

/* -------------------------------------------------------------------------- */
/* did:pkh                                                                     */
/* -------------------------------------------------------------------------- */

const DID_PKH = /^did:pkh:eip155:(\d+):(0x[0-9a-fA-F]{40})$/;

/**
 * Format an agent DID as `did:pkh:eip155:<chainId>:<checksummedAddress>`.
 *
 * The address is always EIP-55 checksummed, so the DID is a canonical string and can be compared
 * with `===` and hashed into the AAD without a normalisation step.
 *
 * @param {number|bigint} chainId EVM chain id.
 * @param {string} address Agent address.
 * @returns {string} did:pkh identifier.
 */
export function toDid(chainId, address) {
  return `did:pkh:eip155:${chainId}:${getAddress(address)}`;
}

/**
 * Parse a `did:pkh:eip155:…` identifier.
 *
 * @param {string} did Identifier to parse.
 * @returns {{ chainId: number, address: string }} Chain id and checksummed address.
 * @throws {KeyError} On a malformed DID or a non-checksummed address.
 */
export function fromDid(did) {
  const match = DID_PKH.exec(did ?? '');
  if (!match) {
    throw new KeyError('INVALID_DID', `Not a did:pkh:eip155 identifier: ${String(did)}`, { did });
  }
  const address = getAddress(match[2]);
  if (address !== match[2]) {
    throw new KeyError('INVALID_DID', 'DID address is not EIP-55 checksummed.', { did });
  }
  return { chainId: Number(match[1]), address };
}

/* -------------------------------------------------------------------------- */
/* Byte helpers                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Big-endian uint32 as 4 bytes. Used in HKDF info strings, where a fixed-width, endian-explicit
 * encoding is required for cross-language reproducibility.
 *
 * @param {number} n Value in [0, 2^32).
 * @returns {Uint8Array} 4 bytes.
 */
export function uint32be(n) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new KeyError('INVALID_KEY_VERSION', `uint32 out of range: ${String(n)}`, { value: n });
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

/**
 * Concatenate byte arrays.
 *
 * @param {...Uint8Array} parts Arrays to join.
 * @returns {Uint8Array} Concatenation.
 */
export function concatBytes(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Overwrite a buffer with zeros.
 *
 * This is best-effort in a garbage-collected runtime — V8 may have copied the bytes — but it removes
 * the long-lived copy, which is the one that ends up in a heap snapshot or a core dump.
 *
 * @param {Uint8Array|null|undefined} bytes Buffer to clear.
 * @returns {void}
 */
export function zeroize(bytes) {
  if (bytes && typeof bytes.fill === 'function') bytes.fill(0);
}

/**
 * Run `fn` with `key`, zeroising `key` afterwards whether or not `fn` throws.
 *
 * @template T
 * @param {Uint8Array} key Key material.
 * @param {(key: Uint8Array) => T} fn Consumer.
 * @returns {T} Whatever `fn` returned.
 */
export function withKey(key, fn) {
  try {
    return fn(key);
  } finally {
    zeroize(key);
  }
}

/* -------------------------------------------------------------------------- */
/* Key parsing and validation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Parse a 0x-hex or raw-bytes private key into 32 bytes, validating the scalar range.
 *
 * @param {string|Uint8Array} key Private key.
 * @returns {Uint8Array} 32 bytes.
 * @throws {KeyError} On a bad length or an out-of-range scalar.
 */
export function toPrivateKeyBytes(key) {
  /** @type {Uint8Array} */
  let bytes;
  if (typeof key === 'string') {
    const hex = key.startsWith('0x') ? key.slice(2) : key;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new KeyError('INVALID_PRIVATE_KEY', 'Private key must be 32 bytes of hex.');
    }
    bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  } else if (key instanceof Uint8Array) {
    bytes = key;
  } else {
    throw new KeyError('INVALID_PRIVATE_KEY', 'Private key must be a hex string or Uint8Array.');
  }
  if (bytes.length !== SECP256K1_PRIVKEY_BYTES) {
    throw new KeyError('INVALID_PRIVATE_KEY', `Private key must be 32 bytes, got ${bytes.length}.`);
  }
  const scalar = bytesToBigInt(bytes);
  if (scalar === 0n || scalar >= SECP256K1_N) {
    throw new KeyError('INVALID_PRIVATE_KEY', 'Private key is not a valid secp256k1 scalar.');
  }
  return bytes;
}

/**
 * Big-endian bytes to BigInt.
 *
 * @param {Uint8Array} bytes Input.
 * @returns {bigint} Value.
 */
function bytesToBigInt(bytes) {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

/**
 * BigInt to fixed-width big-endian bytes.
 *
 * @param {bigint} value Value.
 * @param {number} length Byte width.
 * @returns {Uint8Array} Big-endian encoding.
 */
function bigIntToBytes(value, length) {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Validate a 33-byte compressed secp256k1 public key, including the on-curve check.
 *
 * The on-curve check is not ceremony: an attacker-supplied "public key" that is not on the curve
 * turns ECDH into an invalid-curve attack that can leak bits of the private key. Every recipient key
 * that arrives from the chain or from an HTTP body must pass through here.
 *
 * @param {string|Uint8Array} publicKey Compressed key.
 * @returns {Uint8Array} The validated 33 bytes.
 * @throws {KeyError} When malformed, wrongly prefixed, or off-curve.
 */
export function assertCompressedPublicKey(publicKey) {
  const bytes =
    typeof publicKey === 'string'
      ? Uint8Array.from(Buffer.from(publicKey.replace(/^0x/, ''), 'hex'))
      : publicKey;
  if (bytes.length !== SECP256K1_COMPRESSED_PUBKEY_BYTES) {
    throw new KeyError(
      'INVALID_PUBLIC_KEY',
      `Compressed public key must be ${SECP256K1_COMPRESSED_PUBKEY_BYTES} bytes, got ${bytes.length}.`,
    );
  }
  if (bytes[0] !== 0x02 && bytes[0] !== 0x03) {
    throw new KeyError(
      'INVALID_PUBLIC_KEY',
      `Compressed public key must start with 0x02 or 0x03, got 0x${bytes[0].toString(16)}.`,
    );
  }
  try {
    // Throws when the x coordinate has no corresponding curve point.
    SigningKey.computePublicKey(publicKeyToHex(bytes), false);
  } catch (cause) {
    throw new KeyError('INVALID_PUBLIC_KEY', 'Public key is not a point on secp256k1.', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return bytes;
}

/**
 * 0x-hex form of a public key.
 *
 * @param {Uint8Array} bytes Key bytes.
 * @returns {string} 0x-prefixed hex.
 */
export function publicKeyToHex(bytes) {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

/**
 * Bytes form of a 0x-hex public key.
 *
 * @param {string} hex 0x-prefixed hex.
 * @returns {Uint8Array} Key bytes.
 */
export function publicKeyFromHex(hex) {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
}

/* -------------------------------------------------------------------------- */
/* Encryption-key derivation                                                   */
/* -------------------------------------------------------------------------- */

/**
 * An agent's encryption keypair. Distinct from its wallet/signing keypair.
 *
 * @typedef {object} EncryptionKeypair
 * @property {Uint8Array} privateKey 32-byte secp256k1 scalar. **Key material.**
 * @property {Uint8Array} publicKey 33-byte compressed point.
 * @property {string} publicKeyHex 0x-hex of `publicKey`, the form published on chain.
 * @property {number} keyVersion Monotonic version this key was derived under.
 */

/**
 * Deterministically derive an agent's encryption keypair from its wallet private key.
 *
 * Deterministic in `(walletPrivateKey, keyVersion)` alone: two processes, two machines, and a
 * restart all produce byte-identical output, which is what lets a node recover its own memories
 * after a restart without persisting a second secret.
 *
 * @param {string|Uint8Array} walletPrivateKey The wallet's secp256k1 private key. **Key material.**
 * @param {number} [keyVersion] Monotonic version; bumping it produces an unrelated keypair.
 * @returns {EncryptionKeypair} The derived keypair.
 * @throws {KeyError} If the wallet key is invalid, or (astronomically unlikely) if rejection
 *   sampling fails to find a valid scalar.
 */
export function deriveEncryptionKey(walletPrivateKey, keyVersion = 1) {
  const ikm = toPrivateKeyBytes(walletPrivateKey);
  const versionBytes = uint32be(keyVersion);

  for (let counter = 0; counter < 256; counter += 1) {
    const info = concatBytes(
      new TextEncoder().encode(HKDF_INFO_ENCKEY),
      versionBytes,
      uint32be(counter),
    );
    const okm = new Uint8Array(
      hkdfSync(HKDF_HASH, ikm, SPEC_HASH_BYTES, info, SECP256K1_PRIVKEY_BYTES),
    );
    const scalar = bytesToBigInt(okm);
    if (scalar === 0n || scalar >= SECP256K1_N) {
      zeroize(okm);
      continue; // Rejection sampling: retry with an incremented counter, never reduce mod n.
    }
    const privateKey = bigIntToBytes(scalar, SECP256K1_PRIVKEY_BYTES);
    zeroize(okm);

    // The derived key must not equal the wallet key. HKDF makes a collision impossible in practice;
    // this assertion exists so that a future refactor which accidentally short-circuits the
    // derivation fails loudly instead of silently reintroducing the v1 defect.
    if (Buffer.from(privateKey).equals(Buffer.from(ikm))) {
      throw new KeyError(
        'KEY_SEPARATION_VIOLATED',
        'Derived encryption key equals the wallet signing key; derivation is not separating.',
      );
    }

    const signing = new SigningKey(publicKeyToHex(privateKey));
    const publicKey = publicKeyFromHex(signing.compressedPublicKey);
    return {
      privateKey,
      publicKey,
      publicKeyHex: signing.compressedPublicKey,
      keyVersion,
    };
  }

  /* c8 ignore next 4 -- unreachable: P(256 consecutive HKDF outputs out of range) < 2^-2000 */
  throw new KeyError(
    'DERIVATION_FAILED',
    'Rejection sampling exhausted 256 counters without producing a valid secp256k1 scalar.',
  );
}

/**
 * Wrap an independently generated encryption private key in the same shape as
 * {@link deriveEncryptionKey}, for agents that manage key material elsewhere (an HSM, a KMS, a
 * hardware wallet with a randomised nonce).
 *
 * @param {string|Uint8Array} privateKeyHex The encryption private key. **Key material.**
 * @param {number} [keyVersion] Version to report.
 * @returns {EncryptionKeypair} The keypair.
 */
export function importEncryptionKey(privateKeyHex, keyVersion = 1) {
  const privateKey = toPrivateKeyBytes(privateKeyHex);
  const signing = new SigningKey(publicKeyToHex(privateKey));
  return {
    privateKey,
    publicKey: publicKeyFromHex(signing.compressedPublicKey),
    publicKeyHex: signing.compressedPublicKey,
    keyVersion,
  };
}

/**
 * The wallet address that corresponds to a signing private key.
 *
 * Provided here so callers never need to construct a `Wallet` (which carries a provider and a
 * signing surface) just to learn an address.
 *
 * @param {string|Uint8Array} walletPrivateKey Signing key. **Key material.**
 * @returns {string} Checksummed address.
 */
export function addressFromPrivateKey(walletPrivateKey) {
  return computeAddress(publicKeyToHex(toPrivateKeyBytes(walletPrivateKey)));
}
