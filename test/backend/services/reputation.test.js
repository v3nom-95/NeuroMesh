/**
 * Reputation service: the WAD conversion, the preflights that keep a doomed transaction from being
 * paid for, and the trust-log mapping.
 *
 * @module test/backend/services/reputation.test
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LEADERBOARD_CONCURRENCY,
  TRUST_EVENT_KINDS,
  createReputationService,
  wadToUnit,
} from '../../../src/services/reputation.js';

import { TEST_AGENT, quietLogger, testConfig } from './helpers.js';

/** Two addresses used only as agent labels. */
const ALICE = '0xD4F91196316f802B67C6B17e0B1845A23beaA2ad';
const BOB = '0x10701017eC0faed2309E103C51AB503214F940Fb';

/** The contract parameter block, in the shape `chain.readReputation.parameters()` returns. */
const PARAMETERS = {
  endorsementStakeWei: '10000000000000000',
  trustThresholdWad: '500000000000000000',
  endorseCooldown: 3600,
  reportCooldown: 7200,
  actorCooldown: 600,
  halfLifeSeconds: 15552000,
  priorWad: '100000000000000000',
  negativeMultiplierWad: '3000000000000000000',
};

/**
 * A chain double covering only what the reputation service reads and writes.
 *
 * @param {object} [overrides] Behaviour overrides.
 * @returns {any} The double, plus `submits` and `reads` logs.
 */
function fakeChain(overrides = {}) {
  /** @type {any[]} */
  const submits = [];
  /** @type {string[]} */
  const reads = [];
  const {
    writable = true,
    scoreWad = '720000000000000000',
    registered = true,
    duplicate = false,
    trustEvents = { page: [], total: 0 },
    parameters = PARAMETERS,
    address = TEST_AGENT,
    submitError = null,
  } = /** @type {any} */ (overrides);
  return {
    submits,
    reads,
    assertWritable() {
      if (!writable) {
        const err = /** @type {any} */ (new Error('read only'));
        err.status = 503;
        err.code = 'read_only';
        throw err;
      }
    },
    address: () => address,
    /**
     * @param {any} descriptor Transaction descriptor.
     * @returns {Promise<any>} The result.
     */
    async submit(descriptor) {
      submits.push(descriptor);
      if (submitError) throw submitError;
      return { status: 'confirmed', hash: `0x${'cd'.repeat(32)}`, nonce: '1', blockNumber: 1 };
    },
    readIdentity: {
      /**
       * @returns {Promise<boolean>} Whether the target exists.
       */
      async isRegistered() {
        reads.push('isRegistered');
        return registered;
      },
      /**
       * @returns {Promise<any>} An identity record.
       */
      async getAgent() {
        return { exists: true, active: true, keyVersion: 1, registeredAt: 1767225600 };
      },
    },
    readReputation: {
      /**
       * @returns {Promise<string>} Reputation in WAD.
       */
      async reputationOf() {
        reads.push('reputationOf');
        return scoreWad;
      },
      /**
       * @returns {Promise<number>} Reputation in basis points.
       */
      async reputationBps() {
        return Math.round(Number(wadToUnit(scoreWad)) * 10000);
      },
      /**
       * @returns {Promise<boolean>} Whether the score clears the threshold.
       */
      async isTrusted() {
        return BigInt(scoreWad) >= BigInt(PARAMETERS.trustThresholdWad);
      },
      /**
       * @returns {Promise<number>} Endorser count.
       */
      async endorserCount() {
        return 4;
      },
      /**
       * @returns {Promise<number>} Reporter count.
       */
      async reporterCount() {
        return 1;
      },
      /**
       * @returns {Promise<boolean>} Whether a live endorsement exists.
       */
      async hasActiveEndorsement() {
        reads.push('hasActiveEndorsement');
        return duplicate;
      },
      /**
       * @returns {Promise<boolean>} Whether a live report exists.
       */
      async hasActiveReport() {
        reads.push('hasActiveReport');
        return duplicate;
      },
      /**
       * @returns {Promise<any>} A page of the trust log.
       */
      async getTrustEvents() {
        return trustEvents;
      },
      /**
       * @returns {Promise<any>} The parameter block.
       */
      async parameters() {
        reads.push('parameters');
        return parameters;
      },
    },
  };
}

