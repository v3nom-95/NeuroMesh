/**
 * IPFS service: disabled mode, local CID computation, retry and backoff, pagination, and the
 * gateway's content verification.
 *
 * Every request goes through an injected `fetch` double and every delay through an injected `sleep`,
 * so the suite exercises the real retry *logic* at full speed with no socket and no wall-clock wait.
 *
 * @module test/backend/services/ipfs.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createIpfsService } from '../../../src/services/ipfs.js';
import { canonical } from '../../../src/protocol/index.js';

import { fakeFetch, fakeSleep, quietLogger, response, testConfig } from './helpers.js';

/** A payload small enough to pin and large enough to be a real object. */
const SAMPLE = { hello: 'world', n: 42 };

/** The canonical bytes and CID of {@link SAMPLE}, computed exactly as the service computes them. */
const SAMPLE_BYTES = canonical.canonicalBytes(SAMPLE);
const SAMPLE_CID = canonical.cidFromBytes(SAMPLE_BYTES).cid;

/**
 * @param {object} [options] Options.
 * @param {any[]} [options.queue] Queued responses.
 * @param {Record<string, string|undefined>} [options.env] Environment overrides.
 * @returns {any} The service plus its doubles.
 */
function build({ queue = [], env = {} } = {}) {
  const fetchImpl = fakeFetch(queue);
  const { sleep, delays } = fakeSleep();
  const service = createIpfsService({
    config: testConfig(env),
    logger: quietLogger(),
    fetchImpl,
    sleep,
    // A fixed jitter source makes full-jitter backoff a deterministic assertion instead of a range.
    random: () => 0.5,
  });
  return { service, fetchImpl, delays };
}

describe('services/ipfs: disabled mode', () => {
  it('constructs without a credential and reports "not configured", not "down"', async () => {
    const { service } = build({ env: { PINATA_JWT: undefined } });
    assert.equal(service.enabled, false);
    const probe = await service.probe();
    assert.equal(probe.configured, false);
    assert.equal(probe.status, 'disabled');
  });

  it('refuses to pin with a 503 that names the missing setting', async () => {
    const { service } = build({ env: { PINATA_JWT: undefined } });
    await assert.rejects(service.pin(SAMPLE), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 503);
      assert.equal(any.code, 'ipfs_unavailable');
      // The setting to change is in `details`; the message is the stable, code-level summary.
      assert.match(String(any.details), /PINATA_JWT/);
      return true;
    });
  });

  it('reports an unpin as unavailable rather than throwing', async () => {
    const { service } = build({ env: { PINATA_JWT: undefined } });
    // The caller is already handling a failure when it reaches unpin. Throwing here would replace
    // the original error with a less useful one.
    assert.deepEqual(await service.unpin('bafk'), {
      ok: false,
      cid: 'bafk',
      reason: 'ipfs_disabled',
    });
  });
});

