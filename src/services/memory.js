/**
 * Memory service: the commit pipeline as an observable job, plus the read, verify and decrypt paths.
 *
 * ## The v1 pipeline and why it was unsafe
 *
 * `POST /api/memory` did `embed -> encrypt -> pin -> commit -> respond` with **no `try`/`catch` and
 * no error middleware**. Three separate failures follow from that ordering:
 *
 *   - When the chain write failed, the object was already permanently pinned and billed, with no
 *     on-chain record, no compensating unpin, and **no response at all** - the client did not even
 *     receive the CID it had just started paying to store.
 *   - `await tx.wait()` had no timeout, so a stuck nonce hung the request until the client gave up
 *     and the socket leaked.
 *   - Any throw fell through to Express's default handler and returned an HTML error page with a
 *     stack trace to a client parsing JSON.
 *
 * The replacement is a **job**: the request returns immediately with a job id, the pipeline runs in
 * the background recording a state and a duration for each of its six steps, and every failure path
 * is explicit. In particular, a failure after a successful pin runs a compensating `ipfs.unpin` and
 * records the outcome in `job.result.pinRolledBack` - and whether or not the unpin succeeds, the job
 * still carries the CID, because the one thing that must never happen is a client paying for storage
 * it was never told about.
 *
 * ## What is committed, and what is only bound transitively
 *
 * The chain record is `MemoryInput { cid, prevCidHash, model, embeddingDim, isEncrypted }`. It does
 * **not** carry `payloadHash`, `projectionId`, `policyId` or `specHash`; those live in the payload
 * and are bound to the chain only through the CID. That is a real limitation and it is written here
 * rather than left for a reader to discover.
 *
 * `model` on chain is the **short tag**, not the canonical URI. `Limits.MAX_MODEL_BYTES` is 64 and a
 * digest-pinned URI is around 126 bytes, so committing the URI reverts at `estimateGas` and no
 * memory could ever be written. The tag is `nm1:` + base64url of `keccak256(utf8(uri))`, a lossless
 * commitment to the URI rather than a lossy abbreviation of it, and the URI itself travels in the
 * payload as `model.uri` with `model.id` as the same keccak. See `src/services/embeddings.js`.
 *
 * ## Local index
 *
 * `list()` is served from an in-process index of what this node committed. It is explicitly a
 * **cache, not a source of truth**: the authoritative list is the ledger's owner index and the
 * `MemoryCommitted` log, a restart empties it, and `reconcile()` refills it from the chain. Saying
 * so matters, because v1 listed the operator's entire Pinata billing account and called that the
 * memory list.
 *
 * @module src/services/memory
 */
import { randomUUID } from 'node:crypto';

import { ZeroHash, id as keccakUtf8 } from 'ethers';

import { getConfig } from '../config/index.js';
import { errors } from '../errors.js';
import { logger as defaultLogger } from '../logger.js';
import { canonical, constants, payload as payloadCodec } from '../protocol/index.js';
import * as protocolProjection from '../protocol/projection.js';

import { normalizeMetrics } from './instrument.js';

/** The six pipeline steps, in order. `align` is a real stage that can fail and is timed separately. */
export const COMMIT_STEPS = Object.freeze([
  'embed',
  'align',
  'encrypt',
  'pin',
  'commit',
  'confirm',
]);

/** How long an EIP-712 commit authorisation stays valid. */
export const COMMIT_DEADLINE_SECONDS = 900;

/* ========================================================================== */
/* Job registry                                                               */
/* ========================================================================== */

/**
 * A bounded, in-process job registry.
 *
 * **Non-durable, and that is stated rather than implied.** A restart loses job history, and a job
 * that was mid-commit at restart leaves a pinned object and possibly a broadcast transaction with no
 * local record of either. The mitigations are real but partial: the ledger rejects a duplicate CID,
 * and the chain service logs any unconfirmed transaction hash at WARN during shutdown so an operator
 * can resolve it by hand. A durable queue is future work, not something this pretends to have.
 *
 * @param {object} [deps] Dependencies.
 * @param {ReturnType<typeof getConfig>} [deps.config] Application config.
 * @param {any} [deps.logger] Pino logger.
 * @param {(job: Job) => void} [deps.onChange] Called after every mutation, for the SSE stream.
 * @param {() => number} [deps.now] Clock, in epoch milliseconds.
 * @returns {JobRegistry} The registry.
 */
