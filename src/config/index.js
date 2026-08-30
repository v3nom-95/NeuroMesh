/**
 * The derived, frozen application configuration. The only config surface services import.
 *
 * `./env.js` answers "is the environment valid?". This module answers "what is this node?": it
 * merges the validated environment with `package.json` and the deployment record, derives the
 * booleans everything else branches on (`isProduction`, `isTest`, `hasSigner`, `readOnly`), and
 * freezes the result so nothing can mutate configuration at runtime.
 *
 * ## Parsed once, at import
 *
 * The parse happens when this module is first evaluated, before the port is bound and before any
 * dependency is contacted. A misconfigured node fails immediately with a complete, redacted report
 * rather than binding the port and then failing every request forever, which is what v1 did.
 *
 * ## Secrets are non-enumerable
 *
 * `config.signer.privateKey`, `config.ipfs.jwt`, `config.crypto.encryptionKeyHex`,
 * `config.security.apiToken` and `config.security.metricsToken` are defined as non-enumerable
 * properties. They read normally but never appear in `JSON.stringify(config)`, in a spread, in
 * `Object.keys`, or in a structured log line that serialized the object whole. {@link publicConfig}
 * is the deliberate, secret-free projection for the status route and the OpenAPI examples.
 *
 * ## Address resolution order
 *
 * 1. An explicit `CONTRACT_*` environment variable (highest precedence: it is the operator saying
 *    exactly what to use).
 * 2. The file at `CONTRACT_ADDRESSES_PATH` (`./contract-addresses.json`).
 * 3. `deployments/<chainId>.json`.
 * 4. `null` - the contract is simply not configured, which is a supported state.
 *
 * When a loaded file declares a `chainId` that differs from `CHAIN_ID`, this throws at boot rather
 * than pointing the node at contracts that do not exist on the target chain. That is the failure
 * mode a `hardhat run scripts/deploy.js --network localhost` used to cause by clobbering the
 * Sepolia addresses in place.
 *
 * @module src/config
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAddress } from 'ethers';

import { ConfigError } from '../errors.js';
import { CONTRACT_NAMES } from '../abi/index.js';
import {
  SECRET_KEYS,
  formatIssues,
  isTestRun,
  loadDotenv,
  loadEnv,
  parseEnv,
  redactEnv,
} from './env.js';

export { SECRET_KEYS, formatIssues, isTestRun, parseEnv, redactEnv };

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {{name: string, version: string}} */
const pkg = require('../../package.json');

/**
 * Freeze an object and everything reachable from it, leaving non-enumerable properties alone so
 * the secret getters keep working.
 *
 * @template T
 * @param {T} value Object to freeze.
 * @returns {T} The same object, frozen.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && descriptor.enumerable && 'value' in descriptor) {
      deepFreeze(descriptor.value);
    }
  }
  return value;
}

/**
 * Attach a value as a non-enumerable, non-writable property.
 *
 * @param {Record<string, unknown>} target Object to extend.
 * @param {string} key Property name.
 * @param {unknown} value Value to hide from enumeration.
 * @returns {void}
 */
function defineSecret(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

/**
 * Resolve a possibly-relative path against the repository root.
 *
 * @param {string} p Path from configuration.
 * @returns {string} Absolute path.
 */
function fromRoot(p) {
  return isAbsolute(p) ? p : resolve(ROOT, p);
}

/**
 * @typedef {object} AddressRecord
 * @property {Record<string, string|null>} addresses Contract name to address.
 * @property {string} source Where the addresses came from, for the status route.
 * @property {number|null} chainId Chain id declared by the record, if any.
 */

/**
 * Read a JSON file, tolerating absence and reporting a parse failure clearly.
 *
 * @param {string} path Absolute path.
 * @returns {Record<string, any>|null} Parsed contents, or `null` when the file is absent.
 * @throws {ConfigError} When the file exists but is not JSON.
 */
function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ConfigError(
      `${path} exists but is not valid JSON.`,
      { path },
      'invalid_address_record',
    );
  }
}

/**
 * Resolve every contract address.
 *
 * @param {import('./env.js').Env} env Validated environment.
 * @returns {AddressRecord} Resolved addresses and their provenance.
 * @throws {ConfigError} When a record's `chainId` disagrees with `CHAIN_ID`, or an address is not
 *   a valid EVM address.
 */
