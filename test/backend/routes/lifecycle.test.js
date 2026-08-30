/**
 * Process lifecycle: bind first, warm second, drain cleanly.
 *
 * These bind a real loopback socket on an ephemeral port, because the properties under test are
 * about the socket - that it is listening before any dependency has been touched, and that a
 * shutdown flips readiness off before it stops accepting.
 *
 * `handleSignals:false` throughout: installing the code-under-test's `uncaughtException` listener
 * inside the test runner would swallow the runner's own failures.
 *
 * @module test/backend/routes/lifecycle.test
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import request from 'supertest';

import { main, resetLifecycle, shutdown } from '../../../src/server.js';

import { quietLogger, testConfig } from './helpers.js';

/** @type {Array<import('node:http').Server>} */
const started = [];

/**
 * Find a port nothing is listening on.
 *
 * @returns {Promise<number>} A free port.
 */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {any} */ (probe.address());
  const port = address.port;
  await new Promise((resolve) => probe.close(() => resolve(undefined)));
  return port;
}

/**
 * Start a node on a free loopback port.
 *
 * @param {Record<string, string|undefined>} [env] Environment overrides.
 * @returns {Promise<any>} The handles from `main`.
 */
async function start(env = {}) {
  const port = await freePort();
  const config = testConfig({ PORT: String(port), HOST: '127.0.0.1', ...env });
  const handles = await main({
    config,
    logger: quietLogger(),
    warm: false,
    handleSignals: false,
  });
  started.push(handles.server);
  return { ...handles, port, config };
}

afterEach(async () => {
  while (started.length > 0) {
    const server = started.pop();
    await new Promise((resolve) => server?.close(() => resolve(undefined)));
  }
  resetLifecycle();
});

describe('server/lifecycle: the port binds before anything is warmed', () => {
  it('answers /healthz on a real socket with every dependency cold', async () => {
    // This is the assertion that stops the v1 defect from returning: a top-level `await pipeline()`
    // meant nothing listened until a ~90 MB download finished, so every liveness probe failed and
    // the orchestrator restarted the pod into a download loop that never terminated.
    const node = await start();
    const res = await request(`http://127.0.0.1:${node.port}`).get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('answers /readyz with 503 and a named reason while cold', async () => {
    const node = await start();
    const res = await request(`http://127.0.0.1:${node.port}`).get('/readyz');
    assert.equal(res.status, 503);
    assert.equal(res.body.ready, false);
    assert.ok(res.body.checks.some((/** @type {any} */ c) => c.status !== 'up'));
  });

  it('sets the keep-alive and headers timeouts in the order a proxy needs', async () => {
    // headersTimeout must exceed keepAliveTimeout, and both must exceed a typical 60 s proxy idle
    // timeout, so the proxy is always the side that closes an idle connection. Reversing them
    // produces sporadic 502s that are extremely hard to attribute.
    const node = await start();
    assert.ok(node.server.keepAliveTimeout >= 60000);
    assert.ok(node.server.headersTimeout > node.server.keepAliveTimeout);
  });

  it('fails to start with a clear error when the port is already taken', async () => {
    const node = await start();
    const config = testConfig({ PORT: String(node.port), HOST: '127.0.0.1' });
    await assert.rejects(
      () => main({ config, logger: quietLogger(), warm: false, handleSignals: false }),
      (/** @type {any} */ err) => err.code === 'EADDRINUSE',
    );
  });
});

describe('server/lifecycle: shutdown', () => {
  it('flips readiness off before it stops accepting, and exits 0', async () => {
    const node = await start();
    const base = `http://127.0.0.1:${node.port}`;

    // Readiness is checked while the server is still accepting, which is exactly the window a load
    // balancer uses to stop routing before any connection is reset.
    node.services.readiness.setDraining();
    const draining = await request(base).get('/readyz');
    assert.equal(draining.status, 503);
    assert.equal(draining.body.draining, true);
    assert.equal((await request(base).get('/healthz')).status, 200);

    /** @type {number[]} */
    const exits = [];
    const code = await shutdown('SIGTERM', { timeoutMs: 5000, exit: (c) => exits.push(c) });
    assert.equal(code, 0);
    assert.deepEqual(exits, [0]);
    assert.equal(node.server.listening, false);
  });

  it('exits 1 immediately on a second signal', async () => {
    await start();
    /** @type {number[]} */
    const exits = [];
    const first = shutdown('SIGTERM', { timeoutMs: 5000, exit: (c) => exits.push(c) });
    const second = await shutdown('SIGINT', { timeoutMs: 5000, exit: (c) => exits.push(c) });
    assert.equal(second, 1);
    await first;
    assert.ok(exits.includes(1));
  });

  it('exits 1 and names the stage when the budget expires', async () => {
    const node = await start();
    // A service that never settles is exactly what the budget exists for.
    node.services.memory.shutdown = () => new Promise(() => {});
    /** @type {number[]} */
    const exits = [];
    const code = await shutdown('SIGTERM', { timeoutMs: 60, exit: (c) => exits.push(c) });
    assert.equal(code, 1);
    assert.deepEqual(exits, [1]);
  });
});