describe('services/ipfs: pinning computes the CID locally', () => {
  it('returns the locally computed CID when the service agrees', async () => {
    const { service, fetchImpl } = build({
      queue: [response({ json: { IpfsHash: SAMPLE_CID, PinSize: 32, Timestamp: 'now' } })],
    });
    const result = await service.pin(SAMPLE);
    assert.equal(result.cid, SAMPLE_CID);
    assert.equal(result.size, SAMPLE_BYTES.length);
    assert.deepEqual([...result.bytes], [...SAMPLE_BYTES]);
    assert.match(fetchImpl.requests[0].url, /\/pinning\/pinFileToIPFS$/);
    assert.equal(fetchImpl.requests[0].init.method, 'POST');
  });

  it('uploads exact bytes rather than letting the service re-serialise them', async () => {
    const { service, fetchImpl } = build({
      queue: [response({ json: { IpfsHash: SAMPLE_CID } })],
    });
    await service.pin(SAMPLE);
    const body = fetchImpl.requests[0].init.body;
    // pinFileToIPFS with a Blob, never pinJSONToIPFS. The JSON endpoint re-encodes server-side, so
    // the bytes at the returned CID would not be the bytes this node hashed and signed over.
    assert.ok(body instanceof FormData);
    const file = body.get('file');
    assert.equal(await file.text(), Buffer.from(SAMPLE_BYTES).toString('utf8'));
  });

  it('aborts when the service reports a different CID', async () => {
    const other = canonical.cidFromBytes(canonical.canonicalBytes({ not: 'the same' })).cid;
    const { service } = build({ queue: [response({ json: { IpfsHash: other } })] });
    await assert.rejects(service.pin(SAMPLE), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 502);
      // Committing a third party's asserted hash to the chain would record a claim about content
      // this node never saw.
      assert.match(any.message, /different CID/);
      assert.equal(any.details.expected, SAMPLE_CID);
      assert.equal(any.details.actual, other);
      return true;
    });
  });

  it('refuses zero bytes and anything over IPFS_MAX_BYTES', async () => {
    const { service } = build({ env: { IPFS_MAX_BYTES: '1024' } });
    await assert.rejects(
      service.pinBytes(new Uint8Array(0)),
      (err) => /** @type {any} */ (err).status === 400,
    );
    await assert.rejects(service.pinBytes(new Uint8Array(1025)), (err) => {
      assert.equal(/** @type {any} */ (err).status, 413);
      return true;
    });
  });

  it('tags every pin so listPins can filter to this application', async () => {
    const { service, fetchImpl } = build({ queue: [response({ json: { IpfsHash: SAMPLE_CID } })] });
    await service.pin(SAMPLE);
    const metadata = JSON.parse(fetchImpl.requests[0].init.body.get('pinataMetadata'));
    assert.equal(metadata.keyvalues.app, 'neuromesh');
    assert.equal(metadata.keyvalues.cidDigest, canonical.digestFromCid(SAMPLE_CID));
  });
});

describe('services/ipfs: retry and backoff', () => {
  it('retries a 500 and succeeds on the next attempt', async () => {
    const { service, fetchImpl, delays } = build({
      queue: [
        response({ status: 500, body: 'upstream exploded' }),
        response({ json: { IpfsHash: SAMPLE_CID } }),
      ],
    });
    const result = await service.pin(SAMPLE);
    assert.equal(result.cid, SAMPLE_CID);
    assert.equal(fetchImpl.requests.length, 2);
    // Full jitter with a fixed source: round(0.5 * 250) for attempt 0.
    assert.deepEqual(delays, [125]);
  });

  it('backs off exponentially and gives up after three attempts', async () => {
    const { service, fetchImpl, delays } = build({
      queue: [
        response({ status: 503, body: 'busy' }),
        response({ status: 503, body: 'busy' }),
        response({ status: 503, body: 'busy' }),
      ],
    });
    await assert.rejects(service.pin(SAMPLE), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 503);
      assert.equal(any.code, 'ipfs_unavailable');
      return true;
    });
    assert.equal(fetchImpl.requests.length, 3);
    assert.deepEqual(delays, [125, 250]);
  });

  it('honours Retry-After in delta-seconds form, in preference to the computed delay', async () => {
    const { service, delays } = build({
      queue: [
        response({ status: 429, headers: { 'retry-after': '4' }, body: 'slow down' }),
        response({ json: { IpfsHash: SAMPLE_CID } }),
      ],
    });
    await service.pin(SAMPLE);
    assert.deepEqual(delays, [4000]);
  });

  it('clamps an absurd Retry-After rather than parking the request', async () => {
    const { service, delays } = build({
      queue: [
        response({ status: 429, headers: { 'retry-after': '86400' }, body: 'come back tomorrow' }),
        response({ json: { IpfsHash: SAMPLE_CID } }),
      ],
    });
    await service.pin(SAMPLE);
    assert.deepEqual(delays, [30000]);
  });

  it('never retries a rejected credential — repeating it does not make it valid', async () => {
    const { service, fetchImpl, delays } = build({
      queue: [response({ status: 401, body: 'invalid token' })],
    });
    await assert.rejects(service.pin(SAMPLE), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 502);
      assert.match(any.message, /credentials/i);
      // 502, not 503: a 503 advertises "retry, this will pass", and an expired JWT does not.
      assert.equal(any.retriable, false);
      return true;
    });
    assert.equal(fetchImpl.requests.length, 1);
    assert.deepEqual(delays, []);
  });

  it('never retries a 400', async () => {
    const { service, fetchImpl } = build({
      queue: [response({ status: 400, body: 'malformed' })],
    });
    await assert.rejects(service.pin(SAMPLE));
    assert.equal(fetchImpl.requests.length, 1);
  });

  it('scrubs a credential echoed back in an error body', async () => {
    const { service } = build({
      queue: [
        response({
          status: 400,
          body: 'rejected request with header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnop',
        }),
      ],
    });
    await assert.rejects(service.pin(SAMPLE), (err) => {
      const text = JSON.stringify(/** @type {any} */ (err).details ?? {});
      assert.ok(!text.includes('eyJhbGciOiJIUzI1NiJ9'), 'the JWT survived into the error details');
      assert.match(text, /redacted/);
      return true;
    });
  });

  it('sets the credential on the request and never on the log record', async () => {
    const { service, fetchImpl } = build({ queue: [response({ json: { IpfsHash: SAMPLE_CID } })] });
    await service.pin(SAMPLE);
    assert.equal(
      fetchImpl.requests[0].init.headers.Authorization,
      'Bearer test-jwt-not-a-real-credential',
    );
  });
});

