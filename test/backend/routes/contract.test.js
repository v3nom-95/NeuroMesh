/**
 * The three-way contract: `ROUTE_TABLE`, the Express routers, and the OpenAPI document.
 *
 * Before this table the three agreed by coincidence and did not: the published docs described
 * `GET /api/v1/node` and `POST /api/v1/agents/{address}/endorse` while the shipped client called
 * `/api/status` and `/api/reputation/endorse`, and nothing failed until somebody tried to use the
 * documentation. These tests are what make that class of drift a failing build.
 *
 * The routing assertions are behavioural - a real request per row - rather than a walk of Express's
 * internal layer stack. Express 5 restructured that stack, and a test that reads private internals
 * fails on an upgrade for reasons that have nothing to do with the contract it claims to check.
 *
 * @module test/backend/routes/contract.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { buildOpenApi, renderDocsHtml, toOpenApiPath } from '../../../src/openapi.js';
import { ALL_PATHS, ROUTE_TABLE } from '../../../src/routes/index.js';
import { SCHEMAS } from '../../../src/schemas/api.js';

import { TEST_AGENT, UNKNOWN_CID, buildApp } from './helpers.js';

/** Concrete values substituted for `:param` segments when probing a route. */
const PARAM_VALUES = Object.freeze({
  address: TEST_AGENT,
  cid: UNKNOWN_CID,
  id: '11111111-2222-4333-8444-555555555555',
});

/** A key that satisfies the config schema, so authenticated rows can be probed as authenticated. */
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';

/** A minimal valid body per route id, so a probe fails on routing rather than on validation. */
const BODIES = Object.freeze({
  registerAgent: {},
  createMemory: { context: 'probe' },
  decryptMemory: {},
  semanticSearch: { query: 'probe' },
  endorseAgent: { target: TEST_AGENT, reason: 'probe' },
  reportAgent: { target: TEST_AGENT, reason: 'probe' },
});

/**
 * Substitute concrete values into an Express-style path.
 *
 * @param {string} path The path.
 * @returns {string} A requestable URL.
 */
function concrete(path) {
  return path.replace(
    /:([A-Za-z0-9_]+)/g,
    (_match, name) => /** @type {Record<string, string>} */ (PARAM_VALUES)[name] ?? 'x',
  );
}

describe('routes/contract: every declared route is actually registered', () => {
  it('answers every canonical path and every alias with something other than route-not-found', async () => {
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    /** @type {string[]} */
    const missing = [];
    for (const route of ROUTE_TABLE) {
      for (const path of [route.path, ...route.aliases]) {
        const res = await request(app)
          [route.method](concrete(path))
          .set('X-API-Key', TOKEN)
          .send(/** @type {Record<string, any>} */ (BODIES)[route.id]);
        // A 404 is only a failure when it means "no such route". `job_not_found` and
        // `memory_not_found` are the route working correctly on an id nothing has stored.
        if (res.status === 404 && res.body?.error?.code === 'not_found') {
          missing.push(`${route.method.toUpperCase()} ${path}`);
        }
      }
    }
    assert.deepEqual(missing, [], `declared but not registered: ${missing.join(', ')}`);
  });

  it('never answers a declared route with a 5xx that is not in its declared status list', async () => {
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    /** @type {string[]} */
    const surprises = [];
    for (const route of ROUTE_TABLE) {
      const res = await request(app)
        [route.method](concrete(route.path))
        .set('X-API-Key', TOKEN)
        .send(/** @type {Record<string, any>} */ (BODIES)[route.id]);
      if (res.status >= 500 && !route.statuses.includes(res.status)) {
        surprises.push(`${route.method.toUpperCase()} ${route.path} -> ${res.status}`);
      }
    }
    assert.deepEqual(surprises, []);
  });

  it('declares no duplicate operation ids, and no path outside /api unless it is an ops path', async () => {
    const ids = ROUTE_TABLE.map((route) => route.id);
    assert.equal(new Set(ids).size, ids.length);
    const opsPaths = new Set(['/healthz', '/readyz', '/metrics', '/openapi.json', '/docs']);
    for (const route of ROUTE_TABLE) {
      assert.ok(
        route.path.startsWith('/api/') || opsPaths.has(route.path),
        `unexpected root-level path: ${route.path}`,
      );
    }
  });

  it('declares an alias for every versioned path the bundled dashboard calls', async () => {
    // public/js/api.js freezes these unversioned paths in its ENDPOINTS map. Serving 410 there,
    // as the original plan had it, would break the console this very process ships.
    const declared = new Set(ALL_PATHS);
    for (const path of [
      '/healthz',
      '/readyz',
      '/metrics',
      '/api/status',
      '/api/agents/:address',
      '/api/agents/register',
      '/api/memories',
      '/api/memories/:cid',
      '/api/semantic/search',
      '/api/semantic/similarity',
      '/api/reputation',
      '/api/reputation/endorse',
      '/api/reputation/report',
      '/api/simulation-results',
      '/openapi.json',
      '/docs',
    ]) {
      assert.ok(
        declared.has(path),
        `the dashboard calls ${path} and the table does not declare it`,
      );
    }
  });
});

