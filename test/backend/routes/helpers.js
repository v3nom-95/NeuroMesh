/**
 * Fixtures for the HTTP-layer tests.
 *
 * `createApp({services})` takes its whole world as an argument, so these tests exercise the real
 * routers, the real validation, the real error middleware and the real memory/crypto/semantic
 * services, and fake only the two things a unit test must never do for real: spend gas, and pay a
 * pinning service. Nothing here reads `.env`, opens a socket or downloads model weights - which is
 * the constraint `npm run test:unit` imposes, since it runs `node --test test/backend` with no
 * environment preset at all.
 *
 * @module test/backend/routes/helpers
 */
import { createApp } from '../../../src/app.js';
import { errors } from '../../../src/errors.js';
import { createEmbeddingService } from '../../../src/services/embeddings.js';
import { createCryptoService } from '../../../src/services/crypto.js';
import { createServices } from '../../../src/services/index.js';
import { ADDRESSES, TEST_AGENT, fakePinner, quietLogger, testConfig } from '../services/helpers.js';

export { ADDRESSES, TEST_AGENT, testConfig, quietLogger };

/**
 * A well-formed CIDv1 (raw codec, sha2-256) that nothing has ever stored - it addresses 32 zero
 * bytes. Used for the 404 and validation assertions, where the CID must be *valid* so the route
 * fails for the reason under test rather than at parameter validation.
 */
export const UNKNOWN_CID = 'bafkreidgnb5k36dcxv3wzd6brohj7drabclrjblo4iz3hebkleoq2xzjeu';

/** A CID that is syntactically wrong, for the parameter-validation assertions. */
export const MALFORMED_CID = 'QmXv4cAQdpVjaE6x5k1NudzdHuNbkR8CDW92JcVKQvhHMF';

/** A second address, distinct from the node's own agent. */
export const PEER_ADDRESS = ADDRESSES.MemoryLedger;

/**
 * A chain double: everything a route reads, and a `submit` that pretends to confirm.
 *
 * @param {object} [options] Options.
 * @param {boolean} [options.writable] Whether `assertWritable` passes.
 * @param {boolean} [options.registered] What `isRegistered`/`getAgent().exists` report.
 * @param {boolean} [options.contractsCompatible] The compatibility verdict.
 * @param {boolean} [options.reachable] Whether the RPC endpoint answers.
 * @param {Error|null} [options.submitError] Make `submit` reject with this.
 * @returns {any} The double, plus a `submits` log.
 */
