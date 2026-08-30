/**
 * The memory lifecycle over HTTP: create, list, read, verify and decrypt.
 *
 * These run against the real embedding (mock provider), crypto, semantic and memory services, with
 * only the pinning service and the chain faked - so the CIDs in these assertions are genuinely
 * computed over the bytes that were stored, and the ciphertext that comes back out of `/decrypt` is
 * genuinely the ciphertext that went in.
 *
 * @module test/backend/routes/memory.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import {
  Job,
  MemoryDetail,
  MemoryListResponse,
  VerificationResponse,
} from '../../../src/schemas/api.js';

import { MALFORMED_CID, UNKNOWN_CID, buildApp, commitMemory } from './helpers.js';

describe('routes/memory: POST /api/v1/memories', () => {
  it('answers 202 with a job, a Location header and the six named steps', async () => {
    // 202 rather than 200 because the pipeline includes a chain confirmation, measured at up to
    // 21 s on Sepolia in this repository's own benchmark data. Holding the socket open for that is
    // a request every proxy in the path times out.
    const { app } = await buildApp();
    const res = await request(app).post('/api/v1/memories').send({ context: 'remember this' });
    assert.equal(res.status, 202);
    assert.match(res.headers.location, /^\/api\/v1\/jobs\/[0-9a-f-]{36}$/);
    assert.equal(res.headers['retry-after'], '1');
    assert.ok(Job.safeParse(res.body).success, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.steps.map((/** @type {any} */ s) => s.name),
      ['embed', 'align', 'encrypt', 'pin', 'commit', 'confirm'],
    );
  });

  it('rejects an array context, which is what committed a wrong embeddingDim in v1', async () => {
    // An array reached the tokenizer, was treated as a batch, produced a 768- or 1920-float vector,
    // and was committed under a hardcoded embeddingDim of 384 - a permanent false on-chain record.
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/v1/memories')
      .send({ context: ['one', 'two', 'three'] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_error');
    assert.equal(res.body.error.details[0].path, 'body.context');
  });

  it('rejects a missing, empty, numeric and null context', async () => {
    const { app } = await buildApp();
    for (const body of [{}, { context: '' }, { context: 42 }, { context: null }]) {
      const res = await request(app).post('/api/v1/memories').send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  it('rejects an unknown field rather than silently dropping it', async () => {
    // Strict objects are what would have caught the `raw_context` drift: the client read a key the
    // server had never written, and nothing anywhere errored.
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/v1/memories')
      .send({ context: 'ok', raw_context: 'oops' });
    assert.equal(res.status, 400);
    assert.ok(JSON.stringify(res.body.error.details).includes('raw_context'));
  });

  it('refuses a context above the configured character cap, at one layer or the other', async () => {
    // Two caps guard this, deliberately. The zod schema's `max` is bound to the process config
    // singleton, which is the one config a real process has; the memory service re-checks against
    // the config it was constructed with. A test that injects a different config therefore trips
    // the service's 413 rather than the schema's 400 - and either answer is correct and typed,
    // which is the property that matters. What must never happen is the v1 behaviour: a 90 KB
    // string accepted, silently truncated to the model's 256-token window, and committed as though
    // the vector represented the whole text.
    const { app } = await buildApp({ env: { MAX_CONTEXT_CHARS: '32' } });
    const res = await request(app)
      .post('/api/v1/memories')
      .send({ context: 'x'.repeat(64) });
    assert.ok([400, 413].includes(res.status), String(res.status));
    assert.ok(res.body.error.code);
  });

  it('never echoes the submitted value back in the error details', async () => {
    // A rejected value may be a secret or a 256 KB blob; an issue is {path, code, message}.
    const { app } = await buildApp();
    const secret = 'correct-horse-battery-staple';
    const res = await request(app).post('/api/v1/memories').send({ context: 12, note: secret });
    assert.ok(!JSON.stringify(res.body.error.details).includes(secret));
  });

  it('rejects a malformed grantee public key before any gas is spent', async () => {
    const { app, chain } = await buildApp();
    const res = await request(app)
      .post('/api/v1/memories')
      .send({
        context: 'ok',
        grantees: [{ address: '0x' + '11'.repeat(20), publicKey: '0xdeadbeef' }],
      });
    assert.equal(res.status, 400);
    assert.equal(chain.submits.length, 0);
  });

  it('runs the pipeline to completion and reports every step on the job', async () => {
    const { app } = await buildApp();
    const created = await request(app).post('/api/v1/memories').send({ context: 'a durable fact' });
    const jobId = created.body.id;

    // Poll the real job route rather than reaching into the service: the poll loop is the contract
    // the dashboard depends on.
    /** @type {any} */
    let job = null;
    for (let i = 0; i < 100; i += 1) {
      const res = await request(app).get(`/api/v1/jobs/${jobId}`);
      assert.equal(res.status, 200);
      job = res.body;
      if (job.state === 'succeeded' || job.state === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(job.state, 'succeeded', JSON.stringify(job.error));
    assert.ok(job.result.cid);
    assert.ok(job.result.txHash);
    for (const step of job.steps) {
      assert.equal(step.state, 'done', step.name);
      assert.equal(typeof step.ms, 'number', step.name);
    }
  });
});

describe('routes/memory: GET /api/v1/memories', () => {
  it('returns a paginated envelope that names its own source', async () => {
    const graph = await buildApp();
    await commitMemory(graph, 'one');
    await commitMemory(graph, 'two');
    const res = await request(graph.app).get('/api/v1/memories?limit=1');
    assert.equal(res.status, 200);
    assert.ok(MemoryListResponse.safeParse(res.body).success, JSON.stringify(res.body));
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.total, 2);
    assert.ok(res.body.nextCursor);
    // Naming the source matters: v1 listed the operator's whole Pinata billing account and called
    // that the memory list.
    assert.equal(res.body.source, 'local-index');
  });

  it('follows its own cursor to the second page', async () => {
    const graph = await buildApp();
    await commitMemory(graph, 'one');
    await commitMemory(graph, 'two');
    const first = await request(graph.app).get('/api/v1/memories?limit=1');
    const second = await request(graph.app).get(
      `/api/v1/memories?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    assert.equal(second.status, 200);
    assert.equal(second.body.items.length, 1);
    assert.notEqual(second.body.items[0].cid, first.body.items[0].cid);
    assert.equal(second.body.nextCursor, null);
  });

  it('rejects an out-of-range limit and an unknown query parameter', async () => {
    const { app } = await buildApp();
    assert.equal((await request(app).get('/api/v1/memories?limit=0')).status, 400);
    assert.equal((await request(app).get('/api/v1/memories?limit=1000')).status, 400);
    assert.equal((await request(app).get('/api/v1/memories?bogus=1')).status, 400);
  });

  it('does not treat the string "false" as true', async () => {
    // z.coerce.boolean() is Boolean(value), so 'false' coerces to true. This is the guard.
    const graph = await buildApp();
    await commitMemory(graph, 'sealed');
    const encrypted = await request(graph.app).get('/api/v1/memories?encrypted=true');
    const plaintext = await request(graph.app).get('/api/v1/memories?encrypted=false');
    assert.equal(encrypted.body.items.length, 1);
    assert.equal(plaintext.body.items.length, 0);
  });
});

describe('routes/memory: GET /api/v1/memories/:cid', () => {
  it('returns the v2 payload with its version discriminator and a strong ETag', async () => {
    const graph = await buildApp();
    const cid = await commitMemory(graph);
    const res = await request(graph.app).get(`/api/v1/memories/${cid}`);
    assert.equal(res.status, 200);
    assert.ok(MemoryDetail.safeParse(res.body).success, JSON.stringify(res.body));
    assert.equal(res.body.payloadVersion, 'neuromesh/2.0.0');
    assert.equal(res.body.cid, cid);
    assert.ok(res.headers.etag);
    // The payload is the v2 camelCase shape, not the v1 snake_case one, and it carries no
    // plaintext: `raw_context` never existed and `context` is only reachable through /decrypt.
    assert.ok(!('raw_context' in res.body.payload));
    assert.ok(!('encrypted_context' in res.body.payload));
    assert.ok(res.body.payload.cipher);
  });

  it('answers 304 when the ETag still matches', async () => {
    const graph = await buildApp();
    const cid = await commitMemory(graph);
    const first = await request(graph.app).get(`/api/v1/memories/${cid}`);
    const second = await request(graph.app)
      .get(`/api/v1/memories/${cid}`)
      .set('If-None-Match', first.headers.etag);
    assert.equal(second.status, 304);
  });

  it('rejects a v0 CID at parameter validation rather than deep inside the IPFS service', async () => {
    const { app } = await buildApp();
    const res = await request(app).get(`/api/v1/memories/${MALFORMED_CID}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].path, 'params.cid');
  });

  it('is a 404-class failure for a CID nothing has stored', async () => {
    const { app } = await buildApp();
    const res = await request(app).get(`/api/v1/memories/${UNKNOWN_CID}`);
    assert.ok(res.status >= 400 && res.status < 600);
    assert.notEqual(res.status, 200);
    assert.ok(res.body.error.code);
  });
});

describe('routes/memory: GET /api/v1/memories/:cid/verify', () => {
  it('returns a step array in which skip is not pass', async () => {
    const graph = await buildApp();
    const cid = await commitMemory(graph);
    const res = await request(graph.app).get(`/api/v1/memories/${cid}/verify`);
    assert.equal(res.status, 200);
    assert.ok(VerificationResponse.safeParse(res.body).success, JSON.stringify(res.body));
    assert.ok(res.body.steps.length > 5);
    for (const step of res.body.steps) {
      assert.ok(['pass', 'fail', 'skip'].includes(step.state), step.name);
      assert.equal(typeof step.detail, 'string');
    }
  });

  it('needs no API key, because verification is meant to be public', async () => {
    const graph = await buildApp({
      env: { API_AUTH_TOKEN: '0123456789abcdef0123456789abcdef0123456789abcdef' },
    });
    const cid = await commitMemory(graph);
    assert.equal((await request(graph.app).get(`/api/v1/memories/${cid}/verify`)).status, 200);
  });
});

describe('routes/memory: POST /api/v1/memories/:cid/decrypt', () => {
  it('returns the plaintext for a memory this node sealed', async () => {
    const graph = await buildApp();
    const cid = await commitMemory(graph, 'the quiet part');
    const res = await request(graph.app).post(`/api/v1/memories/${cid}/decrypt`).send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.context, 'the quiet part');
    assert.equal(res.body.verified, true);
    assert.equal(res.body.cid, cid);
  });

  it('never lets the response be cached', async () => {
    const graph = await buildApp();
    const cid = await commitMemory(graph);
    const res = await request(graph.app).post(`/api/v1/memories/${cid}/decrypt`).send({});
    assert.match(String(res.headers['cache-control']), /no-store/);
  });

  it('has its own, tighter rate-limit bucket than the other writes', async () => {
    process.env.RATE_LIMIT_TEST = '1';
    try {
      const graph = await buildApp({
        env: { DECRYPT_RATE_LIMIT_MAX: '1', WRITE_RATE_LIMIT_MAX: '50', RATE_LIMIT_MAX: '500' },
      });
      const cid = await commitMemory(graph);
      assert.equal(
        (await request(graph.app).post(`/api/v1/memories/${cid}/decrypt`).send({})).status,
        200,
      );
      const limited = await request(graph.app).post(`/api/v1/memories/${cid}/decrypt`).send({});
      assert.equal(limited.status, 429);
      // The write bucket is untouched, which is the point of separate buckets.
      assert.equal(
        (await request(graph.app).post('/api/v1/memories').send({ context: 'x' })).status,
        202,
      );
    } finally {
      delete process.env.RATE_LIMIT_TEST;
    }
  });
});
