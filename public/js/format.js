/**
 * NeuroMesh — presentation-layer formatters and small statistics helpers.
 *
 * Every function in the first two thirds of this file is PURE: same input,
 * same output, no DOM, no `Date.now()` unless it is passed in. That is
 * deliberate — this is the module the frontend unit tests exercise under
 * node:test with no jsdom.
 *
 * The one exception is `copyToClipboard`, at the bottom, which is grouped here
 * because it is the string-handling counterpart to the truncators: every place
 * that shows a truncated hash also offers to copy the full one.
 *
 * Rules this module encodes, all of them fixes for audited defects:
 *   - There is exactly one "no value" glyph: EM DASH. `avg()` returning the
 *     string 'N/A' so the caller could concatenate ' ms' and render 'N/A ms'
 *     is the bug this replaces. Non-finite input NEVER produces a unit suffix.
 *   - Latency is summarised with `summarize()` (p50/p95/p99), never a bare
 *     mean. The repo's own chain latencies are [16190, 21288, 7033, ...]; the
 *     arithmetic mean of that distribution is actively misleading.
 *   - Signed similarity values use U+2212 MINUS SIGN, not HYPHEN-MINUS, so a
 *     column of `tabular-nums` values aligns.
 *
 * @module format
 */

/** The single placeholder for "no value". Never render an empty cell. */
export const EMPTY = '—';

/** U+2212. Same advance width as `+` in a tabular-figures font; `-` is not. */
const MINUS = '−';

/* ==================================================================== *
 * Identifier truncation
 * ==================================================================== */

/**
 * Shorten a long opaque identifier, keeping both ends so it stays verifiable
 * by eye. Returns the input untouched when truncating would not save
 * anything, so short strings never gain a pointless ellipsis.
 *
 * @param {string | null | undefined} value
 * @param {number} [head] characters kept at the start
 * @param {number} [tail] characters kept at the end
 * @returns {string} the truncated value, or EMPTY when there is nothing to show
 */
export function truncateMiddle(value, head = 6, tail = 4) {
  if (typeof value !== 'string') return EMPTY;
  const str = value.trim();
  if (str === '') return EMPTY;
  const h = Math.max(0, head);
  const t = Math.max(0, tail);
  if (str.length <= h + t + 1) return str;
  return str.slice(0, h) + '…' + str.slice(str.length - t);
}

/**
 * `0x35Be…EEab`. The full value belongs in a `title` / `aria-label`, which is
 * the caller's job — this function only produces the visible glyphs.
 *
 * @param {string | null | undefined} address
 * @returns {string}
 */
export function formatAddress(address) {
  return truncateMiddle(address, 6, 4);
}

/**
 * IPFS CIDs are longer and their prefix (`bafy…`, `Qm…`) carries meaning, so
 * they keep more head characters than an address does.
 *
 * @param {string | null | undefined} cid
 * @returns {string}
 */
export function formatCid(cid) {
  return truncateMiddle(cid, 8, 6);
}

/** Spelling alias — some call sites read better as `formatCID`. */
export const formatCID = formatCid;

/**
 * Transaction hashes are 66 characters; 10/8 keeps enough to match against a
 * block explorer at a glance.
 *
 * @param {string | null | undefined} hash
 * @returns {string}
 */
export function formatTxHash(hash) {
  return truncateMiddle(hash, 10, 8);
}

/* ==================================================================== *
 * Numbers
 * ==================================================================== */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Locale-grouped number. Non-finite input yields EMPTY — never `NaN`.
 *
 * @param {number | null | undefined} value
 * @param {number} [maxFractionDigits]
 * @returns {string}
 */
export function formatNumber(value, maxFractionDigits = 2) {
  if (!isFiniteNumber(value)) return EMPTY;
  try {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: maxFractionDigits,
    }).format(value);
  } catch {
    return String(value);
  }
}

/**
 * @param {number | null | undefined} value ratio in 0..1 (not 0..100)
 * @param {number} [fractionDigits]
 * @returns {string} e.g. `92.4%`
 */
export function formatPercent(value, fractionDigits = 1) {
  if (!isFiniteNumber(value)) return EMPTY;
  return (value * 100).toFixed(fractionDigits) + '%';
}

/**
 * Cosine similarity is SIGNED and is compared column-wise, so it is rendered
 * at fixed width with an explicit sign and a real minus glyph.
 *
 * @param {number | null | undefined} value
 * @returns {string} e.g. `+0.1081`, `−0.0042`
 */
export function formatSimilarity(value) {
  if (!isFiniteNumber(value)) return EMPTY;
  const sign = value < 0 ? MINUS : '+';
  return sign + Math.abs(value).toFixed(4);
}

/**
 * Binary units, because these are payload sizes reported by the node.
 *
 * @param {number | null | undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!isFiniteNumber(bytes) || bytes < 0) return EMPTY;
  if (bytes < 1024) return bytes + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value.toFixed(1) + ' ' + units[unit];
}

/**
 * Latency with a unit that scales, so a 9 ms embedding and a 21 s chain
 * confirmation are both readable in the same column.
 *
 * @param {number | null | undefined} ms
 * @returns {string} `842 ms` | `19.2 s` | `2 m 04 s`
 */
