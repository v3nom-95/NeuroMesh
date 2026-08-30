/**
 * Visibility-aware polling with bounded exponential backoff.
 *
 * The console it replaces re-armed a `setTimeout` from inside its own fetch
 * handler, forever: no cap, no cleanup, no cancellation, and no awareness of
 * whether anyone was looking. A backgrounded tab hammered `GET /api/status` every
 * two seconds for as long as the browser stayed open, and a node that was down
 * was retried at a fixed three-second cadence indefinitely with nothing on
 * screen to say so.
 *
 * What this does instead:
 *
 *   - one timer, always cancellable, never re-entrant;
 *   - one `AbortController` per tick, aborted when the next tick starts, when
 *     the page is hidden, and on `stop()` — so a slow request can never paint
 *     over a newer one;
 *   - exponential backoff with FULL JITTER on failure (`random(0, min(cap,
 *     base * 2^n))`), which is what stops a fleet of consoles from
 *     synchronising into a thundering herd against a recovering node;
 *   - `visibilitychange` pauses while hidden and fires immediately on return,
 *     because the first thing an operator wants after switching back is fresh
 *     data, not a wait for the next scheduled tick;
 *   - `offline` pauses; `online` resumes with an immediate attempt and the
 *     backoff reset, since the failures were the network's, not the node's.
 *
 * The poller reports its own state (`getState()`), which is what lets the
 * System view honestly say "polling every 5 s" or "retrying in 12 s" instead
 * of the UI guessing.
 *
 * @module poll
 */

import { isAbortError } from './api.js';

/**
 * @typedef {object} PollerOptions
 * @property {(signal: AbortSignal) => Promise<unknown>} fn the work to repeat
 * @property {number} [intervalMs] cadence when healthy (default 5000)
 * @property {number} [minIntervalMs] floor for a caller-supplied interval
 * @property {number} [maxBackoffMs] cap for the failure backoff (default 30000)
 * @property {(data: unknown) => void} [onData]
 * @property {(error: unknown, attempt: number) => void} [onError]
 * @property {(state: PollerState) => void} [onStateChange]
 * @property {boolean} [immediate] run one tick as soon as `start()` is called
 * @property {string} [label] used in warnings only
 */

/**
 * @typedef {object} PollerState
 * @property {'idle'|'polling'|'inflight'|'retrying'|'paused'|'stopped'} mode
 * @property {number} attempts consecutive failures; 0 after any success
 * @property {number} intervalMs the cadence currently in force
 * @property {number|null} nextRunAt epoch ms of the next scheduled tick
 * @property {number|null} lastSuccessAt
 * @property {unknown} lastError
 */

/**
 * @typedef {object} Poller
 * @property {() => void} start
 * @property {() => void} stop
 * @property {() => Promise<void>} refreshNow run immediately, resetting backoff
 * @property {(ms: number) => void} setInterval change the healthy cadence
 * @property {() => PollerState} getState
 */

const DEFAULT_INTERVAL = 5000;
const DEFAULT_MIN_INTERVAL = 1000;
const DEFAULT_MAX_BACKOFF = 30000;

/**
 * @param {PollerOptions} options
 * @returns {Poller}
 */
