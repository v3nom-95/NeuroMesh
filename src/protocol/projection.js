/**
 * NeuroMesh Protocol — deterministic cross-model projection.
 *
 * ## The bug this module replaces
 *
 * `lib/semantic-sync.js` built its projection matrix from `Math.random()`. The matrix was therefore
 * different on every process start and different on every node, so two nodes projected their 768-d
 * embeddings into two *independent* random 384-d subspaces. The cosine between node A's projected
 * vector and node B's projected vector then has expectation 0 and standard deviation 1/sqrt(384) =
 * 0.051 — it carries no semantic information at all. Measured against this repository's own
 * committed results: six cross-model cosines with sample SD 0.0441 against the 0.0510 noise
 * prediction, chi-square 3.82 on 6 degrees of freedom, p = 0.70. The published similarity matrix fit
 * the pure-noise null comfortably.
 *
 * ## What this module guarantees, and what it does not
 *
 * It guarantees **determinism**: the same `(fromDim, toDim)` produces a byte-identical matrix in
 * every process, on every machine, forever, because the matrix is drawn from an AES-256-CTR
 * keystream under a seed derived by keccak256 from protocol constants and the two dimensions. There
 * is no entropy source, no wall clock, no module state that survives a call, and `Math.random`
 * appears nowhere in this file — a test greps for it.
 *
 * It does **not** claim that projecting two independently trained encoders into a shared space makes
 * their coordinates comparable. Johnson–Lindenstrauss is a *within-space* guarantee: it approximately
 * preserves distances between points that already live in one space. Two encoders share no basis, so
 * a shared seed buys reproducibility, not meaning. Cross-model comparison is only sound once an
 * anchor-based alignment bundle exists (relative representations, Moschella et al., ICLR 2023);
 * until then, treat cross-model scores as *reproducible* and compare them against
 * {@link noiseBaseline} before believing them. That comparison is a first-class export here
 * precisely because omitting it is what produced the original claim.
 *
 * ## The construction, specified exactly
 *
 * Seed:
 *
 *     seedKey = keccak256(utf8("neuromesh/projection/v1" ‖ "|" ‖ alg ‖ "|" ‖ from ‖ "->" ‖ to))
 *
 * Keystream: `AES-256-CTR` with `key = seedKey` (32 bytes) and `iv = 16 zero bytes`, encrypting an
 * all-zero plaintext. Words are consumed as **big-endian uint32** in stream order.
 *
 * Entries: sparse Achlioptas (density 1/3). For each entry, one uint32 `u` is drawn and mapped
 *
 *     u <  715827882  (= floor(2^32/6))  → +1
 *     u < 1431655765  (= floor(2^32/3))  → −1
 *     otherwise                          →  0
 *
 * then scaled by `sqrt(3 / toDim)`, which preserves expected norms. The two thresholds give
 * P(+1) = P(−1) = 0.1666666665, a bias of 8·10⁻¹¹ from exactly 1/6 — far below any effect on the
 * distance-preservation bound, and stated here rather than hidden.
 *
 * Generation order: row-major, `i` (source dimension) outer, `j` (target dimension) inner, one
 * uint32 per entry. Reproducing the matrix in another language requires only AES-CTR and this
 * paragraph.
 *
 * @module src/protocol/projection
 */

import { createCipheriv } from 'node:crypto';

import { keccak256, toUtf8Bytes } from 'ethers';

import { sha256 } from './canonical.js';
import {
  LIMITS,
  PROJECTION_ALG,
  PROJECTION_PRNG,
  PROJECTION_SEED_LABEL,
  PROJECTION_VERSION,
  SHARED_EMBEDDING_DIM,
  SIMHASH_BITS,
} from './constants.js';
import { DimensionMismatchError, ProtocolError } from './errors.js';

/** Threshold below which a drawn word maps to +1: floor(2^32 / 6). */
const T_POS = 715827882;

/** Threshold below which a drawn word maps to −1: floor(2^32 / 3). */
const T_NEG = 1431655765;

/**
 * The frozen parameter set. Anything that changes a matrix must change one of these values, and
 * changing any of them changes every `projectionId`.
 */
export const PROJECTION_PARAMS = Object.freeze({
  version: PROJECTION_VERSION,
  alg: PROJECTION_ALG,
  prng: PROJECTION_PRNG,
  seedLabel: PROJECTION_SEED_LABEL,
  /** Achlioptas density parameter s: one third of entries are non-zero. */
  density: 3,
  /** Entry scale, as a function of the target dimension: sqrt(s / toDim). */
  scaleFormula: 'sqrt(3 / toDim)',
  thresholdPositive: T_POS,
  thresholdNegative: T_NEG,
  wordOrder: 'big-endian uint32',
  generationOrder: 'row-major (source dim outer, target dim inner)',
  defaultTargetDim: SHARED_EMBEDDING_DIM,
});

