/**
 * Liveness, readiness and the composite status document.
 *
 * ## The three are different questions, and conflating them is an outage
 *
 *   - `/healthz` asks **is this process alive**. It touches no dependency: no chain, no IPFS, no
 *     model, no filesystem. It is what the Dockerfile HEALTHCHECK and a Kubernetes liveness probe
 *     hit, and a liveness probe that fails because a third-party RPC endpoint is slow will restart
 *     a perfectly healthy pod - repeatedly, until the RPC recovers.
 *   - `/readyz` asks **should traffic be routed here**. It is 503 until every critical dependency
 *     is up, and 503 again the instant a drain begins, which is what gives a load balancer time to
 *     stop routing before the process stops accepting.
 *   - `/api/v1/status` asks **what is this node**. It is the dashboard's document, is assembled
 *     with `Promise.allSettled` so one slow dependency degrades one field rather than failing the
 *     request, and it never invents a value: a field that cannot be determined is `null`, with the
 *     reason in the readiness snapshot. The v1 server answered `agentAddress: 'Loading...'`
 *     forever, which is a string masquerading as data.
 *
 * @module src/routes/health
 */
import { Router } from 'express';

import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { PROTOCOL_INFO } from '../schemas/api.js';

/** How long the composite status document is reused. */
export const STATUS_CACHE_MS = 2000;

/** Chain ids this node can name. An unknown id reports its number, never a guessed name. */
const NETWORK_NAMES = Object.freeze({
  1: 'mainnet',
  11155111: 'sepolia',
  17000: 'holesky',
  31337: 'hardhat',
  1337: 'localhost',
});

/**
 * The two ops probes, mounted at the process root by `src/app.js`.
 *
 * They live outside `/api/v1` because that is where an orchestrator and the Dockerfile's
 * HEALTHCHECK expect to find them, and because a probe must not be versioned with the API: a v2
 * that renamed them would silently break every deployment's liveness check.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @returns {import('express').Router} The router.
 */
export function createProbeRoutes({ services }) {
  const router = Router();

  router.get(
    '/healthz',
    asyncHandler(async (_req, res) => {
      // Always 200 while the process is up, including while draining - a draining process is
      // alive, it just must not receive new traffic, and that is /readyz's job to say.
      res.set('Cache-Control', 'no-store').status(200).json(services.health());
    }),
  );

  router.get(
    '/readyz',
    asyncHandler(async (_req, res) => {
      const snapshot = await services.readiness.snapshot();
      // Identical body at 200 and 503 on purpose: an orchestrator's probe and the dashboard read
      // the same document, so an operator debugging a failing probe sees exactly what the
      // orchestrator saw.
      res.set('Cache-Control', 'no-store');
      res.status(snapshot.ready ? 200 : 503).json(snapshot);
    }),
  );

  return router;
}

/**
 * Build the versioned status routes, plus `/health` and `/ready` aliases of the two probes.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @param {Record<string, any>} deps.config Application config.
 * @returns {import('express').Router} The router.
 */