export function createPoller(options) {
  if (!options || typeof options.fn !== 'function') {
    throw new TypeError('createPoller({ fn }): fn must be a function');
  }

  const minInterval = Math.max(250, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL);
  const maxBackoff = Math.max(minInterval, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF);
  const label = options.label ?? 'poller';

  let healthyInterval = Math.max(minInterval, options.intervalMs ?? DEFAULT_INTERVAL);

  /** @type {number | undefined} */
  let timer;
  /** @type {AbortController | null} */
  let controller = null;
  /** @type {(() => void)[]} */
  const teardown = [];

  let running = false;
  let inFlight = false;
  let attempts = 0;
  /** @type {number | null} */
  let nextRunAt = null;
  /** @type {number | null} */
  let lastSuccessAt = null;
  /** @type {unknown} */
  let lastError = null;
  /** @type {PollerState['mode']} */
  let mode = 'idle';

  /**
   * @returns {boolean} true when a tick would be pointless right now
   */
  function suspended() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    return false;
  }

  /**
   * @param {PollerState['mode']} next
   * @returns {void}
   */
  function setMode(next) {
    if (mode === next) return;
    mode = next;
    emitState();
  }

  /**
   * @returns {void}
   */
  function emitState() {
    if (!options.onStateChange) return;
    try {
      options.onStateChange(getState());
    } catch (error) {
      console.error('[' + label + '] onStateChange threw', error);
    }
  }

  /**
   * Full-jitter backoff. The random floor is deliberately zero: a jittered
   * delay whose minimum is the previous delay is not jitter, it is a slower
   * herd.
   *
   * @returns {number}
   */
  function backoffMs() {
    const ceiling = Math.min(maxBackoff, healthyInterval * Math.pow(2, Math.max(0, attempts - 1)));
    return Math.max(minInterval, Math.round(Math.random() * ceiling));
  }

  /**
   * @param {number} delay
   * @returns {void}
   */
  function schedule(delay) {
    clearTimer();
    if (!running) return;
    nextRunAt = Date.now() + delay;
    timer = window.setTimeout(() => {
      timer = undefined;
      void tick();
    }, delay);
    emitState();
  }

  /**
   * @returns {void}
   */
  function clearTimer() {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    nextRunAt = null;
  }

  /**
   * @returns {void}
   */
  function abortInFlight() {
    if (!controller) return;
    controller.abort();
    controller = null;
  }

  /**
   * One poll. Never throws, never overlaps itself, and never schedules a
   * successor while the page is hidden or offline — the visibility and online
   * listeners are what resume it.
   *
   * @returns {Promise<void>}
   */
  async function tick() {
    if (!running || inFlight) return;
    if (suspended()) {
      clearTimer();
      setMode('paused');
      return;
    }

    inFlight = true;
    setMode('inflight');
    abortInFlight();
    const local = new AbortController();
    controller = local;

    try {
      const data = await options.fn(local.signal);
      if (!running || local.signal.aborted) return;
      attempts = 0;
      lastError = null;
      lastSuccessAt = Date.now();
      if (options.onData) options.onData(data);
      setMode('polling');
      schedule(healthyInterval);
    } catch (error) {
      if (!running) return;
      // An abort is this module cancelling its own work — a decision, not a
      // fault. It must not count towards backoff or reach the error callback.
      if (isAbortError(error) || local.signal.aborted) return;
      attempts += 1;
      lastError = error;
      if (options.onError) {
        try {
          options.onError(error, attempts);
        } catch (callbackError) {
          console.error('[' + label + '] onError threw', callbackError);
        }
      }
      setMode('retrying');
      schedule(backoffMs());
    } finally {
      inFlight = false;
      if (controller === local) controller = null;
    }
  }

  /**
   * @returns {void}
   */
  function handleVisibility() {
    if (!running) return;
    if (document.visibilityState === 'hidden') {
      clearTimer();
      abortInFlight();
      setMode('paused');
      return;
    }
    // Back in view: answer with fresh data now rather than after a full period.
    void tick();
  }

  /**
   * @returns {void}
   */
  function handleOnline() {
    if (!running) return;
    // The failures belonged to the disconnected network, not the node, so the
    // backoff that grew during the outage is discarded.
    attempts = 0;
    void tick();
  }

  /**
   * @returns {void}
   */
  function handleOffline() {
    if (!running) return;
    clearTimer();
    abortInFlight();
    setMode('paused');
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempts = 0;

      const visibility = () => handleVisibility();
      const online = () => handleOnline();
      const offline = () => handleOffline();
      document.addEventListener('visibilitychange', visibility);
      window.addEventListener('online', online);
      window.addEventListener('offline', offline);
      teardown.push(
        () => document.removeEventListener('visibilitychange', visibility),
        () => window.removeEventListener('online', online),
        () => window.removeEventListener('offline', offline),
      );

      if (options.immediate === false) schedule(healthyInterval);
      else void tick();
    },

    stop() {
      running = false;
      clearTimer();
      abortInFlight();
      while (teardown.length > 0) {
        const dispose = teardown.pop();
        if (dispose) dispose();
      }
      setMode('stopped');
    },

    async refreshNow() {
      if (!running) return;
      attempts = 0;
      clearTimer();
      // A tick already in flight owns the cycle; cancelling it here would only
      // trade a nearly-finished request for a brand new one.
      if (inFlight) return;
      await tick();
    },

    setInterval(ms) {
      const next = Math.max(minInterval, Number(ms) || healthyInterval);
      if (next === healthyInterval) return;
      healthyInterval = next;
      if (running && !inFlight && attempts === 0) schedule(healthyInterval);
      else emitState();
    },

    getState,
  };

  /**
   * @returns {PollerState}
   */
  function getState() {
    return {
      mode,
      attempts,
      intervalMs: attempts > 0 ? backoffCeiling() : healthyInterval,
      nextRunAt,
      lastSuccessAt,
      lastError,
    };
  }

  /**
   * The un-jittered ceiling, for display only. Reporting the jittered value
   * would make the System view's "retrying in Ns" jump around at random.
   *
   * @returns {number}
   */
  function backoffCeiling() {
    return Math.min(maxBackoff, healthyInterval * Math.pow(2, Math.max(0, attempts - 1)));
  }
}
