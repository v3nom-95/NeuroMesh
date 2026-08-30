/**
 * Semantic service: deterministic cross-model alignment, a SimHash candidate index, and
 * trust-weighted retrieval.
 *
 * ## The defect this replaces
 *
 * `lib/semantic-sync.js` built its projection matrix from **unseeded `Math.random`** via Box-Muller.
 * Two processes - the API server and the simulator, or two replicas behind a load balancer - drew
 * different matrices, so a vector projected by one was meaningless to the other, and nothing in the
 * payload recorded which matrix had been used. This repository's own `simulation-results.json` shows
 * what that produced: the six cross-model cosines fit the pure-noise null at chi-square 3.82 on 6
 * degrees of freedom, p = 0.70. The numbers were not weak evidence of alignment; they were
 * indistinguishable from nothing.
 *
 * The replacement is `src/protocol/projection.js`: a keccak-derived seed expanded through an
 * AES-256-CTR keystream into an Achlioptas (s = 3) sparse projection. It is a pure function of
 * `(fromDim, toDim)` and the protocol version, so every process on every machine builds the same
 * matrix, and `projectionId` records exactly which one. **`Math.random` appears nowhere in this file
 * or anything it imports**, and a test proves that by spawning a second Node process and byte-
 * comparing the result.
 *
 * Seeding alone would not have been enough, and the module says so: a seeded random projection is
 * *reproducible* noise. What makes a comparison meaningful is the `projectionId` equality filter
 * below - two vectors that did not pass through the same projection are never compared, they are
 * dropped with a diagnostic.
 *
 * ## Honesty about what the search is
 *
 * The candidate stage is an **exact linear scan** over at most `SEMANTIC_INDEX_MAX` entries, ranked
 * by Hamming distance on 256-bit SimHash codes. At 10,000 entries that is a few hundred microseconds
 * and it is not an approximate-nearest-neighbour index; calling it one would be a claim about
 * asymptotics this code does not earn. The SimHash stage exists to cut the number of full cosine
 * evaluations, not to make the search sublinear.
 *
 * Every response carries `diagnostics.noiseBaseline` (1/sqrt(dim)), the standard deviation of the
 * cosine between two unrelated unit vectors in the shared space. It sits beside every similarity
 * deliberately: it is the number that exposed the original bug, and a regression back to noise
 * should be visible rather than plausible.
 *
 * @module src/services/semantic
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { getConfig } from '../config/index.js';
import { errors } from '../errors.js';
import { logger as defaultLogger } from '../logger.js';
import { canonical, constants, projection, similarity } from '../protocol/index.js';

import { normalizeMetrics } from './instrument.js';

/** Minimum candidate pool the SimHash stage hands to the exact cosine stage. */
export const MIN_CANDIDATES = 200;

/** How long a per-agent trust lookup is reused before it is read from the chain again. */
export const TRUST_CACHE_MS = 60000;

/**
 * Create the semantic service.
 *
 * Construction performs no I/O. {@link SemanticService.init} loads the persisted index, and even
 * that is failure-tolerant: an unreadable or truncated index file is a *degraded* service that
 * rebuilds, never a boot failure.
 *
 * @param {object} [deps] Dependencies.
 * @param {ReturnType<typeof getConfig>} [deps.config] Application config.
 * @param {any} [deps.embeddings] Embedding service, used to embed a query.
 * @param {any} [deps.chain] Chain service, used by {@link SemanticService.rebuild}.
 * @param {any} [deps.reputation] Reputation service, used for the trust weight.
 * @param {any} [deps.logger] Pino logger.
 * @param {import('./instrument.js').MetricsLike} [deps.metrics] Metrics collector.
 * @param {boolean} [deps.persist] Whether to read and write the index file. Defaults to off under
 *   test, because a unit test that writes to the developer's real index path is a test that changes
 *   its own future results.
 * @param {() => number} [deps.now] Clock, in epoch milliseconds.
 * @returns {SemanticService} The service.
 */
