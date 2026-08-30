/**
 * NeuroMesh Protocol — envelope encryption.
 *
 * ## Shape of the scheme
 *
 * Every memory is sealed under its **own** random content-encryption key (CEK). The CEK is then
 * wrapped separately for each recipient with ECIES over secp256k1. Nothing is ever encrypted
 * directly under a long-term key, and no long-term key is ever an AES key.
 *
 *     CEK        ← 32 random bytes, used for exactly one payload
 *     ciphertext ← AES-256-GCM(CEK, iv=12 random bytes, aad=buildAad(...))  over the plaintext
 *     recipient  ← ECIES-wrap(CEK) under that recipient's *encryption* public key
 *
 * ## What the AAD binds, and why it is not the CID
 *
 * The additional authenticated data is
 *
 *     PROTOCOL_VERSION ␟ SPEC_HASH ␟ agentDid ␟ contentId ␟ policyId ␟ modelId ␟ keyVersion
 *
 * (␟ = U+001F, and every component is rejected if it contains that byte, so the encoding is
 * unambiguous). This is what makes the cut-and-paste attack the v1 design permitted impossible: an
 * attacker could previously lift Alice's `encrypted_context` object verbatim into their own payload
 * under their own DID, and GCM would verify happily because the ciphertext was bound to nothing.
 * Now the tag only verifies against the exact `(agent, content, policy, model, key version)` tuple
 * that produced it.
 *
 * The AAD deliberately does **not** contain the CID. That would be circular: the CID is the hash of
 * the payload, the payload contains the ciphertext, and the ciphertext depends on the AAD. The chain
 * closes through the ledger instead — the payload carries `contentId`, the CID is the hash of the
 * payload, and the on-chain `MemoryCommit` signature covers `cidHash`. End-to-end binding, no cycle.
 *
 * ## Cost
 *
 * Measured on this repository's benchmark harness: 0.027 ms per seal versus 53 ms for the v1
 * PBKDF2-from-the-private-key scheme. Faster *and* strictly stronger — the v1 cost was almost
 * entirely 100 000 SHA-512 iterations stretching a value that was already uniformly random.
 *
 * @module src/protocol/envelope
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { SigningKey, getAddress } from 'ethers';

import { b64u, canonicalBytes, sha256, unb64u } from './canonical.js';
import {
  AEAD_ALG,
  AES_IV_BYTES,
  AES_TAG_BYTES,
  CEK_BYTES,
  CONTENT_ALG,
  CONTENT_ID_BYTES,
  ECIES_ALG,
  HKDF_HASH,
  HKDF_INFO_KEK,
  POLICY_ID_NONE,
  PROTOCOL_VERSION,
  SPEC_HASH,
  SPEC_HASH_BYTES,
  UNIT_SEP,
} from './constants.js';
import { DecryptionError, KeyError, ProtocolError } from './errors.js';
import {
  assertCompressedPublicKey,
  concatBytes,
  publicKeyFromHex,
  publicKeyToHex,
  toPrivateKeyBytes,
  uint32be,
  zeroize,
} from './keys.js';

const utf8 = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* Random material                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Fresh content-encryption key.
 *
 * Every payload gets its own, so the "at most 2^32 encryptions per key" GCM bound is satisfied by
 * construction with an enormous margin: each CEK performs exactly one encryption.
 *
 * @returns {Uint8Array} 32 random bytes. **Key material** — zeroise it when done.
 */
export function generateCek() {
  return Uint8Array.from(randomBytes(CEK_BYTES));
}

/**
 * Fresh random content identifier.
 *
 * Use this when the identifier should be unlinkable to the plaintext. Use
 * `payload.computeContentId()` instead when the identifier should be a deterministic function of the
 * content, so the same logical memory always carries the same id.
 *
 * @returns {string} 0x-prefixed 16-byte hex.
 */
export function generateContentId() {
  return `0x${randomBytes(CONTENT_ID_BYTES).toString('hex')}`;
}

/**
 * Fresh ephemeral secp256k1 keypair for one ECIES wrap.
 *
 * @returns {{ privateKey: Uint8Array, publicKeyHex: string }} Ephemeral pair.
 */
