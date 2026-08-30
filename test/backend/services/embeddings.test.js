/**
 * Embedding service: the mock provider's determinism, dimensionality, the batch refusal, model
 * identity, and load shedding.
 *
 * Every test here runs with `NEUROMESH_EMBEDDING_PROVIDER=mock` (the default under
 * `NODE_TEST_CONTEXT`), so nothing downloads weights, opens a socket or touches the transformers
 * cache. The one test that exercises the *local* provider injects a `pipelineFactory`, which is the
 * seam that keeps `@huggingface/transformers` from being imported at all.
 *
 * @module test/backend/services/embeddings.test
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { keccak256, toUtf8Bytes } from 'ethers';

import {
  DEFAULT_MODEL_KEY,
  MODEL_REGISTRY,
  chainModelTag,
  createEmbeddingService,
  mockEmbedding,
  modelInfo,
  modelKeyForRepo,
  modelUri,
} from '../../../src/services/embeddings.js';
import { canonical } from '../../../src/protocol/index.js';

import { quietLogger, testConfig } from './helpers.js';

/** `Limits.MAX_MODEL_BYTES` in `contracts/libraries/Limits.sol`. Frozen; the backend must fit it. */
const MAX_MODEL_BYTES = 64;

/**
 * @param {Record<string, string|undefined>} [env] Environment overrides.
 * @returns {any} A service wired to a quiet logger.
 */
function service(env = {}) {
  return createEmbeddingService({ config: testConfig(env), logger: quietLogger() });
}

/**
 * @param {ArrayLike<number>} vector Vector.
 * @returns {number} Its L2 norm.
 */
function norm(vector) {
  let total = 0;
  for (let i = 0; i < vector.length; i += 1) total += vector[i] * vector[i];
  return Math.sqrt(total);
}

