/**
 * Agent identity: registration (spends gas) and lookup (does not).
 *
 * ## What registration now stores
 *
 * v1 registered the literal string `'pubKey_sepolia'` as the agent's public key. That is not a key,
 * so no peer could ever wrap a content encryption key to this agent, which quietly made the whole
 * grant mechanism inoperable. This route registers the node's **real compressed secp256k1
 * encryption public key** from `crypto.encryptionPublicKey()` - a key derived separately from the
 * wallet key and independently versioned, so a leaked memory key does not cost signing authority
 * and rotating one does not orphan the other.
 *
 * @module src/routes/agents
 */
import { Router } from 'express';

import { errors } from '../errors.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { AddressParams, RegisterBody } from '../schemas/api.js';

/**
 * Build the agent routes.
 *
 * @param {object} deps Dependencies.
 * @param {Record<string, any>} deps.services The service container.
 * @param {Record<string, any>} deps.config Application config.
 * @param {Record<string, any>} deps.guards Shared middleware: limiters, auth, read-only guard.
 * @returns {import('express').Router} The router.
 */
export function createAgentRoutes({ services, config, guards }) {
  const router = Router();

  /* ---- Register --------------------------------------------------------- */

  router.post(
    '/register',
    guards.writeLimiter,
    guards.requireApiKey,
    guards.readOnlyGuard,
    validate({ body: RegisterBody }),
    asyncHandler(async (req, res) => {
      const address = services.crypto.agentAddress() ?? services.chain.address();
      if (!address) throw errors.readOnly();

      const publicKey = services.crypto.encryptionPublicKey();
      if (!publicKey) {
        throw errors.chainUnavailable(
          'This node has no encryption keypair yet, so it cannot publish one. Check /readyz.',
        );
      }

      // Preflight rather than pay gas to revert. An already-registered agent is a 409 the client
      // can act on, not a failed transaction and a wasted fee.
      const already = await services.chain.readIdentity.isRegistered(address).catch(() => false);
      if (already) {
        throw errors.conflict('This agent is already registered on chain.', { address });
      }

      const metadataURI = req.body.metadataURI ?? '';
      const job = services.jobs.create({
        kind: 'agent.register',
        steps: ['submit', 'confirm'],
        meta: { address, metadataURI: metadataURI || null },
      });

      // Fire-and-forget: the response is the job id, and every outcome lands on the job. Nothing
      // here can reject into the request, which is the property v1's un-caught handler lacked.
      void runRegistration({ jobId: job.id, address, publicKey, metadataURI });

      res
        .status(202)
        .location(`/api/v1/jobs/${job.id}`)
        .set('Retry-After', '1')
        .json(services.jobs.get(job.id));
    }),
  );

  /**
   * Submit the registration and record every step on the job.
   *
   * @param {object} args Arguments.
   * @param {string} args.jobId Job id.
   * @param {string} args.address The agent being registered.
   * @param {string} args.publicKey Compressed secp256k1 encryption public key.
   * @param {string} args.metadataURI Optional profile URI.
   * @returns {Promise<void>} Always resolves; the outcome is on the job.
   */
  async function runRegistration({ jobId, address, publicKey, metadataURI }) {
    try {
      services.jobs.begin(jobId, 'submit');
      const result = await services.chain.submit({
        label: 'agent.register',
        contract: 'AgentIdentity',
        method: 'registerAgent',
        args: [publicKey, metadataURI],
        onHash: (/** @type {string} */ hash) => {
          services.jobs.end(jobId, 'submit', 'done', { txHash: hash });
          services.jobs.begin(jobId, 'confirm');
        },
      });
      services.jobs.end(jobId, 'confirm', result.status === 'confirmed' ? 'done' : 'failed', {
        blockNumber: result.blockNumber,
      });
      if (result.status !== 'confirmed') {
        services.jobs.warn(
          jobId,
          `The transaction ${result.hash} was broadcast but not confirmed within the budget. ` +
            'It may still confirm; check the explorer link before resubmitting.',
        );
      }
      services.metrics.increment('neuromesh_tx_total', {
        label: 'agent.register',
        result: result.status,
      });
      services.jobs.finish(jobId, {
        address,
        publicKey,
        txHash: result.hash,
        explorerUrl: result.explorerUrl,
        blockNumber: result.blockNumber,
        confirmed: result.status === 'confirmed',
      });
    } catch (err) {
      services.jobs.fail(jobId, err, { address });
    }
  }

  /* ---- Lookup ----------------------------------------------------------- */

  router.get(
    '/:address',
    validate({ params: AddressParams }),
    asyncHandler(async (req, res) => {
      const address = req.params.address;
      const agent = await services.chain.readIdentity.getAgent(address);
      if (!agent.exists) {
        throw errors.notFound(`No agent is registered at ${address}.`, { address });
      }

      // A reputation read that fails must not turn a successful identity lookup into a 502: the
      // identity is the answer to this request, and the score is an enrichment.
      const reputation = await services.reputation.summaryOf(address).catch(() => null);

      res
        .set('Cache-Control', 'private, max-age=5')
        .status(200)
        .json({
          address,
          did: `did:pkh:eip155:${config.chain.chainId}:${address}`,
          registered: true,
          active: agent.active,
          keyVersion: agent.keyVersion,
          publicKey: agent.publicKey,
          metadataURI: agent.metadataURI === '' ? null : agent.metadataURI,
          registeredAt: agent.registeredAt,
          reputation,
        });
    }),
  );

  return router;
}

export default createAgentRoutes;
