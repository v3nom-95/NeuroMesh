/**
 * Terminal 404 in the API's error envelope rather than Express's HTML default.
 *
 * ## The one route that gets no hint
 *
 * `SUGGESTIONS` maps a removed v1 path to its replacement, so a client that was written against
 * the old API gets told where the endpoint went instead of a bare 404.
 *
 * `/api/decrypt` is deliberately absent from that map and must never be added. It was an
 * unauthenticated decryption oracle driven by the node's private key, and it is now simply gone:
 * no 410, no alias, no hint, no "use this instead". It returns exactly the same bare 404 as any
 * other unknown path. Pointing whoever is probing it at the authenticated per-CID replacement is
 * not useful to a legitimate client - which reads the OpenAPI document - and is useful to an
 * attacker.
 *
 * @module src/middleware/notFound
 */
import { NotFoundError } from '../errors.js';

/**
 * Removed v1 paths and where their functionality went.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SUGGESTIONS = Object.freeze({
  '/api/status': 'Use GET /api/v1/status',
  '/api/register': 'Use POST /api/v1/agent/register',
  '/api/memory': 'Use POST /api/v1/memories',
  '/api/memories': 'Use GET /api/v1/memories',
  '/api/simulation-results': 'Use GET /api/v1/simulation',
  // '/api/decrypt' is intentionally NOT listed. See the module comment.
});

/**
 * Build the not-found middleware. Mount it after every router and before the error handler.
 *
 * @returns {(req: any, res: any, next: (err?: any) => void) => void} Express middleware.
 */
export function notFound() {
  return function notFoundMiddleware(req, res, next) {
    const path = req.path ?? req.url ?? '';
    const hint = SUGGESTIONS[path];

    next(
      new NotFoundError(`Route ${req.method} ${path} not found.`, {
        details: hint ? { method: req.method, path, hint } : { method: req.method, path },
      }),
    );
  };
}

export default notFound;
