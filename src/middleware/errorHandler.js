/**
 * The single place any error becomes an HTTP response. Always JSON, never a stack in production,
 * always correlated by request id.
 *
 * ## What this replaces
 *
 * v1 registered no error middleware at all. A failure anywhere in `POST /api/memory` - an
 * undefined `context`, a Pinata 429, an RPC nonce error, a reverted transaction - fell through to
 * Express's default handler and produced an HTML page containing a stack trace. The browser then
 * failed to parse it, so what the user saw was a `SyntaxError` in the console and what the
 * frontend reported was nothing at all.
 *
 * ## The shape is a contract
 *
 * ```json
 * { "error": { "code": "...", "message": "...", "details": null }, "requestId": "..." }
 * ```
 *
 * This is exactly what the frontend's `ApiError.fromResponse` parses. Fields are never added,
 * renamed or reordered without changing that too. In non-production `error.stack` is included as
 * an additional field; in production it never is, and a 5xx `message` is replaced by a fixed
 * string so an internal detail cannot reach a client.
 *
 * @module src/middleware/errorHandler
 */
import { errors, toApiError } from '../errors.js';
import { redactError } from '../logger.js';
import { durationMs } from './requestId.js';

/**
 * @typedef {object} ErrorHandlerOptions
 * @property {Record<string, any>} config Application configuration.
 * @property {import('pino').Logger} [logger] Fallback logger for requests with no `req.log`.
 * @property {(err: import('../errors.js').AppError, req: any) => void} [onError] Metrics hook.
 *   Called once per error,
 *   after the status is known and before the response is written.
 */

/**
 * Build the terminal error middleware. Mount it last, exactly once.
 *
 * @param {ErrorHandlerOptions} options Configuration and collaborators.
 * @returns {(err: any, req: any, res: any, next: (err?: any) => void) => void} Express error
 *   middleware. The four-argument arity is load-bearing: Express identifies error middleware by
 *   `fn.length === 4`, so `next` must stay in the signature even though it is used on one path.
 */
export function errorHandler({ config, logger, onError }) {
  const isProduction = Boolean(config?.app?.isProduction);

  return function errorHandlerMiddleware(err, req, res, next) {
    // (1) Headers already sent. Writing a second body corrupts the response, so hand it back to
    //     Express, whose default handler destroys the socket. This is the one case where
    //     re-throwing is correct.
    if (res.headersSent) {
      next(err);
      return;
    }

    try {
      // (2) Normalize. Anything that is not already an AppError becomes one, with the original
      //     attached as `cause` so it is logged but never sent.
      const apiErr = toApiError(err);

      // (3) Apply the headers this error requires (Retry-After, WWW-Authenticate).
      if (apiErr.headers) {
        for (const [name, value] of Object.entries(apiErr.headers)) {
          if (!res.getHeader(name)) res.setHeader(name, value);
        }
      }

      // (4) Log at the level the status deserves. A validation failure is not an operational
      //     event and must not page anyone; a 5xx is, and carries the stack.
      const log = req.log ?? logger;
      if (log) {
        const record = {
          err: redactError(err, !isProduction),
          code: apiErr.code,
          status: apiErr.status,
          requestId: req.id,
          durationMs: durationMs(req),
        };
        if (apiErr.status >= 500) log.error(record, apiErr.message);
        else if (apiErr.status === 429) log.warn(record, apiErr.message);
        else log.info(record, apiErr.message);
      }

      // (5) Metrics. Never allowed to throw into the response path.
      if (onError) {
        try {
          onError(apiErr, req);
        } catch {
          /* a metrics failure must not turn a 400 into a 500 */
        }
      }

      // (6) Respond.
      /** @type {Record<string, any>} */
      const body = {
        error: {
          code: apiErr.code,
          message: apiErr.expose ? apiErr.message : 'An internal error occurred.',
          details: apiErr.expose ? (apiErr.details ?? null) : null,
        },
        requestId: req.id ?? null,
      };
      if (!isProduction && err instanceof Error && err.stack) {
        body.error.stack = err.stack;
      }

      res.status(apiErr.status).type('application/json').json(body);
    } catch (fatal) {
      // An error inside the error handler must still produce a response. Degrade to a bare 500
      // rather than leaving the socket open.
      try {
        (req.log ?? logger)?.error(
          { err: redactError(fatal, !isProduction), requestId: req.id },
          'The error handler itself failed.',
        );
      } catch {
        /* nothing left to do */
      }
      if (!res.headersSent) res.status(500);
      res.end();
    }
  };
}

/**
 * Translate a body-parser `entity.too.large` into a message that names both numbers.
 *
 * Mounted immediately after the JSON body parser. "request entity too large" with no figures in it
 * is a support ticket; "body is 412000 bytes, the limit is 262144" is self-service.
 *
 * @param {Record<string, any>} config Application configuration.
 * @returns {(err: any, req: any, res: any, next: (err?: any) => void) => void} Express error
 *   middleware.
 */
export function bodyLimitHandler(config) {
  return function bodyLimitHandlerMiddleware(err, req, res, next) {
    if (err && err.type === 'entity.too.large') {
      const declared = Number(req.headers?.['content-length']);
      next(
        errors.payloadTooLarge(
          err.limit ?? config?.http?.bodyLimit,
          err.length ?? (Number.isFinite(declared) ? declared : undefined),
        ),
      );
      return;
    }
    next(err);
  };
}

export default errorHandler;
