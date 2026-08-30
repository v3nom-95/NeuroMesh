/**
 * `ROUTE_TABLE` - the one source of truth for every path this node serves - and the routers that
 * realise it.
 *
 * ## Why a table
 *
 * Three consumers need to agree on the API surface: the Express routers, the OpenAPI document, and
 * the dashboard's frozen `ENDPOINTS` map in `public/js/api.js`. Before this file they agreed by
 * coincidence, and did not: the docs published `/api/v1/node` and `/api/v1/agents/{address}/endorse`
 * while the client called `/api/status` and `/api/reputation/endorse`. Here every path is declared
 * once, `src/openapi.js` is generated from this table, and a test walks the table issuing a real
 * request per row, so a route cannot ship undocumented and a documented route cannot be missing.
 *
 * ## Canonical paths and legacy aliases
 *
 * The canonical surface is `/api/v1/...`. The unversioned `/api/...` paths are **live aliases**,
 * not tombstones: the shipped dashboard's `ENDPOINTS` map is frozen on them, and answering 410
 * there would break the console this node serves. They resolve to the identical handlers, share the
 * identical rate-limit buckets, and are listed on each row as `aliases` so nothing about them is
 * implicit.
 *
 * Two singular spellings - `/api/v1/agent/...` and `/api/v1/simulation` - are also aliased, because
 * the cross-lane review settled on singular `agent` while the shipped client uses plural `agents`.
 * Serving both costs one line and removes a one-character trap from the integration.
 *
 * ## The one path that is NOT here
 *
 * `/api/decrypt` appears nowhere in this table, has no alias, and gets no hint from the 404
 * handler. It was an unauthenticated decryption oracle driven by the node's private key. It is
 * gone, and the replacement - `POST /api/v1/memories/:cid/decrypt`, which accepts no ciphertext -
 * is discoverable through the OpenAPI document, which is where a legitimate client looks.
 *
 * @module src/routes/index
 */
import { Router } from 'express';

import { createAgentRoutes } from './agents.js';
import { createHealthRoutes, createProbeRoutes } from './health.js';
import { createJobRoutes } from './jobs.js';
import { createMemoryRoutes } from './memory.js';
import { createMetricsRoutes, createMetricsSummaryRoutes } from './metrics.js';
import { createReputationRoutes } from './reputation.js';
import { createSemanticRoutes } from './semantic.js';
import { createSimulationRoutes } from './simulation.js';

/** The version prefix every canonical API path carries. */
export const API_PREFIX = '/api/v1';

/** The unversioned prefix the shipped dashboard is frozen on. */
export const LEGACY_PREFIX = '/api';

/**
 * Every route this node serves.
 *
 * @typedef {object} RouteEntry
 * @property {string} id Stable operation id; also the OpenAPI `operationId`.
 * @property {'get'|'post'} method HTTP method, lowercase.
 * @property {string} path Canonical full path, with `:param` segments.
 * @property {string[]} aliases Additional live paths that resolve to the same handler.
 * @property {string} tag OpenAPI tag.
 * @property {string} summary One-line description.
 * @property {string} description Longer description, including the operational caveats.
 * @property {boolean} auth Whether an API key is required.
 * @property {string|null} limiter Which rate-limit bucket applies.
 * @property {string|null} params Name of the params schema in `src/schemas/api.js`.
 * @property {string|null} query Name of the query schema.
 * @property {string|null} body Name of the request-body schema.
 * @property {string|null} response Name of the success-response schema.
 * @property {number[]} statuses Every status code this route can emit.
 * @property {number} success The status a successful call returns.
 */