/**
 * @param {any} [chainOverrides] Chain double overrides.
 * @param {Record<string, string|undefined>} [env] Environment overrides.
 * @returns {any} The service and its chain double.
 */
function build(chainOverrides = {}, env = {}) {
  const chain = fakeChain(chainOverrides);
  const service = createReputationService({
    chain,
    config: testConfig(env),
    logger: quietLogger(),
  });
  return { service, chain };
}

describe('services/reputation: the WAD conversion', () => {
  it('maps 1e18 to 1 and 0 to 0', () => {
    assert.equal(wadToUnit('1000000000000000000'), 1);
    assert.equal(wadToUnit('0'), 0);
  });

  it('maps a half-unit exactly', () => {
    assert.equal(wadToUnit('500000000000000000'), 0.5);
  });

  it('accepts a BigInt as well as a decimal string', () => {
    assert.equal(wadToUnit(750000000000000000n), 0.75);
  });

  it('is the reason a v1 consumer would be wrong by ~1e15', () => {
    // The v1 contract returned `endorsers*1000/(1+3*reports)`, an unbounded integer. A consumer
    // that keeps treating the value as that integer renders 7.2e17 instead of 0.72 — a number that
    // still draws on a chart, with no error anywhere.
    const raw = Number('720000000000000000');
    assert.ok(raw / wadToUnit('720000000000000000') > 1e17);
  });
});

describe('services/reputation: reads', () => {
  it('returns the score in every unit, so no consumer invents its own conversion', async () => {
    const { service } = build();
    const score = await service.scoreOf(ALICE);
    assert.equal(score.address, ALICE);
    assert.equal(score.scoreWad, '720000000000000000');
    assert.equal(typeof score.scoreWad, 'string');
    assert.ok(Math.abs(score.score - 0.72) < 1e-12);
    assert.equal(score.bps, 7200);
    assert.equal(score.trusted, true);
    assert.equal(score.endorsements, 4);
    assert.equal(score.reports, 1);
  });

  it('never leaks a BigInt into a JSON-serialisable result', async () => {
    const { service } = build();
    // JSON.stringify throws on a BigInt, so one that escapes turns a dashboard request into a 500.
    assert.doesNotThrow(() => JSON.stringify(service.scoreOf(ALICE)));
    assert.doesNotThrow(async () => JSON.stringify(await service.scoreOf(ALICE)));
  });

  it('rejects an address-shaped string that is not an address', async () => {
    const { service, chain } = build();
    await assert.rejects(
      service.scoreOf('0xnope'),
      (err) => /** @type {any} */ (err).status === 400,
    );
    assert.equal(chain.reads.length, 0);
  });

  it('caches the contract parameters instead of re-reading them per request', async () => {
    const { service, chain } = build();
    await service.parameters();
    await service.parameters();
    assert.equal(chain.reads.filter((r) => r === 'parameters').length, 1);
  });

  it('converts the WAD parameters alongside the raw values', async () => {
    const { service } = build();
    const params = await service.parameters();
    assert.equal(params.trustThresholdWad, PARAMETERS.trustThresholdWad);
    assert.equal(params.trustThreshold, 0.5);
    assert.equal(params.halfLifeDays, 180);
  });

  it('builds a summary that survives a missing identity record', async () => {
    const chain = fakeChain();
    chain.readIdentity.getAgent = async () => {
      throw new Error('no such agent');
    };
    const service = createReputationService({ chain, config: testConfig(), logger: quietLogger() });
    const summary = await service.summaryOf(ALICE);
    // A zero-reputation agent with no identity record is a fact about the agent, not a failure.
    assert.equal(summary.registered, false);
    assert.equal(summary.score, 0.72);
    assert.equal(summary.thresholds.trusted, 0.5);
  });

  it('ranks a leaderboard by score and reports what it could not read', async () => {
    const chain = fakeChain();
    /** @type {Record<string, string>} */
    const scores = {
      [ALICE]: '900000000000000000',
      [BOB]: '100000000000000000',
      [TEST_AGENT]: '500000000000000000',
    };
    chain.readReputation.reputationOf = async (/** @type {string} */ address) => {
      if (address === BOB) throw new Error('rpc hiccup');
      return scores[address];
    };
    const service = createReputationService({ chain, config: testConfig(), logger: quietLogger() });
    const board = await service.leaderboard({ addresses: [BOB, TEST_AGENT, ALICE] });
    assert.deepEqual(
      board.entries.map((/** @type {any} */ e) => e.address),
      [ALICE, TEST_AGENT],
    );
    assert.equal(board.failed.length, 1);
    assert.equal(board.failed[0].address, BOB);
    assert.equal(board.thresholds.trusted, 0.5);
  });

  it('deduplicates leaderboard addresses and bounds its concurrency', async () => {
    const { service } = build();
    assert.equal(LEADERBOARD_CONCURRENCY, 5);
    const board = await service.leaderboard({ addresses: [ALICE, ALICE, ALICE] });
    assert.equal(board.entries.length, 1);
  });
});

