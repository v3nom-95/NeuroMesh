/**
 * IPFS pinning and retrieval, with locally computed CIDs, byte-exact uploads and no secret leakage.
 *
 * ## Five things v1 got wrong, and what replaced each
 *
 * 1. **The CID was taken on trust.** v1 returned `res.data.IpfsHash` unverified, so a compromised
 *    or merely buggy pinning service could hand back any CID and the node would commit it to the
 *    chain as its proof of what it stored. Here the CID is computed **locally, first**, and a
 *    disagreement is a hard `CidMismatchError` raised *before* anything reaches the chain.
 * 2. **`pinJSONToIPFS` re-serialised the payload.** The bytes at the returned CID were therefore not
 *    the bytes the node hashed, and protocol section 9 step 3 - re-canonicalise and byte-compare -
 *    would have failed on every object this code ever published. This module uploads the exact
 *    canonical bytes through `pinFileToIPFS` as `application/octet-stream` and never calls
 *    `pinJSONToIPFS`.
 * 3. **No timeouts.** A hung connection hung the Express request forever. Every outbound call here
 *    carries `AbortSignal.timeout`.
 * 4. **`pinList` returned the operator's entire account.** Unpaginated, unfiltered, materialised in
 *    memory on every request, and including pins from unrelated projects. {@link listPins} always
 *    filters on the `app: neuromesh` keyvalue and always paginates, and its docstring says plainly
 *    that it is a *secondary* index - the authoritative memory list is the chain.
 * 5. **An error was swallowed into `res.json([])`.** An expired JWT was indistinguishable from an
 *    empty node. Nothing here returns a silent empty result; a broken upstream is a 502 or a 503.
 *
 * ## Transport
 *
 * Node 22's global `fetch`/`FormData`/`Blob`, injected as {@link IpfsOptions.fetchImpl} so tests
 * drive a fake transport with no network and no timing. axios is deliberately not used: an axios
 * error object carries `err.config.headers.Authorization`, i.e. the full Pinata JWT, so any
 * `logger.error(err)` anywhere in the process would print the credential into stdout and from there
 * into log aggregation. Removing the library removes the whole class.
 *
 * @module src/services/ipfs
 */
import { getConfig } from '../config/index.js';
import { errors } from '../errors.js';
import { logger as defaultLogger } from '../logger.js';
import { canonical, constants } from '../protocol/index.js';
import { backoffDelay, normalizeMetrics, sleep as realSleep } from './instrument.js';

/** Maximum attempts for a retriable failure, including the first. */
const MAX_ATTEMPTS = 3;

/** Bytes of an error response body that are read before it is discarded. */
const ERROR_BODY_LIMIT = 2048;

/** Pinata's own per-page ceiling. */
const MAX_PAGE_LIMIT = 100;

/** How long an authentication probe result is reused. */
const PROBE_TTL_MS = 60_000;

/**
 * @typedef {object} IpfsOptions
 * @property {ReturnType<typeof getConfig>} [config] Application config.
 * @property {any} [logger] Pino logger.
 * @property {import('./instrument.js').MetricsLike} [metrics] Metrics collector.
 * @property {typeof globalThis.fetch} [fetchImpl] Transport. Injected in tests.
 * @property {(ms: number) => Promise<void>} [sleep] Delay function. Injected in tests.
 * @property {() => number} [random] Jitter source. Injected in tests for deterministic backoff.
 * @property {number} [cacheMax] Maximum gateway responses retained.
 */

/**
 * Create the IPFS service.
 *
 * Construction performs no I/O. A node with no `PINATA_JWT` gets a fully constructed service in
 * **disabled** mode: `probe()` reports `{configured: false, status: 'disabled'}` so readiness shows
 * "not configured" rather than "down", and every call that would need the credential raises a clear
 * `503 ipfs_unavailable` naming the missing setting instead of throwing a `TypeError` on a
 * `Bearer undefined` header.
 *
 * @param {IpfsOptions} [deps] Dependencies.
 * @returns {IpfsService} The service.
 */