/** @type {readonly RouteEntry[]} */
export const ROUTE_TABLE = Object.freeze(
  /** @type {RouteEntry[]} */ ([
    {
      id: 'liveness',
      method: 'get',
      path: '/healthz',
      aliases: ['/api/v1/health', '/api/health'],
      tag: 'Health',
      summary: 'Liveness probe.',
      description:
        'Always 200 while the process is up, including while draining. Touches no dependency: ' +
        'a liveness probe that fails because a third-party RPC endpoint is slow restarts a ' +
        'healthy pod. The Dockerfile HEALTHCHECK targets this path.',
      auth: false,
      limiter: null,
      params: null,
      query: null,
      body: null,
      response: 'HealthResponse',
      statuses: [200],
      success: 200,
    },
    {
      id: 'readiness',
      method: 'get',
      path: '/readyz',
      aliases: ['/api/v1/ready', '/api/ready'],
      tag: 'Health',
      summary: 'Readiness probe.',
      description:
        '200 when every critical dependency is up, 503 otherwise and immediately once a drain ' +
        'begins. The body is identical at both statuses so a probe and the dashboard read the ' +
        'same document.',
      auth: false,
      limiter: null,
      params: null,
      query: null,
      body: null,
      response: 'ReadinessResponse',
      statuses: [200, 503],
      success: 200,
    },
    {
      id: 'metrics',
      method: 'get',
      path: '/metrics',
      aliases: [],
      tag: 'Metrics',
      summary: 'Prometheus exposition.',
      description:
        'Default process metrics plus the custom instruments. Guarded by METRICS_TOKEN when one ' +
        'is configured; 404 when metrics are disabled, so a disabled endpoint is indistinguishable ' +
        'from a nonexistent one.',
      auth: false,
      limiter: null,
      params: null,
      query: null,
      body: null,
      response: null,
      statuses: [200, 401, 404],
      success: 200,
    },
    {
      id: 'openapi',
      method: 'get',
      path: '/openapi.json',
      aliases: ['/api/docs.json', '/api/v1/openapi.json'],
      tag: 'Health',
      summary: 'The OpenAPI 3.1 document.',
      description: 'Generated from the zod schemas and this route table, so it cannot drift.',
      auth: false,
      limiter: null,
      params: null,
      query: null,
      body: null,
      response: null,
      statuses: [200],
      success: 200,
    },
    {
      id: 'docs',
      method: 'get',
      path: '/docs',
      aliases: [],
      tag: 'Health',
      summary: 'A dependency-free HTML view of the OpenAPI document.',
      description:
        'Rendered server-side from the same document. No CDN and no external script, because the ' +
        'CSP forbids both.',
      auth: false,
      limiter: null,
      params: null,
      query: null,
      body: null,
      response: null,
      statuses: [200],
      success: 200,
    },
    {
      id: 'status',
      method: 'get',
      path: '/api/v1/status',
      aliases: ['/api/status'],
      tag: 'Health',
      summary: 'Node identity, chain, model, IPFS and protocol state.',
      description:
        'Assembled with Promise.allSettled, so one slow dependency degrades one field rather than ' +
        'failing the request. A field that cannot be determined is null with the reason in ' +
        '/readyz - never a placeholder string, and never a fabricated default. Cached 2 s.',
      auth: false,
      limiter: 'global',
      params: null,
      query: null,
      body: null,
      response: 'StatusResponse',
      statuses: [200],
      success: 200,
    },
    {
      id: 'registerAgent',
      method: 'post',
      path: '/api/v1/agents/register',
      aliases: ['/api/agents/register', '/api/v1/agent/register'],
      tag: 'Agents',
      summary: 'Register this node on the identity contract. Spends gas.',
      description:
        "Publishes the node's real compressed secp256k1 ENCRYPTION public key, which is derived " +
        'separately from the wallet key. Preflights isRegistered so an already-registered agent ' +
        'is a 409 rather than a transaction that reverts. Returns 202 with a job.',
      auth: true,
      limiter: 'write',
      params: null,
      query: null,
      body: 'RegisterBody',
      response: 'Job',
      statuses: [202, 400, 401, 409, 429, 503],
      success: 202,
    },
    {
      id: 'getAgent',
      method: 'get',
      path: '/api/v1/agents/:address',
      aliases: ['/api/agents/:address', '/api/v1/agent/:address'],
      tag: 'Agents',
      summary: 'One agent profile, with its reputation.',
      description:
        'The address is validated and checksummed before any chain read. A failed reputation read ' +
        'yields a null score rather than failing the identity lookup.',
      auth: false,
      limiter: 'global',
      params: 'AddressParams',
      query: null,
      body: null,
      response: 'AgentResponse',
      statuses: [200, 400, 404, 429, 503],
      success: 200,
    },
    {
      id: 'createMemory',
      method: 'post',
      path: '/api/v1/memories',
      aliases: ['/api/memories'],
      tag: 'Memory',
      summary: 'Commit a memory. Spends gas and pays for a pin.',
      description:
        'Returns 202 with a job id; the six-step pipeline (embed, align, encrypt, pin, commit, ' +
        'confirm) runs in the background with a per-step duration. A failure after the pin runs a ' +
        'compensating unpin and the job still carries the CID, so a client is never left paying ' +
        'for storage it was not told about.',
      auth: true,
      limiter: 'write',
      params: null,
      query: null,
      body: 'CreateMemoryBody',
      response: 'Job',
      statuses: [202, 400, 401, 413, 429, 503],
      success: 202,
    },
    {
      id: 'listMemories',
      method: 'get',
      path: '/api/v1/memories',
      aliases: ['/api/memories'],
      tag: 'Memory',
      summary: 'A page of the memories this node has committed.',
      description:
        'Served from an in-process index of what this node committed, which the response labels ' +
        'as source: local-index. The authoritative list is the ledger owner index and the ' +
        'MemoryCommitted log; a restart empties the cache and reconcile() refills it.',
      auth: false,
      limiter: 'global',
      params: null,
      query: 'ListMemoriesQuery',
      body: null,
      response: 'MemoryListResponse',
      statuses: [200, 400, 429],
      success: 200,
    },
    {
      id: 'getMemory',
      method: 'get',
      path: '/api/v1/memories/:cid',
      aliases: ['/api/memories/:cid'],
      tag: 'Memory',
      summary: 'One memory, CID-verified server-side.',
      description:
        'The node fetches the bytes, checks sha2-256 against the CID, and parses them against the ' +
        'payload schema before answering, so the browser never talks to a third-party gateway and ' +
        "connect-src 'self' stays honest. Strong ETag; 304 on If-None-Match.",
      auth: false,
      limiter: 'global',
      params: 'MemoryParams',
      query: null,
      body: null,
      response: 'MemoryDetail',
      statuses: [200, 304, 400, 404, 429, 502, 503],
      success: 200,
    },
    {
      id: 'verifyMemory',
      method: 'get',
      path: '/api/v1/memories/:cid/verify',
      aliases: ['/api/memories/:cid/verify'],
      tag: 'Memory',
      summary: 'The step-by-step verification report for one memory.',
      description:
        'Public by design: anyone should be able to check this node’s claims without holding ' +
        'a credential from it. A step the node cannot perform is reported as skip with a reason - ' +
        'skip is not pass.',
      auth: false,
      limiter: 'global',
      params: 'MemoryParams',
      query: null,
      body: null,
      response: 'VerificationResponse',
      statuses: [200, 400, 429],
      success: 200,
    },
    {
      id: 'decryptMemory',
      method: 'post',
      path: '/api/v1/memories/:cid/decrypt',
      aliases: ['/api/memories/:cid/decrypt'],
      tag: 'Memory',
      summary: 'Unwrap one memory this node was granted access to.',
      description:
        'Takes NO ciphertext: the only input is the CID in the path, and the request body schema ' +
        'is an empty strict object. The node fetches the bytes, verifies them against the CID, and ' +
        'unwraps only a recipient entry addressed to its own agent address and key version. ' +
        'Authenticated, tightly rate limited, and audited on every call.',
      auth: true,
      limiter: 'decrypt',
      params: 'MemoryParams',
      query: null,
      body: 'DecryptBody',
      response: 'DecryptResponse',
      statuses: [200, 400, 401, 403, 404, 429, 503],
      success: 200,
    },
    {
      id: 'listJobs',
      method: 'get',
      path: '/api/v1/jobs',
      aliases: ['/api/jobs'],
      tag: 'Jobs',
      summary: 'Recent jobs, for operator debugging.',
      description:
        'Authenticated, because enumerating job ids would defeat the capability that makes ' +
        'GET /jobs/:id safe without a key.',
      auth: true,
      limiter: 'global',
      params: null,
      query: 'JobListQuery',
      body: null,
      response: null,
      statuses: [200, 401, 429],
      success: 200,
    },
    {
      id: 'getJob',
      method: 'get',
      path: '/api/v1/jobs/:id',
      aliases: ['/api/jobs/:id'],
      tag: 'Jobs',
      summary: 'One job status, with per-step timings.',
      description:
        'No API key: the job id is a UUIDv4 capability that only its creator has seen. That trade ' +
        'obliges a client never to log the id to a shared sink or place it in a cross-origin URL.',
      auth: false,
      limiter: 'global',
      params: 'JobParams',
      query: null,
      body: null,
      response: 'Job',
      statuses: [200, 400, 404, 429],
      success: 200,
    },
    {
      id: 'semanticSearch',
      method: 'post',
      path: '/api/v1/semantic/search',
      aliases: ['/api/semantic/search'],
      tag: 'Semantic',
      summary: 'Trust-weighted semantic search.',
      description:
        'Runs one embedding inference, so it has its own rate-limit bucket and sheds load with ' +
        '503 model_not_ready rather than queueing behind a model that is still loading. Every ' +
        'response carries diagnostics.noiseBaseline: any similarity near it is indistinguishable ' +
        'from a comparison between unrelated vectors.',
      auth: false,
      limiter: 'search',
      params: null,
      query: null,
      body: 'SearchBody',
      response: 'SearchResponse',
      statuses: [200, 400, 429, 503],
      success: 200,
    },
    {
      id: 'semanticSimilarity',
      method: 'get',
      path: '/api/v1/semantic/similarity',
      aliases: ['/api/semantic/similarity'],
      tag: 'Semantic',
      summary: 'The cross-model similarity matrix.',
      description:
        'Computed from vectors already in the index; it runs no inference, so a GET can never ' +
        'trigger a model download. Pairs whose projection ids differ are skipped rather than ' +
        'scored, and every cell carries a significance flag against the noise baseline.',
      auth: false,
      limiter: 'global',
      params: null,
      query: 'SimilarityQuery',
      body: null,
      response: 'SimilarityResponse',
      statuses: [200, 400, 429],
      success: 200,
    },
    {
      id: 'semanticIndex',
      method: 'get',
      path: '/api/v1/semantic/index',
      aliases: ['/api/semantic/index'],
      tag: 'Semantic',
      summary: 'Semantic index state, for operators.',
      description: 'Size, projection id, capacity and persistence state.',
      auth: true,
      limiter: 'global',
      params: null,
      query: null,
      body: null,
      response: null,
      statuses: [200, 401, 429],
      success: 200,
    },
    {
      id: 'listReputation',
      method: 'get',
      path: '/api/v1/reputation',
      aliases: ['/api/reputation'],
      tag: 'Reputation',
      summary: 'Scores and the recent trust log.',
      description:
        'Scores are read from the contract and converted from WAD in exactly one place; scoreWad ' +
        'travels alongside the float so a caller needing exactness is not forced through a Number. ' +
        'The trust log is a capacity-bounded ring buffer and the response says so.',
      auth: false,
      limiter: 'global',
      params: null,
      query: 'ReputationQuery',
      body: null,
      response: 'ReputationResponse',
      statuses: [200, 400, 429, 503],
      success: 200,
    },
    {
      id: 'getReputation',
      method: 'get',
      path: '/api/v1/reputation/:address',
      aliases: ['/api/reputation/:address'],
      tag: 'Reputation',
      summary: 'One agent score.',
      description: 'The same envelope as the list, with a single entry.',
      auth: false,
      limiter: 'global',
      params: 'AddressParams',
      query: null,
      body: null,
      response: 'ReputationResponse',
      statuses: [200, 400, 429, 503],
      success: 200,
    },
    {
      id: 'endorseAgent',
      method: 'post',
      path: '/api/v1/reputation/endorse',
      aliases: ['/api/reputation/endorse'],
      tag: 'Reputation',
      summary: 'Endorse an agent. Spends gas.',
      description:
        'Preflighted in the reputation service: self-endorsement, an unregistered target, a ' +
        'duplicate endorsement and an unexpired cooldown are all refused before any gas is spent. ' +
        'Returns 202 with a job.',
      auth: true,
      limiter: 'write',
      params: null,
      query: null,
      body: 'TrustActionBody',
      response: 'Job',
      statuses: [202, 400, 401, 409, 429, 503],
      success: 202,
    },
    {
      id: 'reportAgent',
      method: 'post',
      path: '/api/v1/reputation/report',
      aliases: ['/api/reputation/report'],
      tag: 'Reputation',
      summary: 'Report an agent. Spends gas.',
      description: 'Same guards and preflights as endorse.',
      auth: true,
      limiter: 'write',
      params: null,
      query: null,
      body: 'TrustActionBody',
      response: 'Job',
      statuses: [202, 400, 401, 409, 429, 503],
      success: 202,
    },
    {
      id: 'simulationResults',
      method: 'get',
      path: '/api/v1/simulation-results',
      aliases: ['/api/simulation-results', '/api/v1/simulation'],
      tag: 'Simulation',
      summary: 'Benchmark data from the last local simulation run.',
      description:
        'Answers 200 with available:false when the gitignored simulation-results.json is absent, ' +
        'because that is the default state of a fresh clone rather than a fault. The five chart ' +
        'arrays are always present, empty when there is no file, so no view branches on a missing ' +
        'key. Read asynchronously, mtime-cached, and capped at 8 MB.',
      auth: false,
      limiter: 'global',
      params: null,
      query: null,
      body: null,
      response: 'SimulationResponse',
      statuses: [200, 429, 502],
      success: 200,
    },
    {
      id: 'metricsSummary',
      method: 'get',
      path: '/api/v1/metrics/summary',
      aliases: ['/api/metrics/summary'],
      tag: 'Metrics',
      summary: 'Latency and counter summary for the dashboard.',
      description:
        'Percentiles are exact over the last 200 observations per stage, not interpolated from ' +
        'histogram buckets; the response reports sampleWindow so the scope of the estimate is ' +
        'visible.',
      auth: false,
      limiter: 'global',
      params: null,
      query: 'MetricsQuery',
      body: null,
      response: 'MetricsResponse',
      statuses: [200, 400, 429],
      success: 200,
    },
  ]),
);

