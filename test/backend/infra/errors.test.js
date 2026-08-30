/**
 * The error taxonomy and the terminal error middleware.
 *
 * Three things are proved here:
 *
 * 1. Every error class produces the status, code and `retriable` flag it claims to.
 * 2. `toApiError` normalizes zod, protocol, ethers and body-parser errors, and turns anything it
 *    does not recognise into an opaque 500 rather than leaking an internal message.
 * 3. The middleware emits the exact envelope the frontend parses, and hides stacks in production.
 *
 * A coverage test scans `src/protocol/*.js` for constructed error codes and fails if any of them
 * is missing from `PROTOCOL_ERROR_MAP`, so a new protocol error cannot silently become a 500.
 *
 * @module test/backend/infra/errors.test
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { z } from 'zod';

import {
  AppError,
  ConfigError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PROTOCOL_ERROR_MAP,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
  errors,
  toApiError,
  toFieldError,
} from '../../../src/errors.js';
import { errorHandler, bodyLimitHandler } from '../../../src/middleware/errorHandler.js';
import { requestId } from '../../../src/middleware/requestId.js';
import { CidMismatchError, DecryptionError, KeyError } from '../../../src/protocol/errors.js';

const PROTOCOL_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'src',
  'protocol',
);

/** A logger that records rather than prints. */
function recordingLogger() {
  /** @type {Array<{level: string, record: any, message: string}>} */
  const lines = [];
  /**
   * @param {string} level Level name.
   * @returns {(record: any, message: string) => void} Logging function.
   */
  const at = (level) => (record, message) => lines.push({ level, record, message });
  return { lines, error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') };
}

/**
 * Drive the error middleware with a fake request/response pair.
 *
 * @param {unknown} err Error to handle.
 * @param {{isProduction?: boolean, logger?: any}} [options] Overrides.
 * @returns {{status: number|null, body: any, headers: Record<string, string>, logger: any}}
 *   What the handler produced.
 */
function handle(err, options = {}) {
  const logger = options.logger ?? recordingLogger();
  const config = { app: { isProduction: Boolean(options.isProduction) }, http: {} };

  /** @type {Record<string, string>} */
  const headers = {};
  /** @type {any} */
  let body = null;
  /** @type {number|null} */
  let status = null;

  const res = {
    headersSent: false,
    locals: {},
    /**
     * @param {string} name Header name.
     * @returns {string|undefined} Header value.
     */
    getHeader: (name) => headers[name],
    /**
     * @param {string} name Header name.
     * @param {string} value Header value.
     * @returns {void}
     */
    setHeader: (name, value) => {
      headers[name] = value;
    },
    /**
     * @param {number} code Status code.
     * @returns {any} Chainable response.
     */
    status(code) {
      status = code;
      return res;
    },
    /**
     * @returns {any} Chainable response.
     */
    type() {
      return res;
    },
    /**
     * @param {any} payload Body.
     * @returns {void}
     */
    json(payload) {
      body = payload;
    },
    end() {},
  };

  const req = { headers: {}, method: 'POST', path: '/api/v1/memories' };
  requestId()(req, res, () => {});
  errorHandler({ config, logger })(err, req, res, () => {});
  return { status, body, headers, logger };
}

describe('errors: the class hierarchy', () => {
  /** @type {Array<[AppError, number, string, boolean]>} */
  const cases = [
    [new ValidationError(), 400, 'validation_error', false],
    [new UnauthorizedError(), 401, 'api_key_required', false],
    [new ForbiddenError(), 403, 'forbidden', false],
    [new NotFoundError(), 404, 'not_found', false],
    [new ConflictError(), 409, 'conflict', false],
    [new RateLimitError(30), 429, 'rate_limited', true],
    [new UpstreamError(), 502, 'upstream_error', true],
    [new ServiceUnavailableError(), 503, 'service_unavailable', true],
    [new TimeoutError(), 504, 'upstream_timeout', true],
  ];

  for (const [err, status, code, retriable] of cases) {
    it(`${err.name} is ${status} ${code} (retriable=${retriable})`, () => {
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      assert.equal(err.retriable, retriable);
      assert.ok(err instanceof AppError);
      assert.ok(err instanceof Error);
    });
  }

  it('exposes 4xx and hides 5xx by default', () => {
    assert.equal(new ValidationError().expose, true);
    assert.equal(new AppError('boom').expose, false);
    assert.equal(new UpstreamError().expose, true, 'upstream detail is deliberately exposed');
  });

  it('carries {code, status, message, details, retriable}', () => {
    const err = new ValidationError('nope', [{ path: 'a', code: 'x', message: 'm' }]);
    assert.deepEqual(err.toJSON(), {
      code: 'validation_error',
      message: 'nope',
      details: [{ path: 'a', code: 'x', message: 'm' }],
    });
  });

  it('gives 429 a Retry-After header', () => {
    const err = new RateLimitError(45);
    assert.equal(err.headers?.['Retry-After'], '45');
  });

  it('gives 401 a WWW-Authenticate header', () => {
    assert.equal(new UnauthorizedError().headers?.['WWW-Authenticate'], 'Bearer');
  });

  it('ConfigError is an AppError so it can never render as HTML', () => {
    const err = new ConfigError('bad env', { issues: [] });
    assert.ok(err instanceof AppError);
    assert.equal(err.status, 503);
    assert.equal(err.expose, false);
  });

  it('names every 503 distinctly so an operator knows which dependency failed', () => {
    const codes = [
      errors.notReady({}).code,
      errors.modelNotReady().code,
      errors.chainUnavailable().code,
      errors.contractsIncompatible().code,
      errors.ipfsUnavailable().code,
      errors.readOnly().code,
      errors.insufficientFunds().code,
      errors.overloaded().code,
    ];
    assert.equal(new Set(codes).size, codes.length, 'two 503s share a code');
  });
});

describe('errors: toApiError', () => {
  it('passes an AppError through unchanged', () => {
    const err = new ValidationError();
    assert.equal(toApiError(err), err);
  });

  it('maps a zod error to a 400 with field-level details', () => {
    const result = z.object({ a: z.string() }).safeParse({ a: 1 });
    assert.ok(!result.success);
    const api = toApiError(result.error);
    assert.equal(api.status, 400);
    assert.equal(api.code, 'validation_error');
    assert.ok(Array.isArray(api.details));
  });

  it('maps a protocol CID mismatch to 502, not 400', () => {
    // The pinning service returned bytes that do not hash to the CID it reported. That is an
    // upstream fault; blaming the caller for it would send an operator hunting in the wrong place.
    const api = toApiError(new CidMismatchError('bafk-expected', 'bafk-actual'));
    assert.equal(api.status, 502);
    assert.equal(api.code, 'cid_mismatch');
  });

  it('maps a tag failure to 403 without distinguishing wrong-key from tampered', () => {
    const api = toApiError(
      new DecryptionError('TAG_VERIFY_FAILED', 'authentication tag did not verify'),
    );
    assert.equal(api.status, 403);
    assert.equal(api.code, 'decryption_failed');
    assert.equal(
      toApiError(new DecryptionError('TAG_VERIFY_FAILED', 'x')).code,
      toApiError(new DecryptionError('TAG_VERIFY_FAILED', 'y')).code,
    );
  });

  it('never exposes a key-derivation failure', () => {
    const api = toApiError(new KeyError('DERIVATION_FAILED', 'internal derivation problem'));
    assert.equal(api.status, 500);
    assert.equal(api.expose, false);
  });

  it('maps ethers error codes', () => {
    assert.equal(toApiError({ code: 'INSUFFICIENT_FUNDS' }).code, 'insufficient_funds');
    assert.equal(toApiError({ code: 'NETWORK_ERROR' }).status, 503);
    assert.equal(toApiError({ code: 'NONCE_EXPIRED' }).status, 409);
    assert.equal(toApiError({ code: 'REPLACEMENT_UNDERPRICED' }).code, 'nonce_conflict');
    const reverted = toApiError({ code: 'CALL_EXCEPTION', reason: 'NotRegistered', method: 'x' });
    assert.equal(reverted.status, 502);
    assert.deepEqual(reverted.details, { reason: 'NotRegistered', method: 'x' });
  });

  it('maps body-parser failures', () => {
    assert.equal(toApiError({ type: 'entity.too.large', limit: 100, length: 500 }).status, 413);
    assert.equal(toApiError({ type: 'entity.parse.failed' }).code, 'malformed_json');
    assert.equal(toApiError({ type: 'encoding.unsupported' }).status, 415);
  });

  it('maps an aborted or timed-out operation to 504', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    assert.equal(toApiError(abort).status, 504);
  });

  it('turns anything unrecognised into an opaque 500', () => {
    const api = toApiError(new Error('internal detail nobody should see'));
    assert.equal(api.status, 500);
    assert.equal(api.code, 'internal_error');
    assert.equal(api.expose, false);
    assert.equal(api.message, 'An internal error occurred.');
    assert.equal(api.cause instanceof Error, true);
  });

  it('toFieldError never carries the received value', () => {
    const field = toFieldError({ path: ['a', 0, 'b'], code: 'invalid_type', message: 'nope' });
    assert.deepEqual(field, { path: 'a.0.b', code: 'invalid_type', message: 'nope' });
  });
});