export function createIpfsService({
  config = getConfig(),
  logger = defaultLogger,
  metrics,
  fetchImpl,
  sleep = realSleep,
  random = Math.random,
  cacheMax = 256,
} = {}) {
  const log = logger.child ? logger.child({ service: 'ipfs' }) : logger;
  const instruments = normalizeMetrics(metrics);
  const doFetch = fetchImpl ?? globalThis.fetch;
  const enabled = Boolean(config.ipfs.enabled && config.ipfs.jwt);

  /** Bounded LRU of gateway bodies. Content is immutable under its CID, so only the count is bounded. */
  const cache = new Map();
  /** @type {{at: number, value: object}|null} */
  let probeCache = null;
  /** @type {Promise<any>|null} */
  let probeInflight = null;

  /**
   * @returns {import('../errors.js').AppError} The disabled-mode failure.
   */
  function disabled() {
    return errors.ipfsUnavailable(
      'IPFS pinning is not configured on this node: PINATA_JWT is unset. Reads from the public ' +
        'gateway still work; pinning and unpinning do not.',
    );
  }

  /**
   * One authenticated request to the Pinata API, with retries.
   *
   * Retries only on 429, 5xx and network failures - never on a 4xx, because a rejected credential
   * or a malformed request does not become correct by being repeated. Backoff is full-jitter
   * exponential, and a `Retry-After` header always wins over the computed delay.
   *
   * @param {string} path Path under the API base, e.g. `/data/testAuthentication`.
   * @param {RequestInit & {label?: string, timeoutMs?: number}} [init] Request options.
   * @returns {Promise<Response>} A successful response.
   */
  async function apiRequest(path, init = {}) {
    if (!enabled) throw disabled();
    const url = `${config.ipfs.apiUrl.replace(/\/$/, '')}${path}`;
    const label = init.label ?? 'api';
    const timeoutMs = init.timeoutMs ?? config.ipfs.timeoutMs;

    /** @type {unknown} */
    let lastError = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const stop = instruments.timer('neuromesh_ipfs_duration_seconds', { label });
      try {
        const res = await doFetch(url, {
          ...init,
          headers: {
            // The credential is set here and nowhere else, and no code path puts a Headers object,
            // a request object or an error carrying one onto a log record.
            Authorization: `Bearer ${config.ipfs.jwt}`,
            ...(init.headers ?? {}),
          },
          signal: init.signal ?? AbortSignal.timeout(timeoutMs),
        });
        stop({ status: String(res.status) });
        if (res.ok) return res;

        const failure = await toIpfsError(res, label);
        if (!isRetriableStatus(res.status) || attempt === MAX_ATTEMPTS - 1) throw failure;
        lastError = failure;
        await sleep(retryDelay(res, attempt, random));
      } catch (err) {
        stop({ status: 'error' });
        if (isAppError(err) && !(/** @type {any} */ (err).retriable)) throw err;
        if (attempt === MAX_ATTEMPTS - 1) {
          throw isAppError(err) ? err : networkError(err, label);
        }
        lastError = err;
        await sleep(backoffDelay(attempt, { random }));
      }
    }
    /* c8 ignore next 2 -- the loop either returns or throws on its last iteration */
    throw isAppError(lastError) ? lastError : networkError(lastError, label);
  }

  /**
   * Pin exact bytes.
   *
   * Order is load-bearing: the CID is computed **before** the upload, so the comparison at the end
   * is between a value this node derived and a value a third party asserted. Computing it after,
   * or trusting `IpfsHash`, would make the check vacuous.
   *
   * @param {Uint8Array} bytes The exact bytes to store. Canonicalise before calling; this function
   *   never re-encodes anything.
   * @param {object} [meta] Pin metadata.
   * @param {string} [meta.name] Human-readable pin name.
   * @param {Record<string, string>} [meta.keyvalues] Extra keyvalues, merged over the defaults.
   * @returns {Promise<{cid: string, digest: string, size: number, timestamp: string|null,
   *   duplicate: boolean}>} The pin result, whose `cid` is the locally computed one.
   */
  async function pinBytes(bytes, meta = {}) {
    if (!(bytes instanceof Uint8Array)) {
      throw errors.badRequest('pinBytes() requires a Uint8Array of exact bytes.');
    }
    if (bytes.length === 0) throw errors.badRequest('Refusing to pin zero bytes.');
    if (bytes.length > config.ipfs.maxBytes) {
      // Above 1 MiB an object stops being a single raw block, which is what keeps CID computation a
      // four-line function any verifier can reimplement.
      throw errors.payloadTooLarge(config.ipfs.maxBytes, bytes.length);
    }
    if (!enabled) throw disabled();

    const { cid, digest } = canonical.cidFromBytes(bytes);

    const form = new FormData();
    form.append(
      'file',
      // Cast only to satisfy the DOM lib's BlobPart union, which does not yet list a generic
      // `Uint8Array<ArrayBufferLike>`. The bytes are passed through untouched.
      new Blob([/** @type {any} */ (bytes)], { type: 'application/octet-stream' }),
      meta.name ?? `${cid}.json`,
    );
    form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));
    form.append(
      'pinataMetadata',
      JSON.stringify({
        name: meta.name ?? cid,
        keyvalues: {
          // These keyvalues are what make listPins able to filter to *this* application instead of
          // enumerating the operator's entire billing account.
          app: 'neuromesh',
          v: constants.PROTOCOL_VERSION,
          cidDigest: digest,
          ...(meta.keyvalues ?? {}),
        },
      }),
    );

    const res = await apiRequest('/pinning/pinFileToIPFS', {
      method: 'POST',
      body: form,
      label: 'pin',
    });
    const body = /** @type {any} */ (await readJson(res, 'pin'));
    const reported = body?.IpfsHash;
    if (reported !== cid) {
      throw errors.upstream(
        'The pinning service returned a different CID than the one computed locally. The bytes ' +
          'stored are not the bytes this node hashed, so committing this CID to the chain would ' +
          'record a claim about content that does not exist.',
        { expected: cid, actual: reported ?? null },
      );
    }
    instruments.increment('neuromesh_ipfs_pins_total', { result: 'ok' });
    instruments.observe('neuromesh_ipfs_bytes', bytes.length, { direction: 'out' });
    cache.set(cid, bytes);
    trimCache();
    return {
      cid,
      digest,
      size: bytes.length,
      timestamp: body?.Timestamp ?? null,
      duplicate: Boolean(body?.isDuplicate),
    };
  }

  /**
   * Canonicalise a JSON value and pin the resulting bytes.
   *
   * A convenience over {@link pinBytes} for callers that hold an object rather than bytes. It is
   * still the *local* canonicalisation that produces the uploaded bytes; nothing is re-serialised
   * remotely.
   *
   * @param {unknown} value JSON value to canonicalise and pin.
   * @param {object} [meta] Pin metadata, as {@link pinBytes}.
   * @returns {Promise<Awaited<ReturnType<typeof pinBytes>> & {bytes: Uint8Array}>} The pin result
   *   plus the exact bytes that were stored.
   */
  async function pin(value, meta = {}) {
    const bytes = canonical.canonicalBytes(value);
    const result = await pinBytes(bytes, meta);
    return { ...result, bytes };
  }

  /**
   * Unpin a CID. Used as the compensating action when a chain commit fails after a successful pin.
   *
   * Failures are logged at WARN and reported in the return value rather than thrown. A failed
   * compensation must not replace the original error with a different one - the caller is already
   * handling a failure, and losing that context to a secondary error is how an operator ends up
   * debugging the wrong thing.
   *
   * @param {string} cid CID to unpin.
   * @returns {Promise<{ok: boolean, cid: string, reason: string|null}>} Outcome.
   */
  async function unpin(cid) {
    if (!enabled) return { ok: false, cid, reason: 'ipfs_disabled' };
    try {
      await apiRequest(`/pinning/unpin/${encodeURIComponent(cid)}`, {
        method: 'DELETE',
        label: 'unpin',
      });
      cache.delete(cid);
      instruments.increment('neuromesh_ipfs_unpins_total', { result: 'ok' });
      log.info?.({ cid }, 'compensating unpin succeeded');
      return { ok: true, cid, reason: null };
    } catch (err) {
      instruments.increment('neuromesh_ipfs_unpins_total', { result: 'failed' });
      const reason = String(/** @type {any} */ (err)?.message ?? err);
      log.warn?.(
        { cid, reason },
        'compensating unpin failed; the object remains pinned and billed with no chain record',
      );
      return { ok: false, cid, reason };
    }
  }

  /**
   * Fetch the bytes behind a CID from the gateway and verify them against that CID.
   *
   * Two defences that are not optional:
   *   - The size cap is enforced by **reading the stream and aborting past the limit**.
   *     `Content-Length` is attacker-controlled and is not trusted.
   *   - `canonical.verifyCid` is run on what arrived. A gateway that substitutes content is caught
   *     here rather than silently believed - protocol section 9 step 2.
   *
   * @param {string} cid CID to fetch.
   * @param {object} [options] Options.
   * @param {number} [options.maxBytes] Override the configured cap.
   * @returns {Promise<Uint8Array>} The verified bytes.
   */
  async function fetchBytes(cid, options = {}) {
    const cached = cache.get(cid);
    if (cached) {
      cache.delete(cid);
      cache.set(cid, cached);
      return cached;
    }
    const maxBytes = options.maxBytes ?? config.ipfs.maxBytes;
    const stop = instruments.timer('neuromesh_ipfs_duration_seconds', { label: 'gateway' });
    /** @type {Response} */
    let res;
    try {
      res = await doFetch(gatewayUrl(cid), {
        method: 'GET',
        signal: AbortSignal.timeout(config.ipfs.timeoutMs),
      });
    } catch (err) {
      stop({ status: 'error' });
      throw networkError(err, 'gateway');
    }
    stop({ status: String(res.status) });
    if (res.status === 404) throw errors.memoryNotFound(cid);
    if (!res.ok) throw await toIpfsError(res, 'gateway');

    const bytes = await readCapped(res, maxBytes, cid);
    canonical.verifyCid(bytes, cid);
    instruments.observe('neuromesh_ipfs_bytes', bytes.length, { direction: 'in' });
    cache.set(cid, bytes);
    trimCache();
    return bytes;
  }

  /**
   * Fetch a CID and parse it as JSON.
   *
   * @param {string} cid CID to fetch.
   * @param {object} [options] Options, as {@link fetchBytes}.
   * @returns {Promise<{cid: string, bytes: Uint8Array, json: unknown}>} The verified bytes and their
   *   parse.
   */
  async function fetchByCid(cid, options = {}) {
    const bytes = await fetchBytes(cid, options);
    try {
      return {
        cid,
        bytes,
        json: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      };
    } catch (cause) {
      throw errors.upstream(`The object at ${cid} is not valid UTF-8 JSON.`, {
        cid,
        reason: String(/** @type {any} */ (cause)?.message ?? cause),
      });
    }
  }

  /**
   * List this application's pins, one page at a time.
   *
   * **Secondary index only.** The authoritative list of memories is the `MemoryLedger` owner index
   * and the `MemoryCommitted` log; a pinning service's billing dashboard is not a source of truth
   * about what was committed. This exists for reconciliation - finding a pin with no chain record,
   * which is precisely what a failed compensating unpin leaves behind.
   *
   * @param {object} [options] Options.
   * @param {number} [options.limit] Page size, capped at 100 by the API.
   * @param {string|null} [options.cursor] Opaque cursor from a previous page.
   * @returns {Promise<{items: Array<{cid: string, size: number, pinnedAt: string|null,
   *   name: string|null, keyvalues: Record<string, string>}>, nextCursor: string|null,
   *   total: number}>} One page.
   */
  async function listPins({ limit = 25, cursor = null } = {}) {
    const pageLimit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.trunc(limit)));
    const offset = decodeCursor(cursor);
    const query = new URLSearchParams({
      status: 'pinned',
      pageLimit: String(pageLimit),
      pageOffset: String(offset),
      'metadata[keyvalues]': JSON.stringify({ app: { value: 'neuromesh', op: 'eq' } }),
    });
    const res = await apiRequest(`/data/pinList?${query.toString()}`, {
      method: 'GET',
      label: 'list',
    });
    const body = /** @type {any} */ (await readJson(res, 'list'));
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    const total = Number(body?.count ?? rows.length);
    const items = rows.map((row) => ({
      cid: String(row?.ipfs_pin_hash ?? ''),
      size: Number(row?.size ?? 0),
      pinnedAt: row?.date_pinned ?? null,
      name: row?.metadata?.name ?? null,
      keyvalues: row?.metadata?.keyvalues ?? {},
    }));
    const consumed = offset + items.length;
    return {
      items,
      nextCursor: consumed < total && items.length > 0 ? encodeCursor(consumed) : null,
      total,
    };
  }

  /**
   * Check the credential.
   *
   * Cached for 60 seconds so a probe storm on `/readyz` cannot become an upstream request storm.
   * Returns a status object rather than throwing, because readiness wants a verdict, not an
   * exception.
   *
   * @param {object} [options] Options.
   * @param {boolean} [options.force] Bypass the cache.
   * @returns {Promise<{configured: boolean, status: 'up'|'down'|'disabled', detail: string|null,
   *   checkedAt: string}>} The verdict.
   */
  function probe({ force = false } = {}) {
    if (!enabled) {
      return Promise.resolve({
        configured: false,
        status: /** @type {'disabled'} */ ('disabled'),
        detail: 'PINATA_JWT is not set; this node cannot pin.',
        checkedAt: new Date().toISOString(),
      });
    }
    if (!force && probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
      return Promise.resolve(/** @type {any} */ (probeCache.value));
    }
    // Single-flight. Without this, N concurrent /readyz probes on a cold cache become N upstream
    // requests - the exact amplification the 60 s cache exists to prevent, just moved.
    probeInflight ??= runProbe().finally(() => {
      probeInflight = null;
    });
    return probeInflight;
  }

  /**
   * Perform one authentication probe and cache its verdict.
   *
   * @returns {Promise<any>} The verdict.
   */
  async function runProbe() {
    /** @type {any} */
    let value;
    try {
      await apiRequest('/data/testAuthentication', {
        method: 'GET',
        label: 'probe',
        timeoutMs: Math.min(5000, config.ipfs.timeoutMs),
      });
      value = { configured: true, status: 'up', detail: null, checkedAt: new Date().toISOString() };
    } catch (err) {
      value = {
        configured: true,
        status: 'down',
        detail: String(/** @type {any} */ (err)?.message ?? err),
        checkedAt: new Date().toISOString(),
      };
    }
    probeCache = { at: Date.now(), value };
    return value;
  }

  /**
   * The public gateway URL for a CID.
   *
   * @param {string} cid CID.
   * @returns {string} Absolute URL.
   */
  function gatewayUrl(cid) {
    return `${config.ipfs.gatewayUrl.replace(/\/$/, '')}/${cid}`;
  }

  /**
   * Evict least-recently-used entries beyond the bound.
   *
   * @returns {void}
   */
  function trimCache() {
    while (cache.size > cacheMax) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  /** @type {IpfsService} */
  const service = {
    enabled,
    pin,
    pinBytes,
    unpin,
    fetchBytes,
    fetchByCid,
    listPins,
    probe,
    gatewayUrl,
    cacheSize: () => cache.size,
    async shutdown() {
      cache.clear();
      probeCache = null;
    },
  };
  return service;
}

