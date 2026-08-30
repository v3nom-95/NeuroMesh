/**
 * Tiered rate limiting: generous for reads, tight for writes, tighter still for decryption.
 *
 * ## Why tiers rather than one bucket
 *
 * The routes do not cost the same thing. A `GET /api/v1/status` costs microseconds. A
 * `POST /api/v1/memories` costs an embedding inference, an IPFS pin that is billed, and a Sepolia
 * transaction paid for out of the node's wallet. A single global limit generous enough for the
 * dashboard's polling is far too generous to sit between the internet and 0.27 ETH.
 *
 * Four buckets:
 *
 * - {@link globalLimiter}   every request, generous, skips the ops probes.
 * - {@link writeLimiter}    the routes that spend gas or pay for a pin.
 * - {@link searchLimiter}   `POST /search`, because each call runs a model inference.
 * - {@link decryptLimiter}  the per-CID unwrap, tightest of all, with an audit line per call.
 *
 * ## IPv6
 *
 * Keying on a bare `req.ip` lets an IPv6 client walk its own /64 and get a fresh bucket for every
 * request, which is free and unlimited. `express-rate-limit` exports `ipKeyGenerator`, which
 * normalizes an IPv6 address to its /56 prefix; every key generator here builds on it.
 *
 * ## Honest limitation
 *
 * The store is the library's in-memory default. It is **per process**. Two replicas behind a load
 * balancer therefore enforce two independent limits, and the effective limit is `N x max`. A Redis
 * store is required for a real multi-instance deployment. This is stated plainly rather than
 * implied away, because a rate limit that quietly does not hold is worse than none: it produces
 * the belief that the wallet is protected when it is not.
 *
 * @module src/middleware/rateLimit
 */
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

import { getConfig } from '../config/index.js';
import { errors } from '../errors.js';

/**
 * Should limiting be skipped entirely?
 *
 * Tests disable the limiters by default - a suite that shares one process would otherwise poison
 * later cases with earlier cases' counters - and re-enable them explicitly with `RATE_LIMIT_TEST=1`
 * in the one suite that asserts on limiting behaviour.
 *
 * @param {Record<string, any>} config Application configuration.
 * @returns {boolean} True when limiting is disabled for this process.
 */
function limitingDisabled(config) {
  return config.app.isTest && process.env.RATE_LIMIT_TEST !== '1';
}

/** Paths that must never be rate limited: an orchestrator's probes are not user traffic. */
const PROBE_PATHS = new Set([
  '/healthz',
  '/readyz',
  '/metrics',
  '/api/v1/health',
  '/api/v1/ready',
  '/api/v1/healthz',
  '/api/v1/readyz',
]);

/**
 * Key by API token when one was presented, else by normalized IP.
 *
 * Keying an authenticated request by its token means one operator behind a busy NAT cannot be
 * starved by a noisy neighbour sharing the address. The token is hashed into the key indirectly -
 * `req.auth.ok` is checked first, so an *invalid* token never gets its own bucket, which would
 * otherwise let an attacker escape the IP bucket by inventing tokens.
 *
 * @param {any} req Express request.
 * @returns {string} Bucket key.
 */
function keyByApiKeyOrIp(req) {
  if (req.auth?.ok && req.auth.mode === 'api-key') {
    const header = req.headers?.['x-api-key'] ?? req.headers?.authorization ?? '';
    const token = Array.isArray(header) ? header[0] : header;
    // The value is only ever used as a map key inside this process, never logged or returned.
    return `key:${token}`;
  }
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

/**
 * Build one limiter.
 *
 * @param {object} args Arguments.
 * @param {number} args.max Requests per window.
 * @param {Record<string, any>} args.config Application configuration.
 * @param {(req: any) => string} [args.keyGenerator] Bucket key function.
 * @param {(req: any) => boolean} [args.skip] Extra skip predicate.
 * @param {(req: any) => void} [args.audit] Called once per permitted request.
 * @returns {import('express').RequestHandler} Middleware.
 */
function build({ max, config, keyGenerator, skip, audit }) {
  const windowMs = config.security.rateLimit.windowMs;
  const disabled = limitingDisabled(config);

  const limiter = rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyGenerator ?? ((req) => `ip:${ipKeyGenerator(req.ip ?? '')}`),
    skip: (req) => disabled || PROBE_PATHS.has(req.path) || (skip ? skip(req) : false),
    handler: (_req, _res, next, opts) => {
      next(errors.rateLimited(Math.ceil(opts.windowMs / 1000)));
    },
  });

  if (!audit) return limiter;

  return function auditedLimiter(req, res, next) {
    audit(req);
    limiter(req, res, next);
  };
}

/**
 * Every request. Generous enough for the dashboard's polling.
 *
 * @param {Record<string, any>} [config] Configuration override.
 * @returns {import('express').RequestHandler} Middleware.
 */
export function globalLimiter(config = getConfig()) {
  return build({ max: config.security.rateLimit.max, config });
}

/**
 * The routes that spend gas or pay for a pin.
 *
 * Applied to `POST /agent/register`, `POST /memories`, `POST /reputation/endorse`,
 * `POST /reputation/report` and `POST /memories/:cid/decrypt`. This is the bucket that stands
 * between the internet and the node's wallet.
 *
 * @param {Record<string, any>} [config] Configuration override.
 * @returns {import('express').RequestHandler} Middleware.
 */
export function writeLimiter(config = getConfig()) {
  return build({
    max: config.security.rateLimit.writeMax,
    config,
    keyGenerator: keyByApiKeyOrIp,
  });
}

/**
 * `POST /search`. Each call runs an embedding inference through a concurrency-1 queue.
 *
 * @param {Record<string, any>} [config] Configuration override.
 * @returns {import('express').RequestHandler} Middleware.
 */
export function searchLimiter(config = getConfig()) {
  return build({
    max: config.security.rateLimit.searchMax,
    config,
    keyGenerator: keyByApiKeyOrIp,
  });
}

/**
 * The per-CID unwrap. Tighter than writes, and audited.
 *
 * Every permitted call is logged with the request id, the caller's key mode and the CID, because
 * "who decrypted what, when" is the question an operator will actually be asked. The v1 endpoint
 * this replaces had no auth, no limit and no record of any kind.
 *
 * @param {Record<string, any>} [config] Configuration override.
 * @param {import('pino').Logger} [logger] Logger for the audit line.
 * @returns {import('express').RequestHandler} Middleware.
 */
export function decryptLimiter(config = getConfig(), logger) {
  return build({
    max: config.security.rateLimit.decryptMax,
    config,
    keyGenerator: keyByApiKeyOrIp,
    audit: (req) => {
      (req.log ?? logger)?.info(
        {
          requestId: req.id,
          cid: req.params?.cid ?? null,
          authMode: req.auth?.mode ?? null,
          event: 'decrypt_attempt',
        },
        'Per-CID unwrap requested.',
      );
    },
  });
}

export default globalLimiter;
