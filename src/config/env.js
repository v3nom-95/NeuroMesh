/**
 * The one place in this repository that reads `process.env`.
 *
 * ## Why this file exists
 *
 * v1 read the environment ad hoc and never validated it. `let pk = process.env.PRIVATE_KEY;
 * if (!pk.startsWith('0x'))` threw `TypeError: Cannot read properties of undefined` the moment the
 * variable was absent — which is every fresh clone — and because that ran inside the `app.listen`
 * callback with a `.catch(console.error)`, the port was already bound. The server then answered
 * 200 on `/api/status` with `agentAddress: 'Loading...'` forever and 500 on every write. Nothing
 * validated that the RPC URL was a URL, that the private key was 32 bytes, or that the configured
 * chain id matched what the RPC reported.
 *
 * The replacement: one zod parse, once, before anything else happens. On failure the process
 * prints every problem at once — path and message, never a value — and exits 1.
 *
 * ## Secrets never appear in output
 *
 * {@link SECRET_KEYS} names every variable whose value must never be printed, logged, serialized
 * into a status response, or included in an error. The issue formatter prints paths and messages
 * only, for *all* variables, because a "must be 32 bytes of hex" message that helpfully echoes
 * what it received is exactly how a key ends up in a CI log.
 *
 * ## Test safety
 *
 * `npm run test:unit` runs `node --test test/backend` with no environment preset — npm scripts
 * cannot set env vars inline on Windows. So this module must never require a `.env`, a private
 * key, a network or a model download in order to be imported by a test. Two things make that true:
 *
 * 1. {@link isTestRun} treats `NODE_ENV=test` *or* the presence of `NODE_TEST_CONTEXT` (which
 *    Node's own test runner sets in every test child process) as "this is a test".
 * 2. In a test run, `dotenv` is not loaded at all — the repository's real `.env` holds a funded
 *    Sepolia key and a Pinata JWT, and a unit test must never see either — `NODE_ENV` defaults to
 *    `test`, and `NEUROMESH_EMBEDDING_PROVIDER` defaults to `mock`.
 *
 * @module src/config/env
 */
import { createRequire } from 'node:module';

import { getAddress } from 'ethers';
import { z } from 'zod';

import { ConfigError } from '../errors.js';

/**
 * Variables whose values must never be printed, logged or serialized.
 *
 * The logger builds its redaction list from this, and `publicConfig()` asserts that none of these
 * values appears in its own JSON output.
 *
 * @type {ReadonlyArray<string>}
 */
export const SECRET_KEYS = Object.freeze([
  'PRIVATE_KEY',
  'PINATA_JWT',
  'API_AUTH_TOKEN',
  'MEMORY_ENCRYPTION_KEY',
  'METRICS_TOKEN',
  'ETHERSCAN_API_KEY',
  'COINMARKETCAP_API_KEY',
]);

/**
 * True when this process is a test run.
 *
 * `NODE_TEST_CONTEXT` is set by Node's test runner in each test child process, which is what lets
 * `node --test test/backend` behave as a test run even though the npm script sets no environment.
 *
 * @param {Record<string, string|undefined>} [raw] Environment to inspect.
 * @returns {boolean} True for a test run.
 */
export function isTestRun(raw = process.env) {
  return raw.NODE_ENV === 'test' || Boolean(raw.NODE_TEST_CONTEXT);
}

/* -------------------------------------------------------------------------- */
/* Reusable field schemas                                                     */
/* -------------------------------------------------------------------------- */

/** Accepts `1/true/yes/on` and `0/false/no/off`, case-insensitively. */
const boolish = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === 'boolean') return v;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  ctx.addIssue({ code: 'custom', message: 'must be one of true/false/1/0/yes/no/on/off' });
  return z.NEVER;
});

/** A comma-separated list, trimmed, with empty entries dropped. */
const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter((s) => s.length > 0),
  );

/** 32 bytes of hex, with or without the `0x` prefix, normalized to lower-case 0x form. */
const hex32 = z
  .string()
  .transform((v) => v.trim())
  .refine((v) => /^(0x)?[0-9a-fA-F]{64}$/.test(v), {
    message: 'must be 32 bytes of hexadecimal (64 hex characters, 0x prefix optional)',
  })
  .transform((v) => `0x${v.replace(/^0x/, '').toLowerCase()}`);

/** A checksummed EVM address. `ethers.getAddress` rejects a bad checksum, which catches typos. */
const evmAddress = z.string().transform((v, ctx) => {
  try {
    return getAddress(v.trim());
  } catch {
    ctx.addIssue({ code: 'custom', message: 'must be a valid EVM address' });
    return z.NEVER;
  }
});

