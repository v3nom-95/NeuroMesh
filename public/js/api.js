/**
 * NeuroMesh — the HTTP client. THE ONLY MODULE IN `public/` THAT CONTAINS A URL.
 *
 * Coordination rule (non-negotiable): every endpoint path, method and payload
 * shape is declared once, in `ENDPOINTS` at the top of this file. No other
 * module may build or hold a URL string. The backend's route list is still
 * being reworked, so reconciling the frontend with it must stay a one-file
 * change — grep for `ENDPOINTS` and you have seen the entire API surface.
 *
 * What this module fixes, from the audit of the old `app.js`:
 *   - Six `fetch` call sites, none of which checked `res.ok`. A 500 that
 *     returned an HTML error page threw `SyntaxError: Unexpected token '<'`
 *     and was reported to the user as "Did you supply testnet ETH?".
 *     Here: `res.ok` is checked, the content type is verified BEFORE parsing,
 *     and a non-JSON body becomes a typed `bad_content_type` error carrying a
 *     snippet of what actually came back.
 *   - No timeouts anywhere. A hung gateway meant a promise that never settled
 *     and a spinner that never stopped. Here: every request has its own
 *     `AbortController` deadline.
 *   - No retries, so one dropped packet during boot left the console blank.
 *     Here: idempotent GETs retry up to `RETRY.attempts` times with
 *     exponential backoff and jitter. POSTs — which spend Sepolia gas and pin
 *     to IPFS — are NEVER retried automatically.
 *   - No cancellation, so two fast tab switches raced two renders into one
 *     container. Here: every request is registered against a scope, and a view
 *     aborts its scope on unmount.
 *
 * Secret handling: the write API key is read from `settings.js` and attached
 * as the `x-api-key` HEADER. It is never appended to a URL, never written to
 * the console, and never placed in an error's `details`.
 *
 * @module api
 */

import { getApiKey } from './settings.js';

/* ==================================================================== *
 * THE ROUTE TABLE — the single source of truth for every URL
 * ==================================================================== */

/**
 * Prefix applied to every path below. Empty because the console is served by
 * the same Express process that serves the API; a reverse proxy that mounts
 * the node under a sub-path changes this one constant.
 */
export const API_BASE = '';

/**
 * Logical name -> path builder. Path parameters are `encodeURIComponent`-ed at
 * the point of construction, so a CID containing a slash or a `?` cannot
 * escape its segment and hit a different route.
 *
 * Query strings are NOT built here — `request()` serialises them from the
 * `query` option, which keeps encoding rules in one place.
 */
export const ENDPOINTS = Object.freeze({
  /** GET — liveness. Cheap, never touches the chain. */
  health: () => '/healthz',
  /** GET — readiness: embedding model loaded, chain reachable. */
  ready: () => '/readyz',
  /** GET — node identity + chain + readiness summary. */
  status: () => '/api/status',
  /** GET — agent profile + reputation for one address. */
  agent: (/** @type {string} */ address) => '/api/agents/' + encodeURIComponent(address),
  /** POST — register this node's DID on chain. */
  register: () => '/api/agents/register',
  /** GET (paginated, `?limit=&cursor=`) and POST (commit `{context}`). */
  memories: () => '/api/memories',
  /** GET — one memory by content identifier. */
  memory: (/** @type {string} */ cid) => '/api/memories/' + encodeURIComponent(cid),
  /** POST — trust-weighted semantic search, body `{query, topK}`. */
  semanticSearch: () => '/api/semantic/search',
  /** GET — cross-model similarity matrix. */
  semanticSimilarity: () => '/api/semantic/similarity',
  /** GET — reputation scores + trust events. */
  reputation: () => '/api/reputation',
  /** POST — body `{target, reason}`. */
  endorse: () => '/api/reputation/endorse',
  /** POST — body `{target, reason}`. */
  report: () => '/api/reputation/report',
  /** GET — benchmark data. 404s on a fresh clone; that is a normal state. */
  simulation: () => '/api/simulation-results',
  /** GET — Prometheus exposition format, `text/plain`. */
  metrics: () => '/metrics',
  /** GET — machine-readable OpenAPI document. Linked, never fetched by the UI. */
  openapi: () => '/openapi.json',
  /** GET — human-readable API documentation. Linked, never fetched by the UI. */
  docs: () => '/docs',
});

/**
 * Per-class deadlines. A commit runs an embedding, an AES seal, an IPFS pin
 * and a Sepolia transaction; the repo's own benchmark data records total
 * latencies up to 24 seconds, so 90 s is a real deadline rather than a
 * pessimistic guess.
 */
