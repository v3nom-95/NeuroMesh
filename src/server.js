/**
 * Process lifecycle: build the services, bind the port immediately, warm dependencies in the
 * background, and drain cleanly on a signal.
 *
 * ## Bind first, warm second
 *
 * v1 had `const extractor = await pipeline(...)` at module scope, above `const app = express()`.
 * Nothing listened until a ~90 MB model download finished, so on a cold container every liveness
 * probe failed, the orchestrator restarted the pod, and the download began again - a loop that
 * never terminates. Here the order is: construct (no I/O), listen, then warm in the background. A
 * dependency that fails to warm makes `/readyz` report 503 with a reason; it does not stop the
 * process, because a node with a dead RPC endpoint should still serve `/healthz`, the console and
 * every cached read.
 *
 * ## Why an uncaught exception exits
 *
 * `unhandledRejection` and `uncaughtException` log and exit non-zero rather than continuing. After
 * an uncaught throw the chain service's locally tracked nonce may no longer match what was
 * broadcast, and continuing risks reusing a nonce - which either drops a transaction or replaces
 * one that was already paid for. Restarting resynchronises from the chain; continuing does not.
 *
 * @module src/server
 */
import http from 'node:http';

import { createApp } from './app.js';
import { getConfig } from './config/index.js';
import { logger as rootLogger, redactError } from './logger.js';
import { createServices } from './services/index.js';

/** How long to wait after flipping readiness off, so a load balancer can stop routing. */
export const DRAIN_GRACE_MS = 3000;

/** Module-level handle so {@link shutdown} can be exported and tested independently. */
/** @type {{server: import('node:http').Server|null, services: any, config: any, logger: any}} */
const state = { server: null, services: null, config: null, logger: rootLogger };

let shuttingDown = false;

/**
 * Sleep.
 *
 * @param {number} ms Milliseconds.
 * @returns {Promise<void>} Resolves after `ms`.
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Start the node.
 *
 * @param {object} [options] Options.
 * @param {Record<string, any>} [options.config] Config override, for tests.
 * @param {any} [options.logger] Logger override, for tests.
 * @param {boolean} [options.warm] Whether to run background warmup. Off in tests.
 * @param {boolean} [options.handleSignals] Whether to install the process-level signal and
 *   fatal-error handlers. A test must leave this off: an `uncaughtException` listener installed by
 *   the code under test would swallow the test runner's own failures.
 * @returns {Promise<{app: any, server: import('node:http').Server, services: any}>} The handles.
 */
export async function main({
  config = getConfig(),
  logger = rootLogger,
  warm = true,
  handleSignals = true,
} = {}) {
  state.config = config;
  state.logger = logger;

  // Construction only. Nothing here connects, downloads or reads a file, so the port binds in
  // milliseconds regardless of how slow the chain, the pinning service or the model turn out to be.
  const services = await createServices({ config, logger });
  state.services = services;

  const app = createApp({ services, config, logger });
  const server = http.createServer(app);
  state.server = server;

  // Both above a typical 60 s proxy idle timeout, and headers above keep-alive, so the proxy is
  // always the side that closes an idle connection. Reversing them produces sporadic 502s.
  server.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  server.headersTimeout = config.http.headersTimeoutMs;
  // Per-route deadlines are explicit (see `withTimeout` in the async handler), so the server-wide
  // request timeout is off rather than silently cutting a legitimate slow commit in half.
  server.requestTimeout = 0;
  server.maxHeadersCount = 100;

  await new Promise((resolve, reject) => {
    /**
     * @param {NodeJS.ErrnoException} err Listen error.
     * @returns {void}
     */
    const onError = (err) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        logger.fatal?.(
          { port: config.http.port, host: config.http.host },
          `Port ${config.http.port} is already in use on ${config.http.host}. Stop the other ` +
            'process or set PORT to a free port.',
        );
      } else if (err.code === 'EACCES') {
        logger.fatal?.(
          { port: config.http.port },
          `Permission denied binding port ${config.http.port}. Ports below 1024 need elevated ` +
            'privileges; set PORT to something above 1024.',
        );
      } else {
        logger.fatal?.({ err: redactError(err) }, 'The server failed to bind.');
      }
      reject(err);
    };
    /**
     * @returns {void}
     */
    const onListening = () => {
      server.off('error', onError);
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.http.port, config.http.host);
  });

  logger.info?.(
    {
      port: config.http.port,
      host: config.http.host,
      env: config.app.env,
      version: config.app.version,
      commit: config.app.commit,
      readOnly: config.signer.readOnly,
      provider: config.embeddings.provider,
      chainId: config.chain.chainId,
      contracts: config.chain.addressesSource,
    },
    `NeuroMesh node listening on http://${config.http.host}:${config.http.port}`,
  );

  if (warm) {
    // Deliberately not awaited. Warmup is observable through /readyz; blocking on it here would
    // reintroduce the exact defect this ordering exists to fix.
    void services.warmup().catch((err) => {
      logger.error?.({ err: redactError(err) }, 'Warmup failed; the node continues degraded.');
    });
  }

  if (handleSignals) installSignalHandlers();

  return { app, server, services };
}

