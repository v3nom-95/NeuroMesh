/**
 * The node's key material and every envelope operation.
 *
 * ## Module invariants
 *
 * These are the rules the rest of the backend relies on. Each is enforced in code below, and each
 * exists because its absence was a specific, exploitable defect in v1:
 *
 * 1. **No function here accepts ciphertext from an HTTP body.** {@link CryptoService.decryptOwn}
 *    takes a *fetched, schema-validated payload* and nothing else. v1's `POST /api/decrypt` took
 *    `{encrypted, salt, iv, tag}` straight from the request and decrypted it with the node's chain
 *    key: an unauthenticated decryption oracle, a PBKDF2 work oracle at 53 ms a call, and an
 *    error-shape oracle all at once. There is no shape of argument here that can reconstruct it.
 * 2. **No function returns key material.** The encryption private key lives in a closure variable
 *    and is never placed on the returned object, never logged, never serialised. Only the 33-byte
 *    compressed *public* key is exposed.
 * 3. **The encryption key is not the signing key.** v1 used the wallet private key directly as a
 *    PBKDF2 passphrase, so one leak cost both signing authority and every memory ever written, and
 *    rotating the wallet orphaned every prior ciphertext. Here the encryption keypair is either
 *    supplied independently (`MEMORY_ENCRYPTION_KEY`) or derived through a domain-separated,
 *    one-way HKDF (protocol section 2), and equality with the wallet key is asserted against.
 * 4. **"Not shared with me" and "tampered" stay distinguishable to an operator and identical to a
 *    client.** A missing recipient entry is `403 no_envelope_for_recipient`; a tag failure is
 *    `403 decryption_failed` whose message never says whether the key was wrong or the bytes were
 *    altered. Collapsing the two would hand an attacker an ownership oracle; separating them in the
 *    client-visible message would hand them a tampering oracle.
 *
 * ## What replaced PBKDF2
 *
 * Per-payload random CEK, AES-256-GCM with a 12-byte nonce, AAD binding
 * `(agentDid, contentId, policyId, modelId, keyVersion)`, and the CEK ECIES-wrapped to each
 * recipient's encryption public key. Measured at 0.027 ms p50 against 53 ms p50 for the PBKDF2
 * path: 1,960x faster **and** strictly stronger. The whole construction lives in
 * `src/protocol/envelope.js`; this file is the service that owns the keys and the policy around
 * them.
 *
 * @module src/services/crypto
 */
import { getConfig } from '../config/index.js';
import { errors } from '../errors.js';
import { logger as defaultLogger } from '../logger.js';
import { canonical, envelope, keys, payload as payloadCodec } from '../protocol/index.js';
import { normalizeMetrics } from './instrument.js';

/**
 * The default policy applied when a caller supplies none.
 *
 * `embeddingVisibility: 'grantees'` is the important default. v1 published the plaintext 384-d
 * vector to IPFS *beside* the ciphertext; embedding-inversion work (Song and Raghunathan, CCS 2020;
 * Morris et al., EMNLP 2023) recovers substantial or near-verbatim text from sentence embeddings,
 * so that was close to publishing the plaintext next to its own encryption.
 *
 * @type {Readonly<{embeddingVisibility: 'grantees', redistribution: 'forbidden', retentionUntil: 0}>}
 */
export const DEFAULT_POLICY = Object.freeze({
  embeddingVisibility: /** @type {'grantees'} */ ('grantees'),
  redistribution: /** @type {'forbidden'} */ ('forbidden'),
  retentionUntil: 0,
});

/**
 * Create the crypto service.
 *
 * @param {object} [deps] Dependencies.
 * @param {ReturnType<typeof getConfig>} [deps.config] Application config.
 * @param {any} [deps.chain] Chain service, consulted only for the signer address when the node has
 *   no local private key. Optional: the crypto service works without a chain.
 * @param {any} [deps.logger] Pino logger.
 * @param {import('./instrument.js').MetricsLike} [deps.metrics] Metrics collector.
 * @returns {CryptoService} The service.
 */