function generateEphemeralKey() {
  for (let i = 0; i < 256; i += 1) {
    const candidate = Uint8Array.from(randomBytes(32));
    try {
      toPrivateKeyBytes(candidate);
    } catch {
      continue; // Out-of-range scalar; probability ~2^-128, but handle it rather than assume.
    }
    const signing = new SigningKey(publicKeyToHex(candidate));
    return { privateKey: candidate, publicKeyHex: signing.compressedPublicKey };
  }
  /* c8 ignore next 3 -- unreachable in any universe with a working CSPRNG */
  throw new KeyError('DERIVATION_FAILED', 'Could not sample a valid ephemeral secp256k1 scalar.');
}

/* -------------------------------------------------------------------------- */
/* AAD construction                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build the additional authenticated data for a content seal.
 *
 * Exported publicly and deliberately: a third-party verifier must be able to reconstruct the exact
 * AAD bytes from the payload's own fields in order to check the tag. A verifier must **never** trust
 * an `aad` echo stored inside the payload — reconstruct, then compare.
 *
 * @param {object} args AAD components.
 * @param {string} args.agentDid Authoring agent's did:pkh.
 * @param {string} args.contentId 0x-hex content identifier.
 * @param {string} args.modelId Identifier of the embedding model the payload describes.
 * @param {number} args.keyVersion Encryption key version in force when the memory was sealed.
 * @param {string} [args.policyId] keccak of the canonical policy block, 0x-prefixed hex; defaults
 *   to 32 zero bytes.
 * @returns {Uint8Array} UTF-8 AAD bytes.
 * @throws {ProtocolError} When a component contains the U+001F separator or is missing.
 */
export function buildAad({ agentDid, contentId, modelId, keyVersion, policyId = POLICY_ID_NONE }) {
  const components = [
    PROTOCOL_VERSION,
    SPEC_HASH,
    agentDid,
    contentId,
    policyId,
    modelId,
    String(keyVersion),
  ];
  const names = [
    'PROTOCOL_VERSION',
    'SPEC_HASH',
    'agentDid',
    'contentId',
    'policyId',
    'modelId',
    'keyVersion',
  ];
  components.forEach((component, i) => {
    if (typeof component !== 'string' || component.length === 0) {
      throw new ProtocolError('AAD_COMPONENT_MISSING', `AAD component ${names[i]} is missing.`, {
        component: names[i],
      });
    }
    if (component.includes(UNIT_SEP)) {
      throw new ProtocolError(
        'AAD_COMPONENT_INVALID',
        `AAD component ${names[i]} contains U+001F, which is the component separator.`,
        { component: names[i] },
      );
    }
  });
  return utf8.encode(components.join(UNIT_SEP));
}

/**
 * Build the AAD for a per-recipient key wrap.
 *
 * Separate from the content AAD on purpose: it binds the wrap to the grantor, the content, the
 * recipient address, the recipient's key version and the ephemeral public key, so a wrap cannot be
 * re-addressed to a different recipient or re-used for a different memory.
 *
 * @param {object} args Wrap AAD components.
 * @param {string} args.grantorDid did:pkh of the agent performing the wrap.
 * @param {string} args.contentId 0x-hex content identifier.
 * @param {string} args.recipientAddress Checksummed recipient address.
 * @param {number} args.recipientKeyVersion Recipient's encryption key version.
 * @param {string} args.ephemeralPublicKey 0x-hex compressed ephemeral public key.
 * @returns {Uint8Array} UTF-8 AAD bytes.
 */
export function buildWrapAad({
  grantorDid,
  contentId,
  recipientAddress,
  recipientKeyVersion,
  ephemeralPublicKey,
}) {
  const components = [
    ECIES_ALG,
    SPEC_HASH,
    grantorDid,
    contentId,
    getAddress(recipientAddress),
    String(recipientKeyVersion),
    ephemeralPublicKey,
  ];
  for (const component of components) {
    if (typeof component !== 'string' || component.length === 0 || component.includes(UNIT_SEP)) {
      throw new ProtocolError('AAD_COMPONENT_INVALID', 'Invalid key-wrap AAD component.');
    }
  }
  return utf8.encode(components.join(UNIT_SEP));
}

