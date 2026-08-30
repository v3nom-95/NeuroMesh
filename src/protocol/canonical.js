/**
 * NeuroMesh Protocol — canonicalisation, hashing and content addressing.
 *
 * This is the byte-level foundation. Everything above it — the payload schema, the CID, the
 * on-chain `cidHash`, the AAD — is a function of the bytes this module produces, so it is written to
 * be reimplementable in any language from the comments alone and to have no dependency that a
 * standalone verifier could not also install.
 *
 * ## Canonical form
 *
 * RFC 8785 (JSON Canonicalization Scheme), restricted further:
 *
 *   - Object members are emitted in ascending order of their key's UTF-16 code units. JavaScript's
 *     default `Array.prototype.sort()` on strings compares exactly that way, which is why no
 *     comparator is passed. (RFC 8785 §3.2.3.)
 *   - Arrays preserve their order.
 *   - Strings use `JSON.stringify`'s escaping, which is the minimal escaping RFC 8785 §3.2.2.2
 *     mandates.
 *   - **Numbers must be safe integers.** Floats, NaN, Infinity, -0 and BigInt are rejected outright
 *     rather than serialised. This removes every dependence on cross-language float printing, which
 *     is the single largest source of canonicalisation disagreement between implementations. Real
 *     vectors travel as base64url of a little-endian Float32Array (see {@link f32ToB64}).
 *   - `undefined`, functions and symbols are rejected anywhere they appear, including as object
 *     values, so a typo can never silently drop a field from the hash preimage.
 *   - Cycles are detected and rejected.
 *   - Any string containing U+001F is rejected, because that byte is the AAD separator and allowing
 *     it here would let a payload field forge an AAD boundary.
 *
 * @module src/protocol/canonical
 */

import { createHash } from 'node:crypto';

import { keccak256 } from 'ethers';

import { CID_PREFIX, MAX_PAYLOAD_BYTES, UNIT_SEP } from './constants.js';
import { CanonicalizationError, CidMismatchError, PayloadTooLargeError } from './errors.js';

/* -------------------------------------------------------------------------- */
/* JCS canonicalisation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Serialise `value` to its canonical JSON string.
 *
 * @param {unknown} value Any JSON-representable value obeying the restrictions above.
 * @returns {string} Canonical JSON. The same logical value always yields the same string.
 * @throws {CanonicalizationError} On any value the restricted profile forbids.
 */
export function canonicalize(value) {
  return write(value, new Set(), '$');
}

/**
 * @param {unknown} value Value to serialise.
 * @param {Set<object>} seen Ancestor set, for cycle detection.
 * @param {string} path JSON-path-ish breadcrumb used in error messages.
 * @returns {string} Canonical JSON fragment.
 */
function write(value, seen, path) {
  if (value === null) return 'null';

  const type = typeof value;

  if (type === 'boolean') return value ? 'true' : 'false';

  if (type === 'string') {
    const text = /** @type {string} */ (value);
    if (text.includes(UNIT_SEP)) {
      throw new CanonicalizationError(
        `String at ${path} contains U+001F, which is reserved as the AAD separator.`,
        { path },
      );
    }
    return JSON.stringify(text);
  }

  if (type === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalizationError(
        `Number at ${path} is not a safe integer (${String(value)}). Non-integer numbers are ` +
          'forbidden in canonical payloads; encode real values as base64url float32 instead.',
        { path, value: String(value) },
      );
    }
    // Object.is distinguishes -0 from 0; -0 would round-trip as 0 and break byte stability.
    if (Object.is(value, -0)) {
      throw new CanonicalizationError(`Number at ${path} is negative zero.`, { path });
    }
    return String(value);
  }

  if (type === 'bigint') {
    throw new CanonicalizationError(
      `BigInt at ${path} has no JSON representation; encode it as a decimal string.`,
      { path },
    );
  }

  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    throw new CanonicalizationError(`Value at ${path} has forbidden type "${type}".`, {
      path,
      type,
    });
  }

  // Objects and arrays.
  const obj = /** @type {object} */ (value);
  if (seen.has(obj)) {
    throw new CanonicalizationError(`Cyclic reference at ${path}.`, { path });
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item, i) => write(item, seen, `${path}[${i}]`));
      return `[${parts.join(',')}]`;
    }
    if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) {
      throw new CanonicalizationError(
        `Value at ${path} is a class instance (${obj.constructor?.name ?? 'unknown'}); only plain ` +
          'objects and arrays can be canonicalised.',
        { path },
      );
    }
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) =>
        `${JSON.stringify(k)}:${write(/** @type {Record<string, unknown>} */ (obj)[k], seen, `${path}.${k}`)}`,
    );
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Canonical UTF-8 bytes of `value`.
 *
 * @param {unknown} value Any value acceptable to {@link canonicalize}.
 * @returns {Uint8Array} UTF-8 encoding of the canonical JSON.
 * @throws {PayloadTooLargeError} When the encoding exceeds `MAX_PAYLOAD_BYTES`.
 */
