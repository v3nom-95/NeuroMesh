/**
 * Chain service: provider failover, an optional signer, contract instances, boot-time compatibility
 * checks, typed reads, EIP-712 signing, and the single serialized transaction queue.
 *
 * ## The four v1 defects this module removes
 *
 * 1. **A boot `TypeError` that was swallowed.** v1 read `process.env.PRIVATE_KEY` and called
 *    `pk.startsWith('0x')` on it, inside a callback passed to `app.listen`. With no key the port was
 *    already bound when the `TypeError` fired, the rejection was caught and logged, and the process
 *    then served traffic forever with `contracts` undefined. Here the key is validated by
 *    `src/config/env.js` before anything is constructed, a node with no key is a *legitimate*
 *    read-only node rather than a broken one, and {@link ChainService.health} is what readiness reads.
 * 2. **Hand-transcribed ABIs in two files.** Every fragment now comes from `src/abi/`, which
 *    `scripts/gen-abi.js` generates from the compiled artifacts.
 * 3. **A concurrent-write nonce race.** Two simultaneous writes each asked the provider for the
 *    pending transaction count, both got the same number, and one transaction was silently dropped.
 *    {@link createChainService} serializes every write through one promise chain with a locally
 *    tracked nonce, so two callers can never be handed the same value.
 * 4. **`await tx.wait()` with no timeout.** A stuck nonce hung the HTTP request until the client gave
 *    up and the socket leaked. {@link ChainService.waitForTx} always has a deadline and reports
 *    `timeout` as a *state*, not as an exception that loses the transaction hash.
 *
 * ## The stale deployment is a degraded state, not a crash
 *
 * `contract-addresses.json` points at v1 contracts whose ABI does not match `src/abi/`. Calling a
 * `*_TYPEHASH()` getter on them reverts, because those getters do not exist. {@link ChainService.init}
 * therefore probes rather than asserts: it records `contractsCompatible: false` with a per-contract
 * reason, leaves every read-only route and the whole dashboard working, and refuses only *writes*.
 * A node that cannot prove the deployment matches must not sign a transaction against it - but it
 * has no business refusing to serve a status page either.
 *
 * Three independent signals feed that verdict, in increasing order of authority:
 *
 *   - **bytecode present** - `eth_getCode` returning `0x` means there is no contract at the address
 *     at all, which is what a `hardhat run --network localhost` clobber of the deployment record
 *     looks like from here.
 *   - **bytecode hash** - evidence, never proof. Immutables are zeroed in the artifact and populated
 *     on chain, and the metadata hash moves with compiler settings, so a mismatch means "cannot
 *     prove this is the build we know", not "wrong contract".
 *   - **typehashes and the EIP-712 domain** - decisive. If `MEMORY_COMMIT_TYPEHASH()` differs from
 *     the locally computed one, every signature this node produces would be rejected on chain.
 *     `ReputationManager` is exempt from the domain probe: it has no EIP-712 mixin, and probing it
 *     uniformly would make a *correct* deployment look broken.
 *
 * ## Units
 *
 * Every read returns JSON-safe values: `bigint` becomes a decimal `string` (or a `number` where the
 * Solidity type is `uint32`/`uint64` and cannot overflow `Number.MAX_SAFE_INTEGER`). `JSON.stringify`
 * throws on a `BigInt`, so leaking one out of this module turns a chart into a 500. The WAD
 * (1e18-scaled) reputation values are returned **unconverted**; `src/services/reputation.js` is the
 * single place that divides by 1e18, and doing it in two places is how a number ends up off by 1e15.
 *
 * @module src/services/chain
 */
import { Contract, JsonRpcProvider, Network, Wallet, getAddress, isAddress } from 'ethers';

import {
  ABIS,
  CONTRACT_NAMES,
  DEPLOYED_BYTECODE_HASHES,
  EXPECTED_DOMAINS,
  EXPECTED_TYPEHASHES,
  SUPPORTS_EIP712,
  TYPEHASH_GETTERS,
} from '../abi/index.js';
import { getConfig } from '../config/index.js';
import { errors } from '../errors.js';
import { logger as defaultLogger } from '../logger.js';
import { canonical, eip712 } from '../protocol/index.js';

import { LatencyRing, normalizeMetrics, sleep as realSleep, withDeadline } from './instrument.js';

/** Per-call RPC budget. Long enough for a slow public endpoint, short enough to fail a probe fast. */
export const RPC_TIMEOUT_MS = 10000;

/** Gas limit safety margin over `estimateGas`, as a percentage. */
export const GAS_LIMIT_MARGIN_PCT = 120n;

/**
 * Balance below which the signer check reports `degraded`.
 *
 * 0.005 ETH is roughly ten Sepolia commits at typical fees. It is a warning threshold, not a refusal:
 * the refusal is the exact per-transaction preflight in {@link ChainService.submit}, which compares
 * the balance against this transaction's own `gasLimit * maxFeePerGas + value` and can therefore say
 * precisely how much is missing.
 */
export const MIN_BALANCE_WEI = 5000000000000000n;

/** ethers error codes that mean "this endpoint is unwell", as opposed to "this call is wrong". */
const TRANSIENT_CODES = new Set(['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT', 'CALL_TIMEOUT']);

/** ethers error codes that mean the local nonce is stale and must be resynced from the chain. */
const NONCE_CODES = new Set(['NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED']);

/**
 * Map a contract name to the config key holding its address.
 *
 * @type {Readonly<Record<string, 'identity'|'ledger'|'reputation'|'access'>>}
 */
const ADDRESS_KEY = Object.freeze({
  AgentIdentity: /** @type {const} */ ('identity'),
  MemoryLedger: /** @type {const} */ ('ledger'),
  ReputationManager: /** @type {const} */ ('reputation'),
  MemoryAccessControl: /** @type {const} */ ('access'),
});

/**
 * Create the chain service.
 *
 * Construction performs no I/O and never throws for a recoverable reason. A node with no RPC URL, no
 * private key or no contract addresses is fully constructed and simply reports what it cannot do.
 *
 * @param {object} [deps] Dependencies.
 * @param {ReturnType<typeof getConfig>} [deps.config] Application config.
 * @param {any} [deps.logger] Pino logger.
 * @param {import('./instrument.js').MetricsLike} [deps.metrics] Metrics collector.
 * @param {(url: string, network: any) => any} [deps.providerFactory] Test seam: builds a provider
 *   for one endpoint. Defaults to a `JsonRpcProvider` pinned to the configured network.
 * @param {(privateKey: string, provider: any) => any} [deps.walletFactory] Test seam: builds the
 *   signer. Defaults to `new Wallet(key, provider)`.
 * @param {(ms: number) => Promise<void>} [deps.sleep] Delay function, injected in tests.
 * @param {() => number} [deps.now] Clock, in epoch milliseconds.
 * @returns {ChainService} The service.
 */
