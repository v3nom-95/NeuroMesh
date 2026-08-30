/**
 * Shared fixtures for the service tests.
 *
 * Everything here is **offline by construction**. There is no `.env` read, no network socket, no
 * private key that has ever held value, and no model download: `npm run test:unit` runs
 * `node --test test/backend` with no environment preset at all, so a fixture that needed one would
 * simply fail on a fresh clone.
 *
 * The fakes are deliberately *faithful* rather than minimal:
 *
 *   - {@link fakeNode} decodes call data with the **real generated ABI** and encodes results with it
 *     too, so a test exercises the same encode/decode path production does. A hand-rolled stub that
 *     returned plain objects would pass even if the ABI were wrong, which is the class of bug
 *     `src/abi/` exists to prevent.
 *   - {@link fakePinner} computes the **real CIDv1** over the exact bytes it is handed, so the
 *     local-CID assertion in the IPFS service is genuinely tested rather than short-circuited.
 *
 * @module test/backend/services/helpers
 */
import { Network, Wallet } from 'ethers';

import { EXPECTED_DOMAINS, EXPECTED_TYPEHASHES, getInterface } from '../../../src/abi/index.js';
import { configFromEnv } from '../../../src/config/index.js';
import { canonical } from '../../../src/protocol/index.js';

/** A private key that is not, and must never be, a real one. */
export const TEST_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
/** A second, independent key, so the key-separation rule is satisfied. */
export const TEST_ENCRYPTION_KEY = '22'.repeat(32);

/** Checksummed addresses used only as address-shaped test data. */
export const ADDRESSES = Object.freeze({
  AgentIdentity: '0xD4F91196316f802B67C6B17e0B1845A23beaA2ad',
  MemoryLedger: '0x10701017eC0faed2309E103C51AB503214F940Fb',
  ReputationManager: '0x8E56B730894474e8770b38b4a4A0428f224635ac',
  MemoryAccessControl: '0x2f2e0Bc2c48d1d4d0f27b2B3B3D2C5E7A8Bb9C10',
});

/** The address `TEST_PRIVATE_KEY` controls. */
export const TEST_AGENT = new Wallet(TEST_PRIVATE_KEY).address;

/**
 * Build a frozen config from an explicit environment.
 *
 * Every contract address is set explicitly so the fixture never depends on the repository's
 * `contract-addresses.json`, which points at a stale v1 deployment and would otherwise make these
 * tests change behaviour when that file is regenerated.
 *
 * @param {Record<string, string|undefined>} [overrides] Environment overrides.
 * @returns {Record<string, any>} Frozen config.
 */
export function testConfig(overrides = {}) {
  /** @type {Record<string, string|undefined>} */
  const env = {
    NODE_ENV: 'test',
    SEPOLIA_RPC_URL: 'https://rpc.invalid.test/one',
    CHAIN_ID: '11155111',
    // Point the deployment-record lookup at a path that does not exist, so the fixture depends on
    // nothing but its own explicit addresses. The repository's real contract-addresses.json holds a
    // stale v1 deployment, and letting it leak in would make these tests change when it is
    // regenerated - and would silently supply an address a test deliberately left unset.
    CONTRACT_ADDRESSES_PATH: './test/fixtures/no-such-deployment.json',
    PRIVATE_KEY: TEST_PRIVATE_KEY,
    MEMORY_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    PINATA_JWT: 'test-jwt-not-a-real-credential',
    CONTRACT_AGENT_IDENTITY: ADDRESSES.AgentIdentity,
    CONTRACT_MEMORY_LEDGER: ADDRESSES.MemoryLedger,
    CONTRACT_REPUTATION_MANAGER: ADDRESSES.ReputationManager,
    CONTRACT_MEMORY_ACCESS_CONTROL: ADDRESSES.MemoryAccessControl,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }
  return configFromEnv(env);
}

/**
 * A logger that records nothing and never throws.
 *
 * @returns {any} A pino-shaped no-op logger.
 */
export function quietLogger() {
  /** @type {any} */
  const log = {
    level: 'silent',
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child: () => log,
  };
  return log;
}

/**
 * A logger that keeps every record, for asserting on what was logged.
 *
 * @returns {{logger: any, records: Array<{level: string, obj: any, msg: string}>}} Logger and sink.
 */
export function recordingLogger() {
  /** @type {Array<{level: string, obj: any, msg: string}>} */
  const records = [];
  /**
   * @param {string} level Level name.
   * @returns {(obj?: any, msg?: string) => void} A record function.
   */
  const at =
    (level) =>
    (obj, msg = '') => {
      records.push(typeof obj === 'string' ? { level, obj: null, msg: obj } : { level, obj, msg });
    };
  /** @type {any} */
  const logger = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  };
  return { logger, records };
}

