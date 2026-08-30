/**
 * Embedding service: model lifecycle, a bounded serialized inference queue, and a deterministic
 * mock provider.
 *
 * ## The three defects this module exists to remove
 *
 * 1. **Model loading blocked the port.** v1 had `const extractor = await pipeline(...)` at module
 *    scope, above `const app = express()`. Nothing listened until a ~90 MB download finished, so
 *    every liveness probe failed, the orchestrator restarted the container, and the download began
 *    again - a loop with no terminating condition. Here, nothing is loaded at import: `init()`
 *    starts the load in the background and returns immediately, `isReady()` and `state()` report
 *    progress, and the HTTP layer answers `503 model_not_ready` in the meantime.
 * 2. **Unbounded concurrent inference.** The ONNX session underneath `@huggingface/transformers` is
 *    not safely reentrant, and even if it were, N concurrent 90 MB sessions is an OOM. Calls are
 *    serialized through a queue of concurrency 1, bounded at `config.embeddings.queueMax`, shedding
 *    with `503 overloaded` rather than buffering without limit.
 * 3. **An array silently became a batch.** v1 read `const { context } = req.body` with no schema and
 *    passed it straight in. An array is a *batch* to the tokenizer: `output.data` comes back as
 *    n x 384 floats, `embedding.length` is 768 or 1920, and the ledger recorded a hardcoded
 *    `embeddingDim: 384` - a permanent, unfixable false record. {@link createEmbeddingService}
 *    rejects a non-string outright, and `dim` is always read from the decoded vector.
 *
 * ## The mock provider is the default under test
 *
 * `npm run test:unit` runs `node --test test/backend` with no environment preset, so
 * `src/config/env.js` defaults `NEUROMESH_EMBEDDING_PROVIDER` to `mock` whenever
 * `NODE_TEST_CONTEXT` is set. The mock derives a unit vector from `sha512` of the text, so it is
 * deterministic **across processes and machines** - a property a test asserts by spawning a second
 * Node process - and it performs no I/O of any kind. No unit test downloads weights.
 *
 * `@huggingface/transformers` is loaded with a dynamic `import()` inside the local provider, never
 * at module scope, so a mock-provider run never even parses it.
 *
 * ## Model identity is a digest, not a name
 *
 * `all-MiniLM-L6-v2` is a name, not a version. The weights behind it can be re-uploaded,
 * re-quantised or re-exported to ONNX; every such change moves the embedding space while the name
 * stays put, and a similarity computed against the old space is then quietly wrong.
 * {@link modelInfo} therefore builds a canonical URI carrying the weights digest and derives
 * `id = keccak256(utf8(uri))` from it.
 *
 * See {@link MODEL_REGISTRY} for the one place a digest can be absent, and {@link chainModelTag}
 * for why the on-chain string is not the URI.
 *
 * @module src/services/embeddings
 */
import { createHash } from 'node:crypto';

import { keccak256, toUtf8Bytes } from 'ethers';

import { getConfig } from '../config/index.js';
import { errors } from '../errors.js';
import { logger as defaultLogger } from '../logger.js';
import { canonical, constants } from '../protocol/index.js';
import { LatencyRing, normalizeMetrics, withDeadline } from './instrument.js';

/**
 * The models this build understands, keyed by the short name callers use.
 *
 * `weightsDigest` is `null` for both entries and that is a deliberate, visible gap rather than a
 * fabricated value: the digest must be the sha2-256 of the actual `.onnx` file, produced by
 * `scripts/gen-model-registry.js` after a download. Inventing one would put a hash in the payload
 * and on the chain that corresponds to nothing, which is worse than admitting the model is
 * unpinned. Until the generator runs, {@link modelInfo} emits `pinned: false` and a URI with no
 * `@sha256:` component, and the caller can surface that.
 *
 * @type {Readonly<Record<string, {repo: string, dim: number, weightsDigest: string|null,
 *   maxSequenceLength: number, pooling: 'mean', normalize: true}>>}
 */