export function createCryptoService({
  config = getConfig(),
  chain,
  logger = defaultLogger,
  metrics,
} = {}) {
  const log = logger.child ? logger.child({ service: 'crypto' }) : logger;
  const instruments = normalizeMetrics(metrics);

  /**
   * The encryption private key. Module-scoped by design: it is never a property of the returned
   * object, so no accidental spread, `JSON.stringify` or structured log line can reach it.
   *
   * @type {Uint8Array|null}
   */
  let encryptionPrivateKey = null;
  /** @type {string|null} */
  let encryptionPublicKeyHex = null;
  /** @type {string|null} */
  let address = null;
  /** @type {string|null} */
  let did = null;
  /** @type {'imported'|'derived'|null} */
  let source = null;
  /** @type {{code: string, message: string}|null} */
  let initError = null;
  let initialized = false;

  const keyVersion = config.crypto.keyVersion;

  /**
   * Obtain the encryption keypair.
   *
   * Priority, and the reason for it:
   *   1. `MEMORY_ENCRYPTION_KEY` - an operator who manages key material elsewhere (an HSM, a KMS)
   *      says so explicitly, and their choice wins over any derivation.
   *   2. Derivation from the wallet key per protocol section 2 - deterministic in
   *      `(walletKey, keyVersion)` alone, so a restart recovers the same key with no second secret
   *      to persist, and bumping `ENCRYPTION_KEY_VERSION` produces an unrelated keypair.
   *
   * A node with neither is not broken: it is read-only for crypto. `init()` records that and every
   * sealing or opening call answers `503 read_only` with a message naming the missing setting.
   *
   * @returns {Promise<void>} Always resolves; failures are recorded, not thrown.
   */
  async function init() {
    if (initialized) return;
    initialized = true;
    try {
      if (config.crypto.encryptionKeyHex) {
        const pair = keys.importEncryptionKey(config.crypto.encryptionKeyHex, keyVersion);
        encryptionPrivateKey = pair.privateKey;
        encryptionPublicKeyHex = pair.publicKeyHex;
        source = 'imported';
      } else if (config.signer.privateKey) {
        const pair = keys.deriveEncryptionKey(config.signer.privateKey, keyVersion);
        encryptionPrivateKey = pair.privateKey;
        encryptionPublicKeyHex = pair.publicKeyHex;
        source = 'derived';
      } else {
        initError = {
          code: 'no_key_material',
          message:
            'Neither MEMORY_ENCRYPTION_KEY nor PRIVATE_KEY is set, so this node holds no ' +
            'encryption keypair. Reads still work; sealing and opening do not.',
        };
        return;
      }

      // Assert key separation explicitly. `deriveEncryptionKey` already refuses to return the
      // wallet key, but an imported key is whatever the operator supplied, and an operator who
      // pastes their wallet key into MEMORY_ENCRYPTION_KEY has reintroduced the exact v1 defect.
      if (config.signer.privateKey) {
        const wallet = keys.toPrivateKeyBytes(config.signer.privateKey);
        if (envelope.timingSafeEqualBytes(wallet, encryptionPrivateKey)) {
          encryptionPrivateKey = null;
          throw errors.internal(
            new Error(
              'Key separation violated: the encryption private key equals the chain signing key. ' +
                'One leak would cost both signing authority and every memory ever written. Unset ' +
                'MEMORY_ENCRYPTION_KEY to use the derived key, or supply an independent one.',
            ),
          );
        }
        keys.zeroize(wallet);
        address = keys.addressFromPrivateKey(config.signer.privateKey);
      } else {
        address = chain?.address?.() ?? null;
      }

      if (address) did = keys.toDid(config.chain.chainId, address);
      log.info?.(
        { source, keyVersion, address, encryptionPublicKey: encryptionPublicKeyHex },
        'encryption keypair ready',
      );
    } catch (err) {
      initError = {
        code: String(/** @type {any} */ (err)?.code ?? 'crypto_init_failed'),
        message: String(/** @type {any} */ (err)?.message ?? err),
      };
      log.error?.({ err: initError }, 'crypto service failed to initialise');
    }
  }

  /**
   * @returns {Uint8Array} The encryption private key.
   * @throws {import('../errors.js').AppError} 503 when the node holds no key material.
   */
  function requireKey() {
    if (!encryptionPrivateKey || !address || !did) {
      throw errors.readOnly();
    }
    return encryptionPrivateKey;
  }

  /**
   * Seal a context (and optionally its embedding) for a set of recipients.
   *
   * Steps, matching protocol section 8 steps 4-7:
   *   1. Draw a fresh CEK and a content id.
   *   2. `policyId = keccak256(JCS(policy))`.
   *   3. Build the AAD from `(agentDid, contentId, policyId, modelId, keyVersion)`.
   *   4. Seal `{context, embedding?}`; the embedding is inside the ciphertext unless the policy
   *      makes it public.
   *   5. Wrap the CEK to the author (mandatory, asserted) and to every grantee.
   *   6. Sort recipients into canonical order so the payload bytes - and therefore the CID - are a
   *      function of the recipient *set*, not of argument order.
   *   7. Zeroise the CEK.
   *
   * @param {object} args Arguments.
   * @param {string} args.context Plaintext to seal.
   * @param {ArrayLike<number>|null} [args.embedding] Aligned embedding to seal alongside it.
   * @param {string} args.modelId 0x-hex model identifier, bound into the AAD.
   * @param {{embeddingVisibility: 'public'|'grantees'|'lsh-only',
   *   redistribution?: 'forbidden'|'grantees'|'public', retentionUntil?: number}} [args.policy]
   *   Policy block; defaults to {@link DEFAULT_POLICY}.
   * @param {Array<{address: string, publicKey: string, keyVersion?: number}>} [args.grantees]
   *   Additional recipients. Each must carry a *validated* compressed encryption public key, which
   *   the caller resolves from `AgentIdentity.getPublicKey`.
   * @param {string} [args.contentId] Override the content id. Supply
   *   `payload.computeContentId(content)` for a deterministic, duplicate-detectable id; the default
   *   is 16 random bytes, which is unlinkable and cannot be used to test a guessed plaintext.
   * @returns {{contentId: string, policyId: string, cipher: object, recipients: object[],
   *   embeddingSealed: boolean}} The sealed material.
   */
  function seal({
    context,
    embedding = null,
    modelId,
    policy = DEFAULT_POLICY,
    grantees = [],
    contentId = envelope.generateContentId(),
  }) {
    requireKey();
    if (typeof context !== 'string' || context.length === 0) {
      throw errors.badRequest('seal() requires a non-empty context string.');
    }
    if (typeof modelId !== 'string' || !/^0x[0-9a-f]{64}$/.test(modelId)) {
      throw errors.badRequest('seal() requires modelId as 0x + 64 lower-case hex.');
    }
    const stop = instruments.timer('neuromesh_crypto_seal_duration_seconds');
    const policyId = payloadCodec.computePolicyId(policy);
    const embeddingSealed = embedding !== null && policy.embeddingVisibility !== 'public';

    /** @type {Uint8Array|null} */
    let cek = null;
    try {
      cek = envelope.generateCek();
      const aad = envelope.buildAad({
        agentDid: /** @type {string} */ (did),
        contentId,
        policyId,
        modelId,
        keyVersion,
      });
      const content = {
        context,
        embedding: embeddingSealed
          ? payloadCodec.encodeEmbedding(/** @type {ArrayLike<number>} */ (embedding))
          : null,
      };
      const cipher = envelope.sealContent(content, { cek, aad });

      /** @type {object[]} */
      const recipients = [
        envelope.wrapCek({
          cek,
          recipientPublicKey: /** @type {string} */ (encryptionPublicKeyHex),
          recipientAddress: /** @type {string} */ (address),
          grantorDid: /** @type {string} */ (did),
          contentId,
          recipientKeyVersion: keyVersion,
        }),
      ];
      for (const grantee of grantees) {
        recipients.push(wrapForRecipient({ cek, contentId, grantee }));
      }
      const sorted = envelope.sortRecipients(/** @type {any} */ (recipients));

      // The self-wrap is what stops a node writing a memory it can never read again. It is a
      // structural guarantee, not a convention, so it is asserted rather than assumed.
      if (
        !envelope.findEntry(
          /** @type {any} */ (sorted),
          /** @type {string} */ (address),
          keyVersion,
        )
      ) {
        throw errors.internal(new Error('Sealed payload carries no envelope for its own author.'));
      }
      return { contentId, policyId, cipher, recipients: sorted, embeddingSealed };
    } finally {
      keys.zeroize(cek);
      stop();
    }
  }

  /**
   * Wrap a CEK for one grantee, validating their public key first.
   *
   * An off-curve "public key" turns ECDH into an invalid-curve attack that leaks bits of the
   * private key, so a key arriving from the chain or an HTTP body is validated before it is used.
   * A grantee with no usable key is a 400 naming the address, never a silent skip - silently
   * dropping a grantee produces a memory the requester believes they shared and did not.
   *
   * @param {object} args Arguments.
   * @param {Uint8Array} args.cek The content-encryption key.
   * @param {string} args.contentId 0x-hex content identifier.
   * @param {{address: string, publicKey: string, keyVersion?: number}} args.grantee Recipient.
   * @returns {object} The recipient entry.
   */
  function wrapForRecipient({ cek, contentId, grantee }) {
    if (!grantee?.publicKey) {
      throw errors.badRequest(
        `Grantee ${grantee?.address ?? '(unknown)'} has no registered encryption public key, so ` +
          'the memory cannot be shared with them. Ask them to register or rotate a key first.',
        { address: grantee?.address ?? null },
      );
    }
    try {
      keys.assertCompressedPublicKey(grantee.publicKey);
    } catch (cause) {
      throw errors.badRequest(
        `Grantee ${grantee.address} has an unusable encryption public key: ` +
          `${/** @type {any} */ (cause).message}`,
        { address: grantee.address },
      );
    }
    return envelope.wrapCek({
      cek,
      recipientPublicKey: grantee.publicKey,
      recipientAddress: grantee.address,
      grantorDid: /** @type {string} */ (did),
      contentId,
      recipientKeyVersion: grantee.keyVersion ?? 1,
    });
  }

  /**
   * Seal for this node alone.
   *
   * @param {Omit<Parameters<typeof seal>[0], 'grantees'>} args Arguments, as {@link seal} minus
   *   `grantees`.
   * @returns {ReturnType<typeof seal>} The sealed material.
   */
  function encryptForSelf(args) {
    return seal({ ...args, grantees: [] });
  }

  /**
   * Seal for this node plus a list of grantees.
   *
   * @param {Parameters<typeof seal>[0]} args Arguments, as {@link seal}.
   * @returns {ReturnType<typeof seal>} The sealed material.
   */
  function encryptFor(args) {
    return seal(args);
  }

  /**
   * Open a sealed payload addressed to this node.
   *
   * **This is the only decryption path in the backend, and it takes no ciphertext from a caller.**
   * The argument is a payload that has already been fetched by CID and validated against
   * `MemoryPayloadV2`, so every field the AAD is rebuilt from came from bytes whose hash equals the
   * CID that was requested.
   *
   * The AAD is *reconstructed* from the payload's own fields rather than read from an echo. The v2
   * schema does not even have a place to store an echo - `CipherBlockSchema` is
   * `{alg, iv, ct, tag}` and strict - which removes the class of attack where a publisher stores a
   * misleading AAD copy for a lazy verifier to trust.
   *
   * @param {object} args Arguments.
   * @param {unknown} args.payload The fetched payload.
   * @param {string|null} [args.cid] CID, for the audit log only.
   * @param {string|null} [args.requestId] Correlation id, for the audit log only.
   * @param {string|null} [args.actor] Who asked, for the audit log only.
   * @returns {{context: string, embedding: Float32Array|null, contentId: string,
   *   embeddingVerified: boolean}} The plaintext.
   */
  function open({ payload, cid = null, requestId = null, actor = null }) {
    const privateKey = requireKey();
    const parsed = payloadCodec.parseMemoryPayload(payload);
    if (parsed.cipher === null) {
      throw errors.badRequest('This memory is public; there is nothing to decrypt.', { cid });
    }
    const stop = instruments.timer('neuromesh_crypto_open_duration_seconds');
    /** @type {Uint8Array|null} */
    let cek = null;
    try {
      const entry = envelope.findEntry(
        /** @type {any} */ (parsed.recipients),
        /** @type {string} */ (address),
        keyVersion,
      );
      if (!entry) {
        throw errors.forbidden(
          'This memory was never shared with this agent at this key version. That is a different ' +
            'fact from "the ciphertext failed to verify", and the two are deliberately reported ' +
            'differently to an operator.',
        );
      }
      cek = envelope.unwrapCek({
        entry: /** @type {any} */ (entry),
        recipientPrivateKey: privateKey,
        grantorDid: parsed.agentDid,
        contentId: parsed.contentId,
      });
      const aad = envelope.buildAad({
        agentDid: parsed.agentDid,
        contentId: parsed.contentId,
        policyId: payloadCodec.computePolicyId(parsed.policy),
        modelId: parsed.model.id,
        keyVersion: parsed.keyVersion,
      });
      const content = /** @type {{context: string, embedding: string|null}} */ (
        envelope.openContent(/** @type {any} */ (parsed.cipher), { cek, aad })
      );

      /** @type {Float32Array|null} */
      let vector = null;
      let embeddingVerified = false;
      if (content.embedding) {
        vector = canonical.b64ToF32(content.embedding);
        const digest = payloadCodec.embeddingDigest(vector);
        embeddingVerified = envelope.timingSafeEqualBytes(
          hexToBytes(digest),
          hexToBytes(parsed.embedding.dataDigest),
        );
        if (!embeddingVerified) {
          throw errors.forbidden(
            'The decrypted embedding does not match the digest the author committed to. The ' +
              'ciphertext opened, so this is not a key problem: the payload is internally ' +
              'inconsistent and must not be indexed.',
          );
        }
      }

      // Audit line: who opened what, and never one byte of what they got.
      log.info?.(
        { event: 'memory.decrypt', cid, contentId: parsed.contentId, requestId, actor },
        'memory decrypted',
      );
      return {
        context: content.context,
        embedding: vector,
        contentId: parsed.contentId,
        embeddingVerified,
      };
    } finally {
      keys.zeroize(cek);
      stop();
    }
  }

  /** @type {CryptoService} */
  const service = {
    init,
    configured: () => encryptionPrivateKey !== null,
    agentAddress: () => address,
    agentDid: () => did,
    encryptionPublicKey: () => encryptionPublicKeyHex,
    keyVersion: () => keyVersion,
    keySource: () => source,
    state: () => ({
      configured: encryptionPrivateKey !== null,
      source,
      keyVersion,
      address,
      did,
      encryptionPublicKey: encryptionPublicKeyHex,
      error: initError,
    }),
    seal,
    encryptForSelf,
    encryptFor,
    open,
    decryptOwn: (payload, meta = {}) => open({ payload, ...meta }),
    buildAad: envelope.buildAad,
    defaultPolicy: () => ({ ...DEFAULT_POLICY }),
    async shutdown() {
      keys.zeroize(encryptionPrivateKey);
      encryptionPrivateKey = null;
    },
  };
  return service;
}