/**
 * A metrics collector that records every observation, for asserting instrumentation exists.
 *
 * @returns {{metrics: any, calls: Array<{kind: string, name: string, args: any[]}>}} Collector and
 *   sink.
 */
export function recordingMetrics() {
  /** @type {Array<{kind: string, name: string, args: any[]}>} */
  const calls = [];
  return {
    calls,
    metrics: {
      /**
       * @param {string} name Metric name.
       * @param {number} seconds Observation.
       * @param {any} labels Labels.
       * @returns {void}
       */
      observe(name, seconds, labels) {
        calls.push({ kind: 'observe', name, args: [seconds, labels] });
      },
      /**
       * @param {string} name Metric name.
       * @param {any} labels Labels.
       * @param {number} [value] Increment.
       * @returns {void}
       */
      increment(name, labels, value) {
        calls.push({ kind: 'increment', name, args: [labels, value] });
      },
      /**
       * @param {string} name Metric name.
       * @param {number} value Gauge value.
       * @param {any} labels Labels.
       * @returns {void}
       */
      gauge(name, value, labels) {
        calls.push({ kind: 'gauge', name, args: [value, labels] });
      },
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Fake chain node                                                           */
/* ------------------------------------------------------------------------ */

/**
 * An in-memory chain endpoint that speaks the real ABI.
 *
 * `call()` decodes the incoming calldata with the generated `Interface`, dispatches on
 * `"<Contract>.<method>"`, and encodes the handler's return value back through the same interface.
 * A handler that throws produces a `CALL_EXCEPTION`-shaped failure, which is how a missing
 * `*_TYPEHASH()` getter on the stale v1 deployment is reproduced.
 *
 * @param {object} [options] Options.
 * @param {number} [options.chainId] Chain id the endpoint reports.
 * @param {number} [options.blockNumber] Head block.
 * @param {Record<string, string>} [options.code] Address to `eth_getCode` result.
 * @param {Record<string, bigint>} [options.balances] Address to balance in wei.
 * @param {Record<string, (args: any[]) => any>} [options.handlers] `Contract.method` to handler.
 * @param {bigint} [options.gasEstimate] What `estimateGas` returns.
 * @param {number} [options.pendingNonce] What `getTransactionCount(addr,'pending')` returns.
 * @param {any} [options.receipt] What `waitForTransaction` resolves to; `null` means "timeout".
 * @returns {any} A fake node with `provider`, `walletFor`, and a `calls` log.
 */
export function fakeNode(options = {}) {
  const {
    chainId = 11155111,
    blockNumber = 8123456,
    code = defaultCode(),
    balances = {},
    handlers = {},
    gasEstimate = 210000n,
    pendingNonce = 7,
    receipt = { status: 1, blockNumber: 8123457, gasUsed: 190000n, gasPrice: 1500000000n },
  } = options;

  /** @type {Array<{method: string, args: any[]}>} */
  const calls = [];
  /** @type {Array<{nonce: number, hash: string, tx: any}>} */
  const sent = [];
  const network = Network.from(chainId);
  /** @type {Record<string, string>} */
  const byAddress = {};
  for (const [name, address] of Object.entries(ADDRESSES)) {
    byAddress[address.toLowerCase()] = name;
  }

  /**
   * @param {string} address Contract address.
   * @returns {string} Contract name.
   */
  function contractAt(address) {
    const name = byAddress[String(address).toLowerCase()];
    if (!name) throw new Error(`fakeNode: no contract configured at ${address}`);
    return name;
  }

  /** @type {any} */
  const provider = {
    /**
     * @returns {Promise<any>} The pinned network.
     */
    async getNetwork() {
      calls.push({ method: 'getNetwork', args: [] });
      return network;
    },
    /**
     * @returns {Promise<number>} Head block.
     */
    async getBlockNumber() {
      calls.push({ method: 'getBlockNumber', args: [] });
      return blockNumber;
    },
    /**
     * @param {string} address Address to inspect.
     * @returns {Promise<string>} Deployed bytecode, or `0x`.
     */
    async getCode(address) {
      calls.push({ method: 'getCode', args: [address] });
      return code[String(address)] ?? code[String(address).toLowerCase()] ?? '0x';
    },
    /**
     * @param {string} address Address to inspect.
     * @returns {Promise<bigint>} Balance in wei.
     */
    async getBalance(address) {
      calls.push({ method: 'getBalance', args: [address] });
      return balances[String(address)] ?? 10n ** 18n;
    },
    /**
     * @returns {Promise<number>} Pending transaction count.
     */
    async getTransactionCount() {
      calls.push({ method: 'getTransactionCount', args: [] });
      return pendingNonce;
    },
    /**
     * @returns {Promise<any>} Fee data with both EIP-1559 fields populated.
     */
    async getFeeData() {
      calls.push({ method: 'getFeeData', args: [] });
      return {
        gasPrice: 1000000000n,
        maxFeePerGas: 2000000000n,
        maxPriorityFeePerGas: 1000000000n,
      };
    },
    /**
     * @param {any} tx Transaction request.
     * @returns {Promise<string>} ABI-encoded result.
     */
    async call(tx) {
      const name = contractAt(tx.to);
      const iface = getInterface(/** @type {any} */ (name));
      const parsed = iface.parseTransaction({ data: tx.data });
      if (!parsed) throw new Error(`fakeNode: undecodable calldata for ${name}`);
      const key = `${name}.${parsed.name}`;
      calls.push({ method: key, args: [...parsed.args] });
      const handler = handlers[key];
      if (!handler) {
        // Exactly what the stale v1 deployment looks like: the selector is not there, so the call
        // reverts with no data.
        const err = /** @type {any} */ (new Error(`execution reverted (no handler for ${key})`));
        err.code = 'CALL_EXCEPTION';
        err.shortMessage = 'execution reverted';
        throw err;
      }
      const value = await handler([...parsed.args]);
      return iface.encodeFunctionResult(parsed.name, Array.isArray(value) ? value : [value]);
    },
    /**
     * @returns {Promise<bigint>} The configured gas estimate.
     */
    async estimateGas() {
      calls.push({ method: 'estimateGas', args: [] });
      return gasEstimate;
    },
    /**
     * @returns {Promise<any>} The configured receipt, or null to model a confirmation timeout.
     */
    async waitForTransaction() {
      calls.push({ method: 'waitForTransaction', args: [] });
      return receipt;
    },
    destroy() {},
  };

  /**
   * A signer that is a valid ethers `ContractRunner` without dragging in the whole `Wallet`
   * transaction pipeline. Typed-data signing uses a real `Wallet`, so signatures are genuine.
   *
   * @param {string} privateKey Signing key.
   * @returns {any} The runner.
   */
  function walletFor(privateKey) {
    const signing = new Wallet(privateKey);
    return {
      address: signing.address,
      provider,
      /**
       * @param {any} tx Call request.
       * @returns {Promise<string>} Encoded result.
       */
      call: (tx) => provider.call(tx),
      /**
       * @returns {Promise<bigint>} Gas estimate.
       */
      estimateGas: () => provider.estimateGas(),
      /**
       * @param {any} tx Transaction request.
       * @returns {Promise<{hash: string, nonce: number}>} A response-shaped object.
       */
      async sendTransaction(tx) {
        const nonce = Number(tx.nonce);
        const hash = `0x${nonce.toString(16).padStart(64, '0')}`;
        sent.push({ nonce, hash, tx });
        return { hash, nonce };
      },
      /**
       * @param {any} domain EIP-712 domain.
       * @param {any} types Type table.
       * @param {any} value Message.
       * @returns {Promise<string>} A real signature.
       */
      signTypedData: (domain, types, value) => signing.signTypedData(domain, types, value),
    };
  }

  return {
    provider,
    providerFactory: () => provider,
    walletFactory: (/** @type {string} */ key) => walletFor(key),
    walletFor,
    calls,
    sent,
    network,
  };
}

/**
 * Bytecode long enough to be plausible at every configured address.
 *
 * @returns {Record<string, string>} Address to code.
 */
function defaultCode() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const address of Object.values(ADDRESSES)) out[address] = `0x60806040${'ab'.repeat(600)}`;
  return out;
}

/**
 * Handlers that make {@link fakeNode} behave like a correct v2 deployment.
 *
 * @param {object} [options] Options.
 * @param {Record<string, string>} [options.typehashes] Contract-qualified getter overrides.
 * @param {Record<string, any>} [options.extra] Extra handlers, merged last.
 * @returns {Record<string, (args: any[]) => any>} Handler table.
 */
export function compatibleHandlers({ extra = {} } = {}) {
  /** @type {Record<string, (args: any[]) => any>} */
  const handlers = {};
  // The getters answer with the values `src/abi/` derives locally, so this fixture cannot drift
  // from the expectation the chain service compares against.
  for (const [contract, getters] of Object.entries(EXPECTED_TYPEHASHES)) {
    for (const [getter, value] of Object.entries(getters)) {
      handlers[`${contract}.${getter}`] = () => value;
    }
  }
  for (const [name, address] of Object.entries(ADDRESSES)) {
    const domain = /** @type {any} */ (EXPECTED_DOMAINS)[name];
    if (!domain) continue;
    handlers[`${name}.eip712Domain`] = () => [
      '0x0f',
      domain.name,
      domain.version,
      11155111n,
      address,
      `0x${'0'.repeat(64)}`,
      [],
    ];
  }
  return { ...handlers, ...extra };
}

/* ------------------------------------------------------------------------ */
/* Fake pinning service                                                      */
/* ------------------------------------------------------------------------ */

/**
 * An in-memory pinning service that computes real CIDs.
 *
 * It is the same shape as `src/services/ipfs.js` and computes `cidFromBytes` over exactly the bytes
 * it is given, so a test that asserts "the CID the job reports addresses the bytes that were stored"
 * is asserting something real.
 *
 * @param {object} [options] Options.
 * @param {boolean} [options.unpinFails] Make `unpin` report failure, to exercise the branch where
 *   compensation itself fails.
 * @returns {any} The fake service, plus `store` and `calls` for assertions.
 */
export function fakePinner({ unpinFails = false } = {}) {
  /** @type {Map<string, Uint8Array>} */
  const store = new Map();
  /** @type {string[]} */
  const calls = [];
  return {
    store,
    calls,
    enabled: true,
    /**
     * @param {Uint8Array} bytes Exact bytes.
     * @returns {Promise<any>} Pin result with a locally computed CID.
     */
    async pinBytes(bytes) {
      const { cid, digest } = canonical.cidFromBytes(bytes);
      store.set(cid, bytes);
      calls.push(`pin:${cid}`);
      return { cid, digest, size: bytes.length, timestamp: null, duplicate: false };
    },
    /**
     * @param {string} cid CID to unpin.
     * @returns {Promise<{ok: boolean, cid: string, reason: string|null}>} Outcome.
     */
    async unpin(cid) {
      calls.push(`unpin:${cid}`);
      if (unpinFails) return { ok: false, cid, reason: 'simulated unpin failure' };
      store.delete(cid);
      return { ok: true, cid, reason: null };
    },
    /**
     * @param {string} cid CID to fetch.
     * @returns {Promise<Uint8Array>} The stored bytes.
     */
    async fetchBytes(cid) {
      const bytes = store.get(cid);
      if (!bytes) throw new Error(`fakePinner: nothing stored at ${cid}`);
      return bytes;
    },
    /**
     * @param {string} cid CID to fetch.
     * @returns {Promise<{cid: string, bytes: Uint8Array, json: unknown}>} The parsed object.
     */
    async fetchByCid(cid) {
      const bytes = await this.fetchBytes(cid);
      return { cid, bytes, json: JSON.parse(Buffer.from(bytes).toString('utf8')) };
    },
    /**
     * @param {string} cid CID.
     * @returns {string} A gateway URL.
     */
    gatewayUrl: (cid) => `https://gateway.invalid.test/ipfs/${cid}`,
  };
}

/**
 * Build a `Response` for an injected `fetch`.
 *
 * @param {object} [options] Options.
 * @param {number} [options.status] HTTP status.
 * @param {any} [options.json] JSON body.
 * @param {Uint8Array|string} [options.body] Raw body, used instead of `json`.
 * @param {Record<string, string>} [options.headers] Response headers.
 * @returns {Response} The response.
 */
export function response({ status = 200, json, body, headers = {} } = {}) {
  if (json !== undefined) {
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }
  return new Response(/** @type {any} */ (body ?? ''), { status, headers });
}

/**
 * A `fetch` double that returns queued responses and records every request.
 *
 * @param {Array<Response|((url: string, init: any) => Response|Promise<Response>)>} queue Responses,
 *   consumed in order. A function is called with the request.
 * @returns {any} The fetch double, with a `requests` log.
 */
export function fakeFetch(queue) {
  /** @type {Array<{url: string, init: any}>} */
  const requests = [];
  const pending = [...queue];
  /**
   * @param {string} url Request URL.
   * @param {any} init Request options.
   * @returns {Promise<Response>} The next queued response.
   */
  const impl = async (url, init) => {
    requests.push({ url: String(url), init });
    const next = pending.shift();
    if (next === undefined) throw new Error(`fakeFetch: no queued response for ${url}`);
    return typeof next === 'function' ? next(String(url), init) : next;
  };
  impl.requests = requests;
  impl.remaining = () => pending.length;
  return impl;
}

/**
 * A `sleep` double that records the delays it was asked for instead of waiting.
 *
 * @returns {{sleep: (ms: number) => Promise<void>, delays: number[]}} The double and its log.
 */
export function fakeSleep() {
  /** @type {number[]} */
  const delays = [];
  return {
    delays,
    /**
     * @param {number} ms Requested delay.
     * @returns {Promise<void>} Resolves immediately.
     */
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}
