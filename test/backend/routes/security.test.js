/**
 * The security properties of the HTTP layer, one test per audited defect.
 *
 * Each `describe` below names the finding it closes. These are behavioural tests through the real
 * middleware stack rather than unit tests of the middleware, because the defects were all ordering
 * and wiring failures - every one of the individual pieces existed in `package.json` and none was
 * mounted.
 *
 * @module test/backend/routes/security.test
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import request from 'supertest';

import { ErrorResponse } from '../../../src/schemas/api.js';
import { resetAuthWarnings } from '../../../src/middleware/auth.js';

import { PEER_ADDRESS, UNKNOWN_CID, buildApp } from './helpers.js';

/**
 * A token long enough to satisfy the config schema's 32-character minimum, and varied enough to
 * satisfy its refusal of a repeated single character - the schema treats `'a'.repeat(48)` as a
 * placeholder somebody forgot to replace, which is the right call and worth a note here.
 */
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';

/** Every route that spends gas, pays for a pin, or decrypts. */
const MUTATING = Object.freeze([
  { method: 'post', path: '/api/v1/agents/register', body: {} },
  { method: 'post', path: '/api/v1/memories', body: { context: 'hello' } },
  {
    method: 'post',
    path: '/api/v1/reputation/endorse',
    body: { target: PEER_ADDRESS, reason: 'ok' },
  },
  {
    method: 'post',
    path: '/api/v1/reputation/report',
    body: { target: PEER_ADDRESS, reason: 'no' },
  },
  { method: 'post', path: `/api/v1/memories/${UNKNOWN_CID}/decrypt`, body: {} },
]);

describe('routes/security: the decryption oracle is gone (finding 1)', () => {
  it('POST /api/decrypt is a bare 404 with no hint at a replacement', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/decrypt')
      .send({
        encryptedData: { encrypted: 'aa', salt: 'bb', iv: 'cc', tag: 'dd' },
      });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
    // No 410, no alias, and above all no pointer at the replacement: telling whoever is probing
    // this path where the functionality went is useful to them and to nobody else.
    const flat = JSON.stringify(res.body);
    assert.ok(!/decrypt.*memories|memories.*decrypt/i.test(flat), flat);
    assert.ok(!/hint/i.test(flat), flat);
  });

  it('GET /api/decrypt is a 404 as well', async () => {
    const { app } = await buildApp();
    assert.equal((await request(app).get('/api/decrypt')).status, 404);
  });

  it('the replacement refuses a caller-supplied ciphertext field', async () => {
    // The body schema is an empty strict object. This is the structural guarantee that the oracle
    // cannot be reintroduced by adding a field: any field at all is a 400.
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    const res = await request(app)
      .post(`/api/v1/memories/${UNKNOWN_CID}/decrypt`)
      .set('X-API-Key', TOKEN)
      .send({ encryptedData: { encrypted: 'aa' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
  });

  it('the replacement accepts a request with no body at all', async () => {
    // Express 5 leaves req.body undefined when there is no Content-Type, and an empty strict
    // schema would then reject every legitimate call. This is the regression guard for that.
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    const res = await request(app)
      .post(`/api/v1/memories/${UNKNOWN_CID}/decrypt`)
      .set('X-API-Key', TOKEN);
    assert.notEqual(res.status, 400);
  });
});

describe('routes/security: gas-spending routes require a key (finding 2)', () => {
  before(() => resetAuthWarnings());
  after(() => resetAuthWarnings());

  for (const route of MUTATING) {
    it(`${route.method.toUpperCase()} ${route.path} is 401 without a key`, async () => {
      const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
      const res = await request(app)[route.method](route.path).send(route.body);
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'api_key_required');
      assert.match(String(res.headers['www-authenticate'] ?? ''), /Bearer/);
    });

    it(`${route.method.toUpperCase()} ${route.path} is accepted with a valid key`, async () => {
      const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
      const res = await request(app)
        [route.method](route.path)
        .set('X-API-Key', TOKEN)
        .send(route.body);
      assert.notEqual(res.status, 401);
    });
  }

  it('accepts the token as Authorization: Bearer as well as X-API-Key', async () => {
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    const res = await request(app)
      .post('/api/v1/memories')
      .set('Authorization', `Bearer ${TOKEN}`)
      .send({ context: 'hello' });
    assert.equal(res.status, 202);
  });

  it('answers a 1-character and a 500-character wrong token identically', async () => {
    // A raw timingSafeEqual on the token bytes throws RangeError on a length mismatch, and that
    // throw is observable - it leaks the configured token's length, which is binary-searchable.
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    const short = await request(app)
      .post('/api/v1/memories')
      .set('X-API-Key', 'x')
      .send({ context: 'a' });
    const long = await request(app)
      .post('/api/v1/memories')
      .set('X-API-Key', 'x'.repeat(500))
      .send({ context: 'a' });
    assert.equal(short.status, long.status);
    assert.equal(short.body.error.code, long.body.error.code);
    assert.equal(short.body.error.message, long.body.error.message);
  });

  it('never echoes the presented token back to the client', async () => {
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    const presented = 'not-the-real-token-but-distinctive';
    const res = await request(app)
      .post('/api/v1/memories')
      .set('X-API-Key', presented)
      .send({ context: 'a' });
    assert.ok(!JSON.stringify(res.body).includes(presented));
  });

  it('leaves read routes open', async () => {
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    for (const path of ['/api/v1/status', '/api/v1/memories', '/api/v1/reputation']) {
      assert.equal((await request(app).get(path)).status, 200, path);
    }
  });
});

describe('routes/security: CORS is an allowlist, never a wildcard (finding 2)', () => {
  it('never answers with Access-Control-Allow-Origin: *', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/status').set('Origin', 'https://evil.invalid');
    assert.notEqual(res.headers['access-control-allow-origin'], '*');
  });

  it('reflects an allowlisted origin and refuses an unlisted one', async () => {
    const { app } = await buildApp({
      env: { CORS_ALLOWED_ORIGINS: 'https://console.example' },
    });
    const allowed = await request(app)
      .get('/api/v1/status')
      .set('Origin', 'https://console.example');
    assert.equal(allowed.headers['access-control-allow-origin'], 'https://console.example');

    const denied = await request(app).get('/api/v1/status').set('Origin', 'https://evil.invalid');
    assert.equal(denied.headers['access-control-allow-origin'], undefined);
  });

  it('never allows credentials, which is what removes CSRF as a class', async () => {
    const { app } = await buildApp({ env: { CORS_ALLOWED_ORIGINS: 'https://console.example' } });
    const res = await request(app).get('/api/v1/status').set('Origin', 'https://console.example');
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
  });
});

