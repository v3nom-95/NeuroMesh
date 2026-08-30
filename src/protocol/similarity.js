/**
 * NeuroMesh Protocol — similarity and retrieval ranking.
 *
 * Two separate concerns live here, and the distinction matters:
 *
 *   - **Similarity** is a geometric fact about two vectors. It is only meaningful when both were
 *     produced by the same model and aligned through the same `projectionId`, and even then it must
 *     be read against the noise baseline for the space (see
 *     `projection.noiseBaseline`). A cosine of 0.05 in a 384-d space is exactly one standard
 *     deviation of pure noise, not a weak match.
 *
 *   - **Ranking** is a product of similarity, trust and recency. Ranking scores are *not*
 *     consensus-critical — no two nodes must agree on them bit for bit — so they are computed in
 *     ordinary double-precision floating point. Reputation *scores*, which are consensus-critical,
 *     are integer fixed-point and live elsewhere; never mix the two arithmetics.
 *
 * @module src/protocol/similarity
 */

import { RANK_PHI, RANK_THETA, RECENCY_HALFLIFE_DAYS, TAU_MIN } from './constants.js';
import { DimensionMismatchError, ProtocolError } from './errors.js';

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Dot product of two equal-length vectors.
 *
 * @param {ArrayLike<number>} a First vector.
 * @param {ArrayLike<number>} b Second vector.
 * @returns {number} Dot product.
 */