describe('errors: PROTOCOL_ERROR_MAP covers every protocol code', () => {
  it('has an entry for every code constructed in src/protocol', () => {
    /** @type {Set<string>} */
    const codes = new Set();
    for (const file of readdirSync(PROTOCOL_DIR).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(join(PROTOCOL_DIR, file), 'utf8');
      for (const match of source.matchAll(/new [A-Za-z]*Error\(\s*'([A-Z][A-Z0-9_]*)'/g)) {
        codes.add(match[1]);
      }
      // Single-argument subclasses fix their own code inside errors.js; pick those up too.
      for (const match of source.matchAll(/super\(\s*'([A-Z][A-Z0-9_]*)'\s*,/g)) {
        codes.add(match[1]);
      }
    }

    assert.ok(codes.size >= 10, `expected to find protocol codes, found ${codes.size}`);

    const missing = [...codes].filter((code) => !PROTOCOL_ERROR_MAP[code]).sort();
    assert.deepEqual(
      missing,
      [],
      `PROTOCOL_ERROR_MAP is missing: ${missing.join(', ')}. A new protocol error must never ` +
        'silently become an opaque 500.',
    );
  });

  it('gives every mapped code a plausible status', () => {
    for (const [code, mapped] of Object.entries(PROTOCOL_ERROR_MAP)) {
      assert.ok(
        mapped.status >= 400 && mapped.status <= 504,
        `${code} has status ${mapped.status}`,
      );
      assert.equal(typeof mapped.code, 'string');
      assert.equal(typeof mapped.expose, 'boolean');
    }
  });
});

describe('errorHandler: the response envelope', () => {
  it('always emits {error:{code,message,details}, requestId}', () => {
    const { status, body } = handle(new ValidationError('bad', [{ path: 'a' }]));
    assert.equal(status, 400);
    assert.equal(body.error.code, 'validation_error');
    assert.equal(body.error.message, 'bad');
    assert.deepEqual(body.error.details, [{ path: 'a' }]);
    assert.equal(typeof body.requestId, 'string');
    assert.ok(body.requestId.length >= 8);
  });

  it('shapes every error class correctly', () => {
    /** @type {Array<[AppError, number, string]>} */
    const cases = [
      [new ValidationError(), 400, 'validation_error'],
      [new UnauthorizedError(), 401, 'api_key_required'],
      [new ForbiddenError(), 403, 'forbidden'],
      [new NotFoundError(), 404, 'not_found'],
      [new ConflictError(), 409, 'conflict'],
      [new RateLimitError(60), 429, 'rate_limited'],
      [new UpstreamError(), 502, 'upstream_error'],
      [new ServiceUnavailableError(), 503, 'service_unavailable'],
      [new TimeoutError(), 504, 'upstream_timeout'],
    ];
    for (const [err, status, code] of cases) {
      const out = handle(err);
      assert.equal(out.status, status, `${err.name} status`);
      assert.equal(out.body.error.code, code, `${err.name} code`);
    }
  });

  it('applies the headers an error requires', () => {
    assert.equal(handle(new RateLimitError(90)).headers['Retry-After'], '90');
    assert.equal(handle(new UnauthorizedError()).headers['WWW-Authenticate'], 'Bearer');
  });

  it('includes a stack outside production', () => {
    const { body } = handle(new Error('boom'));
    assert.equal(typeof body.error.stack, 'string');
  });

  it('never includes a stack in production', () => {
    const { body } = handle(new Error('boom'), { isProduction: true });
    assert.equal(Object.hasOwn(body.error, 'stack'), false);
  });

  it('never leaks a 5xx message or details in production', () => {
    const { body, status } = handle(new Error('database password is hunter2'), {
      isProduction: true,
    });
    assert.equal(status, 500);
    assert.equal(body.error.message, 'An internal error occurred.');
    assert.equal(body.error.details, null);
    assert.equal(JSON.stringify(body).includes('hunter2'), false);
  });

  it('still exposes a 4xx message in production', () => {
    const { body } = handle(new ValidationError('field x is required'), { isProduction: true });
    assert.equal(body.error.message, 'field x is required');
  });

  it('logs 5xx at error, 429 at warn and other 4xx at info', () => {
    assert.equal(handle(new Error('boom')).logger.lines[0].level, 'error');
    assert.equal(handle(new RateLimitError(1)).logger.lines[0].level, 'warn');
    assert.equal(handle(new ValidationError()).logger.lines[0].level, 'info');
  });

  it('logs a redacted error, never the raw object', () => {
    const raw = Object.assign(new Error('upstream failed'), {
      config: { headers: { Authorization: 'Bearer eyJ-super-secret-jwt' } },
    });
    const { logger } = handle(raw);
    const serialized = JSON.stringify(logger.lines[0]);
    assert.equal(serialized.includes('eyJ-super-secret-jwt'), false);
  });

  it('reports a duration alongside the error', () => {
    const { logger } = handle(new Error('boom'));
    assert.equal(typeof logger.lines[0].record.durationMs, 'number');
  });

  it('delegates to Express when headers are already sent', () => {
    let delegated = null;
    const err = new Error('too late');
    errorHandler({ config: { app: {} }, logger: recordingLogger() })(
      err,
      { headers: {}, id: 'x' },
      { headersSent: true },
      (/** @type {any} */ e) => {
        delegated = e;
      },
    );
    assert.equal(delegated, err);
  });

  it('has arity 4 so Express recognises it as error middleware', () => {
    assert.equal(errorHandler({ config: { app: {} } }).length, 4);
  });
});

describe('bodyLimitHandler', () => {
  it('names both numbers so the message is self-service', () => {
    let captured = null;
    bodyLimitHandler({ http: { bodyLimit: '256kb' } })(
      { type: 'entity.too.large', limit: 262144, length: 412000 },
      { headers: { 'content-length': '412000' } },
      {},
      (/** @type {any} */ err) => {
        captured = err;
      },
    );
    assert.equal(captured.status, 413);
    assert.equal(captured.code, 'payload_too_large');
    assert.match(captured.message, /412000/);
    assert.match(captured.message, /262144/);
  });

  it('passes anything else through untouched', () => {
    const other = new Error('unrelated');
    let captured = null;
    bodyLimitHandler({})(other, { headers: {} }, {}, (/** @type {any} */ e) => {
      captured = e;
    });
    assert.equal(captured, other);
  });
});