export const TIMEOUTS = Object.freeze({
  default: 15000,
  probe: 8000,
  status: 10000,
  list: 15000,
  search: 20000,
  mutate: 30000,
  commit: 90000,
});

/**
 * Retry policy. Applies to GET and to explicitly idempotent requests only.
 * `429` and `503` are included because both are transient by definition and
 * both are what a node returns while the embedding model is still loading.
 */
export const RETRY = Object.freeze({
  attempts: 3,
  baseMs: 400,
  maxMs: 5000,
  /** Retry-After is honoured but capped: the UI must not hang on a hostile value. */
  maxRetryAfterMs: 10000,
  retriableStatuses: Object.freeze([408, 425, 429, 500, 502, 503, 504]),
});

/**
 * The only content types this client will hand to `JSON.parse`.
 * `application/problem+json` (RFC 9457) is accepted because a well-behaved
 * backend uses it for error envelopes.
 */
const JSON_CONTENT_TYPE = /^application\/(problem\+)?json\b/i;

/* ==================================================================== *
 * Error type
 * ==================================================================== */

/**
 * Every failure that leaves this module is an `ApiError`. Views branch on
 * `code` and `retriable`; `toast.error()` renders `userMessage`.
 */
export class ApiError extends Error {
  /**
   * @param {string} message technical message, for logs and the details line
   * @param {object} [options]
   * @param {number} [options.status] HTTP status, or 0 for a transport failure
   * @param {string} [options.code] stable machine-readable code
   * @param {unknown} [options.details] server-supplied detail payload
   * @param {string | null} [options.requestId] correlation id, if the node sent one
   * @param {boolean} [options.retriable] whether retrying could plausibly work
   * @param {number | null} [options.retryAfterMs] server-directed backoff
   * @param {unknown} [options.cause]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    /** @type {number} */
    this.status = options.status ?? 0;
    /** @type {string} */
    this.code = options.code ?? 'unknown';
    /** @type {unknown} */
    this.details = options.details ?? null;
    /** @type {string | null} */
    this.requestId = options.requestId ?? null;
    /** @type {boolean} */
    this.retriable = options.retriable ?? false;
    /**
     * Server-directed backoff from a `Retry-After` header, in milliseconds.
     * When present it overrides the client's own exponential schedule.
     * @type {number | null}
     */
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  /**
   * A short sentence for a human. Deliberately does NOT include the server's
   * raw message for 4xx codes we recognise — those messages are written for
   * developers and read as noise in a toast.
   *
   * @returns {string}
   */
  get userMessage() {
    switch (this.code) {
      case 'network':
        return 'Cannot reach the node. Check that the server is running.';
      case 'timeout':
        return 'The node took too long to respond.';
      case 'aborted':
        return 'Request cancelled.';
      case 'offline':
        return 'You are offline. The console is showing the last known data.';
      case 'bad_content_type':
        return 'The node returned something that is not JSON. It may be behind a proxy.';
      case 'api_key_required':
        return 'This action needs an API key. Add one in Settings.';
      case 'simulation_missing':
        return 'No benchmark data yet. Run the simulation to generate it.';
      default:
        break;
    }
    if (this.status === 401) return 'This action needs an API key. Add one in Settings.';
    if (this.status === 403) return 'This node refused the request. Check the API key.';
    if (this.status === 404) return 'Not found on this node.';
    if (this.status === 409) return 'That conflicts with something already recorded.';
    if (this.status === 429) return 'Too many requests — retrying shortly.';
    if (this.status === 503) return 'The node is still starting up.';
    if (this.status >= 500) return this.message || 'The node hit an internal error.';
    if (this.status >= 400) return this.message || 'The node rejected the request.';
    return this.message || 'Something went wrong.';
  }

