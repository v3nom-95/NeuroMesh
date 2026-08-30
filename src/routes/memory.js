/**
 * The memory lifecycle surface: create, list, read, verify, decrypt.
 *
 * ## `POST /memories` answers 202, not 200
 *
 * The pipeline is embed, align, encrypt, pin, commit, confirm. On Sepolia the confirmation alone
 * has been measured at up to 21 seconds in this repository's own benchmark data, so holding a
 * socket open for the whole thing is a request that times out at every proxy in the path. The
 * route returns a job id immediately and the client polls `GET /jobs/:id`, which is also what
 * makes the per-step timings visible instead of hidden inside one opaque wait.
 *
 * ## `POST /memories/:cid/decrypt` takes no ciphertext
 *
 * This is the replacement for `POST /api/decrypt`, which accepted `{encrypted, salt, iv, tag}` from
 * any origin and decrypted it with the node's chain signing key - an unauthenticated decryption
 * oracle that was also a PBKDF2 work amplifier at 53 ms of CPU per call. The replacement's only
 * input is a CID in the path. The body schema is an empty strict object, so there is no field a
 * caller could add to smuggle ciphertext back in, and the route is authenticated, tightly limited
 * and audited on every call.
 *
 * The old path is **not** aliased and returns no hint. `/api/decrypt` is a plain 404, like any
 * other unknown path; see `src/middleware/notFound.js`.
 *
 * @module src/routes/memory
 */
import { Router } from 'express';

import { errors } from '../errors.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import {
  CreateMemoryBody,
  DecryptBody,
  ListMemoriesQuery,
  MODEL_KEYS,
  MemoryParams,
} from '../schemas/api.js';

/**
 * Project one index record into the published list row.
 *
 * The service's record uses the chain's vocabulary (`committedAt`, `sizeBytes`); the wire row adds
 * `createdAt` and `size` as the names every client already reads. Doing the renaming here rather
 * than in the service keeps the ledger's language in the ledger's layer and the presentation
 * vocabulary at the presentation boundary - and the original names are kept alongside, so nothing
 * is lost and no consumer has to guess which of the two is authoritative.
 *
 * @param {Record<string, any>} row One `CommittedRecord`.
 * @returns {Record<string, any>} The wire row.
 */
function toSummary(row) {
  return { ...row, createdAt: row.committedAt, size: row.sizeBytes };
}

/**
 * Build the memory routes.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @param {Record<string, any>} deps.config Application config.
 * @param {Record<string, any>} deps.guards Shared middleware.
 * @returns {import('express').Router} The router.
 */
export function createMemoryRoutes({ services, guards }) {
  const router = Router();

  /* ---- Create ----------------------------------------------------------- */

  router.post(
    '/',
    guards.writeLimiter,
    guards.requireApiKey,
    guards.readOnlyGuard,
    validate({ body: CreateMemoryBody }),
    asyncHandler(async (req, res) => {
      const body = req.body;
      const job = services.memory.create({
        context: body.context,
        parentCid: body.parentCid ?? null,
        grantees: body.grantees ?? [],
        policy: body.policy,
        modelKey: /** @type {Record<string, string>} */ (MODEL_KEYS)[body.model] ?? undefined,
        actor: req.auth?.mode ?? null,
      });

      res
        .status(202)
        .location(`/api/v1/jobs/${job.id}`)
        .set('Retry-After', '1')
        .set('Cache-Control', 'no-store')
        .json(job);
    }),
  );

  /* ---- List ------------------------------------------------------------- */

  router.get(
    '/',
    validate({ query: ListMemoriesQuery }),
    asyncHandler(async (req, res) => {
      const query = req.validatedQuery;
      const page = services.memory.list({
        limit: query.limit,
        cursor: query.cursor ?? null,
        encrypted: query.encrypted,
        model: query.model,
      });
      res
        .set('Cache-Control', 'private, max-age=5')
        .status(200)
        .json({ ...page, items: page.items.map(toSummary) });
    }),
  );

  /* ---- Read ------------------------------------------------------------- */

  router.get(
    '/:cid',
    validate({ params: MemoryParams }),
    asyncHandler(async (req, res) => {
      const detail = await services.memory.get(req.params.cid);

      // A strong ETag that costs nothing: the content is addressed by its own hash, so the digest
      // IS the validator. This is also why the browser never has to talk to a third-party gateway,
      // which keeps `connect-src 'self'` honest.
      if (detail.etag) res.set('ETag', detail.etag);
      const inm = req.headers['if-none-match'];
      if (detail.etag && typeof inm === 'string' && inm.split(/\s*,\s*/).includes(detail.etag)) {
        res.status(304).end();
        return;
      }

      res.set('Cache-Control', 'public, max-age=60').status(200).json({
        cid: detail.cid,
        cidDigest: detail.cidDigest,
        payloadVersion: detail.payloadVersion,
        payload: detail.payload,
        sizeBytes: detail.sizeBytes,
        onchain: detail.onchain,
        onchainReason: detail.onchainReason,
        gatewayUrl: detail.gatewayUrl,
      });
    }),
  );

  /* ---- Verify ----------------------------------------------------------- */

  router.get(
    '/:cid/verify',
    validate({ params: MemoryParams }),
    asyncHandler(async (req, res) => {
      // No auth: verification is meant to be public. Anyone should be able to check this node's
      // claims about a memory without holding a credential from this node.
      const report = await services.memory.verify(req.params.cid);
      res.set('Cache-Control', 'no-store').status(200).json(report);
    }),
  );

  /* ---- Decrypt ---------------------------------------------------------- */

  router.post(
    '/:cid/decrypt',
    guards.decryptLimiter,
    guards.requireApiKey,
    validate({ params: MemoryParams, body: DecryptBody }),
    asyncHandler(async (req, res) => {
      if (!services.crypto.configured()) {
        throw errors.readOnly();
      }
      try {
        const result = await services.memory.decrypt(req.params.cid, {
          actor: req.auth?.mode ?? null,
          requestId: req.id ?? null,
        });
        services.metrics.increment('neuromesh_decrypt_total', { result: 'ok' });
        res.set('Cache-Control', 'no-store').status(200).json(result);
      } catch (err) {
        services.metrics.increment('neuromesh_decrypt_total', {
          result: String(/** @type {any} */ (err)?.code ?? 'error'),
        });
        throw err;
      }
    }),
  );

  return router;
}

export default createMemoryRoutes;
