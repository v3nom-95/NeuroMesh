/**
 * Logging: prove the negative.
 *
 * The v1 failure this guards against is subtle. `console.error('Failed:', e.message)` was safe
 * only because it took `.message`. The very next person to write `console.error(e)` on an axios
 * error would have printed `e.config.headers.Authorization` - the full Pinata JWT - into stdout,
 * and from there into container logs and log aggregation, permanently.
 *
 * These tests log objects that deliberately contain every secret shape the process handles, then
 * assert that none of those values appears anywhere in the serialized output.
 *
 * @module test/backend/infra/logger.test
 */
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { pino } from 'pino';

import {
  REDACT_PATHS,
  childFor,
  httpLoggerOptions,
  logger,
  redactError,
} from '../../../src/logger.js';

const PRIVATE_KEY = `0x${'ab'.repeat(32)}`;
const PINATA_JWT = 'eyJhbGciOiJIUzI1NiJ9.super-secret-pinata-payload.signature';
const API_TOKEN = 'api-auth-token-value-0123456789abcdef';
const ENCRYPTION_KEY = `0x${'cd'.repeat(32)}`;
const DERIVATION_SIG = `0x${'ef'.repeat(65)}`;

const ALL_SECRETS = [PRIVATE_KEY, PINATA_JWT, API_TOKEN, ENCRYPTION_KEY, DERIVATION_SIG];

/**
 * Build a logger writing into a string buffer, with the production redaction configuration.
 *
 * @returns {{log: import('pino').Logger, read: () => string}} Logger and its captured output.
 */
function capturingLogger() {
  let output = '';
  const sink = new Writable({
    /**
     * @param {Buffer} chunk Chunk.
     * @param {string} _enc Encoding.
     * @param {(err?: Error) => void} cb Callback.
     * @returns {void}
     */
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  });
  const log = pino(
    { level: 'trace', redact: { paths: [...REDACT_PATHS], censor: '[redacted]' } },
    sink,
  );
  return { log, read: () => output };
}

describe('logger: redaction', () => {
  it('redacts every secret-shaped key by wildcard', () => {
    const { log, read } = capturingLogger();
    log.info({
      env: {
        PRIVATE_KEY,
        PINATA_JWT,
        API_AUTH_TOKEN: API_TOKEN,
        MEMORY_ENCRYPTION_KEY: ENCRYPTION_KEY,
      },
    });
    const out = read();
    for (const secret of [PRIVATE_KEY, PINATA_JWT, API_TOKEN, ENCRYPTION_KEY]) {
      assert.equal(out.includes(secret), false, `leaked ${secret.slice(0, 12)}...`);
    }
    assert.match(out, /\[redacted\]/);
  });

  it('redacts inbound credential headers', () => {
    const { log, read } = capturingLogger();
    log.info({
      req: {
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          'x-api-key': API_TOKEN,
          cookie: 'session=abc',
        },
      },
    });
    const out = read();
    assert.equal(out.includes(API_TOKEN), false);
    assert.equal(out.includes('session=abc'), false);
  });

  it('redacts an outbound client config Authorization header', () => {
    // The exact axios shape that would have leaked the Pinata JWT.
    const { log, read } = capturingLogger();
    log.error({ config: { headers: { Authorization: `Bearer ${PINATA_JWT}` } } });
    assert.equal(read().includes(PINATA_JWT), false);
  });

  it('redacts derivationSignature but not signature', () => {
    // An EIP-712 signature is published on chain and is public. The signature used to derive the
    // encryption keypair is equivalent to the encryption private key, so only that one is hidden.
    const { log, read } = capturingLogger();
    log.info({ memory: { signature: '0xdeadbeef', derivationSignature: DERIVATION_SIG } });
    const out = read();
    assert.equal(out.includes(DERIVATION_SIG), false);
    assert.ok(out.includes('0xdeadbeef'), 'a public signature must remain loggable');
  });

  it('redacts a nested camelCase secret', () => {
    const { log, read } = capturingLogger();
    log.info({ signer: { privateKey: PRIVATE_KEY }, ipfs: { jwt: PINATA_JWT } });
    const out = read();
    assert.equal(out.includes(PRIVATE_KEY), false);
    assert.equal(out.includes(PINATA_JWT), false);
  });

  it('emits none of the secret values for a kitchen-sink record', () => {
    const { log, read } = capturingLogger();
    log.error({
      env: { PRIVATE_KEY, PINATA_JWT, API_AUTH_TOKEN: API_TOKEN },
      req: { headers: { authorization: `Bearer ${API_TOKEN}` } },
      config: { headers: { Authorization: `Bearer ${PINATA_JWT}` } },
      signer: { privateKey: PRIVATE_KEY },
      crypto: { cek: ENCRYPTION_KEY, derivationSignature: DERIVATION_SIG },
    });
    const out = read();
    for (const secret of ALL_SECRETS) {
      assert.equal(out.includes(secret), false, `leaked a secret: ${secret.slice(0, 12)}...`);
    }
  });
});

