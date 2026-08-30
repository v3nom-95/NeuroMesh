/**
 * Configuration: defaults, refusals, and the guarantee that no secret ever leaves this module.
 *
 * Every case drives `parseEnv`/`configFromEnv` with an explicit object. Nothing here reads the
 * ambient environment, loads `.env`, touches the network or needs a private key - which is the
 * whole point, because `npm run test:unit` runs `node --test test/backend` with no environment
 * preset at all.
 *
 * @module test/backend/infra/config.test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  EnvSchema,
  SECRET_KEYS,
  formatIssues,
  isTestRun,
  loadEnv,
  parseEnv,
  redactEnv,
} from '../../../src/config/env.js';
import { configFromEnv, getConfig, publicConfig, secretValues } from '../../../src/config/index.js';
import { ConfigError } from '../../../src/errors.js';

/** A 64-hex private key that is not, and must never be, a real one. */
const FAKE_KEY = `0x${'11'.repeat(32)}`;
/** A second, different fake key, for the key-separation test. */
const OTHER_KEY = `0x${'22'.repeat(32)}`;
/** A token long enough to pass the 32-character minimum. */
const TOKEN = 'a'.repeat(16) + 'b'.repeat(16) + 'c'.repeat(8);
/** Checksummed addresses used only as address-shaped test data. */
const LEDGER = '0x10701017eC0faed2309E103C51AB503214F940Fb';
const IDENTITY = '0xD4F91196316f802B67C6B17e0B1845A23beaA2ad';

describe('config/env: defaults', () => {
  it('parses an entirely empty environment', () => {
    const result = parseEnv({});
    assert.equal(result.ok, true);
  });

  it('defaults HOST to 127.0.0.1, never the wildcard address', () => {
    const result = parseEnv({});
    assert.ok(result.ok);
    assert.equal(result.value.HOST, '127.0.0.1');
    assert.notEqual(result.value.HOST, '0.0.0.0');
  });

  it('defaults PORT, NODE_ENV and the CORS allowlist', () => {
    const result = parseEnv({});
    assert.ok(result.ok);
    assert.equal(result.value.PORT, 7860);
    assert.equal(result.value.NODE_ENV, 'development');
    assert.deepEqual(result.value.CORS_ALLOWED_ORIGINS, []);
  });

  it('defaults the embedding provider to mock under NODE_ENV=test', () => {
    const result = parseEnv({ NODE_ENV: 'test' });
    assert.ok(result.ok);
    assert.equal(result.value.NEUROMESH_EMBEDDING_PROVIDER, 'mock');
  });

  it('defaults the embedding provider to local outside a test run', () => {
    const result = parseEnv({ NODE_ENV: 'development' });
    assert.ok(result.ok);
    assert.equal(result.value.NEUROMESH_EMBEDDING_PROVIDER, 'local');
  });

  it('lets an explicit provider override the test default', () => {
    const result = parseEnv({ NODE_ENV: 'test', NEUROMESH_EMBEDDING_PROVIDER: 'local' });
    assert.ok(result.ok);
    assert.equal(result.value.NEUROMESH_EMBEDDING_PROVIDER, 'local');
  });

  it('recognises the test runner even with no NODE_ENV set', () => {
    assert.equal(isTestRun({ NODE_TEST_CONTEXT: 'child' }), true);
    assert.equal(isTestRun({ NODE_ENV: 'test' }), true);
    assert.equal(isTestRun({}), false);
  });

  it('treats an empty string as absent rather than coercing it', () => {
    // `PRIVATE_KEY=` in a .env file is extremely common. Coercing '' to 0 for a numeric field, or
    // accepting it as a key, would silently misconfigure the node.
    const result = parseEnv({ PRIVATE_KEY: '', TX_TIMEOUT_MS: '' });
    assert.ok(result.ok);
    assert.equal(result.value.PRIVATE_KEY, undefined);
    assert.equal(result.value.TX_TIMEOUT_MS, 120000);
  });

  it('normalizes a private key with no 0x prefix', () => {
    const result = parseEnv({ PRIVATE_KEY: 'AB'.repeat(32) });
    assert.ok(result.ok);
    assert.equal(result.value.PRIVATE_KEY, `0x${'ab'.repeat(32)}`);
  });

  it('splits a comma list and trims each entry', () => {
    const result = parseEnv({ CORS_ALLOWED_ORIGINS: ' https://a.test , https://b.test ,' });
    assert.ok(result.ok);
    assert.deepEqual(result.value.CORS_ALLOWED_ORIGINS, ['https://a.test', 'https://b.test']);
  });

  it('exposes the schema so other tooling can introspect it', () => {
    assert.equal(typeof EnvSchema.safeParse, 'function');
  });
});