export function createChainService({
  config = getConfig(),
  logger = defaultLogger,
  metrics,
  providerFactory,
  walletFactory,
  sleep = realSleep,
  now = Date.now,
} = {}) {
  const log = logger.child ? logger.child({ service: 'chain' }) : logger;
  const instruments = normalizeMetrics(metrics);

  const endpoints = config.chain.rpcUrls ?? [];
  const enabled = endpoints.length > 0;
  const network = Network.from(config.chain.chainId);

  /** @type {Map<number, any>} */
  const providerCache = new Map();
  /** @type {Map<number, Record<string, any>>} */
  const contractCache = new Map();
  let activeIndex = 0;

  /** @type {any} */
  let wallet = null;
  /** @type {string|null} */
  let signerAddress = null;

  /** @type {ChainStatus} */
  let status = {
    status: enabled ? 'idle' : 'disabled',
    reachable: false,
    chainId: null,
    expectedChainId: config.chain.chainId,
    blockNumber: null,
    contractsCompatible: false,
    contracts: {},
    checkedAt: null,
    error: enabled ? null : { code: 'no_rpc_url', message: 'No RPC endpoint is configured.' },
  };

  /** @type {{at: number, value: {reachable: boolean, chainId: number|null, blockNumber: number|null, latencyMs: number|null, error: {code: string, message: string}|null}}|null} */
  let probeCache = null;
  /** @type {Promise<any>|null} */
  let probeInflight = null;

  const latency = new LatencyRing(200);

  /* ---------------------------------------------------------------------- */
  /* Provider and contracts                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * The provider for one endpoint index, built on first use.
   *
   * `staticNetwork` matters more than it looks: without it ethers re-detects the network before
   * every call, which doubles RPC volume and, on a rate-limited public endpoint, halves the effective
   * request budget for no benefit at all - the chain id is already known from configuration.
   *
   * @param {number} index Endpoint index.
   * @returns {any} A provider.
   */
  function providerAt(index) {
    const cached = providerCache.get(index);
    if (cached) return cached;
    const url = endpoints[index];
    const built = providerFactory
      ? providerFactory(url, network)
      : new JsonRpcProvider(url, network, { staticNetwork: network, batchMaxCount: 10 });
    providerCache.set(index, built);
    return built;
  }

  /**
   * Contract instances bound to one endpoint's provider.
   *
   * Bound to the *provider*, never to the wallet: reads must keep working on a read-only node, and a
   * write path that accidentally inherited a signer from a read helper is how an unintended
   * transaction gets sent. {@link submit} attaches the wallet explicitly, once, at the point of
   * submission.
   *
   * @param {number} index Endpoint index.
   * @returns {Record<string, any>} Contracts by name; a missing address yields `null`.
   */
  function contractsAt(index) {
    const cached = contractCache.get(index);
    if (cached) return cached;
    const provider = providerAt(index);
    /** @type {Record<string, any>} */
    const built = {};
    for (const name of CONTRACT_NAMES) {
      const address = config.chain.addresses[ADDRESS_KEY[name]];
      built[name] = address
        ? new Contract(address, /** @type {any} */ (ABIS[name]), provider)
        : null;
    }
    contractCache.set(index, built);
    return built;
  }

  /**
   * Advance to the next endpoint.
   *
   * @param {string} label What was being attempted, for the log line.
   * @returns {boolean} Whether another endpoint was available.
   */
  function failover(label) {
    if (endpoints.length < 2) return false;
    const from = endpoints[activeIndex];
    const next = (activeIndex + 1) % endpoints.length;
    activeIndex = next;
    instruments.increment('neuromesh_rpc_failover_total', { label });
    log.warn?.({ label, from: redactUrl(from), to: redactUrl(endpoints[next]) }, 'rpc failover');
    return true;
  }

  /**
   * Run one RPC interaction with a deadline, a single failover retry per remaining endpoint, and
   * normalized errors.
   *
   * @template T
   * @param {string} label Metric and log label, e.g. `MemoryLedger.getMemory`.
   * @param {(ctx: {provider: any, contracts: Record<string, any>}) => Promise<T>} fn The interaction.
   * @returns {Promise<T>} The result.
   */
  async function withRpc(label, fn) {
    if (!enabled) throw errors.chainUnavailable('No RPC endpoint is configured on this node.');
    const attempts = Math.max(1, endpoints.length);
    /** @type {unknown} */
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const index = activeIndex;
      const stop = instruments.timer('neuromesh_rpc_call_duration_seconds', { method: label });
      try {
        const value = await withDeadline(
          fn({ provider: providerAt(index), contracts: contractsAt(index) }),
          RPC_TIMEOUT_MS,
          () => errors.upstreamTimeout(`RPC call ${label} exceeded ${RPC_TIMEOUT_MS} ms.`),
        );
        latency.observe(stop({ status: 'ok' }));
        return value;
      } catch (err) {
        stop({ status: 'error' });
        const mapped = mapChainError(err, label);
        if (!isTransient(err) || attempt === attempts - 1) throw mapped;
        lastError = mapped;
        failover(label);
      }
    }
    /* c8 ignore next -- the loop returns or throws on its final iteration */
    throw lastError ?? errors.chainUnavailable(`RPC call ${label} failed.`);
  }

  /* ---------------------------------------------------------------------- */
  /* Boot invariants                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Connect, verify the chain id, and check every configured contract for compatibility.
   *
   * **Never throws.** Every failure becomes a recorded check with a reason a human can act on, and
   * the node keeps serving reads. The caller decides what to do with
   * {@link ChainStatus.contractsCompatible}; {@link ChainService.assertWritable} is the guard the
   * write paths use.
   *
   * @returns {Promise<ChainStatus>} The recorded status.
   */
  async function init() {
    if (!enabled) {
      status = { ...status, status: 'disabled', checkedAt: new Date(now()).toISOString() };
      return status;
    }

    /** @type {Record<string, ContractCheck>} */
    const contracts = {};
    let reachable = false;
    /** @type {number|null} */
    let chainId = null;
    /** @type {number|null} */
    let blockNumber = null;
    /** @type {{code: string, message: string}|null} */
    let error = null;

    try {
      const net = await withRpc('eth_chainId', async ({ provider }) => provider.getNetwork());
      chainId = Number(net.chainId);
      reachable = true;
      blockNumber = await withRpc('eth_blockNumber', async ({ provider }) =>
        provider.getBlockNumber(),
      );
    } catch (err) {
      error = describe(err);
      log.warn?.({ err: error }, 'chain unreachable at init');
    }

    if (reachable && chainId !== config.chain.chainId) {
      // Not fatal, deliberately. A node pointed at the wrong network should say so loudly and refuse
      // to write, but crashing takes the dashboard down too and tells an operator less than a status
      // line naming both numbers does.
      error = {
        code: 'chain_id_mismatch',
        message:
          `The RPC endpoint reports chain ${chainId} but this node is configured for ` +
          `${config.chain.chainId}. Every address in the deployment record belongs to the ` +
          'configured chain, so no write can be correct until one of the two is changed.',
      };
      log.error?.({ reported: chainId, expected: config.chain.chainId }, 'chain id mismatch');
    }

    if (reachable && !error) {
      for (const name of CONTRACT_NAMES) {
        contracts[name] = await checkContract(name);
      }
    }

    const configured = Object.values(contracts).filter((c) => c.configured);
    // `skipped` counts as compatible; `absent` and `mismatch` do not. ReputationManager legitimately
    // exposes no typehash getter and no EIP-712 domain, so demanding a positive `match` from every
    // contract would make a correct deployment look broken - the exact boot-check bug this service
    // is written to avoid. `absent` is different: it means the getter *should* be there and is not.
    const proven = (verdict) => verdict === 'match' || verdict === 'skipped';
    const compatible =
      reachable &&
      !error &&
      configured.length > 0 &&
      configured.every((c) => c.hasCode && proven(c.typehashes) && proven(c.domain));

    status = {
      status: !reachable ? 'down' : compatible ? 'ready' : 'degraded',
      reachable,
      chainId,
      expectedChainId: config.chain.chainId,
      blockNumber,
      contractsCompatible: compatible,
      contracts,
      checkedAt: new Date(now()).toISOString(),
      error,
    };

    if (reachable && !compatible) {
      log.warn?.(
        { contracts: summarizeChecks(contracts) },
        'contracts are not provably compatible with this build; the node is read-only for writes ' +
          'but continues to serve every read-only route',
      );
    }

    if (config.signer.configured) {
      try {
        const address = signer().address;
        signerAddress = address;
        const bal = reachable ? await balance() : null;
        log.info?.(
          { address, chainId, balanceWei: bal, contractsCompatible: compatible },
          'chain signer ready',
        );
      } catch (err) {
        log.error?.({ err: describe(err) }, 'signer could not be constructed');
      }
    }

    return status;
  }

  /**
   * Probe one contract: bytecode, build fingerprint, typehashes, EIP-712 domain.
   *
   * @param {string} name Contract name.
   * @returns {Promise<ContractCheck>} The check result.
   */
  async function checkContract(name) {
    const address = config.chain.addresses[ADDRESS_KEY[name]] ?? null;
    /** @type {ContractCheck} */
    const check = {
      name,
      address,
      configured: address !== null,
      hasCode: false,
      codeSize: 0,
      bytecode: 'unknown',
      typehashes: 'skipped',
      domain: 'skipped',
      reason: null,
    };
    if (!address) {
      check.reason =
        `No address is configured for ${name}. It is treated as disabled rather than down: a node ` +
        'without a MemoryAccessControl deployment can still commit and read memories.';
      return check;
    }

    /** @type {string} */
    let code;
    try {
      code = await withRpc(`${name}.getCode`, async ({ provider }) => provider.getCode(address));
    } catch (err) {
      check.reason = describe(err).message;
      return check;
    }

    check.codeSize = Math.max(0, (code.length - 2) / 2);
    check.hasCode = code !== '0x' && check.codeSize > 0;
    if (!check.hasCode) {
      check.reason =
        `There is no contract at ${address} on chain ${config.chain.chainId}. The deployment ` +
        'record points at an address with no bytecode, which is what a deploy against a different ' +
        'network looks like from here.';
      return check;
    }

    check.bytecode =
      canonical.sha256Hex(hexToBytes(code)) === DEPLOYED_BYTECODE_HASHES[name]
        ? 'match'
        : 'unknown';

    const getters = TYPEHASH_GETTERS[name] ?? [];
    if (getters.length === 0) {
      check.typehashes = 'skipped';
    } else {
      check.typehashes = 'match';
      for (const getter of getters) {
        const expected = EXPECTED_TYPEHASHES[name]?.[getter] ?? null;
        try {
          const actual = await withRpc(`${name}.${getter}`, async ({ contracts }) =>
            contracts[name][getter](),
          );
          if (expected && String(actual).toLowerCase() !== expected.toLowerCase()) {
            check.typehashes = 'mismatch';
            check.reason =
              `${name}.${getter}() returned ${actual}, but this build signs ${expected}. Every ` +
              'signature produced against this deployment would be rejected on chain.';
            break;
          }
        } catch {
          // The v1 deployment has no typehash getters at all, so the call reverts. That is the
          // clean, decisive signal that the address belongs to a different contract version.
          check.typehashes = 'absent';
          check.reason =
            `${name}.${getter}() reverted or does not exist at ${address}. This is an older ` +
            'deployment that predates the EIP-712 entrypoints this backend uses.';
          break;
        }
      }
    }

    const expectedDomain = EXPECTED_DOMAINS[name];
    if (!SUPPORTS_EIP712[name] || !expectedDomain) {
      // ReputationManager has no EIP712 mixin. Probing it uniformly would revert and make a correct
      // deployment look broken, which is exactly the boot-check bug the critique flagged.
      check.domain = 'skipped';
      return check;
    }
    try {
      const result = await withRpc(`${name}.eip712Domain`, async ({ contracts }) =>
        contracts[name].eip712Domain(),
      );
      const okName = result[1] === expectedDomain.name;
      const okVersion = result[2] === expectedDomain.version;
      const okChain = Number(result[3]) === config.chain.chainId;
      const okVerifying = String(result[4]).toLowerCase() === address.toLowerCase();
      if (okName && okVersion && okChain && okVerifying) {
        check.domain = 'match';
      } else {
        check.domain = 'mismatch';
        check.reason =
          `${name} declares EIP-712 domain (${result[1]}, ${result[2]}, chainId ${result[3]}, ` +
          `verifyingContract ${result[4]}); this build signs (${expectedDomain.name}, ` +
          `${expectedDomain.version}, chainId ${config.chain.chainId}, verifyingContract ${address}).`;
      }
    } catch {
      check.domain = 'absent';
      check.reason ??= `${name}.eip712Domain() reverted at ${address}; this deployment does not implement ERC-5267.`;
    }
    return check;
  }

  /* ---------------------------------------------------------------------- */
  /* Signer                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * The wallet, built on first use.
   *
   * @returns {any} The signer.
   * @throws {import('../errors.js').AppError} 503 `read_only` when no key is configured.
   */
  function signer() {
    if (!config.signer.privateKey) {
      throw errors.readOnly();
    }
    if (!wallet) {
      const provider = enabled ? providerAt(activeIndex) : null;
      wallet = walletFactory
        ? walletFactory(config.signer.privateKey, provider)
        : new Wallet(config.signer.privateKey, provider);
      signerAddress = wallet.address;
    }
    return wallet;
  }

  /**
   * This node's agent address, or `null` on a read-only node.
   *
   * Never throws: it is called from status and readiness paths where "no signer" is an answer, not
   * an error.
   *
   * @returns {string|null} Checksummed address.
   */
  function address() {
    if (signerAddress) return signerAddress;
    if (!config.signer.configured) return null;
    try {
      return signer().address;
    } catch {
      /* c8 ignore next -- unreachable: config.signer.configured implies a key */
      return null;
    }
  }

  /**
   * The signer's balance in wei, as a decimal string.
   *
   * @returns {Promise<string>} Balance in wei.
   */
  async function balance() {
    const addr = address();
    if (!addr) throw errors.readOnly();
    const value = await withRpc('eth_getBalance', async ({ provider }) =>
      provider.getBalance(addr),
    );
    return value.toString();
  }

  /**
   * Guard for every path that would spend gas.
   *
   * The three refusals are deliberately distinct, because they need different operator actions:
   * a missing key is a configuration change, an unreachable RPC is an outage, and an incompatible
   * deployment is a redeploy.
   *
   * @returns {void}
   * @throws {import('../errors.js').AppError} 503 when this node must not write.
   */
  function assertWritable() {
    if (!enabled) throw errors.chainUnavailable('No RPC endpoint is configured on this node.');
    if (!config.signer.configured) throw errors.readOnly();
    if (!status.reachable) {
      throw errors.chainUnavailable(
        status.error?.message ?? 'The configured RPC endpoint is not reachable.',
      );
    }
    if (!status.contractsCompatible) {
      throw errors.contractsIncompatible(
        'The contracts at the configured addresses cannot be proven to match this build, so ' +
          'signing a transaction against them would produce a signature the chain rejects (or, ' +
          'worse, a call decoded against the wrong ABI). Reads continue to work. Redeploy and ' +
          'regenerate the deployment record to restore writes.',
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Reads                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Call one view function on one contract.
   *
   * @param {string} name Contract name.
   * @param {string} method Function name.
   * @param {unknown[]} [args] Arguments.
   * @returns {Promise<any>} The decoded result.
   */
  function read(name, method, args = []) {
    return withRpc(`${name}.${method}`, async ({ contracts }) => {
      const contract = contracts[name];
      if (!contract) {
        throw errors.chainUnavailable(
          `${name} has no configured address on this node, so ${method}() cannot be called.`,
        );
      }
      return contract[method](...args);
    });
  }

  /** Typed reads against `AgentIdentity`. */
  const readIdentity = {
    /**
     * @param {string} account Agent address.
     * @returns {Promise<{registeredAt: number, statusChangedAt: number, keyVersion: number,
     *   active: boolean, exists: boolean, publicKey: string, metadataURI: string}>} The record.
     */
    async getAgent(account) {
      const row = await read('AgentIdentity', 'getAgent', [assertAddress(account, 'account')]);
      return {
        registeredAt: Number(row.registeredAt ?? row[0]),
        statusChangedAt: Number(row.statusChangedAt ?? row[1]),
        keyVersion: Number(row.keyVersion ?? row[2]),
        active: Boolean(row.active ?? row[3]),
        exists: Boolean(row.exists ?? row[4]),
        publicKey: String(row.publicKey ?? row[5]),
        metadataURI: String(row.metadataURI ?? row[6]),
      };
    },
    /**
     * @param {string} account Agent address.
     * @returns {Promise<{publicKey: string, keyVersion: number}>} The encryption public key.
     */
    async getPublicKey(account) {
      const row = await read('AgentIdentity', 'getPublicKey', [assertAddress(account, 'account')]);
      return { publicKey: String(row[0]), keyVersion: Number(row[1]) };
    },
    /**
     * @param {string} account Agent address.
     * @returns {Promise<boolean>} Whether the agent exists.
     */
    isRegistered: (account) =>
      read('AgentIdentity', 'isRegistered', [assertAddress(account, 'account')]).then(Boolean),
    /**
     * @param {string} account Agent address.
     * @returns {Promise<boolean>} Whether the agent is registered and active.
     */
    isActive: (account) =>
      read('AgentIdentity', 'isActive', [assertAddress(account, 'account')]).then(Boolean),
    /**
     * @param {string} owner Agent address.
     * @returns {Promise<string>} The identity nonce, as a decimal string.
     */
    nonces: (owner) =>
      read('AgentIdentity', 'nonces', [assertAddress(owner, 'owner')]).then(String),
    /**
     * @returns {Promise<number>} Total registered agents.
     */
    totalAgents: () => read('AgentIdentity', 'totalAgents').then(Number),
    /**
     * @param {number} offset Page offset.
     * @param {number} limit Page size.
     * @returns {Promise<{page: string[], total: number}>} One page of agent addresses.
     */
    async getAgents(offset, limit) {
      const row = await read('AgentIdentity', 'getAgents', [offset, limit]);
      return { page: [...row[0]].map(String), total: Number(row[1]) };
    },
  };

  /** Typed reads against `MemoryLedger`. */
  const readLedger = {
    /**
     * @param {string} cid CID string.
     * @returns {Promise<string>} `keccak256(bytes(cid))`, computed on chain.
     */
    cidHashOf: (cid) => read('MemoryLedger', 'cidHashOf', [cid]).then(String),
    /**
     * @param {string} cidHash bytes32 key.
     * @returns {Promise<boolean>} Whether a record exists.
     */
    exists: (cidHash) => read('MemoryLedger', 'exists', [cidHash]).then(Boolean),
    /**
     * @param {string} cidHash bytes32 key.
     * @returns {Promise<MemoryRecord>} The normalized record.
     */
    getMemory: (cidHash) => read('MemoryLedger', 'getMemory', [cidHash]).then(normalizeMemory),
    /**
     * @param {string} cid CID string.
     * @returns {Promise<MemoryRecord>} The normalized record.
     */
    getMemoryByCid: (cid) => read('MemoryLedger', 'getMemoryByCid', [cid]).then(normalizeMemory),
    /**
     * `verifyMemory` gained a trailing `bool revoked` in the rewritten contract. A hand-written ABI
     * missing that field decodes without complaint and silently reports every revoked memory as
     * live, which is why no ABI in this repository is hand-written.
     *
     * @param {string} cid CID string.
     * @returns {Promise<{owner: string, committedAt: number, isEncrypted: boolean,
     *   embeddingDim: number, model: string, revoked: boolean}>} The verification tuple.
     */
    async verifyMemory(cid) {
      const row = await read('MemoryLedger', 'verifyMemory', [cid]);
      return {
        owner: String(row[0]),
        committedAt: Number(row[1]),
        isEncrypted: Boolean(row[2]),
        embeddingDim: Number(row[3]),
        model: String(row[4]),
        revoked: Boolean(row[5]),
      };
    },
    /**
     * @param {string} owner Owner address.
     * @param {number} offset Page offset.
     * @param {number} limit Page size.
     * @returns {Promise<{page: string[], total: number}>} One page of cid hashes.
     */
    async getOwnerMemories(owner, offset, limit) {
      const row = await read('MemoryLedger', 'getOwnerMemories', [
        assertAddress(owner, 'owner'),
        offset,
        limit,
      ]);
      return { page: [...row[0]].map(String), total: Number(row[1]) };
    },
    /**
     * @param {string} owner Owner address.
     * @param {number} offset Page offset.
     * @param {number} limit Page size.
     * @returns {Promise<{page: MemoryRecord[], total: number}>} One page of full records.
     */
    async getOwnerMemoryRecords(owner, offset, limit) {
      const row = await read('MemoryLedger', 'getOwnerMemoryRecords', [
        assertAddress(owner, 'owner'),
        offset,
        limit,
      ]);
      return { page: [...row[0]].map(normalizeMemory), total: Number(row[1]) };
    },
    /**
     * @param {string} owner Owner address.
     * @returns {Promise<number>} Number of records owned.
     */
    getOwnerMemoryCount: (owner) =>
      read('MemoryLedger', 'getOwnerMemoryCount', [assertAddress(owner, 'owner')]).then(Number),
    /**
     * @returns {Promise<number>} Total records ever committed.
     */
    totalMemoryCount: () => read('MemoryLedger', 'totalMemoryCount').then(Number),
    /**
     * @returns {Promise<number>} Total records revoked.
     */
    totalRevokedCount: () => read('MemoryLedger', 'totalRevokedCount').then(Number),
    /**
     * @param {string} owner Agent address.
     * @returns {Promise<string>} The ledger nonce, as a decimal string.
     */
    nonces: (owner) => read('MemoryLedger', 'nonces', [assertAddress(owner, 'owner')]).then(String),
    /**
     * The contract's own EIP-712 digest for a commit.
     *
     * This exists so the backend can prove byte-equality between what it signs and what the chain
     * verifies, rather than assuming its transcription of the typehash is right.
     *
     * @param {string} agent Agent address.
     * @param {{cid: string, prevCidHash: string, model: string, embeddingDim: number,
     *   isEncrypted: boolean}} input The `MemoryInput` tuple.
     * @param {string|number|bigint} nonce Current ledger nonce.
     * @param {number|bigint} deadline Unix seconds.
     * @returns {Promise<string>} bytes32 digest.
     */
    hashCommit: (agent, input, nonce, deadline) =>
      read('MemoryLedger', 'hashCommit', [
        assertAddress(agent, 'agent'),
        [input.cid, input.prevCidHash, input.model, input.embeddingDim, input.isEncrypted],
        BigInt(nonce),
        BigInt(deadline),
      ]).then(String),
  };

  /** Typed reads against `ReputationManager`. All WAD values stay in WAD; see the module header. */
  const readReputation = {
    /**
     * @param {string} account Agent address.
     * @returns {Promise<string>} Reputation in WAD, as a decimal string.
     */
    reputationOf: (account) =>
      read('ReputationManager', 'reputationOf', [assertAddress(account, 'account')]).then(String),
    /**
     * @param {string} account Agent address.
     * @returns {Promise<number>} Reputation in basis points (0..10000).
     */
    reputationBps: (account) =>
      read('ReputationManager', 'reputationBps', [assertAddress(account, 'account')]).then(Number),
    /**
     * @param {string} account Agent address.
     * @returns {Promise<boolean>} Whether the score is at or above the trust threshold.
     */
    isTrusted: (account) =>
      read('ReputationManager', 'isTrusted', [assertAddress(account, 'account')]).then(Boolean),
    /**
     * @param {string} account Agent address.
     * @returns {Promise<number>} Distinct endorsers.
     */
    endorserCount: (account) =>
      read('ReputationManager', 'endorserCount', [assertAddress(account, 'account')]).then(Number),
    /**
     * @param {string} account Agent address.
     * @returns {Promise<number>} Distinct reporters.
     */
    reporterCount: (account) =>
      read('ReputationManager', 'reporterCount', [assertAddress(account, 'account')]).then(Number),
    /**
     * @param {string} from Endorser.
     * @param {string} to Target.
     * @returns {Promise<boolean>} Whether an unrevoked endorsement exists.
     */
    hasActiveEndorsement: (from, to) =>
      read('ReputationManager', 'hasActiveEndorsement', [
        assertAddress(from, 'from'),
        assertAddress(to, 'to'),
      ]).then(Boolean),
    /**
     * @param {string} from Reporter.
     * @param {string} to Target.
     * @returns {Promise<boolean>} Whether an unwithdrawn report exists.
     */
    hasActiveReport: (from, to) =>
      read('ReputationManager', 'hasActiveReport', [
        assertAddress(from, 'from'),
        assertAddress(to, 'to'),
      ]).then(Boolean),
    /**
     * @param {string} endorser Prospective endorser.
     * @returns {Promise<string>} The weight this endorser would contribute, in WAD.
     */
    previewEndorsementWeight: (endorser) =>
      read('ReputationManager', 'previewEndorsementWeight', [
        assertAddress(endorser, 'endorser'),
      ]).then(String),
    /**
     * @param {number} offset Page offset.
     * @param {number} limit Page size.
     * @returns {Promise<{page: TrustEventRow[], total: number}>} One page of the ring buffer.
     */
    async getTrustEvents(offset, limit) {
      const row = await read('ReputationManager', 'getTrustEvents', [offset, limit]);
      return {
        page: [...row[0]].map((event, index) => ({
          index: offset + index,
          from: String(event.from ?? event[0]),
          kind: Number(event.kind ?? event[1]),
          timestamp: Number(event.timestamp ?? event[2]),
          to: String(event.to ?? event[3]),
          weightWad: String(event.weight ?? event[4]),
          reasonHash: String(event.reasonHash ?? event[5]),
        })),
        total: Number(row[1]),
      };
    },
    /**
     * @returns {Promise<number>} Entries currently in the ring buffer.
     */
    getTrustLogLength: () => read('ReputationManager', 'getTrustLogLength').then(Number),
    /**
     * @returns {Promise<number>} Trust events ever recorded (may exceed the ring capacity).
     */
    trustEventCount: () => read('ReputationManager', 'trustEventCount').then(Number),
    /**
     * The tunable parameters, read from the contract rather than hardcoded - a hardcoded stake is
     * how an endorsement gets rejected for underpayment after the gas has been spent.
     *
     * @returns {Promise<{endorsementStakeWei: string, trustThresholdWad: string,
     *   endorseCooldown: number, reportCooldown: number, actorCooldown: number,
     *   halfLifeSeconds: number, priorWad: string, negativeMultiplierWad: string}>} Parameters.
     */
    async parameters() {
      const [
        stake,
        threshold,
        endorseCooldown,
        reportCooldown,
        actorCooldown,
        halfLife,
        prior,
        negative,
      ] = await Promise.all([
        read('ReputationManager', 'endorsementStakeWei'),
        read('ReputationManager', 'trustThresholdWad'),
        read('ReputationManager', 'endorseCooldown'),
        read('ReputationManager', 'reportCooldown'),
        read('ReputationManager', 'actorCooldown'),
        read('ReputationManager', 'halfLifeSeconds'),
        read('ReputationManager', 'priorWad'),
        read('ReputationManager', 'negativeMultiplierWad'),
      ]);
      return {
        endorsementStakeWei: String(stake),
        trustThresholdWad: String(threshold),
        endorseCooldown: Number(endorseCooldown),
        reportCooldown: Number(reportCooldown),
        actorCooldown: Number(actorCooldown),
        halfLifeSeconds: Number(halfLife),
        priorWad: String(prior),
        negativeMultiplierWad: String(negative),
      };
    },
  };

  /** Typed reads against `MemoryAccessControl`. */
  const readAccess = {
    /**
     * @param {string} cidHash bytes32 memory key.
     * @param {string} account Candidate reader.
     * @returns {Promise<boolean>} Whether the account holds a live grant.
     */
    canAccess: (cidHash, account) =>
      read('MemoryAccessControl', 'canAccess', [cidHash, assertAddress(account, 'account')]).then(
        Boolean,
      ),
    /**
     * @param {string} cidHash bytes32 memory key.
     * @param {string} grantee Grantee address.
     * @returns {Promise<{wrappedKey: string, keyVersion: number}>} The stored wrapped key.
     */
    async getWrappedKey(cidHash, grantee) {
      const row = await read('MemoryAccessControl', 'getWrappedKey', [
        cidHash,
        assertAddress(grantee, 'grantee'),
      ]);
      return { wrappedKey: String(row[0]), keyVersion: Number(row[1]) };
    },
    /**
     * @param {string} cidHash bytes32 memory key.
     * @param {number} offset Page offset.
     * @param {number} limit Page size.
     * @returns {Promise<{page: string[], total: number}>} One page of grantees.
     */
    async getGrantees(cidHash, offset, limit) {
      const row = await read('MemoryAccessControl', 'getGrantees', [cidHash, offset, limit]);
      return { page: [...row[0]].map(String), total: Number(row[1]) };
    },
    /**
     * @param {string} owner Agent address.
     * @returns {Promise<string>} The access-control nonce, as a decimal string.
     */
    nonces: (owner) =>
      read('MemoryAccessControl', 'nonces', [assertAddress(owner, 'owner')]).then(String),
  };

  /* ---------------------------------------------------------------------- */
  /* EIP-712 signing                                                         */
  /* ---------------------------------------------------------------------- */

  /**
   * Sign a `MemoryCommit`, cross-checking the digest against the contract's own `hashCommit`.
   *
   * The cross-check is the runtime guard against ABI or typehash drift. `hashCommit` exists on the
   * ledger precisely so an off-chain signer can prove its transcription is right *before* it signs;
   * skipping it would mean discovering a mismatch as a revert the user paid for. When the chain is
   * unreachable the check is skipped and reported as skipped, never silently passed.
   *
   * @param {object} args Arguments.
   * @param {string} args.cid CID string exactly as it will be stored.
   * @param {string} args.prevCidHash bytes32 parent key, or 32 zero bytes.
   * @param {string} args.model Model string exactly as it will be stored.
   * @param {number} args.embeddingDim Declared dimension.
   * @param {boolean} args.isEncrypted Whether the context is sealed.
   * @param {number} args.deadline Unix seconds.
   * @param {string|number|bigint} [args.nonce] Ledger nonce; read from chain when omitted.
   * @returns {Promise<{signature: string, digest: string, nonce: string, deadline: number,
   *   agent: string, crossChecked: boolean}>} The signature and what it covers.
   */
  async function signMemoryCommit({
    cid,
    prevCidHash,
    model,
    embeddingDim,
    isEncrypted,
    deadline,
    nonce,
  }) {
    const agent = address();
    if (!agent) throw errors.readOnly();
    const ledgerAddress = config.chain.addresses.ledger;
    if (!ledgerAddress) {
      throw errors.chainUnavailable('No MemoryLedger address is configured on this node.');
    }
    const resolvedNonce = nonce ?? (await readLedger.nonces(agent));
    const typed = eip712.buildMemoryCommit({
      agent,
      chainId: config.chain.chainId,
      ledger: ledgerAddress,
      cid,
      prevCidHash,
      model,
      embeddingDim,
      isEncrypted,
      nonce: BigInt(resolvedNonce),
      deadline,
    });
    const localDigest = eip712.digest(typed);

    let crossChecked = false;
    if (status.reachable) {
      const onchain = await readLedger.hashCommit(
        agent,
        { cid, prevCidHash, model, embeddingDim, isEncrypted },
        resolvedNonce,
        deadline,
      );
      if (onchain.toLowerCase() !== localDigest.toLowerCase()) {
        throw errors.conflict(
          'The locally computed EIP-712 digest does not match MemoryLedger.hashCommit(). The ' +
            'deployed struct definition differs from the one this build signs, so the signature ' +
            'would be rejected on chain. Aborting before anything irreversible happens.',
          { local: localDigest, onchain },
        );
      }
      crossChecked = true;
    }

    const signature = await eip712.signTypedData(signer(), typed);
    return {
      signature,
      digest: localDigest,
      nonce: String(resolvedNonce),
      deadline,
      agent,
      crossChecked,
    };
  }

  /**
   * Sign a `Registration` for `AgentIdentity.registerAgentFor`.
   *
   * @param {object} args Arguments.
   * @param {string} args.publicKey 0x-hex encryption public key bytes.
   * @param {string} args.metadataURI Metadata URI string.
   * @param {number} args.deadline Unix seconds.
   * @param {string|number|bigint} [args.nonce] Identity nonce; read from chain when omitted.
   * @returns {Promise<{signature: string, digest: string, nonce: string, deadline: number,
   *   agent: string}>} The signature and what it covers.
   */
  async function signRegistration({ publicKey, metadataURI, deadline, nonce }) {
    const agent = address();
    if (!agent) throw errors.readOnly();
    const identityAddress = config.chain.addresses.identity;
    if (!identityAddress) {
      throw errors.chainUnavailable('No AgentIdentity address is configured on this node.');
    }
    const resolvedNonce = nonce ?? (await readIdentity.nonces(agent));
    const typed = eip712.buildRegistration({
      agent,
      chainId: config.chain.chainId,
      identity: identityAddress,
      publicKey,
      metadataURI,
      nonce: BigInt(resolvedNonce),
      deadline,
    });
    const signature = await eip712.signTypedData(signer(), typed);
    return {
      signature,
      digest: eip712.digest(typed),
      nonce: String(resolvedNonce),
      deadline,
      agent,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Transactions                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Locally tracked next nonce. `null` until the first submission seeds it from the chain.
   *
   * @type {bigint|null}
   */
  let nextNonce = null;

  /**
   * Reserve a nonce.
   *
   * Reservation and the read it derives from happen in one synchronous step, so no `await` can
   * interleave between "what is the next nonce" and "that one is now taken". The provider's pending
   * count only ever *raises* the local counter: it is a floor, never an override, because a lagging
   * `eth_getTransactionCount` would otherwise hand a second caller a nonce that is already in use.
   *
   * @param {bigint} pending The provider's pending transaction count.
   * @returns {bigint} The nonce this transaction owns.
   */
  function reserveNonce(pending) {
    const nonce = nextNonce === null || pending > nextNonce ? pending : nextNonce;
    nextNonce = nonce + 1n;
    return nonce;
  }

  /**
   * Give a reserved nonce back, when the transaction was never broadcast.
   *
   * Only the most recent reservation can be released, and only if nothing has reserved after it -
   * otherwise releasing would create a gap that stalls every later transaction from this signer.
   *
   * @param {bigint} nonce The nonce to release.
   * @returns {void}
   */
  function releaseNonce(nonce) {
    if (nextNonce === nonce + 1n) nextNonce = nonce;
  }
  let queueDepth = 0;
  let txInflight = 0;
  let accepting = true;
  /** @type {Promise<unknown>} */
  let txTail = Promise.resolve();

  /**
   * Submit one transaction.
   *
   * Exactly one transaction is in flight per signer, enforced by a promise chain rather than a
   * counter: nonce assignment and broadcast must be atomic with respect to each other, and a
   * semaphore released across an `await` boundary can be acquired twice under the right
   * interleaving.
   *
   * The order of the preflight steps is load-bearing. `estimateGas` runs *before* the balance check
   * so a transaction that would revert is rejected as a 400 rather than costing gas; the balance
   * check runs before broadcast so an unfunded node answers `503 insufficient_funds` with the exact
   * shortfall instead of an opaque ethers failure.
   *
   * @param {TxDescriptor} descriptor What to send.
   * @returns {Promise<TxResult>} The outcome, including the hash even on a confirmation timeout.
   */
  function submit(descriptor) {
    assertWritable();
    if (!accepting) {
      throw errors.chainUnavailable(
        'This node is shutting down and is not accepting transactions.',
      );
    }
    if (queueDepth + txInflight >= config.chain.txQueueMax) {
      instruments.increment('neuromesh_tx_shed_total', { label: descriptor.label });
      throw errors.overloaded({ queue: 'transactions', max: config.chain.txQueueMax });
    }
    queueDepth += 1;
    instruments.gauge('neuromesh_tx_queue_depth', queueDepth + txInflight);
    const run = txTail.then(
      () => runTx(descriptor),
      () => runTx(descriptor),
    );
    txTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * The body of one transaction, already serialized by {@link submit}.
   *
   * @param {TxDescriptor} descriptor What to send.
   * @returns {Promise<TxResult>} The outcome.
   */
  async function runTx(descriptor) {
    queueDepth -= 1;
    txInflight += 1;
    const started = now();
    const label = descriptor.label;
    try {
      return await sendOnce(descriptor, false);
    } catch (err) {
      if (NONCE_CODES.has(String(/** @type {any} */ (err)?.chainCode ?? ''))) {
        // The local counter is stale (an external transaction from the same key, or a restart with
        // a pending transaction). Resync from the chain and try exactly once more. Retrying more
        // than once would let a systematically wrong counter produce a broadcast storm.
        log.warn?.({ label }, 'nonce out of sync; resyncing from chain and retrying once');
        nextNonce = null;
        return await sendOnce(descriptor, true);
      }
      instruments.increment('neuromesh_tx_total', { label, status: 'failed' });
      throw err;
    } finally {
      txInflight -= 1;
      instruments.gauge('neuromesh_tx_queue_depth', queueDepth + txInflight);
      instruments.observe('neuromesh_tx_duration_seconds', (now() - started) / 1000, {
        label,
        stage: 'total',
      });
    }
  }

  /**
   * One broadcast attempt: nonce, fees, gas estimate, balance preflight, send, confirm.
   *
   * @param {TxDescriptor} descriptor What to send.
   * @param {boolean} isRetry Whether this is the post-resync attempt.
   * @returns {Promise<TxResult>} The outcome.
   */
  async function sendOnce(descriptor, isRetry) {
    const {
      label,
      contract: contractName,
      method,
      args = [],
      value = 0n,
      confirmations = config.chain.confirmations,
      onHash,
      gasLimitHint,
    } = descriptor;

    const from = /** @type {string} */ (address());
    const wallet_ = signer();
    const contracts = contractsAt(activeIndex);
    const base = contracts[contractName];
    if (!base) {
      throw errors.chainUnavailable(
        `${contractName} has no configured address on this node, so ${method}() cannot be sent.`,
      );
    }
    const bound = base.connect(wallet_);
    const valueWei = BigInt(value);

    // (1) Nonce. The local counter is authoritative once seeded, so two callers can never be handed
    //     the same value even if the provider's pending count lags.
    const pending = BigInt(
      await withRpc('eth_getTransactionCount', async ({ provider }) =>
        provider.getTransactionCount(from, 'pending'),
      ),
    );
    const nonce = reserveNonce(pending);

    // (2) Fees, as integer arithmetic. Multiplying a bigint by a float is a TypeError, and rounding
    //     through Number would lose precision on a large maxFeePerGas.
    const feeData = await withRpc('eth_feeHistory', async ({ provider }) => provider.getFeeData());
    const multiplier = BigInt(Math.round(config.chain.gasMultiplier * 100));
    const maxFeePerGas = feeData.maxFeePerGas ? (feeData.maxFeePerGas * multiplier) / 100n : null;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
      ? (feeData.maxPriorityFeePerGas * multiplier) / 100n
      : null;
    const gasPrice =
      maxFeePerGas ?? (feeData.gasPrice ? (feeData.gasPrice * multiplier) / 100n : 0n);

    // (3) Gas estimate. A revert here means the transaction is doomed; surfacing it as a 400 stops
    //     the node paying for a failure it can see coming.
    const estimateStop = instruments.timer('neuromesh_tx_duration_seconds', {
      label,
      stage: 'estimate',
    });
    /** @type {bigint} */
    let gasLimit;
    try {
      const estimated = gasLimitHint
        ? BigInt(gasLimitHint)
        : BigInt(await bound[method].estimateGas(...args, { value: valueWei }));
      gasLimit = (estimated * GAS_LIMIT_MARGIN_PCT) / 100n;
    } catch (err) {
      estimateStop({ status: 'revert' });
      releaseNonce(nonce);
      throw mapEstimateError(err, label, method);
    }
    estimateStop({ status: 'ok' });

    // (4) Balance preflight. Cheap, exact, and the difference between a clear 503 and an ethers
    //     stack trace the operator has to decode.
    const have = BigInt(
      await withRpc('eth_getBalance', async ({ provider }) => provider.getBalance(from)),
    );
    const need = gasLimit * gasPrice + valueWei;
    if (have < need) {
      releaseNonce(nonce);
      throw errors.insufficientFunds({
        have: have.toString(),
        need: need.toString(),
        shortfall: (need - have).toString(),
        address: from,
      });
    }

    // (5) Broadcast, and report the hash before confirmation so a job can show it immediately.
    const broadcastStop = instruments.timer('neuromesh_tx_duration_seconds', {
      label,
      stage: 'broadcast',
    });
    /** @type {any} */
    let sent;
    try {
      /** @type {Record<string, any>} */
      const overrides = { nonce: Number(nonce), gasLimit, value: valueWei };
      if (maxFeePerGas && maxPriorityFeePerGas) {
        overrides.maxFeePerGas = maxFeePerGas;
        overrides.maxPriorityFeePerGas = maxPriorityFeePerGas;
      }
      sent = await bound[method](...args, overrides);
    } catch (err) {
      broadcastStop({ status: 'error' });
      // The transaction never reached the network, so its nonce is free again. Leaving it reserved
      // would open a gap that stalls every later transaction from this signer.
      releaseNonce(nonce);
      const mapped = mapChainError(err, `${label}.broadcast`);
      /** @type {any} */ (mapped).chainCode = /** @type {any} */ (err)?.code;
      throw mapped;
    }
    broadcastStop({ status: 'ok' });
    const hash = String(sent.hash);
    try {
      onHash?.(hash);
    } catch {
      // A caller's callback must not turn a broadcast transaction into a failed one; the hash is
      // already on the network and losing it here is strictly worse than losing the notification.
    }

    // (6) Confirm, always with a deadline.
    const confirmStop = instruments.timer('neuromesh_tx_duration_seconds', {
      label,
      stage: 'confirm',
    });
    const outcome = await waitForTx(hash, {
      confirmations,
      timeoutMs: descriptor.timeoutMs ?? config.chain.txTimeoutMs,
    });
    confirmStop({ status: outcome.status });
    instruments.increment('neuromesh_tx_total', { label, status: outcome.status });
    if (outcome.gasUsed) instruments.observe('neuromesh_tx_gas_used', Number(outcome.gasUsed));

    if (outcome.status === 'timeout') {
      // The nonce is NOT reused. A transaction that has been broadcast may still confirm; reusing
      // its nonce is how a node double-spends. The hash is logged so an operator can resolve it.
      log.warn?.(
        { hash, label, nonce: nonce.toString() },
        'transaction not confirmed within the budget; it may still land. The nonce is not reused.',
      );
    }
    if (outcome.status === 'reverted') {
      throw errors.upstream(`Transaction ${hash} reverted on chain.`, {
        hash,
        label,
        blockNumber: outcome.blockNumber,
      });
    }

    return {
      status: outcome.status,
      hash,
      nonce: nonce.toString(),
      blockNumber: outcome.blockNumber,
      gasUsed: outcome.gasUsed,
      effectiveGasPrice: outcome.effectiveGasPrice,
      explorerUrl: `${config.chain.explorerBaseUrl.replace(/\/$/, '')}/tx/${hash}`,
      retried: isRetry,
      confirmations,
    };
  }

  /**
   * Wait for a transaction, with an explicit deadline.
   *
   * A timeout is a *state*, not an exception. Throwing here would discard the hash, and the hash is
   * the only thing that lets anyone find out what actually happened.
   *
   * @param {string} hash Transaction hash.
   * @param {{confirmations?: number, timeoutMs?: number}} [options] Options.
   * @returns {Promise<{status: 'confirmed'|'timeout'|'reverted', receipt: any,
   *   blockNumber: number|null, gasUsed: string|null, effectiveGasPrice: string|null}>} Outcome.
   */
  async function waitForTx(hash, options = {}) {
    const confirmations = options.confirmations ?? config.chain.confirmations;
    const timeoutMs = options.timeoutMs ?? config.chain.txTimeoutMs;
    /** @type {any} */
    let receipt;
    try {
      receipt = await withDeadline(
        providerAt(activeIndex).waitForTransaction(hash, confirmations, timeoutMs),
        timeoutMs + 1000,
        () => errors.upstreamTimeout(`Waiting for ${hash} exceeded ${timeoutMs} ms.`),
      );
    } catch {
      receipt = null;
    }
    if (!receipt) {
      return {
        status: /** @type {const} */ ('timeout'),
        receipt: null,
        blockNumber: null,
        gasUsed: null,
        effectiveGasPrice: null,
      };
    }
    return {
      status: Number(receipt.status) === 1 ? 'confirmed' : 'reverted',
      receipt,
      blockNumber: receipt.blockNumber == null ? null : Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed == null ? null : String(receipt.gasUsed),
      effectiveGasPrice:
        receipt.gasPrice == null && receipt.effectiveGasPrice == null
          ? null
          : String(receipt.effectiveGasPrice ?? receipt.gasPrice),
    };
  }

  /**
   * Stop accepting work and wait for the in-flight transaction.
   *
   * @param {number} [timeoutMs] Budget.
   * @returns {Promise<void>} Resolves when quiet or the budget expires.
   */
  async function drain(timeoutMs = config.chain.txTimeoutMs) {
    accepting = false;
    await Promise.race([txTail.catch(() => undefined), sleep(timeoutMs)]);
  }

  /* ---------------------------------------------------------------------- */
  /* Health                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Liveness probe against the RPC endpoint, cached for two seconds.
   *
   * The cache is what stops a readiness-probe storm becoming an RPC storm, and the single in-flight
   * promise is what stops ten simultaneous probes becoming ten simultaneous calls.
   *
   * @param {{force?: boolean}} [options] Options.
   * @returns {Promise<{reachable: boolean, chainId: number|null, blockNumber: number|null,
   *   latencyMs: number|null, error: {code: string, message: string}|null}>} The verdict.
   */
  function probe({ force = false } = {}) {
    if (!enabled) {
      return Promise.resolve({
        reachable: false,
        chainId: null,
        blockNumber: null,
        latencyMs: null,
        error: { code: 'no_rpc_url', message: 'No RPC endpoint is configured.' },
      });
    }
    if (!force && probeCache && now() - probeCache.at < 2000) {
      return Promise.resolve(probeCache.value);
    }
    if (probeInflight) return probeInflight;
    const started = now();
    probeInflight = (async () => {
      /** @type {any} */
      let value;
      try {
        const blockNumber = await withRpc('eth_blockNumber', async ({ provider }) =>
          provider.getBlockNumber(),
        );
        value = {
          reachable: true,
          chainId: status.chainId ?? config.chain.chainId,
          blockNumber: Number(blockNumber),
          latencyMs: now() - started,
          error: null,
        };
      } catch (err) {
        value = {
          reachable: false,
          chainId: null,
          blockNumber: null,
          latencyMs: now() - started,
          error: describe(err),
        };
      }
      probeCache = { at: now(), value };
      probeInflight = null;
      return value;
    })();
    return probeInflight;
  }

  /**
   * The readiness verdict for `/readyz` and the status route.
   *
   * @returns {Promise<{status: 'up'|'degraded'|'down'|'disabled', reachable: boolean,
   *   contractsCompatible: boolean, chainId: number|null, blockNumber: number|null,
   *   writable: boolean, signer: {configured: boolean, address: string|null, balanceWei: string|null,
   *   low: boolean}, contracts: Record<string, ContractCheck>, latency: any,
   *   detail: string|null}>} The verdict.
   */
  async function health() {
    const live = await probe();
    /** @type {string|null} */
    let balanceWei = null;
    if (config.signer.configured && live.reachable) {
      try {
        balanceWei = await balance();
      } catch {
        balanceWei = null;
      }
    }
    const low = balanceWei !== null && BigInt(balanceWei) < MIN_BALANCE_WEI;
    /** @type {boolean} */
    let writable;
    try {
      assertWritable();
      writable = true;
    } catch {
      writable = false;
    }
    const state = !enabled
      ? /** @type {const} */ ('disabled')
      : !live.reachable
        ? /** @type {const} */ ('down')
        : status.contractsCompatible && !low
          ? /** @type {const} */ ('up')
          : /** @type {const} */ ('degraded');
    return {
      status: state,
      reachable: live.reachable,
      contractsCompatible: status.contractsCompatible,
      chainId: live.chainId ?? status.chainId,
      blockNumber: live.blockNumber ?? status.blockNumber,
      writable,
      signer: {
        configured: config.signer.configured,
        address: address(),
        balanceWei,
        low,
      },
      contracts: status.contracts,
      latency: latency.stats(),
      detail:
        status.error?.message ??
        live.error?.message ??
        (status.contractsCompatible
          ? null
          : 'The deployed contracts cannot be proven to match this build; writes are refused and ' +
            'reads continue.'),
    };
  }

  /** @type {ChainService} */
  const service = {
    init,
    enabled,
    provider: () => providerAt(activeIndex),
    signer,
    address,
    contracts: () => contractsAt(activeIndex),
    state: () => status,
    probe,
    health,
    balance,
    assertWritable,
    getBlockNumber: () =>
      withRpc('eth_blockNumber', async ({ provider }) => provider.getBlockNumber()).then(Number),
    readIdentity,
    readLedger,
    readReputation,
    readAccess,
    signMemoryCommit,
    signRegistration,
    submit,
    waitForTx,
    drain,
    queueDepth: () => queueDepth + txInflight,
    async shutdown() {
      await drain(config.chain.txTimeoutMs);
      for (const provider of providerCache.values()) {
        try {
          provider.destroy?.();
        } catch {
          // A provider that cannot be destroyed must not stop the process from exiting.
        }
      }
      providerCache.clear();
      contractCache.clear();
      wallet = null;
    },
  };
  return service;
}

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {object} ContractCheck
 * @property {string} name Contract name.
 * @property {string|null} address Configured address, or `null` when unset.
 * @property {boolean} configured Whether an address is configured at all.
 * @property {boolean} hasCode Whether `eth_getCode` returned bytecode.
 * @property {number} codeSize Deployed bytecode length in bytes.
 * @property {'match'|'unknown'} bytecode Build fingerprint comparison. Evidence, not proof.
 * @property {'match'|'mismatch'|'absent'|'skipped'} typehashes The decisive compatibility signal.
 * @property {'match'|'mismatch'|'absent'|'skipped'} domain ERC-5267 domain comparison.
 * @property {string|null} reason Why the check is not a clean match.
 */

/**
 * @typedef {object} ChainStatus
 * @property {'idle'|'ready'|'degraded'|'down'|'disabled'} status Overall state.
 * @property {boolean} reachable Whether the RPC endpoint answered.
 * @property {number|null} chainId Chain id reported by the endpoint.
 * @property {number} expectedChainId Chain id this node is configured for.
 * @property {number|null} blockNumber Head block at the last check.
 * @property {boolean} contractsCompatible Whether writes are permitted.
 * @property {Record<string, ContractCheck>} contracts Per-contract check results.
 * @property {string|null} checkedAt ISO timestamp of the last `init`.
 * @property {{code: string, message: string}|null} error The blocking failure, if any.
 */

/**
 * @typedef {object} MemoryRecord
 * @property {string} owner Record owner.
 * @property {number} committedAt Block timestamp of the commit.
 * @property {number} embeddingDim Declared embedding dimension.
 * @property {string} prevCidHash Parent key, or 32 zero bytes.
 * @property {string} committedBy Sender that paid for the commit (may differ from `owner`).
 * @property {number} revokedAt Revocation timestamp, or 0.
 * @property {number} version Version index within the parent chain.
 * @property {boolean} isEncrypted Whether the payload's context is sealed.
 * @property {boolean} revoked Whether the record is revoked.
 * @property {string} cid CID string.
 * @property {string} model Model string as committed.
 */

/**
 * @typedef {object} TrustEventRow
 * @property {number} index Position in the ring buffer.
 * @property {string} from Actor.
 * @property {number} kind `TrustEventKind` enum value.
 * @property {number} timestamp Block timestamp.
 * @property {string} to Target.
 * @property {string} weightWad Weight in WAD.
 * @property {string} reasonHash keccak of the reason string.
 */

/**
 * @typedef {object} TxDescriptor
 * @property {string} label Metric and log label, e.g. `memory.commit`.
 * @property {string} contract Contract name.
 * @property {string} method Method name.
 * @property {unknown[]} [args] Arguments.
 * @property {bigint|number|string} [value] Wei to send.
 * @property {number} [confirmations] Confirmations to await.
 * @property {number} [timeoutMs] Confirmation budget.
 * @property {number|bigint} [gasLimitHint] Skip `estimateGas` and use this.
 * @property {(hash: string) => void} [onHash] Called as soon as the hash exists.
 */

/**
 * @typedef {object} TxResult
 * @property {'confirmed'|'timeout'} status Outcome. A revert throws instead.
 * @property {string} hash Transaction hash — present even on a timeout.
 * @property {string} nonce Nonce used.
 * @property {number|null} blockNumber Inclusion block.
 * @property {string|null} gasUsed Gas used.
 * @property {string|null} effectiveGasPrice Effective gas price in wei.
 * @property {string} explorerUrl Block-explorer link.
 * @property {boolean} retried Whether this was the post-nonce-resync attempt.
 * @property {number} confirmations Confirmations awaited.
 */

/**
 * @typedef {object} ChainService
 * @property {() => Promise<ChainStatus>} init Connect and run the compatibility checks.
 * @property {boolean} enabled Whether an RPC endpoint is configured.
 * @property {() => any} provider The active provider.
 * @property {() => any} signer The wallet; throws 503 on a read-only node.
 * @property {() => string|null} address The signer address, or null.
 * @property {() => Record<string, any>} contracts Contract instances bound to the provider.
 * @property {() => ChainStatus} state The last recorded status.
 * @property {(options?: {force?: boolean}) => Promise<any>} probe Cached liveness probe.
 * @property {() => Promise<any>} health The readiness verdict.
 * @property {() => Promise<string>} balance Signer balance in wei.
 * @property {() => void} assertWritable Throws unless this node may spend gas.
 * @property {() => Promise<number>} getBlockNumber Head block.
 * @property {any} readIdentity Typed `AgentIdentity` reads.
 * @property {any} readLedger Typed `MemoryLedger` reads.
 * @property {any} readReputation Typed `ReputationManager` reads.
 * @property {any} readAccess Typed `MemoryAccessControl` reads.
 * @property {(args: any) => Promise<any>} signMemoryCommit Sign a `MemoryCommit`.
 * @property {(args: any) => Promise<any>} signRegistration Sign a `Registration`.
 * @property {(descriptor: TxDescriptor) => Promise<TxResult>} submit Serialized submission.
 * @property {(hash: string, options?: any) => Promise<any>} waitForTx Bounded confirmation wait.
 * @property {(timeoutMs?: number) => Promise<void>} drain Stop accepting and quiesce.
 * @property {() => number} queueDepth Queued plus in-flight transactions.
 * @property {() => Promise<void>} shutdown Drain and release providers.
 */

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Normalize a `MemoryRecord` tuple into a JSON-safe object.
 *
 * ethers v6 returns a `Result` that is both array-like and named-property-addressable. Reading both
 * forms keeps this working against a plain-array test double as well as the real decoder.
 *
 * @param {any} row The decoded tuple.
 * @returns {MemoryRecord} The normalized record.
 */
function normalizeMemory(row) {
  return {
    owner: String(row.owner ?? row[0]),
    committedAt: Number(row.committedAt ?? row[1]),
    embeddingDim: Number(row.embeddingDim ?? row[2]),
    prevCidHash: String(row.prevCidHash ?? row[3]),
    committedBy: String(row.committedBy ?? row[4]),
    revokedAt: Number(row.revokedAt ?? row[5]),
    version: Number(row.version ?? row[6]),
    isEncrypted: Boolean(row.isEncrypted ?? row[7]),
    revoked: Boolean(row.revoked ?? row[8]),
    cid: String(row.cid ?? row[9]),
    model: String(row.model ?? row[10]),
  };
}

/**
 * @param {string} value Candidate address.
 * @param {string} field Field name, for the message.
 * @returns {string} The checksummed address.
 * @throws {import('../errors.js').AppError} 400 when it is not an address.
 */
function assertAddress(value, field) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw errors.badRequest(`"${field}" must be a 20-byte hex address.`, { field });
  }
  return getAddress(value);
}

/**
 * @param {string} hex 0x-prefixed hex.
 * @returns {Uint8Array} Bytes.
 */
function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex'));
}

/**
 * Whether an ethers failure is worth trying another endpoint for.
 *
 * @param {unknown} err The failure.
 * @returns {boolean} True for transport-level failures only.
 */
function isTransient(err) {
  const any = /** @type {any} */ (err);
  if (TRANSIENT_CODES.has(String(any?.code))) return true;
  return any?.status === 504 || any?.code === 'upstream_timeout';
}

/**
 * Translate an ethers failure into the API taxonomy.
 *
 * A `CALL_EXCEPTION` carries a decoded custom error when the ABI knows it, which is the whole reason
 * the ABI is generated rather than transcribed: the Solidity lane uses custom errors exclusively, so
 * without the real ABI every revert would surface as unexplained hex.
 *
 * @param {unknown} err The failure.
 * @param {string} label What was being attempted.
 * @returns {import('../errors.js').AppError} The mapped error.
 */
function mapChainError(err, label) {
  const any = /** @type {any} */ (err);
  if (any?.status && any?.code && any instanceof Error && 'expose' in any) {
    return /** @type {import('../errors.js').AppError} */ (any);
  }
  const code = String(any?.code ?? '');
  if (code === 'INSUFFICIENT_FUNDS') {
    return errors.insufficientFunds({ detail: String(any?.shortMessage ?? any?.message ?? '') });
  }
  if (NONCE_CODES.has(code)) {
    const conflict = errors.conflict(
      `Nonce conflict while performing ${label}: ${any?.shortMessage ?? code}.`,
      { label, code },
    );
    /** @type {any} */ (conflict).chainCode = code;
    return conflict;
  }
  if (code === 'CALL_EXCEPTION') {
    return errors.upstream(
      `${label} reverted: ${any?.revert?.name ?? any?.shortMessage ?? 'unknown reason'}.`,
      {
        label,
        reason: any?.revert?.name ?? null,
        args: any?.revert?.args ? [...any.revert.args].map(String) : null,
      },
    );
  }
  if (code === 'ACTION_REJECTED') {
    return errors.badRequest(`${label} was rejected by the signer.`, { label });
  }
  if (TRANSIENT_CODES.has(code)) {
    return errors.chainUnavailable(
      `${label} failed at the RPC transport layer: ${any?.shortMessage ?? code}.`,
    );
  }
  return errors.chainUnavailable(`${label} failed: ${any?.shortMessage ?? any?.message ?? err}.`);
}

/**
 * Translate an `estimateGas` failure.
 *
 * This is deliberately a **400**, not a 502. A revert at estimation means the transaction cannot
 * succeed as constructed; broadcasting it anyway would spend real gas to learn what the node already
 * knows.
 *
 * @param {unknown} err The failure.
 * @param {string} label Transaction label.
 * @param {string} method Method name.
 * @returns {import('../errors.js').AppError} The mapped error.
 */
function mapEstimateError(err, label, method) {
  const any = /** @type {any} */ (err);
  if (TRANSIENT_CODES.has(String(any?.code))) return mapChainError(err, `${label}.estimateGas`);
  const reason = any?.revert?.name ?? any?.shortMessage ?? any?.message ?? 'unknown reason';
  return errors.badRequest(
    `${method}() would revert (${reason}), so it was not broadcast. No gas was spent.`,
    {
      label,
      method,
      reason: any?.revert?.name ?? null,
      args: any?.revert?.args ? [...any.revert.args].map(String) : null,
    },
  );
}

/**
 * Strip credentials and path from an RPC URL before it reaches a log line. Provider URLs routinely
 * embed an API key in the path (`https://sepolia.infura.io/v3/<key>`), and a failover log line is
 * not worth leaking one for.
 *
 * @param {string} url Endpoint URL.
 * @returns {string} Host only.
 */
function redactUrl(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable url)';
  }
}

/**
 * @param {Record<string, ContractCheck>} contracts Check results.
 * @returns {Record<string, string>} A compact per-contract verdict for one log line.
 */
function summarizeChecks(contracts) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, check] of Object.entries(contracts)) {
    out[name] = !check.configured
      ? 'unconfigured'
      : !check.hasCode
        ? 'no-bytecode'
        : `typehashes:${check.typehashes} domain:${check.domain}`;
  }
  return out;
}

/**
 * @param {unknown} err Thrown value.
 * @returns {{code: string, message: string}} A loggable description with no upstream object attached.
 */
function describe(err) {
  const any = /** @type {any} */ (err);
  return {
    code: String(any?.code ?? any?.name ?? 'error'),
    message: String(any?.shortMessage ?? any?.message ?? err),
  };
}

export default createChainService;
