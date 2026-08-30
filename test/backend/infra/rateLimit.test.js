/**
 * Rate limiting: the buckets are separately budgeted, probes are exempt, and the limiter is off in
 * tests unless a test asks for it.
 *
 * `RATE_LIMIT_TEST=1` is set and cleared inside this file rather than by the npm script, because
 * `npm run test:unit` cannot set an environment variable inline on Windows.
 *
 * @module test/backend/infra/rateLimit.test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  decryptLimiter,
  globalLimiter,
  searchLimiter,
  writeLimiter,
} from '../../../src/middleware/rateLimit.js';
import { RateLimitError } from '../../../src/errors.js';

/**
 * Configuration stub.
 *
 * @param {Record<string, number>} [limits] Per-bucket limits.
 * @returns {Record<string, any>} Config-shaped object.
 */
function fakeConfig(limits = {}) {
  return {
    app: { isTest: true, isProduction: false },
    security: {
      rateLimit: {
        windowMs: 60000,
        max: 60,
        writeMax: 2,
        searchMax: 3,
        decryptMax: 1,
        ...limits,
      },
    },
  };
}

/**
 * Send `count` requests through a limiter and report what came back.
 *
 * @param {any} limiter Middleware under test.
 * @param {number} count How many requests to send.
 * @param {Record<string, any>} [req] Request stub overrides.
 * @returns {Promise<Array<any>>} One entry per request: `null` when allowed, else the error.
 */
async function send(limiter, count, req = {}) {
  /** @type {any[]} */
  const results = [];
  for (let i = 0; i < count; i += 1) {
    const request = {
      headers: {},
      ip: '203.0.113.7',
      path: '/api/v1/memories',
      method: 'POST',
      ...req,
    };
    const res = {
      /** @returns {any} Chainable. */
      status() {
        return res;
      },
      setHeader() {},
      /** @returns {any} Chainable. */
      json() {
        return res;
      },
      end() {},
      getHeader: () => undefined,
      headersSent: false,
    };
    // The buckets are stateful and the order of requests is the whole point, so these are
    // deliberately sequential.
    const outcome = await new Promise((resolve) => {
      limiter(request, res, (/** @type {any} */ err) => resolve(err ?? null));
    });
    results.push(outcome);
  }
  return results;
}

describe('rateLimit: disabled in tests by default', () => {
  it('lets an unlimited number of requests through', async () => {
    delete process.env.RATE_LIMIT_TEST;
    const results = await send(writeLimiter(fakeConfig()), 20);
    assert.equal(
      results.every((r) => r === null),
      true,
      'a shared-process suite would otherwise poison later cases with earlier counters',
    );
  });
});

describe('rateLimit: enabled with RATE_LIMIT_TEST=1', () => {
  before(() => {
    process.env.RATE_LIMIT_TEST = '1';
  });
  after(() => {
    delete process.env.RATE_LIMIT_TEST;
  });

  it('allows exactly `writeMax` writes, then rejects with 429', async () => {
    const results = await send(writeLimiter(fakeConfig({ writeMax: 2 })), 4);
    assert.equal(results[0], null);
    assert.equal(results[1], null);
    assert.ok(results[2] instanceof RateLimitError);
    assert.equal(results[2].status, 429);
    assert.equal(results[2].code, 'rate_limited');
    assert.ok(results[3] instanceof RateLimitError);
  });

  it('gives the 429 a Retry-After derived from the window', async () => {
    const results = await send(writeLimiter(fakeConfig({ writeMax: 1 })), 2);
    assert.equal(results[1].headers['Retry-After'], '60');
    assert.equal(results[1].retriable, true);
  });

  it('budgets writes, search and decrypt separately', async () => {
    const config = fakeConfig({ writeMax: 2, searchMax: 3, decryptMax: 1 });
    // Exhausting one bucket must not affect another: they exist because the routes cost different
    // amounts, and a search must not be blocked by someone else's writes.
    const writes = await send(writeLimiter(config), 3);
    assert.ok(writes[2] instanceof RateLimitError);
    const searches = await send(searchLimiter(config), 3, { path: '/api/v1/search' });
    assert.equal(
      searches.every((r) => r === null),
      true,
    );
  });

  it('makes the decrypt bucket the tightest of all', async () => {
    const config = fakeConfig({ decryptMax: 1 });
    const results = await send(decryptLimiter(config), 2, {
      path: '/api/v1/memories/bafk/decrypt',
      params: { cid: 'bafk' },
    });
    assert.equal(results[0], null);
    assert.ok(results[1] instanceof RateLimitError);
  });

  it('audits every decrypt attempt', async () => {
    /** @type {any[]} */
    const lines = [];
    const logger = { info: (/** @type {any} */ record) => lines.push(record) };
    await send(decryptLimiter(fakeConfig({ decryptMax: 5 }), logger), 2, {
      path: '/api/v1/memories/bafkTEST/decrypt',
      params: { cid: 'bafkTEST' },
    });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].event, 'decrypt_attempt');
    assert.equal(lines[0].cid, 'bafkTEST');
  });

  it('never limits the ops probes', async () => {
    const config = fakeConfig({ max: 1 });
    for (const path of ['/healthz', '/readyz', '/metrics']) {
      // Sequential on purpose: the bucket is stateful.
      const results = await send(globalLimiter(config), 5, { path, method: 'GET' });
      assert.equal(
        results.every((r) => r === null),
        true,
        `${path} must never be rate limited`,
      );
    }
  });

  it('keys separate IPs into separate buckets', async () => {
    const limiter = writeLimiter(fakeConfig({ writeMax: 1 }));
    const first = await send(limiter, 2, { ip: '198.51.100.1' });
    assert.ok(first[1] instanceof RateLimitError);
    const second = await send(limiter, 1, { ip: '198.51.100.2' });
    assert.equal(second[0], null);
  });

  it('normalizes IPv6 so a client cannot walk its own prefix for free', async () => {
    // A bare req.ip key lets an IPv6 client rotate through a /64 and get an unlimited number of
    // fresh buckets. The library's ipKeyGenerator collapses the prefix, so these share a bucket.
    const limiter = writeLimiter(fakeConfig({ writeMax: 1 }));
    const first = await send(limiter, 1, { ip: '2001:db8:1234:5678::1' });
    assert.equal(first[0], null);
    const second = await send(limiter, 1, { ip: '2001:db8:1234:5678::abcd' });
    assert.ok(second[0] instanceof RateLimitError, 'an IPv6 prefix must share one bucket');
  });
});