export function createSemanticService({
  config = getConfig(),
  embeddings,
  chain,
  reputation,
  logger = defaultLogger,
  metrics,
  persist,
  now = Date.now,
} = {}) {
  const log = logger.child ? logger.child({ service: 'semantic' }) : logger;
  const instruments = normalizeMetrics(metrics);
  const shouldPersist = persist ?? !config.app.isTest;
  const outDim = constants.SHARED_EMBEDDING_DIM;

  /**
   * The index. Insertion order is LRU order: a re-`upsert` deletes and re-inserts, and eviction
   * takes the front of the map.
   *
   * @type {Map<string, IndexEntry>}
   */
  const index = new Map();
  /** @type {Map<string, {at: number, tau: number}>} */
  const trustCache = new Map();
  /** @type {'idle'|'ready'|'degraded'} */
  let status = 'idle';
  /** @type {string|null} */
  let loadedFrom = null;
  let dirty = false;

  /* ---------------------------------------------------------------------- */
  /* Alignment                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Align an embedding into the shared semantic space.
   *
   * There is deliberately **no** dimension-guessing fallback and **no** zero-padding path. Padding a
   * 384-dimension vector with 384 zeros does not place it in a 768-dimension model's space; it only
   * makes the cosine computable, which is worse than refusing, because a computable meaningless
   * number gets plotted. `projection.alignEmbedding` throws on an expansion request and this service
   * translates that into a 422 rather than papering over it.
   *
   * @param {ArrayLike<number>} vector The model's raw output.
   * @param {object} [options] Options.
   * @param {string|null} [options.modelId] Model identifier, echoed into the result for provenance.
   * @param {number} [options.targetDim] Shared dimension; defaults to the protocol's.
   * @returns {AlignResult} The aligned vector, its projection id and its SimHash.
   */
  function align(vector, options = {}) {
    const targetDim = options.targetDim ?? outDim;
    const stop = instruments.timer('neuromesh_semantic_align_duration_seconds');
    try {
      const aligned = projection.alignEmbedding({ embedding: vector, targetDim });
      // Round-trip through float32 immediately. The payload publishes and digests the float32
      // encoding, so anything the index holds at higher precision would compute a slightly different
      // cosine than a peer that decrypted the published bytes.
      const z = Float32Array.from(aligned.aligned);
      const lsh = projection.simhash256(z);
      return {
        z,
        lsh,
        projectionId: aligned.projectionId,
        sourceDim: aligned.sourceDim,
        outDim: aligned.targetDim,
        projected: aligned.projected,
        noiseBaseline: aligned.noiseBaseline,
        modelId: options.modelId ?? null,
      };
    } catch (err) {
      const any = /** @type {any} */ (err);
      if (any?.code === 'DIMENSION_MISMATCH') {
        throw errors.badRequest(
          `This embedding cannot be aligned into the shared ${targetDim}-dimension space: ` +
            `${any.message} There is no zero-padding path, because padding does not make two ` +
            'model spaces comparable - it only makes the cosine computable.',
          { sourceDim: vector?.length ?? null, targetDim },
        );
      }
      throw err;
    } finally {
      stop();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Index                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Insert or replace one index entry.
   *
   * @param {object} entry The entry.
   * @param {string} entry.cid CID of the memory.
   * @param {string} [entry.cidDigest] sha2-256 digest of the payload bytes; derived from `cid` when
   *   omitted.
   * @param {string} entry.owner Owning agent address.
   * @param {ArrayLike<number>} entry.z Aligned embedding.
   * @param {Uint8Array} [entry.lsh] SimHash; recomputed from `z` when omitted.
   * @param {string} entry.projectionId Projection the vector passed through.
   * @param {number} [entry.createdAt] Unix seconds.
   * @param {string} [entry.model] Model URI or tag, for display.
   * @param {boolean} [entry.encrypted] Whether the memory's context is sealed.
   * @param {boolean} [entry.revoked] Whether the on-chain record is revoked.
   * @returns {IndexEntry} The stored entry.
   */
  function upsert(entry) {
    if (!entry?.cid) throw errors.badRequest('upsert() requires a cid.');
    if (!entry.z || typeof entry.z.length !== 'number' || entry.z.length === 0) {
      throw errors.badRequest('upsert() requires an aligned embedding.');
    }
    if (!entry.projectionId) {
      throw errors.badRequest(
        'upsert() requires a projectionId. An entry with no recorded projection can never be ' +
          'safely compared with anything, which is exactly the bug this field exists to prevent.',
      );
    }
    const z = entry.z instanceof Float32Array ? entry.z : Float32Array.from(entry.z);
    const key = entry.cidDigest ?? canonical.digestFromCid(entry.cid);
    /** @type {IndexEntry} */
    const stored = {
      cid: entry.cid,
      cidDigest: key,
      owner: entry.owner,
      z,
      lsh: entry.lsh ?? projection.simhash256(z),
      projectionId: entry.projectionId,
      createdAt: entry.createdAt ?? Math.floor(now() / 1000),
      model: entry.model ?? null,
      encrypted: entry.encrypted ?? true,
      revoked: entry.revoked ?? false,
    };
    index.delete(key);
    index.set(key, stored);
    evict();
    dirty = true;
    status = 'ready';
    instruments.gauge('neuromesh_semantic_index_size', index.size);
    return stored;
  }

  /**
   * Drop the oldest entries until the index is within its bound.
   *
   * @returns {number} How many entries were evicted.
   */
  function evict() {
    let dropped = 0;
    while (index.size > config.semantic.indexMax) {
      const oldest = index.keys().next();
      if (oldest.done) break;
      index.delete(oldest.value);
      dropped += 1;
    }
    return dropped;
  }

  /**
   * @param {string} cidDigest Index key.
   * @returns {boolean} Whether an entry was removed.
   */
  function remove(cidDigest) {
    const removed = index.delete(cidDigest);
    if (removed) {
      dirty = true;
      instruments.gauge('neuromesh_semantic_index_size', index.size);
    }
    return removed;
  }

  /**
   * @param {string} cidDigest Index key.
   * @returns {IndexEntry|null} The entry, or null.
   */
  function get(cidDigest) {
    return index.get(cidDigest) ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /* Trust                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * The calibrated trust `tau` in [0, 1] for one agent.
   *
   * Degrades to 0 - the trust *floor*, not a rejection - when reputation is unavailable. A node with
   * no chain connection still returns results; it just ranks everything at `theta`, the floor of the
   * trust multiplier. Reputation re-ranks, it never gates, and an outage must not silently become a
   * gate.
   *
   * @param {string} owner Agent address.
   * @returns {Promise<number>} `tau` in [0, 1].
   */
  async function trustFor(owner) {
    if (!owner || !reputation?.scoreOf) return 0;
    const cached = trustCache.get(owner);
    if (cached && now() - cached.at < TRUST_CACHE_MS) return cached.tau;
    /** @type {number} */
    let tau;
    try {
      const score = await reputation.scoreOf(owner);
      tau = clamp01(Number(score?.score ?? 0));
    } catch (err) {
      log.debug?.(
        { owner, err: String(/** @type {any} */ (err)?.message ?? err) },
        'trust lookup failed; this agent ranks at the trust floor rather than being dropped',
      );
      tau = 0;
    }
    trustCache.set(owner, { at: now(), tau });
    return tau;
  }

  /* ---------------------------------------------------------------------- */
  /* Search                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Trust-weighted semantic search over the local index.
   *
   * Four stages, in this order and for these reasons:
   *   1. **Align.** The query is projected through the same deterministic projection as everything
   *      in the index. Its `projectionId` is what the filter stage compares against.
   *   2. **Candidate.** Rank by Hamming distance on the 256-bit SimHash and keep
   *      `max(200, topK*20)`. An exact scan, honestly described (see the module header).
   *   3. **Filter.** Drop revoked entries, and drop every entry whose `projectionId` differs from
   *      the query's. That filter is the correctness guarantee: comparing across projections is the
   *      original bug, and producing a number for it anyway would reintroduce it at the ranking layer.
   *   4. **Rank.** `score = max(0, cos) * (theta + (1-theta) * tau^phi) * 2^(-ageDays/halfLife)`
   *      with theta = 0.2 and phi = 0.5, ties broken by ascending CID so the ordering is total and
   *      identical on every machine.
   *
   * @param {object} args Arguments.
   * @param {string} [args.query] Text to embed and search for.
   * @param {ArrayLike<number>} [args.embedding] A pre-computed raw model vector, instead of `query`.
   * @param {number} [args.topK] Maximum results.
   * @param {number} [args.minSimilarity] Cosine floor applied after ranking.
   * @param {boolean} [args.trustWeighted] Whether to apply the trust and recency factors.
   * @param {string} [args.model] Embedding model key for the query.
   * @param {string} [args.owner] Restrict to one owner.
   * @returns {Promise<SearchResponse>} Results and diagnostics.
   */
  async function search({
    query,
    embedding,
    topK = 10,
    minSimilarity = 0,
    trustWeighted = true,
    model,
    owner = undefined,
  } = {}) {
    const started = now();
    if (!query && !embedding) {
      throw errors.badRequest('search() requires either a query string or an embedding.');
    }
    if (!Number.isInteger(topK) || topK < 1 || topK > 100) {
      throw errors.badRequest('topK must be an integer between 1 and 100.');
    }

    /** @type {ArrayLike<number>} */
    let raw;
    /** @type {string|null} */
    let modelId = null;
    if (embedding) {
      raw = embedding;
    } else {
      if (!embeddings?.embed) {
        throw errors.notReady({ embeddings: { status: 'absent' } });
      }
      const result = await embeddings.embed(/** @type {string} */ (query), { model });
      raw = result.vector;
      modelId = result.modelId;
    }

    const aligned = align(raw, { modelId });

    // Stage 2: candidates by Hamming distance. Bounded, exact, and linear in the index size.
    const pool = Math.max(MIN_CANDIDATES, topK * 20);
    /** @type {Array<{entry: IndexEntry, hamming: number}>} */
    const scoredByHamming = [];
    /** @type {Array<{cid: string, reason: string}>} */
    const skipped = [];
    for (const entry of index.values()) {
      if (entry.revoked) {
        skipped.push({ cid: entry.cid, reason: 'revoked' });
        continue;
      }
      if (owner && entry.owner?.toLowerCase() !== owner.toLowerCase()) continue;
      if (entry.projectionId !== aligned.projectionId) {
        skipped.push({
          cid: entry.cid,
          reason: `projection_mismatch: entry is ${entry.projectionId}, query is ${aligned.projectionId}`,
        });
        continue;
      }
      /** @type {number} */
      let hamming;
      try {
        hamming = projection.hammingDistance(aligned.lsh, entry.lsh);
      } catch {
        // A signature of the wrong width belongs to a different protocol version. Rank it last
        // rather than dropping it silently, and let the exact cosine stage decide.
        hamming = Number.MAX_SAFE_INTEGER;
      }
      scoredByHamming.push({ entry, hamming });
    }
    scoredByHamming.sort(
      (a, b) => a.hamming - b.hamming || (a.entry.cidDigest < b.entry.cidDigest ? -1 : 1),
    );
    const candidates = scoredByHamming.slice(0, pool);

    // Stage 3/4: exact cosine plus the trust and recency factors, delegated to the protocol so the
    // formula lives in exactly one place and is unit-tested there.
    const nowSeconds = Math.floor(now() / 1000);
    const enriched = [];
    for (const { entry } of candidates) {
      const tau = trustWeighted ? await trustFor(entry.owner) : 0;
      enriched.push({
        cid: entry.cid,
        embedding: entry.z,
        projectionId: entry.projectionId,
        reputation: tau,
        ageDays: Math.max(0, (nowSeconds - entry.createdAt) / 86400),
      });
    }
    const ranked = similarity.rankMemories(aligned.z, enriched, {
      topK,
      projectionId: aligned.projectionId,
      ...(trustWeighted ? {} : { theta: 1, phi: 1, recencyHalfLifeDays: Infinity }),
    });
    skipped.push(...ranked.skipped);

    const byCid = new Map(candidates.map(({ entry }) => [entry.cid, entry]));
    const results = ranked.results
      .filter((row) => row.similarity >= minSimilarity)
      .map((row) => {
        const entry = /** @type {IndexEntry} */ (byCid.get(row.cid));
        const tau = enriched.find((c) => c.cid === row.cid)?.reputation ?? 0;
        return {
          cid: row.cid,
          cidDigest: entry.cidDigest,
          similarity: row.similarity,
          score: row.score,
          trustWeight: tau,
          owner: entry.owner,
          model: entry.model,
          createdAt: entry.createdAt,
          encrypted: entry.encrypted,
          // Never a fabricated snippet. The plaintext is only available through the authenticated
          // per-CID unwrap, so a search result carries no preview at all.
          preview: null,
        };
      });

    const tookMs = now() - started;
    instruments.observe('neuromesh_semantic_search_duration_seconds', tookMs / 1000);
    return {
      query: query ?? null,
      topK,
      trustWeighted,
      results,
      tookMs,
      diagnostics: {
        indexSize: index.size,
        candidateCount: candidates.length,
        projectionId: aligned.projectionId,
        outDim: aligned.outDim,
        // Shipped with every response on purpose: any similarity within roughly three of these of
        // zero is indistinguishable from a comparison between unrelated vectors.
        noiseBaseline: aligned.noiseBaseline,
        skipped: skipped.slice(0, 20),
        skippedCount: skipped.length,
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Persistence and lifecycle                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Load the persisted index.
   *
   * Never throws. A missing file is a cold start; a truncated or corrupt line is skipped with a
   * count in the log. Refusing to boot over a damaged *cache* would be the wrong trade: the index is
   * rebuildable from the chain, and the memories themselves are on IPFS.
   *
   * @returns {Promise<{loaded: number, skipped: number}>} What was read.
   */
  async function init() {
    if (!shouldPersist) {
      status = index.size > 0 ? 'ready' : 'degraded';
      return { loaded: 0, skipped: 0 };
    }
    let loaded = 0;
    let bad = 0;
    try {
      const text = readFileSync(config.semantic.indexPath, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          upsert({
            cid: row.cid,
            cidDigest: row.cidDigest,
            owner: row.owner,
            z: canonical.b64ToF32(row.z),
            lsh: Uint8Array.from(Buffer.from(row.lsh, 'base64url')),
            projectionId: row.projectionId,
            createdAt: row.createdAt,
            model: row.model,
            encrypted: row.encrypted,
            revoked: row.revoked,
          });
          loaded += 1;
        } catch {
          bad += 1;
        }
      }
      loadedFrom = config.semantic.indexPath;
      dirty = false;
    } catch (err) {
      const code = String(/** @type {any} */ (err)?.code ?? '');
      if (code !== 'ENOENT') {
        log.warn?.(
          {
            path: config.semantic.indexPath,
            err: String(/** @type {any} */ (err)?.message ?? err),
          },
          'semantic index could not be read; starting empty',
        );
      }
    }
    status = index.size > 0 ? 'ready' : 'degraded';
    if (loaded || bad) log.info?.({ loaded, skipped: bad }, 'semantic index loaded');
    return { loaded, skipped: bad };
  }

  /**
   * Persist the index atomically.
   *
   * Temp file plus rename, because a half-written index read at the next boot would be silently
   * wrong rather than obviously broken - and `rename` is atomic within a filesystem on every
   * platform this runs on.
   *
   * @returns {Promise<{written: number, path: string|null}>} What was written.
   */
  async function save() {
    if (!shouldPersist || !dirty) return { written: 0, path: null };
    const path = config.semantic.indexPath;
    const temp = `${path}.${process.pid}.tmp`;
    const lines = [];
    for (const entry of index.values()) {
      lines.push(
        JSON.stringify({
          cid: entry.cid,
          cidDigest: entry.cidDigest,
          owner: entry.owner,
          z: canonical.f32ToB64(entry.z),
          lsh: Buffer.from(entry.lsh).toString('base64url'),
          projectionId: entry.projectionId,
          createdAt: entry.createdAt,
          model: entry.model,
          encrypted: entry.encrypted,
          revoked: entry.revoked,
        }),
      );
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(temp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
      renameSync(temp, path);
      dirty = false;
      return { written: lines.length, path };
    } catch (err) {
      log.warn?.(
        { path, err: String(/** @type {any} */ (err)?.message ?? err) },
        'semantic index could not be persisted; it will be rebuilt on the next start',
      );
      return { written: 0, path: null };
    }
  }

  /**
   * Rebuild the index from the chain's owner index.
   *
   * Only the *metadata* can be rebuilt this way: the aligned vector lives inside the encrypted
   * payload, so an entry restored from the chain alone has no embedding and is therefore not
   * searchable. This returns what it could and what it could not, rather than pretending a metadata
   * rebuild restored search.
   *
   * @param {object} [options] Options.
   * @param {string} [options.owner] Owner to enumerate; defaults to this node's agent.
   * @param {number} [options.limit] Maximum records to walk.
   * @returns {Promise<{scanned: number, restored: number, unsearchable: number}>} The outcome.
   */
  async function rebuild({ owner, limit = 500 } = {}) {
    const target = owner ?? chain?.address?.();
    if (!target) {
      throw errors.badRequest('rebuild() needs an owner address, and this node has no signer.');
    }
    if (!chain?.readLedger) throw errors.chainUnavailable('No chain service is available.');
    let scanned = 0;
    let restored = 0;
    let unsearchable = 0;
    const pageSize = 50;
    for (let offset = 0; offset < limit; offset += pageSize) {
      const page = await chain.readLedger.getOwnerMemoryRecords(target, offset, pageSize);
      if (page.page.length === 0) break;
      for (const record of page.page) {
        scanned += 1;
        const key = canonical.digestFromCid(record.cid);
        const existing = index.get(key);
        if (existing) {
          existing.revoked = record.revoked;
          existing.owner = record.owner;
          restored += 1;
        } else {
          unsearchable += 1;
        }
      }
      if (offset + pageSize >= page.total) break;
    }
    dirty = true;
    log.info?.({ scanned, restored, unsearchable }, 'semantic index reconciled against the chain');
    return { scanned, restored, unsearchable };
  }

  /* ---------------------------------------------------------------------- */
  /* Cross-model similarity                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * The cross-model similarity matrix, computed from what this node actually holds.
   *
   * ## What it is, and what it deliberately is not
   *
   * Cells are the mean and maximum cosine between the aligned vectors of memories committed under
   * each pair of models. It runs **no inference**: a `GET` that quietly loaded a second 90 MB model
   * would be a denial-of-service handed to anyone who can reach the dashboard. Every number comes
   * from vectors already in the index.
   *
   * Two rules keep the numbers meaningful rather than merely computable:
   *
   *   1. A pair whose `projectionId` differs is **skipped**, never scored. Comparing across
   *      projections is the original defect this service exists to fix; producing a number for it
   *      anyway would reintroduce that defect one layer up.
   *   2. Every cell carries `significant`, which is `|mean| > 3 * noiseBaseline`. The repository's
   *      own v1 `simulation-results.json` fitted the pure-noise null at chi-square 3.82 on 6
   *      degrees of freedom, p = 0.70 - the published cross-model cosines were indistinguishable
   *      from comparisons between unrelated vectors. Shipping the baseline beside every cell is
   *      what makes a regression back to that state visible instead of plausible.
   *
   * Sampling is deterministic (a fixed stride, never `Math.random`), so two calls over an unchanged
   * index return byte-identical numbers.
   *
   * @param {object} [options] Options.
   * @param {number} [options.maxPairs] Upper bound on the pairs scored per cell.
   * @returns {{labels: string[], matrix: Array<Array<number|null>>,
   *   cells: Array<Record<string, any>>, models: Array<Record<string, any>>,
   *   diagnostics: Record<string, any>}} The matrix and its diagnostics.
   */
  function crossModelSimilarity({ maxPairs = 2000 } = {}) {
    /** @type {Map<string, IndexEntry[]>} */
    const groups = new Map();
    for (const entry of index.values()) {
      if (entry.revoked) continue;
      const label = entry.model ?? 'unknown';
      const bucket = groups.get(label);
      if (bucket) bucket.push(entry);
      else groups.set(label, [entry]);
    }

    const labels = [...groups.keys()].sort();
    const baseline = projection.noiseBaseline(outDim);
    /** @type {Array<Array<number|null>>} */
    const matrix = labels.map(() => labels.map(() => null));
    /** @type {Array<Record<string, any>>} */
    const cells = [];
    let skippedProjection = 0;

    for (let i = 0; i < labels.length; i += 1) {
      for (let j = i; j < labels.length; j += 1) {
        const left = /** @type {IndexEntry[]} */ (groups.get(labels[i]));
        const right = /** @type {IndexEntry[]} */ (groups.get(labels[j]));
        let scored = 0;
        let sum = 0;
        let max = -1;
        outer: for (let a = 0; a < left.length; a += 1) {
          // A within-model cell must not score an entry against itself: a self-cosine is 1 by
          // construction and would inflate the diagonal into a fabricated perfect match.
          const from = i === j ? a + 1 : 0;
          for (let b = from; b < right.length; b += 1) {
            if (left[a].cidDigest === right[b].cidDigest) continue;
            if (left[a].projectionId !== right[b].projectionId) {
              skippedProjection += 1;
              continue;
            }
            const value = similarity.cosineSimilarity(left[a].z, right[b].z);
            sum += value;
            if (value > max) max = value;
            scored += 1;
            if (scored >= maxPairs) break outer;
          }
        }
        const mean = scored > 0 ? sum / scored : null;
        matrix[i][j] = mean;
        matrix[j][i] = mean;
        cells.push({
          fromModel: labels[i],
          toModel: labels[j],
          pairs: scored,
          meanCosine: mean,
          maxCosine: scored > 0 ? max : null,
          significant: mean === null ? null : Math.abs(mean) > 3 * baseline,
        });
      }
    }

    return {
      labels,
      matrix,
      cells,
      models: labels.map((label) => ({
        model: label,
        entries: /** @type {IndexEntry[]} */ (groups.get(label)).length,
      })),
      diagnostics: {
        indexSize: index.size,
        outDim,
        noiseBaseline: baseline,
        significanceThreshold: 3 * baseline,
        maxPairs,
        skippedProjectionMismatch: skippedProjection,
        method: 'exact cosine over aligned vectors already held in the index; no inference is run',
      },
    };
  }

  /**
   * @returns {SemanticStats} Observable state.
   */
  function stats() {
    /** @type {Record<string, number>} */
    const byProjection = {};
    for (const entry of index.values()) {
      byProjection[entry.projectionId] = (byProjection[entry.projectionId] ?? 0) + 1;
    }
    return {
      status,
      size: index.size,
      max: config.semantic.indexMax,
      outDim,
      projectionId: projection.projectionId(outDim, outDim),
      noiseBaseline: projection.noiseBaseline(outDim),
      byProjection,
      persisted: shouldPersist,
      loadedFrom,
      dirty,
    };
  }

  /** @type {SemanticService} */
  const service = {
    init,
    align,
    search,
    upsert,
    remove,
    get,
    stats,
    crossModelSimilarity,
    rebuild,
    save,
    size: () => index.size,
    clear: () => {
      index.clear();
      trustCache.clear();
      dirty = true;
    },
    async shutdown() {
      await save();
      index.clear();
      trustCache.clear();
    },
  };
  return service;
}

/* ------------------------------------------------------------------------ */
/* Types                                                                     */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {object} IndexEntry
 * @property {string} cid CID of the memory.
 * @property {string} cidDigest sha2-256 of the payload bytes; the index key.
 * @property {string} owner Owning agent address.
 * @property {Float32Array} z Aligned embedding.
 * @property {Uint8Array} lsh 256-bit SimHash of `z`.
 * @property {string} projectionId Projection the vector passed through.
 * @property {number} createdAt Unix seconds.
 * @property {string|null} model Model URI or tag.
 * @property {boolean} encrypted Whether the context is sealed.
 * @property {boolean} revoked Whether the on-chain record is revoked.
 */

/**
 * @typedef {object} AlignResult
 * @property {Float32Array} z The aligned, L2-normalised vector.
 * @property {Uint8Array} lsh 256-bit SimHash of `z`.
 * @property {string} projectionId Identifier two vectors must share to be comparable.
 * @property {number} sourceDim Input dimensionality.
 * @property {number} outDim Output dimensionality.
 * @property {boolean} projected Whether a projection was actually applied.
 * @property {number} noiseBaseline 1/sqrt(outDim).
 * @property {string|null} modelId Model the source vector came from.
 */

/**
 * @typedef {object} SemanticStats
 * @property {'idle'|'ready'|'degraded'} status Service state.
 * @property {number} size Entries held.
 * @property {number} max Capacity.
 * @property {number} outDim Shared dimension.
 * @property {string} projectionId Identity projection id for the shared dimension.
 * @property {number} noiseBaseline 1/sqrt(outDim).
 * @property {Record<string, number>} byProjection Entry counts per projection.
 * @property {boolean} persisted Whether the index is written to disk.
 * @property {string|null} loadedFrom Path the index was read from.
 * @property {boolean} dirty Whether there are unsaved changes.
 */

/**
 * @typedef {object} SearchResponse
 * @property {string|null} query The query text, when there was one.
 * @property {number} topK Requested result count.
 * @property {boolean} trustWeighted Whether trust and recency were applied.
 * @property {Array<object>} results Ranked results.
 * @property {number} tookMs Wall-clock duration.
 * @property {object} diagnostics Index size, candidate count, projection id and noise baseline.
 */

/**
 * @typedef {object} SemanticService
 * @property {() => Promise<{loaded: number, skipped: number}>} init Load the persisted index.
 * @property {(vector: ArrayLike<number>, options?: object) => AlignResult} align Align one vector.
 * @property {(args?: object) => Promise<SearchResponse>} search Trust-weighted retrieval.
 * @property {(entry: {cid: string, cidDigest?: string, owner: string, z: ArrayLike<number>,
 *   lsh?: Uint8Array, projectionId: string, createdAt?: number, model?: string, encrypted?: boolean,
 *   revoked?: boolean}) => IndexEntry} upsert Insert or replace an entry.
 * @property {(cidDigest: string) => boolean} remove Drop an entry.
 * @property {(cidDigest: string) => IndexEntry|null} get Read an entry.
 * @property {() => SemanticStats} stats Observable state.
 * @property {(options?: {maxPairs?: number}) => {labels: string[],
 *   matrix: Array<Array<number|null>>, cells: Array<Record<string, any>>,
 *   models: Array<Record<string, any>>, diagnostics: Record<string, any>}} crossModelSimilarity
 *   The cross-model matrix, computed from the index without running inference.
 * @property {(options?: object) => Promise<object>} rebuild Reconcile against the chain.
 * @property {() => Promise<{written: number, path: string|null}>} save Persist atomically.
 * @property {() => number} size Entries held.
 * @property {() => void} clear Empty the index.
 * @property {() => Promise<void>} shutdown Persist and release.
 */

/**
 * @param {number} value Candidate.
 * @returns {number} `value` clamped into [0, 1]; a non-finite input becomes 0.
 */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export default createSemanticService;