describe('config/env: rejections with a helpful message', () => {
  it('reports every problem at once instead of one per round trip', () => {
    const result = parseEnv({
      SEPOLIA_RPC_URL: 'not-a-url',
      PORT: '99999',
      PRIVATE_KEY: '0xdead',
      LOG_LEVEL: 'chatty',
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok);
    const paths = result.issues.map((i) => i.path);
    for (const expected of ['SEPOLIA_RPC_URL', 'PORT', 'PRIVATE_KEY', 'LOG_LEVEL']) {
      assert.ok(paths.includes(expected), `expected an issue for ${expected}, got ${paths}`);
    }
  });

  it('names the variable and says what is wrong with it', () => {
    const result = parseEnv({ PRIVATE_KEY: 'nope' });
    assert.ok(!result.ok);
    const issue = result.issues.find((i) => i.path === 'PRIVATE_KEY');
    assert.ok(issue);
    assert.match(issue.message, /32 bytes of hexadecimal/);
  });

  it('never prints a value, not even an invalid one', () => {
    const result = parseEnv({
      PRIVATE_KEY: 'super-secret-but-invalid',
      API_AUTH_TOKEN: 'short',
      PINATA_JWT: '',
    });
    assert.ok(!result.ok);
    const report = formatIssues(result.issues);
    assert.equal(report.includes('super-secret-but-invalid'), false);
    assert.equal(report.includes('short'), false);
    assert.match(report, /No values are printed above, deliberately/);
  });

  it('refuses to boot in production without an API token', () => {
    const result = parseEnv({ NODE_ENV: 'production' });
    assert.ok(!result.ok);
    const issue = result.issues.find((i) => i.path === 'API_AUTH_TOKEN');
    assert.ok(issue);
    assert.match(issue.message, /required in production/);
    assert.match(issue.message, /openssl rand -hex 32/);
  });

  it('boots in production once an API token is present', () => {
    const result = parseEnv({ NODE_ENV: 'production', API_AUTH_TOKEN: TOKEN });
    assert.ok(result.ok);
  });

  it("never accepts '*' as a CORS allowlist", () => {
    const result = parseEnv({ CORS_ALLOWED_ORIGINS: 'https://a.test,*' });
    assert.ok(!result.ok);
    const issue = result.issues.find((i) => i.path === 'CORS_ALLOWED_ORIGINS');
    assert.ok(issue);
    assert.match(issue.message, /never accepted/);
  });

  it('refuses to bind the wildcard address without a token', () => {
    const result = parseEnv({ HOST: '0.0.0.0' });
    assert.ok(!result.ok);
    assert.ok(result.issues.some((i) => i.path === 'HOST'));
  });

  it('allows the wildcard address when a token is configured', () => {
    const result = parseEnv({ HOST: '0.0.0.0', API_AUTH_TOKEN: TOKEN });
    assert.ok(result.ok);
  });

  it('refuses a memory key equal to the chain signing key', () => {
    const result = parseEnv({ PRIVATE_KEY: FAKE_KEY, MEMORY_ENCRYPTION_KEY: FAKE_KEY });
    assert.ok(!result.ok);
    const issue = result.issues.find((i) => i.path === 'MEMORY_ENCRYPTION_KEY');
    assert.ok(issue);
    assert.match(issue.message, /key separation violation/);
  });

  it('accepts distinct chain and memory keys', () => {
    const result = parseEnv({ PRIVATE_KEY: FAKE_KEY, MEMORY_ENCRYPTION_KEY: OTHER_KEY });
    assert.ok(result.ok);
  });

  it('rejects an address with a bad checksum', () => {
    const result = parseEnv({
      CONTRACT_MEMORY_LEDGER: '0x10701017ec0faed2309e103c51ab503214f940fB',
    });
    assert.ok(!result.ok);
    assert.ok(result.issues.some((i) => i.path === 'CONTRACT_MEMORY_LEDGER'));
  });

  it('throws a ConfigError rather than exiting when a test run is misconfigured', () => {
    assert.throws(
      () => loadEnv({ NODE_ENV: 'test', PORT: '0' }),
      (err) => err instanceof ConfigError && /Invalid configuration/.test(err.message),
    );
  });
});

describe('config: derived values', () => {
  it('marks a node with no signer as read-only', () => {
    const config = configFromEnv({ SEPOLIA_RPC_URL: 'https://rpc.test/' });
    assert.equal(config.signer.configured, false);
    assert.equal(config.signer.readOnly, true);
    assert.equal(config.features.write, false);
  });

  it('marks a node with a signer but no RPC as read-only', () => {
    const config = configFromEnv({ PRIVATE_KEY: FAKE_KEY });
    assert.equal(config.signer.configured, true);
    assert.equal(config.signer.readOnly, true);
  });

  it('is writable only with both a signer and an RPC endpoint', () => {
    const config = configFromEnv({ PRIVATE_KEY: FAKE_KEY, SEPOLIA_RPC_URL: 'https://rpc.test/' });
    assert.equal(config.signer.readOnly, false);
    assert.equal(config.features.write, true);
  });

  it('falls back from RPC_URLS to SEPOLIA_RPC_URL', () => {
    const one = configFromEnv({ SEPOLIA_RPC_URL: 'https://a.test/' });
    assert.deepEqual(one.chain.rpcUrls, ['https://a.test/']);
    const many = configFromEnv({
      SEPOLIA_RPC_URL: 'https://a.test/',
      RPC_URLS: 'https://b.test/,https://c.test/',
    });
    assert.deepEqual(many.chain.rpcUrls, ['https://b.test/', 'https://c.test/']);
  });

  it('derives isProduction and isTest', () => {
    assert.equal(
      configFromEnv({ NODE_ENV: 'production', API_AUTH_TOKEN: TOKEN }).app.isProduction,
      true,
    );
    assert.equal(configFromEnv({ NODE_ENV: 'test' }).app.isTest, true);
    assert.equal(configFromEnv({ NODE_ENV: 'development' }).app.isProduction, false);
  });

  it('is frozen all the way down', () => {
    const config = configFromEnv({});
    assert.throws(() => {
      config.http.port = 1;
    }, TypeError);
    assert.throws(() => {
      config.chain.addresses.ledger = '0x0';
    }, TypeError);
  });

  it('refuses a contract address record written for another chain', () => {
    // The v1 failure this prevents: `hardhat run scripts/deploy.js --network localhost` overwrote
    // contract-addresses.json in place, and the running server then held Sepolia-shaped config
    // pointing at addresses with no bytecode on Sepolia.
    const path = join(mkdtempSync(join(tmpdir(), 'neuromesh-cfg-')), 'addresses.json');
    writeFileSync(path, JSON.stringify({ chainId: 31337, MemoryLedger: LEDGER }), 'utf8');

    assert.throws(
      () => configFromEnv({ CHAIN_ID: '11155111', CONTRACT_ADDRESSES_PATH: path }),
      (err) => err instanceof ConfigError && err.code === 'contract_address_chain_mismatch',
    );
    // The same record is fine when the chain ids agree.
    const config = configFromEnv({ CHAIN_ID: '31337', CONTRACT_ADDRESSES_PATH: path });
    assert.equal(config.chain.addresses.ledger, LEDGER);
  });

  it('lets an explicit CONTRACT_* variable win over the address file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'neuromesh-cfg-')), 'addresses.json');
    writeFileSync(path, JSON.stringify({ MemoryLedger: LEDGER }), 'utf8');
    const config = configFromEnv({
      CONTRACT_ADDRESSES_PATH: path,
      CONTRACT_MEMORY_LEDGER: IDENTITY,
    });
    assert.equal(config.chain.addresses.ledger, IDENTITY);
  });

  it('treats an unconfigured contract as null rather than guessing', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'neuromesh-cfg-')), 'addresses.json');
    writeFileSync(path, JSON.stringify({}), 'utf8');
    const config = configFromEnv({ CONTRACT_ADDRESSES_PATH: path });
    assert.equal(config.chain.addresses.ledger, null);
    assert.equal(config.chain.addresses.access, null);
  });
});