describe('routes/security: rate limits (finding 2)', () => {
  it('returns 429 with Retry-After once the write budget is spent', async () => {
    process.env.RATE_LIMIT_TEST = '1';
    try {
      const { app } = await buildApp({
        env: { API_AUTH_TOKEN: TOKEN, WRITE_RATE_LIMIT_MAX: '2', RATE_LIMIT_MAX: '1000' },
      });
      /**
       * @returns {Promise<any>} One write attempt.
       */
      const write = () =>
        request(app).post('/api/v1/memories').set('X-API-Key', TOKEN).send({ context: 'x' });
      assert.equal((await write()).status, 202);
      assert.equal((await write()).status, 202);
      const limited = await write();
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error.code, 'rate_limited');
      assert.ok(Number(limited.headers['retry-after']) > 0);
    } finally {
      delete process.env.RATE_LIMIT_TEST;
    }
  });

  it('never rate limits the probes', async () => {
    process.env.RATE_LIMIT_TEST = '1';
    try {
      const { app } = await buildApp({ env: { RATE_LIMIT_MAX: '1' } });
      for (let i = 0; i < 5; i += 1) {
        assert.equal((await request(app).get('/healthz')).status, 200);
      }
    } finally {
      delete process.env.RATE_LIMIT_TEST;
    }
  });

  it('applies the global limiter to static assets, not just to the API', async () => {
    // Mounting the limiter after the static handler would give an attacker unlimited requests by
    // asking for a stylesheet.
    process.env.RATE_LIMIT_TEST = '1';
    try {
      const { app } = await buildApp({ env: { RATE_LIMIT_MAX: '2' } });
      await request(app).get('/css/base.css');
      await request(app).get('/css/base.css');
      const third = await request(app).get('/css/base.css');
      assert.equal(third.status, 429);
    } finally {
      delete process.env.RATE_LIMIT_TEST;
    }
  });
});