/** Every path this node answers, canonical and alias alike. */
export const ALL_PATHS = Object.freeze(
  ROUTE_TABLE.flatMap((route) => [route.path, ...route.aliases]),
);

/**
 * Look one route up by its operation id.
 *
 * @param {string} id Operation id.
 * @returns {RouteEntry|undefined} The row.
 */
export function routeById(id) {
  return ROUTE_TABLE.find((route) => route.id === id);
}

/**
 * Build the versioned API router.
 *
 * Mounted twice by `src/app.js` - once at `/api/v1` and once at `/api` - so the canonical and
 * legacy surfaces are literally the same handlers with the same limiter buckets, and cannot drift.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @param {Record<string, any>} deps.config Application config.
 * @param {Record<string, any>} deps.guards Shared middleware instances.
 * @returns {import('express').Router} The router.
 */
export function createApiRouter({ services, config, guards }) {
  const router = Router({ mergeParams: true });

  router.use('/', createHealthRoutes({ services, config }));

  const agents = createAgentRoutes({ services, config, guards });
  router.use('/agents', agents);
  router.use('/agent', agents);

  router.use('/memories', createMemoryRoutes({ services, config, guards }));
  router.use('/jobs', createJobRoutes({ services, config, guards }));
  router.use('/semantic', createSemanticRoutes({ services, guards }));
  router.use('/reputation', createReputationRoutes({ services, guards }));
  router.use('/metrics', createMetricsSummaryRoutes({ services }));

  const simulation = createSimulationRoutes({ config });
  router.use('/simulation-results', simulation);
  router.use('/simulation', simulation);

  return router;
}

/**
 * Build the root-mounted router: the two ops probes and the Prometheus endpoint.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @param {Record<string, any>} deps.config Application config.
 * @param {Record<string, any>} deps.guards Shared middleware instances.
 * @returns {import('express').Router} The router.
 */
export function createRootRouter({ services, config, guards }) {
  const router = Router();
  router.use('/', createProbeRoutes({ services }));
  router.use('/', createMetricsRoutes({ services, config, guards }));
  return router;
}

export default createApiRouter;