export function fakeChain({
  writable = true,
  registered = true,
  contractsCompatible = true,
  reachable = true,
  submitError = null,
} = {}) {
  /** @type {any[]} */
  const submits = [];
  const txHash = `0x${'ab'.repeat(32)}`;

  /** @type {any} */
  const chain = {
    submits,
    enabled: true,
    address: () => TEST_AGENT,
    state: () => ({
      status: contractsCompatible ? 'ready' : 'degraded',
      reachable,
      chainId: 11155111,
      expectedChainId: 11155111,
      blockNumber: 8123456,
      contractsCompatible,
      contracts: {},
      checkedAt: new Date(0).toISOString(),
      error: contractsCompatible ? null : { code: 'typehash_absent', message: 'stale deployment' },
    }),
    assertWritable() {
      if (writable && contractsCompatible) return;
      const err = /** @type {any} */ (new Error('read only'));
      err.status = 503;
      err.code = writable ? 'contracts_incompatible' : 'read_only';
      err.expose = true;
      throw err;
    },
    async init() {
      return chain.state();
    },
    async probe() {
      return {
        reachable,
        chainId: 11155111,
        blockNumber: 8123456,
        latencyMs: 1,
        error: null,
      };
    },
    async health() {
      return {
        status: reachable ? (contractsCompatible ? 'up' : 'degraded') : 'down',
        reachable,
        contractsCompatible,
        chainId: 11155111,
        blockNumber: 8123456,
        writable,
        signer: {
          configured: true,
          address: TEST_AGENT,
          balanceWei: '270000000000000000',
          low: false,
        },
        contracts: {},
        latency: {},
        detail: null,
      };
    },
    async balance() {
      return '270000000000000000';
    },
    async getBlockNumber() {
      return 8123456;
    },
    async signMemoryCommit(args) {
      return {
        signature: `0x${'11'.repeat(65)}`,
        digest: `0x${'22'.repeat(32)}`,
        nonce: '0',
        deadline: args.deadline,
        agent: TEST_AGENT,
        crossChecked: true,
      };
    },
    async submit(descriptor) {
      submits.push(descriptor);
      if (submitError) throw submitError;
      descriptor.onHash?.(txHash);
      return {
        status: 'confirmed',
        hash: txHash,
        nonce: '0',
        blockNumber: 8123457,
        gasUsed: '190000',
        effectiveGasPrice: '1500000000',
        explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`,
        retried: false,
        confirmations: 1,
      };
    },
    readIdentity: {
      async getAgent(address) {
        return {
          registeredAt: registered ? 1767225600 : 0,
          statusChangedAt: 0,
          keyVersion: registered ? 1 : 0,
          active: registered,
          exists: registered,
          publicKey: registered ? `0x02${'11'.repeat(32)}` : '0x',
          metadataURI: registered ? 'https://example.invalid/agent.json' : '',
          address,
        };
      },
      async getPublicKey() {
        return { publicKey: `0x02${'11'.repeat(32)}`, keyVersion: 1 };
      },
      async isRegistered() {
        return registered;
      },
      async isActive() {
        return registered;
      },
      async nonces() {
        return '0';
      },
      async totalAgents() {
        return registered ? 1 : 0;
      },
      async getAgents() {
        return { page: registered ? [TEST_AGENT] : [], total: registered ? 1 : 0 };
      },
    },
    readLedger: {
      async getMemoryByCid(cid) {
        const committed = submits[0]?.args?.[1];
        return {
          owner: TEST_AGENT,
          committedAt: 1767225600,
          embeddingDim: Number(committed?.[3] ?? 384),
          prevCidHash: `0x${'00'.repeat(32)}`,
          committedBy: TEST_AGENT,
          revokedAt: 0,
          version: 1,
          isEncrypted: true,
          revoked: false,
          cid,
          model: String(committed?.[2] ?? 'nm1:tag'),
        };
      },
      async getOwnerMemoryRecords() {
        return { page: [], total: 0 };
      },
    },
    readReputation: {
      async reputationOf() {
        return '750000000000000000';
      },
      async getTrustEvents() {
        return { page: [], total: 0 };
      },
    },
    readAccess: {},
    async drain() {},
    queueDepth: () => 0,
    async shutdown() {},
  };
  return chain;
}

/**
 * A reputation double. The real service reads five contract getters this fixture does not model;
 * faking at the service boundary keeps the route tests about routing.
 *
 * @param {object} [options] Options.
 * @param {Error|null} [options.error] Make every read reject with this.
 * @returns {any} The double, plus an `actions` log.
 */
export function fakeReputation({ error = null } = {}) {
  /** @type {any[]} */
  const actions = [];
  /**
   * @param {string} address Agent address.
   * @returns {Record<string, any>} A score entry.
   */
  const entry = (address) => ({
    address,
    scoreWad: '750000000000000000',
    score: 0.75,
    bps: 7500,
    trusted: true,
    endorsements: 3,
    reports: 0,
  });
  /**
   * @returns {void}
   */
  const boom = () => {
    if (error) throw error;
  };
  return {
    actions,
    async scoreOf(address) {
      boom();
      return entry(address);
    },
    async summaryOf(address) {
      boom();
      return {
        ...entry(address),
        registered: true,
        active: true,
        keyVersion: 1,
        registeredAt: 1767225600,
        thresholds: { trusted: 0.5, max: 1 },
      };
    },
    async leaderboard({ addresses = [] } = {}) {
      boom();
      return {
        entries: addresses.map(entry),
        thresholds: { trusted: 0.5, max: 1 },
        failed: [],
      };
    },
    async events() {
      boom();
      return { items: [], nextCursor: null, total: 0, capacityBounded: true };
    },
    async endorse(args) {
      actions.push({ action: 'endorse', ...args });
      args.onHash?.(`0x${'cd'.repeat(32)}`);
      return {
        hash: `0x${'cd'.repeat(32)}`,
        blockNumber: 8123458,
        explorerUrl: 'https://x.invalid',
      };
    },
    async report(args) {
      actions.push({ action: 'report', ...args });
      args.onHash?.(`0x${'ef'.repeat(32)}`);
      return {
        hash: `0x${'ef'.repeat(32)}`,
        blockNumber: 8123459,
        explorerUrl: 'https://x.invalid',
      };
    },
    async parameters() {
      return { trustThreshold: 0.5 };
    },
    async health() {
      return { status: 'up', detail: null };
    },
    wadToUnit: (wad) => Number(BigInt(wad)) / 1e18,
  };
}

/**
 * Wrap {@link fakePinner} with the two members the container's readiness check and shutdown need.
 *
 * @param {object} [options] Options forwarded to `fakePinner`.
 * @returns {any} The pinner.
 */
export function routePinner(options = {}) {
  const pinner = fakePinner(options);
  // The real service maps a gateway 404 to a typed `memory_not_found`, so the fake must too.
  // Throwing a bare Error here would let a genuine missing-CID path answer 500 in the tests while
  // answering 404 in production, which is the wrong way round for a fixture to be wrong.
  pinner.fetchBytes = async (/** @type {string} */ cid) => {
    const bytes = pinner.store.get(cid);
    if (!bytes) throw errors.memoryNotFound(cid);
    return bytes;
  };
  pinner.fetchByCid = async (/** @type {string} */ cid) => {
    const bytes = await pinner.fetchBytes(cid);
    return { cid, bytes, json: JSON.parse(Buffer.from(bytes).toString('utf8')) };
  };
  pinner.probe = async () => ({
    configured: true,
    status: 'up',
    detail: null,
    checkedAt: new Date(0).toISOString(),
  });
  pinner.listPins = async () => ({ items: [], nextCursor: null, total: 0 });
  pinner.cacheSize = () => pinner.store.size;
  pinner.shutdown = async () => {};
  return pinner;
}

/**
 * Build a service container and an app around it.
 *
 * @param {object} [options] Options.
 * @param {Record<string, string|undefined>} [options.env] Environment overrides for `testConfig`.
 * @param {Record<string, any>} [options.overrides] Service overrides passed to `createServices`.
 * @param {boolean} [options.warm] Whether to run `warmup()` before returning. Default true, so
 *   `/readyz` is green and the model is loaded (the mock provider loads instantly).
 * @returns {Promise<{app: any, services: any, config: any, chain: any, ipfs: any}>} The graph.
 */
export async function buildApp({ env = {}, overrides = {}, warm = true } = {}) {
  const config = testConfig(env);
  const logger = quietLogger();

  const chain = overrides.chain ?? fakeChain();
  const ipfs = overrides.ipfs ?? routePinner();
  const reputation = overrides.reputation ?? fakeReputation();
  const embeddings = overrides.embeddings ?? createEmbeddingService({ config, logger });
  const crypto = overrides.crypto ?? createCryptoService({ config, logger });

  const services = await createServices({
    config,
    logger,
    overrides: { ...overrides, chain, ipfs, reputation, embeddings, crypto },
  });

  if (warm) {
    await embeddings.init();
    await crypto.init();
  }

  const app = createApp({ services, config, logger });
  return { app, services, config, chain, ipfs, reputation, embeddings, crypto };
}

/**
 * Commit one memory through the real pipeline and return its CID.
 *
 * @param {any} graph The graph from {@link buildApp}.
 * @param {string} [context] The plaintext.
 * @returns {Promise<string>} The CID.
 */
export async function commitMemory(graph, context = 'a memory worth keeping') {
  const job = graph.services.memory.create({ context });
  const finished = await graph.services.memory.waitFor(job.id);
  if (finished.state !== 'succeeded') {
    throw new Error(`fixture commit failed: ${JSON.stringify(finished.error)}`);
  }
  return String(finished.result.cid);
}