  /**
   * Log-safe projection. Never contains a body, a header, or the API key.
   * @returns {Record<string, unknown>}
   */
  toJSON() {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      message: this.message,
      requestId: this.requestId,
      retriable: this.retriable,
    };
  }

  /**
   * Build from a non-ok response. Understands the backend's error envelope
   * `{ error: { code, message, details }, requestId }` and degrades to the
   * status text when the body is unusable.
   *
   * @param {Response} response
   * @param {unknown} body parsed JSON, a raw string, or null
   * @returns {ApiError}
   */
  static fromResponse(response, body) {
    const envelope =
      body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : null;
    const inner =
      envelope && typeof envelope.error === 'object' && envelope.error !== null
        ? /** @type {Record<string, unknown>} */ (envelope.error)
        : envelope;

    const message =
      (inner && typeof inner.message === 'string' && inner.message) ||
      (typeof body === 'string' && body.trim() !== '' ? body.slice(0, 200) : '') ||
      response.statusText ||
      'HTTP ' + response.status;

    const code =
      (inner && typeof inner.code === 'string' && inner.code) || 'http_' + response.status;

    return new ApiError(message, {
      status: response.status,
      code,
      details: inner ? (inner.details ?? null) : null,
      requestId:
        response.headers.get('x-request-id') ||
        (envelope && typeof envelope.requestId === 'string' ? envelope.requestId : null),
      retriable: RETRY.retriableStatuses.includes(response.status),
      retryAfterMs: retryAfterMs(response),
    });
  }

  /**
   * @param {unknown} cause
   * @returns {ApiError}
   */
  static fromNetwork(cause) {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return new ApiError(
      offline ? 'Browser reports no network connection' : 'Network request failed',
      {
        status: 0,
        code: offline ? 'offline' : 'network',
        retriable: true,
        cause,
      },
    );
  }

  /**
   * @param {number} ms the deadline that elapsed
   * @returns {ApiError}
   */
  static timeout(ms) {
    return new ApiError('Request timed out after ' + ms + ' ms', {
      status: 0,
      code: 'timeout',
      retriable: true,
    });
  }

  /**
   * A caller-initiated cancellation — a view unmounting, or a superseded
   * search. NEVER retriable and never worth a toast: it is not a failure.
   *
   * @returns {ApiError}
   */
  static aborted() {
    return new ApiError('Request aborted', { status: 0, code: 'aborted', retriable: false });
  }
}

/**
 * True for the one error class that must never reach the user as a toast.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  return error instanceof ApiError && error.code === 'aborted';
}

/* ==================================================================== *
 * In-flight registry
 *
 * A view calls `createScope('memory')` on mount and `scope.abort()` on
 * unmount. Every request tagged with that scope is cancelled, so a late
 * response can never render into a container that has been torn down.
 * ==================================================================== */

/** @type {Map<string, Set<AbortController>>} */
const inFlight = new Map();
let scopeSequence = 0;

/**
 * @typedef {object} RequestScope
 * @property {string} name unique registry key
 * @property {() => void} abort cancel every request currently tagged with this scope
 * @property {() => number} size number of requests in flight
 */

/**
 * @param {string} [label] a human-readable prefix, e.g. the view name
 * @returns {RequestScope}
 */
export function createScope(label = 'scope') {
  scopeSequence += 1;
  const name = label + '#' + scopeSequence;
  return {
    name,
    abort: () => abortScope(name),
    size: () => inFlightCount(name),
  };
}

/**
 * @param {string | RequestScope | null | undefined} scope
 * @returns {string | null}
 */
function scopeKey(scope) {
  if (!scope) return null;
  return typeof scope === 'string' ? scope : scope.name;
}

/**
 * @param {string | RequestScope} scope
 * @returns {number} how many requests were cancelled
 */
export function abortScope(scope) {
  const key = scopeKey(scope);
  if (!key) return 0;
  const set = inFlight.get(key);
  if (!set) return 0;
  const count = set.size;
  // Copy: abort() triggers the finally block, which mutates this set.
  for (const controller of Array.from(set)) controller.abort();
  inFlight.delete(key);
  return count;
}

/**
 * Cancel everything. Used on `pagehide` so a navigating tab does not leave
 * requests hanging.
 *
 * @returns {void}
 */
export function abortAll() {
  for (const key of Array.from(inFlight.keys())) abortScope(key);
}

/**
 * @param {string | RequestScope} [scope] omit for the global total
 * @returns {number}
 */
export function inFlightCount(scope) {
  const key = scopeKey(scope);
  if (key) return inFlight.get(key)?.size ?? 0;
  let total = 0;
  for (const set of inFlight.values()) total += set.size;
  return total;
}

/**
 * @param {string | null} key
 * @param {AbortController} controller
 * @returns {void}
 */
function registerInFlight(key, controller) {
  if (!key) return;
  let set = inFlight.get(key);
  if (!set) {
    set = new Set();
    inFlight.set(key, set);
  }
  set.add(controller);
}

/**
 * @param {string | null} key
 * @param {AbortController} controller
 * @returns {void}
 */
