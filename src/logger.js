/**
 * Structured logging with secret redaction, request correlation and per-module children.
 *
 * ## What went wrong before
 *
 * v1 logged with `console.log` and `console.error`. One line was
 * `console.error('Failed to list memories from Pinata:', e.message)`, which is safe only by
 * accident: it takes `.message`. Any later `console.error(e)` on that same axios error, or any
 * logger that serialized the error object, would print `e.config.headers.Authorization` - the full
 * `Bearer eyJ...` Pinata JWT - into stdout, and from there into container logs and log
 * aggregation, where it lives forever.
 *
 * Two mechanisms prevent that here, and both are needed:
 *
 * 1. {@link REDACT_PATHS} - pino's own redaction, covering request headers, outbound client config
 *    headers, and every secret-shaped key by wildcard.
 * 2. {@link redactError} - errors are never handed to the logger whole. They are reduced to
 *    `{name, code, message, stack?}` first, so a library error carrying a `config` or `request`
 *    object cannot smuggle a credential past the path list.
 *
 * `test/backend/infra/logger.test.js` proves the negative: it logs an object containing every
 * secret value and asserts none of them appears in the serialized output.
 *
 * ## `derivationSignature` is redacted, `signature` is not
 *
 * An EIP-712 signature is public - it is published on chain. The signature used to *derive* the
 * encryption keypair (protocol section 2) is equivalent to the encryption private key itself, so
 * `derivationSignature` is redacted while `signature` deliberately is not.
 *
 * @module src/logger
 */
import { pino, stdTimeFunctions, transport as pinoTransport } from 'pino';

import { getConfig } from './config/index.js';

/**
 * Paths pino replaces with `[redacted]` before a record is serialized.
 *
 * Both the exact inbound-request paths and the wildcard forms are listed. The wildcards catch a
 * secret that arrives nested inside some object nobody anticipated; the exact paths are cheaper
 * and cover the common case.
 *
 * @type {ReadonlyArray<string>}
 */
export const REDACT_PATHS = Object.freeze([
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.Authorization',
  'headers["x-api-key"]',
  'config.headers.Authorization',
  'err.config.headers.Authorization',
  'error.config.headers.Authorization',
  'body.privateKey',
  'body.encryptedData',
  '*.PRIVATE_KEY',
  '*.PINATA_JWT',
  '*.API_AUTH_TOKEN',
  '*.MEMORY_ENCRYPTION_KEY',
  '*.METRICS_TOKEN',
  '*.ETHERSCAN_API_KEY',
  '*.privateKey',
  '*.apiToken',
  '*.metricsToken',
  '*.jwt',
  '*.cek',
  '*.secret',
  '*.token',
  '*.password',
  // Equivalent to the encryption private key. `signature` (EIP-712, public) is NOT redacted.
  '*.derivationSignature',
]);

/**
 * Build the root logger.
 *
 * Pretty printing is dev-only and must never be load-bearing: `pino-pretty` is a devDependency, so
 * a production image will not have it. The transport construction is wrapped in a try/catch that
 * degrades to plain JSON on stdout rather than throwing during module evaluation, which would take
 * the whole process down over a missing formatter.
 *
 * @param {Record<string, any>} [cfg] Configuration to build from.
 * @returns {import('pino').Logger} Root logger.
 */
export function createLogger(cfg = getConfig()) {
  /** @type {import('pino').LoggerOptions} */
  const options = {
    // Silent in tests: a unit suite that prints structured JSON for every assertion is unreadable,
    // and the log-redaction test builds its own logger with an explicit destination anyway.
    level: cfg.app.isTest ? 'silent' : cfg.logging.level,
    base: {
      service: 'neuromesh',
      version: cfg.app.version,
      commit: cfg.app.commit,
      env: cfg.app.env,
    },
    timestamp: stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
  };

  if (cfg.logging.pretty && !cfg.app.isProduction && !cfg.app.isTest) {
    try {
      return pino(
        options,
        pinoTransport({
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname,service,version,commit,env',
          },
        }),
      );
    } catch {
      // pino-pretty is a devDependency. Its absence is normal, not an error.
    }
  }

  return pino(options);
}