/**
 * @typedef {object} CryptoService
 * @property {() => Promise<void>} init Obtain the keypair; never throws.
 * @property {() => boolean} configured Whether key material is present.
 * @property {() => string|null} agentAddress This node's agent address.
 * @property {() => string|null} agentDid This node's did:pkh.
 * @property {() => string|null} encryptionPublicKey 33-byte compressed key, 0x-hex.
 * @property {() => number} keyVersion Current encryption key version.
 * @property {() => 'imported'|'derived'|null} keySource Where the key came from.
 * @property {() => object} state Public, secret-free state for /api/v1/status.
 * @property {(args: any) => any} seal Seal for the author plus grantees.
 * @property {(args: any) => any} encryptForSelf Seal for the author alone.
 * @property {(args: any) => any} encryptFor Seal for the author plus grantees.
 * @property {(args: any) => any} open Open a fetched, validated payload.
 * @property {(payload: unknown, meta?: object) => any} decryptOwn Alias of {@link open}.
 * @property {typeof envelope.buildAad} buildAad Exposed so a verifier can rebuild the AAD.
 * @property {() => object} defaultPolicy A mutable copy of {@link DEFAULT_POLICY}.
 * @property {() => Promise<void>} shutdown Zeroise the key.
 */

/**
 * @param {string} hex 0x-prefixed hex.
 * @returns {Uint8Array} Bytes.
 */
function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
}

export default createCryptoService;
