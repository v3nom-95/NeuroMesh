/**
 * Service instrumentation: a metrics adapter, a latency sampler, and two timing helpers.
 *
 * ## Why this file exists
 *
 * Every service in this directory is asked to "record per-call latency for metrics", but the
 * prom-client registry (`src/services/metrics.js`) belongs to a later phase. Rather than have seven
 * services each grow their own `metrics?.observe?.(...)` guard - and each disagree about the shape
 * of the object they are guarding - the contract is stated once, here.
 *
 * A service accepts an optional `metrics` argument and passes it through {@link normalizeMetrics},
 * which returns a total object with `observe`/`increment`/`gauge`/`timer`. A missing collector, a
 * collector that implements only part of the surface, and a collector whose method throws are all
 * the same thing to a caller: nothing happens. **A metrics failure must never turn a working
 * request into a failed one**, so every call is wrapped.
 *
 * {@link LatencyRing} is the in-process sample buffer behind `state().latency` on the embedding
 * service and behind the eventual `/api/v1/metrics/summary`. Percentiles come from actual samples
 * rather than from histogram-bucket interpolation, and the ring is bounded so it cannot grow.
 *
 * Timing uses `performance.now()`, never `Date.now()`. The v1 benchmark harness used `Date.now()`,
 * whose 1 ms resolution on Windows reported the 0.027 ms envelope encryption as `0` - a measurement
 * that made a real 1,960x improvement invisible.
 *
 * @module src/services/instrument
 */

/**
 * A metrics collector, as a service expects to find it. Every method is optional; every method may
 * throw without consequence.
 *
 * @typedef {object} MetricsLike
 * @property {(name: string, seconds: number, labels?: Record<string, string|number>) => void} [observe]
 *   Record an observation, in **seconds** (the Prometheus base unit).
 * @property {(name: string, labels?: Record<string, string|number>, value?: number) => void} [increment]
 *   Increment a counter.
 * @property {(name: string, value: number, labels?: Record<string, string|number>) => void} [gauge]
 *   Set a gauge.
 */

/**
 * A metrics collector with no optional members: safe to call unconditionally.
 *
 * @typedef {object} Instruments
 * @property {(name: string, seconds: number, labels?: Record<string, string|number>) => void} observe
 *   Record an observation in seconds.
 * @property {(name: string, labels?: Record<string, string|number>, value?: number) => void} increment
 *   Increment a counter.
 * @property {(name: string, value: number, labels?: Record<string, string|number>) => void} gauge
 *   Set a gauge.
 * @property {(name: string, labels?: Record<string, string|number>) => (extra?: Record<string, string|number>) => number} timer
 *   Start a timer; the returned function stops it, records the duration in seconds, and returns the
 *   elapsed milliseconds.
 */

/**
 * Wrap a possibly-absent, possibly-partial, possibly-throwing metrics collector into a total one.
 *
 * @param {MetricsLike|null|undefined} metrics The collector, if any.
 * @returns {Instruments} A collector that is always safe to call.
 */
export function normalizeMetrics(metrics) {
  /**
   * @param {string} method Method to invoke.
   * @param {unknown[]} args Arguments.
   * @returns {void}
   */
  const call = (method, args) => {
    const fn = /** @type {any} */ (metrics)?.[method];
    if (typeof fn !== 'function') return;
    try {
      fn.apply(metrics, args);
    } catch {
      // Deliberately swallowed. Instrumentation is never allowed to fail a request; a broken
      // collector must degrade to "no data", not to a 500.
    }
  };

  /** @type {Instruments} */
  const instruments = {
    observe: (name, seconds, labels) => call('observe', [name, seconds, labels]),
    increment: (name, labels, value) => call('increment', [name, labels, value]),
    gauge: (name, value, labels) => call('gauge', [name, value, labels]),
    timer: (name, labels) => {
      const started = performance.now();
      return (extra) => {
        const ms = performance.now() - started;
        instruments.observe(name, ms / 1000, { ...labels, ...extra });
        return ms;
      };
    },
  };

  return instruments;
}

/**
 * A bounded ring of latency samples, in milliseconds, with exact percentiles over what it holds.
 *
 * The percentiles are honest about their scope: they describe the last `capacity` observations, not
 * the process lifetime. `stats()` reports `count` so a consumer can see how thin the sample is.
 */