/**
 * Drain and stop.
 *
 * The order matters and each step buys something specific:
 *
 *   1. flip readiness off, so `/readyz` is 503 immediately while `/healthz` stays 200 - that gap
 *      is what lets a load balancer stop routing before the process stops accepting;
 *   2. wait a short grace period (production only) for that to propagate;
 *   3. stop accepting and close idle connections;
 *   4. shut the services down in reverse dependency order, which is where the chain service waits
 *      for an in-flight transaction and logs any hash still unconfirmed at WARN, so an operator
 *      can resolve it by hand rather than discovering it from a block explorer;
 *   5. force any remaining socket closed at the deadline.
 *
 * @param {string} signal What triggered the shutdown.
 * @param {object} [options] Options.
 * @param {number} [options.timeoutMs] Total budget.
 * @param {(code: number) => void} [options.exit] Exit function; injected in tests.
 * @returns {Promise<number>} The intended exit code.
 */
export async function shutdown(signal, { timeoutMs, exit = process.exit } = {}) {
  const config = state.config ?? getConfig();
  const logger = state.logger ?? rootLogger;
  const budget = timeoutMs ?? config.http.shutdownTimeoutMs;

  if (shuttingDown) {
    // A second signal inside the budget means someone is trying to make it stop now.
    logger.warn?.({ signal }, 'Second shutdown signal; exiting immediately.');
    exit(1);
    return 1;
  }
  shuttingDown = true;
  logger.info?.({ signal, budgetMs: budget }, 'Shutting down.');

  let stage = 'readiness';
  const deadline = new Promise((resolve) => setTimeout(() => resolve('timeout'), budget).unref?.());

  const work = (async () => {
    state.services?.readiness?.setDraining();

    stage = 'drain-grace';
    await delay(config.app.isProduction ? DRAIN_GRACE_MS : 0);

    stage = 'server-close';
    const server = state.server;
    if (server) {
      server.closeIdleConnections?.();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }

    stage = 'services';
    await state.services?.shutdown?.({ timeoutMs: budget });

    stage = 'done';
    return 'done';
  })();

  const outcome = await Promise.race([work, deadline]);
  if (outcome === 'timeout') {
    logger.error?.({ signal, stage, budgetMs: budget }, 'Shutdown exceeded its budget.');
    state.server?.closeAllConnections?.();
    await flush(logger);
    exit(1);
    return 1;
  }

  logger.info?.({ signal }, 'Shutdown complete.');
  await flush(logger);
  exit(0);
  return 0;
}

/**
 * Flush pino's buffers, with a short bound so a stuck transport cannot hold the process open.
 *
 * @param {any} logger The logger.
 * @returns {Promise<void>} Resolves when flushed or after 2 s.
 */
async function flush(logger) {
  await Promise.race([
    new Promise((resolve) => {
      try {
        logger.flush?.(() => resolve(undefined));
      } catch {
        resolve(undefined);
      }
      // pino's flush callback is not guaranteed on every transport.
      setTimeout(resolve, 200).unref?.();
    }),
    delay(2000),
  ]);
}

let handlersInstalled = false;

/**
 * Install the signal and fatal-error handlers, exactly once per process.
 *
 * @returns {void}
 */
export function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  for (const signal of /** @type {const} */ (['SIGTERM', 'SIGINT'])) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    (state.logger ?? rootLogger).fatal?.(
      { err: redactError(reason) },
      'Unhandled promise rejection. Exiting: continuing after one risks an inconsistent nonce.',
    );
    void flush(state.logger ?? rootLogger).then(() => process.exit(1));
  });

  process.on('uncaughtException', (err) => {
    (state.logger ?? rootLogger).fatal?.(
      { err: redactError(err) },
      'Uncaught exception. Exiting: the transaction queue may hold a nonce that was already used.',
    );
    void flush(state.logger ?? rootLogger).then(() => process.exit(1));
  });
}

/**
 * Reset the module state. Test-only.
 *
 * @returns {void}
 */
export function resetLifecycle() {
  shuttingDown = false;
  state.server = null;
  state.services = null;
  state.config = null;
}

/**
 * Start when this module is the entry point, either directly or through the root `server.js` shim.
 *
 * The guard is on an explicit flag rather than `import.meta.url === process.argv[1]`, because the
 * real entry point is the one-line root shim and that comparison would never match.
 */
if (process.env.NEUROMESH_NO_AUTOSTART !== '1') {
  const invokedAsEntrypoint = !process.env.NODE_TEST_CONTEXT;
  if (invokedAsEntrypoint) {
    main().catch((err) => {
      rootLogger.fatal?.({ err: redactError(err) }, 'The node failed to start.');
      process.exitCode = 1;
    });
  }
}

export default main;