export function dot(a, b) {
  assertSameLength(a, b);
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

/**
 * Euclidean norm.
 *
 * @param {ArrayLike<number>} v Vector.
 * @returns {number} L2 norm.
 */
export function l2Norm(v) {
  let sum = 0;
  for (let i = 0; i < v.length; i += 1) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/**
 * Cosine similarity, in [-1, 1].
 *
 * Returns 0 — not NaN — when either vector has zero norm, because a zero vector has no direction and
 * silently propagating NaN through a ranking pipeline hides the problem instead of neutralising it.
 *
 * @param {ArrayLike<number>} a First vector.
 * @param {ArrayLike<number>} b Second vector.
 * @returns {number} Cosine similarity.
 * @throws {DimensionMismatchError} When the lengths differ.
 */
export function cosineSimilarity(a, b) {
  assertSameLength(a, b);
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return d / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @param {ArrayLike<number>} a First vector.
 * @param {ArrayLike<number>} b Second vector.
 * @returns {void}
 */
function assertSameLength(a, b) {
  if (!a || !b || typeof a.length !== 'number' || typeof b.length !== 'number') {
    throw new DimensionMismatchError('Both arguments must be numeric vectors.');
  }
  if (a.length !== b.length) {
    throw new DimensionMismatchError(`Dimension mismatch: ${a.length} vs ${b.length}.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Trust calibration                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Map an unbounded reputation score onto `tau` in [0, 1).
 *
 * `tau = score / (score + reference)`, with `reference` conventionally the median non-zero score in
 * the population. This is a saturating map with no free parameters beyond the reference, so it does
 * not need re-tuning as the population's absolute scores drift — which a fixed threshold would.
 *
 * @param {number} score Raw reputation score (>= 0).
 * @param {number} reference Reference score (> 0), e.g. the population median.
 * @returns {number} Calibrated trust in [0, 1).
 */
export function calibrateTau(score, reference) {
  if (!(score >= 0)) {
    throw new ProtocolError('INVALID_REPUTATION', `Reputation score must be >= 0, got ${score}.`);
  }
  if (!(reference > 0)) {
    throw new ProtocolError('INVALID_REPUTATION', 'Reference score must be > 0.');
  }
  return score / (score + reference);
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The retrieval ranking score: similarity, discounted by trust and by age.
 *
 *     score = max(0, similarity) · (theta + (1 − theta) · tau^phi) · 2^(−ageDays / halfLife)
 *
 * Each factor earns its place:
 *
 *   - `max(0, similarity)` — a negative cosine is an anti-match; it is clamped rather than allowed to
 *     flip the sign of the trust term.
 *   - `theta + (1 − theta)·tau^phi` — the trust multiplier, bounded in `[theta, 1]`. `theta = 0.2` is
 *     a floor, so an agent with no reputation is ranked low but remains reachable; reputation
 *     re-ranks, it never gates. `phi = 0.5` makes the curve concave, so the first units of
 *     reputation matter most and a very high score cannot dominate a genuinely better match.
 *   - `2^(−age / halfLife)` — exponential recency with a 180-day half-life.
 *
 * Floating point is deliberate and safe here: ranking is a presentation concern, not consensus.
 *
 * @param {number} similarity Cosine similarity between the query and the candidate.
 * @param {number} reputation Calibrated trust `tau` in [0, 1] (see {@link calibrateTau}).
 * @param {object} [options] Tuning.
 * @param {number} [options.ageDays] Age of the memory in days.
 * @param {number} [options.theta] Trust floor.
 * @param {number} [options.phi] Trust concavity.
 * @param {number} [options.recencyHalfLifeDays] Recency half-life in days.
 * @returns {number} Ranking score in [0, 1].
 */
export function trustWeightedScore(
  similarity,
  reputation,
  {
    ageDays = 0,
    theta = RANK_THETA,
    phi = RANK_PHI,
    recencyHalfLifeDays = RECENCY_HALFLIFE_DAYS,
  } = {},
) {
  if (!Number.isFinite(similarity)) {
    throw new ProtocolError('INVALID_SIMILARITY', 'Similarity must be a finite number.');
  }
  const tau = clamp01(reputation);
  const trust = theta + (1 - theta) * Math.pow(tau, phi);
  const recency = Math.pow(2, -Math.max(0, ageDays) / recencyHalfLifeDays);
  return Math.max(0, similarity) * trust * recency;
}

/**
 * @param {number} value Candidate.
 * @returns {number} `value` clamped into [0, 1].
 */
function clamp01(value) {
  if (!Number.isFinite(value)) {
    throw new ProtocolError('INVALID_REPUTATION', 'Calibrated trust must be a finite number.');
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * A retrieval candidate.
 *
 * @typedef {object} Candidate
 * @property {string} cid Content identifier of the memory.
 * @property {ArrayLike<number>} embedding Aligned embedding.
 * @property {string} [projectionId] Projection the embedding was aligned through.
 * @property {number} [reputation] Calibrated trust of the owning agent, in [0, 1].
 * @property {number} [ageDays] Age of the memory in days.
 */

/**
 * Rank candidates against a query vector.
 *
 * Two hard filters run before scoring:
 *   - **Projection equality.** A candidate whose `projectionId` differs from the query's is dropped
 *     with a diagnostic rather than compared. Comparing across projections is precisely the mistake
 *     that produced this repository's noise similarity matrix, and silently producing a number for
 *     it would reintroduce the bug at the ranking layer.
 *   - **Minimum trust.** Candidates below `tauMin` are dropped.
 *
 * Ties are broken by ascending `cid` so the ordering is total and stable across processes.
 *
 * @param {ArrayLike<number>} queryEmbedding Aligned query vector.
 * @param {Candidate[]} candidates Candidate memories.
 * @param {object} [options] Options.
 * @param {number} [options.topK] Maximum results to return.
 * @param {string} [options.projectionId] Projection the query was aligned through; when supplied,
 *   candidates must match it.
 * @param {number} [options.tauMin] Minimum calibrated trust.
 * @param {number} [options.theta] Trust floor.
 * @param {number} [options.phi] Trust concavity.
 * @param {number} [options.recencyHalfLifeDays] Recency half-life in days.
 * @returns {{ results: Array<{ cid: string, similarity: number, score: number }>,
 *   skipped: Array<{ cid: string, reason: string }> }} Ranked results and what was filtered out.
 */
export function rankMemories(
  queryEmbedding,
  candidates,
  {
    topK = 5,
    projectionId,
    tauMin = TAU_MIN,
    theta = RANK_THETA,
    phi = RANK_PHI,
    recencyHalfLifeDays = RECENCY_HALFLIFE_DAYS,
  } = {},
) {
  /** @type {Array<{ cid: string, reason: string }>} */
  const skipped = [];
  /** @type {Array<{ cid: string, similarity: number, score: number }>} */
  const scored = [];

  for (const candidate of candidates) {
    if (projectionId && candidate.projectionId && candidate.projectionId !== projectionId) {
      skipped.push({
        cid: candidate.cid,
        reason: `projection_mismatch: candidate is ${candidate.projectionId}, query is ${projectionId}`,
      });
      continue;
    }
    const reputation = candidate.reputation ?? 0;
    if (reputation < tauMin) {
      skipped.push({ cid: candidate.cid, reason: 'below_tau_min' });
      continue;
    }
    const similarity = cosineSimilarity(queryEmbedding, candidate.embedding);
    scored.push({
      cid: candidate.cid,
      similarity,
      score: trustWeightedScore(similarity, reputation, {
        ageDays: candidate.ageDays ?? 0,
        theta,
        phi,
        recencyHalfLifeDays,
      }),
    });
  }

  scored.sort((a, b) => b.score - a.score || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0));
  return { results: scored.slice(0, topK), skipped };
}

/**
 * Pure-similarity search, with no trust or recency weighting.
 *
 * Kept because it is what a caller usually means by "semantic search", and because the ranked form
 * above is not always wanted. It applies the same projection-equality filter.
 *
 * @param {ArrayLike<number>} queryEmbedding Aligned query vector.
 * @param {Candidate[]} memoryBank Candidate memories.
 * @param {number} [topK] Maximum results.
 * @param {string} [projectionId] Projection the query was aligned through.
 * @returns {Array<{ cid: string, similarity: number }>} Results, most similar first.
 */
export function semanticSearch(queryEmbedding, memoryBank, topK = 5, projectionId) {
  const scored = memoryBank
    .filter((mem) => !projectionId || !mem.projectionId || mem.projectionId === projectionId)
    .map((mem) => ({
      cid: mem.cid,
      similarity: cosineSimilarity(queryEmbedding, mem.embedding),
    }));
  scored.sort(
    (a, b) => b.similarity - a.similarity || (a.cid < b.cid ? -1 : a.cid > b.cid ? 1 : 0),
  );
  return scored.slice(0, topK);
}