/**
 * Positive integer with bounds.
 *
 * @param {number} min Inclusive lower bound.
 * @param {number} max Inclusive upper bound.
 * @returns {z.ZodType<number>} Schema.
 */
const int = (min, max) => z.coerce.number().int().min(min).max(max);

/* -------------------------------------------------------------------------- */
/* The schema                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Shape rules for every recognized variable. Cross-field rules live in {@link crossFieldRules}.
 */
const EnvObject = z.object({
  // Process.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(1, 65535).default(7860),
  // 127.0.0.1, never 0.0.0.0: v1 bound the wildcard, which put a wallet-spending API on the LAN.
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: boolish.default(true),
  SHUTDOWN_TIMEOUT_MS: int(0, 600000).default(10000),
  GIT_COMMIT: z.string().default('unknown'),

  // HTTP surface.
  BODY_LIMIT: z.string().default('256kb'),
  TRUST_PROXY: z.union([boolish, z.string()]).default(false),
  CORS_ALLOWED_ORIGINS: csv.default([]),

  // Rate limiting.
  RATE_LIMIT_WINDOW_MS: int(1000, 3600000).default(60000),
  RATE_LIMIT_MAX: int(1, 100000).default(60),
  WRITE_RATE_LIMIT_MAX: int(1, 100000).default(10),
  SEARCH_RATE_LIMIT_MAX: int(1, 100000).default(20),
  DECRYPT_RATE_LIMIT_MAX: int(1, 100000).default(5),

  // Authentication.
  API_AUTH_TOKEN: z
    .string()
    .min(32, { message: 'must be at least 32 characters; generate with `openssl rand -hex 32`' })
    .optional(),
  METRICS_ENABLED: boolish.default(true),
  METRICS_TOKEN: z.string().min(16).optional(),

  // Chain.
  SEPOLIA_RPC_URL: z.url({ message: 'must be an absolute URL' }).optional(),
  RPC_URLS: csv.optional(),
  CHAIN_ID: int(1, Number.MAX_SAFE_INTEGER).default(11155111),
  PRIVATE_KEY: hex32.optional(),
  CONTRACT_ADDRESSES_PATH: z.string().default('./contract-addresses.json'),
  CONTRACT_AGENT_IDENTITY: evmAddress.optional(),
  CONTRACT_MEMORY_LEDGER: evmAddress.optional(),
  CONTRACT_REPUTATION_MANAGER: evmAddress.optional(),
  CONTRACT_MEMORY_ACCESS_CONTROL: evmAddress.optional(),
  TX_CONFIRMATIONS: int(1, 64).default(1),
  TX_TIMEOUT_MS: int(1000, 3600000).default(120000),
  TX_QUEUE_MAX: int(1, 10000).default(32),
  GAS_PRICE_MULTIPLIER: z.coerce.number().min(1).max(10).default(1.2),
  EXPLORER_BASE_URL: z.url().default('https://sepolia.etherscan.io'),

  // IPFS.
  PINATA_JWT: z.string().min(1).optional(),
  PINATA_API_URL: z.url().default('https://api.pinata.cloud'),
  IPFS_GATEWAY_URL: z.url().default('https://gateway.pinata.cloud/ipfs'),
  IPFS_TIMEOUT_MS: int(1000, 600000).default(30000),
  IPFS_MAX_BYTES: int(1024, 16777216).default(1048576),

  // Crypto.
  MEMORY_ENCRYPTION_KEY: hex32.optional(),
  ENCRYPTION_KEY_VERSION: int(1, 65535).default(1),

  // Embeddings.
  NEUROMESH_EMBEDDING_PROVIDER: z.enum(['local', 'mock']).default('local'),
  EMBEDDING_MODEL: z.string().min(1).default('Xenova/all-MiniLM-L6-v2'),
  EMBEDDING_MODEL_ALT: z.string().min(1).default('Xenova/all-distilroberta-v1'),
  MODEL_PRELOAD: boolish.default(true),
  MODEL_LOAD_TIMEOUT_MS: int(1000, 3600000).default(300000),
  EMBED_TIMEOUT_MS: int(100, 600000).default(30000),
  EMBED_QUEUE_MAX: int(1, 10000).default(64),
  TRANSFORMERS_CACHE: z.string().default('./.cache/transformers'),
  MAX_CONTEXT_CHARS: int(1, 1000000).default(8000),
  MAX_REASON_CHARS: int(1, 10000).default(200),

  // Semantic layer.
  ALIGNMENT_BUNDLE_PATH: z.string().optional(),
  ANCHOR_SET_PATH: z.string().optional(),
  SEMANTIC_INDEX_PATH: z.string().default('./.cache/semantic-index.jsonl'),
  SEMANTIC_INDEX_MAX: int(1, 10000000).default(10000),

  // Jobs, events, features.
  JOB_TTL_MS: int(1000, 604800000).default(3600000),
  JOB_MAX: int(1, 1000000).default(500),
  IDEMPOTENCY_TTL_MS: int(1000, 604800000).default(86400000),
  SSE_MAX_CLIENTS: int(1, 100000).default(100),
  SSE_HEARTBEAT_MS: int(1000, 600000).default(15000),
  ENABLE_LEGACY_ROUTES: boolish.default(false),

  // Paths.
  SIMULATION_RESULTS_PATH: z.string().default('./simulation-results.json'),
});

