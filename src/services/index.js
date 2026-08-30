/**
 * The dependency container: constructs every service, owns the readiness registry, and owns
 * warmup and shutdown.
 *
 * ## Why a container rather than module singletons
 *
 * `createApp()` takes this object and never reaches for a global. That is what lets the whole
 * route suite run against fakes with no network, no `.env`, no private key and no model download -
 * the constraint `npm run test:unit` imposes, since it runs `node --test test/backend` with no
 * environment preset at all.
 *
 * ## Construction performs no I/O
 *
 * Every service's constructor builds objects and returns. Nothing connects, loads or reads. That
 * is the fix for the v1 defect where `const extractor = await pipeline(...)` sat at module scope
 * above `const app = express()`: nothing listened until a ~90 MB download finished, so every
 * liveness probe failed and an orchestrator restarted the pod into a download loop that never
 * terminated. Here the port binds first and {@link Services.warmup} runs afterwards, in the
 * background, and a failure in it degrades `/readyz` rather than killing the process.
 *
 * @module src/services/index
 */
import { getConfig } from '../config/index.js';
import { logger as defaultLogger } from '../logger.js';
import { constants, projection } from '../protocol/index.js';

import { createChainService } from './chain.js';
import { createCryptoService } from './crypto.js';
import { createEmbeddingService } from './embeddings.js';
import { createIpfsService } from './ipfs.js';
import { createJobRegistry, createMemoryService } from './memory.js';
import { createMetrics } from './metrics.js';
import { createReputationService } from './reputation.js';
import { createSemanticService } from './semantic.js';

/** How long a readiness check's verdict is reused before it is recomputed. */
export const READINESS_CACHE_MS = 2000;

/** Per-check timeout. A hanging dependency reports `degraded`; it never hangs the probe. */
export const READINESS_TIMEOUT_MS = 2000;

/* ========================================================================== */
/* Readiness registry                                                         */
/* ========================================================================== */

/**
 * Build the readiness registry.
 *
 * Each check is individually timed, individually wrapped and individually cached. Two properties
 * follow, and both matter operationally:
 *
 *   - a probe storm cannot become an RPC storm, because a verdict is reused for
 *     {@link READINESS_CACHE_MS};
 *   - one hanging dependency cannot hang the probe, because each check races its own timeout and
 *     reports `degraded` when it loses.
 *
 * `ready` is true only when every **critical** check is `up` and the process is not draining. A
 * `disabled` check - IPFS on a node with no Pinata credential, say - is a configuration, not an
 * outage, so it never blocks readiness.
 *
 * @param {object} [deps] Dependencies.
 * @param {() => number} [deps.now] Clock, in epoch milliseconds.
 * @returns {ReadinessRegistry} The registry.
 */
