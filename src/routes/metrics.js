/**
 * Prometheus exposition, and the dashboard's latency summary.
 *
 * `/metrics` is mounted at the process root rather than under `/api/v1`, because that is the path
 * every scraper's default configuration already looks at, and because the exposition format is not
 * versioned with this API.
 *
 * @module src/routes/metrics
 */
import { Router } from 'express';

import { errors } from '../errors.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { MetricsQuery } from '../schemas/api.js';

/**
 * The root-mounted Prometheus endpoint.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @param {Record<string, any>} deps.config Application config.
 * @param {Record<string, any>} deps.guards Shared middleware.
 * @returns {import('express').Router} The router.
 */
export function createMetricsRoutes({ services, config, guards }) {
  const router = Router();

  router.get(
    '/metrics',
    guards.requireMetricsToken,
    asyncHandler(async (_req, res) => {
      // A disabled endpoint answers exactly like a nonexistent one. Returning 403 would confirm
      // that this node has metrics and merely will not show them, which is information a scanner
      // does not need.
      if (!config.features.metrics) throw errors.notFound('Route GET /metrics not found.');
      const body = await services.metrics.scrape();
      res
        .set('Content-Type', services.metrics.contentType())
        .set('Cache-Control', 'no-store')
        .status(200)
        .send(body);
    }),
  );

  return router;
}

/**
 * The versioned summary the dashboard renders.
 *
 * No auth: it exposes latency aggregates and counters, with no secrets and no per-request data.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @returns {import('express').Router} The router.
 */
export function createMetricsSummaryRoutes({ services }) {
  const router = Router();

  router.get(
    '/summary',
    validate({ query: MetricsQuery }),
    asyncHandler(async (req, res) => {
      const summary = await services.metrics.summary(req.validatedQuery.window);
      res.set('Cache-Control', 'private, max-age=5').status(200).json(summary);
    }),
  );

  return router;
}

export default createMetricsRoutes;
