/**
 * Timing-safe API-key authentication for every state-changing route.
 *
 * ## What this stands between
 *
 * `POST /agent/register` and `POST /memories` each submit a Sepolia transaction signed by the node
 * wallet. In v1 both were reachable from any origin, with no credential, no rate limit and
 * `app.use(cors())` setting `Access-Control-Allow-Origin: *`, on a server bound to `0.0.0.0`. A
 * single `for(;;) fetch('http://victim:7860/api/memory', {method:'POST', ...})` on any page the
 * operator happened to visit drained the wallet and flooded the Pinata account. This middleware,
 * the CORS allowlist, the write rate limiter and `HOST=127.0.0.1` are the four things that replace
 * that; none of them is sufficient alone.
 *
 * ## Why the comparison hashes first
 *
 * `crypto.timingSafeEqual` throws `RangeError` when its two buffers differ in length. Calling it
 * on the raw token bytes therefore leaks the configured token's length through the difference
 * between "threw immediately" and "compared in constant time" - and a caller can binary-search
 * that. Hashing both sides with SHA-256 first makes both operands exactly 32 bytes, so the
 * comparison is constant-time *and* length-independent, and the digest of a wrong token reveals
 * nothing about the right one.
 *
 * @module src/middleware/auth
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { getConfig } from '../config/index.js';
import { errors } from '../errors.js';
import { logger as rootLogger } from '../logger.js';

/**
 * Compare two secrets in constant time, regardless of their lengths.
 *
 * @param {string|null|undefined} a First secret.
 * @param {string|null|undefined} b Second secret.
 * @returns {boolean} True when both are non-empty strings and equal.
 */
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || b.length === 0) return false;
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

/**
 * Extract a bearer token or API key from a request.
 *
 * `X-API-Key` wins over `Authorization` when both are present; the scheme match is
 * case-insensitive because clients disagree about `Bearer` versus `bearer`.
 *
 * @param {any} req Express request.
 * @returns {string|null} The presented token, or `null` when none was presented.
 */
export function extractToken(req) {
  const headers = req?.headers ?? {};

  const apiKey = headers['x-api-key'];
  const key = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (typeof key === 'string' && key.trim().length > 0) return key.trim();

  const auth = headers.authorization;
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (typeof value === 'string') {
    const match = /^bearer\s+(.+)$/i.exec(value.trim());
    if (match) return match[1].trim();
  }

  return null;
}

/** Warn at most once per process that the node is running without a configured token. */
let warnedUnauthenticated = false;

/**
 * Sleep for a jittered interval.
 *
 * A small random delay on authentication failure blunts online guessing without becoming an
 * amplification vector: it is bounded, it is applied only on the failure path, and it never holds
 * a chain or IPFS resource.
 *
 * @param {number} minMs Lower bound.
 * @param {number} maxMs Upper bound.
 * @returns {Promise<void>} Resolves after the delay.
 */
function jitter(minMs, maxMs) {
  if (maxMs <= 0) return Promise.resolve();
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @typedef {object} RequireApiKeyOptions
 * @property {boolean} [optional] Allow an unauthenticated request through, marking `req.auth.ok`
 *   false rather than rejecting. Used by routes that only *vary* by authentication.
 * @property {Record<string, any>} [config] Configuration override, for tests.
 * @property {import('pino').Logger} [logger] Logger override, for tests.
 * @property {[number, number]} [failureDelayMs] Jitter bounds applied on failure.
 */

/**
 * Build the API-key middleware.
 *
 * @param {RequireApiKeyOptions} [options] Overrides.
 * @returns {(req: any, res: any, next: (err?: any) => void) => Promise<void>} Express middleware.
 */
export function requireApiKey(options = {}) {
  const optional = options.optional ?? false;

  return async function requireApiKeyMiddleware(req, res, next) {
    const config = options.config ?? getConfig();
    const log = options.logger ?? rootLogger;
    // No artificial delay in tests: it would add seconds to the suite and proves nothing there.
    const [minDelay, maxDelay] = options.failureDelayMs ?? (config.app.isTest ? [0, 0] : [50, 150]);

    const configured = config.security.apiToken;

    if (!configured) {
      // Unreachable in production: src/config/env.js refuses to boot without API_AUTH_TOKEN when
      // NODE_ENV=production, so reaching here would mean the config guard was bypassed.
      if (config.app.isProduction) {
        next(
          errors.internal(
            new Error('No API token is configured but the process is running in production.'),
          ),
        );
        return;
      }
      if (!warnedUnauthenticated) {
        warnedUnauthenticated = true;
        log.warn(
          { mode: 'unauthenticated-dev' },
          'No API_AUTH_TOKEN is set. Mutating routes are UNAUTHENTICATED. This is permitted in ' +
            'development only; production refuses to boot without one.',
        );
      }
      req.auth = { ok: true, mode: 'unauthenticated-dev' };
      next();
      return;
    }

    const presented = extractToken(req);
    if (presented && timingSafeCompare(presented, configured)) {
      req.auth = { ok: true, mode: 'api-key' };
      next();
      return;
    }

    req.auth = { ok: false, mode: presented ? 'invalid' : 'missing' };

    if (optional) {
      next();
      return;
    }

    await jitter(minDelay, maxDelay);

    // The supplied token is never logged, not even truncated: a prefix is still a prefix.
    log.warn(
      {
        requestId: req.id,
        ip: req.ip,
        route: req.originalUrl ?? req.url,
        reason: presented ? 'invalid_token' : 'missing_token',
      },
      'Rejected an unauthenticated request to a protected route.',
    );

    res.setHeader('WWW-Authenticate', 'Bearer');
    next(
      errors.unauthorized(
        presented
          ? 'The supplied API key is not valid.'
          : 'A valid API key is required for this action. Send it as X-API-Key or ' +
              'Authorization: Bearer <token>.',
      ),
    );
  };
}

/**
 * Guard `/metrics` with `METRICS_TOKEN`.
 *
 * A no-op when no metrics token is configured, because scraping is commonly restricted at the
 * network layer instead and refusing to serve metrics by default would break every existing
 * Prometheus setup.
 *
 * @param {{config?: Record<string, any>}} [options] Overrides.
 * @returns {(req: any, res: any, next: (err?: any) => void) => void} Express middleware.
 */
export function requireMetricsToken(options = {}) {
  return function requireMetricsTokenMiddleware(req, res, next) {
    const config = options.config ?? getConfig();
    const configured = config.security.metricsToken;
    if (!configured) {
      next();
      return;
    }
    if (timingSafeCompare(extractToken(req), configured)) {
      next();
      return;
    }
    res.setHeader('WWW-Authenticate', 'Bearer');
    next(errors.unauthorized('A valid metrics token is required.'));
  };
}

/**
 * Reject write actions on a node that has no signer or no RPC endpoint.
 *
 * Mounted on every route that would spend gas, so an unconfigured node answers
 * `503 read_only` with a message an operator can act on, instead of an ethers stack trace
 * surfacing as an HTML 500.
 *
 * @param {{config?: Record<string, any>}} [options] Overrides.
 * @returns {(req: any, res: any, next: (err?: any) => void) => void} Express middleware.
 */
export function readOnlyGuard(options = {}) {
  return function readOnlyGuardMiddleware(req, res, next) {
    const config = options.config ?? getConfig();
    if (config.signer.readOnly) {
      next(errors.readOnly());
      return;
    }
    next();
  };
}

/**
 * Reset the once-per-process warning flag. Test-only.
 *
 * @returns {void}
 */
export function resetAuthWarnings() {
  warnedUnauthenticated = false;
}

export default requireApiKey;
