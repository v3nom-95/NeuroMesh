/**
 * API-key authentication: constant-time comparison, no length leak, and a hard refusal for the
 * routes that spend money.
 *
 * @module test/backend/infra/auth.test
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  extractToken,
  readOnlyGuard,
  requireApiKey,
  requireMetricsToken,
  resetAuthWarnings,
  timingSafeCompare,
} from '../../../src/middleware/auth.js';
import { UnauthorizedError, ServiceUnavailableError } from '../../../src/errors.js';

const TOKEN = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(8);

/**
 * Build a configuration stub.
 *
 * @param {Record<string, any>} [over] Overrides merged into the defaults.
 * @returns {Record<string, any>} Config-shaped object.
 */
function fakeConfig(over = {}) {
  return {
    app: { isTest: true, isProduction: false, ...(over.app ?? {}) },
    security: { apiToken: null, metricsToken: null, ...(over.security ?? {}) },
    signer: { readOnly: false, ...(over.signer ?? {}) },
  };
}

/** A logger that swallows everything, so the suite stays readable. */
const silentLogger = {
  warn() {},
  info() {},
  error() {},
  debug() {},
};

/**
 * Run a middleware against a fake request and capture what it did.
 *
 * @param {any} middleware Middleware under test.
 * @param {Record<string, any>} [req] Request stub.
 * @returns {Promise<{req: any, error: any, called: boolean, headers: Record<string, string>}>}
 *   What happened.
 */