describe('routes/security: one error envelope, always (finding 4)', () => {
  it('emits {error:{code,message,details},requestId} for every failure class', async () => {
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    /** @type {Array<[string, Promise<any>]>} */
    const cases = [
      ['404', request(app).get('/api/v1/no-such-route')],
      ['400', request(app).get('/api/v1/agents/not-an-address')],
      ['401', request(app).post('/api/v1/memories').send({ context: 'x' })],
      [
        '422-ish body',
        request(app).post('/api/v1/memories').set('X-API-Key', TOKEN).send({ nope: 1 }),
      ],
    ];
    for (const [label, pending] of cases) {
      const res = await pending;
      assert.ok(res.status >= 400, label);
      assert.match(res.headers['content-type'], /application\/json/, label);
      const parsed = ErrorResponse.safeParse(res.body);
      assert.ok(parsed.success, `${label}: ${JSON.stringify(res.body)}`);
      assert.equal(typeof res.body.error.code, 'string', label);
      assert.equal(res.body.requestId, res.headers['x-request-id'], label);
    }
  });

  it('never returns an HTML error page', async () => {
    // v1 had no error middleware at all, so a throw fell through to Express's default handler and
    // returned an HTML stack trace to a client calling JSON.parse on it.
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/v1/memories')
      .set('Content-Type', 'application/json')
      .send('{ this is not json');
    assert.ok(res.status >= 400);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.ok(!/<html/i.test(res.text));
  });

  it('rejects an oversized body with a 413 that names both numbers', async () => {
    const { app } = await buildApp({ env: { BODY_LIMIT: '1kb', API_AUTH_TOKEN: TOKEN } });
    const res = await request(app)
      .post('/api/v1/memories')
      .set('X-API-Key', TOKEN)
      .send({ context: 'x'.repeat(4096) });
    assert.equal(res.status, 413);
    assert.match(res.body.error.message + JSON.stringify(res.body.error.details), /\d/);
  });

  it('stamps X-Request-Id on every response and echoes a well-formed inbound one', async () => {
    const { app } = await buildApp();
    const generated = await request(app).get('/api/v1/status');
    assert.match(generated.headers['x-request-id'], /^[0-9a-f-]{36}$/);

    const supplied = await request(app)
      .get('/api/v1/status')
      .set('X-Request-Id', 'client-12345678');
    assert.equal(supplied.headers['x-request-id'], 'client-12345678');

    // A hostile inbound id is replaced rather than reflected: it lands in log records and in the
    // response header, so an unbounded or CRLF-bearing value is a header-injection primitive.
    const hostile = await request(app).get('/api/v1/status').set('X-Request-Id', 'x'.repeat(500));
    assert.notEqual(hostile.headers['x-request-id'], 'x'.repeat(500));
  });
});

describe('routes/security: helmet and the CSP the dashboard needs', () => {
  it('sets a CSP with no unsafe-inline anywhere', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/healthz');
    const csp = String(res.headers['content-security-policy'] ?? '');
    assert.ok(csp.length > 0);
    assert.ok(!csp.includes('unsafe-inline'), csp);
    assert.ok(!csp.includes('unsafe-eval'), csp);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
  });

  it('removes the X-Powered-By fingerprint and sets the usual hardening headers', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/healthz');
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  });
});

describe('routes/security: a read-only node refuses to pretend', () => {
  it('answers 503 read_only on a write route when no signer is configured', async () => {
    const { app } = await buildApp({ env: { PRIVATE_KEY: undefined } });
    const res = await request(app).post('/api/v1/memories').send({ context: 'x' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'read_only');
  });

  it('still serves every read route on a read-only node', async () => {
    const { app } = await buildApp({ env: { PRIVATE_KEY: undefined } });
    for (const path of ['/healthz', '/api/v1/status', '/api/v1/memories', '/api/v1/reputation']) {
      assert.ok((await request(app).get(path)).status < 400, path);
    }
  });
});