export function canonicalBytes(value) {
  const bytes = new TextEncoder().encode(canonicalize(value));
  if (bytes.length > MAX_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(bytes.length, MAX_PAYLOAD_BYTES);
  }
  return bytes;
}

/**
 * Re-canonicalise `bytes` and assert they were already canonical.
 *
 * Step 3 of the third-party verification procedure: a payload whose bytes differ from the canonical
 * form of their own parse cannot be reproduced by a verifier and must be rejected.
 *
 * @param {Uint8Array} bytes Fetched payload bytes.
 * @returns {void}
 * @throws {CanonicalizationError} When the bytes are not already canonical.
 */
export function assertCanonical(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new CanonicalizationError('Payload bytes are not valid JSON.', {
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (canonicalize(parsed) !== text) {
    throw new CanonicalizationError(
      'Payload bytes are not in canonical form; re-serialising the parse produced different bytes.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * keccak256 of raw bytes — the hash Solidity speaks.
 *
 * @param {Uint8Array} bytes Input.
 * @returns {string} 0x-prefixed 32-byte hex.
 */
export function payloadHash(bytes) {
  return keccak256(bytes);
}

/**
 * sha2-256 of raw bytes as a `Uint8Array` — the hash IPFS speaks.
 *
 * @param {Uint8Array} bytes Input.
 * @returns {Uint8Array} 32-byte digest.
 */
export function sha256(bytes) {
  return Uint8Array.from(createHash('sha256').update(bytes).digest());
}

/**
 * sha2-256 of raw bytes as 0x-prefixed hex.
 *
 * @param {Uint8Array} bytes Input.
 * @returns {string} 0x-prefixed 32-byte hex.
 */
export function sha256Hex(bytes) {
  return `0x${createHash('sha256').update(bytes).digest('hex')}`;
}

/* -------------------------------------------------------------------------- */
/* base32 (RFC 4648, lower-case, unpadded) — the multibase `b` alphabet        */
/* -------------------------------------------------------------------------- */

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * @param {Uint8Array} bytes Input.
 * @returns {string} Unpadded lower-case base32.
 */
function base32Encode(bytes) {
  let out = '';
  let bits = 0;
  let acc = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32_ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += B32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * @param {string} text Unpadded lower-case base32.
 * @returns {Uint8Array} Decoded bytes.
 * @throws {CanonicalizationError} On any character outside the alphabet.
 */
function base32Decode(text) {
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of text) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) {
      throw new CanonicalizationError(`Invalid base32 character "${ch}".`, { char: ch });
    }
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/* -------------------------------------------------------------------------- */
/* CIDv1 (raw codec, sha2-256, single block)                                   */
/* -------------------------------------------------------------------------- */

/**
 * Compute the CIDv1 of `bytes` locally.
 *
 * The multihash is `0x01 0x55 0x12 0x20 || sha256(bytes)`: CID version 1, `raw` codec (0x55),
 * sha2-256 (0x12), 32-byte digest (0x20). The string form is multibase base32-lower, prefixed `b`.
 * Because payloads are capped at 1 MiB the object is always a single raw block, so there is no
 * UnixFS framing and no DAG — a verifier reproduces this in four lines.
 *
 * @param {Uint8Array} bytes Exact payload bytes.
 * @returns {{ cid: string, digest: string }} The CID string and the 0x-hex sha2-256 digest.
 */
export function cidFromBytes(bytes) {
  const digest = sha256(bytes);
  const multihash = new Uint8Array(CID_PREFIX.length + digest.length);
  multihash.set(CID_PREFIX, 0);
  multihash.set(digest, CID_PREFIX.length);
  return {
    cid: `b${base32Encode(multihash)}`,
    digest: `0x${Buffer.from(digest).toString('hex')}`,
  };
}

/**
 * Parse a CID string and return its sha2-256 digest.
 *
 * Rejects loudly rather than mis-parsing: a v0 `Qm…` CID, a dag-pb CID, or any other hash function
 * throws, because a verifier that silently accepted one would be checking the wrong bytes.
 *
 * @param {string} cid Multibase base32 CIDv1 string.
 * @returns {string} 0x-prefixed 32-byte sha2-256 digest.
 * @throws {CanonicalizationError} When the CID is not v1/raw/sha2-256/32.
 */
export function digestFromCid(cid) {
  if (typeof cid !== 'string' || cid.length === 0) {
    throw new CanonicalizationError('CID must be a non-empty string.');
  }
  if (cid.startsWith('Qm')) {
    throw new CanonicalizationError(
      'CIDv0 (Qm…) is not accepted: it implies the dag-pb codec and UnixFS framing, so its digest ' +
        'is not sha256 of the payload bytes.',
      { cid },
    );
  }
  if (!cid.startsWith('b')) {
    throw new CanonicalizationError(
      `Unsupported multibase prefix "${cid[0]}"; only base32-lower ("b") is accepted.`,
      { cid },
    );
  }
  const bytes = base32Decode(cid.slice(1));
  if (bytes.length !== CID_PREFIX.length + 32) {
    throw new CanonicalizationError(
      `CID decodes to ${bytes.length} bytes; expected ${CID_PREFIX.length + 32}.`,
      { cid },
    );
  }
  for (let i = 0; i < CID_PREFIX.length; i += 1) {
    if (bytes[i] !== CID_PREFIX[i]) {
      throw new CanonicalizationError(
        'CID is not v1/raw/sha2-256/32; only single-block raw payloads are addressable here.',
        { cid },
      );
    }
  }
  return `0x${Buffer.from(bytes.subarray(CID_PREFIX.length)).toString('hex')}`;
}

/**
 * Assert that `cid` really addresses `bytes`.
 *
 * This is the check that removes the pinning service from the middle of the proof chain: the node
 * computes the CID itself and refuses whatever the remote API claims if the two disagree.
 *
 * @param {Uint8Array} bytes Exact payload bytes.
 * @param {string} cid CID claimed by a third party.
 * @returns {void}
 * @throws {CidMismatchError} On disagreement.
 */
export function verifyCid(bytes, cid) {
  const { cid: expected } = cidFromBytes(bytes);
  if (expected !== cid) throw new CidMismatchError(expected, cid);
}

/* -------------------------------------------------------------------------- */
/* base64url and typed-array codecs                                            */
/* -------------------------------------------------------------------------- */

/**
 * Encode bytes as unpadded base64url.
 *
 * @param {Uint8Array} bytes Input.
 * @returns {string} Unpadded base64url.
 */
export function b64u(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Decode unpadded base64url.
 *
 * @param {string} text Input.
 * @returns {Uint8Array} Decoded bytes.
 */
export function unb64u(text) {
  return Uint8Array.from(Buffer.from(text, 'base64url'));
}

/**
 * Encode a float vector as base64url of little-endian IEEE-754 binary32.
 *
 * Endianness is written explicitly through `DataView`; host order is never assumed, so the encoding
 * is identical on a big-endian machine.
 *
 * @param {ArrayLike<number>} values Vector.
 * @returns {string} base64url of `values.length * 4` bytes.
 */
export function f32ToB64(values) {
  const buf = new ArrayBuffer(values.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < values.length; i += 1) view.setFloat32(i * 4, values[i], true);
  return b64u(new Uint8Array(buf));
}

/**
 * Decode base64url little-endian binary32 back into a `Float32Array`.
 *
 * @param {string} text Encoded vector.
 * @returns {Float32Array} Decoded vector.
 * @throws {CanonicalizationError} When the byte length is not a multiple of 4.
 */
export function b64ToF32(text) {
  const bytes = unb64u(text);
  if (bytes.length % 4 !== 0) {
    throw new CanonicalizationError(
      `Encoded float32 vector is ${bytes.length} bytes, which is not a multiple of 4.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.length / 4);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}