describe('routes/contract: removed endpoints stay removed', () => {
  it('404s every v1 path that must never come back', async () => {
    const { app } = await buildApp();
    for (const [method, path] of /** @type {Array<['get'|'post', string]>} */ ([
      ['post', '/api/decrypt'],
      ['get', '/api/decrypt'],
      ['post', '/api/register'],
      ['post', '/api/memory'],
      ['get', '/api/memory'],
      ['get', '/api/v1/node'],
      ['get', '/api/v1/benchmarks'],
    ])) {
      const res = await request(app)[method](path).send({});
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.equal(res.body.error.code, 'not_found', `${method} ${path}`);
    }
  });

  it('offers a hint for a merely-renamed path but never for /api/decrypt', async () => {
    const { app } = await buildApp();
    const renamed = await request(app).post('/api/memory').send({});
    assert.ok(renamed.body.error.details.hint, 'a renamed path should say where it went');

    const oracle = await request(app).post('/api/decrypt').send({});
    assert.equal(oracle.body.error.details.hint, undefined);
  });
});

describe('routes/contract: the OpenAPI document is a projection of the table', () => {
  it('documents every route in the table, and documents nothing else', () => {
    const doc = buildOpenApi();
    const documented = new Set();
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const method of Object.keys(/** @type {any} */ (operations))) {
        documented.add(`${method} ${path}`);
      }
    }
    const declared = new Set(
      ROUTE_TABLE.map((route) => `${route.method} ${toOpenApiPath(route.path)}`),
    );
    assert.deepEqual([...documented].sort(), [...declared].sort());
  });

  it('marks a security scheme on exactly the authenticated routes', () => {
    const doc = buildOpenApi();
    for (const route of ROUTE_TABLE) {
      const operation = doc.paths[toOpenApiPath(route.path)][route.method];
      assert.equal(
        operation.security.length > 0,
        route.auth,
        `${route.id} security does not match auth:${route.auth}`,
      );
    }
  });

  it('resolves every $ref it emits', () => {
    const doc = buildOpenApi();
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)];
    assert.ok(refs.length > 0);
    for (const [, bucket, name] of refs) {
      assert.ok(doc.components[bucket]?.[name], `dangling $ref: ${bucket}/${name}`);
    }
  });

  it('converts every schema in the registry without throwing', () => {
    // A schema the converter cannot represent must fail here, loudly, rather than silently
    // producing a document that describes something other than what the server accepts.
    const doc = buildOpenApi();
    for (const name of Object.keys(SCHEMAS)) {
      assert.ok(doc.components.schemas[name], `schema ${name} is missing from the document`);
    }
  });

  it('describes the decrypt body as empty and additionalProperties:false', () => {
    // This is the structural guarantee, restated in the published contract: there is no field a
    // client could send that would make this endpoint decrypt caller-supplied ciphertext.
    const doc = buildOpenApi();
    const schema = doc.components.schemas.DecryptBody;
    assert.equal(schema.type, 'object');
    assert.deepEqual(schema.properties ?? {}, {});
    assert.equal(schema.additionalProperties, false);
  });

  it('contains no secret value', async () => {
    const { config } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    const flat = JSON.stringify(buildOpenApi({ config }));
    for (const secret of [TOKEN, config.signer.privateKey, config.ipfs.jwt]) {
      if (!secret) continue;
      assert.ok(!flat.includes(secret), 'a secret reached the OpenAPI document');
    }
  });

  it('is served at every declared location with a matching body', async () => {
    const { app } = await buildApp();
    const canonical = await request(app).get('/openapi.json');
    assert.equal(canonical.status, 200);
    assert.equal(canonical.body.openapi, '3.1.0');
    for (const path of ['/api/docs.json', '/api/v1/openapi.json']) {
      const res = await request(app).get(path);
      assert.equal(res.status, 200, path);
      assert.deepEqual(
        Object.keys(res.body.paths).sort(),
        Object.keys(canonical.body.paths).sort(),
      );
    }
  });
});

describe('routes/contract: the HTML docs page', () => {
  it('renders without an external script or stylesheet, because the CSP forbids both', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/docs');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    // No CDN, and no inline script: script-src is 'self' with no 'unsafe-inline', so either would
    // simply be blocked and the page would render blank.
    assert.ok(!/<script/i.test(res.text), 'the docs page must contain no script at all');
    assert.ok(
      !/https?:\/\/(?!localhost)/i.test(res.text.replace(/https?:\/\/example\.invalid/g, '')),
    );
  });

  it('escapes everything it interpolates', () => {
    const html = renderDocsHtml({
      info: { title: '<script>x</script>', version: '1', summary: '&' },
      tags: [{ name: 'Health', description: '<img onerror=1>' }],
      paths: {
        '/x': {
          get: {
            tags: ['Health'],
            summary: '"quoted"',
            description: 'a & b',
            responses: { 200: {} },
          },
        },
      },
    });
    assert.ok(!html.includes('<script>x</script>'));
    assert.ok(!html.includes('<img onerror=1>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  it('lists every documented operation', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/docs');
    for (const route of ROUTE_TABLE) {
      assert.ok(
        res.text.includes(toOpenApiPath(route.path)),
        `${route.path} is missing from the rendered docs`,
      );
    }
  });
});