export const MODEL_REGISTRY = Object.freeze({
  MiniLM: Object.freeze({
    repo: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    weightsDigest: null,
    maxSequenceLength: 256,
    pooling: /** @type {'mean'} */ ('mean'),
    normalize: /** @type {true} */ (true),
  }),
  distilRoBERTa: Object.freeze({
    repo: 'Xenova/all-distilroberta-v1',
    dim: 768,
    weightsDigest: null,
    maxSequenceLength: 512,
    pooling: /** @type {'mean'} */ ('mean'),
    normalize: /** @type {true} */ (true),
  }),
});

/** The model key used when a caller does not name one. */
export const DEFAULT_MODEL_KEY = 'MiniLM';

/**
 * Domain-separation label for the mock provider's keystream. Part of the hashed input, so changing
 * it changes every mock vector - which is exactly what should happen if the construction changes.
 */
const MOCK_LABEL = 'neuromesh/mock-embedding/v1';

/**
 * Map a repository name back to its registry key.
 *
 * @param {string} repo Hugging Face repository, e.g. `Xenova/all-MiniLM-L6-v2`.
 * @returns {string|null} The registry key, or `null` when the repo is unknown.
 */
export function modelKeyForRepo(repo) {
  const found = Object.entries(MODEL_REGISTRY).find(([, entry]) => entry.repo === repo);
  return found ? found[0] : null;
}

/**
 * The canonical model URI: `hf:<repo>[@sha256:<digest>]?normalize=true&pooling=mean`.
 *
 * Query parameters are sorted lexicographically so the URI is a canonical string and its keccak is
 * stable. The digest, when known, pins the exact weights that produced the vector.
 *
 * @param {string} modelKey Registry key.
 * @returns {string} The URI.
 * @throws {import('../errors.js').AppError} 422 `unknown_model` when the key is not registered.
 */
export function modelUri(modelKey) {
  const entry = requireModel(modelKey);
  const digest = entry.weightsDigest ? `@sha256:${entry.weightsDigest}` : '';
  return `hf:${entry.repo}${digest}?normalize=${String(entry.normalize)}&pooling=${entry.pooling}`;
}

/**
 * The string written into `MemoryLedger.MemoryInput.model`.
 *
 * ## Why this is not the URI
 *
 * `contracts/libraries/Limits.sol` caps `MAX_MODEL_BYTES` at 64 and `MemoryLedger` validates
 * `input.model` against it. A digest-pinned URI is ~126 bytes, so committing one reverts with
 * `StringTooLong('model', 126, 64)` - and it reverts at `estimateGas`, so no memory could ever be
 * written. The contracts are frozen, so the backend must send something shorter.
 *
 * The tag is `nm1:` plus the base64url of `keccak256(utf8(uri))`: 4 + 43 = 47 bytes, comfortably
 * inside the cap, and a *lossless* commitment to the URI rather than a lossy abbreviation of it. The
 * human-readable URI travels in the IPFS payload as `model.uri`, and `model.id` is the same keccak
 * in hex, so the chain record and the payload are bound by an equality anyone can check:
 *
 *     chainModelTag(key) === 'nm1:' + base64url(payload.model.id)
 *
 * The EIP-712 `MemoryCommit.modelHash` is `keccak256(bytes(input.model))` computed by the contract
 * over *this* string, which is what the signature covers.
 *
 * @param {string} modelKey Registry key.
 * @returns {string} A model tag of at most 47 bytes.
 */
export function chainModelTag(modelKey) {
  const id = keccak256(toUtf8Bytes(modelUri(modelKey)));
  return `nm1:${canonical.b64u(Uint8Array.from(Buffer.from(id.slice(2), 'hex')))}`;
}

/**
 * Everything identifying one model.
 *
 * @param {string} modelKey Registry key.
 * @returns {{key: string, name: string, repo: string, dim: number, uri: string, id: string,
 *   chainModel: string, pinned: boolean, maxSequenceLength: number}} Model identity.
 */