describe('services/embeddings: the mock provider', () => {
  it('is a pure function of (text, dim)', () => {
    const a = mockEmbedding('the same sentence', 384);
    const b = mockEmbedding('the same sentence', 384);
    assert.deepEqual([...a], [...b]);
  });

  it('produces a different vector for a different text', () => {
    const a = mockEmbedding('alpha', 384);
    const b = mockEmbedding('beta', 384);
    assert.notDeepEqual([...a], [...b]);
  });

  it('produces a different vector for a different dimensionality', () => {
    const short = mockEmbedding('same text', 384);
    const long = mockEmbedding('same text', 768);
    // The dimension is part of the hashed input, so the 384-d vector is not a prefix of the 768-d
    // one. A construction where it were would make the two silently comparable.
    assert.notDeepEqual([...short], [...long.subarray(0, 384)]);
  });

  it('returns unit vectors at both registered dimensionalities', () => {
    assert.ok(Math.abs(norm(mockEmbedding('x', 384)) - 1) < 1e-6);
    assert.ok(Math.abs(norm(mockEmbedding('x', 768)) - 1) < 1e-6);
  });

  it('fills exactly the requested number of dimensions', () => {
    for (const dim of [1, 7, 8, 9, 384, 768]) {
      assert.equal(mockEmbedding('x', dim).length, dim);
    }
  });

  it('performs no I/O, so it is identical in a second process', () => {
    const local = mockEmbedding('cross-process determinism probe', 384);
    const moduleUrl = pathToFileURL(
      fileURLToPath(new URL('../../../src/services/embeddings.js', import.meta.url)),
    ).href;
    // A second, independent Node process. Anything stateful — a PRNG, a clock, a cached matrix —
    // would show up here as a different vector, which is exactly the failure mode that made the
    // original random projection meaningless across processes.
    const stdout = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { mockEmbedding } = await import(${JSON.stringify(moduleUrl)});
         process.stdout.write(Buffer.from(mockEmbedding('cross-process determinism probe', 384).buffer).toString('hex'));`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(stdout, Buffer.from(local.buffer).toString('hex'));
  });
});

describe('services/embeddings: model identity', () => {
  it('registers MiniLM at 384 and distilRoBERTa at 768', () => {
    assert.equal(MODEL_REGISTRY.MiniLM.dim, 384);
    assert.equal(MODEL_REGISTRY.distilRoBERTa.dim, 768);
  });

  it('maps a repository name back to its registry key', () => {
    assert.equal(modelKeyForRepo('Xenova/all-MiniLM-L6-v2'), 'MiniLM');
    assert.equal(modelKeyForRepo('Xenova/all-distilroberta-v1'), 'distilRoBERTa');
    assert.equal(modelKeyForRepo('someone/unknown-model'), null);
  });

  it('sorts the URI query parameters, so the URI is canonical', () => {
    const uri = modelUri('MiniLM');
    assert.match(uri, /^hf:Xenova\/all-MiniLM-L6-v2\?normalize=true&pooling=mean$/);
  });

  it('derives the model id as the keccak of the canonical URI', () => {
    const info = modelInfo('MiniLM');
    assert.equal(info.id, keccak256(toUtf8Bytes(info.uri)));
  });

  it('reports pinned:false rather than inventing a weights digest', () => {
    // The registry has no digest until scripts/gen-model-registry.js hashes a downloaded .onnx.
    // A fabricated hash in the payload and on the chain would be worse than an admitted gap.
    assert.equal(modelInfo('MiniLM').pinned, false);
    assert.equal(MODEL_REGISTRY.MiniLM.weightsDigest, null);
  });

  it('produces an on-chain model tag that fits Limits.MAX_MODEL_BYTES', () => {
    for (const key of Object.keys(MODEL_REGISTRY)) {
      const tag = chainModelTag(key);
      assert.ok(
        Buffer.byteLength(tag, 'utf8') <= MAX_MODEL_BYTES,
        `${key} tag is ${Buffer.byteLength(tag, 'utf8')} bytes, over the ${MAX_MODEL_BYTES} cap`,
      );
    }
  });

  it('makes the tag a lossless commitment to the URI, not an abbreviation of it', () => {
    const info = modelInfo('distilRoBERTa');
    const expected = `nm1:${canonical.b64u(Uint8Array.from(Buffer.from(info.id.slice(2), 'hex')))}`;
    assert.equal(info.chainModel, expected);
    assert.equal(chainModelTag('distilRoBERTa'), expected);
  });

  it('refuses an unregistered model by name', () => {
    assert.throws(
      () => modelUri('NotAModel'),
      (err) => /** @type {any} */ (err).status === 400,
    );
  });
});

describe('services/embeddings: lifecycle', () => {
  it('performs no I/O at construction and starts idle', () => {
    const svc = service();
    assert.equal(svc.isReady(), false);
    assert.equal(svc.state().status, 'idle');
    assert.equal(svc.provider, 'mock');
  });

  it('refuses inference before the model is ready, with 503 model_not_ready', async () => {
    const svc = service();
    await assert.rejects(svc.embed('anything'), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 503);
      assert.equal(any.code, 'model_not_ready');
      return true;
    });
  });

  it('becomes ready after init and reports its state', async () => {
    const svc = service();
    await svc.init();
    assert.equal(svc.isReady(), true);
    const state = svc.state();
    assert.equal(state.status, 'ready');
    assert.equal(state.provider, 'mock');
    assert.equal(state.model, DEFAULT_MODEL_KEY);
    assert.equal(state.dim, 384);
    assert.ok(typeof state.loadMs === 'number');
  });

  it('is idempotent: a second init returns the same promise', async () => {
    const svc = service();
    const first = svc.init();
    const second = svc.init();
    assert.equal(first, second);
    await first;
  });
});

describe('services/embeddings: inference', () => {
  it('returns a vector whose length is read from the vector, never hardcoded', async () => {
    const svc = service();
    await svc.init();
    const result = await svc.embed('a memory worth keeping');
    assert.equal(result.vector.length, 384);
    assert.equal(result.dim, result.vector.length);
    assert.equal(result.modelKey, 'MiniLM');
    assert.equal(result.provider, 'mock');
  });

  it('honours a per-call model selection at its own dimensionality', async () => {
    const svc = service();
    await svc.init();
    const result = await svc.embed('a memory worth keeping', { model: 'distilRoBERTa' });
    assert.equal(result.dim, 768);
    assert.equal(result.modelName, 'Xenova/all-distilroberta-v1');
  });

  it('rejects an array instead of treating it as a batch', async () => {
    const svc = service();
    await svc.init();
    await assert.rejects(svc.embed(/** @type {any} */ (['a', 'b'])), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 400);
      // This is the exact defect: an array became an n x 384 batch whose flattened length was
      // committed on chain as embeddingDim 384.
      assert.match(any.message, /batch/i);
      return true;
    });
  });

  it('rejects an empty string and a non-string', async () => {
    const svc = service();
    await svc.init();
    await assert.rejects(svc.embed(''), (err) => /** @type {any} */ (err).status === 400);
    await assert.rejects(
      svc.embed(/** @type {any} */ (undefined)),
      (err) => /** @type {any} */ (err).status === 400,
    );
  });

  it('refuses a context over MAX_CONTEXT_CHARS with 413', async () => {
    const svc = service({ MAX_CONTEXT_CHARS: '32' });
    await svc.init();
    await assert.rejects(svc.embed('x'.repeat(33)), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 413);
      return true;
    });
  });

  it('flags probable truncation as a warning rather than silently clipping', async () => {
    const svc = service();
    await svc.init();
    // MiniLM's window is 256 tokens and the estimator is ~4 characters per token.
    const long = await svc.embed('word '.repeat(400));
    assert.equal(long.truncated, true);
    const short = await svc.embed('a short memory');
    assert.equal(short.truncated, false);
  });

  it('embeds many texts one at a time, each with its own dimension check', async () => {
    const svc = service();
    await svc.init();
    const results = await svc.embedMany(['one', 'two', 'three']);
    assert.equal(results.length, 3);
    assert.deepEqual(
      results.map((r) => r.dim),
      [384, 384, 384],
    );
    assert.notDeepEqual([...results[0].vector], [...results[1].vector]);
  });

  it('records a latency sample per call', async () => {
    const svc = service();
    await svc.init();
    await svc.embed('one');
    await svc.embed('two');
    assert.ok(svc.state().latency.count >= 2);
  });
});

describe('services/embeddings: load shedding', () => {
  it('sheds with 503 overloaded rather than queueing without limit', async () => {
    /** @type {Array<() => void>} */
    const releases = [];
    const svc = createEmbeddingService({
      // The `local` provider plus an injected pipelineFactory is the seam that lets a test drive a
      // slow session without importing @huggingface/transformers or touching the network.
      config: testConfig({
        NEUROMESH_EMBEDDING_PROVIDER: 'local',
        // One model, not two: the default alternate is distilRoBERTa at 768, and this fake session
        // answers at 384 for every model, which the load-time shape assertion would (rightly) reject.
        EMBEDDING_MODEL_ALT: 'Xenova/all-MiniLM-L6-v2',
        EMBED_QUEUE_MAX: '2',
      }),
      logger: quietLogger(),
      pipelineFactory: async () => async () => {
        await new Promise((resolve) => releases.push(() => resolve(undefined)));
        return { data: mockEmbedding('slow', 384) };
      },
    });
    // The shape probe during init is itself one queued call, so release it before measuring.
    const ready = svc.init();
    await waitFor(() => releases.length >= 1);
    releases.shift()?.();
    await ready;
    assert.equal(svc.isReady(), true);

    const first = svc.embed('one');
    const second = svc.embed('two');
    await waitFor(() => svc.state().queueDepth + svc.state().inflight >= 2);
    await assert.rejects(svc.embed('three'), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 503);
      assert.equal(any.code, 'overloaded');
      assert.match(any.message, /shedding load/i);
      return true;
    });

    // Let the two accepted calls finish. A drainer rather than a fixed sequence of releases, so the
    // test does not encode an assumption about how the queue interleaves.
    const drainer = setInterval(() => {
      while (releases.length) releases.shift()?.();
    }, 1);
    await Promise.all([first, second]);
    clearInterval(drainer);
  });

  it('serializes inference so the session is never entered twice at once', async () => {
    let concurrent = 0;
    let peak = 0;
    const svc = createEmbeddingService({
      config: testConfig({
        NEUROMESH_EMBEDDING_PROVIDER: 'local',
        EMBEDDING_MODEL_ALT: 'Xenova/all-MiniLM-L6-v2',
      }),
      logger: quietLogger(),
      pipelineFactory: async () => async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 1));
        concurrent -= 1;
        return { data: mockEmbedding('serialized', 384) };
      },
    });
    await svc.init();
    await Promise.all([svc.embed('a'), svc.embed('b'), svc.embed('c'), svc.embed('d')]);
    // The ONNX session is not safely reentrant. One at a time is the contract, not an optimisation.
    assert.equal(peak, 1);
  });

  it('keeps the queue running after one call rejects', async () => {
    let calls = 0;
    const svc = createEmbeddingService({
      config: testConfig({
        NEUROMESH_EMBEDDING_PROVIDER: 'local',
        EMBEDDING_MODEL_ALT: 'Xenova/all-MiniLM-L6-v2',
      }),
      logger: quietLogger(),
      pipelineFactory: async () => async () => {
        calls += 1;
        if (calls === 2) throw new Error('one bad inference');
        return { data: mockEmbedding(`call-${calls}`, 384) };
      },
    });
    await svc.init();
    await assert.rejects(svc.embed('this one fails'));
    const after = await svc.embed('this one must still work');
    assert.equal(after.dim, 384);
  });
});

describe('services/embeddings: shape assertion at load', () => {
  it('refuses a model whose output dimensionality contradicts the registry', async () => {
    const svc = createEmbeddingService({
      config: testConfig({
        NEUROMESH_EMBEDDING_PROVIDER: 'local',
        EMBEDDING_MODEL_ALT: 'Xenova/all-MiniLM-L6-v2',
      }),
      logger: quietLogger(),
      // The weights behind a fixed name changed. Every vector from them would be incomparable with
      // the ones already committed, and the committed embeddingDim would be a permanent false record.
      pipelineFactory: async () => async () => ({ data: mockEmbedding('wrong shape', 512) }),
    });
    await svc.init();
    assert.equal(svc.state().status, 'failed');
    assert.match(String(svc.state().error?.message), /512 dimensions/);
    await assert.rejects(svc.embed('anything'), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 503);
      return true;
    });
  });

  it('refuses a model that does not return unit vectors', async () => {
    const svc = createEmbeddingService({
      config: testConfig({
        NEUROMESH_EMBEDDING_PROVIDER: 'local',
        EMBEDDING_MODEL_ALT: 'Xenova/all-MiniLM-L6-v2',
      }),
      logger: quietLogger(),
      pipelineFactory: async () => async () => ({
        data: Float32Array.from(mockEmbedding('unnormalised', 384), (v) => v * 3),
      }),
    });
    await svc.init();
    assert.equal(svc.state().status, 'failed');
    assert.match(String(svc.state().error?.message), /L2 norm/);
  });
});

/**
 * Poll until a predicate holds, without a fixed sleep.
 *
 * @param {() => boolean} predicate What to wait for.
 * @param {number} [timeoutMs] Budget.
 * @returns {Promise<void>} Resolves when the predicate holds.
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