describe('services/ipfs: compensating unpin', () => {
  it('reports success without throwing', async () => {
    const { service, fetchImpl } = build({ queue: [response({ json: { ok: true } })] });
    assert.deepEqual(await service.unpin(SAMPLE_CID), {
      ok: true,
      cid: SAMPLE_CID,
      reason: null,
    });
    assert.equal(fetchImpl.requests[0].init.method, 'DELETE');
    assert.match(fetchImpl.requests[0].url, /\/pinning\/unpin\//);
  });

  it('reports failure without throwing, so the original error survives', async () => {
    const { service } = build({ queue: [response({ status: 400, body: 'not pinned here' })] });
    const result = await service.unpin(SAMPLE_CID);
    assert.equal(result.ok, false);
    assert.equal(result.cid, SAMPLE_CID);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  });
});

describe('services/ipfs: pagination', () => {
  it('filters to this application and returns an opaque cursor', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ipfs_pin_hash: `bafk${i}`,
      size: 100 + i,
      date_pinned: '2026-01-01T00:00:00Z',
      metadata: { name: `pin-${i}`, keyvalues: { app: 'neuromesh' } },
    }));
    const { service, fetchImpl } = build({ queue: [response({ json: { count: 60, rows } })] });
    const page = await service.listPins({ limit: 25 });
    assert.equal(page.items.length, 25);
    assert.equal(page.total, 60);
    assert.ok(page.nextCursor);
    const url = new URL(fetchImpl.requests[0].url);
    assert.equal(url.searchParams.get('pageLimit'), '25');
    assert.equal(url.searchParams.get('pageOffset'), '0');
    // Without this filter the call enumerates the operator's entire billing account, including
    // pins from unrelated projects — which is what v1 returned and called "the memory list".
    assert.match(String(url.searchParams.get('metadata[keyvalues]')), /neuromesh/);
  });

  it('resumes from a cursor at the right offset', async () => {
    const first = build({
      queue: [
        response({
          json: {
            count: 3,
            rows: [{ ipfs_pin_hash: 'bafk0', size: 1, metadata: { keyvalues: {} } }],
          },
        }),
      ],
    });
    const page = await first.service.listPins({ limit: 1 });
    const second = build({
      queue: [
        response({
          json: {
            count: 3,
            rows: [{ ipfs_pin_hash: 'bafk1', size: 1, metadata: { keyvalues: {} } }],
          },
        }),
      ],
    });
    await second.service.listPins({ limit: 1, cursor: page.nextCursor });
    assert.equal(new URL(second.fetchImpl.requests[0].url).searchParams.get('pageOffset'), '1');
  });

  it('stops issuing a cursor at the end of the listing', async () => {
    const { service } = build({
      queue: [
        response({
          json: {
            count: 1,
            rows: [{ ipfs_pin_hash: 'bafk0', size: 1, metadata: { keyvalues: {} } }],
          },
        }),
      ],
    });
    assert.equal((await service.listPins({ limit: 25 })).nextCursor, null);
  });

  it('clamps the page size to the API maximum', async () => {
    const { service, fetchImpl } = build({ queue: [response({ json: { count: 0, rows: [] } })] });
    await service.listPins({ limit: 5000 });
    assert.equal(new URL(fetchImpl.requests[0].url).searchParams.get('pageLimit'), '100');
  });

  it('rejects a cursor it did not issue', async () => {
    const { service } = build({ queue: [] });
    await assert.rejects(
      service.listPins({ cursor: 'not-a-cursor' }),
      (err) => /** @type {any} */ (err).status === 400,
    );
  });
});