export function modelInfo(modelKey) {
  const entry = requireModel(modelKey);
  const uri = modelUri(modelKey);
  return {
    key: modelKey,
    name: entry.repo,
    repo: entry.repo,
    dim: entry.dim,
    uri,
    id: keccak256(toUtf8Bytes(uri)),
    chainModel: chainModelTag(modelKey),
    pinned: entry.weightsDigest !== null,
    maxSequenceLength: entry.maxSequenceLength,
  };
}

/**
 * @param {string} modelKey Registry key.
 * @returns {(typeof MODEL_REGISTRY)[keyof typeof MODEL_REGISTRY]} The registry entry.
 */
function requireModel(modelKey) {
  const entry = /** @type {Record<string, any>} */ (MODEL_REGISTRY)[modelKey];
  if (!entry) {
    throw errors.badRequest(
      `Unknown embedding model "${modelKey}". Known models: ${Object.keys(MODEL_REGISTRY).join(', ')}.`,
      { modelKey, known: Object.keys(MODEL_REGISTRY) },
    );
  }
  return entry;
}

/**
 * Deterministic pseudo-embedding, derived from the text alone.
 *
 * Construction, stated so it can be reimplemented: successive `sha512` blocks are drawn over
 * `"<label>|<dim>|<counter>|<text>"`, each block is read as eight big-endian `uint32` words, each
 * word is mapped into `[-1, 1)`, and the resulting vector is L2-normalised. There is no PRNG state,
 * no clock and no `Math.random`, so the output is a pure function of `(text, dim)` and is identical
 * in every process on every machine.
 *
 * It is a *stand-in*, not an approximation: two semantically similar sentences produce unrelated
 * vectors. It exists so the pipeline can be exercised end to end without a 90 MB download, and any
 * test that asserts a semantic property of a mock vector is asserting nonsense.
 *
 * @param {string} text Input text.
 * @param {number} dim Output dimensionality.
 * @returns {Float32Array} A unit vector of length `dim`.
 */
export function mockEmbedding(text, dim) {
  const out = new Float32Array(dim);
  let i = 0;
  let counter = 0;
  while (i < dim) {
    const block = createHash('sha512').update(`${MOCK_LABEL}|${dim}|${counter}|${text}`).digest();
    for (let offset = 0; offset + 4 <= block.length && i < dim; offset += 4) {
      out[i] = (block.readUInt32BE(offset) / 0x100000000) * 2 - 1;
      i += 1;
    }
    counter += 1;
  }
  let norm = 0;
  for (let j = 0; j < dim; j += 1) norm += out[j] * out[j];
  norm = Math.sqrt(norm);
  /* c8 ignore next -- a zero vector out of sha512 is not reachable */
  if (norm === 0) return out;
  for (let j = 0; j < dim; j += 1) out[j] /= norm;
  return out;
}

/**
 * The embedding service's observable state.
 *
 * @typedef {object} EmbeddingState
 * @property {'idle'|'loading'|'ready'|'failed'} status Load state.
 * @property {'local'|'mock'} provider Which provider is in force.
 * @property {string} model Registry key of the primary model.
 * @property {number} dim Dimensionality of the primary model.
 * @property {string|null} loadedAt ISO timestamp of the successful load.
 * @property {number|null} loadMs Duration of the successful load.
 * @property {{code: string, message: string}|null} error Why the load failed, if it did.
 * @property {number} queueDepth Calls waiting for the session.
 * @property {number} inflight Calls currently running (0 or 1).
 * @property {number} attempts Load attempts made so far.
 * @property {ReturnType<LatencyRing['stats']>} latency Recent inference latency, in milliseconds.
 */

/**
 * Create the embedding service.
 *
 * Construction performs no I/O and never throws for a reason a running node could recover from; the
 * model is contacted only by {@link EmbeddingService.init}.
 *
 * @param {object} [deps] Dependencies.
 * @param {ReturnType<typeof getConfig>} [deps.config] Application config.
 * @param {any} [deps.logger] Pino logger.
 * @param {import('./instrument.js').MetricsLike} [deps.metrics] Metrics collector.
 * @param {(repo: string) => Promise<(text: string, options: object) => Promise<any>>} [deps.pipelineFactory]
 *   Test seam: builds the inference callable for a repo. Defaults to a dynamic import of
 *   `@huggingface/transformers`, so the library is never loaded under the mock provider.
 * @returns {EmbeddingService} The service.
 */