describe('logger: redactError', () => {
  it('reduces an error to four safe fields', () => {
    const err = Object.assign(new Error('upstream failed'), { code: 'ECONNRESET' });
    const out = redactError(err, false);
    assert.deepEqual(Object.keys(out).sort(), ['code', 'message', 'name']);
    assert.equal(out.code, 'ECONNRESET');
  });

  it('drops the request object a client library attaches', () => {
    const err = Object.assign(new Error('403'), {
      config: { headers: { Authorization: `Bearer ${PINATA_JWT}` } },
      request: { _header: `Authorization: Bearer ${PINATA_JWT}` },
    });
    const serialized = JSON.stringify(redactError(err, true));
    assert.equal(serialized.includes(PINATA_JWT), false);
    assert.equal(serialized.includes('config'), false);
  });

  it('includes a stack only when asked', () => {
    const err = new Error('boom');
    assert.equal(typeof redactError(err, true).stack, 'string');
    assert.equal(redactError(err, false).stack, undefined);
  });

  it('keeps a cause, reduced the same way', () => {
    const cause = Object.assign(new Error('inner'), { code: 'INNER' });
    const err = new Error('outer', { cause });
    const out = redactError(err, false);
    assert.deepEqual(out.cause, { name: 'Error', code: 'INNER', message: 'inner' });
  });

  it('handles a thrown non-Error', () => {
    assert.deepEqual(redactError('just a string'), {
      name: 'NonError',
      code: null,
      message: 'just a string',
    });
  });
});

describe('logger: wiring', () => {
  it('is silent under test so a suite stays readable', () => {
    assert.equal(logger.level, 'silent');
  });

  it('makes child loggers per module', () => {
    const child = childFor({ module: 'chain' });
    assert.equal(typeof child.info, 'function');
  });

  it('silences probe endpoints so they do not drown the log', () => {
    const options = httpLoggerOptions(logger);
    const res = { statusCode: 200 };
    assert.equal(options.customLogLevel({ url: '/healthz' }, res, null), 'silent');
    assert.equal(options.customLogLevel({ url: '/readyz' }, res, null), 'silent');
    assert.equal(options.customLogLevel({ url: '/metrics' }, res, null), 'silent');
    assert.equal(options.autoLogging.ignore({ url: '/healthz' }), true);
    assert.equal(options.autoLogging.ignore({ url: '/api/v1/memories' }), false);
  });

  it('levels a response by its status', () => {
    const options = httpLoggerOptions(logger);
    const req = { url: '/api/v1/memories' };
    assert.equal(options.customLogLevel(req, { statusCode: 500 }, null), 'error');
    assert.equal(options.customLogLevel(req, { statusCode: 429 }, null), 'warn');
    assert.equal(options.customLogLevel(req, { statusCode: 400 }, null), 'info');
    assert.equal(options.customLogLevel(req, { statusCode: 200 }, null), 'info');
  });

  it('records whether a key was used, never which one', () => {
    const props = httpLoggerOptions(logger).customProps({
      id: 'r1',
      auth: { ok: true, mode: 'api-key' },
      headers: { 'x-api-key': API_TOKEN },
    });
    assert.deepEqual(props, { requestId: 'r1', apiKeyUsed: true });
    assert.equal(JSON.stringify(props).includes(API_TOKEN), false);
  });

  it('reduces req and res to the fields worth keeping', () => {
    const options = httpLoggerOptions(logger);
    const req = options.serializers.req({
      id: 'r1',
      method: 'POST',
      url: '/x',
      remoteAddress: '203.0.113.1',
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    assert.deepEqual(Object.keys(req).sort(), ['id', 'method', 'remoteAddress', 'url']);
    assert.deepEqual(options.serializers.res({ statusCode: 204, headers: {} }), {
      statusCode: 204,
    });
  });
});
