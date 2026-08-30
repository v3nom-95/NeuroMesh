/**
 * Trust reads, and the two gas-spending trust writes.
 *
 * ## The score is read, never recomputed
 *
 * v1's dashboard reimplemented `(endorsers * 1000) / (1 + 3 * negatives)` in JavaScript and applied
 * a `>= 500` cutoff in the browser. That arithmetic lives in `ReputationManager.sol`, and any
 * second copy of it drifts silently the moment the contract changes. Every number here comes from
 * a contract read, converted from WAD in exactly one place (`src/services/reputation.js`), and the
 * raw `scoreWad` decimal string travels alongside the float so a caller that needs exactness is
 * never forced through a `Number`.
 *
 * @module src/routes/reputation
 */
import { Router } from 'express';

import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { AddressParams, ReputationQuery, TrustActionBody } from '../schemas/api.js';

/** How many agents the leaderboard enumerates from the identity index when none are named. */
const DEFAULT_LEADERBOARD = 25;

/**
 * Build the reputation routes.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @param {Record<string, any>} deps.guards Shared middleware.
 * @returns {import('express').Router} The router.
 */
export function createReputationRoutes({ services, guards }) {
  const router = Router();

  /* ---- Leaderboard and trust log ---------------------------------------- */

  router.get(
    '/',
    validate({ query: ReputationQuery }),
    asyncHandler(async (req, res) => {
      const query = req.validatedQuery;
      const limit = Math.min(query.limit, DEFAULT_LEADERBOARD * 4);

      /** @type {string[]} */
      let addresses;
      if (typeof query.addresses === 'string' && query.addresses.trim() !== '') {
        addresses = query.addresses
          .split(',')
          .map((/** @type {string} */ value) => value.trim())
          .filter(Boolean)
          .slice(0, limit);
      } else {
        // No explicit set: enumerate from the identity index, which is the authoritative agent
        // list. A failure here yields an empty leaderboard plus a live trust log rather than a
        // 502 - the two reads are independent and one must not take the other down.
        const page = await services.chain.readIdentity
          .getAgents(0, limit)
          .catch(() => ({ page: [], total: 0 }));
        addresses = page.page;
      }

      const [board, events] = await Promise.all([
        addresses.length > 0
          ? services.reputation.leaderboard({ addresses })
          : Promise.resolve({ entries: [], thresholds: { trusted: null, max: 1 }, failed: [] }),
        services.reputation
          .events({ limit: query.limit, cursor: query.cursor ?? null })
          .catch(() => ({ items: [], nextCursor: null, total: 0, capacityBounded: true })),
      ]);

      res.set('Cache-Control', 'private, max-age=5').status(200).json({
        entries: board.entries,
        events: events.items,
        thresholds: board.thresholds,
        nextCursor: events.nextCursor,
        total: events.total,
        failed: board.failed,
        // The on-chain trust log is a capacity-bounded ring buffer, so this is the recent
        // history and not the whole of it. The authoritative record is the event log.
        capacityBounded: events.capacityBounded,
      });
    }),
  );

  router.get(
    '/:address',
    validate({ params: AddressParams }),
    asyncHandler(async (req, res) => {
      const summary = await services.reputation.summaryOf(req.params.address);
      res
        .set('Cache-Control', 'private, max-age=5')
        .status(200)
        .json({
          entries: [summary],
          events: [],
          thresholds: summary.thresholds ?? { trusted: null, max: 1 },
          nextCursor: null,
          total: 1,
        });
    }),
  );

  /* ---- Trust writes ------------------------------------------------------ */

  /**
   * Build one of the two trust-action handlers.
   *
   * @param {'endorse'|'report'} action Which action.
   * @returns {import('express').RequestHandler} The handler.
   */
  function trustAction(action) {
    return asyncHandler(async (req, res) => {
      const { target, reason } = req.body;
      const job = services.jobs.create({
        kind: `reputation.${action}`,
        steps: ['submit', 'confirm'],
        meta: { action, target },
      });

      void (async () => {
        try {
          services.jobs.begin(job.id, 'submit');
          const result = await services.reputation[action]({
            target,
            reason,
            onHash: (/** @type {string} */ hash) => {
              services.jobs.end(job.id, 'submit', 'done', { txHash: hash });
              services.jobs.begin(job.id, 'confirm');
            },
          });
          services.jobs.end(job.id, 'confirm', 'done', { blockNumber: result.blockNumber ?? null });
          services.jobs.finish(job.id, {
            target,
            txHash: result.hash ?? null,
            explorerUrl: result.explorerUrl ?? null,
            blockNumber: result.blockNumber ?? null,
          });
        } catch (err) {
          services.jobs.fail(job.id, err, { target });
        }
      })();

      res
        .status(202)
        .location(`/api/v1/jobs/${job.id}`)
        .set('Retry-After', '1')
        .set('Cache-Control', 'no-store')
        .json(services.jobs.get(job.id));
    });
  }

  router.post(
    '/endorse',
    guards.writeLimiter,
    guards.requireApiKey,
    guards.readOnlyGuard,
    validate({ body: TrustActionBody }),
    trustAction('endorse'),
  );

  router.post(
    '/report',
    guards.writeLimiter,
    guards.requireApiKey,
    guards.readOnlyGuard,
    validate({ body: TrustActionBody }),
    trustAction('report'),
  );

  return router;
}

export default createReputationRoutes;
