/**
 * The HTTP error taxonomy: one class hierarchy, one status/code mapping table, and one normalizer
 * that turns anything thrown anywhere in the process into a response the client can branch on.
 *
 * ## Why a taxonomy at all
 *
 * The v1 server had no error middleware. A failure anywhere in `POST /api/memory` fell through to
 * Express's default handler and produced an HTML page with a stack trace, which the browser then
 * failed to `JSON.parse`, so the frontend reported a `SyntaxError` instead of the actual problem.
 * Every error in this process now ends up as
 * `{ error: { code, message, details }, requestId }` with a stable machine-readable `code`.
 *
 * ## The contract
 *
 * - `code` is stable and machine-readable. Clients branch on it. Never reword a code.
 * - `message` is for humans and may change at any time.
 * - `details` is structured, non-secret context. It never contains a received *value*, because a
 *   value may be a secret or a 256 KB blob.
 * - `retriable` says whether repeating the identical request could plausibly succeed. It is what
 *   the frontend's retry policy reads, and it is why 503 and 504 differ from 400.
 * - `expose` decides whether `message`/`details` reach the client. 5xx defaults to not exposed.
 *
 * @module src/errors
 */

/**
 * @typedef {object} AppErrorOptions
 * @property {number} [status] HTTP status.
 * @property {string} [code] Stable machine-readable code.
 * @property {unknown} [details] Structured, non-secret context.
 * @property {boolean} [expose] Whether message/details may reach the client.
 * @property {unknown} [cause] Underlying error.
 * @property {boolean} [retriable] Whether an identical retry could succeed.
 * @property {Record<string, string>|null} [headers] Response headers this error requires.
 */

/**
 * Base class for every error this application deliberately produces.
 *
 * Anything that is *not* an `AppError` by the time it reaches the error handler is a bug, and is
 * reported as an opaque 500 with the real cause logged but never sent.
 */
