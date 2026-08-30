/**
 * The prom-client registry and every custom instrument the rest of the process records into.
 *
 * ## Shape contract with the services
 *
 * `src/services/instrument.js` defines the tiny collector interface the services already call -
 * `increment(name, labels, value)`, `observe(name, value, labels)`, `timer(name, labels)`,
 * `gauge(name, value, labels)`. This module implements exactly that interface on top of prom-client,
 * so no service needs to know whether metrics are enabled, and a metric this module does not
 * declare is silently ignored rather than throwing inside a request.
 *
 * ## The label-cardinality rule
 *
 * `route` is always the Express route **pattern** (`/memories/:cid`), never `req.originalUrl`.
 * Recording the raw URL would mint one time series per CID; at ten thousand memories the registry
 * becomes hundreds of megabytes and the scrape times out. `observeHttp` resolves the pattern from
 * the matched layer and falls back to a single `unmatched` bucket - a bounded fallback, not the
 * raw path.
 *
 * ## Bucket choice
 *
 * The histogram buckets are taken from this repository's own measurements (`bench.json`), not from
 * prom-client's defaults:
 *
 *   - embedding: MiniLM p50 2.85 ms, p95 12.5 ms - the default buckets start at 5 ms, which would
 *     put the median in the first bucket and make the p50 unrecoverable.
 *   - crypto: envelope seal p50 0.027 ms. Every default bucket would contain 100% of samples.
 *   - chain: measured Sepolia confirmation up to 21 s.
 *
 * @module src/services/metrics
 */
import client from 'prom-client';

import { getConfig } from '../config/index.js';

import { LatencyRing } from './instrument.js';

/** How many recent samples per stage the summary percentiles are computed over. */
export const SAMPLE_WINDOW = 200;

/**
 * Latency histogram buckets, in seconds, per instrument family.
 *
 * @type {Readonly<Record<string, number[]>>}
 */
export const BUCKETS = Object.freeze({
  http: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  embedding: [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5],
  crypto: [0.00005, 0.0001, 0.0005, 0.001, 0.005],
  ipfs: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  chain: [1, 2, 5, 10, 15, 21, 30, 60, 120],
  search: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
});

/**
 * The named stages `summary()` reports, mapped to the histogram that feeds them.
 *
 * @type {Readonly<Record<string, string>>}
 */
const SUMMARY_STAGES = Object.freeze({
  embedding: 'neuromesh_embedding_duration_seconds',
  encryption: 'neuromesh_crypto_seal_duration_seconds',
  ipfs: 'neuromesh_ipfs_request_duration_seconds',
  chain: 'neuromesh_tx_duration_seconds',
  search: 'neuromesh_semantic_search_duration_seconds',
  align: 'neuromesh_semantic_align_duration_seconds',
  total: 'neuromesh_memory_pipeline_duration_seconds',
});

/**
 * Create the metrics service.
 *
 * @param {object} [deps] Dependencies.
 * @param {ReturnType<typeof getConfig>} [deps.config] Application config.
 * @returns {MetricsService} The service.
 */