export function createJobRegistry({
  config = getConfig(),
  logger = defaultLogger,
  onChange,
  now = Date.now,
} = {}) {
  const log = logger.child ? logger.child({ service: 'jobs' }) : logger;
  /** @type {Map<string, Job>} */
  const jobs = new Map();
  /** @type {Map<string, {started: number}>} */
  const timers = new Map();

  /**
   * @param {Job} job The job that changed.
   * @returns {void}
   */
  function emit(job) {
    try {
      onChange?.(job);
    } catch (err) {
      // A subscriber must never be able to fail the pipeline it is watching.
      log.warn?.({ err: String(/** @type {any} */ (err)?.message ?? err) }, 'job subscriber threw');
    }
  }

  /**
   * @param {object} args Arguments.
   * @param {string} args.kind Job kind, e.g. `memory.create`.
   * @param {string[]} [args.steps] Step names, in order.
   * @param {Record<string, unknown>} [args.meta] Non-secret context shown to the client.
   * @returns {Job} The new job.
   */
  function create({ kind, steps = [], meta = {} }) {
    sweep();
    evict();
    /** @type {Job} */
    const job = {
      id: randomUUID(),
      kind,
      state: 'queued',
      steps: steps.map((name) => ({ name, state: 'pending', ms: null, detail: null })),
      result: null,
      error: null,
      warnings: [],
      meta,
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
    };
    jobs.set(job.id, job);
    emit(job);
    return job;
  }

  /**
   * @param {string} id Job id.
   * @returns {Job} The job.
   * @throws {import('../errors.js').AppError} 404 when it is unknown or has expired.
   */
  function require_(id) {
    const job = jobs.get(id);
    if (!job) throw errors.jobNotFound(id);
    return job;
  }

  /**
   * Mark a step active and start its clock.
   *
   * @param {string} id Job id.
   * @param {string} name Step name.
   * @returns {void}
   */
  function begin(id, name) {
    const job = require_(id);
    job.state = 'running';
    const step = job.steps.find((s) => s.name === name);
    if (step) step.state = 'active';
    timers.set(`${id}:${name}`, { started: now() });
    emit(job);
  }

  /**
   * Complete a step and record its duration.
   *
   * @param {string} id Job id.
   * @param {string} name Step name.
   * @param {'done'|'failed'|'skipped'} state Outcome.
   * @param {unknown} [detail] Non-secret detail shown to the client.
   * @returns {void}
   */
  function end(id, name, state, detail = null) {
    const job = require_(id);
    const step = job.steps.find((s) => s.name === name);
    const timer = timers.get(`${id}:${name}`);
    timers.delete(`${id}:${name}`);
    if (step) {
      step.state = state;
      step.ms = timer ? now() - timer.started : step.ms;
      step.detail = /** @type {any} */ (detail);
    }
    emit(job);
  }

  /**
   * @param {string} id Job id.
   * @param {string} message Warning text.
   * @returns {void}
   */
  function warn(id, message) {
    const job = require_(id);
    job.warnings.push(message);
    emit(job);
  }

  /**
   * @param {string} id Job id.
   * @param {Record<string, unknown>} result Result payload.
   * @returns {Job} The finished job.
   */
  function finish(id, result) {
    const job = require_(id);
    job.state = 'succeeded';
    job.result = { ...(job.result ?? {}), ...result };
    job.finishedAt = new Date(now()).toISOString();
    emit(job);
    return job;
  }

  /**
   * @param {string} id Job id.
   * @param {unknown} error The failure.
   * @param {Record<string, unknown>} [result] Partial result to retain — the CID, above all.
   * @returns {Job} The failed job.
   */
  function fail(id, error, result = {}) {
    const job = require_(id);
    const any = /** @type {any} */ (error);
    job.state = 'failed';
    job.error = {
      code: String(any?.code ?? 'internal_error'),
      message: String(any?.expose === false ? 'The job failed.' : (any?.message ?? error)),
      details: any?.expose === false ? null : (any?.details ?? null),
    };
    job.result = { ...(job.result ?? {}), ...result };
    job.finishedAt = new Date(now()).toISOString();
    emit(job);
    return job;
  }

  /**
   * Drop jobs that finished more than `JOB_TTL_MS` ago.
   *
   * @returns {number} How many were dropped.
   */
  function sweep() {
    let dropped = 0;
    const cutoff = now() - config.jobs.ttlMs;
    for (const [key, job] of jobs) {
      if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) {
        jobs.delete(key);
        dropped += 1;
      }
    }
    return dropped;
  }

  /**
   * Enforce the registry bound, evicting the oldest *finished* job first.
   *
   * A running job is never evicted: dropping it would lose the only local record of a transaction
   * that may already be on the network.
   *
   * @returns {number} How many were evicted.
   */
  function evict() {
    let dropped = 0;
    while (jobs.size >= config.jobs.max) {
      const victim = [...jobs.values()].find((job) => job.finishedAt !== null);
      if (!victim) break;
      jobs.delete(victim.id);
      dropped += 1;
    }
    return dropped;
  }

  return {
    create,
    get: (id) => jobs.get(id) ?? null,
    require: require_,
    begin,
    end,
    warn,
    finish,
    fail,
    sweep,
    size: () => jobs.size,
    list: ({ limit = 25 } = {}) => [...jobs.values()].slice(-limit).reverse(),
  };
}

/* ========================================================================== */
/* Memory service                                                             */
/* ========================================================================== */

/**
 * Create the memory service.
 *
 * @param {object} deps Dependencies.
 * @param {ReturnType<typeof getConfig>} [deps.config] Application config.
 * @param {any} [deps.logger] Pino logger.
 * @param {any} deps.embeddings Embedding service.
 * @param {any} deps.crypto Crypto service.
 * @param {any} deps.ipfs IPFS service.
 * @param {any} deps.chain Chain service.
 * @param {any} [deps.semantic] Semantic service; the index upsert is skipped without it.
 * @param {JobRegistry} [deps.jobs] Job registry; one is created when omitted.
 * @param {import('./instrument.js').MetricsLike} [deps.metrics] Metrics collector.
 * @param {() => number} [deps.now] Clock, in epoch milliseconds.
 * @returns {MemoryService} The service.
 */
