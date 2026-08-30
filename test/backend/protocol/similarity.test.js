/**
 * Similarity and retrieval ranking.
 *
 * Two things matter here beyond arithmetic. First, `cosineSimilarity` must refuse to compare vectors
 * of different lengths rather than quietly zipping them — the v1 code's "alignment" produced exactly
 * that situation and the resulting number had no interpretation. Second, `rankMemories` must drop a
 * candidate aligned through a different projection instead of scoring it, because a cosine across
 * two independent subspaces is noise with a plausible-looking magnitude.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RANK_PHI, RANK_THETA, RECENCY_HALFLIFE_DAYS } from '../../../src/protocol/constants.js';
import { ProtocolError } from '../../../src/protocol/errors.js';
import {
  calibrateTau,
  cosineSimilarity,
  dot,
  l2Norm,
  rankMemories,
  semanticSearch,
  trustWeightedScore,
} from '../../../src/protocol/similarity.js';

const close = (actual, expected, tolerance = 1e-12) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );

const PROJ = 'neuromesh-proj/v1/achlioptas-s3/aes-256-ctr/768-384/deadbeef';
const OTHER_PROJ = 'neuromesh-proj/v1/achlioptas-s3/aes-256-ctr/384-384/cafebabe';

describe('dot and l2Norm', () => {
  it('compute the textbook values', () => {
    close(dot([1, 2, 3], [4, 5, 6]), 32);
    close(l2Norm([3, 4]), 5);
    close(l2Norm([0, 0, 0]), 0);
  });

  it('reject a length mismatch instead of zipping the shorter vector', () => {
    assert.throws(() => dot([1, 2], [1, 2, 3]), ProtocolError);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for a vector against itself and against a positive rescaling of itself', () => {
    close(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
    close(cosineSimilarity([1, 2, 3], [10, 20, 30]), 1, 1e-12);
  });

  it('is 0 for orthogonal vectors and -1 for opposites', () => {
    close(cosineSimilarity([1, 0], [0, 1]), 0);
    close(cosineSimilarity([1, 2], [-1, -2]), -1, 1e-12);
  });

  it('is symmetric', () => {
    close(cosineSimilarity([1, 2, 3], [3, 1, 2]), cosineSimilarity([3, 1, 2], [1, 2, 3]));
  });

  it('never exceeds [-1, 1] even when floating point would like it to', () => {
    const v = Array.from({ length: 384 }, (_, i) => Math.sin(i) * 1e6);
    const s = cosineSimilarity(v, v);
    assert.ok(s <= 1 && s >= -1, `cosine out of range: ${s}`);
  });

  it('refuses vectors of different dimension — the v1 zero-pad bug in one assertion', () => {
    assert.throws(
      () => cosineSimilarity(new Array(384).fill(1), new Array(768).fill(1)),
      ProtocolError,
    );
  });

  it('returns 0 — never NaN — for a zero vector, which has no direction', () => {
    // NaN propagating through a ranking pipeline hides the problem; 0 neutralises the candidate.
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
    assert.equal(cosineSimilarity([0, 0], [0, 0]), 0);
  });
});

describe('calibrateTau', () => {
  it('maps a raw score onto [0, 1) and equals 0.5 at the reference', () => {
    close(calibrateTau(0, 10), 0);
    close(calibrateTau(10, 10), 0.5);
    close(calibrateTau(90, 10), 0.9);
  });

  it('saturates rather than diverging', () => {
    assert.ok(calibrateTau(1e12, 10) < 1);
  });

  it('rejects a negative score and a non-positive reference', () => {
    assert.throws(() => calibrateTau(-1, 10), ProtocolError);
    assert.throws(() => calibrateTau(1, 0), ProtocolError);
  });
});

describe('trustWeightedScore', () => {
  const formula = (sim, tau, ageDays = 0) =>
    Math.max(0, sim) *
    (RANK_THETA + (1 - RANK_THETA) * Math.pow(tau, RANK_PHI)) *
    Math.pow(2, -ageDays / RECENCY_HALFLIFE_DAYS);

  it('matches the spec formula exactly', () => {
    close(trustWeightedScore(0.8, 0.25), formula(0.8, 0.25));
    close(trustWeightedScore(0.8, 0.25, { ageDays: 180 }), formula(0.8, 0.25, 180));
  });

  it('applies the trust floor: a zero-reputation agent is ranked low, never unreachable', () => {
    close(trustWeightedScore(1, 0), RANK_THETA);
    assert.ok(trustWeightedScore(1, 0) > 0, 'reputation re-ranks; it must not gate');
  });

  it('reaches the full similarity at maximum trust and zero age', () => {
    close(trustWeightedScore(1, 1), 1);
  });

  it('is monotone non-decreasing in reputation and in similarity', () => {
    let previous = -Infinity;
    for (let tau = 0; tau <= 1.0000001; tau += 0.05) {
      const score = trustWeightedScore(0.7, tau);
      assert.ok(score >= previous, `not monotone in tau at ${tau}`);
      previous = score;
    }
    assert.ok(trustWeightedScore(0.9, 0.5) > trustWeightedScore(0.4, 0.5));
  });

  it('is concave in reputation, so the first units of trust are worth the most', () => {
    const gainLow = trustWeightedScore(1, 0.1) - trustWeightedScore(1, 0);
    const gainHigh = trustWeightedScore(1, 1) - trustWeightedScore(1, 0.9);
    assert.ok(
      gainLow > gainHigh,
      `phi < 1 must make early reputation cheaper: ${gainLow} vs ${gainHigh}`,
    );
  });

  it('halves the score after exactly one recency half-life', () => {
    close(trustWeightedScore(1, 1, { ageDays: RECENCY_HALFLIFE_DAYS }), 0.5, 1e-12);
  });

  it('clamps an anti-match to zero rather than letting it flip the trust term', () => {
    assert.equal(trustWeightedScore(-0.9, 1), 0);
  });

  it('clamps out-of-range reputation instead of extrapolating', () => {
    close(trustWeightedScore(1, 5), trustWeightedScore(1, 1));
    close(trustWeightedScore(1, -5), trustWeightedScore(1, 0));
  });

  it('rejects a non-finite similarity', () => {
    assert.throws(() => trustWeightedScore(NaN, 0.5), ProtocolError);
    assert.throws(() => trustWeightedScore(0.5, NaN), ProtocolError);
  });
});

describe('rankMemories', () => {
  const query = [1, 0, 0];
  const candidates = [
    { cid: 'bafy-near', embedding: [0.9, 0.1, 0], projectionId: PROJ, reputation: 0.1, ageDays: 0 },
    { cid: 'bafy-far', embedding: [0, 1, 0], projectionId: PROJ, reputation: 0.9, ageDays: 0 },
    { cid: 'bafy-exact', embedding: [1, 0, 0], projectionId: PROJ, reputation: 0.9, ageDays: 0 },
  ];

  it('ranks by the trust-weighted score, best first', () => {
    const { results } = rankMemories(query, candidates, { projectionId: PROJ });
    assert.deepEqual(
      results.map((r) => r.cid),
      ['bafy-exact', 'bafy-near', 'bafy-far'],
    );
    assert.ok(results[0].score >= results[1].score && results[1].score >= results[2].score);
  });

  it('drops a candidate from a different projection instead of scoring it', () => {
    const mixed = [
      ...candidates,
      { cid: 'bafy-alien', embedding: [1, 0, 0], projectionId: OTHER_PROJ },
    ];
    const { results, skipped } = rankMemories(query, mixed, { projectionId: PROJ });
    assert.ok(!results.some((r) => r.cid === 'bafy-alien'), 'a cross-projection cosine is noise');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].reason, /^projection_mismatch/);
  });

  it('drops candidates below tauMin and says why', () => {
    const { results, skipped } = rankMemories(query, candidates, {
      projectionId: PROJ,
      tauMin: 0.5,
    });
    assert.deepEqual(results.map((r) => r.cid).sort(), ['bafy-exact', 'bafy-far']);
    assert.deepEqual(skipped, [{ cid: 'bafy-near', reason: 'below_tau_min' }]);
  });

  it('honours topK', () => {
    assert.equal(
      rankMemories(query, candidates, { projectionId: PROJ, topK: 2 }).results.length,
      2,
    );
  });

  it('breaks ties by ascending cid, so the ordering is total and stable across processes', () => {
    const tied = [
      { cid: 'ccc', embedding: [1, 0, 0], projectionId: PROJ, reputation: 0.5 },
      { cid: 'aaa', embedding: [1, 0, 0], projectionId: PROJ, reputation: 0.5 },
      { cid: 'bbb', embedding: [1, 0, 0], projectionId: PROJ, reputation: 0.5 },
    ];
    assert.deepEqual(
      rankMemories(query, tied, { projectionId: PROJ }).results.map((r) => r.cid),
      ['aaa', 'bbb', 'ccc'],
    );
  });

  it('ages a stale high-similarity memory below a fresh good one', () => {
    const aged = [
      { cid: 'stale', embedding: [1, 0, 0], projectionId: PROJ, reputation: 0.5, ageDays: 3650 },
      { cid: 'fresh', embedding: [0.8, 0.6, 0], projectionId: PROJ, reputation: 0.5, ageDays: 0 },
    ];
    assert.equal(rankMemories(query, aged, { projectionId: PROJ }).results[0].cid, 'fresh');
  });

  it('returns an empty result set rather than throwing on no candidates', () => {
    assert.deepEqual(rankMemories(query, [], { projectionId: PROJ }), { results: [], skipped: [] });
  });
});

describe('semanticSearch', () => {
  it('ranks on pure similarity, ignoring reputation and age', () => {
    const bank = [
      { cid: 'b', embedding: [0.9, 0.1, 0], projectionId: PROJ, reputation: 0.99, ageDays: 0 },
      { cid: 'a', embedding: [1, 0, 0], projectionId: PROJ, reputation: 0, ageDays: 3650 },
    ];
    const results = semanticSearch([1, 0, 0], bank, 5, PROJ);
    assert.deepEqual(
      results.map((r) => r.cid),
      ['a', 'b'],
    );
    close(results[0].similarity, 1);
  });

  it('applies the same projection filter', () => {
    const bank = [
      { cid: 'ok', embedding: [1, 0, 0], projectionId: PROJ },
      { cid: 'alien', embedding: [1, 0, 0], projectionId: OTHER_PROJ },
    ];
    assert.deepEqual(
      semanticSearch([1, 0, 0], bank, 5, PROJ).map((r) => r.cid),
      ['ok'],
    );
  });
});