export function formatMs(ms) {
  if (!isFiniteNumber(ms) || ms < 0) return EMPTY;
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + ' m ' + String(seconds).padStart(2, '0') + ' s';
}

/**
 * Process uptime. Sheds units that are zero from the left only, so `12m 03s`
 * and `3d 04h 12m` are both produced by the same rule.
 *
 * @param {number | null | undefined} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  if (!isFiniteNumber(seconds) || seconds < 0) return EMPTY;
  const total = Math.floor(seconds);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return d + 'd ' + pad2(h) + 'h ' + pad2(m) + 'm';
  if (h > 0) return h + 'h ' + pad2(m) + 'm ' + pad2(s) + 's';
  if (m > 0) return m + 'm ' + pad2(s) + 's';
  return s + 's';
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(value, lo, hi) {
  if (!isFiniteNumber(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * @param {number} a
 * @param {number} b
 * @param {number} t
 * @returns {number}
 */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
export function pluralize(count, one, many) {
  return count === 1 ? one : many;
}

/* ==================================================================== *
 * Time
 * ==================================================================== */

/**
 * Accepts an ISO string, an epoch-millisecond number, or a Date.
 *
 * @param {string | number | Date | null | undefined} value
 * @returns {Date | null} null when the value cannot be parsed
 */
export function toDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Absolute local time. Deliberately medium/short: the console is operated by
 * one person looking at one node, so the year matters and the seconds do not.
 *
 * @param {string | number | Date | null | undefined} value
 * @returns {string}
 */
export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return EMPTY;
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Full precision, for a `title` attribute beside a relative time.
 *
 * @param {string | number | Date | null | undefined} value
 * @returns {string}
 */
export function formatIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : EMPTY;
}

/** Largest-first, so the first unit whose span fits is the one used. */
const RELATIVE_UNITS = /** @type {const} */ ([
  ['year', 31536000000],
  ['month', 2592000000],
  ['week', 604800000],
  ['day', 86400000],
  ['hour', 3600000],
  ['minute', 60000],
  ['second', 1000],
]);

/**
 * `3 minutes ago` / `in 2 hours`. Future timestamps are supported because a
 * node with a skewed clock will produce them and a broken render is worse
 * than an odd-looking one.
 *
 * @param {string | number | Date | null | undefined} value
 * @param {number} [now] epoch ms, injectable so tests are deterministic
 * @returns {string}
 */
export function formatRelative(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return EMPTY;
  const deltaMs = date.getTime() - now;
  const absMs = Math.abs(deltaMs);
  if (absMs < 5000) return 'just now';

  for (const [unit, span] of RELATIVE_UNITS) {
    if (absMs >= span || unit === 'second') {
      const amount = Math.round(deltaMs / span);
      try {
        return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, unit);
      } catch {
        const magnitude = Math.abs(amount);
        const label = magnitude + ' ' + unit + (magnitude === 1 ? '' : 's');
        return deltaMs < 0 ? label + ' ago' : 'in ' + label;
      }
    }
  }
  return EMPTY;
}

/* ==================================================================== *
 * Statistics
 *
 * These exist so that no view ever renders a bare arithmetic mean of a
 * latency distribution again.
 * ==================================================================== */

/**
 * Linear-interpolated quantile (the "R-7" / Excel PERCENTILE definition).
 * Copies before sorting, drops non-finite entries.
 *
 * @param {readonly number[] | null | undefined} values
 * @param {number} p in 0..1
 * @returns {number} NaN for an empty or fully non-finite input
 */
export function quantile(values, p) {
  if (!Array.isArray(values)) return NaN;
  const sorted = values.filter(isFiniteNumber).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const position = (n - 1) * clamp(p, 0, 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return lerp(sorted[lower], sorted[upper], position - lower);
}

/**
 * @typedef {object} Summary
 * @property {number} count number of finite samples
 * @property {number} mean
 * @property {number} min
 * @property {number} max
 * @property {number} p50
 * @property {number} p95
 * @property {number} p99
 */

/**
 * The single interpretation point for any latency array in the app. Every
 * field is NaN for empty input, which `formatMs` renders as EMPTY — callers
 * must not special-case it with their own placeholder string.
 *
 * @param {readonly number[] | null | undefined} values
 * @returns {Summary}
 */
export function summarize(values) {
  const finite = Array.isArray(values) ? values.filter(isFiniteNumber) : [];
  const count = finite.length;
  if (count === 0) {
    return { count: 0, mean: NaN, min: NaN, max: NaN, p50: NaN, p95: NaN, p99: NaN };
  }
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const value of finite) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return {
    count,
    mean: sum / count,
    min,
    max,
    p50: quantile(finite, 0.5),
    p95: quantile(finite, 0.95),
    p99: quantile(finite, 0.99),
  };
}

/**
 * "Nice" round axis ticks using the 1 / 2 / 5 x 10^n ladder.
 *
 * @param {number} min
 * @param {number} max
 * @param {number} [count] desired tick count (approximate, by design)
 * @returns {number[]} ascending ticks spanning [min, max]
 */