/* -------------------------------------------------------------------------- */
/* Content sealing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A sealed content block, as it appears in the IPFS payload.
 *
 * @typedef {object} CipherBlock
 * @property {string} alg Algorithm discriminator, {@link CONTENT_ALG}.
 * @property {string} iv base64url of the 12-byte GCM nonce.
 * @property {string} ct base64url of the ciphertext.
 * @property {string} tag base64url of the 16-byte GCM tag.
 */

/**
 * Seal bytes or a UTF-8 string under a CEK.
 *
 * @param {string|Uint8Array} plaintext Data to seal.
 * @param {object} options Options.
 * @param {Uint8Array} options.cek 32-byte content-encryption key.
 * @param {Uint8Array} options.aad AAD bytes from {@link buildAad}.
 * @returns {CipherBlock} The sealed block. `ct` is the ciphertext.
 */
export function seal(plaintext, { cek, aad }) {
  assertCek(cek);
  assertAad(aad);
  const bytes = typeof plaintext === 'string' ? utf8.encode(plaintext) : plaintext;
  const iv = randomBytes(AES_IV_BYTES);
  const cipher = createCipheriv(AEAD_ALG, cek, iv, { authTagLength: AES_TAG_BYTES });
  cipher.setAAD(aad, { plaintextLength: bytes.length });
  const ct = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    alg: CONTENT_ALG,
    iv: b64u(iv),
    ct: b64u(ct),
    tag: b64u(cipher.getAuthTag()),
  };
}

/**
 * Open a sealed block back into bytes.
 *
 * A tag failure is reported as `TAG_VERIFY_FAILED` and means something stronger than "wrong key":
 * the ciphertext is not bound to the agent DID, content id, policy, model and key version you
 * supplied. Anyone who cut this ciphertext out of another agent's payload lands here.
 *
 * @param {CipherBlock & { ciphertext?: string }} cipherBlock The sealed block. `ciphertext` is
 *   accepted as an alias for `ct` on input; `ct` is what is written on output.
 * @param {object} options Options.
 * @param {Uint8Array} options.cek 32-byte content-encryption key.
 * @param {Uint8Array} options.aad AAD bytes reconstructed from the payload's own fields.
 * @returns {Uint8Array} Plaintext bytes.
 * @throws {DecryptionError} On tag verification failure or a malformed block.
 */
export function open(cipherBlock, { cek, aad }) {
  assertCek(cek);
  assertAad(aad);
  const ctB64 = cipherBlock?.ct ?? cipherBlock?.ciphertext;
  if (!cipherBlock || typeof cipherBlock.iv !== 'string' || typeof ctB64 !== 'string') {
    throw new DecryptionError('CIPHER_BLOCK_MALFORMED', 'Sealed block is missing iv/ct/tag.');
  }
  if (cipherBlock.alg && cipherBlock.alg !== CONTENT_ALG) {
    throw new DecryptionError(
      'CIPHER_ALG_UNSUPPORTED',
      `Unsupported content algorithm "${cipherBlock.alg}"; this build understands ${CONTENT_ALG}.`,
      { alg: cipherBlock.alg },
    );
  }
  const iv = unb64u(cipherBlock.iv);
  if (iv.length !== AES_IV_BYTES) {
    throw new DecryptionError(
      'CIPHER_BLOCK_MALFORMED',
      `GCM nonce must be ${AES_IV_BYTES} bytes, got ${iv.length}. v1 blocks used 16 and are not ` +
        'readable here; migrate them with scripts/migrate-v1-ciphertext.js.',
    );
  }
  const tag = unb64u(cipherBlock.tag ?? '');
  if (tag.length !== AES_TAG_BYTES) {
    throw new DecryptionError('CIPHER_BLOCK_MALFORMED', 'GCM tag must be 16 bytes.');
  }
  const decipher = createDecipheriv(AEAD_ALG, cek, iv, { authTagLength: AES_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Uint8Array.from(Buffer.concat([decipher.update(unb64u(ctB64)), decipher.final()]));
  } catch {
    throw new DecryptionError(
      'TAG_VERIFY_FAILED',
      'GCM tag verification failed. This does not merely mean "wrong key": the ciphertext is not ' +
        'bound to the (agentDid, contentId, policyId, modelId, keyVersion) tuple supplied as AAD, ' +
        'so either the key is wrong, the block was tampered with, or it was copied from another ' +
        "agent's payload.",
    );
  }
}

/**
 * Seal a plain JSON object, canonicalised first so the ciphertext is a function of the *logical*
 * content rather than of key ordering.
 *
 * @param {object} content Plain object obeying the canonicalisation rules.
 * @param {object} options Options.
 * @param {Uint8Array} options.cek 32-byte content-encryption key.
 * @param {Uint8Array} options.aad AAD bytes from {@link buildAad}.
 * @returns {CipherBlock} The sealed block.
 */
export function sealContent(content, { cek, aad }) {
  return seal(canonicalBytes(content), { cek, aad });
}

/**
 * Open a sealed block and parse it as JSON.
 *
 * @param {CipherBlock & { ciphertext?: string }} cipherBlock The sealed block.
 * @param {object} options Options.
 * @param {Uint8Array} options.cek 32-byte content-encryption key.
 * @param {Uint8Array} options.aad AAD bytes reconstructed from the payload's own fields.
 * @returns {unknown} Parsed content.
 */
export function openContent(cipherBlock, { cek, aad }) {
  const bytes = open(cipherBlock, { cek, aad });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    zeroize(bytes);
  }
}