/**
 * @typedef {z.infer<typeof EnvObject>} Env
 */

/**
 * Normalize a raw environment before the schema sees it.
 *
 * Three jobs, all of which have to happen before per-field validation:
 *
 * 1. An empty string is treated as absent. `.env` files are full of `PRIVATE_KEY=` and
 *    `z.coerce.number()` happily turns `''` into `0`, which would silently configure a zero
 *    timeout rather than reporting a missing value.
 * 2. `NODE_ENV` is resolved first, because two other defaults depend on it.
 * 3. In a test run, the embedding provider defaults to `mock` and pretty logging is off. A unit
 *    test must never download 90 MB of ONNX weights.
 *
 * @param {unknown} value Raw environment.
 * @returns {Record<string, unknown>} Normalized environment.
 */
function normalizeRaw(value) {
  /** @type {Record<string, unknown>} */
  const raw = {};
  for (const [key, v] of Object.entries(/** @type {Record<string, unknown>} */ (value ?? {}))) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    raw[key] = v;
  }

  const testRun = isTestRun(/** @type {Record<string, string|undefined>} */ (raw));
  if (raw.NODE_ENV === undefined && testRun) raw.NODE_ENV = 'test';
  const nodeEnv = raw.NODE_ENV ?? 'development';

  if (raw.NEUROMESH_EMBEDDING_PROVIDER === undefined && nodeEnv === 'test') {
    raw.NEUROMESH_EMBEDDING_PROVIDER = 'mock';
  }
  if (raw.LOG_PRETTY === undefined) raw.LOG_PRETTY = nodeEnv !== 'production';
  if (raw.LOG_LEVEL === undefined && nodeEnv === 'test') raw.LOG_LEVEL = 'silent';

  return raw;
}

/**
 * Cross-field rules. Each one exists because of a specific way this service can be misconfigured
 * into being dangerous rather than merely broken.
 *
 * @param {Env} env Parsed environment.
 * @param {z.RefinementCtx} ctx zod refinement context.
 * @returns {void}
 */
function crossFieldRules(env, ctx) {
  const isProd = env.NODE_ENV === 'production';

  // (1) A production node with no token is an open, wallet-spending API. Refuse to boot.
  if (isProd && !env.API_AUTH_TOKEN) {
    ctx.addIssue({
      code: 'custom',
      path: ['API_AUTH_TOKEN'],
      message:
        'is required in production - every mutating route is gated on it. ' +
        'Generate one with `openssl rand -hex 32`.',
    });
  }

  // (2) '*' is never an allowlist. v1 used bare cors(), which is how a page the operator merely
  //     visited could drive POST /api/memory and drain the wallet.
  if (env.CORS_ALLOWED_ORIGINS.includes('*')) {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ALLOWED_ORIGINS'],
      message:
        "must be an explicit list of origins; '*' is never accepted. Leave it empty to allow " +
        'same-origin requests only.',
    });
  }

  // (3) Binding the wildcard address without a token exposes the API to the whole network.
  if (env.HOST === '0.0.0.0' && !env.API_AUTH_TOKEN) {
    ctx.addIssue({
      code: 'custom',
      path: ['HOST'],
      message:
        'binds every interface, which requires API_AUTH_TOKEN to be set. Use 127.0.0.1 for local ' +
        'development.',
    });
  }

  // (4) Key separation. The whole point of the envelope rewrite is that leaking the memory key
  //     must not cost signing authority, and vice versa.
  if (
    env.MEMORY_ENCRYPTION_KEY &&
    env.PRIVATE_KEY &&
    env.MEMORY_ENCRYPTION_KEY === env.PRIVATE_KEY
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['MEMORY_ENCRYPTION_KEY'],
      message:
        'key separation violation: the memory encryption key MUST NOT equal the chain signing key.',
    });
  }

  // (5) A signer with nowhere to send transactions is not an error - it is a read-only node.
  //     Handled as a derived flag in src/config/index.js, deliberately not an issue here.

  // (6) A token short enough to guess is worse than no token, because it looks like security.
  if (env.API_AUTH_TOKEN && /^(\w)\1*$/.test(env.API_AUTH_TOKEN)) {
    ctx.addIssue({
      code: 'custom',
      path: ['API_AUTH_TOKEN'],
      message: 'must not be a repeated single character.',
    });
  }
}