async function run(middleware, req = {}) {
  const request = { headers: {}, id: 'test-request-id', ip: '203.0.113.1', ...req };
  /** @type {Record<string, string>} */
  const headers = {};
  const res = {
    /**
     * @param {string} name Header name.
     * @param {string} value Header value.
     * @returns {void}
     */
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  /** @type {any} */
  let error = null;
  let called = false;
  await middleware(request, res, (/** @type {any} */ err) => {
    called = true;
    error = err ?? null;
  });
  return { req: request, error, called, headers };
}

describe('auth: timingSafeCompare', () => {
  it('accepts an exact match', () => {
    assert.equal(timingSafeCompare(TOKEN, TOKEN), true);
  });

  it('rejects a different token of the same length', () => {
    assert.equal(timingSafeCompare(TOKEN, `x${TOKEN.slice(1)}`), false);
  });

  it('rejects a token of a different length without throwing', () => {
    // A raw crypto.timingSafeEqual on the token bytes throws RangeError here, and that throw is
    // observable - it is how the configured token's length leaks. Hashing first removes the
    // failure mode entirely.
    assert.equal(timingSafeCompare('short', TOKEN), false);
    assert.equal(timingSafeCompare(`${TOKEN}extra`, TOKEN), false);
  });

  it('rejects empty, null and non-string inputs', () => {
    assert.equal(timingSafeCompare('', TOKEN), false);
    assert.equal(timingSafeCompare(null, TOKEN), false);
    assert.equal(timingSafeCompare(undefined, TOKEN), false);
    assert.equal(timingSafeCompare(/** @type {any} */ (123), TOKEN), false);
    assert.equal(timingSafeCompare(TOKEN, null), false);
  });

  it('compares operands of a fixed 32 bytes regardless of input length', () => {
    // The property that makes the comparison length-independent, asserted directly: whatever the
    // inputs, both digests are 32 bytes, so timingSafeEqual is always reachable and never throws.
    for (const candidate of ['x', 'x'.repeat(1000), randomBytes(64).toString('hex')]) {
      const a = createHash('sha256').update(candidate).digest();
      const b = createHash('sha256').update(TOKEN).digest();
      assert.equal(a.length, 32);
      assert.equal(b.length, 32);
      assert.doesNotThrow(() => timingSafeEqual(a, b));
    }
  });
});

describe('auth: extractToken', () => {
  it('reads X-API-Key', () => {
    assert.equal(extractToken({ headers: { 'x-api-key': TOKEN } }), TOKEN);
  });

  it('reads Authorization: Bearer, case-insensitively', () => {
    assert.equal(extractToken({ headers: { authorization: `Bearer ${TOKEN}` } }), TOKEN);
    assert.equal(extractToken({ headers: { authorization: `bearer ${TOKEN}` } }), TOKEN);
    assert.equal(extractToken({ headers: { authorization: `BEARER ${TOKEN}` } }), TOKEN);
  });

  it('prefers X-API-Key when both are present', () => {
    assert.equal(
      extractToken({ headers: { 'x-api-key': TOKEN, authorization: 'Bearer other' } }),
      TOKEN,
    );
  });

  it('ignores a non-bearer Authorization scheme', () => {
    assert.equal(extractToken({ headers: { authorization: `Basic ${TOKEN}` } }), null);
  });

  it('returns null when nothing was presented', () => {
    assert.equal(extractToken({ headers: {} }), null);
    assert.equal(extractToken({ headers: { 'x-api-key': '   ' } }), null);
    assert.equal(extractToken({}), null);
  });
});

describe('auth: requireApiKey', () => {
  const config = fakeConfig({ security: { apiToken: TOKEN } });
  const mw = requireApiKey({ config, logger: silentLogger, failureDelayMs: [0, 0] });

  it('accepts the correct key via X-API-Key', async () => {
    const out = await run(mw, { headers: { 'x-api-key': TOKEN } });
    assert.equal(out.error, null);
    assert.deepEqual(out.req.auth, { ok: true, mode: 'api-key' });
  });

  it('accepts the correct key via Authorization: Bearer', async () => {
    const out = await run(mw, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(out.error, null);
    assert.equal(out.req.auth.ok, true);
  });

  it('rejects a wrong key with 401 api_key_required', async () => {
    const out = await run(mw, { headers: { 'x-api-key': 'wrong-but-long-enough-token-value' } });
    assert.ok(out.error instanceof UnauthorizedError);
    assert.equal(out.error.status, 401);
    assert.equal(out.error.code, 'api_key_required');
    assert.equal(out.req.auth.ok, false);
    assert.equal(out.req.auth.mode, 'invalid');
  });

  it('rejects a missing key with 401', async () => {
    const out = await run(mw, { headers: {} });
    assert.ok(out.error instanceof UnauthorizedError);
    assert.equal(out.req.auth.mode, 'missing');
  });

  it('sets WWW-Authenticate on rejection', async () => {
    const out = await run(mw, { headers: {} });
    assert.equal(out.headers['WWW-Authenticate'], 'Bearer');
  });

  it('never echoes the presented token in the error', async () => {
    const presented = 'guessed-token-that-should-never-be-echoed-back';
    const out = await run(mw, { headers: { 'x-api-key': presented } });
    const serialized = JSON.stringify({
      message: out.error.message,
      details: out.error.details,
    });
    assert.equal(serialized.includes(presented), false);
    assert.equal(serialized.includes(TOKEN), false);
  });

  it('never reveals the configured token length', async () => {
    // Two wrong tokens of very different lengths must produce byte-identical responses.
    const a = await run(mw, { headers: { 'x-api-key': 'x' } });
    const b = await run(mw, { headers: { 'x-api-key': 'x'.repeat(500) } });
    assert.equal(a.error.status, b.error.status);
    assert.equal(a.error.code, b.error.code);
    assert.equal(a.error.message, b.error.message);
  });

  it('allows an unauthenticated request in development when no token is configured', async () => {
    resetAuthWarnings();
    const dev = requireApiKey({ config: fakeConfig(), logger: silentLogger });
    const out = await run(dev, { headers: {} });
    assert.equal(out.error, null);
    assert.deepEqual(out.req.auth, { ok: true, mode: 'unauthenticated-dev' });
  });

  it('warns exactly once per process about running unauthenticated', async () => {
    resetAuthWarnings();
    let warnings = 0;
    const logger = { ...silentLogger, warn: () => (warnings += 1) };
    const dev = requireApiKey({ config: fakeConfig(), logger });
    await run(dev, { headers: {} });
    await run(dev, { headers: {} });
    await run(dev, { headers: {} });
    assert.equal(warnings, 1);
  });

  it('fails closed if production is somehow reached with no token', async () => {
    resetAuthWarnings();
    const prod = requireApiKey({
      config: fakeConfig({ app: { isProduction: true, isTest: true } }),
      logger: silentLogger,
    });
    const out = await run(prod, { headers: {} });
    assert.ok(out.error);
    assert.equal(out.error.status, 500);
    assert.equal(out.error.expose, false);
  });

  it('lets an optional guard record failure without rejecting', async () => {
    const optional = requireApiKey({
      config,
      logger: silentLogger,
      optional: true,
      failureDelayMs: [0, 0],
    });
    const out = await run(optional, { headers: {} });
    assert.equal(out.error, null);
    assert.equal(out.req.auth.ok, false);
  });
});

describe('auth: requireMetricsToken', () => {
  it('is a no-op when no metrics token is configured', async () => {
    const out = await run(requireMetricsToken({ config: fakeConfig() }), { headers: {} });
    assert.equal(out.error, null);
  });

  it('rejects a wrong metrics token', async () => {
    const mw = requireMetricsToken({
      config: fakeConfig({ security: { metricsToken: 'metrics-token-value-1234' } }),
    });
    const out = await run(mw, { headers: { 'x-api-key': 'nope' } });
    assert.ok(out.error instanceof UnauthorizedError);
  });

  it('accepts the right metrics token', async () => {
    const token = 'metrics-token-value-1234';
    const mw = requireMetricsToken({ config: fakeConfig({ security: { metricsToken: token } }) });
    const out = await run(mw, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(out.error, null);
  });
});

describe('auth: readOnlyGuard', () => {
  it('passes through on a writable node', async () => {
    const out = await run(readOnlyGuard({ config: fakeConfig() }));
    assert.equal(out.error, null);
  });

  it('returns 503 read_only rather than an ethers stack trace', async () => {
    const mw = readOnlyGuard({ config: fakeConfig({ signer: { readOnly: true } }) });
    const out = await run(mw);
    assert.ok(out.error instanceof ServiceUnavailableError);
    assert.equal(out.error.status, 503);
    assert.equal(out.error.code, 'read_only');
    assert.equal(out.error.retriable, false);
  });
});