export function createMetrics({ config = getConfig() } = {}) {
  const enabled = Boolean(config.features?.metrics);
  const registry = new client.Registry();

  registry.setDefaultLabels({
    service: config.app.name,
    version: config.app.version,
    env: config.app.env,
    chain_id: String(config.chain.chainId),
  });

  /** @type {Map<string, any>} */
  const instruments = new Map();
  /** @type {Map<string, LatencyRing>} */
  const rings = new Map();

  if (enabled) {
    client.collectDefaultMetrics({ register: registry, prefix: 'neuromesh_' });

    /**
     * @param {string} name Metric name.
     * @param {string} help Help text.
     * @param {string[]} labelNames Label names.
     * @param {number[]} buckets Bucket boundaries in seconds.
     * @returns {void}
     */
    const histogram = (name, help, labelNames, buckets) => {
      instruments.set(
        name,
        new client.Histogram({ name, help, labelNames, buckets, registers: [registry] }),
      );
      rings.set(name, new LatencyRing(SAMPLE_WINDOW));
    };
    /**
     * @param {string} name Metric name.
     * @param {string} help Help text.
     * @param {string[]} [labelNames] Label names.
     * @returns {void}
     */
    const counter = (name, help, labelNames = []) => {
      instruments.set(name, new client.Counter({ name, help, labelNames, registers: [registry] }));
    };
    /**
     * @param {string} name Metric name.
     * @param {string} help Help text.
     * @param {string[]} [labelNames] Label names.
     * @returns {void}
     */
    const gauge = (name, help, labelNames = []) => {
      instruments.set(name, new client.Gauge({ name, help, labelNames, registers: [registry] }));
    };

    histogram(
      'neuromesh_http_request_duration_seconds',
      'HTTP request duration, labelled by route PATTERN (never the raw URL).',
      ['method', 'route', 'status'],
      BUCKETS.http,
    );
    counter('neuromesh_http_requests_total', 'HTTP requests served.', [
      'method',
      'route',
      'status',
    ]);
    counter('neuromesh_http_errors_total', 'HTTP responses that carried an error envelope.', [
      'code',
      'status',
      'route',
    ]);

    histogram(
      'neuromesh_embedding_duration_seconds',
      'Embedding inference duration.',
      ['model', 'provider'],
      BUCKETS.embedding,
    );
    gauge('neuromesh_embedding_queue_depth', 'Calls waiting for the inference session.');
    counter('neuromesh_embedding_errors_total', 'Failed embedding calls.', ['reason']);

    histogram(
      'neuromesh_crypto_seal_duration_seconds',
      'Envelope seal duration (random CEK, AES-256-GCM, ECIES key wrap).',
      [],
      BUCKETS.crypto,
    );
    histogram(
      'neuromesh_crypto_open_duration_seconds',
      'Envelope open duration.',
      [],
      BUCKETS.crypto,
    );
    counter('neuromesh_decrypt_total', 'Per-CID unwrap attempts.', ['result']);
    counter('neuromesh_memory_decrypts_total', 'Successful per-CID unwraps.');

    histogram(
      'neuromesh_ipfs_request_duration_seconds',
      'Outbound IPFS request duration.',
      ['op'],
      BUCKETS.ipfs,
    );
    counter('neuromesh_ipfs_requests_total', 'Outbound IPFS requests.', ['op', 'result']);
    counter('neuromesh_ipfs_bytes_total', 'Bytes pinned or fetched.', ['direction']);

    histogram(
      'neuromesh_rpc_duration_seconds',
      'JSON-RPC call duration.',
      ['method'],
      BUCKETS.http,
    );
    counter('neuromesh_rpc_failover_total', 'Failovers to a secondary RPC endpoint.');
    counter('neuromesh_tx_total', 'Transactions submitted.', ['label', 'result']);
    histogram(
      'neuromesh_tx_duration_seconds',
      'Transaction submission to confirmation.',
      ['label'],
      BUCKETS.chain,
    );
    gauge('neuromesh_tx_queue_depth', 'Queued plus in-flight transactions.');
    counter('neuromesh_tx_gas_used_total', 'Gas consumed by confirmed transactions.', ['label']);

    histogram(
      'neuromesh_semantic_search_duration_seconds',
      'Trust-weighted search duration.',
      [],
      BUCKETS.search,
    );
    histogram(
      'neuromesh_semantic_align_duration_seconds',
      'Deterministic alignment duration.',
      [],
      BUCKETS.search,
    );
    gauge('neuromesh_semantic_index_size', 'Entries held in the semantic index.');

    histogram(
      'neuromesh_memory_pipeline_duration_seconds',
      'End-to-end commit pipeline duration.',
      ['result'],
      BUCKETS.chain,
    );
    counter('neuromesh_memories_committed_total', 'Memories committed to the ledger.');
    gauge('neuromesh_jobs_active', 'Jobs currently running.');
  }

  /**
   * @param {string} name Metric name.
   * @returns {any} The instrument, or `undefined` when it is not declared.
   */
  function instrument(name) {
    return instruments.get(name);
  }

  /**
   * Increment a counter. Unknown names are ignored - a metric must never fail a request.
   *
   * @param {string} name Metric name.
   * @param {Record<string, string|number>} [labels] Label values.
   * @param {number} [value] Increment.
   * @returns {void}
   */
  function increment(name, labels = {}, value = 1) {
    const metric = instrument(name);
    if (!metric?.inc) return;
    try {
      metric.inc(labels, value);
    } catch {
      /* a bad label set must not break the caller */
    }
  }

  /**
   * Observe a histogram sample, and keep it in the ring the summary percentiles are drawn from.
   *
   * @param {string} name Metric name.
   * @param {number} value Value, in seconds.
   * @param {Record<string, string|number>} [labels] Label values.
   * @returns {void}
   */
  function observe(name, value, labels = {}) {
    if (!Number.isFinite(value)) return;
    rings.get(name)?.observe(value * 1000);
    const metric = instrument(name);
    if (!metric?.observe) return;
    try {
      metric.observe(labels, value);
    } catch {
      /* as above */
    }
  }

  /**
   * Start a timer. The returned function records the elapsed seconds when called.
   *
   * @param {string} name Metric name.
   * @param {Record<string, string|number>} [labels] Label values.
   * @returns {(extra?: Record<string, string|number>) => number} Stop function, returning the
   *   elapsed milliseconds - the same contract as `instrument.js`, so the two are interchangeable.
   */
  function timer(name, labels = {}) {
    const started = process.hrtime.bigint();
    return (extra = {}) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      observe(name, ms / 1000, { ...labels, ...extra });
      return ms;
    };
  }

  /**
   * Set a gauge.
   *
   * @param {string} name Metric name.
   * @param {number} value Value.
   * @param {Record<string, string|number>} [labels] Label values.
   * @returns {void}
   */
  function gauge(name, value, labels = {}) {
    const metric = instrument(name);
    if (!metric?.set) return;
    try {
      metric.set(labels, value);
    } catch {
      /* as above */
    }
  }

  /**
   * Resolve the route PATTERN for a request.
   *
   * This is the cardinality guard. `req.route.path` is the pattern the matched handler was
   * registered with; combined with `req.baseUrl` it reconstructs `/api/v1/memories/:cid`. When
   * nothing matched - a 404 - the label is the constant `unmatched`, because the alternative is one
   * time series per URL an unknown scanner probes.
   *
   * @param {any} req Express request.
   * @returns {string} A bounded route label.
   */
  function routeLabel(req) {
    const base = typeof req?.baseUrl === 'string' ? req.baseUrl : '';
    const pattern = req?.route?.path;
    if (typeof pattern === 'string' && pattern.length > 0) {
      const joined = `${base}${pattern === '/' ? '' : pattern}`;
      return joined === '' ? '/' : joined;
    }
    if (base !== '') return `${base}/*`;
    return 'unmatched';
  }

  /**
   * Record one finished HTTP exchange.
   *
   * @param {any} req Express request.
   * @param {any} res Express response.
   * @param {number} ms Duration in milliseconds.
   * @returns {void}
   */
  function observeHttp(req, res, ms) {
    const labels = {
      method: String(req?.method ?? 'GET'),
      route: routeLabel(req),
      status: String(res?.statusCode ?? 0),
    };
    observe('neuromesh_http_request_duration_seconds', ms / 1000, labels);
    increment('neuromesh_http_requests_total', labels);
  }

  /**
   * Record an error response.
   *
   * @param {{code: string, status: number}} apiErr The normalized error.
   * @param {any} req Express request.
   * @returns {void}
   */
  function observeError(apiErr, req) {
    increment('neuromesh_http_errors_total', {
      code: String(apiErr?.code ?? 'unknown'),
      status: String(apiErr?.status ?? 500),
      route: routeLabel(req),
    });
  }

  /**
   * The dashboard's latency summary.
   *
   * Percentiles come from the in-memory ring of the last {@link SAMPLE_WINDOW} observations per
   * stage, not from histogram-bucket interpolation. That is stated in the response as
   * `sampleWindow` rather than implied: a p99 over 200 samples is an estimate, and presenting it
   * as though it were computed over the full history would be a claim the data does not support.
   *
   * @param {string} [window] Requested window label, echoed back.
   * @returns {Promise<Record<string, any>>} The summary.
   */
  async function summary(window = '1h') {
    /** @type {Record<string, any>} */
    const latency = {};
    for (const [stage, metric] of Object.entries(SUMMARY_STAGES)) {
      const ring = rings.get(metric);
      latency[stage] = ring ? ring.stats() : emptyStats();
    }

    /** @type {Record<string, number>} */
    const counters = {};
    /** @type {Record<string, number>} */
    const gauges = {};
    if (enabled) {
      for (const name of [
        'neuromesh_http_requests_total',
        'neuromesh_http_errors_total',
        'neuromesh_memories_committed_total',
        'neuromesh_tx_total',
        'neuromesh_decrypt_total',
      ]) {
        counters[name] = await total(instrument(name));
      }
      for (const name of [
        'neuromesh_tx_queue_depth',
        'neuromesh_embedding_queue_depth',
        'neuromesh_semantic_index_size',
        'neuromesh_jobs_active',
      ]) {
        gauges[name] = await total(instrument(name));
      }
    }

    return {
      window,
      sampleWindow: SAMPLE_WINDOW,
      unit: 'milliseconds',
      enabled,
      latency,
      counters,
      gauges,
    };
  }

  return Object.freeze({
    enabled,
    registry,
    increment,
    observe,
    timer,
    gauge,
    instrument,
    routeLabel,
    observeHttp,
    observeError,
    summary,
    /**
     * @returns {Promise<string>} The Prometheus exposition text.
     */
    scrape: () => registry.metrics(),
    /** @returns {string} The exposition content type. */
    contentType: () => registry.contentType,
    /** @returns {void} Drop every recorded sample. Test-only. */
    reset() {
      registry.resetMetrics();
      for (const ring of rings.values()) ring.reset();
    },
  });
}

/**
 * Sum every child of a counter or gauge.
 *
 * @param {any} metric A prom-client counter or gauge, or `undefined`.
 * @returns {Promise<number>} The summed value, or 0.
 */
async function total(metric) {
  if (!metric?.get) return 0;
  try {
    const snapshot = await metric.get();
    return snapshot.values.reduce(
      (/** @type {number} */ sum, /** @type {any} */ row) => sum + Number(row.value ?? 0),
      0,
    );
  } catch {
    return 0;
  }
}

/**
 * @returns {Record<string, number|null>} A zero-sample statistics block.
 */
function emptyStats() {
  return {
    count: 0,
    retained: 0,
    mean: null,
    p50: null,
    p95: null,
    p99: null,
    min: null,
    max: null,
  };
}

/**
 * @typedef {ReturnType<typeof createMetrics>} MetricsService
 */

export default createMetrics;