export function createMemoryService(
  {
    config = getConfig(),
    logger = defaultLogger,
    embeddings,
    crypto,
    ipfs,
    chain,
    semantic,
    jobs,
    metrics,
    now = Date.now,
  } = /** @type {any} */ ({}),
) {
  const log = logger.child ? logger.child({ service: 'memory' }) : logger;
  const instruments = normalizeMetrics(metrics);
  const registry = jobs ?? createJobRegistry({ config, logger, now });

  /**
   * The local index of what this node committed. Newest last; `list()` reverses.
   *
   * @type {Map<string, CommittedRecord>}
   */
  const committed = new Map();
  /** @type {Map<string, Promise<Job>>} */
  const running = new Map();

  /* ---------------------------------------------------------------------- */
  /* Create                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Start a commit.
   *
   * Returns as soon as the job exists, so the HTTP layer can answer `202` with a job id instead of
   * holding a socket open across an embedding, a pin and a chain confirmation. Await
   * {@link MemoryService.waitFor} to observe the outcome.
   *
   * @param {object} [args] Arguments. Typed as optional because the whole point of the checks
   *   below is to answer a caller who supplied the wrong thing with a 400 rather than a TypeError.
   * @param {string} [args.context] Plaintext to remember.
   * @param {string|null} [args.parentCid] CID this memory supersedes.
   * @param {Array<{address: string, publicKey: string, keyVersion?: number}>} [args.grantees]
   *   Additional recipients, each with a validated compressed encryption public key.
   * @param {{embeddingVisibility: 'public'|'grantees'|'lsh-only',
   *   redistribution?: 'forbidden'|'grantees'|'public', retentionUntil?: number}} [args.policy]
   *   Policy block; defaults to the crypto service's.
   * @param {string} [args.modelKey] Embedding model key.
   * @param {string|null} [args.actor] Who asked, for the audit log.
   * @returns {Job} The job, already running.
   */
  function create({
    context,
    parentCid = null,
    grantees = [],
    policy,
    modelKey,
    actor = null,
  } = {}) {
    if (typeof context !== 'string' || context.trim().length === 0) {
      throw errors.badRequest(
        '"context" must be a non-empty string. An array would be treated as a batch by the ' +
          'tokenizer, which is how a 1920-float vector came to be committed as embeddingDim 384.',
        { received: Array.isArray(context) ? 'array' : typeof context },
      );
    }
    if (context.length > config.embeddings.maxContextChars) {
      throw errors.payloadTooLarge(config.embeddings.maxContextChars, context.length);
    }
    // Refuse before creating a job, so a read-only node produces one clear 503 rather than a job
    // that exists only to fail.
    chain.assertWritable();

    const job = registry.create({
      kind: 'memory.create',
      steps: [...COMMIT_STEPS],
      meta: { actor, parentCid, contextChars: context.length, grantees: grantees.length },
    });

    const promise = runPipeline(job.id, {
      context,
      parentCid,
      grantees,
      policy: policy ?? crypto.defaultPolicy(),
      modelKey,
      actor,
    });
    running.set(job.id, promise);
    void promise.finally(() => running.delete(job.id));
    return job;
  }

  /**
   * The commit pipeline.
   *
   * @param {string} jobId Job id.
   * @param {object} args Pipeline arguments, already validated by {@link create}.
   * @param {string} args.context Plaintext.
   * @param {string|null} args.parentCid Parent CID.
   * @param {Array<any>} args.grantees Additional recipients.
   * @param {{embeddingVisibility: 'public'|'grantees'|'lsh-only',
   *   redistribution?: 'forbidden'|'grantees'|'public', retentionUntil?: number}} args.policy
   *   Policy block.
   * @param {string} [args.modelKey] Model key.
   * @param {string|null} args.actor Requester.
   * @returns {Promise<Job>} The finished job. Never rejects; the outcome is on the job.
   */
  async function runPipeline(jobId, { context, parentCid, grantees, policy, modelKey, actor }) {
    const started = now();
    /** @type {string|null} */
    let cid = null;
    let pinned = false;
    try {
      /* 1. Embed. */
      registry.begin(jobId, 'embed');
      const embedded = await embeddings.embed(context, { model: modelKey });
      registry.end(jobId, 'embed', 'done', {
        model: embedded.modelKey,
        dim: embedded.dim,
        provider: embedded.provider,
        ms: Math.round(embedded.durationMs),
      });
      if (embedded.truncated) {
        registry.warn(
          jobId,
          `The context is approximately ${embedded.tokenCount} tokens and the model's window is ` +
            'shorter, so the tail was dropped before the vector was produced. The embedding does ' +
            'not represent the whole text.',
        );
      }
      if (!embedded.pinned) {
        registry.warn(
          jobId,
          'The model weights are not digest-pinned in this build, so model.uri carries no ' +
            '@sha256 component and a verifier cannot check which weights produced this vector.',
        );
      }

      /* 2. Align. */
      registry.begin(jobId, 'align');
      const aligned = semantic
        ? semantic.align(embedded.vector, { modelId: embedded.modelId })
        : localAlign(embedded.vector);
      registry.end(jobId, 'align', 'done', {
        projectionId: aligned.projectionId,
        outDim: aligned.outDim,
        projected: aligned.projected,
        noiseBaseline: aligned.noiseBaseline,
      });

      /* 3. Seal. */
      registry.begin(jobId, 'encrypt');
      const sealed = crypto.seal({
        context,
        embedding: aligned.z,
        modelId: embedded.modelId,
        policy,
        grantees,
      });
      registry.end(jobId, 'encrypt', 'done', {
        recipients: sealed.recipients.length,
        embeddingSealed: sealed.embeddingSealed,
      });

      /* 4. Assemble, validate, address, pin. */
      registry.begin(jobId, 'pin');
      const agentDid = crypto.agentDid();
      if (!agentDid) throw errors.readOnly();
      const body = {
        v: constants.PROTOCOL_VERSION,
        contentId: sealed.contentId,
        agentDid,
        keyVersion: crypto.keyVersion(),
        createdAt: Math.floor(now() / 1000),
        prevCid: parentCid,
        model: { id: embedded.modelId, uri: embedded.modelUri, dim: embedded.dim },
        alignment: { projectionId: aligned.projectionId, dim: aligned.outDim },
        embedding: {
          visibility: policy.embeddingVisibility,
          encoding: /** @type {const} */ ('f32-b64'),
          dim: aligned.outDim,
          data: policy.embeddingVisibility === 'public' ? canonical.f32ToB64(aligned.z) : null,
          dataDigest: payloadCodec.embeddingDigest(aligned.z),
        },
        lsh: { alg: /** @type {const} */ ('simhash'), bits: 256, sig: canonical.b64u(aligned.lsh) },
        policy,
        cipher: sealed.cipher,
        context: null,
        recipients: sealed.recipients,
      };
      // Validate before anything irreversible. A payload that fails its own schema must never reach
      // a paid pinning service, let alone the chain.
      const validated = payloadCodec.parseMemoryPayload(body);
      const addressed = payloadCodec.addressPayload(validated);
      cid = addressed.cid;
      const pin = await ipfs.pinBytes(addressed.bytes, {
        name: addressed.cid,
        keyvalues: { agent: crypto.agentAddress() ?? 'unknown', contentId: sealed.contentId },
      });
      pinned = true;
      registry.end(jobId, 'pin', 'done', {
        cid: pin.cid,
        size: pin.size,
        duplicate: pin.duplicate,
      });

      /* 5. Sign and broadcast. */
      registry.begin(jobId, 'commit');
      const deadline = Math.floor(now() / 1000) + COMMIT_DEADLINE_SECONDS;
      const prevCidHash = parentCid ? keccakUtf8(parentCid) : ZeroHash;
      const signed = await chain.signMemoryCommit({
        cid: addressed.cid,
        prevCidHash,
        model: embedded.chainModel,
        embeddingDim: aligned.outDim,
        isEncrypted: true,
        deadline,
      });
      if (!signed.crossChecked) {
        registry.warn(
          jobId,
          'The EIP-712 digest could not be cross-checked against MemoryLedger.hashCommit() ' +
            'because the chain was unreachable at signing time.',
        );
      }
      /** @type {string|null} */
      let hash = null;
      registry.begin(jobId, 'confirm');
      const receipt = await chain.submit({
        label: 'memory.commit',
        contract: 'MemoryLedger',
        method: 'commitMemoryFor',
        args: [
          signed.agent,
          [addressed.cid, prevCidHash, embedded.chainModel, aligned.outDim, true],
          deadline,
          signed.signature,
        ],
        onHash: (value) => {
          hash = value;
          registry.end(jobId, 'commit', 'done', { txHash: value, nonce: signed.nonce });
        },
      });
      if (!hash) registry.end(jobId, 'commit', 'done', { nonce: signed.nonce });
      registry.end(jobId, 'confirm', receipt.status === 'confirmed' ? 'done' : 'skipped', {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
      });
      if (receipt.status === 'timeout') {
        registry.warn(
          jobId,
          `Transaction ${receipt.hash} was broadcast but had not confirmed within the budget. It ` +
            'may still land; the nonce has not been reused.',
        );
      }

      /* 6. Index. */
      const record = {
        cid: addressed.cid,
        cidDigest: addressed.cidDigest,
        payloadHash: addressed.payloadHash,
        contentId: sealed.contentId,
        owner: signed.agent,
        agentDid,
        model: embedded.modelUri,
        chainModel: embedded.chainModel,
        embeddingDim: aligned.outDim,
        projectionId: aligned.projectionId,
        sizeBytes: addressed.bytes.length,
        isEncrypted: true,
        prevCid: parentCid,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        committedAt: Math.floor(now() / 1000),
        confirmed: receipt.status === 'confirmed',
      };
      committed.set(addressed.cid, record);
      semantic?.upsert({
        cid: addressed.cid,
        cidDigest: addressed.cidDigest,
        owner: signed.agent,
        z: aligned.z,
        lsh: aligned.lsh,
        projectionId: aligned.projectionId,
        createdAt: record.committedAt,
        model: embedded.modelUri,
        encrypted: true,
      });

      instruments.increment('neuromesh_memory_commits_total', { status: receipt.status });
      instruments.observe('neuromesh_memory_pipeline_duration_seconds', (now() - started) / 1000);
      log.info?.(
        { cid: addressed.cid, txHash: receipt.hash, actor, jobId, ms: now() - started },
        'memory committed',
      );
      return registry.finish(jobId, {
        cid: addressed.cid,
        cidDigest: addressed.cidDigest,
        contentId: sealed.contentId,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        explorerUrl: receipt.explorerUrl,
        gatewayUrl: ipfs.gatewayUrl(addressed.cid),
        status: receipt.status,
        pinRolledBack: false,
      });
    } catch (err) {
      instruments.increment('neuromesh_memory_commits_total', { status: 'failed' });
      /** @type {Record<string, unknown>} */
      const partial = { cid, pinRolledBack: false };
      if (pinned && cid) {
        // The compensating action. It is best-effort by design: a failed unpin must not replace the
        // original error with a different one, because the caller is already handling a failure and
        // losing that context is how an operator ends up debugging the wrong thing.
        const undo = await ipfs.unpin(cid);
        partial.pinRolledBack = undo.ok;
        partial.pinRollbackReason = undo.reason;
        if (!undo.ok) {
          registry.warn(
            jobId,
            `The commit failed after the payload was pinned, and the compensating unpin of ${cid} ` +
              `also failed (${undo.reason}). The object remains pinned and billed with no chain ` +
              'record. Reconcile it with ipfs.listPins().',
          );
        }
      }
      for (const step of registry.require(jobId).steps) {
        if (step.state === 'active') registry.end(jobId, step.name, 'failed');
      }
      log.warn?.(
        { jobId, cid, actor, err: describe(err), pinRolledBack: partial.pinRolledBack },
        'memory commit failed',
      );
      return registry.fail(jobId, err, partial);
    }
  }

  /**
   * Fallback alignment for a node constructed without a semantic service.
   *
   * @param {ArrayLike<number>} vector Raw model output.
   * @returns {any} The same shape `semantic.align` returns.
   */
  function localAlign(vector) {
    const aligned = protocolProjection.alignEmbedding({
      embedding: vector,
      targetDim: constants.SHARED_EMBEDDING_DIM,
    });
    const z = Float32Array.from(aligned.aligned);
    return {
      z,
      lsh: protocolProjection.simhash256(z),
      projectionId: aligned.projectionId,
      outDim: aligned.targetDim,
      projected: aligned.projected,
      noiseBaseline: aligned.noiseBaseline,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Read                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Fetch one memory by CID.
   *
   * The bytes are fetched through the IPFS service, which verifies `sha256(bytes) === cidDigest`
   * before returning them, so the payload is provably the one the CID names. The on-chain record is
   * best-effort: a memory whose bytes are readable but whose chain record is unavailable is reported
   * with `onchain: null` and a reason, not as a 404.
   *
   * @param {string} cid CID to fetch.
   * @returns {Promise<any>} The payload, its chain record and its addressing.
   */
  async function get(cid) {
    assertCid(cid);
    const fetched = await ipfs.fetchByCid(cid);
    const parsed = payloadCodec.parseMemoryPayload(fetched.json);
    /** @type {any} */
    let onchain = null;
    /** @type {string|null} */
    let onchainReason = null;
    try {
      onchain = await chain.readLedger.getMemoryByCid(cid);
      if (!onchain.owner || /^0x0{40}$/i.test(onchain.owner)) {
        onchain = null;
        onchainReason = 'No ledger record exists for this CID.';
      }
    } catch (err) {
      onchainReason = describe(err).message;
    }
    return {
      cid,
      cidDigest: canonical.digestFromCid(cid),
      payloadVersion: parsed.v,
      payload: parsed,
      sizeBytes: fetched.bytes.length,
      onchain,
      onchainReason,
      gatewayUrl: ipfs.gatewayUrl(cid),
      // A strong ETag that costs nothing: the content is addressed by its own hash.
      etag: `"${canonical.digestFromCid(cid).slice(2)}"`,
      local: committed.get(cid) ?? null,
    };
  }

  /**
   * A page of this node's committed memories.
   *
   * @param {object} [options] Options.
   * @param {number} [options.limit] Page size.
   * @param {string|null} [options.cursor] Opaque cursor from a previous page.
   * @param {boolean} [options.encrypted] Filter on encryption.
   * @param {string} [options.model] Filter on the model URI.
   * @returns {{items: CommittedRecord[], nextCursor: string|null, total: number,
   *   source: 'local-index'}} One page.
   */
  function list({ limit = 25, cursor = null, encrypted, model } = {}) {
    const pageLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const filters = { encrypted: encrypted ?? null, model: model ?? null };
    const { offset, filtersHash } = decodeCursor(cursor);
    const currentHash = hashFilters(filters);
    if (cursor && filtersHash !== currentHash) {
      // A cursor issued for a different filter set describes a different sequence. Continuing with
      // it silently returns the wrong page, which is worse than an error the client can act on.
      throw errors.badRequest(
        'This pagination cursor was issued for a different set of filters. Restart the listing ' +
          'without a cursor.',
        { cursor },
      );
    }
    const all = [...committed.values()]
      .filter((row) => (filters.encrypted === null ? true : row.isEncrypted === filters.encrypted))
      .filter((row) => (filters.model === null ? true : row.model === filters.model))
      .reverse();
    const items = all.slice(offset, offset + pageLimit);
    const consumed = offset + items.length;
    return {
      items,
      nextCursor: consumed < all.length ? encodeCursor(consumed, currentHash) : null,
      total: all.length,
      source: /** @type {const} */ ('local-index'),
    };
  }

  /**
   * Refill the local index from the ledger's owner index.
   *
   * Only the on-chain fields can be restored this way - the payload's model URI, projection id and
   * size live in the pinned bytes. Fields that could not be recovered are `null` rather than
   * plausible defaults.
   *
   * @param {object} [options] Options.
   * @param {string} [options.owner] Owner to enumerate; defaults to this node's agent.
   * @param {number} [options.limit] Maximum records.
   * @returns {Promise<{restored: number, total: number}>} What was restored.
   */
  async function reconcile({ owner, limit = 200 } = {}) {
    const target = owner ?? chain.address();
    if (!target) throw errors.readOnly();
    let restored = 0;
    let total = 0;
    const pageSize = 50;
    for (let offset = 0; offset < limit; offset += pageSize) {
      const page = await chain.readLedger.getOwnerMemoryRecords(target, offset, pageSize);
      total = page.total;
      if (page.page.length === 0) break;
      for (const row of page.page) {
        if (committed.has(row.cid)) continue;
        committed.set(row.cid, {
          cid: row.cid,
          cidDigest: safeDigest(row.cid),
          payloadHash: null,
          contentId: null,
          owner: row.owner,
          agentDid: null,
          model: null,
          chainModel: row.model,
          embeddingDim: row.embeddingDim,
          projectionId: null,
          sizeBytes: null,
          isEncrypted: row.isEncrypted,
          prevCid: null,
          txHash: null,
          blockNumber: null,
          committedAt: row.committedAt,
          confirmed: true,
          revoked: row.revoked,
        });
        restored += 1;
      }
      if (offset + pageSize >= page.total) break;
    }
    log.info?.({ restored, total, owner: target }, 'local memory index reconciled from the chain');
    return { restored, total };
  }

  /* ---------------------------------------------------------------------- */
  /* Verify and decrypt                                                      */
  /* ---------------------------------------------------------------------- */

  /**
   * Run the verification sequence for one memory and report every step.
   *
   * Deliberately returns an array of step results rather than a boolean. "This memory does not
   * verify" is not actionable; "step 6 failed because the on-chain `embeddingDim` is 384 and the
   * payload's is 768" is. A step that cannot be evaluated reports `skip` with a reason - a node with
   * no chain connection genuinely cannot check the ledger, and saying so is not the same as passing.
   *
   * @param {string} cid CID to verify.
   * @returns {Promise<{cid: string, ok: boolean, steps: VerifyStep[]}>} The report.
   */
  async function verify(cid) {
    /** @type {VerifyStep[]} */
    const steps = [];
    /**
     * @param {string} name Step name.
     * @param {'pass'|'fail'|'skip'} state Outcome.
     * @param {string} detail Explanation.
     * @returns {void}
     */
    const push = (name, state, detail) => {
      steps.push({ name, state, detail });
    };

    /** @type {any} */
    let parsed;
    /** @type {Uint8Array} */
    let bytes;

    try {
      assertCid(cid);
      push('cid-format', 'pass', 'The CID is a v1 raw sha2-256 identifier.');
    } catch (err) {
      push('cid-format', 'fail', describe(err).message);
      return { cid, ok: false, steps };
    }

    try {
      // fetchBytes verifies sha256(bytes) === the CID's digest before returning, so this single call
      // covers both "the bytes were retrievable" and "the bytes are the ones the CID names".
      bytes = await ipfs.fetchBytes(cid);
      push('bytes-retrieved', 'pass', `${bytes.length} bytes fetched from the gateway.`);
      push('cid-matches-bytes', 'pass', 'sha2-256 of the retrieved bytes equals the CID digest.');
    } catch (err) {
      push('bytes-retrieved', 'fail', describe(err).message);
      push('cid-matches-bytes', 'skip', 'The bytes could not be retrieved.');
      return { cid, ok: false, steps };
    }

    try {
      parsed = payloadCodec.parseMemoryPayload(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
      push('schema', 'pass', `The payload validates against ${parsed.v}.`);
    } catch (err) {
      push('schema', 'fail', describe(err).message);
      return { cid, ok: false, steps };
    }

    const recanonicalised = payloadCodec.serializePayloadBytes(parsed);
    const identical =
      recanonicalised.length === bytes.length &&
      Buffer.compare(Buffer.from(recanonicalised), Buffer.from(bytes)) === 0;
    push(
      'canonical',
      identical ? 'pass' : 'fail',
      identical
        ? 'Re-canonicalising the parsed payload reproduces the stored bytes exactly.'
        : 'The stored bytes are not the canonical encoding of their own content, so the CID does ' +
            'not address a canonical payload. v1 published through pinJSONToIPFS, which re-encodes ' +
            'server-side; this is what that looks like.',
    );

    const policyId = payloadCodec.computePolicyId(parsed.policy);
    push(
      'policy-id',
      'pass',
      `policyId = ${policyId}; it is bound into the ciphertext AAD, so a substituted policy fails ` +
        'the tag check rather than being silently accepted.',
    );

    // Informational, never a failure: a public embedding is a deliberate policy choice, not a
    // defect. The step exists so a reader can see which choice was made without decoding the policy.
    push(
      'embedding-visibility',
      'pass',
      parsed.embedding.visibility === 'public'
        ? 'The embedding is published in the clear, by the author’s explicit policy. Embedding ' +
            'inversion recovers substantial text from a sentence vector, so this is close to ' +
            'publishing the plaintext.'
        : 'The embedding is sealed; only its digest and a 256-bit SimHash are public.',
    );

    /** @type {any} */
    let record = null;
    try {
      record = await chain.readLedger.getMemoryByCid(cid);
      if (!record.owner || /^0x0{40}$/i.test(record.owner)) record = null;
    } catch (err) {
      push('chain-record', 'skip', `The ledger could not be read: ${describe(err).message}`);
    }

    if (record) {
      push(
        'chain-record',
        'pass',
        `Committed at block time ${record.committedAt} by ${record.owner}.`,
      );
      const didOwner = parsed.agentDid.split(':').pop() ?? '';
      const ownerMatches = didOwner.toLowerCase() === String(record.owner).toLowerCase();
      push(
        'owner-binding',
        ownerMatches ? 'pass' : 'fail',
        ownerMatches
          ? 'The payload’s agentDid resolves to the address that owns the ledger record.'
          : `The payload claims ${didOwner} but the ledger record is owned by ${record.owner}.`,
      );
      const dimMatches = Number(record.embeddingDim) === parsed.alignment.dim;
      push(
        'dimension-binding',
        dimMatches ? 'pass' : 'fail',
        dimMatches
          ? `The committed embeddingDim (${record.embeddingDim}) equals the payload’s aligned dimension.`
          : `The chain records embeddingDim ${record.embeddingDim} but the payload’s aligned ` +
              `vector has ${parsed.alignment.dim}. One of the two is a false record and it cannot be ` +
              'corrected on chain.',
      );
      const tagMatches = record.model === expectedChainTag(parsed.model.id);
      push(
        'model-binding',
        tagMatches ? 'pass' : 'fail',
        tagMatches
          ? 'The on-chain model tag is the base64url keccak of the payload’s model URI.'
          : `The on-chain model tag "${record.model}" is not the commitment to the payload’s ` +
              `model URI "${parsed.model.uri}".`,
      );
      push(
        'revocation',
        record.revoked ? 'fail' : 'pass',
        record.revoked
          ? `The record was revoked at ${record.revokedAt}; it must not be served as current.`
          : 'The ledger record is not revoked.',
      );
    } else if (!steps.some((s) => s.name === 'chain-record')) {
      push('chain-record', 'fail', 'There is no ledger record for this CID.');
    }

    const self = crypto.agentAddress();
    if (!self) {
      push('recipient-entry', 'skip', 'This node holds no encryption keypair.');
      push('decryptable', 'skip', 'This node holds no encryption keypair.');
    } else if (parsed.cipher === null) {
      push('recipient-entry', 'skip', 'The memory is public; there is nothing to unwrap.');
      push('decryptable', 'skip', 'The memory is public; there is nothing to unwrap.');
    } else {
      const entry = parsed.recipients.some(
        (r) => r.addr.toLowerCase() === self.toLowerCase() && r.keyVersion === crypto.keyVersion(),
      );
      push(
        'recipient-entry',
        entry ? 'pass' : 'skip',
        entry
          ? 'This node holds a wrapped CEK for this memory at its current key version.'
          : 'This memory was not shared with this agent, so the remaining steps cannot be run here.',
      );
      if (entry) {
        try {
          crypto.open({ payload: parsed, cid });
          push(
            'decryptable',
            'pass',
            'The ciphertext opens under the reconstructed AAD and the decrypted embedding matches ' +
              'its published digest.',
          );
        } catch (err) {
          push('decryptable', 'fail', describe(err).message);
        }
      } else {
        push('decryptable', 'skip', 'No recipient entry for this agent.');
      }
    }

    const ok = steps.every((step) => step.state !== 'fail');
    return { cid, ok, steps };
  }

  /**
   * Decrypt one memory this node is a recipient of.
   *
   * **Takes no ciphertext from the caller.** The only input is a CID; the bytes are fetched, verified
   * against that CID, validated against the payload schema, and only then opened with this node's
   * own encryption key. This is the replacement for `POST /api/decrypt`, which accepted arbitrary
   * `{encrypted, salt, iv, tag}` from any origin and decrypted it with the node's chain signing key -
   * an unauthenticated decryption oracle that was also a PBKDF2 work amplifier at 53 ms per call.
   *
   * @param {string} cid CID to open.
   * @param {object} [options] Options.
   * @param {string|null} [options.actor] Who asked, for the audit log.
   * @param {string|null} [options.requestId] Correlation id, for the audit log.
   * @returns {Promise<{cid: string, context: string, contentId: string, verified: true,
   *   embeddingVerified: boolean}>} The plaintext.
   */
  async function decrypt(cid, { actor = null, requestId = null } = {}) {
    assertCid(cid);
    const fetched = await ipfs.fetchByCid(cid);
    const parsed = payloadCodec.parseMemoryPayload(fetched.json);
    const opened = crypto.open({ payload: parsed, cid, actor, requestId });
    instruments.increment('neuromesh_memory_decrypts_total');
    return {
      cid,
      context: opened.context,
      contentId: opened.contentId,
      verified: /** @type {const} */ (true),
      embeddingVerified: opened.embeddingVerified,
    };
  }

  /**
   * @param {string} modelId 0x-hex keccak of the model URI.
   * @returns {string} The chain tag that commits to it.
   */
  function expectedChainTag(modelId) {
    return `nm1:${canonical.b64u(Uint8Array.from(Buffer.from(modelId.slice(2), 'hex')))}`;
  }

  /** @type {MemoryService} */
  const service = {
    create,
    getJob: (id) => registry.get(id),
    waitFor: (id) => running.get(id) ?? Promise.resolve(registry.require(id)),
    jobs: registry,
    get,
    list,
    reconcile,
    verify,
    decrypt,
    count: () => committed.size,
    index: () => [...committed.values()],
    async shutdown() {
      await Promise.allSettled([...running.values()]);
      committed.clear();
    },
  };
  return service;
}

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {object} JobStep
 * @property {string} name Step name.
 * @property {'pending'|'active'|'done'|'failed'|'skipped'} state Step state.
 * @property {number|null} ms Duration once the step has ended.
 * @property {unknown} detail Non-secret detail.
 */

/**
 * @typedef {object} Job
 * @property {string} id UUID.
 * @property {string} kind Job kind.
 * @property {'queued'|'running'|'succeeded'|'failed'} state Job state.
 * @property {JobStep[]} steps Steps, in order.
 * @property {Record<string, unknown>|null} result Result, including the CID even on failure.
 * @property {{code: string, message: string, details: unknown}|null} error The failure.
 * @property {string[]} warnings Non-fatal findings the client should see.
 * @property {Record<string, unknown>} meta Request context.
 * @property {string} startedAt ISO timestamp.
 * @property {string|null} finishedAt ISO timestamp.
 */

/**
 * @typedef {object} JobRegistry
 * @property {(args: {kind: string, steps?: string[], meta?: Record<string, unknown>}) => Job} create
 * @property {(id: string) => Job|null} get Read a job, or null.
 * @property {(id: string) => Job} require Read a job, or throw 404.
 * @property {(id: string, name: string) => void} begin Mark a step active.
 * @property {(id: string, name: string, state: 'done'|'failed'|'skipped', detail?: unknown) => void} end
 * @property {(id: string, message: string) => void} warn Append a warning.
 * @property {(id: string, result: Record<string, unknown>) => Job} finish Mark succeeded.
 * @property {(id: string, error: unknown, result?: Record<string, unknown>) => Job} fail Mark failed.
 * @property {() => number} sweep Drop expired jobs.
 * @property {() => number} size Jobs retained.
 * @property {(options?: {limit?: number}) => Job[]} list Recent jobs, newest first.
 */

/**
 * @typedef {object} CommittedRecord
 * @property {string} cid CID.
 * @property {string|null} cidDigest sha2-256 of the payload bytes.
 * @property {string|null} payloadHash keccak256 of the payload bytes.
 * @property {string|null} contentId Content identifier.
 * @property {string} owner Owning agent address.
 * @property {string|null} agentDid did:pkh of the owner.
 * @property {string|null} model Canonical model URI.
 * @property {string} chainModel Short model tag as committed.
 * @property {number} embeddingDim Aligned dimension.
 * @property {string|null} projectionId Projection the vector passed through.
 * @property {number|null} sizeBytes Payload size.
 * @property {boolean} isEncrypted Whether the context is sealed.
 * @property {string|null} prevCid Parent CID.
 * @property {string|null} txHash Commit transaction.
 * @property {number|null} blockNumber Inclusion block.
 * @property {number} committedAt Unix seconds.
 * @property {boolean} confirmed Whether the commit confirmed.
 * @property {boolean} [revoked] Whether the ledger record is revoked.
 */

/**
 * @typedef {object} VerifyStep
 * @property {string} name Step name.
 * @property {'pass'|'fail'|'skip'} state Outcome. `skip` is not `pass`.
 * @property {string} detail Explanation.
 */

/**
 * @typedef {object} MemoryService
 * @property {(args?: {context?: string, parentCid?: string|null, grantees?: Array<{address: string,
 *   publicKey: string, keyVersion?: number}>,
 *   policy?: {embeddingVisibility: 'public'|'grantees'|'lsh-only',
 *   redistribution?: 'forbidden'|'grantees'|'public', retentionUntil?: number},
 *   modelKey?: string, actor?: string|null}) => Job} create Start a commit; returns immediately.
 * @property {(id: string) => Job|null} getJob Read a job.
 * @property {(id: string) => Promise<Job>} waitFor Await a running job.
 * @property {JobRegistry} jobs The job registry.
 * @property {(cid: string) => Promise<any>} get Fetch and validate one memory.
 * @property {(options?: object) => any} list A page of the local index.
 * @property {(options?: object) => Promise<any>} reconcile Refill the index from the chain.
 * @property {(cid: string) => Promise<any>} verify The verification report.
 * @property {(cid: string, options?: object) => Promise<any>} decrypt Authenticated per-CID unwrap.
 * @property {() => number} count Entries in the local index.
 * @property {() => CommittedRecord[]} index The local index.
 * @property {() => Promise<void>} shutdown Await in-flight jobs.
 */

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

/**
 * @param {string} cid Candidate CID.
 * @returns {void}
 * @throws {import('../errors.js').AppError} 400 when it is not a v1 raw sha2-256 CID.
 */
function assertCid(cid) {
  if (typeof cid !== 'string' || cid.length === 0) {
    throw errors.badRequest('A CID is required.');
  }
  try {
    canonical.digestFromCid(cid);
  } catch (err) {
    throw errors.badRequest(describe(err).message, { cid });
  }
}

/**
 * @param {string} cid CID.
 * @returns {string|null} Its digest, or null when it is not parseable.
 */
function safeDigest(cid) {
  try {
    return canonical.digestFromCid(cid);
  } catch {
    return null;
  }
}

/**
 * @param {Record<string, unknown>} filters Active filters.
 * @returns {string} A short stable hash of them.
 */
function hashFilters(filters) {
  return canonical.sha256Hex(canonical.canonicalBytes(filters)).slice(2, 18);
}

/**
 * @param {number} offset Page offset.
 * @param {string} filtersHash Hash of the filters this cursor belongs to.
 * @returns {string} An opaque cursor.
 */
function encodeCursor(offset, filtersHash) {
  return Buffer.from(JSON.stringify({ o: offset, f: filtersHash })).toString('base64url');
}

/**
 * @param {string|null} cursor Opaque cursor.
 * @returns {{offset: number, filtersHash: string|null}} What it encodes.
 */
function decodeCursor(cursor) {
  if (!cursor) return { offset: 0, filtersHash: null };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const offset = Number(parsed?.o);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('bad offset');
    return { offset, filtersHash: String(parsed.f ?? '') };
  } catch {
    throw errors.badRequest('The pagination cursor is not one this service issued.', { cursor });
  }
}

/**
 * @param {unknown} err Thrown value.
 * @returns {{code: string, message: string}} A loggable description.
 */
function describe(err) {
  const any = /** @type {any} */ (err);
  return {
    code: String(any?.code ?? any?.name ?? 'error'),
    message: String(any?.message ?? err),
  };
}

export default createMemoryService;
