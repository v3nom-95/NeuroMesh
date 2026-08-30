/**
 * Reputation service: on-chain trust reads, the WAD unit conversion, and preflighted endorse/report
 * writes.
 *
 * ## The unit change, stated loudly because it is silent otherwise
 *
 * The v1 contract's `globalReputation` returned `endorsers * 1000 / (1 + 3 * reports)` - an
 * unbounded integer whose magnitude depended on the population. The rewritten `ReputationManager`
 * returns **WAD**: a `uint256` scaled by 1e18, bounded in `[0, 1e18]`, with time decay applied.
 *
 * Nothing about that change is visible at a call site. A dashboard that keeps treating the value as
 * the old integer renders a score inflated by roughly 1e15 and shows no error, because the value is
 * still a number and the chart still draws. {@link createReputationService} is therefore the single
 * place in the backend that divides by 1e18; `src/services/chain.js` deliberately returns WAD
 * strings untouched, and no route, view or script performs the conversion for itself.
 *
 * ## Why the writes are preflighted
 *
 * `endorseAgent` is `payable` and takes a stake. Submitting one blindly costs gas whether it
 * succeeds or reverts, so every condition the contract will check is checked here first, from the
 * chain rather than from a constant:
 *
 *   - the target is a valid, checksummed address, and is not this node itself;
 *   - the target is registered (an endorsement of an unregistered agent is a guaranteed revert);
 *   - there is no live endorsement already (a duplicate is a `409`, not a paid-for failure);
 *   - the stake is read from `endorsementStakeWei()`, never hardcoded - a hardcoded stake is how an
 *     endorsement gets rejected for underpayment after a parameter change;
 *   - the reason fits `MAX_REASON_CHARS`.
 *
 * The balance preflight itself lives in the transaction queue, which is the only place that knows
 * this transaction's gas limit and fee, and can therefore report the exact shortfall.
 *
 * @module src/services/reputation
 */
import { getAddress, isAddress } from 'ethers';

import { getConfig } from '../config/index.js';
import { errors } from '../errors.js';
import { logger as defaultLogger } from '../logger.js';
import { constants } from '../protocol/index.js';

import { normalizeMetrics } from './instrument.js';

/** 1e18, as a BigInt. The scale factor for every `*Wad` value the contract returns. */
export const WAD = constants.WAD;

/** How many `reputationOf` reads run at once in {@link ReputationService.leaderboard}. */
export const LEADERBOARD_CONCURRENCY = 5;

/** How long contract parameters are cached. They change only through a governance transaction. */
export const PARAMS_CACHE_MS = 300000;

/**
 * `TrustEventKind` as the contract encodes it.
 *
 * Transcribed from the enum's declaration order, which is what the `uint8` on the wire means. A
 * value outside this table is surfaced as `'unknown'` with the raw number retained, never guessed
 * into the nearest known action.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const TRUST_EVENT_KINDS = Object.freeze({
  0: 'endorse',
  1: 'report',
  2: 'endorsement_revoked',
  3: 'report_withdrawn',
  4: 'endorsement_slashed',
});

/**
 * Create the reputation service.
 *
 * @param {object} deps Dependencies. Not optional: the chain service is required, and defaulting
 *   the whole bag to `{}` would turn that into a `TypeError` at the first read instead of a
 *   construction-time signature error.
 * @param {any} deps.chain Chain service. Required: every read and write goes through it.
 * @param {ReturnType<typeof getConfig>} [deps.config] Application config.
 * @param {any} [deps.logger] Pino logger.
 * @param {import('./instrument.js').MetricsLike} [deps.metrics] Metrics collector.
 * @param {() => number} [deps.now] Clock, in epoch milliseconds.
 * @returns {ReputationService} The service.
 */