/**
 * Matrices are memoised per `(fromDim, toDim)`. This is a pure cache: the value it holds is a
 * deterministic function of the key, so its presence or absence cannot change any output.
 *
 * @type {Map<string, Float64Array>}
 */
const matrixCache = new Map();

/* -------------------------------------------------------------------------- */
/* Deterministic keystream                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The 32-byte AES key that seeds the keystream for one `(fromDim, toDim)` pair.
 *
 * @param {number} fromDim Source dimensionality.
 * @param {number} toDim Target dimensionality.
 * @returns {string} 0x-prefixed 32-byte hex seed.
 */
export function projectionSeed(fromDim, toDim) {
  return keccak256(toUtf8Bytes(`${PROJECTION_SEED_LABEL}|${PROJECTION_ALG}|${fromDim}->${toDim}`));
}

/**
 * Open an AES-256-CTR keystream and return a function yielding successive big-endian uint32 words.
 *
 * The keystream is generated in blocks rather than word by word, purely for speed; the byte sequence
 * is identical either way, because CTR mode is a pure function of `(key, iv, position)`.
 *
 * @param {string} seedHex 0x-prefixed 32-byte hex key.
 * @returns {() => number} Generator returning the next uint32.
 */
export function keystream(seedHex) {
  const key = Buffer.from(seedHex.slice(2), 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = createCipheriv(PROJECTION_PRNG, key, iv);
  const BLOCK_WORDS = 4096;
  /** @type {Buffer} */
  let block = Buffer.alloc(0);
  let offset = 0;
  return function next() {
    if (offset + 4 > block.length) {
      block = cipher.update(Buffer.alloc(BLOCK_WORDS * 4, 0));
      offset = 0;
    }
    const word = block.readUInt32BE(offset);
    offset += 4;
    return word;
  };
}

/* -------------------------------------------------------------------------- */
/* Matrix construction                                                         */
/* -------------------------------------------------------------------------- */

/**
 * @param {number} fromDim Source dimensionality.
 * @param {number} toDim Target dimensionality.
 * @returns {void}
 */
function assertDims(fromDim, toDim) {
  for (const [name, dim] of [
    ['fromDim', fromDim],
    ['toDim', toDim],
  ]) {
    if (
      !Number.isInteger(dim) ||
      Number(dim) < LIMITS.MIN_EMBEDDING_DIM ||
      Number(dim) > LIMITS.MAX_EMBEDDING_DIM
    ) {
      throw new DimensionMismatchError(
        `${name} must be an integer in [${LIMITS.MIN_EMBEDDING_DIM}, ${LIMITS.MAX_EMBEDDING_DIM}], got ${String(dim)}.`,
        { [String(name)]: dim },
      );
    }
  }
  if (fromDim < toDim) {
    throw new DimensionMismatchError(
      `Refusing to "expand" a ${fromDim}-d embedding to ${toDim} dimensions. The v1 code zero-padded ` +
        'here and returned the result as "aligned"; the cosine that follows is then computed over ' +
        'arbitrary coordinate correspondences plus a block of zeros and has no interpretation. ' +
        'Project into a shared dimension that is no larger than the smallest model, or align both ' +
        'models against an anchor set.',
      { fromDim, toDim },
    );
  }
}

/**
 * Stable identifier for a projection.
 *
 * Every aligned vector, every index entry and every search response carries this string. Two vectors
 * may only be compared when their `projectionId` values are equal — that check is what turns a
 * silent mismatch into a loud one.
 *
 * @param {number} fromDim Source dimensionality.
 * @param {number} toDim Target dimensionality.
 * @returns {string} e.g. `neuromesh-proj/v1/achlioptas-s3/aes-256-ctr/768-384/9f2c1a4b`.
 */
export function projectionId(fromDim, toDim = SHARED_EMBEDDING_DIM) {
  assertDims(fromDim, toDim);
  const seed = projectionSeed(fromDim, toDim);
  return `neuromesh-proj/${PROJECTION_VERSION}/${PROJECTION_ALG}/${PROJECTION_PRNG}/${fromDim}-${toDim}/${seed.slice(2, 10)}`;
}

/**
 * Build (or return the memoised) projection matrix.
 *
 * @param {number} fromDim Source dimensionality.
 * @param {number} toDim Target dimensionality; must be <= `fromDim`.
 * @returns {Float64Array} Row-major `fromDim x toDim` matrix. Treat as read-only.
 */
export function buildProjectionMatrix(fromDim, toDim = SHARED_EMBEDDING_DIM) {
  assertDims(fromDim, toDim);
  const cacheKey = `${fromDim}:${toDim}`;
  const cached = matrixCache.get(cacheKey);
  if (cached) return cached;

  const next = keystream(projectionSeed(fromDim, toDim));
  const scale = Math.sqrt(PROJECTION_PARAMS.density / toDim);
  const matrix = new Float64Array(fromDim * toDim);
  for (let i = 0; i < fromDim; i += 1) {
    const rowBase = i * toDim;
    for (let j = 0; j < toDim; j += 1) {
      const word = next();
      matrix[rowBase + j] = word < T_POS ? scale : word < T_NEG ? -scale : 0;
    }
  }
  matrixCache.set(cacheKey, matrix);
  return matrix;
}

/**
 * sha2-256 of a projection matrix's little-endian float64 bytes.
 *
 * The cheapest possible cross-process determinism assertion: two nodes that disagree on this string
 * are projecting into different subspaces, and every cross-node similarity they exchange is noise.
 *
 * @param {number} fromDim Source dimensionality.
 * @param {number} toDim Target dimensionality.
 * @returns {string} 0x-prefixed 32-byte hex digest.
 */
export function projectionMatrixDigest(fromDim, toDim = SHARED_EMBEDDING_DIM) {
  const matrix = buildProjectionMatrix(fromDim, toDim);
  const bytes = new Uint8Array(matrix.length * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < matrix.length; i += 1) view.setFloat64(i * 8, matrix[i], true);
  return `0x${Buffer.from(sha256(bytes)).toString('hex')}`;
}

/* -------------------------------------------------------------------------- */
/* Projection and alignment                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Project a vector through the deterministic matrix.
 *
 * The accumulation order is fixed (`i` outer, `j` inner), so the floating-point result is
 * bit-identical across processes on the same IEEE-754 platform.
 *
 * @param {ArrayLike<number>} vector Source vector of length `fromDim`.
 * @param {number} toDim Target dimensionality.
 * @returns {Float64Array} Projected vector of length `toDim`.
 */
export function projectEmbedding(vector, toDim = SHARED_EMBEDDING_DIM) {
  const fromDim = vector.length;
  const matrix = buildProjectionMatrix(fromDim, toDim);
  const out = new Float64Array(toDim);
  for (let i = 0; i < fromDim; i += 1) {
    const value = vector[i];
    if (value === 0) continue;
    const rowBase = i * toDim;
    for (let j = 0; j < toDim; j += 1) out[j] += value * matrix[rowBase + j];
  }
  return out;
}

/**
 * L2-normalise a vector in place-free fashion.
 *
 * @param {ArrayLike<number>} vector Input.
 * @returns {Float64Array} Unit-norm copy; an all-zero input is returned unchanged.
 */
export function l2Normalize(vector) {
  let norm = 0;
  for (let i = 0; i < vector.length; i += 1) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  const out = new Float64Array(vector.length);
  if (norm === 0) return out;
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/**
 * The result of aligning one embedding into the shared space.
 *
 * @typedef {object} AlignedEmbedding
 * @property {Float64Array} aligned Unit-norm vector of length `targetDim`.
 * @property {string} projectionId Identifier two vectors must share before being compared.
 * @property {number} sourceDim Dimensionality of the input.
 * @property {number} targetDim Dimensionality of the output.
 * @property {boolean} projected False when the input already had the target dimensionality.
 * @property {number} noiseBaseline 1/sqrt(targetDim) — the standard deviation of a cosine between
 *   two *unrelated* vectors in this space. Any similarity below roughly 3x this is indistinguishable
 *   from noise and must not be reported as a semantic match.
 */

/**
 * Align an embedding into the shared semantic dimension.
 *
 * Three cases, and only three:
 *   - `sourceDim === targetDim` — no projection, the vector is L2-normalised and returned. Note that
 *     this is a *no-op*, not an alignment: two different models that happen to share a dimension are
 *     still not comparable.
 *   - `sourceDim > targetDim` — deterministic Achlioptas projection, then L2 normalisation.
 *   - `sourceDim < targetDim` — **throws**. There is no zero-padding path. See {@link assertDims}.
 *
 * @param {object} args Arguments.
 * @param {ArrayLike<number>} args.embedding The source embedding.
 * @param {number} [args.targetDim] Shared dimension; defaults to {@link SHARED_EMBEDDING_DIM}.
 * @returns {AlignedEmbedding} The aligned vector and its provenance.
 * @throws {DimensionMismatchError} On an empty vector or an expansion request.
 */
export function alignEmbedding({ embedding, targetDim = SHARED_EMBEDDING_DIM }) {
  if (!embedding || typeof embedding.length !== 'number' || embedding.length === 0) {
    throw new DimensionMismatchError('alignEmbedding requires a non-empty numeric vector.');
  }
  const sourceDim = embedding.length;
  assertDims(sourceDim, targetDim);
  const projected = sourceDim !== targetDim;
  const raw = projected ? projectEmbedding(embedding, targetDim) : embedding;
  return {
    aligned: l2Normalize(raw),
    projectionId: projectionId(sourceDim, targetDim),
    sourceDim,
    targetDim,
    projected,
    noiseBaseline: noiseBaseline(targetDim),
  };
}

/**
 * Standard deviation of the cosine between two independent random unit vectors in `k` dimensions.
 *
 * Exported as a real function, not a footnote: it is the null control that the original similarity
 * matrix failed, and every similarity this protocol reports should be presented next to it.
 *
 * @param {number} k Dimensionality.
 * @returns {number} 1 / sqrt(k).
 */
export function noiseBaseline(k) {
  if (!Number.isInteger(k) || k < 1) {
    throw new DimensionMismatchError(
      `noiseBaseline requires a positive integer, got ${String(k)}.`,
    );
  }
  return 1 / Math.sqrt(k);
}

/* -------------------------------------------------------------------------- */
/* SimHash — publishable candidate-retrieval signature                         */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic random hyperplanes for SimHash, drawn from the same keystream construction.
 *
 * @param {number} dim Dimensionality of the vectors to be hashed.
 * @param {number} [bits] Number of hyperplanes / output bits.
 * @returns {Float64Array} Row-major `bits x dim` plane matrix.
 */
export function derivePlanes(dim, bits = SIMHASH_BITS) {
  if (!Number.isInteger(bits) || bits < 8 || bits % 8 !== 0) {
    throw new ProtocolError('INVALID_SIMHASH_BITS', 'SimHash bit count must be a multiple of 8.');
  }
  const next = keystream(keccak256(toUtf8Bytes(`${PROJECTION_SEED_LABEL}|simhash|${dim}|${bits}`)));
  const planes = new Float64Array(bits * dim);
  const scale = Math.sqrt(PROJECTION_PARAMS.density / dim);
  for (let b = 0; b < bits; b += 1) {
    const base = b * dim;
    for (let i = 0; i < dim; i += 1) {
      const word = next();
      planes[base + i] = word < T_POS ? scale : word < T_NEG ? -scale : 0;
    }
  }
  return planes;
}

/**
 * SimHash signature of an aligned vector.
 *
 * Published in place of the vector itself when `embeddingVisibility !== 'public'`, so candidates can
 * be shortlisted without exposing the embedding. Note honestly: the bits still leak coarse
 * semantics. They are a privacy *improvement* over publishing 384 floats — which sentence-embedding
 * inversion work (Song & Raghunathan, CCS 2020; Morris et al., EMNLP 2023) shows is close to
 * publishing the text — not a privacy guarantee.
 *
 * @param {ArrayLike<number>} vector Aligned vector.
 * @param {number} [bits] Number of output bits.
 * @returns {Uint8Array} `bits / 8` bytes, most-significant bit first.
 */
export function simhash(vector, bits = SIMHASH_BITS) {
  const dim = vector.length;
  const planes = derivePlanes(dim, bits);
  const out = new Uint8Array(bits / 8);
  for (let b = 0; b < bits; b += 1) {
    let dot = 0;
    const base = b * dim;
    for (let i = 0; i < dim; i += 1) dot += vector[i] * planes[base + i];
    if (dot >= 0) out[b >> 3] |= 0x80 >> (b & 7);
  }
  return out;
}

/**
 * 256-bit SimHash, the protocol's published signature width.
 *
 * @param {ArrayLike<number>} vector Aligned vector.
 * @returns {Uint8Array} 32 bytes.
 */
export function simhash256(vector) {
  return simhash(vector, SIMHASH_BITS);
}

/**
 * Hamming distance between two equal-length bit signatures.
 *
 * @param {Uint8Array} a First signature.
 * @param {Uint8Array} b Second signature.
 * @returns {number} Number of differing bits.
 */
export function hammingDistance(a, b) {
  if (a.length !== b.length) {
    throw new DimensionMismatchError(
      `SimHash signatures differ in length: ${a.length} vs ${b.length}.`,
    );
  }
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = a[i] ^ b[i];
    while (x) {
      x &= x - 1;
      total += 1;
    }
  }
  return total;
}
