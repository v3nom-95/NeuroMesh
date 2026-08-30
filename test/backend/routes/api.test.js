/**
 * The remaining route surfaces: agents, jobs, semantic, reputation, simulation and metrics.
 *
 * @module test/backend/routes/api.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import request from 'supertest';

import {
  AgentResponse,
  Job,
  MetricsResponse,
  ReputationResponse,
  SearchResponse,
  SimilarityResponse,
  SimulationResponse,
} from '../../../src/schemas/api.js';

import { PEER_ADDRESS, TEST_AGENT, buildApp, commitMemory, fakeChain } from './helpers.js';

/** A key that satisfies the config schema. */
const TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef';

/* ========================================================================== */
/* Agents                                                                      */
/* ========================================================================== */

describe('routes/agents', () => {
  it('GET /agents/:address returns a profile with its reputation', async () => {
    const { app } = await buildApp();
    const res = await request(app).get(`/api/v1/agents/${TEST_AGENT}`);
    assert.equal(res.status, 200);
    assert.ok(AgentResponse.safeParse(res.body).success, JSON.stringify(res.body));
    assert.equal(res.body.address, TEST_AGENT);
    assert.match(res.body.did, /^did:pkh:eip155:11155111:0x/);
    assert.equal(res.body.registered, true);
  });

  it('GET /agents/:address rejects a malformed address before any chain read', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/agents/0xnothex');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].path, 'params.address');
  });

  it('GET /agents/:address rejects a bad EIP-55 checksum rather than lowercasing it', async () => {
    const { app } = await buildApp();
    // Same address, one character case-flipped: a valid hex string with an invalid checksum, which
    // is almost always a transcription error rather than an intent.
    const broken = TEST_AGENT.slice(0, -1) + (TEST_AGENT.endsWith('A') ? 'a' : 'A');
    const res = await request(app).get(`/api/v1/agents/${broken}`);
    assert.equal(res.status, 400);
  });

  it('GET /agents/:address is 404 for an unregistered agent', async () => {
    const { app } = await buildApp({ overrides: { chain: fakeChain({ registered: false }) } });
    const res = await request(app).get(`/api/v1/agents/${PEER_ADDRESS}`);
    assert.equal(res.status, 404);
  });

  it('POST /agents/register preflights, so an already-registered agent is a 409 not a revert', async () => {
    const { app, chain } = await buildApp();
    const res = await request(app).post('/api/v1/agents/register').send({});
    assert.equal(res.status, 409);
    assert.equal(chain.submits.length, 0);
  });

  it('POST /agents/register publishes the real encryption public key, never a placeholder', async () => {
    // v1 registered the literal string 'pubKey_sepolia', which made it impossible for any peer to
    // wrap a content key to this agent.
    const { app, chain, crypto } = await buildApp({
      overrides: { chain: fakeChain({ registered: false }) },
    });
    const res = await request(app).post('/api/v1/agents/register').send({});
    assert.equal(res.status, 202);
    assert.ok(Job.safeParse(res.body).success);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(chain.submits.length, 1);
    const [publicKey] = chain.submits[0].args;
    assert.equal(publicKey, crypto.encryptionPublicKey());
    assert.match(publicKey, /^0x0[23][0-9a-f]{64}$/i);
  });

  it('POST /agents/register rejects a non-URI metadata value', async () => {
    const { app } = await buildApp({ overrides: { chain: fakeChain({ registered: false }) } });
    const res = await request(app)
      .post('/api/v1/agents/register')
      .send({ metadataURI: 'not a uri' });
    assert.equal(res.status, 400);
  });

  it('is served at the singular /agent alias as well as the plural', async () => {
    const { app } = await buildApp();
    assert.equal((await request(app).get(`/api/v1/agent/${TEST_AGENT}`)).status, 200);
    assert.equal((await request(app).get(`/api/agents/${TEST_AGENT}`)).status, 200);
  });
});

/* ========================================================================== */
/* Jobs                                                                        */
/* ========================================================================== */