export function createReputationService({
  chain,
  config = getConfig(),
  logger = defaultLogger,
  metrics,
  now = Date.now,
}) {
  const log = logger.child ? logger.child({ service: 'reputation' }) : logger;
  const instruments = normalizeMetrics(metrics);

  /** @type {{at: number, value: any}|null} */
  let paramsCache = null;

  /**
   * The contract's tunable parameters, cached.
   *
   * @param {{force?: boolean}} [options] Options.
   * @returns {Promise<any>} Parameters, with WAD values converted alongside the raw strings.
   */
  async function parameters({ force = false } = {}) {
    if (!force && paramsCache && now() - paramsCache.at < PARAMS_CACHE_MS) return paramsCache.value;
    const raw = await chain.readReputation.parameters();
    // Written through a synchronous setter rather than assigned here, so the cache slot is never
    // read on one side of an `await` and overwritten on the other.
    return cacheParameters({
      ...raw,
      trustThreshold: wadToUnit(raw.trustThresholdWad),
      prior: wadToUnit(raw.priorWad),
      negativeMultiplier: wadToUnit(raw.negativeMultiplierWad),
      halfLifeDays: raw.halfLifeSeconds / 86400,
    });
  }

  /**
   * @param {any} value Freshly read parameters.
   * @returns {any} The same value, now cached.
   */
  function cacheParameters(value) {
    paramsCache = { at: now(), value };
    return value;
  }

  /**
   * One agent's score.
   *
   * @param {string} address Agent address.
   * @returns {Promise<ScoreEntry>} The score in every unit a consumer might want, so no consumer
   *   invents its own conversion.
   */
  async function scoreOf(address) {
    const target = assertAddress(address, 'address');
    const stop = instruments.timer('neuromesh_reputation_read_duration_seconds');
    try {
      const [scoreWad, bps, trusted, endorsements, reports] = await Promise.all([
        chain.readReputation.reputationOf(target),
        chain.readReputation.reputationBps(target),
        chain.readReputation.isTrusted(target),
        chain.readReputation.endorserCount(target),
        chain.readReputation.reporterCount(target),
      ]);
      return {
        address: target,
        scoreWad: String(scoreWad),
        // The one division in the backend. See the module header.
        score: wadToUnit(scoreWad),
        bps: Number(bps),
        trusted: Boolean(trusted),
        endorsements: Number(endorsements),
        reports: Number(reports),
      };
    } finally {
      stop();
    }
  }

  /**
   * A score plus everything the profile view needs, in one round of reads.
   *
   * @param {string} address Agent address.
   * @returns {Promise<any>} Score, identity and the trust threshold this score is judged against.
   */
  async function summaryOf(address) {
    const target = assertAddress(address, 'address');
    const [score, params] = await Promise.all([scoreOf(target), parameters().catch(() => null)]);
    /** @type {any} */
    let identity = null;
    try {
      identity = await chain.readIdentity.getAgent(target);
    } catch (err) {
      // An agent may legitimately have a reputation read of zero and no identity record. That is a
      // fact about the agent, not a failure of this request.
      log.debug?.(
        { address: target, err: String(/** @type {any} */ (err)?.message ?? err) },
        'identity lookup failed while building a reputation summary',
      );
    }
    return {
      ...score,
      registered: Boolean(identity?.exists),
      active: Boolean(identity?.active),
      keyVersion: identity?.keyVersion ?? null,
      registeredAt: identity?.registeredAt ?? null,
      thresholds: params ? { trusted: params.trustThreshold, max: 1 } : { trusted: null, max: 1 },
    };
  }

  /**
   * Scores for a set of addresses, ranked.
   *
   * Concurrency is capped at five rather than firing every read at once: a public RPC endpoint
   * rate-limits, and a leaderboard of fifty agents issuing 250 simultaneous calls converts a slow
   * page into a 429 storm that also breaks every other request in flight.
   *
   * @param {object} [args] Arguments.
   * @param {string[]} [args.addresses] Addresses to score.
   * @returns {Promise<{entries: ScoreEntry[], thresholds: {trusted: number|null, max: number},
   *   failed: Array<{address: string, reason: string}>}>} The leaderboard.
   */
  async function leaderboard({ addresses = [] } = {}) {
    if (!Array.isArray(addresses)) {
      throw errors.badRequest('leaderboard() requires an array of addresses.');
    }
    const targets = [...new Set(addresses.map((a) => assertAddress(a, 'addresses[]')))];
    /** @type {ScoreEntry[]} */
    const entries = [];
    /** @type {Array<{address: string, reason: string}>} */
    const failed = [];
    for (let i = 0; i < targets.length; i += LEADERBOARD_CONCURRENCY) {
      const slice = targets.slice(i, i + LEADERBOARD_CONCURRENCY);
      const settled = await Promise.allSettled(slice.map((address) => scoreOf(address)));
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') entries.push(result.value);
        else failed.push({ address: slice[index], reason: String(result.reason?.message ?? '') });
      });
    }
    entries.sort(
      (a, b) =>
        Number(BigInt(b.scoreWad) > BigInt(a.scoreWad)) -
          Number(BigInt(b.scoreWad) < BigInt(a.scoreWad)) ||
        (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
    );
    const params = await parameters().catch(() => null);
    return {
      entries,
      thresholds: { trusted: params?.trustThreshold ?? null, max: 1 },
      failed,
    };
  }

  /**
   * A page of the on-chain trust log.
   *
   * The ring buffer is capacity-bounded (`TRUST_LOG_CAPACITY`), so it is the *recent* history, not
   * the whole of it; the authoritative record is the `AgentEndorsed`/`AgentReported` event log. The
   * response says which one it is rather than letting a caller assume.
   *
   * The chain stores only `reasonHash`. The reason *text* lives in the event log, so it is `null`
   * here unless a log lookup supplied it - never a guess, and never the hash rendered as if it were
   * text.
   *
   * @param {object} [options] Options.
   * @param {number} [options.limit] Page size.
   * @param {string|null} [options.cursor] Opaque cursor from a previous page.
   * @returns {Promise<{items: TrustEvent[], nextCursor: string|null, total: number,
   *   capacityBounded: true}>} One page.
   */
  async function events({ limit = 25, cursor = null } = {}) {
    const pageLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const offset = decodeCursor(cursor);
    const page = await chain.readReputation.getTrustEvents(offset, pageLimit);
    const items = page.page.map((row) => ({
      id: `${row.index}`,
      from: row.from,
      to: row.to,
      action: TRUST_EVENT_KINDS[row.kind] ?? 'unknown',
      kind: row.kind,
      weightWad: row.weightWad,
      weight: wadToUnit(row.weightWad),
      reason: null,
      reasonHash: row.reasonHash,
      at: row.timestamp,
      txHash: null,
    }));
    const consumed = offset + items.length;
    return {
      items,
      nextCursor: consumed < page.total && items.length > 0 ? encodeCursor(consumed) : null,
      total: page.total,
      capacityBounded: /** @type {const} */ (true),
    };
  }

  /**
   * Endorse an agent.
   *
   * @param {object} args Arguments.
   * @param {string} args.target Agent to endorse.
   * @param {string} [args.reason] Free-text reason, recorded as a hash on chain.
   * @param {(hash: string) => void} [args.onHash] Called as soon as the transaction hash exists.
   * @returns {Promise<any>} The transaction result.
   */
  function endorse(args) {
    return submitTrustAction('endorse', args);
  }

  /**
   * Report an agent.
   *
   * @param {object} args Arguments.
   * @param {string} args.target Agent to report.
   * @param {string} [args.reason] Free-text reason, recorded as a hash on chain.
   * @param {(hash: string) => void} [args.onHash] Called as soon as the transaction hash exists.
   * @returns {Promise<any>} The transaction result.
   */
  function report(args) {
    return submitTrustAction('report', args);
  }

  /**
   * The shared preflight-and-submit path for both trust actions.
   *
   * @param {'endorse'|'report'} action Which action.
   * @param {{target?: string, reason?: string, onHash?: (hash: string) => void}} [args] Arguments;
   *   validated here rather than assumed, so a missing target is a 400 and not a TypeError.
   * @returns {Promise<any>} The transaction result.
   */
  async function submitTrustAction(action, { target, reason = '', onHash } = {}) {
    chain.assertWritable();
    const to = assertAddress(target, 'target');
    const from = chain.address();
    if (!from) throw errors.readOnly();
    if (to.toLowerCase() === from.toLowerCase()) {
      // The contract rejects this too, but discovering it as a revert costs gas and tells the caller
      // less than a 400 naming the rule does.
      throw errors.badRequest(
        `An agent cannot ${action} itself. Reputation is a statement other agents make about this ` +
          'one; a self-referential edge carries no information and the contract rejects it.',
        { from, to },
      );
    }
    if (typeof reason !== 'string' || reason.length > config.embeddings.maxReasonChars) {
      throw errors.badRequest(
        `"reason" must be a string of at most ${config.embeddings.maxReasonChars} characters.`,
        { limit: config.embeddings.maxReasonChars, actual: reason?.length ?? null },
      );
    }

    const registered = await chain.readIdentity.isRegistered(to);
    if (!registered) {
      throw errors.badRequest(
        `${to} is not a registered agent, so it has no identity to ${action}. The transaction ` +
          'would revert; it was not sent and no gas was spent.',
        { target: to },
      );
    }

    const duplicate =
      action === 'endorse'
        ? await chain.readReputation.hasActiveEndorsement(from, to)
        : await chain.readReputation.hasActiveReport(from, to);
    if (duplicate) {
      throw errors.conflict(
        `This agent already has a live ${action} for ${to}. Revoke or withdraw it first; a second ` +
          'one would revert.',
        { from, to, action },
      );
    }

    /** @type {bigint} */
    let value = 0n;
    if (action === 'endorse') {
      const params = await parameters();
      value = BigInt(params.endorsementStakeWei);
    }

    const result = await chain.submit({
      label: `reputation.${action}`,
      contract: 'ReputationManager',
      method: action === 'endorse' ? 'endorseAgent' : 'reportAgent',
      args: [to, reason],
      value,
      onHash,
    });
    instruments.increment('neuromesh_reputation_actions_total', {
      action,
      status: result.status,
    });
    log.info?.({ action, from, to, hash: result.hash, status: result.status }, 'trust action sent');
    // The caches are now stale for both parties.
    paramsCache = null;
    return { ...result, action, from, to, stakeWei: value.toString() };
  }

  /**
   * Readiness verdict.
   *
   * `disabled` rather than `down` when no address is configured: a node without a ReputationManager
   * deployment is a legitimate configuration, and reporting it as an outage would make `/readyz`
   * red for a node that is working exactly as configured.
   *
   * @returns {Promise<{status: 'up'|'degraded'|'disabled', detail: string|null}>} The verdict.
   */
  async function health() {
    if (!config.chain.addresses.reputation) {
      return { status: /** @type {const} */ ('disabled'), detail: 'No ReputationManager address.' };
    }
    try {
      await parameters();
      return { status: /** @type {const} */ ('up'), detail: null };
    } catch (err) {
      return {
        status: /** @type {const} */ ('degraded'),
        detail: String(/** @type {any} */ (err)?.message ?? err),
      };
    }
  }

  /** @type {ReputationService} */
  const service = {
    scoreOf,
    summaryOf,
    leaderboard,
    events,
    endorse,
    report,
    parameters,
    health,
    wadToUnit,
  };
  return service;
}

