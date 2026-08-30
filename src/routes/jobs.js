/**
 * Job polling - the completion channel for every write route.
 *
 * ## A job id is a capability
 *
 * `GET /jobs/:id` requires no API key, because the id is a UUIDv4 that only the caller who created
 * the job has seen. That is a deliberate trade and it carries an obligation: a job id must never be
 * written to a shared analytics sink, never appear in a `Referer`, and never be put in a URL that
 * leaves this origin. `Cache-Control: no-store` is set for the same reason.
 *
 * `GET /jobs` - the operator's list - *does* require a key, because enumerating ids would defeat
 * the capability entirely.
 *
 * @module src/routes/jobs
 */
import { Router } from 'express';

import { errors } from '../errors.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { JobListQuery, JobParams } from '../schemas/api.js';

/**
 * Build the job routes.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @param {Record<string, any>} deps.config Application config.
 * @param {Record<string, any>} deps.guards Shared middleware.
 * @returns {import('express').Router} The router.
 */
export function createJobRoutes({ services, config, guards }) {
  const router = Router();

  router.get(
    '/',
    guards.requireApiKey,
    validate({ query: JobListQuery }),
    asyncHandler(async (req, res) => {
      const items = services.jobs.list({ limit: req.validatedQuery.limit });
      res.set('Cache-Control', 'no-store').status(200).json({ items, total: items.length });
    }),
  );

  router.get(
    '/:id',
    validate({ params: JobParams }),
    asyncHandler(async (req, res) => {
      const job = services.jobs.get(req.params.id);
      if (!job) {
        // The same 404 covers "never existed" and "aged out". `ttlMs` is included so a client can
        // tell them apart by elapsed time rather than guessing - the registry is bounded and
        // non-durable, and saying so is better than implying a job id is permanent.
        throw errors.jobNotFound(req.params.id);
      }
      res.set('Cache-Control', 'no-store');
      if (job.state === 'queued' || job.state === 'running') res.set('Retry-After', '1');
      res.status(200).json({ ...job, ttlMs: config.jobs.ttlMs });
    }),
  );

  return router;
}

export default createJobRoutes;