/**
 * @typedef {object} IpfsService
 * @property {boolean} enabled Whether a credential is configured.
 * @property {(value: unknown, meta?: object) => Promise<any>} pin Canonicalise and pin a JSON value.
 * @property {(bytes: Uint8Array, meta?: object) => Promise<any>} pinBytes Pin exact bytes.
 * @property {(cid: string) => Promise<{ok: boolean, cid: string, reason: string|null}>} unpin
 *   Compensating unpin; never throws.
 * @property {(cid: string, options?: object) => Promise<Uint8Array>} fetchBytes CID-verified fetch.
 * @property {(cid: string, options?: object) => Promise<any>} fetchByCid CID-verified fetch + parse.
 * @property {(options?: object) => Promise<any>} listPins Filtered, paginated secondary index.
 * @property {(options?: object) => Promise<any>} probe Credential check, cached 60 s.
 * @property {(cid: string) => string} gatewayUrl Public URL for a CID.
 * @property {() => number} cacheSize Entries in the gateway cache.
 * @property {() => Promise<void>} shutdown Drop the caches.
 */

/**
 * Whether a status code is worth retrying.
 *
 * @param {number} status HTTP status.
 * @returns {boolean} True for 429 and 5xx.
 */
function isRetriableStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * The delay before the next attempt: `Retry-After` when the server sent one, otherwise full-jitter
 * exponential backoff.
 *
 * `Retry-After` is accepted in both of its RFC 9110 forms - delta-seconds and an HTTP-date - and a
 * value that parses to something absurd is clamped rather than obeyed, so a hostile or broken
 * upstream cannot park a request for an hour.
 *
 * @param {Response} res The response carrying the header.
 * @param {number} attempt Zero-based attempt number.
 * @param {() => number} random Jitter source.
 * @returns {number} Delay in milliseconds.
 */
