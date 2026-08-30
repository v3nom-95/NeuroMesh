/**
 * NeuroMesh — semantic-sync compatibility facade.
 *
 * @deprecated This module is a thin, path-preserving shim over `src/protocol/projection.js` and
 * `src/protocol/similarity.js`. New code MUST import from `src/protocol/index.js` directly. This
 * file exists only so that an existing `lib/semantic-sync.js` import keeps resolving.
 *
 * ## What was here before, and why it is gone
 *
 * `generateProjectionMatrix` drew every entry from `Math.random()`. The matrix was therefore
 * different on every process start and on every node, so two nodes projected into two *independent*
 * random subspaces and the cosine between their projected vectors was pure noise: expectation 0,
 * standard deviation 1/sqrt(384) = 0.051. Checked against this repository's own committed results —
 * the six unique cross-model cosines had sample SD 0.0441 against the 0.0510 prediction, max |cos| =
 * 0.0763 = 1.50 sigma, chi-square 3.82 on 6 dof, p = 0.70. The published "cross-model semantic
 * alignment" matrix fit the pure-noise null comfortably.
 *
 * `alignEmbedding` also zero-padded a 384-d vector up to 768 and returned it as "aligned". The
 * resulting cosine is computed over 384 arbitrary coordinate correspondences plus a block of zeros
 * and has no interpretation — and, worse, the API gave no signal that anything had happened.
 *
 * Both are now hard errors rather than silently different behaviour, because a silent signature
 * change would produce plausible-looking garbage instead of a failure.
 *
 * @module lib/semantic-sync
 */

import { RemovedApiError } from '../src/protocol/errors.js';
import { alignEmbedding as alignEmbeddingV2 } from '../src/protocol/projection.js';

export {
  buildProjectionMatrix,
  derivePlanes,
  hammingDistance,
  l2Normalize,
  noiseBaseline,
  projectionId,
  projectionMatrixDigest,
  projectionSeed,
  simhash,
  simhash256,
} from '../src/protocol/projection.js';

export {
  calibrateTau,
  cosineSimilarity,
  dot,
  l2Norm,
  rankMemories,
  semanticSearch,
  trustWeightedScore,
} from '../src/protocol/similarity.js';

/**
 * Align an embedding into the shared semantic dimension.
 *
 * Only the v2 keyword-argument form is accepted. The old positional signature
 * `alignEmbedding(embedding, sourceDim, targetDim, projMatrix)` throws, because silently
 * reinterpreting those arguments would return a differently-shaped result to callers that would
 * never notice.
 *
 * @param {{ embedding: ArrayLike<number>, targetDim?: number }} args Alignment arguments.
 * @returns {import('../src/protocol/projection.js').AlignedEmbedding} The aligned vector.
 * @throws {RemovedApiError} When called with the v1 positional signature.
 */
export function alignEmbedding(args) {
  if (
    Array.isArray(args) ||
    ArrayBuffer.isView(args) ||
    typeof args !== 'object' ||
    args === null
  ) {
    throw new RemovedApiError(
      'REMOVED_UNSOUND_API',
      'alignEmbedding(embedding, sourceDim, targetDim, projMatrix) has been removed. Call ' +
        'alignEmbedding({ embedding, targetDim }) instead; the source dimension is read from the ' +
        'vector, expansion by zero-padding is no longer possible, and the projection is ' +
        'deterministic and versioned. See src/protocol/projection.js.',
    );
  }
  return alignEmbeddingV2(args);
}

/**
 * Removed. Generated an unseeded random matrix, so no two processes agreed on the subspace.
 *
 * @deprecated Always throws. Use `buildProjectionMatrix(fromDim, toDim)`, which is deterministic.
 * @returns {never} Never returns.
 * @throws {RemovedApiError} Always.
 */
export function generateProjectionMatrix() {
  throw new RemovedApiError(
    'REMOVED_UNSOUND_API',
    'generateProjectionMatrix() has been removed: it drew every entry from Math.random(), so the ' +
      'matrix differed on every process start and on every node, and cross-node cosines were pure ' +
      "noise (this repository's own six cross-model values fit the noise null at chi-square 3.82 " +
      'on 6 dof, p = 0.70). Use buildProjectionMatrix(fromDim, toDim) from ' +
      'src/protocol/projection.js, which is seeded, versioned and byte-identical in every process. ' +
      'Note also that a shared seed buys reproducibility, not cross-model meaning: ' +
      'Johnson-Lindenstrauss is a within-space guarantee, so always compare a reported similarity ' +
      'against noiseBaseline(dim).',
  );
}

/**
 * Removed. Took a caller-supplied matrix, which is how an unseeded matrix entered the pipeline.
 *
 * @deprecated Always throws. Use `projectEmbedding(vector, toDim)` from `src/protocol/projection.js`.
 * @returns {never} Never returns.
 * @throws {RemovedApiError} Always.
 */
export function projectEmbedding() {
  throw new RemovedApiError(
    'REMOVED_UNSOUND_API',
    'projectEmbedding(vector, projectionMatrix) has been removed: accepting a caller-supplied ' +
      'matrix is what allowed an unseeded one into the pipeline. Use projectEmbedding(vector, ' +
      'toDim) from src/protocol/projection.js, which derives the matrix deterministically.',
  );
}