export function niceTicks(min, max, count = 5) {
  if (!isFiniteNumber(min) || !isFiniteNumber(max)) return [];
  if (min === max) return [min];
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const rawStep = (hi - lo) / Math.max(1, count);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  // The epsilon keeps floating-point drift from dropping the final tick.
  for (let value = start; value <= hi + step * 1e-9; value += step) {
    // Re-round each tick: repeated addition of 0.1 does not stay on 0.1.
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}

/**
 * Map a value onto an integer colour bin, clamped so out-of-range data can
 * never index past the end of a palette.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @param {number} bins
 * @returns {number} 0..bins-1
 */
export function bucketIndex(value, min, max, bins) {
  const n = Math.max(1, Math.floor(bins));
  if (!isFiniteNumber(value) || max === min) return 0;
  const ratio = (value - min) / (max - min);
  return Math.round(clamp(Math.floor(ratio * n), 0, n - 1));
}

/* ==================================================================== *
 * Function timing
 * ==================================================================== */

/**
 * Trailing-edge debounce. The returned function carries `.cancel()` so a view
 * can drop a pending call during unmount instead of firing into a dead DOM.
 *
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} ms
 * @returns {F & { cancel: () => void }}
 */
export function debounce(fn, ms) {
  /** @type {number | undefined} */
  let timer;
  /**
   * @type {any}
   * @this {unknown} preserved so a debounced method keeps its receiver
   */
  const wrapped = function (...args) {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = undefined;
      fn.apply(this, args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  };
  return wrapped;
}

/**
 * Leading-edge throttle with a trailing call, so the last event in a burst is
 * never lost (which matters for resize-driven chart redraws).
 *
 * @template {(...args: any[]) => void} F
 * @param {F} fn
 * @param {number} ms
 * @returns {F & { cancel: () => void }}
 */
export function throttle(fn, ms) {
  let last = 0;
  /** @type {number | undefined} */
  let timer;
  /** @type {any[] | null} */
  let pendingArgs = null;

  /**
   * @type {any}
   * @this {unknown} preserved so a throttled method keeps its receiver
   */
  const wrapped = function (...args) {
    const now = Date.now();
    /** @type {unknown} */
    const self = this;
    const remaining = ms - (now - last);
    if (remaining <= 0) {
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      last = now;
      fn.apply(self, args);
      return;
    }
    pendingArgs = args;
    if (timer === undefined) {
      timer = window.setTimeout(() => {
        timer = undefined;
        last = Date.now();
        const queued = pendingArgs;
        pendingArgs = null;
        if (queued) fn.apply(self, queued);
      }, remaining);
    }
  };
  wrapped.cancel = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    pendingArgs = null;
  };
  return wrapped;
}

/* ==================================================================== *
 * Explorer links
 * ==================================================================== */

/**
 * Returns null when the node has not reported an explorer base URL, so the
 * caller renders plain text rather than a dead link. Never guesses a chain.
 *
 * @param {string | null | undefined} baseUrl
 * @param {string | null | undefined} txHash
 * @returns {string | null}
 */
export function explorerTxUrl(baseUrl, txHash) {
  return explorerUrl(baseUrl, 'tx', txHash);
}

/**
 * @param {string | null | undefined} baseUrl
 * @param {string | null | undefined} address
 * @returns {string | null}
 */
export function explorerAddressUrl(baseUrl, address) {
  return explorerUrl(baseUrl, 'address', address);
}

/**
 * @param {string | null | undefined} baseUrl
 * @param {string} kind
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
function explorerUrl(baseUrl, kind, value) {
  if (typeof baseUrl !== 'string' || baseUrl === '') return null;
  if (typeof value !== 'string' || value === '') return null;
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return base + '/' + kind + '/' + encodeURIComponent(value);
}

/* ==================================================================== *
 * Clipboard
 *
 * The only impure function in this module. It resolves to a boolean instead
 * of rejecting, because every call site wants the same thing: show a "Copied"
 * confirmation, or show a "Press Ctrl+C" fallback. Neither is an exception.
 * ==================================================================== */

/**
 * @param {string} value
 * @returns {Promise<boolean>} true when the value reached the clipboard
 */
export async function copyToClipboard(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text === '') return false;

  // The async Clipboard API requires a secure context (https or localhost)
  // AND a user gesture. Both hold for a button click on a served page.
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, or the document lost focus mid-write. Fall through.
    }
  }
  return legacyCopy(text);
}

/**
 * `document.execCommand('copy')` fallback for insecure origins (a node served
 * over plain http on a LAN address is a realistic deployment).
 *
 * The scratch element is a textarea with its VALUE set — never markup — and it
 * is removed in a finally block so a thrown selection error cannot leave it in
 * the document.
 *
 * @param {string} text
 * @returns {boolean}
 */
function legacyCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.tabIndex = -1;
  // Off-screen rather than display:none — a hidden element cannot be selected.
  area.style.setProperty('position', 'fixed');
  area.style.setProperty('inset-block-start', '-9999px');
  area.style.setProperty('opacity', '0');

  const previouslyFocused = document.activeElement;
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
  }
}
