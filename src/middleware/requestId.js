/**
 * Correlation id on every request and every response.
 *
 * Without this, no log line can be tied to a client's bug report and no error envelope can be
 * traced. It must run before `pino-http`, because `genReqId` reads `req.id`.
 *
 * An inbound `X-Request-Id` is honoured so a trace can span a proxy, but only when it matches a
 * strict character class. An unvalidated header echoed into a response is a header-injection sink,
 * and an unbounded one is a cheap way to bloat every log line in the system.
 *
 * @module src/middleware/requestId
 */
import { randomUUID } from 'node:crypto';

/** Conservative: alphanumerics and `.`, `_`, `-` only. No CR, no LF, no spaces, no colons. */
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * @typedef {object} RequestIdOptions
 * @property {string} [header] Header to read and write. Defaults to `x-request-id`.
 * @property {number} [maxLength] Maximum accepted inbound length. Defaults to 64.
 */

/**
 * Build the request-id middleware.
 *
 * @param {RequestIdOptions} [options] Overrides.
 * @returns {(req: any, res: any, next: (err?: any) => void) => void} Express middleware.
 */
export function requestId(options = {}) {
  const header = (options.header ?? 'x-request-id').toLowerCase();
  const maxLength = options.maxLength ?? 64;

  return function requestIdMiddleware(req, res, next) {
    const inbound = req.headers?.[header];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;

    const id =
      typeof candidate === 'string' && candidate.length <= maxLength && SAFE_ID.test(candidate)
        ? candidate
        : randomUUID();

    req.id = id;
    res.locals = res.locals ?? {};
    res.locals.requestId = id;
    res.setHeader('X-Request-Id', id);

    // Read the clock once, here, so the error handler and the metrics hook can both report a
    // duration without a second syscall and without disagreeing about when the request started.
    req.startedAt = process.hrtime.bigint();

    next();
  };
}

/**
 * Milliseconds elapsed since {@link requestId} stamped the request.
 *
 * @param {any} req Express request.
 * @returns {number|null} Duration in milliseconds, or `null` when the request was never stamped.
 */
export function durationMs(req) {
  if (typeof req?.startedAt !== 'bigint') return null;
  return Number(process.hrtime.bigint() - req.startedAt) / 1e6;
}

export default requestId;