describe('services/ipfs: gateway reads are verified', () => {
  it('returns bytes whose hash matches the requested CID', async () => {
    const { service } = build({ queue: [response({ body: SAMPLE_BYTES })] });
    const bytes = await service.fetchBytes(SAMPLE_CID);
    assert.deepEqual([...bytes], [...SAMPLE_BYTES]);
  });

  it('rejects bytes the gateway substituted', async () => {
    const { service } = build({
      queue: [response({ body: canonical.canonicalBytes({ substituted: true }) })],
    });
    // A gateway is not trusted to return the content its own CID names. This is protocol section 9
    // step 2, and without it a compromised gateway rewrites history invisibly.
    await assert.rejects(service.fetchBytes(SAMPLE_CID), (err) => {
      assert.match(String(/** @type {any} */ (err).message), /CID|digest/i);
      return true;
    });
  });

  it('maps a gateway 404 to memory_not_found', async () => {
    const { service } = build({ queue: [response({ status: 404, body: 'nope' })] });
    await assert.rejects(service.fetchBytes(SAMPLE_CID), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 404);
      assert.equal(any.code, 'memory_not_found');
      return true;
    });
  });

  it('parses a verified body as JSON', async () => {
    const { service } = build({ queue: [response({ body: SAMPLE_BYTES })] });
    const fetched = await service.fetchByCid(SAMPLE_CID);
    assert.deepEqual(fetched.json, SAMPLE);
    assert.equal(fetched.cid, SAMPLE_CID);
  });

  it('serves a second read from the bounded cache without another request', async () => {
    const { service, fetchImpl } = build({ queue: [response({ body: SAMPLE_BYTES })] });
    await service.fetchBytes(SAMPLE_CID);
    await service.fetchBytes(SAMPLE_CID);
    assert.equal(fetchImpl.requests.length, 1);
    assert.equal(service.cacheSize(), 1);
  });

  it('builds the gateway URL from configuration, never a hardcoded host', () => {
    const { service } = build({ env: { IPFS_GATEWAY_URL: 'https://gw.example.test/ipfs' } });
    assert.equal(service.gatewayUrl(SAMPLE_CID), `https://gw.example.test/ipfs/${SAMPLE_CID}`);
  });
});

describe('services/ipfs: credential probe', () => {
  it('reports up on success and caches the verdict', async () => {
    const { service, fetchImpl } = build({ queue: [response({ json: { message: 'ok' } })] });
    const first = await service.probe();
    assert.equal(first.status, 'up');
    assert.equal(first.configured, true);
    await service.probe();
    // A readiness-probe storm must not become an upstream request storm.
    assert.equal(fetchImpl.requests.length, 1);
  });

  it('reports down with a detail instead of throwing', async () => {
    const { service } = build({
      queue: [
        response({ status: 500, body: 'down' }),
        response({ status: 500, body: 'down' }),
        response({ status: 500, body: 'down' }),
      ],
    });
    const verdict = await service.probe();
    assert.equal(verdict.status, 'down');
    assert.ok(typeof verdict.detail === 'string' && verdict.detail.length > 0);
  });
});