describe('services/reputation: the trust log', () => {
  it('decodes the event kind and reports the reason as null, never as the hash', async () => {
    const { service } = build({
      trustEvents: {
        page: [
          {
            index: 0,
            from: ALICE,
            kind: 0,
            timestamp: 1767225600,
            to: BOB,
            weightWad: '250000000000000000',
            reasonHash: `0x${'ee'.repeat(32)}`,
          },
          {
            index: 1,
            from: BOB,
            kind: 1,
            timestamp: 1767225601,
            to: ALICE,
            weightWad: '100000000000000000',
            reasonHash: `0x${'ff'.repeat(32)}`,
          },
        ],
        total: 2,
      },
    });
    const page = await service.events({ limit: 10 });
    assert.equal(page.items[0].action, 'endorse');
    assert.equal(page.items[1].action, 'report');
    assert.equal(page.items[0].weight, 0.25);
    // The chain stores only the hash. Rendering it as if it were text would be a fabrication.
    assert.equal(page.items[0].reason, null);
    assert.equal(page.items[0].reasonHash, `0x${'ee'.repeat(32)}`);
    // The ring buffer is recent history, not the whole of it, and the response says so.
    assert.equal(page.capacityBounded, true);
  });

  it('reports an unrecognised kind as "unknown" rather than guessing', async () => {
    const { service } = build({
      trustEvents: {
        page: [
          {
            index: 0,
            from: ALICE,
            kind: 99,
            timestamp: 1,
            to: BOB,
            weightWad: '0',
            reasonHash: `0x${'00'.repeat(32)}`,
          },
        ],
        total: 1,
      },
    });
    const page = await service.events();
    assert.equal(page.items[0].action, 'unknown');
    assert.equal(page.items[0].kind, 99);
    assert.ok(!(99 in TRUST_EVENT_KINDS));
  });

  it('issues a cursor only while there is more to read', async () => {
    const row = {
      index: 0,
      from: ALICE,
      kind: 0,
      timestamp: 1,
      to: BOB,
      weightWad: '0',
      reasonHash: `0x${'00'.repeat(32)}`,
    };
    const more = build({ trustEvents: { page: [row], total: 5 } });
    assert.ok((await more.service.events({ limit: 1 })).nextCursor);
    const done = build({ trustEvents: { page: [row], total: 1 } });
    assert.equal((await done.service.events({ limit: 1 })).nextCursor, null);
  });

  it('rejects a cursor it did not issue', async () => {
    const { service } = build();
    await assert.rejects(
      service.events({ cursor: 'hand-made' }),
      (err) => /** @type {any} */ (err).status === 400,
    );
  });
});