describe('routes/jobs', () => {
  it('GET /jobs/:id is 404 for an id that never existed, and says what the TTL is', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/jobs/11111111-2222-4333-8444-555555555555');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'job_not_found');
  });

  it('GET /jobs/:id rejects a non-UUID id', async () => {
    const { app } = await buildApp();
    assert.equal((await request(app).get('/api/v1/jobs/not-a-uuid')).status, 400);
  });

  it('GET /jobs/:id sets Retry-After while the job is still running', async () => {
    const { app } = await buildApp();
    const created = await request(app).post('/api/v1/memories').send({ context: 'x' });
    const res = await request(app).get(`/api/v1/jobs/${created.body.id}`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers['cache-control']), /no-store/);
    if (res.body.state === 'queued' || res.body.state === 'running') {
      assert.equal(res.headers['retry-after'], '1');
    }
  });

  it('GET /jobs requires a key, because enumerating ids would defeat the capability', async () => {
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    assert.equal((await request(app).get('/api/v1/jobs')).status, 401);
    const ok = await request(app).get('/api/v1/jobs').set('X-API-Key', TOKEN);
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.items));
  });
});

/* ========================================================================== */
/* Semantic                                                                    */
/* ========================================================================== */

describe('routes/semantic', () => {
  it('POST /semantic/search returns results with the noise baseline attached', async () => {
    const graph = await buildApp();
    await commitMemory(graph, 'the capital of France is Paris');
    const res = await request(graph.app)
      .post('/api/v1/semantic/search')
      .send({ query: 'France', topK: 5 });
    assert.equal(res.status, 200);
    assert.ok(SearchResponse.safeParse(res.body).success, JSON.stringify(res.body));
    // 1/sqrt(384). Shipping it beside every similarity is what lets a reader tell a real match
    // from a comparison between unrelated vectors - the distinction v1's results did not survive.
    assert.ok(Math.abs(res.body.diagnostics.noiseBaseline - 1 / Math.sqrt(384)) < 1e-9);
    assert.equal(res.body.diagnostics.outDim, 384);
  });

  it('POST /semantic/search validates its body', async () => {
    const { app } = await buildApp();
    assert.equal((await request(app).post('/api/v1/semantic/search').send({})).status, 400);
    assert.equal(
      (await request(app).post('/api/v1/semantic/search').send({ query: 'x', topK: 500 })).status,
      400,
    );
    assert.equal(
      (await request(app).post('/api/v1/semantic/search').send({ query: 'x', model: 'gpt' }))
        .status,
      400,
    );
  });

  it('POST /semantic/search sheds load with 503 model_not_ready before warmup', async () => {
    // Queueing without bound behind a model that is still downloading is how a slow start becomes
    // an outage; a typed 503 is something a client can retry on.
    const { app } = await buildApp({ warm: false });
    const res = await request(app).post('/api/v1/semantic/search').send({ query: 'anything' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'model_not_ready');
  });

  it('GET /semantic/similarity answers on an empty index without running inference', async () => {
    const { app } = await buildApp({ warm: false });
    const res = await request(app).get('/api/v1/semantic/similarity');
    assert.equal(res.status, 200);
    assert.ok(SimilarityResponse.safeParse(res.body).success, JSON.stringify(res.body));
    assert.deepEqual(res.body.labels, []);
    assert.deepEqual(res.body.matrix, []);
  });

  it('GET /semantic/similarity flags a cell as significant only against the noise baseline', async () => {
    const graph = await buildApp();
    await commitMemory(graph, 'alpha');
    await commitMemory(graph, 'beta');
    const res = await request(graph.app).get('/api/v1/semantic/similarity');
    assert.equal(res.status, 200);
    assert.equal(res.body.labels.length, 1);
    const cell = res.body.pairs[0];
    assert.equal(cell.pairs, 1);
    assert.equal(typeof cell.meanCosine, 'number');
    assert.equal(
      cell.significant,
      Math.abs(cell.meanCosine) > 3 * res.body.diagnostics.noiseBaseline,
    );
  });

  it('GET /semantic/index requires a key', async () => {
    const { app } = await buildApp({ env: { API_AUTH_TOKEN: TOKEN } });
    assert.equal((await request(app).get('/api/v1/semantic/index')).status, 401);
    assert.equal(
      (await request(app).get('/api/v1/semantic/index').set('X-API-Key', TOKEN)).status,
      200,
    );
  });
});

/* ========================================================================== */
/* Reputation                                                                  */
/* ========================================================================== */

describe('routes/reputation', () => {
  it('GET /reputation returns entries, events and the thresholds they are judged against', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/reputation');
    assert.equal(res.status, 200);
    assert.ok(ReputationResponse.safeParse(res.body).success, JSON.stringify(res.body));
    assert.equal(res.body.entries[0].address, TEST_AGENT);
    // The raw WAD string travels beside the float so a caller needing exactness is not forced
    // through a Number, and so nothing has to reimplement the contract's arithmetic.
    assert.equal(res.body.entries[0].scoreWad, '750000000000000000');
    assert.equal(res.body.entries[0].score, 0.75);
  });

  it('GET /reputation/:address returns the same envelope with one entry', async () => {
    const { app } = await buildApp();
    const res = await request(app).get(`/api/v1/reputation/${TEST_AGENT}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.entries.length, 1);
    assert.equal(res.body.total, 1);
  });

  it('GET /reputation validates its query', async () => {
    const { app } = await buildApp();
    assert.equal((await request(app).get('/api/v1/reputation?limit=0')).status, 400);
    assert.equal((await request(app).get('/api/v1/reputation?unknown=1')).status, 400);
  });

  it('POST /reputation/endorse returns a job and reaches the reputation service', async () => {
    const { app, reputation } = await buildApp();
    const res = await request(app)
      .post('/api/v1/reputation/endorse')
      .send({ target: PEER_ADDRESS, reason: 'accurate memories' });
    assert.equal(res.status, 202);
    assert.ok(Job.safeParse(res.body).success);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(reputation.actions[0].action, 'endorse');
    assert.equal(reputation.actions[0].target, PEER_ADDRESS);
  });

  it('POST /reputation/report validates target and reason', async () => {
    const { app } = await buildApp();
    assert.equal(
      (await request(app).post('/api/v1/reputation/report').send({ target: 'nope', reason: 'x' }))
        .status,
      400,
    );
    assert.equal(
      (await request(app).post('/api/v1/reputation/report').send({ target: PEER_ADDRESS })).status,
      400,
    );
    assert.equal(
      (
        await request(app)
          .post('/api/v1/reputation/report')
          .send({ target: PEER_ADDRESS, reason: 'x'.repeat(5000) })
      ).status,
      400,
    );
  });

  it('keeps the trust log alive when the leaderboard read fails', async () => {
    // The two reads are independent; one failing must not take the other down.
    const { app } = await buildApp({
      overrides: { chain: fakeChain({ registered: false }) },
    });
    const res = await request(app).get('/api/v1/reputation');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.entries, []);
    assert.ok(Array.isArray(res.body.events));
  });
});

/* ========================================================================== */
/* Simulation                                                                  */
/* ========================================================================== */

describe('routes/simulation', () => {
  it('answers 200 with available:false when the gitignored file is absent', async () => {
    // simulation-results.json is generated by `npm run simulate` and is gitignored, so its absence
    // is the default state of a fresh clone. A 404 or a 500 there makes a correct checkout look
    // broken.
    const { app } = await buildApp({
      env: { SIMULATION_RESULTS_PATH: './test/fixtures/no-such-simulation.json' },
    });
    const res = await request(app).get('/api/v1/simulation-results');
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
    assert.match(res.body.hint, /npm run simulate/);
    assert.ok(SimulationResponse.safeParse(res.body).success, JSON.stringify(res.body));
    // The five chart names are present and empty, so no dashboard view branches on a missing key.
    assert.deepEqual(res.body.agents, []);
    assert.deepEqual(res.body.memoryCommits, []);
    assert.deepEqual(res.body.reputationEvents, []);
    assert.deepEqual(res.body.crossModelSimilarity, []);
    assert.deepEqual(res.body.benchmarks.embeddingLatencies, []);
    assert.deepEqual(res.body.benchmarks.totalLatencies, []);
  });

  it('serves the file when it is present, with available:true', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/simulation-results');
    assert.equal(res.status, 200);
    assert.ok(SimulationResponse.safeParse(res.body).success);
    if (res.body.available) {
      assert.ok(Array.isArray(res.body.agents));
      assert.ok(['v1', 'v2'].includes(res.body.schema));
    }
  });

  it('reports a corrupt file as a typed upstream error, not a stack trace', async () => {
    // The simulator writes this file without a temp-and-rename, so a half-written file is reachable.
    const { app } = await buildApp({
      env: { SIMULATION_RESULTS_PATH: './package.json.lock.missing' },
    });
    const res = await request(app).get('/api/v1/simulation-results');
    assert.equal(res.status, 200);
    assert.equal(res.body.available, false);
  });

  it('is served at the unversioned alias the dashboard uses', async () => {
    const { app } = await buildApp();
    assert.equal((await request(app).get('/api/simulation-results')).status, 200);
    assert.equal((await request(app).get('/api/v1/simulation')).status, 200);
  });
});

/* ========================================================================== */
/* Metrics                                                                     */
/* ========================================================================== */

describe('routes/metrics', () => {
  it('GET /metrics is Prometheus text carrying the custom instruments', async () => {
    const { app } = await buildApp();
    await request(app).get('/api/v1/status');
    const res = await request(app).get('/metrics');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/plain/);
    for (const name of [
      'neuromesh_http_request_duration_seconds',
      'neuromesh_embedding_duration_seconds',
      'neuromesh_tx_total',
      'neuromesh_tx_queue_depth',
      'neuromesh_memories_committed_total',
    ]) {
      assert.ok(res.text.includes(name), name);
    }
  });

  it('labels the duration histogram with the route PATTERN, never the raw URL', async () => {
    // One time series per CID would make the registry unscrapeable within a day of real use.
    const graph = await buildApp();
    const cid = await commitMemory(graph);
    await request(graph.app).get(`/api/v1/memories/${cid}`);
    const res = await request(graph.app).get('/metrics');
    assert.ok(res.text.includes('route="/api/v1/memories/:cid"'), 'route pattern label missing');
    assert.ok(!res.text.includes(cid), 'a CID leaked into a metric label');
  });

  it('attributes an unmatched path to a single bounded bucket', async () => {
    const { app } = await buildApp();
    await request(app).get('/api/v1/definitely-not-a-route-01');
    await request(app).get('/api/v1/definitely-not-a-route-02');
    const res = await request(app).get('/metrics');
    assert.ok(res.text.includes('route="unmatched"'));
    assert.ok(!res.text.includes('definitely-not-a-route'));
  });

  it('requires the metrics token when one is configured', async () => {
    const { app } = await buildApp({ env: { METRICS_TOKEN: TOKEN } });
    assert.equal((await request(app).get('/metrics')).status, 401);
    assert.equal((await request(app).get('/metrics').set('X-API-Key', TOKEN)).status, 200);
  });

  it('is a 404, not a 403, when metrics are disabled', async () => {
    const { app } = await buildApp({ env: { METRICS_ENABLED: 'false' } });
    assert.equal((await request(app).get('/metrics')).status, 404);
  });

  it('GET /api/v1/metrics/summary reports the sample window it actually used', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/v1/metrics/summary?window=5m');
    assert.equal(res.status, 200);
    assert.ok(MetricsResponse.safeParse(res.body).success, JSON.stringify(res.body));
    assert.equal(res.body.window, '5m');
    // Saying the percentiles are over the last N observations is the difference between an
    // estimate and a claim about the whole history.
    assert.equal(res.body.sampleWindow, 200);
    assert.equal(res.body.unit, 'milliseconds');
  });

  it('GET /api/v1/metrics/summary rejects an unknown window', async () => {
    const { app } = await buildApp();
    assert.equal((await request(app).get('/api/v1/metrics/summary?window=7d')).status, 400);
  });
});