function resolveAddresses(env) {
  /** @type {Record<string, string|undefined>} */
  const explicit = {
    AgentIdentity: env.CONTRACT_AGENT_IDENTITY,
    MemoryLedger: env.CONTRACT_MEMORY_LEDGER,
    ReputationManager: env.CONTRACT_REPUTATION_MANAGER,
    MemoryAccessControl: env.CONTRACT_MEMORY_ACCESS_CONTROL,
  };

  const filePath = fromRoot(env.CONTRACT_ADDRESSES_PATH);
  const deploymentPath = resolve(ROOT, 'deployments', `${env.CHAIN_ID}.json`);

  const fileRecord = readJsonIfPresent(filePath);
  const deploymentRecord = readJsonIfPresent(deploymentPath);

  for (const [record, path] of /** @type {Array<[Record<string, any>|null, string]>} */ ([
    [fileRecord, filePath],
    [deploymentRecord, deploymentPath],
  ])) {
    if (record && record.chainId !== undefined && Number(record.chainId) !== env.CHAIN_ID) {
      throw new ConfigError(
        `${path} was written for chain ${record.chainId} but CHAIN_ID is ${env.CHAIN_ID}. ` +
          'Pointing at contracts that do not exist on the target chain produces opaque decode ' +
          'errors on every read; refusing to boot instead.',
        { path, recordChainId: Number(record.chainId), configuredChainId: env.CHAIN_ID },
        'contract_address_chain_mismatch',
      );
    }
  }

  /**
   * Addresses may live at the top level of the record or under `contracts`.
   *
   * @param {Record<string, any>|null} record Loaded record.
   * @param {string} name Contract name.
   * @returns {string|undefined} Address, if the record has one.
   */
  const pick = (record, name) => {
    if (!record) return undefined;
    const contracts = record.contracts ?? record;
    const value = contracts?.[name];
    if (typeof value === 'string') return value;
    if (value && typeof value.address === 'string') return value.address;
    return undefined;
  };

  /** @type {Record<string, string|null>} */
  const addresses = {};
  /** @type {Set<string>} */
  const sources = new Set();

  for (const name of CONTRACT_NAMES) {
    const raw =
      explicit[name] ?? pick(fileRecord, name) ?? pick(deploymentRecord, name) ?? undefined;
    if (raw === undefined) {
      addresses[name] = null;
      continue;
    }
    try {
      addresses[name] = getAddress(raw);
    } catch {
      throw new ConfigError(
        `The address configured for ${name} is not a valid EVM address.`,
        { contract: name },
        'invalid_contract_address',
      );
    }
    if (explicit[name]) sources.add('env');
    else if (pick(fileRecord, name)) sources.add(env.CONTRACT_ADDRESSES_PATH);
    else sources.add(`deployments/${env.CHAIN_ID}.json`);
  }

  return {
    addresses,
    source: sources.size === 0 ? 'none' : [...sources].join('+'),
    chainId: fileRecord?.chainId ?? deploymentRecord?.chainId ?? null,
  };
}

/**
 * @typedef {ReturnType<typeof buildConfig>} Config
 */

/**
 * Assemble the frozen configuration object from a validated environment.
 *
 * @param {import('./env.js').Env} env Validated environment.
 * @returns {Record<string, any>} Deeply frozen configuration.
 */
