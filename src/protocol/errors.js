/**
 * NeuroMesh Protocol — typed errors.
 *
 * Callers branch on `error.code`, never on `error.message`. Message text is for humans and may be
 * reworded at any time; the code is part of this module's contract. HTTP layers map codes to status
 * values, and the crypto layer deliberately keeps two failure modes distinguishable to an *operator*
 * while an external caller sees a single generic failure:
 *
 *   NO_ENVELOPE_FOR_RECIPIENT — this key material was never wrapped for you.
 *   TAG_VERIFY_FAILED         — the ciphertext is not bound to the AAD you supplied.
 *
 * @module src/protocol/errors
 */

/**
 * Base class for every protocol failure.
 *
 * @property {string} code Stable, machine-readable failure kind.
 * @property {Record<string, unknown>} details Structured, non-secret context.
 */
export class ProtocolError extends Error {
  /**
   * @param {string} code Stable failure kind, SCREAMING_SNAKE_CASE.
   * @param {string} message Human-readable explanation.
   * @param {Record<string, unknown>} [details] Structured context. MUST NOT contain key material.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** A value could not be canonicalised (JCS) — non-integer number, cycle, forbidden type, etc. */
export class CanonicalizationError extends ProtocolError {
  /**
   * @param {string} message Human-readable explanation.
   * @param {Record<string, unknown>} [details] Structured context.
   */
  constructor(message, details) {
    super('CANONICALIZATION_FAILED', message, details);
  }
}

/** Canonical bytes exceeded {@link module:src/protocol/constants.MAX_PAYLOAD_BYTES}. */
export class PayloadTooLargeError extends ProtocolError {
  /**
   * @param {number} size Actual byte length.
   * @param {number} max Permitted byte length.
   */
  constructor(size, max) {
    super('PAYLOAD_TOO_LARGE', `Canonical payload is ${size} bytes; the limit is ${max}.`, {
      size,
      max,
    });
  }
}

/** A locally computed CID disagreed with one supplied by a third party (a pinning service). */
export class CidMismatchError extends ProtocolError {
  /**
   * @param {string} expected Locally computed CID.
   * @param {string} actual CID reported by the remote party.
   */
  constructor(expected, actual) {
    super('CID_MISMATCH', `CID mismatch: computed ${expected}, received ${actual}.`, {
      expected,
      actual,
    });
  }
}

/** A payload failed schema validation. Carries the zod issue list. */
export class SchemaValidationError extends ProtocolError {
  /**
   * @param {string} message Human-readable explanation.
   * @param {unknown[]} issues zod `error.issues`.
   */
  constructor(message, issues) {
    super('SCHEMA_INVALID', message, { issues });
  }
}

/** AEAD open failed, or a caller-supplied component of the AAD did not match. */
export class DecryptionError extends ProtocolError {
  /**
   * @param {string} code One of TAG_VERIFY_FAILED, NO_ENVELOPE_FOR_RECIPIENT, AAD_MISMATCH.
   * @param {string} message Human-readable explanation.
   * @param {Record<string, unknown>} [details] Structured context, never key material.
   */
  constructor(code, message, details) {
    super(code, message, details);
  }
}

/** Key material was malformed, off-curve, the wrong length, or otherwise unusable. */
export class KeyError extends ProtocolError {
  /**
   * @param {string} code Stable failure kind.
   * @param {string} message Human-readable explanation.
   * @param {Record<string, unknown>} [details] Structured context, never key material.
   */
  constructor(code, message, details) {
    super(code, message, details);
  }
}

/** An EIP-712 signature did not recover to the expected signer, or is non-canonical. */
export class SignatureError extends ProtocolError {
  /**
   * @param {string} message Human-readable explanation.
   * @param {Record<string, unknown>} [details] Structured context.
   */
  constructor(message, details) {
    super('SIGNATURE_INVALID', message, details);
  }
}

/** An EIP-712 authorisation is past its `deadline`. */
export class DeadlineExpiredError extends ProtocolError {
  /**
   * @param {number|bigint} deadline The signed deadline (unix seconds).
   * @param {number|bigint} now Current time (unix seconds).
   */
  constructor(deadline, now) {
    super('DEADLINE_EXPIRED', `Authorisation expired at ${deadline}; now is ${now}.`, {
      deadline: String(deadline),
      now: String(now),
    });
  }
}

/** Two vectors, or a vector and a projection, disagreed about dimensionality. */
export class DimensionMismatchError extends ProtocolError {
  /**
   * @param {string} message Human-readable explanation.
   * @param {Record<string, unknown>} [details] Structured context.
   */
  constructor(message, details) {
    super('DIMENSION_MISMATCH', message, details);
  }
}

/** A v1 API that is unsafe by construction was called. Never downgrade this to a warning. */
export class RemovedApiError extends ProtocolError {
  /**
   * @param {string} code REMOVED_UNSAFE_API or REMOVED_UNSOUND_API.
   * @param {string} message Human-readable explanation naming the replacement.
   */
  constructor(code, message) {
    super(code, message);
  }
}