function retryDelay(res, attempt, random) {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms) && ms > 0) return Math.min(ms, 30_000);
  }
  return backoffDelay(attempt, { random });
}

/**
 * Normalise a failed response into a typed error, reading a bounded, scrubbed slice of the body.
 *
 * The status mapping is deliberate:
 *   - 401/403 -> 502 `upstream_error`. A rejected credential is **not** a 503: 503 advertises
 *     "retry, this will pass", and an expired JWT does not pass on its own.
 *   - 404 -> 404.
 *   - 429 -> 429 with the upstream's `Retry-After` propagated.
 *   - 5xx/network -> 503 `ipfs_unavailable`, retriable.
 *
 * @param {Response} res The failed response.
 * @param {string} label Operation label.
 * @returns {Promise<import('../errors.js').AppError>} The typed error.
 */
async function toIpfsError(res, label) {
  const snippet = await readErrorSnippet(res);
  const detail = snippet
    ? `${res.status} ${res.statusText}: ${snippet}`
    : `${res.status} ${res.statusText}`;
  if (res.status === 401 || res.status === 403) {
    // `retriable` is cleared explicitly. `UpstreamError` defaults it to true, which is right for a
    // 502 raised over a flaky dependency but wrong here: the retry loop reads this flag, and a
    // rejected credential repeated three times is three rejected credentials plus two sleeps.
    return notRetriable(
      errors.upstream(
        'The pinning service rejected this node’s credentials. Check PINATA_JWT; this will not ' +
          'succeed on retry.',
        { label, status: res.status },
      ),
    );
  }
  if (res.status === 404) {
    return errors.notFound(`The pinning service has no such object (${label}).`, { label });
  }
  if (res.status === 429) {
    const header = Number(res.headers?.get?.('retry-after'));
    return errors.rateLimited(Number.isFinite(header) ? header : 1);
  }
  if (res.status >= 500) return errors.ipfsUnavailable(detail);
  // Any other 4xx is a malformed request. Repeating it does not make it well-formed.
  return notRetriable(
    errors.upstream(`The pinning service refused the ${label} request.`, {
      label,
      status: res.status,
      detail: snippet,
    }),
  );
}