function releaseInFlight(key, controller) {
  if (!key) return;
  const set = inFlight.get(key);
  if (!set) return;
  set.delete(controller);
  if (set.size === 0) inFlight.delete(key);
}

/* ==================================================================== *
 * The core request
 * ==================================================================== */

/**
 * @typedef {object} RequestOptions
 * @property {'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} [method]
 * @property {unknown} [body] serialised as JSON when present
 * @property {Record<string, unknown>} [query] null/undefined/'' entries are dropped
 * @property {AbortSignal} [signal] caller cancellation, composed with the timeout
 * @property {number} [timeoutMs] defaults to TIMEOUTS.default
 * @property {string | RequestScope} [scope] registry key for bulk cancellation
 * @property {'json' | 'text' | 'none'} [parse] expected response shape
 * @property {boolean} [idempotent] allow retries for a non-GET method
 * @property {string} [idempotencyKey] sent as `Idempotency-Key`
 * @property {number} [retries] override RETRY.attempts (0 disables retrying)
 */

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }
  });
}

/**
 * Exponential backoff with proportional jitter. Jitter is essential rather
 * than decorative: without it, every panel that failed on the same tick
 * retries on the same tick forever.
 *
 * @param {number} attempt zero-based
 * @returns {number} milliseconds
 */
function backoffDelay(attempt) {
  const base = Math.min(RETRY.maxMs, RETRY.baseMs * Math.pow(2, attempt));
  return Math.round(base * (0.7 + Math.random() * 0.6));
}

/**
 * `Retry-After` is either delta-seconds or an HTTP-date. Both are honoured,
 * and both are capped so a misconfigured node cannot freeze the UI.
 *
 * @param {Response} response
 * @returns {number | null} milliseconds, or null when absent/unparsable
 */
function retryAfterMs(response) {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.min(RETRY.maxRetryAfterMs, Math.max(0, seconds * 1000));
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) return null;
  return Math.min(RETRY.maxRetryAfterMs, Math.max(0, date - Date.now()));
}

/**
 * @param {string} path
 * @param {Record<string, unknown> | undefined} query
 * @returns {string}
 */
function buildUrl(path, query) {
  const url = API_BASE + path;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const serialised = params.toString();
  return serialised === '' ? url : url + '?' + serialised;
}

/**
 * @returns {string} a correlation id echoed back by the node in its logs
 */
function newRequestId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
  } catch {
    // Non-secure context: randomUUID is undefined. Fall through.
  }
  return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Perform one HTTP attempt. Retrying is the caller's job.
 *
 * @param {string} path
 * @param {RequestOptions} options
 * @returns {Promise<unknown>}
 */
async function attempt(path, options) {
  const method = options.method ?? 'GET';
  const parse = options.parse ?? 'json';
  const timeoutMs = options.timeoutMs ?? TIMEOUTS.default;
  const key = scopeKey(options.scope);

  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;

  // The deadline covers the WHOLE exchange, body included. Clearing it as soon
  // as headers arrive would leave a slow or stalled body read unbounded, which
  // is the same never-settling promise the old code had.
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  /** @type {(() => void) | null} */
  let detachCaller = null;
  const callerSignal = options.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      callerAborted = true;
      controller.abort();
    } else {
      const onAbort = () => {
        callerAborted = true;
        controller.abort();
      };
      callerSignal.addEventListener('abort', onAbort, { once: true });
      detachCaller = () => callerSignal.removeEventListener('abort', onAbort);
    }
  }

  registerInFlight(key, controller);

  /** @type {Record<string, string>} */
  const headers = { Accept: parse === 'text' ? 'text/plain, */*' : 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  headers['X-Request-Id'] = newRequestId();

  // The write key travels as a header and only as a header: never a query
  // parameter, because URLs reach access logs, Referer headers and history.
  const apiKey = getApiKey();
  if (apiKey !== '') headers['x-api-key'] = apiKey;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  try {
    /** @type {Response} */
    let response;
    try {
      response = await fetch(buildUrl(path, options.query), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        credentials: 'same-origin',
        // A status probe must never be answered from the HTTP cache.
        cache: 'no-store',
      });
    } catch (cause) {
      // fetch throws an AbortError for both a caller cancellation and a
      // timeout. Distinguishing them is what stops a timeout being classified
      // as "the user changed their mind" and silently swallowed.
      if (callerAborted) throw ApiError.aborted();
      if (timedOut) throw ApiError.timeout(timeoutMs);
      throw ApiError.fromNetwork(cause);
    }

    if (!response.ok) {
      const body = await readBodyDefensively(response);
      const error = ApiError.fromResponse(response, body);
      // Let main.js raise the "this node requires an API key" banner once,
      // centrally, instead of every call site testing for it.
      if (response.status === 401) {
        document.dispatchEvent(
          new CustomEvent('nm:apikeyrequired', { detail: { code: error.code } }),
        );
      }
      throw error;
    }

    if (parse === 'none' || response.status === 204) return null;

    const contentType = response.headers.get('content-type') || '';

    if (parse === 'text') return await response.text();

    // Verify BEFORE parsing. A reverse proxy can return an HTML error page
    // with a 200, and `res.json()` on it throws a bare SyntaxError carrying
    // none of the context needed to explain what actually happened.
    if (!JSON_CONTENT_TYPE.test(contentType)) {
      const snippet = (await response.text()).slice(0, 200);
      throw new ApiError(
        'Expected JSON but received "' + (contentType || 'no content-type') + '"',
        {
          status: response.status,
          code: 'bad_content_type',
          details: snippet,
          retriable: false,
        },
      );
    }

    try {
      return await response.json();
    } catch (cause) {
      if (timedOut) throw ApiError.timeout(timeoutMs);
      if (callerAborted) throw ApiError.aborted();
      throw new ApiError('The node sent malformed JSON', {
        status: response.status,
        code: 'bad_json',
        retriable: false,
        cause,
      });
    }
  } finally {
    window.clearTimeout(timer);
    if (detachCaller) detachCaller();
    releaseInFlight(key, controller);
  }
}

