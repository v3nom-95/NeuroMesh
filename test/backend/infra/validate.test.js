/**
 * Request validation: zod issues become field errors, values are never echoed, and the two Express
 * 5 traps (an absent body, a read-only `req.query`) are handled.
 *
 * @module test/backend/infra/validate.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { validate, validateResponse } from '../../../src/middleware/validate.js';
import { ValidationError } from '../../../src/errors.js';

/**
 * Run a middleware against a request stub.
 *
 * @param {any} middleware Middleware under test.
 * @param {Record<string, any>} req Request stub.
 * @returns {Promise<{req: any, error: any}>} What happened.
 */
async function run(middleware, req) {
  const request = { headers: {}, ...req };
  /** @type {any} */
  let error = null;
  await middleware(request, { locals: {} }, (/** @type {any} */ err) => {
    error = err ?? null;
  });
  return { req: request, error };
}

const BodySchema = z
  .object({
    context: z.string().min(1).max(100),
    tags: z.array(z.string()).optional(),
  })
  .strict();

describe('validate: success path', () => {
  it('replaces the body with the parsed output', async () => {
    const out = await run(validate({ body: BodySchema }), { body: { context: 'hello' } });
    assert.equal(out.error, null);
    assert.deepEqual(out.req.body, { context: 'hello' });
  });

  it('applies coercion and defaults from the schema', async () => {
    const schema = z.object({ limit: z.coerce.number().int().default(25) });
    const out = await run(validate({ query: schema }), { query: { limit: '50' } });
    assert.equal(out.error, null);
    assert.deepEqual(out.req.validatedQuery, { limit: 50 });
  });

  it('writes parsed query to req.validatedQuery, not req.query', async () => {
    // Express 5 defines req.query as a getter with no setter; assigning to it throws. The parsed
    // value therefore lives beside it rather than replacing it.
    const schema = z.object({ q: z.string() });
    const out = await run(validate({ query: schema }), { query: { q: 'x' } });
    assert.deepEqual(out.req.validatedQuery, { q: 'x' });
    assert.deepEqual(out.req.query, { q: 'x' });
  });

  it('validates params', async () => {
    const schema = z.object({ cid: z.string().startsWith('bafk') });
    const out = await run(validate({ params: schema }), { params: { cid: 'bafkabc' } });
    assert.equal(out.error, null);
    assert.equal(out.req.params.cid, 'bafkabc');
  });
});

describe('validate: an absent body parses as {}', () => {
  const emptyBody = z.object({}).strict();

  it('accepts a POST with no body and no Content-Type', async () => {
    // This is the exact shape of POST /memories/:cid/decrypt, whose empty strict body schema is
    // the structural guarantee that the decryption oracle cannot come back: the endpoint takes no
    // caller-supplied ciphertext, by construction. Without the `req.body ?? {}` default, every
    // valid call would 400 with invalid_type because express.json() never ran.
    const out = await run(validate({ body: emptyBody }), { body: undefined });
    assert.equal(out.error, null);
    assert.deepEqual(out.req.body, {});
  });

  it('still rejects a body that smuggles in a ciphertext field', async () => {
    const out = await run(validate({ body: emptyBody }), {
      body: { encryptedData: { encrypted: 'ff', iv: '00', tag: '11', salt: '22' } },
    });
    assert.ok(out.error instanceof ValidationError);
    assert.equal(out.error.status, 400);
  });
});

describe('validate: failure path', () => {
  it('maps a zod issue to {path, code, message}', async () => {
    const out = await run(validate({ body: BodySchema }), { body: { context: '' } });
    assert.ok(out.error instanceof ValidationError);
    const issues = /** @type {any[]} */ (out.error.details);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, 'body.context');
    assert.equal(typeof issues[0].code, 'string');
    assert.equal(typeof issues[0].message, 'string');
  });

  it('prefixes the path with the request part', async () => {
    const out = await run(validate({ params: z.object({ id: z.string().uuid() }) }), {
      params: { id: 'not-a-uuid' },
    });
    const issues = /** @type {any[]} */ (out.error.details);
    assert.equal(issues[0].path, 'params.id');
  });

  it('reports problems from every part in one response', async () => {
    const out = await run(
      validate({
        body: BodySchema,
        query: z.object({ limit: z.coerce.number().int().max(10) }),
      }),
      { body: { context: '' }, query: { limit: '999' } },
    );
    const paths = /** @type {any[]} */ (out.error.details).map((i) => i.path);
    assert.ok(paths.includes('body.context'));
    assert.ok(paths.includes('query.limit'));
  });

  it('rejects an unknown field rather than dropping it silently', async () => {
    // This is what would have caught the payload drift: the client read `raw_context`, a field no
    // payload ever contained, and rendered fallback text forever with no error anywhere.
    const out = await run(validate({ body: BodySchema }), {
      body: { context: 'ok', raw_context: 'surprise' },
    });
    assert.ok(out.error instanceof ValidationError);
    const paths = /** @type {any[]} */ (out.error.details).map((i) => i.path);
    assert.ok(paths.some((p) => p.startsWith('body')));
  });

  it('never echoes the received value', async () => {
    const secret = 'a-value-that-must-not-appear-in-the-response';
    const out = await run(validate({ body: z.object({ token: z.number() }).strict() }), {
      body: { token: secret },
    });
    assert.equal(JSON.stringify(out.error.details).includes(secret), false);
    assert.equal(out.error.message.includes(secret), false);
  });

  it('produces a 400 with code validation_error', async () => {
    const out = await run(validate({ body: BodySchema }), { body: {} });
    assert.equal(out.error.status, 400);
    assert.equal(out.error.code, 'validation_error');
    assert.equal(out.error.retriable, false);
  });

  it('does nothing at all when no schema is supplied', async () => {
    const out = await run(validate(), { body: { anything: true } });
    assert.equal(out.error, null);
    assert.deepEqual(out.req.body, { anything: true });
  });
});

describe('validateResponse', () => {
  const schema = z.object({ ok: z.boolean() }).strict();

  /**
   * Build a response stub whose `json` records what it was given.
   *
   * @returns {{res: any, sent: unknown[]}} Stub and its capture array.
   */
  function fakeRes() {
    /** @type {unknown[]} */
    const sent = [];
    const res = {
      /**
       * @param {unknown} body Body.
       * @returns {unknown} The body.
       */
      json(body) {
        sent.push(body);
        return body;
      },
    };
    return { res, sent };
  }

  it('passes a conforming body through', () => {
    const { res, sent } = fakeRes();
    validateResponse(schema)({ method: 'GET', path: '/x' }, res, () => {});
    res.json({ ok: true });
    assert.deepEqual(sent, [{ ok: true }]);
  });

  it('throws on a drifting response outside production', () => {
    const { res } = fakeRes();
    validateResponse(schema)({ method: 'GET', path: '/x' }, res, () => {});
    assert.throws(() => res.json({ oops: 1 }), /does not match its published schema/);
  });

  it('never fails a real request in production', () => {
    const { res, sent } = fakeRes();
    validateResponse(schema, { app: { isProduction: true } })(
      { method: 'GET', path: '/x' },
      res,
      () => {},
    );
    res.json({ oops: 1 });
    assert.deepEqual(sent, [{ oops: 1 }]);
  });
});