/* ------------------------------------------------------------------------ */
/* Types and helpers                                                         */
/* ------------------------------------------------------------------------ */

/**
 * @typedef {object} ScoreEntry
 * @property {string} address Agent address.
 * @property {string} scoreWad Raw WAD value, as a decimal string. `JSON.stringify` throws on a
 *   BigInt, so this never leaves the service as one.
 * @property {number} score The same value in [0, 1].
 * @property {number} bps The same value in basis points.
 * @property {boolean} trusted Whether the score is at or above the trust threshold.
 * @property {number} endorsements Distinct endorsers.
 * @property {number} reports Distinct reporters.
 */

/**
 * @typedef {object} TrustEvent
 * @property {string} id Ring-buffer index, as a string.
 * @property {string} from Actor.
 * @property {string} to Target.
 * @property {string} action Decoded `TrustEventKind`, or `'unknown'`.
 * @property {number} kind The raw enum value.
 * @property {string} weightWad Weight in WAD.
 * @property {number} weight Weight in [0, 1].
 * @property {string|null} reason Reason text, only when a log lookup supplied it.
 * @property {string} reasonHash keccak of the reason string.
 * @property {number} at Block timestamp.
 * @property {string|null} txHash Transaction hash, when known.
 */

/**
 * @typedef {object} ReputationService
 * @property {(address: string) => Promise<ScoreEntry>} scoreOf One agent's score.
 * @property {(address: string) => Promise<any>} summaryOf Score plus identity.
 * @property {(args?: {addresses?: string[]}) => Promise<any>} leaderboard Ranked scores for a set
 *   of addresses.
 * @property {(options?: object) => Promise<any>} events A page of the trust log.
 * @property {(args: {target: string, reason?: string, onHash?: (hash: string) => void}) =>
 *   Promise<any>} endorse Preflighted endorsement.
 * @property {(args: {target: string, reason?: string, onHash?: (hash: string) => void}) =>
 *   Promise<any>} report Preflighted report.
 * @property {(options?: object) => Promise<any>} parameters Contract parameters, cached.
 * @property {() => Promise<any>} health Readiness verdict.
 * @property {(wad: string|bigint) => number} wadToUnit The WAD conversion, exported for tests.
 */