/**
 * The full environment schema: normalize, validate each field, then apply the cross-field rules.
 *
 * @type {z.ZodType<Env>}
 */
export const EnvSchema = /** @type {any} */ (
  z.preprocess(normalizeRaw, EnvObject).superRefine(crossFieldRules)
);

/* -------------------------------------------------------------------------- */
/* Parsing and reporting                                                      */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} EnvIssue
 * @property {string} path Variable name (dotted for nested paths, which this schema has none of).
 * @property {string} message What is wrong. Never contains the received value.
 */

/**
 * @typedef {{ok: true, value: Env}|{ok: false, issues: EnvIssue[]}} ParseEnvResult
 */

/**
 * Validate an environment without any side effects.
 *
 * Pure: it does not read `process.env` unless you let it default, does not load `.env`, does not
 * print and does not exit. Tests drive this directly with explicit objects.
 *
 * @param {Record<string, string|undefined>} [raw] Environment to validate.
 * @returns {ParseEnvResult} Success with the parsed value, or the full issue list.
 */
export function parseEnv(raw = process.env) {
  const result = EnvSchema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data };

  /** @type {EnvIssue[]} */
  const issues = result.error.issues
    .map((issue) => ({
      path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(environment)',
      message: issue.message,
    }))
    .sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));

  return { ok: false, issues };
}

/**
 * Render the issue list as a human-readable report.
 *
 * Values are never included. The report names the variable and says what is wrong with it, which
 * is everything an operator needs and nothing an attacker or a CI log wants.
 *
 * @param {ReadonlyArray<EnvIssue>} issues Issues from {@link parseEnv}.
 * @returns {string} Multi-line report.
 */
export function formatIssues(issues) {
  const width = issues.reduce((max, i) => Math.max(max, i.path.length), 0);
  const lines = issues.map((i) => `  ${i.path.padEnd(width)}  ${i.message}`);
  return [
    `Invalid configuration - ${issues.length} problem${issues.length === 1 ? '' : 's'} found:`,
    '',
    ...lines,
    '',
    'See .env.example for every recognized variable. No values are printed above, deliberately.',
  ].join('\n');
}

/**
 * Return a copy of an environment with every secret replaced by a marker.
 *
 * Used by the status route's debug output and by anything that wants to log "what am I configured
 * with" without logging the answer.
 *
 * @param {Record<string, unknown>} env Environment-shaped object.
 * @returns {Record<string, unknown>} A copy safe to serialize.
 */
export function redactEnv(env) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_KEYS.includes(key)) {
      out[key] = value === undefined || value === null ? null : '[redacted]';
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** @type {boolean} Whether `.env` has already been loaded into `process.env`. */
let dotenvLoaded = false;

/**
 * Load `.env` into `process.env`, unless this is a test run.
 *
 * A test must never inherit the repository's real `.env`: it holds a funded Sepolia key and a
 * Pinata JWT, and `npm run test:unit` sets no environment of its own on Windows. `SKIP_DOTENV=1`
 * is the explicit escape hatch for any other context that wants the same guarantee.
 *
 * Synchronous on purpose: configuration is parsed once at import time, and an `await` here would
 * force every consumer of the config singleton to become async.
 *
 * @param {Record<string, string|undefined>} [raw] Environment to inspect.
 * @returns {boolean} Whether `.env` was actually loaded.
 */
export function loadDotenv(raw = process.env) {
  if (dotenvLoaded) return false;
  dotenvLoaded = true;
  if (isTestRun(raw) || raw.SKIP_DOTENV === '1') return false;
  const dotenv = createRequire(import.meta.url)('dotenv');
  dotenv.config({ quiet: true });
  return true;
}

/**
 * Validate `process.env` and either return it or fail loudly.
 *
 * Behaviour on failure is deliberately different in a test run: a test asserts on a thrown
 * {@link ConfigError} rather than watching the runner exit.
 *
 * @param {Record<string, string|undefined>} [raw] Environment to validate.
 * @returns {Env} The validated environment.
 * @throws {ConfigError} In a test run, when validation fails.
 */
export function loadEnv(raw = process.env) {
  const result = parseEnv(raw);
  if (result.ok) return result.value;

  const report = formatIssues(result.issues);
  if (isTestRun(raw)) {
    throw new ConfigError(report, { issues: result.issues });
  }
  process.stderr.write(`${report}\n`);
  process.exit(1);
}

export { EnvObject };
