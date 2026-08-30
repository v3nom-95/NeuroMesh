/**
 * The Express application factory. No side effects: no `listen`, no model load, no chain connect.
 *
 * `createApp({services})` is what supertest imports, and `services` is **required** - there is no
 * fallback to a module singleton. That is deliberate: a hidden global is exactly what makes a test
 * suite quietly reach the network, and this suite must run with no `.env`, no private key and no
 * model download.
 *
 * ## Middleware order is load-bearing
 *
 * The numbered comments below are not decoration. Several of these have a wrong order that still
 * appears to work until it is attacked or put behind a proxy:
 *
 *   - `trust proxy` must be set before the rate limiter, or the limiter keys every request behind a
 *     reverse proxy to the proxy's own address and one client can exhaust everyone's budget.
 *   - `requestId` must run before `pino-http`, or no log line carries the id a user quotes.
 *   - The rate limiter must run before the static handler, or an attacker gets unlimited requests
 *     by asking for `/css/base.css`.
 *   - `notFound` then `errorHandler`, last and exactly once.
 *
 * @module src/app
 */
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pinoHttp from 'pino-http';

import { errors } from './errors.js';
import { logger as defaultLogger, httpLoggerOptions } from './logger.js';
import { requireApiKey, requireMetricsToken, readOnlyGuard } from './middleware/auth.js';
import { bodyLimitHandler, errorHandler } from './middleware/errorHandler.js';
import { notFound } from './middleware/notFound.js';
import {
  decryptLimiter,
  globalLimiter,
  searchLimiter,
  writeLimiter,
} from './middleware/rateLimit.js';
import { requestId, durationMs } from './middleware/requestId.js';
import { openApiDocument, renderDocsHtml } from './openapi.js';
import { createApiRouter, createRootRouter } from './routes/index.js';

/**
 * Paths that never see the global rate limiter. An orchestrator's probes are not user traffic, and
 * limiting a scrape endpoint turns a monitoring blip into a monitoring outage.
 */
const UNLIMITED = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * Is this a real pino logger, as opposed to a duck-typed stand-in?
 *
 * @param {any} candidate The logger.
 * @returns {boolean} True when pino-http can be constructed with it.
 */
function isPinoLogger(candidate) {
  return Boolean(candidate?.levels?.values && typeof candidate.child === 'function');
}

/**
 * Build the application.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container from `src/services/index.js`.
 * @param {Record<string, any>} [deps.config] Application config; defaults to `services.config`.
 * @param {any} [deps.logger] Pino logger; defaults to `services.logger`.
 * @returns {import('express').Express} The configured app.
 */