export function createEmbeddingService({
  config = getConfig(),
  logger = defaultLogger,
  metrics,
  pipelineFactory,
} = {}) {
  const log = logger.child ? logger.child({ service: 'embeddings' }) : logger;
  const instruments = normalizeMetrics(metrics);
  const provider = config.embeddings.provider === 'mock' ? 'mock' : 'local';
  const primaryKey = modelKeyForRepo(config.embeddings.model) ?? DEFAULT_MODEL_KEY;
  const maxAttempts = 3;

  /** @type {'idle'|'loading'|'ready'|'failed'} */
  let status = 'idle';
  /** @type {Promise<void>|null} */
  let loadPromise = null;
  /** @type {Map<string, (text: string, options: object) => Promise<any>>} */
  const extractors = new Map();
  /** @type {string|null} */
  let loadedAt = null;
  /** @type {number|null} */
  let loadMs = null;
  /** @type {{code: string, message: string}|null} */
  let loadError = null;
  let attempts = 0;
  let stopped = false;

  const latency = new LatencyRing(200);

  /** Serialized inference: exactly one call touches the session at a time. */
  let queueDepth = 0;
  let inflight = 0;
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();

  /**
   * Run `fn` on the single-slot inference queue.
   *
   * The queue is a promise chain rather than a semaphore because a semaphore released across an
   * `await` boundary can be acquired twice under the right interleaving; a chain cannot.
   *
   * @template T
   * @param {() => Promise<T>} fn Work to serialize.
   * @returns {Promise<T>} Result of `fn`.
   */
  function enqueue(fn) {
    if (queueDepth + inflight >= config.embeddings.queueMax) {
      instruments.increment('neuromesh_embedding_shed_total', { reason: 'queue_full' });
      return Promise.reject(
        errors.overloaded({ queue: 'embeddings', max: config.embeddings.queueMax }),
      );
    }
    queueDepth += 1;
    instruments.gauge('neuromesh_embedding_queue_depth', queueDepth);
    const run = tail.then(
      async () => {
        queueDepth -= 1;
        inflight += 1;
        instruments.gauge('neuromesh_embedding_queue_depth', queueDepth);
        try {
          return await fn();
        } finally {
          inflight -= 1;
        }
      },
      async () => {
        // The previous link rejected. That is that call's problem, not this one's: the chain must
        // keep running, so the rejection is absorbed here and this link proceeds normally.
        queueDepth -= 1;
        inflight += 1;
        try {
          return await fn();
        } finally {
          inflight -= 1;
        }
      },
    );
    // `tail` must never hold a rejection that nothing awaits, or Node reports an unhandled
    // rejection for a failure the caller is already handling.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Build the inference callable for one model, honouring the configured provider.
   *
   * @param {string} modelKey Registry key.
   * @returns {Promise<(text: string, options: object) => Promise<any>>} The callable.
   */
  async function buildExtractor(modelKey) {
    const entry = requireModel(modelKey);
    if (provider === 'mock') {
      return async (text) => ({ data: mockEmbedding(text, entry.dim), dims: [1, entry.dim] });
    }
    if (pipelineFactory) return pipelineFactory(entry.repo);

    // Imported here, not at module scope: under the mock provider this line never runs, so a unit
    // test never parses the library, never touches the filesystem cache and never reaches the
    // network.
    const { pipeline, env: hfEnv } = await import('@huggingface/transformers');
    hfEnv.cacheDir = config.embeddings.cacheDir;
    // Belt and braces against the acceptance criterion "no test downloads weights": even if a test
    // somehow selected the local provider, remote resolution is off.
    hfEnv.allowRemoteModels = !config.app.isTest;
    const extractor = await pipeline('feature-extraction', entry.repo);
    return /** @type {any} */ (extractor);
  }

  /**
   * Load the models, once.
   *
   * @param {object} [options] Options.
   * @param {boolean} [options.force] Retry after a latched failure. This is an operator action:
   *   a failed load stays failed rather than retrying in a hot loop, which is how the v1 container
   *   turned a slow download into an infinite one.
   * @returns {Promise<void>} Resolves when the models are usable; never rejects.
   */
  function init(options = {}) {
    if (stopped) return Promise.resolve();
    if (loadPromise && !(options.force && status === 'failed')) return loadPromise;
    if (options.force) {
      status = 'idle';
      loadError = null;
    }

    status = 'loading';
    const started = performance.now();
    loadPromise = (async () => {
      const keys = uniqueModelKeys(config);
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        attempts += 1;
        try {
          for (const key of keys) {
            if (extractors.has(key)) continue;
            const extractor = await withDeadline(
              buildExtractor(key),
              config.embeddings.loadTimeoutMs,
              () =>
                errors.upstreamTimeout(
                  `Loading embedding model "${key}" exceeded ${config.embeddings.loadTimeoutMs} ms.`,
                ),
            );
            await assertModelShape(key, extractor);
            extractors.set(key, extractor);
          }
          status = 'ready';
          loadMs = performance.now() - started;
          loadedAt = new Date().toISOString();
          loadError = null;
          log.info?.({ provider, models: keys, loadMs }, 'embedding models ready');
          return;
        } catch (err) {
          const isLast = attempt === maxAttempts - 1;
          log.warn?.(
            { attempt: attempt + 1, maxAttempts, err: describe(err) },
            'embedding model load failed',
          );
          if (isLast) {
            status = 'failed';
            loadError = describe(err);
            log.error?.(
              { err: loadError },
              'embedding model load latched failed; call init({force:true}) to retry',
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    })();
    return loadPromise;
  }

  /**
   * Assert that a freshly loaded model produces vectors of the dimensionality the registry claims.
   *
   * A model swapped under a fixed name is the failure this catches, and it must fail loudly at load
   * rather than quietly at commit time - a wrong `embeddingDim` on chain is permanent.
   *
   * @param {string} modelKey Registry key.
   * @param {(text: string, options: object) => Promise<any>} extractor Inference callable.
   * @returns {Promise<void>} Resolves when the shape checks out.
   */
  async function assertModelShape(modelKey, extractor) {
    const entry = requireModel(modelKey);
    const probe = await extractor('neuromesh model shape probe', {
      pooling: entry.pooling,
      normalize: entry.normalize,
    });
    const vector = toFloat32(probe);
    if (vector.length !== entry.dim) {
      throw errors.upstream(
        `Model "${entry.repo}" returned ${vector.length} dimensions; the registry declares ` +
          `${entry.dim}. The weights behind this name have changed, and every vector produced ` +
          'from them would be incomparable with the ones already committed.',
        { modelKey, expected: entry.dim, actual: vector.length },
      );
    }
    const norm = Math.sqrt(vector.reduce((acc, value) => acc + value * value, 0));
    if (Math.abs(norm - 1) > 1e-3) {
      throw errors.upstream(
        `Model "${entry.repo}" returned a vector with L2 norm ${norm.toFixed(6)}; the pipeline is ` +
          'called with normalize:true and every downstream cosine assumes unit vectors.',
        { modelKey, norm },
      );
    }
  }

  /**
   * Embed one piece of text.
   *
   * @param {string} text Text to embed. Must be a non-empty string; an array is rejected rather
   *   than treated as a batch.
   * @param {object} [options] Options.
   * @param {string} [options.model] Registry key; defaults to the configured primary model.
   * @returns {Promise<{vector: Float32Array, dim: number, modelKey: string, modelName: string,
   *   modelId: string, modelUri: string, chainModel: string, pinned: boolean, tokenCount: number|null,
   *   truncated: boolean, provider: 'local'|'mock', durationMs: number}>} The embedding and its
   *   provenance.
   */
  async function embed(text, options = {}) {
    const modelKey = options.model ?? primaryKey;
    const entry = requireModel(modelKey);

    if (Array.isArray(text)) {
      throw errors.badRequest(
        'embed() takes a single string. Passing an array makes the tokenizer produce a batch, ' +
          'whose flattened length is a multiple of the model dimension - which is how v1 committed ' +
          'embeddingDim 384 for a 1920-float payload. Call embedMany() for batches.',
        { received: 'array' },
      );
    }
    if (typeof text !== 'string' || text.length === 0) {
      throw errors.badRequest('embed() requires a non-empty string.', {
        received: typeof text,
      });
    }
    if (text.length > config.embeddings.maxContextChars) {
      throw errors.payloadTooLarge(config.embeddings.maxContextChars, text.length);
    }
    if (status !== 'ready') {
      // Kick the load if nobody has yet; still refuse this call rather than making the client wait
      // out a multi-minute download behind an open socket.
      if (status === 'idle') void init();
      throw status === 'failed' ? modelFailed(loadError) : errors.modelNotReady();
    }
    const extractor = extractors.get(modelKey);
    if (!extractor) {
      // A secondary model that was not in the warmup set: load it on demand, still serialized.
      await init();
      if (!extractors.get(modelKey)) {
        const built = await buildExtractor(modelKey);
        await assertModelShape(modelKey, built);
        extractors.set(modelKey, built);
      }
    }

    const stop = instruments.timer('neuromesh_embedding_duration_seconds', {
      model: modelKey,
      provider,
    });
    const result = await enqueue(async () =>
      withDeadline(
        /** @type {(text: string, options: object) => Promise<any>} */ (extractors.get(modelKey))(
          text,
          { pooling: entry.pooling, normalize: entry.normalize },
        ),
        config.embeddings.inferTimeoutMs,
        () =>
          errors.upstreamTimeout(
            `Embedding inference exceeded ${config.embeddings.inferTimeoutMs} ms.`,
          ),
      ),
    );
    const durationMs = stop();
    latency.observe(durationMs);

    const vector = toFloat32(result);
    if (vector.length !== entry.dim) {
      throw errors.upstream(
        `Model "${entry.repo}" returned ${vector.length} floats for a single input; the registry ` +
          `declares ${entry.dim}. Refusing to commit a dimension the payload contradicts.`,
        { expected: entry.dim, actual: vector.length },
      );
    }
    const info = modelInfo(modelKey);
    const { tokenCount, truncated } = estimateTokens(text, entry);
    return {
      vector,
      dim: vector.length,
      modelKey,
      modelName: info.name,
      modelId: info.id,
      modelUri: info.uri,
      chainModel: info.chainModel,
      pinned: info.pinned,
      tokenCount,
      truncated,
      provider,
      durationMs,
    };
  }

  /**
   * Embed several texts, still one at a time through the same queue.
   *
   * Explicitly sequential: batching inside the session would be faster but would reintroduce the
   * flattened-batch ambiguity this service exists to prevent, and the caller gets a per-item
   * dimension assertion this way.
   *
   * @param {string[]} texts Texts to embed.
   * @param {object} [options] Options, as {@link embed}.
   * @returns {Promise<Array<Awaited<ReturnType<typeof embed>>>>} One result per input.
   */
  async function embedMany(texts, options = {}) {
    if (!Array.isArray(texts)) throw errors.badRequest('embedMany() requires an array of strings.');
    const out = [];
    for (const text of texts) out.push(await embed(text, options));
    return out;
  }

  /**
   * @returns {EmbeddingState} The current state.
   */
  function state() {
    return {
      status,
      provider,
      model: primaryKey,
      dim: requireModel(primaryKey).dim,
      loadedAt,
      loadMs,
      error: loadError,
      queueDepth,
      inflight,
      attempts,
      latency: latency.stats(),
    };
  }

  /** @type {EmbeddingService} */
  const service = {
    init,
    state,
    isReady: () => status === 'ready',
    whenReady: () => init(),
    embed,
    embedMany,
    modelInfo,
    models: () => Object.keys(MODEL_REGISTRY),
    provider,
    async shutdown() {
      stopped = true;
      // Let whatever is on the queue finish; the session itself has no close() to call.
      await tail.catch(() => undefined);
      extractors.clear();
    },
  };
  return service;
}

/**
 * @typedef {object} EmbeddingService
 * @property {(options?: {force?: boolean}) => Promise<void>} init Start (or restart) the load.
 * @property {() => EmbeddingState} state Observable state, for /readyz and /api/v1/status.
 * @property {() => boolean} isReady Whether inference will be accepted right now.
 * @property {() => Promise<void>} whenReady The readiness promise.
 * @property {(text: string, options?: {model?: string}) => Promise<any>} embed Embed one string.
 * @property {(texts: string[], options?: {model?: string}) => Promise<any[]>} embedMany Embed many.
 * @property {(modelKey: string) => ReturnType<typeof modelInfo>} modelInfo Model identity.
 * @property {() => string[]} models Known registry keys.
 * @property {'local'|'mock'} provider Active provider.
 * @property {() => Promise<void>} shutdown Stop accepting work and release the sessions.
 */

/**
 * The distinct models a node should warm: the primary, plus the alternate when it is a different
 * registered model. An unknown `EMBEDDING_MODEL_ALT` is skipped rather than failing the load - a
 * node should not refuse to start because its *secondary* model is misconfigured.
 *
 * @param {ReturnType<typeof getConfig>} config Application config.
 * @returns {string[]} Registry keys to load.
 */
function uniqueModelKeys(config) {
  const keys = [modelKeyForRepo(config.embeddings.model) ?? DEFAULT_MODEL_KEY];
  const alt = modelKeyForRepo(config.embeddings.altModel);
  if (alt && !keys.includes(alt)) keys.push(alt);
  return keys;
}

/**
 * Coerce a pipeline result into a `Float32Array`.
 *
 * `@huggingface/transformers` returns a Tensor whose `.data` is a typed array; the mock provider
 * returns the same shape. A bare array is accepted for the benefit of an injected test double.
 *
 * @param {any} result Pipeline output.
 * @returns {Float32Array} The vector.
 */
function toFloat32(result) {
  const data = result?.data ?? result;
  if (data instanceof Float32Array) return data;
  if (ArrayBuffer.isView(data) || Array.isArray(data))
    return Float32Array.from(/** @type {any} */ (data));
  throw errors.upstream('The embedding pipeline returned no vector data.', {
    received: typeof data,
  });
}

/**
 * Approximate the token count and detect truncation.
 *
 * The tokenizer is not exposed by the callable the pipeline returns, so this is an explicit
 * approximation rather than a silent guess: roughly one token per four characters, the conventional
 * English rule of thumb. `truncated` is therefore a *warning* the caller surfaces as
 * `job.warnings`, not an assertion - which is still strictly better than v1, where an 8,000
 * character context was silently clipped to the model's 256-token window and the resulting vector
 * did not represent the text at all, with nothing anywhere saying so.
 *
 * @param {string} text Input text.
 * @param {{maxSequenceLength: number}} entry Registry entry.
 * @returns {{tokenCount: number, truncated: boolean}} Estimate and warning flag.
 */
function estimateTokens(text, entry) {
  const tokenCount = Math.ceil(text.length / 4);
  return { tokenCount, truncated: tokenCount > entry.maxSequenceLength };
}

/**
 * @param {{code: string, message: string}|null} error The latched load failure.
 * @returns {import('../errors.js').AppError} A 503 naming the operator action.
 */
function modelFailed(error) {
  return errors.notReady({
    model: {
      status: 'failed',
      reason: error?.message ?? 'unknown',
      action: 'POST /api/v1/status/model/reload, or restart the node, to retry the load.',
    },
  });
}

/**
 * Reduce an unknown thrown value to a loggable shape with no upstream headers or config attached.
 *
 * @param {unknown} err Thrown value.
 * @returns {{code: string, message: string}} Loggable description.
 */
function describe(err) {
  const any = /** @type {any} */ (err);
  return {
    code: String(any?.code ?? any?.name ?? 'error'),
    message: String(any?.message ?? err),
  };
}

/** Re-exported so a consumer can reference the protocol's shared dimension without a second import. */
export const { SHARED_EMBEDDING_DIM } = constants;

export default createEmbeddingService;