describe('services/reputation: preflighted writes', () => {
  it('reads the stake from the contract rather than hardcoding it', async () => {
    const { service, chain } = build();
    const result = await service.endorse({ target: ALICE, reason: 'useful memories' });
    assert.equal(chain.submits.length, 1);
    assert.equal(chain.submits[0].method, 'endorseAgent');
    assert.equal(chain.submits[0].contract, 'ReputationManager');
    // A hardcoded stake is how an endorsement gets rejected for underpayment after a parameter
    // change, with the gas already spent.
    assert.equal(chain.submits[0].value, BigInt(PARAMETERS.endorsementStakeWei));
    assert.equal(result.stakeWei, PARAMETERS.endorsementStakeWei);
    assert.equal(result.action, 'endorse');
  });

  it('sends a report with no stake', async () => {
    const { service, chain } = build();
    await service.report({ target: ALICE, reason: 'fabricated citations' });
    assert.equal(chain.submits[0].method, 'reportAgent');
    assert.equal(chain.submits[0].value, 0n);
  });

  it('refuses a self-endorsement with a 400 rather than leaving it to revert', async () => {
    const { service, chain } = build();
    await assert.rejects(service.endorse({ target: TEST_AGENT }), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 400);
      assert.match(any.message, /cannot endorse itself/);
      return true;
    });
    assert.equal(chain.submits.length, 0);
  });

  it('refuses an unregistered target before spending gas', async () => {
    const { service, chain } = build({ registered: false });
    await assert.rejects(service.endorse({ target: ALICE }), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 400);
      assert.match(any.message, /no gas was spent/i);
      return true;
    });
    assert.equal(chain.submits.length, 0);
  });

  it('refuses a duplicate endorsement with 409 rather than a paid-for revert', async () => {
    const { service, chain } = build({ duplicate: true });
    await assert.rejects(service.endorse({ target: ALICE }), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 409);
      assert.equal(any.code, 'conflict');
      return true;
    });
    assert.equal(chain.submits.length, 0);
  });

  it('refuses a duplicate report with 409', async () => {
    const { service, chain } = build({ duplicate: true });
    await assert.rejects(
      service.report({ target: ALICE }),
      (err) => /** @type {any} */ (err).status === 409,
    );
    assert.equal(chain.submits.length, 0);
  });

  it('enforces MAX_REASON_CHARS', async () => {
    const { service, chain } = build({}, { MAX_REASON_CHARS: '16' });
    await assert.rejects(service.endorse({ target: ALICE, reason: 'x'.repeat(17) }), (err) => {
      const any = /** @type {any} */ (err);
      assert.equal(any.status, 400);
      assert.equal(any.details.limit, 16);
      return true;
    });
    assert.equal(chain.submits.length, 0);
  });

  it('refuses every write on a read-only node before any read', async () => {
    const { service, chain } = build({ writable: false });
    await assert.rejects(
      service.endorse({ target: ALICE }),
      (err) => /** @type {any} */ (err).code === 'read_only',
    );
    assert.equal(chain.reads.length, 0);
  });

  it('rejects a malformed target address', async () => {
    const { service, chain } = build();
    await assert.rejects(
      service.endorse({ target: 'alice.eth' }),
      (err) => /** @type {any} */ (err).status === 400,
    );
    assert.equal(chain.submits.length, 0);
  });
});

describe('services/reputation: health', () => {
  it('reports disabled when no ReputationManager address is configured', async () => {
    const { service } = build({}, { CONTRACT_REPUTATION_MANAGER: undefined });
    // A node without a ReputationManager deployment is configured that way on purpose; reporting it
    // as an outage would make /readyz red for a node that is working correctly.
    assert.deepEqual(await service.health(), {
      status: 'disabled',
      detail: 'No ReputationManager address.',
    });
  });

  it('reports up when the parameters read', async () => {
    const { service } = build();
    assert.deepEqual(await service.health(), { status: 'up', detail: null });
  });

  it('reports degraded, with a detail, when the read fails', async () => {
    const chain = fakeChain();
    chain.readReputation.parameters = async () => {
      throw new Error('rpc is down');
    };
    const service = createReputationService({ chain, config: testConfig(), logger: quietLogger() });
    const health = await service.health();
    assert.equal(health.status, 'degraded');
    assert.match(String(health.detail), /rpc is down/);
  });
});