/* -------------------------------------------------------------------------- */
/* ECIES key wrapping                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One recipient's wrapped copy of the CEK.
 *
 * @typedef {object} RecipientEntry
 * @property {string} alg Algorithm discriminator, {@link ECIES_ALG}.
 * @property {string} addr Checksummed recipient address.
 * @property {number} keyVersion Recipient's encryption key version.
 * @property {string} epk 0x-hex compressed ephemeral public key.
 * @property {string} iv base64url of the 12-byte GCM nonce.
 * @property {string} ct base64url of the wrapped CEK.
 * @property {string} tag base64url of the 16-byte GCM tag.
 */

/**
 * Derive the key-encryption key shared with one recipient.
 *
 * Seven steps, laid out so a reimplementation can follow them exactly:
 *   1. Validate the counterparty's compressed public key, including the on-curve check.
 *   2. ECDH: `shared = d · Q`, taking the **x coordinate only** — the leading 0x02/0x03/0x04 byte of
 *      the encoded point is dropped, because including it would make the secret depend on the point
 *      encoding rather than on the shared value.
 *   3. salt = `sha256(SPEC_HASH ‖ contentId)`, so a KEK is scoped to one memory.
 *   4. info = `"neuromesh/kek/v2" ‖ recipientAddress(20 bytes) ‖ uint32be(keyVersion)`.
 *   5. HKDF-SHA256 to 32 bytes.
 *
 * @param {object} args Arguments.
 * @param {Uint8Array} args.privateKey Local secp256k1 scalar (ephemeral when wrapping, the
 *   recipient's encryption key when unwrapping). **Key material.**
 * @param {string} args.peerPublicKey 0x-hex compressed public key of the other side.
 * @param {string} args.recipientAddress Checksummed recipient address.
 * @param {number} args.recipientKeyVersion Recipient's encryption key version.
 * @param {string} args.contentId 0x-hex content identifier.
 * @returns {Uint8Array} 32-byte KEK. **Key material.**
 */
function deriveKek({
  privateKey,
  peerPublicKey,
  recipientAddress,
  recipientKeyVersion,
  contentId,
}) {
  assertCompressedPublicKey(peerPublicKey);
  const signing = new SigningKey(publicKeyToHex(privateKey));
  // ethers returns the uncompressed point (0x04 ‖ x ‖ y); the x coordinate is bytes 1..33.
  const sharedPoint = publicKeyFromHex(signing.computeSharedSecret(peerPublicKey));
  const sharedX = sharedPoint.subarray(1, 33);

  const salt = sha256(concatBytes(SPEC_HASH_BYTES, hexToBytes(contentId)));
  const info = concatBytes(
    utf8.encode(HKDF_INFO_KEK),
    hexToBytes(getAddress(recipientAddress)),
    uint32be(recipientKeyVersion),
  );
  const kek = new Uint8Array(hkdfSync(HKDF_HASH, sharedX, salt, info, CEK_BYTES));
  zeroize(sharedPoint);
  return kek;
}