describe('config: secrets never leak', () => {
  const env = {
    PRIVATE_KEY: FAKE_KEY,
    MEMORY_ENCRYPTION_KEY: OTHER_KEY,
    API_AUTH_TOKEN: TOKEN,
    METRICS_TOKEN: 'metrics-token-value-1234',
    PINATA_JWT: 'eyJhbGciOiJIUzI1NiJ9.pinata.secret',
    SEPOLIA_RPC_URL: 'https://rpc.test/',
  };

  it('keeps every secret readable by name', () => {
    const config = configFromEnv(env);
    assert.equal(config.signer.privateKey, FAKE_KEY);
    assert.equal(config.crypto.encryptionKeyHex, OTHER_KEY);
    assert.equal(config.security.apiToken, TOKEN);
    assert.equal(config.ipfs.jwt, env.PINATA_JWT);
  });

  it('keeps every secret out of JSON.stringify(config)', () => {
    const config = configFromEnv(env);
    const json = JSON.stringify(config);
    for (const value of secretValues(config)) {
      assert.equal(json.includes(value), false, `serialized config leaked a secret`);
    }
    // The key names themselves must not be serialized either - `"apiTokenConfigured"` is fine and
    // deliberate, `"apiToken"` as its own field is not.
    assert.equal(json.includes('"privateKey"'), false);
    assert.equal(json.includes('"apiToken"'), false);
    assert.equal(json.includes('"jwt"'), false);
  });

  it('keeps every secret out of publicConfig()', () => {
    const config = configFromEnv(env);
    const json = JSON.stringify(publicConfig(config));
    for (const value of secretValues(config)) {
      assert.equal(json.includes(value), false, 'publicConfig leaked a secret');
    }
  });

  it('reports whether each secret is configured without revealing it', () => {
    const pub = publicConfig(configFromEnv(env));
    assert.equal(pub.security.apiTokenConfigured, true);
    assert.equal(pub.signer.configured, true);
    assert.equal(pub.ipfs.enabled, true);
    assert.equal(Object.hasOwn(pub.signer, 'privateKey'), false);
  });

  it('keeps secrets out of Object.keys and the spread operator', () => {
    const config = configFromEnv(env);
    assert.equal(Object.keys(config.signer).includes('privateKey'), false);
    assert.equal(Object.hasOwn({ ...config.ipfs }, 'jwt'), false);
  });

  it('redactEnv replaces every secret key and keeps the rest', () => {
    const redacted = redactEnv({ PRIVATE_KEY: FAKE_KEY, PINATA_JWT: 'x', PORT: '7860' });
    assert.equal(redacted.PRIVATE_KEY, '[redacted]');
    assert.equal(redacted.PINATA_JWT, '[redacted]');
    assert.equal(redacted.PORT, '7860');
  });

  it('SECRET_KEYS covers every secret the config actually holds', () => {
    for (const key of ['PRIVATE_KEY', 'PINATA_JWT', 'API_AUTH_TOKEN', 'MEMORY_ENCRYPTION_KEY']) {
      assert.ok(SECRET_KEYS.includes(key), `${key} must be in SECRET_KEYS`);
    }
  });
});