export class AppError extends Error {
  /**
   * @param {string} message Human-readable explanation.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    const status = options.status ?? 500;
    this.name = new.target.name;
    /** @type {number} HTTP status code. */
    this.status = status;
    /** @type {string} Stable machine-readable code. */
    this.code = options.code ?? 'internal_error';
    /** @type {unknown} Structured, non-secret context. */
    this.details = options.details ?? null;
    /** @type {boolean} Whether message and details may be sent to the client. */
    this.expose = options.expose ?? status < 500;
    /** @type {boolean} Whether an identical retry could plausibly succeed. */
    this.retriable = options.retriable ?? (status === 429 || status === 503 || status === 504);
    /** @type {Record<string, string>|null} Headers this error requires on the response. */
    this.headers = options.headers ?? null;
    Error.captureStackTrace?.(this, new.target);
  }

  /**
   * The client-visible body fragment. `expose` is applied by the error handler, not here, so that
   * a caller which deliberately wants the full shape (a log line, a test) can still get it.
   *
   * @returns {{code: string, message: string, details: unknown}} Error envelope contents.
   */
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** 400 — the request was malformed or failed schema validation. */
export class ValidationError extends AppError {
  /**
   * @param {string} [message] Human-readable explanation.
   * @param {unknown} [details] Field-level issues.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(message = 'The request failed validation.', details = null, options = {}) {
    super(message, {
      status: 400,
      code: 'validation_error',
      details,
      retriable: false,
      ...options,
    });
  }
}

/** 401 — no credential, or a credential that did not verify. */
export class UnauthorizedError extends AppError {
  /**
   * @param {string} [message] Human-readable explanation.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(message = 'A valid API key is required for this action.', options = {}) {
    super(message, {
      status: 401,
      code: 'api_key_required',
      retriable: false,
      headers: { 'WWW-Authenticate': 'Bearer' },
      ...options,
    });
  }
}

/** 403 — authenticated, but not permitted. */
export class ForbiddenError extends AppError {
  /**
   * @param {string} [message] Human-readable explanation.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(message = 'This action is not permitted.', options = {}) {
    super(message, { status: 403, code: 'forbidden', retriable: false, ...options });
  }
}

/** 404 — no such route, or no such resource. */
export class NotFoundError extends AppError {
  /**
   * @param {string} [message] Human-readable explanation.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(message = 'Not found.', options = {}) {
    super(message, { status: 404, code: 'not_found', retriable: false, ...options });
  }
}

/** 409 — the request conflicts with current state (nonce race, idempotency key reuse). */
export class ConflictError extends AppError {
  /**
   * @param {string} [message] Human-readable explanation.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(message = 'The request conflicts with the current state.', options = {}) {
    super(message, { status: 409, code: 'conflict', retriable: false, ...options });
  }
}

/** 429 — a rate limit bucket is empty. Always carries `Retry-After`. */
export class RateLimitError extends AppError {
  /**
   * @param {number} [retryAfterSeconds] Seconds until the bucket refills.
   * @param {string} [message] Human-readable explanation.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(retryAfterSeconds = 60, message = 'Too many requests.', options = {}) {
    super(message, {
      status: 429,
      code: 'rate_limited',
      details: { retryAfterSeconds },
      retriable: true,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
      ...options,
    });
  }
}

/** 502 — a dependency answered, but with something this node cannot accept. */
export class UpstreamError extends AppError {
  /**
   * @param {string} [message] Human-readable explanation.
   * @param {unknown} [details] Structured, non-secret context.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(message = 'An upstream service failed.', details = null, options = {}) {
    super(message, {
      status: 502,
      code: 'upstream_error',
      details,
      expose: true,
      retriable: true,
      ...options,
    });
  }
}

/** 503 — a dependency is down, or this node is not ready to serve the request. */
export class ServiceUnavailableError extends AppError {
  /**
   * @param {string} [message] Human-readable explanation.
   * @param {unknown} [details] Structured, non-secret context.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(message = 'The service is temporarily unavailable.', details = null, options = {}) {
    super(message, {
      status: 503,
      code: 'service_unavailable',
      details,
      expose: true,
      retriable: true,
      ...options,
    });
  }
}

/** 504 — a dependency did not answer inside its budget. */
export class TimeoutError extends AppError {
  /**
   * @param {string} [message] Human-readable explanation.
   * @param {unknown} [details] Structured, non-secret context.
   * @param {AppErrorOptions} [options] Overrides.
   */
  constructor(message = 'An upstream service timed out.', details = null, options = {}) {
    super(message, {
      status: 504,
      code: 'upstream_timeout',
      details,
      expose: true,
      retriable: true,
      ...options,
    });
  }
}

/**
 * A configuration problem detected at boot.
 *
 * Deliberately an `AppError` so that if one ever escapes into a request path it still renders as a
 * correct 503 rather than an HTML stack trace, but its real job is to be thrown before the port is
 * bound. `details.issues` is a list of `{path, message}` with no values in it.
 */
export class ConfigError extends AppError {
  /**
   * @param {string} message Human-readable explanation.
   * @param {unknown} [details] Structured, non-secret context (never a value from the environment).
   * @param {string} [code] Stable machine-readable code.
   */
  constructor(message, details = null, code = 'invalid_configuration') {
    super(message, { status: 503, code, details, expose: false, retriable: false });
  }
}

/* -------------------------------------------------------------------------- */
/* Named factories                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Factories that fix status and code together, so no call site has to remember the pairing.
 *
 * These exist alongside the classes rather than instead of them: `instanceof ValidationError` is
 * how tests and middleware branch, while `errors.notReady(...)` is how a route raises one of the
 * many distinct 503s without inventing a code.
 */
export const errors = Object.freeze({
  /**
   * @param {string} [message] Explanation.
   * @param {unknown} [details] Context.
   * @returns {ValidationError} 400 bad_request.
   */
  badRequest: (message = 'Bad request.', details = null) =>
    new ValidationError(message, details, { code: 'bad_request' }),

  /**
   * @param {ReadonlyArray<{path: string, code?: string, message: string}>} issues Field issues.
   * @param {string} [message] Explanation.
   * @returns {ValidationError} 400 validation_error.
   */
  validation: (issues, message = 'The request failed validation.') =>
    new ValidationError(message, issues),

  /**
   * @param {string} [message] Explanation.
   * @returns {UnauthorizedError} 401 api_key_required.
   */
  unauthorized: (message) => new UnauthorizedError(message),

  /**
   * @param {string} [message] Explanation.
   * @returns {ForbiddenError} 403 forbidden.
   */
  forbidden: (message) => new ForbiddenError(message),

  /**
   * @param {string} [message] Explanation.
   * @param {unknown} [details] Context.
   * @returns {NotFoundError} 404 not_found.
   */
  notFound: (message, details = null) => new NotFoundError(message, { details }),

  /**
   * @param {string} cid Content identifier that was requested.
   * @returns {NotFoundError} 404 memory_not_found.
   */
  memoryNotFound: (cid) =>
    new NotFoundError(`No memory is known for CID ${cid}.`, {
      code: 'memory_not_found',
      details: { cid },
    }),

  /**
   * @param {string} id Job identifier.
   * @returns {NotFoundError} 404 job_not_found.
   */
  jobNotFound: (id) =>
    new NotFoundError(`No job with id ${id}.`, { code: 'job_not_found', details: { id } }),

  /**
   * @returns {NotFoundError} 404 simulation_missing.
   */
  simulationMissing: () =>
    new NotFoundError('No simulation results have been produced on this node yet.', {
      code: 'simulation_missing',
    }),

  /**
   * @param {string} [message] Explanation.
   * @param {unknown} [details] Context.
   * @returns {ConflictError} 409 conflict.
   */
  conflict: (message, details = null) => new ConflictError(message, { details }),

  /**
   * @param {string} key The reused key.
   * @returns {ConflictError} 409 idempotency_conflict.
   */
  idempotencyConflict: (key) =>
    new ConflictError('This Idempotency-Key was already used with a different request body.', {
      code: 'idempotency_conflict',
      details: { key },
    }),

  /**
   * @param {number} [limitBytes] Configured limit.
   * @param {number} [actualBytes] Reported Content-Length.
   * @returns {AppError} 413 payload_too_large.
   */
  payloadTooLarge: (limitBytes, actualBytes) =>
    new AppError(
      limitBytes && actualBytes
        ? `Request body is ${actualBytes} bytes; the limit is ${limitBytes} bytes.`
        : 'Request body is too large.',
      {
        status: 413,
        code: 'payload_too_large',
        details: { limitBytes: limitBytes ?? null, actualBytes: actualBytes ?? null },
        retriable: false,
      },
    ),

  /**
   * @param {string} [received] The Content-Type that was sent.
   * @returns {AppError} 415 unsupported_media_type.
   */
  unsupportedMediaType: (received) =>
    new AppError('This endpoint accepts application/json only.', {
      status: 415,
      code: 'unsupported_media_type',
      details: { received: received ?? null },
      retriable: false,
    }),

  /**
   * @param {number} [retryAfterSeconds] Seconds until the bucket refills.
   * @returns {RateLimitError} 429 rate_limited.
   */
  rateLimited: (retryAfterSeconds) => new RateLimitError(retryAfterSeconds),

  /**
   * @param {unknown} checks Readiness check results.
   * @returns {ServiceUnavailableError} 503 not_ready.
   */
  notReady: (checks) =>
    new ServiceUnavailableError('This node is not ready to serve requests yet.', checks, {
      code: 'not_ready',
    }),

  /**
   * @returns {ServiceUnavailableError} 503 model_not_ready.
   */
  modelNotReady: () =>
    new ServiceUnavailableError('The embedding model is still loading.', null, {
      code: 'model_not_ready',
    }),

  /**
   * @param {unknown} [detail] Context.
   * @returns {ServiceUnavailableError} 503 chain_unavailable.
   */
  chainUnavailable: (detail = null) =>
    new ServiceUnavailableError('The blockchain RPC endpoint is unavailable.', detail, {
      code: 'chain_unavailable',
    }),

  /**
   * @param {unknown} [detail] Context.
   * @returns {ServiceUnavailableError} 503 contracts_incompatible.
   */
  contractsIncompatible: (detail = null) =>
    new ServiceUnavailableError(
      'The contracts at the configured addresses do not match this build. The node is serving ' +
        'read-only routes only.',
      detail,
      { code: 'contracts_incompatible' },
    ),

  /**
   * @param {unknown} [detail] Context.
   * @returns {ServiceUnavailableError} 503 ipfs_unavailable.
   */
  ipfsUnavailable: (detail = null) =>
    new ServiceUnavailableError('The IPFS pinning service is unavailable.', detail, {
      code: 'ipfs_unavailable',
    }),

  /**
   * @returns {ServiceUnavailableError} 503 read_only.
   */
  readOnly: () =>
    new ServiceUnavailableError(
      'This node has no signer configured and cannot perform write actions.',
      null,
      { code: 'read_only', retriable: false },
    ),

  /**
   * @param {Record<string, string|number|null>} [amounts] Balance, requirement and shortfall, as
   *   decimal strings, plus whatever else names the wallet that came up short.
   * @returns {ServiceUnavailableError} 503 insufficient_funds.
   */
  insufficientFunds: (amounts = {}) =>
    new ServiceUnavailableError(
      'The node wallet does not hold enough ETH to pay for this transaction.',
      amounts,
      { code: 'insufficient_funds' },
    ),

  /**
   * The message is fixed on purpose: "which queue is full and how deep is it" is operator
   * information, and it belongs in `details` and the log rather than in a client-visible sentence
   * that leaks the node's capacity to anyone probing it.
   *
   * @param {unknown} [details] Non-secret context, e.g. which queue shed the work.
   * @returns {ServiceUnavailableError} 503 overloaded.
   */
  overloaded: (details = null) =>
    new ServiceUnavailableError('This node is shedding load; try again shortly.', details, {
      code: 'overloaded',
    }),

  /**
   * @param {string} [message] Explanation.
   * @param {unknown} [details] Context.
   * @returns {UpstreamError} 502 upstream_error.
   */
  upstream: (message, details = null) => new UpstreamError(message, details),

  /**
   * @param {string} [message] Explanation.
   * @param {unknown} [details] Context.
   * @returns {TimeoutError} 504 upstream_timeout.
   */
  upstreamTimeout: (message, details = null) => new TimeoutError(message, details),

  /**
   * @param {unknown} [cause] The real error, logged but never sent.
   * @returns {AppError} 500 internal_error, never exposed.
   */
  internal: (cause) =>
    new AppError('An internal error occurred.', {
      status: 500,
      code: 'internal_error',
      expose: false,
      cause,
      retriable: false,
    }),
});

/* -------------------------------------------------------------------------- */
/* Protocol error mapping                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Exhaustive map from every `ProtocolError.code` in `src/protocol/errors.js` to an HTTP outcome.
 *
 * `test/backend/infra/errors.test.js` scans the protocol sources for constructed codes and fails if
 * any of them is missing here, so a new protocol error cannot silently become an opaque 500.
 *
 * Two entries carry security decisions worth stating out loud:
 *
 * - `TAG_VERIFY_FAILED` is a 403 whose message deliberately does not distinguish "wrong key" from
 *   "tampered ciphertext". The distinction is available to an operator in the logs and to nobody
 *   else; collapsing it in the response is what stops the endpoint being an ownership oracle.
 * - `CID_MISMATCH` is a 502, not a 400. The pinning service returned bytes that do not hash to the
 *   CID it reported. That is an upstream fault, never the caller's.
 *
 * @type {Readonly<Record<string, {status: number, code: string, expose: boolean}>>}
 */
export const PROTOCOL_ERROR_MAP = Object.freeze({
  // Canonicalisation and payload shape.
  CANONICALIZATION_FAILED: { status: 422, code: 'canonicalization_error', expose: true },
  SCHEMA_INVALID: { status: 400, code: 'validation_error', expose: true },
  PAYLOAD_TOO_LARGE: { status: 413, code: 'payload_too_large', expose: true },
  PROTOCOL_VERSION: { status: 409, code: 'protocol_version', expose: true },

  // Content addressing.
  CID_MISMATCH: { status: 502, code: 'cid_mismatch', expose: true },

  // Signatures and authorisation windows.
  SIGNATURE_INVALID: { status: 400, code: 'bad_signature', expose: true },
  DEADLINE_EXPIRED: { status: 400, code: 'deadline_expired', expose: true },

  // Envelope encryption.
  TAG_VERIFY_FAILED: { status: 403, code: 'decryption_failed', expose: true },
  NO_ENVELOPE_FOR_RECIPIENT: { status: 403, code: 'no_envelope_for_recipient', expose: true },
  AAD_MISMATCH: { status: 422, code: 'aad_mismatch', expose: true },
  AAD_REQUIRED: { status: 422, code: 'aad_mismatch', expose: true },
  AAD_COMPONENT_MISSING: { status: 422, code: 'aad_mismatch', expose: true },
  AAD_COMPONENT_INVALID: { status: 422, code: 'aad_mismatch', expose: true },
  CIPHER_BLOCK_MALFORMED: { status: 400, code: 'cipher_block_malformed', expose: true },
  CIPHER_ALG_UNSUPPORTED: { status: 422, code: 'cipher_alg_unsupported', expose: true },
  RECIPIENT_ENTRY_MALFORMED: { status: 400, code: 'recipient_entry_malformed', expose: true },
  WRAP_ALG_UNSUPPORTED: { status: 422, code: 'wrap_alg_unsupported', expose: true },

  // Key material. Never exposed with detail: the shape of a key error is information.
  DERIVATION_FAILED: { status: 500, code: 'key_derivation_failed', expose: false },
  KEY_SEPARATION_VIOLATED: { status: 500, code: 'key_separation_violated', expose: false },
  INVALID_CEK: { status: 400, code: 'invalid_key_material', expose: true },
  INVALID_DID: { status: 400, code: 'invalid_did', expose: true },
  INVALID_KEY_VERSION: { status: 400, code: 'invalid_key_version', expose: true },
  INVALID_PRIVATE_KEY: { status: 500, code: 'invalid_key_material', expose: false },
  INVALID_PUBLIC_KEY: { status: 400, code: 'invalid_key_material', expose: true },
  INVALID_HEX: { status: 400, code: 'validation_error', expose: true },

  // Vectors and ranking.
  DIMENSION_MISMATCH: { status: 422, code: 'embedding_mismatch', expose: true },
  INVALID_SIMILARITY: { status: 422, code: 'embedding_mismatch', expose: true },
  INVALID_SIMHASH_BITS: { status: 422, code: 'embedding_mismatch', expose: true },
  INVALID_REPUTATION: { status: 422, code: 'invalid_reputation', expose: true },

  // Removed v1 APIs. 410 rather than 404 because the caller is code, not an attacker probing.
  REMOVED_UNSAFE_API: { status: 410, code: 'endpoint_removed', expose: true },
  REMOVED_UNSOUND_API: { status: 410, code: 'endpoint_removed', expose: true },
});

/**
 * ethers v6 `error.code` values that carry a specific HTTP meaning.
 *
 * @type {Readonly<Record<string, {status: number, code: string, expose: boolean}>>}
 */
const ETHERS_ERROR_MAP = Object.freeze({
  INSUFFICIENT_FUNDS: { status: 503, code: 'insufficient_funds', expose: true },
  CALL_EXCEPTION: { status: 502, code: 'contract_call_reverted', expose: true },
  NETWORK_ERROR: { status: 503, code: 'chain_unavailable', expose: true },
  SERVER_ERROR: { status: 503, code: 'chain_unavailable', expose: true },
  TIMEOUT: { status: 504, code: 'upstream_timeout', expose: true },
  NONCE_EXPIRED: { status: 409, code: 'nonce_conflict', expose: true },
  REPLACEMENT_UNDERPRICED: { status: 409, code: 'nonce_conflict', expose: true },
  TRANSACTION_REPLACED: { status: 409, code: 'nonce_conflict', expose: true },
  ACTION_REJECTED: { status: 400, code: 'bad_request', expose: true },
  UNCONFIGURED_NAME: { status: 400, code: 'bad_request', expose: true },
  UNSUPPORTED_OPERATION: { status: 500, code: 'internal_error', expose: false },
});

/**
 * body-parser `error.type` values.
 *
 * @type {Readonly<Record<string, {status: number, code: string}>>}
 */
const BODY_PARSER_MAP = Object.freeze({
  'entity.too.large': { status: 413, code: 'payload_too_large' },
  'entity.parse.failed': { status: 400, code: 'malformed_json' },
  'entity.verify.failed': { status: 400, code: 'malformed_json' },
  'encoding.unsupported': { status: 415, code: 'unsupported_media_type' },
  'request.aborted': { status: 400, code: 'request_aborted' },
  'parameters.too.many': { status: 413, code: 'payload_too_large' },
  'charset.unsupported': { status: 415, code: 'unsupported_media_type' },
});

/**
 * Map a zod issue to the flat field-error shape the API publishes.
 *
 * The received value is deliberately absent: it may be a secret, and it may be enormous.
 *
 * @param {{path?: ReadonlyArray<string|number|symbol>, code?: string, message?: string}} issue
 *   A zod issue.
 * @returns {{path: string, code: string, message: string}} Field error.
 */
export function toFieldError(issue) {
  const path = Array.isArray(issue.path) ? issue.path.map(String).join('.') : '';
  return {
    path,
    code: issue.code ?? 'invalid',
    message: issue.message ?? 'Invalid value.',
  };
}

/**
 * Does this look like a zod error? Checked structurally rather than with `instanceof`, so a zod
 * instance that arrived from a differently-resolved copy of the package still maps correctly.
 *
 * @param {any} err Candidate.
 * @returns {boolean} True when it carries a zod-shaped `issues` array.
 */
function isZodError(err) {
  return Boolean(err) && err.name === 'ZodError' && Array.isArray(err.issues);
}

/**
 * Does this look like a `ProtocolError`? Structural for the same reason.
 *
 * @param {any} err Candidate.
 * @returns {boolean} True when it carries a protocol-style code.
 */
function isProtocolError(err) {
  return (
    Boolean(err) &&
    typeof err.code === 'string' &&
    /^[A-Z][A-Z0-9_]*$/.test(err.code) &&
    err instanceof Error &&
    Object.hasOwn(err, 'details')
  );
}

/**
 * Normalize anything thrown into an {@link AppError}.
 *
 * This is the single funnel the error middleware uses. Everything it does not recognise becomes an
 * opaque `internal_error` with the original attached as `cause`, so the real reason is logged and
 * never sent.
 *
 * @param {unknown} err Anything that was thrown or rejected.
 * @returns {AppError} A normalized error.
 */
export function toApiError(err) {
  if (err instanceof AppError) return err;

  /** @type {any} */
  const any = err;

  if (isZodError(any)) {
    return errors.validation(any.issues.map(toFieldError));
  }

  if (any && typeof any.type === 'string' && BODY_PARSER_MAP[any.type]) {
    const mapped = BODY_PARSER_MAP[any.type];
    if (mapped.code === 'payload_too_large') {
      return errors.payloadTooLarge(any.limit, any.length);
    }
    return new AppError(
      mapped.code === 'malformed_json'
        ? 'The request body is not valid JSON.'
        : (any.message ?? 'Bad request.'),
      { status: mapped.status, code: mapped.code, retriable: false },
    );
  }

  if (isProtocolError(any) && PROTOCOL_ERROR_MAP[any.code]) {
    const mapped = PROTOCOL_ERROR_MAP[any.code];
    return new AppError(any.message, {
      status: mapped.status,
      code: mapped.code,
      details: mapped.expose ? (any.details ?? null) : null,
      expose: mapped.expose,
      cause: any,
      retriable: mapped.status >= 500,
    });
  }

  if (any && typeof any.code === 'string' && ETHERS_ERROR_MAP[any.code]) {
    const mapped = ETHERS_ERROR_MAP[any.code];
    /** @type {Record<string, unknown>|null} */
    let details = null;
    if (any.code === 'CALL_EXCEPTION') {
      details = { reason: any.reason ?? null, method: any.method ?? null };
    } else if (any.code === 'INSUFFICIENT_FUNDS') {
      return errors.insufficientFunds({});
    }
    return new AppError(mapped.expose ? any.shortMessage || any.message : 'An error occurred.', {
      status: mapped.status,
      code: mapped.code,
      details,
      expose: mapped.expose,
      cause: any,
    });
  }

  if (any && (any.name === 'AbortError' || any.name === 'TimeoutError')) {
    return errors.upstreamTimeout('The operation did not complete within its time budget.');
  }

  return errors.internal(err);
}

/** Back-compat alias. The spec and several call sites name the base class `ApiError`. */
export { AppError as ApiError };
