/**
 * NeuroMesh statistical benchmark harness.
 *
 * Measures each stage of the local commit pipeline over N iterations with warmup,
 * reporting mean / median / p95 / p99 / stddev / min / max rather than the
 * single-run numbers the original prototype published.
 *
 * Runs fully offline. Network-bound stages (IPFS pinning, chain commit) are NOT
 * measured here — they belong to `npm run simulate`, and quoting them from a local
 * harness would misrepresent where the time goes.
 *
 * Usage:
 *   node scripts/benchmark.js                      # real ONNX encoders
 *   node scripts/benchmark.js --iterations 100
 *   node scripts/benchmark.js --provider mock      # no model download
 *   node scripts/benchmark.js --json               # machine-readable only
 *
 * @module scripts/benchmark
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';

const CORPUS = [
  'The user prefers dark mode in all UI elements and uses keyboard shortcuts extensively.',
  'Server response latency should be kept below 200ms for optimal user experience.',
  'The database schema uses normalized tables with foreign key constraints for data integrity.',
  'Machine learning models should be retrained weekly using the latest production data.',
  'Security protocols require AES-256 encryption for all data at rest and TLS 1.3 in transit.',
  'Kubernetes pods should define resource requests and limits to avoid noisy-neighbour effects.',
  'Feature flags must default to off and be removed within two releases of full rollout.',
  'All public API responses include a request identifier for distributed trace correlation.',
];

/**
 * @param {string[]} argv
 * @returns {{iterations: number, warmup: number, provider: string|null, json: boolean, out: string|null}}
 */
function parseArgs(argv) {
  const get = (/** @type {string} */ flag, /** @type {string|null} */ fallback) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    iterations: Math.max(1, Number(get('--iterations', '40'))),
    warmup: Math.max(0, Number(get('--warmup', '5'))),
    provider: get('--provider', null),
    json: argv.includes('--json'),
    out: get('--out', null),
  };
}

/**
 * Summary statistics over a sample of millisecond timings.
 *
 * @param {number[]} samples
 */
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((acc, v) => acc + v, 0) / n;
  const q = (/** @type {number} */ p) => s[Math.min(n - 1, Math.floor(p * n))];
  const variance = s.reduce((acc, v) => acc + (v - mean) ** 2, 0) / n;
  const r = (/** @type {number} */ v) => Number(v.toFixed(4));
  return {
    n,
    mean: r(mean),
    p50: r(q(0.5)),
    p95: r(q(0.95)),
    p99: r(q(0.99)),
    stddev: r(Math.sqrt(variance)),
    min: r(s[0]),
    max: r(s[n - 1]),
  };
}

/**
 * Time a thunk `iterations` times after `warmup` discarded runs.
 *
 * @param {(i: number) => unknown | Promise<unknown>} fn
 * @param {number} iterations
 * @param {number} warmup
 */