function buildConfig(env) {
  const isProduction = env.NODE_ENV === 'production';
  const isTest = env.NODE_ENV === 'test';
  const hasSigner = Boolean(env.PRIVATE_KEY);
  const rpcUrls =
    env.RPC_URLS && env.RPC_URLS.length > 0
      ? env.RPC_URLS
      : env.SEPOLIA_RPC_URL
        ? [env.SEPOLIA_RPC_URL]
        : [];
  // A signer with nowhere to send transactions is a read-only node, not a misconfiguration.
  const readOnly = !hasSigner || rpcUrls.length === 0;

  const { addresses, source: addressesSource } = resolveAddresses(env);

  const security = {
    rateLimit: {
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      writeMax: env.WRITE_RATE_LIMIT_MAX,
      searchMax: env.SEARCH_RATE_LIMIT_MAX,
      decryptMax: env.DECRYPT_RATE_LIMIT_MAX,
    },
    apiTokenConfigured: Boolean(env.API_AUTH_TOKEN),
    metricsTokenConfigured: Boolean(env.METRICS_TOKEN),
  };
  defineSecret(security, 'apiToken', env.API_AUTH_TOKEN ?? null);
  defineSecret(security, 'metricsToken', env.METRICS_TOKEN ?? null);

  const signer = { configured: hasSigner, readOnly };
  defineSecret(signer, 'privateKey', env.PRIVATE_KEY ?? null);

  const ipfs = {
    enabled: Boolean(env.PINATA_JWT),
    apiUrl: env.PINATA_API_URL,
    gatewayUrl: env.IPFS_GATEWAY_URL,
    timeoutMs: env.IPFS_TIMEOUT_MS,
    maxBytes: env.IPFS_MAX_BYTES,
  };
  defineSecret(ipfs, 'jwt', env.PINATA_JWT ?? null);

  const crypto = {
    keyVersion: env.ENCRYPTION_KEY_VERSION,
    // Absent means "derive the encryption keypair from the wallet key per protocol section 2",
    // which is still key *separation*: the derivation is one-way and domain-separated.
    deriveFromWallet: !env.MEMORY_ENCRYPTION_KEY,
  };
  defineSecret(crypto, 'encryptionKeyHex', env.MEMORY_ENCRYPTION_KEY ?? null);

  return deepFreeze({
    app: {
      name: pkg.name,
      version: pkg.version,
      commit: env.GIT_COMMIT,
      nodeVersion: process.version,
      env: env.NODE_ENV,
      isProduction,
      isProd: isProduction,
      isTest,
      isDevelopment: env.NODE_ENV === 'development',
      startedAt: new Date().toISOString(),
    },
    http: {
      port: env.PORT,
      host: env.HOST,
      bodyLimit: env.BODY_LIMIT,
      trustProxy: env.TRUST_PROXY,
      corsOrigins: env.CORS_ALLOWED_ORIGINS,
      shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
      // Both above a typical 60 s proxy idle timeout, and headers > keepAlive, so the proxy is
      // always the side that closes an idle connection. Reversing them produces 502s under load.
      keepAliveTimeoutMs: 65000,
      headersTimeoutMs: 66000,
    },
    security,
    logging: {
      level: env.LOG_LEVEL,
      pretty: env.LOG_PRETTY,
    },
    chain: {
      enabled: rpcUrls.length > 0,
      rpcUrls,
      chainId: env.CHAIN_ID,
      confirmations: env.TX_CONFIRMATIONS,
      txTimeoutMs: env.TX_TIMEOUT_MS,
      txQueueMax: env.TX_QUEUE_MAX,
      gasMultiplier: env.GAS_PRICE_MULTIPLIER,
      explorerBaseUrl: env.EXPLORER_BASE_URL,
      addresses: {
        identity: addresses.AgentIdentity,
        ledger: addresses.MemoryLedger,
        reputation: addresses.ReputationManager,
        access: addresses.MemoryAccessControl,
      },
      addressesSource,
    },
    signer,
    ipfs,
    crypto,
    embeddings: {
      provider: env.NEUROMESH_EMBEDDING_PROVIDER,
      model: env.EMBEDDING_MODEL,
      altModel: env.EMBEDDING_MODEL_ALT,
      preload: env.MODEL_PRELOAD,
      loadTimeoutMs: env.MODEL_LOAD_TIMEOUT_MS,
      inferTimeoutMs: env.EMBED_TIMEOUT_MS,
      queueMax: env.EMBED_QUEUE_MAX,
      cacheDir: fromRoot(env.TRANSFORMERS_CACHE),
      maxContextChars: env.MAX_CONTEXT_CHARS,
      maxReasonChars: env.MAX_REASON_CHARS,
    },
    semantic: {
      indexPath: fromRoot(env.SEMANTIC_INDEX_PATH),
      indexMax: env.SEMANTIC_INDEX_MAX,
      bundlePath: env.ALIGNMENT_BUNDLE_PATH ? fromRoot(env.ALIGNMENT_BUNDLE_PATH) : null,
      anchorPath: env.ANCHOR_SET_PATH ? fromRoot(env.ANCHOR_SET_PATH) : null,
    },
    jobs: {
      ttlMs: env.JOB_TTL_MS,
      max: env.JOB_MAX,
      idempotencyTtlMs: env.IDEMPOTENCY_TTL_MS,
    },
    sse: {
      maxClients: env.SSE_MAX_CLIENTS,
      heartbeatMs: env.SSE_HEARTBEAT_MS,
    },
    paths: {
      root: ROOT,
      publicDir: resolve(ROOT, 'public'),
      simulationResults: fromRoot(env.SIMULATION_RESULTS_PATH),
      contractAddresses: fromRoot(env.CONTRACT_ADDRESSES_PATH),
    },
    features: {
      legacyRoutes: env.ENABLE_LEGACY_ROUTES,
      metrics: env.METRICS_ENABLED,
      write: !readOnly,
      search: true,
      sseToken: false,
    },
  });
}