/**
 * Wrap a CEK for one recipient.
 *
 * @param {object} args Arguments.
 * @param {Uint8Array} args.cek 32-byte content-encryption key to wrap. **Key material.**
 * @param {string} args.recipientPublicKey 0x-hex compressed encryption public key of the recipient,
 *   as published in `AgentIdentity`. Never the recipient's *signing* key.
 * @param {string} args.recipientAddress Recipient's address.
 * @param {string} args.grantorDid did:pkh of the agent performing the wrap.
 * @param {string} args.contentId 0x-hex content identifier.
 * @param {number} [args.recipientKeyVersion] Recipient's encryption key version.
 * @returns {RecipientEntry} The wrapped entry, safe to publish.
 */
export function wrapCek({
  cek,
  recipientPublicKey,
  recipientAddress,
  grantorDid,
  contentId,
  recipientKeyVersion = 1,
}) {
  assertCek(cek);
  const addr = getAddress(recipientAddress);
  const ephemeral = generateEphemeralKey();
  /** @type {Uint8Array|null} */
  let kek = null;
  try {
    kek = deriveKek({
      privateKey: ephemeral.privateKey,
      peerPublicKey: recipientPublicKey,
      recipientAddress: addr,
      recipientKeyVersion,
      contentId,
    });
    const aad = buildWrapAad({
      grantorDid,
      contentId,
      recipientAddress: addr,
      recipientKeyVersion,
      ephemeralPublicKey: ephemeral.publicKeyHex,
    });
    const iv = randomBytes(AES_IV_BYTES);
    const cipher = createCipheriv(AEAD_ALG, kek, iv, { authTagLength: AES_TAG_BYTES });
    cipher.setAAD(aad, { plaintextLength: cek.length });
    const ct = Buffer.concat([cipher.update(cek), cipher.final()]);
    return {
      alg: ECIES_ALG,
      addr,
      keyVersion: recipientKeyVersion,
      epk: ephemeral.publicKeyHex,
      iv: b64u(iv),
      ct: b64u(ct),
      tag: b64u(cipher.getAuthTag()),
    };
  } finally {
    zeroize(kek);
    zeroize(ephemeral.privateKey);
  }
}

/**
 * Alias of {@link wrapCek} matching the naming used in the protocol brief.
 *
 * @param {Parameters<typeof wrapCek>[0]} args Arguments.
 * @returns {RecipientEntry} The wrapped entry.
 */
export const wrapCEKFor = (args) => wrapCek(args);

/**
 * Unwrap a CEK addressed to the holder of `recipientPrivateKey`.
 *
 * @param {object} args Arguments.
 * @param {RecipientEntry} args.entry The recipient entry from the payload.
 * @param {Uint8Array|string} args.recipientPrivateKey The recipient's **encryption** private key.
 * @param {string} args.grantorDid did:pkh of the agent that performed the wrap.
 * @param {string} args.contentId 0x-hex content identifier.
 * @returns {Uint8Array} The 32-byte CEK. **Key material** — zeroise it when done.
 * @throws {DecryptionError} When the entry is malformed or its tag does not verify.
 */