async function measure(fn, iterations, warmup) {
  for (let i = 0; i < warmup; i += 1) await fn(i);
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

/** @param {Record<string, ReturnType<typeof stats>>} rows */
function printTable(rows) {
  const entries = Object.entries(rows);
  const w = Math.max(...entries.map(([k]) => k.length), 5);
  process.stdout.write(
    `\n| ${'Stage'.padEnd(w)} |    n |     p50 |     p95 |    mean |  stddev |\n`,
  );
  process.stdout.write(`|${'-'.repeat(w + 2)}|-----:|--------:|--------:|--------:|--------:|\n`);
  for (const [name, s] of entries) {
    process.stdout.write(
      `| ${name.padEnd(w)} | ${String(s.n).padStart(4)} | ` +
        `${s.p50.toFixed(3).padStart(7)} | ${s.p95.toFixed(3).padStart(7)} | ` +
        `${s.mean.toFixed(3).padStart(7)} | ${s.stddev.toFixed(3).padStart(7)} |\n`,
    );
  }
  process.stdout.write('\nAll values in milliseconds. Lower is better.\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // The config module snapshots process.env at import time, so the provider override
  // has to be in place before anything that reads config is imported.
  if (args.provider) process.env.NEUROMESH_EMBEDDING_PROVIDER = args.provider;

  const envelope = await import('../src/protocol/envelope.js');
  const projection = await import('../src/protocol/projection.js');
  const similarity = await import('../src/protocol/similarity.js');
  const canonical = await import('../src/protocol/canonical.js');
  const { PROTOCOL_VERSION } = await import('../src/protocol/constants.js');
  const { createEmbeddingService } = await import('../src/services/embeddings.js');

  const embeddings = createEmbeddingService();

  if (!args.json) {
    process.stdout.write('\nNeuroMesh benchmark\n');
    process.stdout.write(`  protocol    ${PROTOCOL_VERSION}\n`);
    process.stdout.write(`  provider    ${embeddings.provider}\n`);
    process.stdout.write(`  iterations  ${args.iterations} (warmup ${args.warmup})\n`);
    process.stdout.write(`  node        ${process.version} on ${process.platform}/${os.arch()}\n`);
    process.stdout.write(`  cpu         ${os.cpus()[0]?.model ?? 'unknown'}\n\n`);
  }

  /** @type {Record<string, ReturnType<typeof stats>>} */
  const stages = {};
  /** @type {Record<string, number>} */
  const coldLoadMs = {};

  // ── Embedding, per registered model ──────────────────────────────────────
  const t0 = performance.now();
  await embeddings.init();
  await embeddings.whenReady();
  coldLoadMs.init = Number((performance.now() - t0).toFixed(1));

  for (const modelKey of embeddings.models()) {
    try {
      // One call outside the sample both proves the model works and pays any
      // lazy per-model initialisation cost before timing starts.
      await embeddings.embed(CORPUS[0], { model: modelKey });
    } catch (error) {
      if (!args.json) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stdout.write(`  skipping ${modelKey}: ${msg.split('\n')[0]}\n`);
      }
      continue;
    }
    stages[`embed:${modelKey}`] = await measure(
      (i) => embeddings.embed(CORPUS[i % CORPUS.length], { model: modelKey }),
      args.iterations,
      args.warmup,
    );
  }

  // ── Envelope encryption (random CEK + AES-256-GCM with bound AAD) ────────
  const cek = envelope.generateCek();
  const aad = envelope.buildAad({
    agentDid: `did:pkh:eip155:11155111:0x${'11'.repeat(20)}`,
    contentId: envelope.generateContentId(),
    modelId: 'MiniLM',
    keyVersion: 1,
  });
  stages['encrypt:aes-256-gcm'] = await measure(
    (i) => envelope.seal(CORPUS[i % CORPUS.length], { cek, aad }),
    Math.max(args.iterations, 200),
    args.warmup,
  );

  const sealed = envelope.seal(CORPUS[0], { cek, aad });
  stages['decrypt:aes-256-gcm'] = await measure(
    () => envelope.open(sealed, { cek, aad }),
    Math.max(args.iterations, 200),
    args.warmup,
  );

  // ── Deterministic projection 768 -> 384 ──────────────────────────────────
  const v768 = Array.from({ length: 768 }, (_, i) => Math.sin(i) / 2);
  stages['project:768->384'] = await measure(
    () => projection.projectEmbedding(v768, 384),
    Math.max(args.iterations, 100),
    args.warmup,
  );

  // ── Cosine similarity at the shared dimensionality ───────────────────────
  const a = projection.l2Normalize(Array.from({ length: 384 }, (_, i) => Math.cos(i)));
  const b = projection.l2Normalize(Array.from({ length: 384 }, (_, i) => Math.sin(i)));
  stages['cosine:384d'] = await measure(
    () => similarity.cosineSimilarity(a, b),
    Math.max(args.iterations, 2000),
    args.warmup,
  );

  // ── Canonical serialisation (drives content addressing) ──────────────────
  const samplePayload = {
    version: PROTOCOL_VERSION,
    agentDid: `did:pkh:eip155:11155111:0x${'22'.repeat(20)}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    model: { id: 'MiniLM', dim: 384 },
    cipher: sealed,
    nonce: randomBytes(8).toString('hex'),
  };
  stages.canonicalize = await measure(
    () => canonical.canonicalize(samplePayload),
    Math.max(args.iterations, 500),
    args.warmup,
  );

  await embeddings.shutdown();

  const results = {
    generatedAt: new Date().toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    provider: embeddings.provider,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: os.arch(),
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      totalMemGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
    },
    methodology: {
      warmupIterations: args.warmup,
      note:
        'Cold load is reported separately and excluded from inference samples. Network stages ' +
        '(IPFS pin, chain commit) are deliberately not measured here — see `npm run simulate`.',
    },
    coldLoadMs,
    stages,
  };

  const outPath = args.out || path.join(process.cwd(), 'reports', `benchmark-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  printTable(stages);
  process.stdout.write('\nCold start (excluded from samples above):\n');
  for (const [k, v] of Object.entries(coldLoadMs)) {
    process.stdout.write(`  ${k.padEnd(16)} ${v} ms\n`);
  }
  process.stdout.write(`\nWritten to ${path.relative(process.cwd(), outPath)}\n\n`);
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(`\nBenchmark failed: ${error instanceof Error ? error.message : String(error)}`);
});