/**
 * Build a configuration from an arbitrary environment, with no process-level side effects.
 *
 * This is the seam tests use: it never loads `.env`, never exits, and throws a
 * {@link ConfigError} carrying the full redacted report when the environment is invalid.
 *
 * @param {Record<string, string|undefined>} raw Environment to validate and derive from.
 * @returns {Record<string, any>} Frozen configuration.
 * @throws {ConfigError} When `raw` is invalid.
 */
export function configFromEnv(raw) {
  const result = parseEnv(raw);
  if (!result.ok) {
    throw new ConfigError(formatIssues(result.issues), { issues: result.issues });
  }
  return buildConfig(result.value);
}

loadDotenv();

/** @type {Record<string, any>} */
let config = buildConfig(loadEnv());

/**
 * The process-wide configuration.
 *
 * @returns {Record<string, any>} Frozen configuration.
 */
export function getConfig() {
  return config;
}

/**
 * Re-parse the environment. Test-only: production configuration is immutable by design, and a
 * service holding a stale reference after a reload would be a subtle and awful bug.
 *
 * @param {Record<string, string|undefined>} [raw] Environment to use.
 * @returns {Record<string, any>} The new frozen configuration.
 * @throws {ConfigError} Outside a test run, or when `raw` is invalid.
 */
export function reloadConfig(raw = process.env) {
  if (!config.app.isTest && !isTestRun()) {
    throw new ConfigError(
      'reloadConfig() is test-only. Configuration is parsed once at boot and is immutable.',
      null,
      'reload_not_permitted',
    );
  }
  config = configFromEnv(raw);
  return config;
}

/**
 * A JSON-safe projection of the configuration with every secret replaced by a boolean.
 *
 * This is what `/api/v1/status` returns and what the OpenAPI examples embed. It is asserted, both
 * here and in a unit test, to contain none of the secret values.
 *
 * @param {Record<string, any>} [cfg] Configuration to project.
 * @returns {Record<string, any>} Secret-free configuration.
 */
export function publicConfig(cfg = config) {
  return {
    app: { ...cfg.app },
    http: {
      port: cfg.http.port,
      host: cfg.http.host,
      bodyLimit: cfg.http.bodyLimit,
      corsOrigins: cfg.http.corsOrigins,
    },
    security: {
      apiTokenConfigured: cfg.security.apiTokenConfigured,
      metricsTokenConfigured: cfg.security.metricsTokenConfigured,
      rateLimit: { ...cfg.security.rateLimit },
    },
    logging: { ...cfg.logging },
    chain: {
      enabled: cfg.chain.enabled,
      chainId: cfg.chain.chainId,
      confirmations: cfg.chain.confirmations,
      explorerBaseUrl: cfg.chain.explorerBaseUrl,
      addresses: { ...cfg.chain.addresses },
      addressesSource: cfg.chain.addressesSource,
      rpcConfigured: cfg.chain.rpcUrls.length,
    },
    signer: { configured: cfg.signer.configured, readOnly: cfg.signer.readOnly },
    ipfs: {
      enabled: cfg.ipfs.enabled,
      gatewayUrl: cfg.ipfs.gatewayUrl,
      timeoutMs: cfg.ipfs.timeoutMs,
      maxBytes: cfg.ipfs.maxBytes,
    },
    crypto: { keyVersion: cfg.crypto.keyVersion, deriveFromWallet: cfg.crypto.deriveFromWallet },
    embeddings: { ...cfg.embeddings },
    semantic: { ...cfg.semantic },
    jobs: { ...cfg.jobs },
    sse: { ...cfg.sse },
    features: { ...cfg.features },
  };
}

/**
 * Every secret value this configuration holds, for the "no secret leaked" assertions.
 *
 * Not exported as part of the public surface for casual use - it exists so a test can prove a
 * negative. Returns only values that are actually set.
 *
 * @param {Record<string, any>} [cfg] Configuration to inspect.
 * @returns {string[]} Secret values currently configured.
 */
export function secretValues(cfg = config) {
  return [
    cfg.security.apiToken,
    cfg.security.metricsToken,
    cfg.signer.privateKey,
    cfg.ipfs.jwt,
    cfg.crypto.encryptionKeyHex,
  ].filter((v) => typeof v === 'string' && v.length > 0);
}

/**
 * The configuration as it was at import time.
 *
 * This is a snapshot, not a live binding: {@link reloadConfig} replaces what {@link getConfig}
 * returns but cannot change what a `default` import already captured. Long-lived code should call
 * `getConfig()`; the default export is for the common case of a module that reads configuration
 * once and never expects it to change, which in production it never does.
 */
export default config;