/**
 * Mark an error as one the retry loop must not repeat.
 *
 * @template {import('../errors.js').AppError} T
 * @param {T} error The error.
 * @returns {T} The same error, with `retriable` cleared.
 */
function notRetriable(error) {
  error.retriable = false;
  return error;
}

/**
 * Read at most {@link ERROR_BODY_LIMIT} bytes of an error body and remove anything token-shaped.
 *
 * An upstream error body is attacker-influenced text that is about to be logged and possibly shown
 * to a client. Bounding it stops a megabyte HTML error page from filling the log; scrubbing stops a
 * body that echoes the request's own `Authorization` header from re-introducing the credential leak
 * this module was written to close.
 *
 * @param {Response} res The failed response.
 * @returns {Promise<string>} A short, scrubbed snippet.
 */
async function readErrorSnippet(res) {
  try {
    const text = await res.text();
    return text
      .slice(0, ERROR_BODY_LIMIT)
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[redacted-jwt]')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * Parse a successful response as JSON.
 *
 * @param {Response} res The response.
 * @param {string} label Operation label.
 * @returns {Promise<unknown>} The parsed body.
 */
async function readJson(res, label) {
  try {
    return await res.json();
  } catch (cause) {
    throw errors.upstream(`The pinning service returned a non-JSON ${label} response.`, {
      label,
      reason: String(/** @type {any} */ (cause)?.message ?? cause),
    });
  }
}

/**
 * Read a body with a hard byte cap, aborting rather than buffering past it.
 *
 * @param {Response} res The response.
 * @param {number} maxBytes Cap.
 * @param {string} cid CID being fetched, for the error.
 * @returns {Promise<Uint8Array>} The body bytes.
 */
async function readCapped(res, maxBytes, cid) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buffer = new Uint8Array(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw errors.payloadTooLarge(maxBytes, buffer.length);
    return buffer;
  }
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw errors.payloadTooLarge(maxBytes, total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  if (out.length === 0) throw errors.memoryNotFound(cid);
  return out;
}

/**
 * Turn a transport-level failure into a typed error without carrying the request object.
 *
 * The original error is deliberately **not** attached as `cause`. A `fetch` failure carries the
 * Request, and the Request carries the `Authorization` header; passing it along would put the JWT
 * one `logger.error(err)` away from stdout.
 *
 * @param {unknown} err The thrown value.
 * @param {string} label Operation label.
 * @returns {import('../errors.js').AppError} The typed error.
 */
function networkError(err, label) {
  const name = String(/** @type {any} */ (err)?.name ?? '');
  if (name === 'TimeoutError' || name === 'AbortError') {
    return errors.upstreamTimeout(`The IPFS ${label} request timed out.`, { label });
  }
  return errors.ipfsUnavailable(
    `The IPFS ${label} request failed at the transport level: ${String(/** @type {any} */ (err)?.message ?? err)}`,
  );
}

/**
 * @param {unknown} err Candidate.
 * @returns {boolean} Whether it is one of this repository's typed HTTP errors.
 */
function isAppError(err) {
  const any = /** @type {any} */ (err);
  return Boolean(any && typeof any.status === 'number' && typeof any.code === 'string');
}

/**
 * Encode a page offset as an opaque cursor.
 *
 * Opaque so a client cannot construct one by hand and so the encoding can change without breaking
 * anybody; base64url so it is URL-safe with no escaping.
 *
 * @param {number} offset Row offset.
 * @returns {string} Cursor.
 */
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

/**
 * Decode a cursor back to an offset.
 *
 * @param {string|null} cursor Cursor from a previous page.
 * @returns {number} Row offset; 0 for a missing cursor.
 */
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const offset = Number(parsed?.o);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('bad offset');
    return offset;
  } catch {
    throw errors.badRequest('The pagination cursor is not one this node issued.', {
      field: 'cursor',
    });
  }
}

export default createIpfsService;