/** The process-wide root logger. */
export const logger = createLogger();

/**
 * A child logger bound to a module or subsystem.
 *
 * @param {Record<string, unknown>} bindings Fields every line from this child carries.
 * @returns {import('pino').Logger} Child logger.
 */
export function childFor(bindings) {
  return logger.child(bindings);
}

/**
 * Reduce an error to a safe, serializable shape.
 *
 * Never pass a raw error from `fetch`, `ethers` or any client library to a logger. Those objects
 * carry the request that produced them, and the request carries the credential. This keeps four
 * fields and drops everything else; the stack is included only outside production, where it is
 * useful and where log destinations are not shared.
 *
 * @param {unknown} err Anything thrown.
 * @param {boolean} [includeStack] Whether to keep the stack. Defaults to "not in production".
 * @returns {{name: string, code: string|null, message: string, status?: number, stack?: string,
 *   cause?: {name: string, code: string|null, message: string}}} Loggable error.
 */
export function redactError(err, includeStack = !getConfig().app.isProduction) {
  if (!(err instanceof Error)) {
    return { name: 'NonError', code: null, message: String(err) };
  }

  /** @type {any} */
  const any = err;
  /** @type {Record<string, any>} */
  const out = {
    name: err.name,
    code: typeof any.code === 'string' ? any.code : null,
    message: err.message,
  };
  if (typeof any.status === 'number') out.status = any.status;
  if (includeStack && err.stack) out.stack = err.stack;

  const cause = any.cause;
  if (cause instanceof Error) {
    out.cause = {
      name: cause.name,
      code:
        typeof (/** @type {any} */ (cause).code) === 'string'
          ? /** @type {any} */ (cause).code
          : null,
      message: cause.message,
    };
  }

  return /** @type {any} */ (out);
}

/**
 * Options for `pino-http`.
 *
 * Kept as a plain factory rather than instantiating `pino-http` here so that `src/app.js` decides
 * when the middleware is created and with which logger, and so this module has no dependency on
 * `pino-http` at import time.
 *
 * Three deliberate choices:
 *
 * - `genReqId` reads `req.id`, which `requestId()` has already set. That middleware must run first
 *   or every log line loses its correlation id.
 * - Probe endpoints log at `silent`. A `/healthz` every second otherwise drowns everything else.
 * - `customProps` records *whether* an API key was used, never which one.
 *
 * @param {import('pino').Logger} [base] Logger to attach.
 * @returns {Record<string, any>} Options object for `pinoHttp(options)`.
 */
export function httpLoggerOptions(base = logger) {
  const PROBE_PATHS = new Set([
    '/healthz',
    '/readyz',
    '/metrics',
    '/api/v1/health',
    '/api/v1/ready',
  ]);

  return {
    logger: base,
    genReqId: (/** @type {any} */ req) => req.id,
    customLogLevel: (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ err) => {
      const path = (req.url ?? '').split('?')[0];
      if (PROBE_PATHS.has(path)) return 'silent';
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode === 429) return 'warn';
      if (res.statusCode >= 400) return 'info';
      return 'info';
    },
    customProps: (/** @type {any} */ req) => ({
      requestId: req.id,
      apiKeyUsed: Boolean(req.auth?.ok),
    }),
    autoLogging: {
      ignore: (/** @type {any} */ req) => PROBE_PATHS.has((req.url ?? '').split('?')[0]),
    },
    serializers: {
      req: (/** @type {any} */ req) => ({
        id: req.id,
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
      }),
      res: (/** @type {any} */ res) => ({ statusCode: res.statusCode }),
      err: (/** @type {any} */ err) => redactError(err),
    },
  };
}

export default logger;