export function createReadiness({ now = Date.now } = {}) {
  /** @type {Map<string, {critical: boolean, check: () => any, cache: {at: number, value: any}|null}>} */
  const checks = new Map();
  let draining = false;

  /**
   * @param {string} name Check name.
   * @param {{critical?: boolean, check: () => any}} spec The check.
   * @returns {void}
   */
  function register(name, { critical = true, check }) {
    checks.set(name, { critical, check, cache: null });
  }

  /**
   * @param {string} name Check name.
   * @param {{critical: boolean, check: () => any, cache: any}} entry Registered check.
   * @returns {Promise<Record<string, any>>} One normalized verdict.
   */
  async function run(name, entry) {
    if (entry.cache && now() - entry.cache.at < READINESS_CACHE_MS) return entry.cache.value;
    const started = now();
    /** @type {Record<string, any>} */
    let value;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => entry.check()),
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ status: 'degraded', detail: 'The check did not answer in time.' }),
            READINESS_TIMEOUT_MS,
          ),
        ),
      ]);
      value = {
        name,
        status: /** @type {any} */ (result)?.status ?? 'down',
        critical: entry.critical,
        detail: /** @type {any} */ (result)?.detail ?? null,
        latencyMs: now() - started,
        checkedAt: new Date(now()).toISOString(),
      };
    } catch (err) {
      value = {
        name,
        status: 'down',
        critical: entry.critical,
        detail: String(/** @type {any} */ (err)?.message ?? err),
        latencyMs: now() - started,
        checkedAt: new Date(now()).toISOString(),
      };
    }
    entry.cache = { at: now(), value };
    return value;
  }

  return {
    register,
    /** @returns {void} Flip readiness off so a load balancer stops routing before we stop accepting. */
    setDraining() {
      draining = true;
      for (const entry of checks.values()) entry.cache = null;
    },
    /** @returns {boolean} Whether the process is draining. */
    isDraining: () => draining,
    /** @returns {string[]} Registered check names, in registration order. */
    names: () => [...checks.keys()],
    /**
     * @returns {Promise<{ready: boolean, draining: boolean, checks: Array<Record<string, any>>}>}
     *   The snapshot served by `/readyz` at both 200 and 503.
     */
    async snapshot() {
      const results = await Promise.all(
        [...checks.entries()].map(([name, entry]) => run(name, entry)),
      );
      const ready = !draining && results.every((row) => !row.critical || row.status === 'up');
      return { ready, draining, checks: results };
    },
  };
}

/* ========================================================================== */
/* Container                                                                  */
/* ========================================================================== */

/**
 * Construct every service and wire them together.
 *
 * Construction order is dependency order: metrics, readiness, jobs, embeddings, chain, crypto,
 * ipfs, semantic, reputation, memory. Nothing here performs I/O, so this function returns in
 * microseconds and the caller can bind the port immediately.
 *
 * @param {object} [deps] Dependencies.
 * @param {ReturnType<typeof getConfig>} [deps.config] Application config.
 * @param {any} [deps.logger] Pino logger.
 * @param {Record<string, any>} [deps.overrides] Pre-built services to use instead of constructing
 *   them. This is the seam the route tests inject fakes through.
 * @returns {Promise<Services>} The frozen container.
 */