export class LatencyRing {
  /**
   * @param {number} [capacity] Maximum samples retained.
   */
  constructor(capacity = 200) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError(`LatencyRing capacity must be a positive integer, got ${capacity}.`);
    }
    /** @type {number} Maximum retained samples. */
    this.capacity = capacity;
    /** @type {number[]} Retained samples, in arrival order until the ring wraps. */
    this.samples = [];
    /** @type {number} Next write index once the ring is full. */
    this.next = 0;
    /** @type {number} Lifetime observation count, which may exceed `capacity`. */
    this.total = 0;
  }

  /**
   * Record one sample.
   *
   * @param {number} ms Duration in milliseconds. Non-finite values are ignored.
   * @returns {void}
   */
  observe(ms) {
    if (!Number.isFinite(ms)) return;
    this.total += 1;
    if (this.samples.length < this.capacity) {
      this.samples.push(ms);
      return;
    }
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.capacity;
  }

  /**
   * Summary statistics over the retained samples.
   *
   * @returns {{count: number, retained: number, mean: number|null, p50: number|null,
   *   p95: number|null, p99: number|null, min: number|null, max: number|null}} Statistics; every
   *   quantile is `null` when nothing has been observed, never a misleading `0`.
   */
  stats() {
    const n = this.samples.length;
    if (n === 0) {
      return {
        count: this.total,
        retained: 0,
        mean: null,
        p50: null,
        p95: null,
        p99: null,
        min: null,
        max: null,
      };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const sum = sorted.reduce((acc, value) => acc + value, 0);
    return {
      count: this.total,
      retained: n,
      mean: sum / n,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
      p99: quantile(sorted, 0.99),
      min: sorted[0],
      max: sorted[n - 1],
    };
  }

  /**
   * Drop every retained sample. The lifetime `count` is preserved.
   *
   * @returns {void}
   */
  reset() {
    this.samples = [];
    this.next = 0;
  }
}

/**
 * Nearest-rank quantile of an ascending array.
 *
 * Nearest-rank rather than linear interpolation because an interpolated p95 is a value that was
 * never observed, which is misleading when the sample is small.
 *
 * @param {number[]} sorted Ascending samples, non-empty.
 * @param {number} q Quantile in [0, 1].
 * @returns {number} The sample at that rank.
 */
function quantile(sorted, q) {
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Race a promise against a deadline.
 *
 * The timer is **not** `unref`'d. An unref'd timer that nothing else keeps alive never fires, which
 * means the timeout silently stops existing and the call it was protecting hangs forever - exactly
 * the failure the deadline is there to prevent. It is always cleared in `finally`, so it cannot keep
 * the process alive either.
 *
 * @template T
 * @param {Promise<T>|PromiseLike<T>} promise Work to bound.
 * @param {number} ms Budget in milliseconds; a non-positive or non-finite budget means "no deadline".
 * @param {() => Error} onTimeout Factory for the rejection reason. A factory, not a value, so the
 *   error's stack is captured at the moment of failure.
 * @returns {Promise<T>} The result, or a rejection from `onTimeout()`.
 */
export async function withDeadline(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  try {
    return await Promise.race([
      promise,
      /** @type {Promise<never>} */ (
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(onTimeout()), ms);
        })
      ),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Promise-returning sleep. Injectable so tests can drive backoff without real delay.
 *
 * @param {number} ms Milliseconds to wait.
 * @returns {Promise<void>} Resolves after `ms`.
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Full-jitter exponential backoff, per the AWS Architecture Blog's "Exponential Backoff And Jitter".
 *
 * Full jitter (`random() * capped`) rather than the more obvious `capped/2 + random()*capped/2`
 * because full jitter minimises contention when many clients retry against the same upstream - and
 * a rate-limited pinning service is exactly that situation.
 *
 * @param {number} attempt Zero-based attempt number.
 * @param {object} [options] Options.
 * @param {number} [options.baseMs] Delay for attempt 0 before jitter.
 * @param {number} [options.maxMs] Ceiling before jitter.
 * @param {() => number} [options.random] Source of randomness; injectable for deterministic tests.
 * @returns {number} Delay in milliseconds.
 */
export function backoffDelay(attempt, { baseMs = 250, maxMs = 8000, random = Math.random } = {}) {
  const capped = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(random() * capped);
}
