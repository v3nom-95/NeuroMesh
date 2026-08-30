/**
 * Liveness, readiness and status.
 *
 * The property under test is the separation between the three: a liveness probe must never fail
 * because a dependency is slow, a readiness probe must fail the instant a drain begins, and the
 * status document must report an unknown value as `null` rather than as a plausible default.
 *
 * @module test/backend/routes/health.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import { HealthResponse, ReadinessResponse, StatusResponse } from '../../../src/schemas/api.js';

import { buildApp, fakeChain } from './helpers.js';

describe('routes/health: GET /healthz', () => {
  it('is 200 with a schema-valid body', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.draining, false);
    assert.ok(HealthResponse.safeParse(res.body).success, JSON.stringify(res.body));
  });

  it('stays 200 even when every dependency is down', async () => {
    // A liveness probe that fails because a third-party RPC endpoint is unreachable causes an
    // orchestrator to restart a healthy pod, repeatedly, for the duration of somebody else's
    // outage. This is the assertion that stops that regression.
    const { app } = await buildApp({
      warm: false,
      overrides: { chain: fakeChain({ reachable: false, contractsCompatible: false }) },
    });
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
  });

  it('reports degraded, still at 200, once the process is draining', async () => {
    const { app, services } = await buildApp();
    services.readiness.setDraining();
    const res = await request(app).get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.draining, true);
  });

  it('is served at the /api/v1/health alias too', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });
});

describe('routes/health: GET /readyz', () => {
  it('is 503 while the model has not loaded, and lists the dependency that is down', async () => {
    const { app } = await buildApp({ warm: false });
    const res = await request(app).get('/readyz');
    assert.equal(res.status, 503);
    assert.equal(res.body.ready, false);
    const model = res.body.checks.find((/** @type {any} */ c) => c.name === 'model');
    assert.equal(model.status, 'down');
    assert.equal(model.critical, true);
    assert.ok(ReadinessResponse.safeParse(res.body).success);
  });

  it('is 200 once the dependencies are warm', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/readyz');
    assert.equal(res.status, 200);
    assert.equal(res.body.ready, true);
  });

  it('returns the identical document at 200 and at 503', async () => {
    const ready = await buildApp();
    const notReady = await buildApp({ warm: false });
    const ok = await request(ready.app).get('/readyz');
    const bad = await request(notReady.app).get('/readyz');
    assert.deepEqual(Object.keys(ok.body).sort(), Object.keys(bad.body).sort());
    assert.deepEqual(
      ok.body.checks.map((/** @type {any} */ c) => c.name).sort(),
      bad.body.checks.map((/** @type {any} */ c) => c.name).sort(),
    );
  });

  it('flips to 503 the moment a drain starts, while /healthz stays 200', async () => {
    // That ordering is the whole point: the load balancer stops routing before the process stops
    // accepting, so an in-flight request is never reset by a deploy.
    const { app, services } = await buildApp();
    assert.equal((await request(app).get('/readyz')).status, 200);
    services.readiness.setDraining();
    assert.equal((await request(app).get('/readyz')).status, 503);
    assert.equal((await request(app).get('/healthz')).status, 200);
  });

  it('does not make a chain outage a readiness failure', async () => {
    // Reads still work with a dead RPC endpoint, so the node is still worth routing to. Marking
    // the chain critical would take the console down with Sepolia.
    const { app } = await buildApp({
      overrides: { chain: fakeChain({ reachable: false, contractsCompatible: false }) },
    });
    const res = await request(app).get('/readyz');
    assert.equal(res.status, 200);
    const chain = res.body.checks.find((/** @type {any} */ c) => c.name === 'chain');
    assert.equal(chain.critical, false);
    assert.notEqual(chain.status, 'up');
  });
});

describe('routes/health: GET /api/v1/status', () => {
  it('reports node, agent, chain, model, ipfs, protocol and features', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/status');
    assert.equal(res.status, 200);
    const parsed = StatusResponse.safeParse(res.body);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.equal(res.body.protocol.version, 'neuromesh/2.0.0');
    assert.equal(res.body.features.sseToken, false);
    assert.equal(typeof res.body.chain.contractsCompatible, 'boolean');
    assert.equal(typeof res.body.memoryCount, 'number');
  });

  it('never emits a placeholder string where a value is unknown', async () => {
    // v1 answered `agentAddress: 'Loading...'` forever after a swallowed boot failure. A string
    // that looks like data but is not is worse than an explicit null.
    const { app } = await buildApp({ warm: false });
    const res = await request(app).get('/api/v1/status');
    const flat = JSON.stringify(res.body);
    assert.ok(!/Loading\.\.\./.test(flat));
    assert.ok(!/undefined/.test(flat));
  });

  it('reports contractsCompatible:false for a stale deployment while still answering 200', async () => {
    // The addresses in contract-addresses.json point at v1 contracts whose ABI does not match this
    // build. That is a degraded state, not a crash, and every read must keep working.
    const { app } = await buildApp({
      overrides: { chain: fakeChain({ contractsCompatible: false }) },
    });
    const res = await request(app).get('/api/v1/status');
    assert.equal(res.status, 200);
    assert.equal(res.body.chain.contractsCompatible, false);
    assert.equal(res.body.chain.reachable, true);
    assert.equal((await request(app).get('/api/v1/memories')).status, 200);
  });

  it('is served at the unversioned alias the bundled dashboard uses', async () => {
    const { app } = await buildApp();
    const versioned = await request(app).get('/api/v1/status');
    const legacy = await request(app).get('/api/status');
    assert.equal(legacy.status, 200);
    assert.deepEqual(Object.keys(legacy.body).sort(), Object.keys(versioned.body).sort());
  });
});
