/**
 * Wrappers that guarantee an async route handler's failure reaches the error middleware, and that
 * no request can hang forever waiting on a dependency.
 *
 * ## Why `asyncHandler` at all under Express 5
 *
 * Express 5 already forwards a rejected promise returned by a handler to `next(err)`, so this
 * wrapper is defensive rather than load-bearing. It is applied uniformly anyway, for three
 * reasons: it makes the contract explicit at the call site; it also covers a handler that returns
 * a non-native thenable, which Express does not special-case; and it makes behaviour identical if
 * any part of this app is ever mounted inside an Express 4 sub-app, where an unhandled rejection
 * silently hangs the request until the client gives up.
 *
 * ## Why `withTimeout`
 *
 * v1 called `await tx.wait()` with no timeout and made axios calls with no timeout. A stuck
 * Sepolia nonce or a hung Pinata connection held the Express request open until the client
 * disconnected, leaking the socket. Every handler that talks to the chain, to IPFS or to the model
 * gets an explicit budget, and exceeding it is a 504 with a code the client can act on.
 *
 * @module src/middleware/asyncHandler
 */
import { errors } from '../errors.js';

/**
 * Wrap an async request handler so a rejection always reaches `next`.
 *
 * @template {(req: any, res: any, next: (err?: any) => void) => any} T
 * @param {T} fn Handler to wrap.
 * @returns {(req: any, res: any, next: (err?: any) => void) => void} Wrapped handler.
 */
export function asyncHandler(fn) {
  return function asyncHandlerWrapper(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Wrap an async request handler with a wall-clock budget.
 *
 * The handler is not cancelled - JavaScript cannot cancel arbitrary work - but the *request* stops
 * waiting, and the client gets a definite answer instead of an open socket. Handlers that own a
 * cancellable resource should also read `req.timeoutSignal`, which this attaches, and pass it to
 * `fetch` or an ethers provider so the underlying work really does stop.
 *
 * @template {(req: any, res: any, next: (err?: any) => void) => any} T
 * @param {T} fn Handler to wrap.
 * @param {number} ms Budget in milliseconds.
 * @param {string} [code] Machine-readable code for the resulting 504.
 * @returns {(req: any, res: any, next: (err?: any) => void) => void} Wrapped handler.
 */
export function withTimeout(fn, ms, code = 'upstream_timeout') {
  return function withTimeoutWrapper(req, res, next) {
    const controller = new AbortController();
    req.timeoutSignal = controller.signal;

    /** @type {NodeJS.Timeout|undefined} */
    let timer;
    const budget = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const err = errors.upstreamTimeout(`The operation did not complete within ${ms} ms.`, {
          timeoutMs: ms,
        });
        err.code = code;
        reject(err);
      }, ms);
    });

    Promise.race([Promise.resolve(fn(req, res, next)), budget])
      .catch(next)
      .finally(() => clearTimeout(timer));
  };
}

export default asyncHandler;