export function createHealthRoutes({ services, config }) {
  const router = Router();

  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').status(200).json(services.health());
    }),
  );

  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const snapshot = await services.readiness.snapshot();
      res.set('Cache-Control', 'no-store');
      res.status(snapshot.ready ? 200 : 503).json(snapshot);
    }),
  );

  /* ---- Status ----------------------------------------------------------- */

  /** @type {{at: number, value: Record<string, any>}|null} */
  let statusCache = null;

  /**
   * Assemble the status document.
   *
   * Every dependency read is settled, never awaited in a chain: a chain read that times out must
   * cost the `chain.blockNumber` field, not the whole response.
   *
   * @returns {Promise<Record<string, any>>} The document.
   */
  async function buildStatus() {
    const cryptoState = services.crypto.state();
    const address = cryptoState.address ?? services.chain.address();
    const embeddingState = services.embeddings.state();

    const [chainHealth, identity, reputation, ipfsProbe] = await Promise.allSettled([
      services.chain.health(),
      address ? services.chain.readIdentity.getAgent(address) : Promise.resolve(null),
      address ? services.reputation.summaryOf(address) : Promise.resolve(null),
      services.ipfs.probe(),
    ]);

    const chain = chainHealth.status === 'fulfilled' ? chainHealth.value : null;
    const agent = identity.status === 'fulfilled' ? identity.value : null;
    const score = reputation.status === 'fulfilled' ? reputation.value : null;
    const ipfs = ipfsProbe.status === 'fulfilled' ? ipfsProbe.value : null;

    const chainId = chain?.chainId ?? config.chain.chainId ?? null;
    const modelInfo = (() => {
      try {
        return services.embeddings.modelInfo(embeddingState.model);
      } catch {
        return null;
      }
    })();

    return {
      node: {
        name: config.app.name,
        version: config.app.version,
        commit: config.app.commit,
        env: config.app.env,
        uptimeSec: Math.round(process.uptime() * 1000) / 1000,
        startedAt: config.app.startedAt,
      },
      agent: {
        address: address ?? null,
        did: cryptoState.did ?? null,
        // `null`, not `false`: "we could not ask the chain" and "the chain says no" are different
        // facts, and collapsing them is what hides a broken RPC behind a plausible answer.
        registered: agent ? Boolean(agent.exists) : null,
        active: agent ? Boolean(agent.active) : null,
        keyVersion: cryptoState.keyVersion ?? null,
        encryptionPublicKey: cryptoState.encryptionPublicKey ?? null,
        reputation: score,
      },
      chain: {
        configured: Boolean(config.chain.enabled),
        network:
          /** @type {Record<number, string>} */ (NETWORK_NAMES)[Number(chainId)] ??
          (chainId === null ? null : `chain-${chainId}`),
        chainId: chainId === null ? null : Number(chainId),
        blockNumber: chain?.blockNumber ?? null,
        reachable: chain?.reachable ?? false,
        // The decisive compatibility signal. `contract-addresses.json` still points at a v1
        // deployment whose ABI does not match this build, so this is routinely false on a
        // developer machine - and the node still serves every read.
        contractsCompatible: Boolean(chain?.contractsCompatible),
        explorerBase: config.chain.explorerBaseUrl ?? null,
        balance: chain?.signer?.balanceWei ?? null,
        contracts: {
          identity: config.chain.addresses.identity,
          ledger: config.chain.addresses.ledger,
          reputation: config.chain.addresses.reputation,
          access: config.chain.addresses.access,
        },
        addressesSource: config.chain.addressesSource,
      },
      model: {
        ready: embeddingState.status === 'ready',
        loading: embeddingState.status === 'loading',
        provider: embeddingState.provider,
        name: modelInfo?.name ?? embeddingState.model ?? null,
        uri: modelInfo?.uri ?? null,
        pinned: modelInfo?.pinned ?? null,
        dim: embeddingState.dim ?? null,
        dimensions: embeddingState.dim ?? null,
        error: embeddingState.error ?? null,
      },
      ipfs: {
        configured: Boolean(config.ipfs.enabled),
        provider: 'pinata',
        status: ipfs?.status ?? 'disabled',
        gateway: config.ipfs.gatewayUrl ?? null,
      },
      protocol: {
        ...PROTOCOL_INFO,
        projectionId: services.protocol?.projectionId ?? null,
      },
      features: {
        write: Boolean(config.features.write),
        search: Boolean(config.features.search),
        decrypt: Boolean(services.crypto.configured()),
        metrics: Boolean(config.features.metrics),
        legacyRoutes: true,
        // EventSource cannot set a header, so this node deliberately has no SSE endpoint rather
        // than one authenticated by a token in a query string. Clients poll.
        sseToken: /** @type {const} */ (false),
      },
      counts: {
        memories: services.memory.count(),
        jobs: services.jobs.size(),
      },
      memoryCount: services.memory.count(),
      readOnly: Boolean(config.signer.readOnly),
    };
  }

  router.get(
    '/status',
    validate({}),
    asyncHandler(async (_req, res) => {
      if (!statusCache || Date.now() - statusCache.at > STATUS_CACHE_MS) {
        // eslint-disable-next-line require-atomic-updates -- benign single-threaded cache race; last write wins
        statusCache = { at: Date.now(), value: await buildStatus() };
      }
      res.set('Cache-Control', 'no-cache');
      res.status(200).json(statusCache.value);
    }),
  );

  return router;
}

export default createHealthRoutes;
