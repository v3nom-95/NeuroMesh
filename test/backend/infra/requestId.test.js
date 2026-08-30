/**
 * Request correlation and the not-found envelope.
 *
 * @module test/backend/infra/requestId.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { durationMs, requestId } from '../../../src/middleware/requestId.js';
import { SUGGESTIONS, notFound } from '../../../src/middleware/notFound.js';
import { asyncHandler, withTimeout } from '../../../src/middleware/asyncHandler.js';
import { NotFoundError, TimeoutError } from '../../../src/errors.js';

/**
 * Run a middleware against fake request and response objects.
 *
 * @param {any} middleware Middleware under test.
 * @param {Record<string, any>} [req] Request stub.
 * @returns {{req: any, headers: Record<string, string>, error: any}} What happened.
 */
function run(middleware, req = {}) {
  const request = { headers: {}, method: 'GET', path: '/', ...req };
  /** @type {Record<string, string>} */
  const headers = {};
  const res = {
    locals: {},
    /**
     * @param {string} n Header name.
     * @param {string} v Header value.
     * @returns {void}
     */
    setHeader: (n, v) => {
      headers[n] = v;
    },
  };
  /** @type {any} */
  let error = null;
  middleware(request, res, (/** @type {any} */ err) => {
    error = err ?? null;
  });
  return { req: request, headers, error };
}

describe('requestId', () => {
  it('generates a uuid when no header is present', () => {
    const { req, headers } = run(requestId());
    assert.match(req.id, /^[0-9a-f-]{36}$/);
    assert.equal(headers['X-Request-Id'], req.id);
  });

  it('honours a well-formed inbound id so a trace can span a proxy', () => {
    const { req } = run(requestId(), { headers: { 'x-request-id': 'abc-123_XYZ.9' } });
    assert.equal(req.id, 'abc-123_XYZ.9');
  });

  it('rejects an id carrying header-injection characters', () => {
    const injected = 'abcdefgh\r\nX-Admin: true';
    const { req, headers } = run(requestId(), { headers: { 'x-request-id': injected } });
    assert.notEqual(req.id, injected);
    assert.equal(headers['X-Request-Id'].includes('\r'), false);
    assert.equal(headers['X-Request-Id'].includes('\n'), false);
  });

  it('rejects an unbounded id', () => {
    const { req } = run(requestId(), { headers: { 'x-request-id': 'a'.repeat(4096) } });
    assert.ok(req.id.length <= 64);
  });

  it('rejects an id that is too short to be a real correlation id', () => {
    const { req } = run(requestId(), { headers: { 'x-request-id': 'abc' } });
    assert.notEqual(req.id, 'abc');
  });

  it('takes the first value of a repeated header', () => {
    const { req } = run(requestId(), { headers: { 'x-request-id': ['first-id-value', 'second'] } });
    assert.equal(req.id, 'first-id-value');
  });

  it('mirrors the id into res.locals for the error handler', () => {
    const request = { headers: {} };
    /** @type {any} */
    const res = { locals: {}, setHeader() {} };
    requestId()(request, res, () => {});
    assert.equal(res.locals.requestId, /** @type {any} */ (request).id);
  });

  it('stamps a monotonic start time exactly once', () => {
    const { req } = run(requestId());
    assert.equal(typeof req.startedAt, 'bigint');
    const d = durationMs(req);
    assert.ok(typeof d === 'number' && d >= 0);
  });

  it('reports a null duration for an unstamped request', () => {
    assert.equal(durationMs({}), null);
    assert.equal(durationMs(undefined), null);
  });
});

describe('notFound', () => {
  it('produces a 404 in the API envelope, not Express HTML', () => {
    const { error } = run(notFound(), { method: 'GET', path: '/api/v1/nope' });
    assert.ok(error instanceof NotFoundError);
    assert.equal(error.status, 404);
    assert.equal(error.code, 'not_found');
    assert.deepEqual(error.details, { method: 'GET', path: '/api/v1/nope' });
  });

  it('points a v1 client at the replacement route', () => {
    const { error } = run(notFound(), { method: 'POST', path: '/api/memory' });
    assert.equal(error.details.hint, 'Use POST /api/v1/memories');
  });

  it('gives /api/decrypt a bare 404 with no hint whatsoever', () => {
    // The removed route was an unauthenticated decryption oracle driven by the node's private
    // key. It gets exactly the same answer as any unknown path: telling whoever is probing where
    // the replacement lives helps nobody who is entitled to know.
    const { error } = run(notFound(), { method: 'POST', path: '/api/decrypt' });
    assert.equal(error.status, 404);
    assert.equal(error.details.hint, undefined);
    assert.equal(Object.hasOwn(SUGGESTIONS, '/api/decrypt'), false);
    assert.equal(JSON.stringify(error.details).toLowerCase().includes('decrypt'), true);
    assert.equal(JSON.stringify(error.details).includes('/api/v1/memories'), false);
  });
});

describe('asyncHandler', () => {
  it('routes a rejection to next', async () => {
    const boom = new Error('boom');
    /** @type {any} */
    let captured = null;
    await new Promise((resolve) => {
      asyncHandler(async () => {
        throw boom;
      })({}, {}, (/** @type {any} */ err) => {
        captured = err;
        resolve(undefined);
      });
    });
    assert.equal(captured, boom);
  });

  it('routes a rejected non-native thenable to next', async () => {
    /** @type {any} */
    let captured = null;
    await new Promise((resolve) => {
      asyncHandler(() => ({
        /**
         * @param {(v: unknown) => void} _ok Resolve.
         * @param {(e: unknown) => void} fail Reject.
         * @returns {void}
         */
        then(_ok, fail) {
          fail(new Error('thenable failure'));
        },
      }))({}, {}, (/** @type {any} */ err) => {
        captured = err;
        resolve(undefined);
      });
    });
    assert.match(captured.message, /thenable failure/);
  });

  it('does not call next when the handler resolves', async () => {
    let calls = 0;
    await new Promise((resolve) => {
      asyncHandler(async () => {})({}, {}, () => {
        calls += 1;
      });
      setTimeout(resolve, 5);
    });
    assert.equal(calls, 0);
  });
});

describe('withTimeout', () => {
  it('turns a hung handler into a 504 instead of an open socket', async () => {
    /** @type {any} */
    let captured = null;
    const req = {};
    await new Promise((resolve) => {
      withTimeout(() => new Promise(() => {}), 10)(req, {}, (/** @type {any} */ err) => {
        captured = err;
        resolve(undefined);
      });
    });
    assert.ok(captured instanceof TimeoutError);
    assert.equal(captured.status, 504);
    assert.equal(captured.retriable, true);
  });

  it('aborts the signal it hands the handler', async () => {
    /** @type {any} */
    const req = {};
    await new Promise((resolve) => {
      withTimeout(() => new Promise(() => {}), 10)(req, {}, () => resolve(undefined));
    });
    assert.equal(req.timeoutSignal.aborted, true);
  });

  it('lets a fast handler finish untouched', async () => {
    let called = false;
    await new Promise((resolve) => {
      withTimeout(async () => {
        called = true;
      }, 1000)({}, {}, () => {});
      setTimeout(resolve, 20);
    });
    assert.equal(called, true);
  });
});