export function unwrapCek({ entry, recipientPrivateKey, grantorDid, contentId }) {
  if (!entry || typeof entry.epk !== 'string') {
    throw new DecryptionError('RECIPIENT_ENTRY_MALFORMED', 'Recipient entry is missing `epk`.');
  }
  if (entry.alg && entry.alg !== ECIES_ALG) {
    throw new DecryptionError(
      'WRAP_ALG_UNSUPPORTED',
      `Unsupported key-wrap algorithm "${entry.alg}".`,
      { alg: entry.alg },
    );
  }
  const privateKey = toPrivateKeyBytes(recipientPrivateKey);
  /** @type {Uint8Array|null} */
  let kek = null;
  try {
    kek = deriveKek({
      privateKey,
      peerPublicKey: entry.epk,
      recipientAddress: entry.addr,
      recipientKeyVersion: entry.keyVersion,
      contentId,
    });
    const aad = buildWrapAad({
      grantorDid,
      contentId,
      recipientAddress: entry.addr,
      recipientKeyVersion: entry.keyVersion,
      ephemeralPublicKey: entry.epk,
    });
    const decipher = createDecipheriv(AEAD_ALG, kek, unb64u(entry.iv), {
      authTagLength: AES_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(unb64u(entry.tag));
    return Uint8Array.from(Buffer.concat([decipher.update(unb64u(entry.ct)), decipher.final()]));
  } catch (cause) {
    if (cause instanceof ProtocolError) throw cause;
    throw new DecryptionError(
      'TAG_VERIFY_FAILED',
      'Key-unwrap tag verification failed: this envelope is not addressed to the supplied key, or ' +
        'the entry was tampered with.',
    );
  } finally {
    zeroize(kek);
  }
}

/**
 * Alias of {@link unwrapCek} matching the naming used in the protocol brief.
 *
 * @param {Parameters<typeof unwrapCek>[0]} args Arguments.
 * @returns {Uint8Array} The 32-byte CEK.
 */
export const unwrapCEK = (args) => unwrapCek(args);

/**
 * Find the entry addressed to `(address, keyVersion)`, or `null`.
 *
 * Returns `null` rather than throwing so a caller can tell "this memory was never shared with me"
 * (a 403 with code `no_envelope_for_recipient`) from "the envelope is corrupt or forged"
 * (`TAG_VERIFY_FAILED`). Collapsing the two would hand an attacker an ownership oracle, which is
 * exactly what the v1 `/api/decrypt` route did with its blanket 403.
 *
 * @param {RecipientEntry[]} recipients Recipient list from the payload.
 * @param {string} address Address to look for.
 * @param {number} [keyVersion] Key version to match; when omitted, the highest available is used.
 * @returns {RecipientEntry|null} The entry, or null.
 */
export function findEntry(recipients, address, keyVersion) {
  if (!Array.isArray(recipients)) return null;
  const target = getAddress(address);
  const mine = recipients.filter((entry) => {
    try {
      return getAddress(entry.addr) === target;
    } catch {
      return false;
    }
  });
  if (mine.length === 0) return null;
  if (keyVersion === undefined) {
    return mine.reduce((best, entry) => (entry.keyVersion > best.keyVersion ? entry : best));
  }
  return mine.find((entry) => entry.keyVersion === keyVersion) ?? null;
}

/**
 * Sort recipient entries into the canonical order: ascending checksummed address, then ascending
 * key version. Deterministic ordering keeps the payload bytes — and therefore the CID — a function
 * of the recipient *set* rather than of the order a caller happened to pass them in.
 *
 * @param {RecipientEntry[]} recipients Entries to sort.
 * @returns {RecipientEntry[]} A new, sorted array.
 */
export function sortRecipients(recipients) {
  return [...recipients].sort((a, b) =>
    a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : a.keyVersion - b.keyVersion,
  );
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Constant-time equality for two byte arrays of any length.
 *
 * `crypto.timingSafeEqual` throws on a length mismatch, which would itself leak the length, so the
 * lengths are compared first and unequal inputs fall through to a fixed-cost comparison.
 *
 * @param {Uint8Array} a First value.
 * @param {Uint8Array} b Second value.
 * @returns {boolean} Whether the two are equal.
 */
export function timingSafeEqualBytes(a, b) {
  if (a.length !== b.length) {
    timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * @param {string} hex 0x-prefixed hex.
 * @returns {Uint8Array} Bytes.
 */
function hexToBytes(hex) {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0) {
    throw new ProtocolError('INVALID_HEX', `Not an even-length hex string: ${hex}`);
  }
  return Uint8Array.from(Buffer.from(body, 'hex'));
}

/**
 * @param {Uint8Array} cek Candidate key.
 * @returns {void}
 */
function assertCek(cek) {
  if (!(cek instanceof Uint8Array) || cek.length !== CEK_BYTES) {
    throw new KeyError('INVALID_CEK', `CEK must be ${CEK_BYTES} bytes.`);
  }
}

/**
 * @param {Uint8Array} aad Candidate AAD.
 * @returns {void}
 */
function assertAad(aad) {
  if (!(aad instanceof Uint8Array) || aad.length === 0) {
    throw new ProtocolError(
      'AAD_REQUIRED',
      'AAD is mandatory. Sealing without one reintroduces the v1 cut-and-paste defect.',
    );
  }
}