export function createApp({ services, config, logger } = /** @type {any} */ ({})) {
  if (!services) {
    throw new TypeError(
      'createApp({services}) requires a service container. There is no global fallback: a hidden ' +
        'singleton is how a unit test ends up reaching the network.',
    );
  }
  const cfg = config ?? services.config;
  const log = logger ?? services.logger ?? defaultLogger;

  const app = express();

  /* 1. Proxy trust. Set BEFORE the limiter, so the limiter keys on the real client address.
   *    A comment rather than a default of `true`: trusting a forwarded header when there is no
   *    proxy in front lets any client set X-Forwarded-For and mint a fresh rate-limit bucket per
   *    request. TRUST_PROXY is opt-in for exactly that reason. */
  app.set('trust proxy', cfg.http.trustProxy);

  /* 2. Small hardening and parsing defaults. */
  app.disable('x-powered-by');
  app.set('etag', 'strong');
  app.set('query parser', 'simple');
  app.locals.services = services;
  app.locals.config = cfg;
  app.locals.startedAt = Date.now();

  /* 3. Correlation id. Must precede pino-http so every log line carries it. */
  app.use(requestId());

  /* 3b. HTTP duration, recorded once per response.
   *     The listener is registered early but READS the route label late: `res.on('finish')` fires
   *     after routing has resolved `req.route`, so the label is the route PATTERN
   *     (`/api/v1/memories/:cid`) and a probe of an unknown URL is attributed to the single
   *     `unmatched` bucket. Recording `req.originalUrl` would mint one time series per CID and
   *     make the registry unscrapeable. */
  app.use((req, res, next) => {
    res.on('finish', () => {
      const ms = durationMs(req);
      if (ms !== null) services.metrics?.observeHttp?.(req, res, ms);
    });
    next();
  });

  /* 4. Structured request logging, with probe paths silenced.
   *    pino-http reads `logger.levels.values` at construction, so it needs a real pino instance,
   *    not the duck-typed no-op logger a test injects. When `log` is not pino-shaped we hand
   *    pino-http the module's root logger, which is already at level `silent` under test - so the
   *    request-logging middleware is genuinely exercised rather than skipped, and prints nothing. */
  const httpLog = isPinoLogger(log) ? log : defaultLogger;
  app.use(pinoHttp(/** @type {any} */ (httpLoggerOptions(httpLog))));

  /* 5. Security headers.
   *    The CSP has no 'unsafe-inline' anywhere, which is precisely why the dashboard's handlers
   *    are all addEventListener-based and its styles all live in files. connect-src is 'self'
   *    only because this node proxies gateway reads (GET /api/v1/memories/:cid verifies the CID
   *    server-side), so the browser never needs a third-party origin. */
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'font-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          ...(cfg.app.isProduction ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: cfg.app.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  /* 6. Compression. */
  app.use(
    compression({
      threshold: 1024,
      /**
       * @param {any} req Request.
       * @param {any} res Response.
       * @returns {boolean} Whether to compress.
       */
      filter: (req, res) =>
        req.headers['x-no-compression'] ? false : compression.filter(req, res),
    }),
  );

  /* 7. CORS, from an explicit allowlist that is NEVER '*'.
   *    `credentials:false` is deliberate and is what removes CSRF as a class here: this API is
   *    bearer-token authenticated and never cookie authenticated, so a cross-origin page cannot
   *    make an authenticated request by virtue of the browser attaching anything. A request with
   *    no Origin header (curl, a server-side client, a same-origin navigation) is allowed; a
   *    cross-origin request from an unlisted origin gets no CORS headers, which is what makes the
   *    browser refuse it. */
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        return callback(null, cfg.http.corsOrigins.includes(origin));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'X-Request-Id'],
      exposedHeaders: [
        'X-Request-Id',
        'RateLimit-Limit',
        'RateLimit-Remaining',
        'RateLimit-Reset',
        'Retry-After',
        'Location',
      ],
      credentials: false,
      maxAge: 600,
    }),
  );

  /* 8. Body parsing, with a bounded limit and an error handler that names both numbers. */
  app.use(express.json({ limit: cfg.http.bodyLimit, strict: true, type: ['application/json'] }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(bodyLimitHandler(cfg));

  /* 9. The global rate limiter, before static so an asset request is not a free pass. */
  const limiters = {
    global: globalLimiter(cfg),
    write: writeLimiter(cfg),
    search: searchLimiter(cfg),
    decrypt: decryptLimiter(cfg, log),
  };
  app.use((req, res, next) => {
    if (UNLIMITED.has(req.path)) return next();
    return limiters.global(req, res, next);
  });

  /* 10. The OpenAPI document and its HTML view. Declared before static so a file dropped into
   *     public/ can never shadow the API's own description of itself. */
  /**
   * @param {any} _req Request.
   * @param {any} res Response.
   * @returns {void}
   */
  const sendOpenApi = (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').status(200).json(openApiDocument());
  };
  app.get('/openapi.json', sendOpenApi);
  app.get('/api/docs.json', sendOpenApi);
  app.get('/api/v1/openapi.json', sendOpenApi);
  app.get('/docs', (_req, res) => {
    res
      .set('Cache-Control', 'public, max-age=300')
      .type('html')
      .status(200)
      .send(renderDocsHtml(openApiDocument()));
  });

  /* 11. Ops routes at the root: /healthz, /readyz, /metrics. */
  const guards = {
    requireApiKey: requireApiKey({ config: cfg, logger: log }),
    requireMetricsToken: requireMetricsToken({ config: cfg }),
    readOnlyGuard: readOnlyGuard({ config: cfg }),
    writeLimiter: limiters.write,
    searchLimiter: limiters.search,
    decryptLimiter: limiters.decrypt,
  };
  app.use(createRootRouter({ services, config: cfg, guards }));

  /* 12. The API, mounted at the canonical prefix and at the unversioned alias the shipped
   *     dashboard is frozen on. One router instance, so the two surfaces are literally the same
   *     handlers sharing the same limiter buckets and cannot drift apart. */
  const api = createApiRouter({ services, config: cfg, guards });
  app.use('/api/v1', api);
  app.use('/api', api);

  /* 13. Static assets. Mounted AFTER the limiter and the API, with index:false so that `/` is
   *     served explicitly below rather than shadowing anything. */
  app.use(
    express.static(cfg.paths.publicDir, {
      index: false,
      etag: true,
      maxAge: cfg.app.isProduction ? '1h' : 0,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  /* 14. Console fallback. Express 5 removed the string '*' route pattern, so this must be a
   *     RegExp - a common and silent upgrade break. Anything that is not an API path, a probe or
   *     a metrics scrape gets the dashboard's index.html, so a deep link into the console works
   *     on a hard refresh. A missing index.html is a 404 in the API's envelope, not a stack trace. */
  app.get(
    /^(?!\/api(?:\/|$)|\/healthz$|\/readyz$|\/metrics$|\/openapi\.json$|\/docs$).*/,
    (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile('index.html', { root: cfg.paths.publicDir }, (err) => {
        if (err) next(errors.notFound('No console is bundled with this node.'));
      });
    },
  );

  /* 15. Terminal 404 and the single error handler. Always last, always exactly once. */
  app.use(notFound());
  app.use(
    errorHandler({
      config: cfg,
      logger: log,
      onError: (apiErr, req) => services.metrics?.observeError?.(apiErr, req),
    }),
  );

  return app;
}

export default createApp;