export async function createServices({
  config = getConfig(),
  logger = defaultLogger,
  overrides = {},
} = {}) {
  const metrics = overrides.metrics ?? createMetrics({ config });
  const readiness = overrides.readiness ?? createReadiness();

  const jobs = overrides.jobs ?? createJobRegistry({ config, logger });
  const embeddings = overrides.embeddings ?? createEmbeddingService({ config, logger, metrics });
  const chain = overrides.chain ?? createChainService({ config, logger, metrics });
  const crypto = overrides.crypto ?? createCryptoService({ config, logger, chain });
  const ipfs = overrides.ipfs ?? createIpfsService({ config, logger, metrics });
  const reputation = overrides.reputation ?? createReputationService({ config, logger, chain });
  const semantic =
    overrides.semantic ??
    createSemanticService({ config, logger, metrics, embeddings, chain, reputation });
  const memory =
    overrides.memory ??
    createMemoryService({
      config,
      logger,
      metrics,
      embeddings,
      crypto,
      ipfs,
      chain,
      semantic,
      jobs,
    });

  /* ---- Readiness checks ------------------------------------------------- */

  readiness.register('config', {
    critical: true,
    check: () => ({ status: 'up', detail: `Environment: ${config.app.env}.` }),
  });

  readiness.register('model', {
    critical: true,
    check: () => {
      const state = embeddings.state();
      if (state.status === 'ready') {
        return { status: 'up', detail: `${state.provider}/${state.model} (${state.dim}-d).` };
      }
      if (state.status === 'loading')
        return { status: 'down', detail: 'The model is still loading.' };
      if (state.status === 'failed') {
        return { status: 'down', detail: state.error?.message ?? 'The model failed to load.' };
      }
      return { status: 'down', detail: 'The model has not been loaded yet.' };
    },
  });

  // The chain is NOT critical. A node with a dead RPC endpoint must still serve /healthz, the
  // dashboard and every cached read - that is the whole point of the degraded state, and making
  // this critical would take the console down whenever Sepolia hiccups.
  readiness.register('chain', {
    critical: false,
    check: async () => {
      const verdict = await chain.health();
      return { status: verdict.status, detail: verdict.detail };
    },
  });

  readiness.register('contracts', {
    critical: false,
    check: () => {
      if (!config.chain.enabled) return { status: 'disabled', detail: 'No RPC endpoint.' };
      const state = chain.state();
      if (state.contractsCompatible) return { status: 'up', detail: null };
      return {
        status: 'degraded',
        detail:
          state.error?.message ??
          'The deployed contracts cannot be proven to match this build; writes are refused and ' +
            'reads continue.',
      };
    },
  });

  readiness.register('signer', {
    critical: false,
    check: () => {
      if (config.signer.readOnly) {
        return { status: 'disabled', detail: 'This node is read-only; it never spends gas.' };
      }
      return { status: 'up', detail: chain.address() };
    },
  });

  readiness.register('ipfs', {
    critical: false,
    check: async () => {
      if (!config.ipfs.enabled) return { status: 'disabled', detail: 'No pinning credential.' };
      const probe = await ipfs.probe();
      // `down` is reported as `degraded`: the node still serves every read, and a pinning outage
      // must not make an otherwise healthy node fail its readiness probe and get restarted.
      return probe.status === 'up'
        ? { status: 'up', detail: null }
        : { status: 'degraded', detail: probe.detail ?? 'The pinning service did not answer.' };
    },
  });

  readiness.register('semantic', {
    critical: false,
    check: () => {
      const stats = semantic.stats();
      return {
        status: stats.status === 'ready' ? 'up' : 'degraded',
        detail: `${stats.size} entries, projection ${stats.projectionId}.`,
      };
    },
  });

  /* ---- Lifecycle -------------------------------------------------------- */

  /**
   * Warm every dependency concurrently.
   *
   * Never rejects, and never leaves the process in a state where a single failed dependency has
   * taken the whole node down. Each outcome is logged with its duration; the verdict a client sees
   * is the readiness snapshot, not this function's return value.
   *
   * @returns {Promise<Array<{name: string, ok: boolean, ms: number, reason: string|null}>>}
   *   One row per dependency.
   */
  async function warmup() {
    /** @type {Array<[string, () => Promise<unknown>]>} */
    const tasks = [
      ['crypto', () => crypto.init()],
      ['chain', () => chain.init()],
      ['semantic', () => semantic.init()],
    ];
    if (config.embeddings.preload) tasks.push(['model', () => embeddings.init()]);
    if (config.ipfs.enabled) tasks.push(['ipfs', () => ipfs.probe()]);

    const started = Date.now();
    const settled = await Promise.allSettled(
      tasks.map(async ([name, run]) => {
        const at = Date.now();
        try {
          await run();
          return { name, ok: true, ms: Date.now() - at, reason: null };
        } catch (err) {
          return {
            name,
            ok: false,
            ms: Date.now() - at,
            reason: String(/** @type {any} */ (err)?.message ?? err),
          };
        }
      }),
    );
    const rows = settled.map((row) =>
      row.status === 'fulfilled'
        ? row.value
        : { name: 'unknown', ok: false, ms: 0, reason: String(row.reason?.message ?? row.reason) },
    );
    for (const row of rows) {
      if (row.ok) logger.info?.({ dependency: row.name, ms: row.ms }, 'Dependency ready.');
      else
        logger.warn?.(
          { dependency: row.name, ms: row.ms, reason: row.reason },
          'Dependency degraded.',
        );
    }
    logger.info?.({ ms: Date.now() - started, dependencies: rows.length }, 'Warmup finished.');
    return rows;
  }

  /**
   * Shut down in reverse dependency order, with a budget.
   *
   * @param {{timeoutMs?: number}} [options] Options.
   * @returns {Promise<void>} Resolves when everything is quiet or the budget expired.
   */
  async function shutdown({ timeoutMs = config.http.shutdownTimeoutMs } = {}) {
    /** @type {Array<[string, () => Promise<unknown>]>} */
    const order = [
      ['memory', () => memory.shutdown()],
      ['semantic', () => semantic.shutdown()],
      ['chain', () => chain.shutdown()],
      ['ipfs', () => ipfs.shutdown()],
      ['embeddings', () => embeddings.shutdown()],
      ['crypto', () => crypto.shutdown()],
    ];
    for (const [name, run] of order) {
      try {
        await Promise.race([
          Promise.resolve().then(run),
          new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      } catch (err) {
        logger.warn?.(
          { dependency: name, reason: String(/** @type {any} */ (err)?.message ?? err) },
          'A service failed to shut down cleanly.',
        );
      }
    }
  }

  /**
   * The liveness answer. It reads no dependency, touches no socket and opens no file: it says
   * whether this process is alive, which is the only question a liveness probe asks.
   *
   * @returns {{status: 'ok'|'degraded', uptimeSec: number, version: string, commit: string,
   *   node: string, draining: boolean}} The `/healthz` body.
   */
  function health() {
    return {
      status: readiness.isDraining()
        ? /** @type {const} */ ('degraded')
        : /** @type {const} */ ('ok'),
      uptimeSec: Math.round(process.uptime() * 1000) / 1000,
      version: config.app.version,
      commit: config.app.commit,
      node: config.app.nodeVersion,
      draining: readiness.isDraining(),
    };
  }

  /** @type {Services} */
  const container = /** @type {any} */ (
    Object.freeze({
      config,
      logger,
      metrics,
      readiness,
      jobs,
      embeddings,
      crypto,
      ipfs,
      chain,
      semantic,
      reputation,
      memory,
      protocol: Object.freeze({
        version: constants.PROTOCOL_VERSION,
        specHash: constants.SPEC_HASH,
        sharedDim: constants.SHARED_EMBEDDING_DIM,
        projectionId: projection.projectionId(
          constants.SHARED_EMBEDDING_DIM,
          constants.SHARED_EMBEDDING_DIM,
        ),
      }),
      warmup,
      shutdown,
      health,
      ready: () => readiness.snapshot(),
    })
  );
  return container;
}

/**
 * @typedef {object} ReadinessRegistry
 * @property {(name: string, spec: {critical?: boolean, check: () => any}) => void} register
 * @property {() => void} setDraining Flip readiness off.
 * @property {() => boolean} isDraining Whether the process is draining.
 * @property {() => string[]} names Registered check names.
 * @property {() => Promise<{ready: boolean, draining: boolean,
 *   checks: Array<Record<string, any>>}>} snapshot The readiness document.
 */

/**
 * @typedef {object} Services
 * @property {Record<string, any>} config Application config.
 * @property {any} logger Root logger.
 * @property {ReturnType<typeof createMetrics>} metrics Metrics registry.
 * @property {ReadinessRegistry} readiness Readiness registry.
 * @property {any} jobs Job registry.
 * @property {any} embeddings Embedding service.
 * @property {any} crypto Envelope crypto service.
 * @property {any} ipfs Pinning and gateway service.
 * @property {any} chain Chain service.
 * @property {any} semantic Semantic index and search.
 * @property {any} reputation Reputation reads and trust writes.
 * @property {any} memory Memory lifecycle.
 * @property {{version: string, specHash: string, sharedDim: number, projectionId: string}} protocol
 * @property {() => Promise<Array<Record<string, any>>>} warmup Background dependency warmup.
 * @property {(options?: {timeoutMs?: number}) => Promise<void>} shutdown Reverse-order shutdown.
 * @property {() => Record<string, any>} health The liveness body.
 * @property {() => Promise<Record<string, any>>} ready The readiness snapshot.
 */

export default createServices;
