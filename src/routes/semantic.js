/**
 * Cross-model semantic retrieval - the first HTTP surface this capability has ever had.
 *
 * v1 imported `alignEmbedding`, `cosineSimilarity` and `semanticSearch` into `server.js` and
 * referenced none of them. The project's headline claim had no endpoint at all; it existed only
 * inside the simulator, where it ran against an unseeded random projection.
 *
 * ## Every response carries the noise baseline
 *
 * `diagnostics.noiseBaseline` is `1/sqrt(dim)` - the standard deviation of the cosine between two
 * unrelated unit vectors in the shared space. It is shipped beside every similarity on purpose:
 * this repository's own v1 results fitted the pure-noise null at p = 0.70, and a number that a
 * reader cannot compare against chance is a number that will be over-read.
 *
 * @module src/routes/semantic
 */
import { Router } from 'express';

import { errors } from '../errors.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { MODEL_KEYS, SearchBody, SimilarityQuery } from '../schemas/api.js';

/**
 * Build the semantic routes.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @param {Record<string, any>} deps.guards Shared middleware.
 * @returns {import('express').Router} The router.
 */
export function createSemanticRoutes({ services, guards }) {
  const router = Router();

  /* ---- Search ----------------------------------------------------------- */

  router.post(
    '/search',
    guards.searchLimiter,
    validate({ body: SearchBody }),
    asyncHandler(async (req, res) => {
      // Each call runs an inference through a concurrency-1 ONNX session, so shed load with a
      // clear 503 rather than queueing without bound behind a model that is still downloading.
      if (!services.embeddings.isReady()) throw errors.modelNotReady();

      const body = req.body;
      const result = await services.semantic.search({
        query: body.query,
        topK: body.topK,
        minSimilarity: body.minSimilarity,
        trustWeighted: body.trustWeighted,
        model: /** @type {Record<string, string>} */ (MODEL_KEYS)[body.model],
        owner: body.owner,
      });
      res.set('Cache-Control', 'no-store').status(200).json(result);
    }),
  );

  /* ---- Cross-model similarity matrix ------------------------------------ */

  router.get(
    '/similarity',
    validate({ query: SimilarityQuery }),
    asyncHandler(async (req, res) => {
      // A GET must not run inference. This is computed entirely from vectors already in the index,
      // so an empty index answers with empty labels rather than loading a second 90 MB model.
      const matrix = services.semantic.crossModelSimilarity({
        maxPairs: req.validatedQuery.maxPairs,
      });
      res.set('Cache-Control', 'private, max-age=10').status(200).json({
        labels: matrix.labels,
        matrix: matrix.matrix,
        // `pairs` is the flat shape the dashboard's normaliser already understands, emitted
        // alongside the square matrix so neither side has to pivot the other's format.
        pairs: matrix.cells,
        models: matrix.models,
        diagnostics: matrix.diagnostics,
      });
    }),
  );

  /* ---- Index state ------------------------------------------------------ */

  router.get(
    '/index',
    guards.requireApiKey,
    asyncHandler(async (_req, res) => {
      res.set('Cache-Control', 'no-store').status(200).json(services.semantic.stats());
    }),
  );

  return router;
}

export default createSemanticRoutes;