/**
 * Read an error body without ever throwing: a failure to read the explanation
 * must not replace the failure being explained.
 *
 * @param {Response} response
 * @returns {Promise<unknown>}
 */
async function readBodyDefensively(response) {
  try {
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    if (raw === '') return null;
    if (/json/i.test(contentType)) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * The retry wrapper around `attempt`.
 *
 * Retries are permitted ONLY for `GET` or for a request explicitly marked
 * `idempotent`. `POST /api/memories` embeds, pins to IPFS and sends a Sepolia
 * transaction; retrying it on a timeout could commit the same memory twice
 * and spend gas twice, so it is never retried without an idempotency key the
 * server can deduplicate on.
 *
 * @param {string} path
 * @param {RequestOptions} [options]
 * @returns {Promise<unknown>}
 */
export async function request(path, options = {}) {
  const method = options.method ?? 'GET';
  const mayRetry = method === 'GET' || options.idempotent === true;
  const maxAttempts = mayRetry ? Math.max(1, options.retries ?? RETRY.attempts) : 1;

  /** @type {ApiError} */
  let lastError = ApiError.fromNetwork(null);

  for (let index = 0; index < maxAttempts; index += 1) {
    try {
      return await attempt(path, options);
    } catch (error) {
      const apiError = error instanceof ApiError ? error : ApiError.fromNetwork(error);
      lastError = apiError;

      // A cancelled request is a decision, not a fault. Never retry it.
      if (apiError.code === 'aborted') throw apiError;
      if (!apiError.retriable || index === maxAttempts - 1) throw apiError;
      if (options.signal?.aborted) throw ApiError.aborted();

      // A node that told us how long to wait knows better than our schedule.
      const delay = apiError.retryAfterMs ?? backoffDelay(index);
      await sleep(delay, options.signal);
      if (options.signal?.aborted) throw ApiError.aborted();
    }
  }
  throw lastError;
}

/* ==================================================================== *
 * Typed endpoint helpers
 *
 * Views call these, never `request()` directly, so the method, the timeout
 * class and the retry eligibility of each route are decided in exactly one
 * place. `opts` is `{ signal, scope, timeoutMs }` throughout.
 * ==================================================================== */

/**
 * @typedef {object} CallOptions
 * @property {AbortSignal} [signal]
 * @property {string | RequestScope} [scope]
 * @property {number} [timeoutMs]
 */

/**
 * @param {CallOptions | undefined} opts
 * @param {number} timeoutMs
 * @returns {RequestOptions}
 */
function base(opts, timeoutMs) {
  return { signal: opts?.signal, scope: opts?.scope, timeoutMs: opts?.timeoutMs ?? timeoutMs };
}

/**
 * Liveness. Answers even while the embedding model is loading.
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getHealth(opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.health(), base(opts, TIMEOUTS.probe))
  );
}

/**
 * Readiness: model loaded and chain reachable. A `503` here is a NORMAL state
 * during boot, not an error to shout about — callers render "starting up".
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getReady(opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.ready(), base(opts, TIMEOUTS.probe))
  );
}

/**
 * Node identity, chain state and readiness in one payload. This is the
 * request the status poller repeats.
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getStatus(opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.status(), base(opts, TIMEOUTS.status))
  );
}

/**
 * @param {string} address
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getAgent(address, opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.agent(address), base(opts, TIMEOUTS.default))
  );
}

/**
 * Register this node's DID. A write: requires the API key, is never retried.
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function registerAgent(opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.register(), {
      ...base(opts, TIMEOUTS.commit),
      method: 'POST',
      body: {},
    })
  );
}

/**
 * @param {{ limit?: number, cursor?: string | null }} [params]
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function listMemories(params, opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.memories(), {
      ...base(opts, TIMEOUTS.list),
      query: { limit: params?.limit, cursor: params?.cursor },
    })
  );
}

/**
 * @param {string} cid
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getMemory(cid, opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.memory(cid), base(opts, TIMEOUTS.default))
  );
}

/**
 * Commit a memory: embed, encrypt, pin, and record the proof on chain.
 *
 * The single most expensive call in the app. It carries an `Idempotency-Key`
 * so a node that supports deduplication can make a client-side retry safe,
 * but this client still never retries it on its own.
 *
 * @param {{ context: string }} payload
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function createMemory(payload, opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.memories(), {
      ...base(opts, TIMEOUTS.commit),
      method: 'POST',
      body: { context: payload.context },
      idempotencyKey: newRequestId(),
    })
  );
}

/**
 * @param {{ query: string, topK?: number }} payload
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function semanticSearch(payload, opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.semanticSearch(), {
      ...base(opts, TIMEOUTS.search),
      method: 'POST',
      body: { query: payload.query, topK: payload.topK ?? 5 },
      // A search has no side effects, so a retry is safe and worth having.
      idempotent: true,
    })
  );
}

/**
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getSimilarity(opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.semanticSimilarity(), base(opts, TIMEOUTS.list))
  );
}

/**
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getReputation(opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.reputation(), base(opts, TIMEOUTS.list))
  );
}

/**
 * @param {{ target: string, reason: string }} payload
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function endorse(payload, opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.endorse(), {
      ...base(opts, TIMEOUTS.mutate),
      method: 'POST',
      body: { target: payload.target, reason: payload.reason },
    })
  );
}

/**
 * @param {{ target: string, reason: string }} payload
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function report(payload, opts) {
  return /** @type {Record<string, unknown>} */ (
    await request(ENDPOINTS.report(), {
      ...base(opts, TIMEOUTS.mutate),
      method: 'POST',
      body: { target: payload.target, reason: payload.reason },
    })
  );
}

/**
 * Benchmark data.
 *
 * `simulation-results.json` is gitignored, so a fresh clone has no such file
 * and this route 404s. That is the DEFAULT state, not a fault — the 404 is
 * re-coded as `simulation_missing` so the view renders a "run the simulation"
 * empty state with a copyable command instead of an error toast.
 *
 * @param {CallOptions} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getSimulation(opts) {
  try {
    return /** @type {Record<string, unknown>} */ (
      await request(ENDPOINTS.simulation(), base(opts, TIMEOUTS.list))
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ApiError('No simulation results on this node yet', {
        status: 404,
        code: 'simulation_missing',
        retriable: false,
      });
    }
    throw error;
  }
}

/**
 * Prometheus exposition text. Returned unparsed — the System view owns the
 * parsing, because the metric set is the backend's to define.
 *
 * @param {CallOptions} [opts]
 * @returns {Promise<string>}
 */
export async function getMetrics(opts) {
  return /** @type {string} */ (
    await request(ENDPOINTS.metrics(), { ...base(opts, TIMEOUTS.probe), parse: 'text' })
  );
}

/**
 * Cancel every outstanding request when the page goes away. Without this a
 * `pagehide` during a commit leaves the connection open until the browser
 * reaps it.
 *
 * @returns {() => void} teardown
 */
export function installUnloadGuard() {
  const onPageHide = () => abortAll();
  window.addEventListener('pagehide', onPageHide);
  return () => window.removeEventListener('pagehide', onPageHide);
}

/** Internal surface for unit tests that stub `globalThis.fetch`. */
export const __testing = Object.freeze({ request, attempt, buildUrl, backoffDelay, retryAfterMs });
