/**
 * zod validation of `body`, `query`, `params` and `headers`, producing one canonical 400 shape.
 *
 * ## What this replaces
 *
 * v1's `POST /api/memory` did `const { context } = req.body;` and nothing else. Three concrete
 * failures followed from that single line: `undefined` reached the embedding extractor and threw;
 * an *array* was silently treated as a batch, producing a 768- or 1920-float vector while the
 * chain record still hardcoded `embeddingDim: 384`, a permanent false record; and a 90 KB string
 * passed the body parser, got truncated to the model's 256-token window, and produced a vector
 * that did not represent the text it claimed to.
 *
 * ## Design decisions worth stating
 *
 * - **Every part is validated before any part fails.** A client sees all its problems at once
 *   rather than one per round trip.
 * - **Values are never echoed.** An issue is `{path, code, message}`. The received value may be a
 *   secret or a 256 KB blob, and putting it in a response body (or a log) is how both leak.
 * - **Objects should be `.strict()`.** An unknown field is a 400, not a silent drop. That is
 *   precisely what would have caught the `raw_context` drift, where the client read a field the
 *   server had never written and rendered fallback text forever with no error anywhere.
 * - **An absent body parses as `{}`.** `express.json({type: ['application/json']})` does not run
 *   when a request has no `Content-Type`, so `req.body` is `undefined` in Express 5. Without this
 *   default, `POST /memories/:cid/decrypt` - whose body schema is deliberately an empty strict
 *   object, because the endpoint must never accept caller-supplied ciphertext - would reject every
 *   valid call with `invalid_type`.
 * - **Parsed query goes to `req.validatedQuery`.** Express 5 makes `req.query` a getter, so
 *   assigning to it throws.
 *
 * @module src/middleware/validate
 */
import { errors, toFieldError } from '../errors.js';

/**
 * @typedef {object} ValidateSchemas
 * @property {{safeParseAsync: (v: unknown) => Promise<any>}} [body] Schema for the request body.
 * @property {{safeParseAsync: (v: unknown) => Promise<any>}} [query] Schema for the query string.
 * @property {{safeParseAsync: (v: unknown) => Promise<any>}} [params] Schema for route params.
 * @property {{safeParseAsync: (v: unknown) => Promise<any>}} [headers] Schema for headers.
 */

/**
 * Build a validation middleware.
 *
 * @param {ValidateSchemas} [schemas] Schemas to apply, by request part.
 * @returns {(req: any, res: any, next: (err?: any) => void) => Promise<void>} Express middleware.
 */
export function validate(schemas = {}) {
  return async function validateMiddleware(req, res, next) {
    /** @type {Array<{path: string, code: string, message: string}>} */
    const issues = [];
    /** @type {Record<string, unknown>} */
    const parsed = {};

    /** @type {Array<[keyof ValidateSchemas, unknown]>} */
    const parts = [
      ['body', req.body ?? {}],
      ['query', req.query ?? {}],
      ['params', req.params ?? {}],
      ['headers', req.headers ?? {}],
    ];

    for (const [part, value] of parts) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = await schema.safeParseAsync(value);
      if (result.success) {
        parsed[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          const field = toFieldError(issue);
          issues.push({ ...field, path: field.path ? `${part}.${field.path}` : part });
        }
      }
    }

    if (issues.length > 0) {
      next(errors.validation(issues));
      return;
    }

    // Replace each part with the parsed output so downstream code sees coerced, defaulted and
    // stripped values rather than raw strings.
    if ('body' in parsed) req.body = parsed.body;
    if ('params' in parsed) req.params = parsed.params;
    if ('headers' in parsed) req.validatedHeaders = parsed.headers;
    // Express 5: req.query is a getter with no setter. Assigning to it throws in strict mode.
    if ('query' in parsed) req.validatedQuery = parsed.query;

    next();
  };
}

/**
 * Validate an outgoing response body against its published schema.
 *
 * This is the mechanism that turns a frontend/backend contract drift into a failing test instead
 * of a blank card in the UI. It is enabled in development and test and disabled in production: a
 * bug in a response schema must never fail a real user's request.
 *
 * @param {{safeParse: (v: unknown) => any}} schema Response schema.
 * @param {Record<string, any>} [cfg] Configuration (only `app.isProduction` is read).
 * @returns {(req: any, res: any, next: (err?: any) => void) => void} Express middleware.
 */
export function validateResponse(schema, cfg = { app: { isProduction: false } }) {
  return function validateResponseMiddleware(req, res, next) {
    if (cfg.app?.isProduction) {
      next();
      return;
    }

    const originalJson = res.json.bind(res);
    /**
     * @param {unknown} body Response body.
     * @returns {any} Whatever `res.json` returns.
     */
    res.json = (body) => {
      const result = schema.safeParse(body);
      if (!result.success) {
        throw new Error(
          `Response body does not match its published schema for ${req.method} ${req.path}: ` +
            JSON.stringify(result.error.issues.map(toFieldError)),
        );
      }
      return originalJson(body);
    };

    next();
  };
}

export default validate;