describe('config: the singleton is safe to import from a unit test', () => {
  // The non-negotiable constraint for this repository: `npm run test:unit` is
  // `node --test test/backend` with NO environment preset, because npm scripts cannot set an
  // environment variable inline on Windows. Importing the config singleton must therefore never
  // pull in the repository's real `.env` - which holds a funded Sepolia key and a Pinata JWT -
  // and must never select a provider that downloads model weights.
  const config = getConfig();

  it('resolved NODE_ENV to test with nothing set', () => {
    assert.equal(config.app.env, 'test');
    assert.equal(config.app.isTest, true);
  });

  it('selected the mock embedding provider, so no test downloads weights', () => {
    assert.equal(config.embeddings.provider, 'mock');
  });

  it('did not load .env, so no test holds a real key or JWT', () => {
    assert.equal(config.signer.configured, false, 'a unit test must never see a private key');
    assert.equal(config.ipfs.enabled, false, 'a unit test must never see a Pinata JWT');
    assert.equal(config.signer.privateKey, null);
    assert.equal(config.ipfs.jwt, null);
  });

  it('is read-only, so nothing can accidentally spend gas', () => {
    assert.equal(config.signer.readOnly, true);
    assert.equal(config.features.write, false);
  });

  it('binds the loopback address', () => {
    assert.equal(config.http.host, '127.0.0.1');
  });

  it('silences the logger so the suite output stays readable', () => {
    assert.equal(config.logging.level, 'silent');
  });
});