/**
 * Convert a WAD value to a float in [0, 1].
 *
 * The integer division extracts whole units and the remainder supplies the fraction, so a value near
 * `2^63` does not lose precision the way `Number(bigint) / 1e18` would. For the bounded scores this
 * contract produces either form would do; the careful version is here because this helper is the one
 * place the conversion happens and it should not need re-auditing if a future value is unbounded.
 *
 * @param {string|bigint|number} wad WAD-scaled value.
 * @returns {number} The value divided by 1e18.
 */
export function wadToUnit(wad) {
  const value = BigInt(wad);
  const whole = value / WAD;
  const fraction = value % WAD;
  return Number(whole) + Number(fraction) / 1e18;
}

/**
 * @param {unknown} value Candidate address. Deliberately `unknown`: this helper is the boundary that
 *   turns whatever a caller supplied into either a checksummed address or a 400.
 * @param {string} field Field name, for the message.
 * @returns {string} The checksummed address.
 * @throws {import('../errors.js').AppError} 400 when it is not an address.
 */
function assertAddress(value, field) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw errors.badRequest(`"${field}" must be a 20-byte hex address.`, { field });
  }
  return getAddress(value);
}

/**
 * @param {number} offset Page offset.
 * @returns {string} An opaque cursor.
 */
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

/**
 * @param {string|null} cursor Opaque cursor.
 * @returns {number} The offset it encodes.
 * @throws {import('../errors.js').AppError} 400 when the cursor is not one this service issued.
 */
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const offset = Number(parsed?.o);
    if (!Number.isInteger(offset) || offset < 0) throw new Error('bad offset');
    return offset;
  } catch {
    throw errors.badRequest('The pagination cursor is not one this service issued.', { cursor });
  }
}

export default createReputationService;
