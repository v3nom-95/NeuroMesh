/**
 * NeuroMesh — accessible toast notifications.
 *
 * This is the app's entire error surface. The console it replaces had exactly
 * one: `alert("Error committing memory to the real network.")` — modal,
 * unstyled, unkeyboardable by convention, discarding the real error, offering
 * no retry. Everything else failed silently into `console.warn`.
 *
 * Accessibility decisions, and why:
 *
 *   - `role="status"` for info/success/warning, `role="alert"` for errors.
 *     `status` is a polite live region: it waits for a pause in speech.
 *     `alert` is assertive and interrupts, which is correct for a failure the
 *     user must know about before continuing, and wrong for everything else.
 *
 *   - DEVIATION, deliberate: index.html declares the two `#live-*` regions the
 *     only live regions in the app. Toasts are the sanctioned exception —
 *     `role="status"` / `role="alert"` ARE live-region roles, and they are how
 *     assistive technology is expected to encounter a notification. To avoid
 *     the classic double-announcement, this module NEVER also calls
 *     `dom.announce()`; a toast announces itself and nothing else repeats it.
 *
 *   - The content is appended on the frame AFTER the shell is inserted. A live
 *     region that arrives already populated is frequently not announced at
 *     all, because the accessibility tree records no change WITHIN a live
 *     region — only the arrival of one. This two-step is the reliable pattern.
 *
 *   - WCAG 2.2.1 (Enough Time): the auto-dismiss timer PAUSES on hover and on
 *     focus, and resumes on leave/blur, so a toast cannot vanish out from
 *     under someone reading it or tabbing to its action. `persistent: true`
 *     disables the timer entirely, which is what a "node unreachable" notice
 *     uses.
 *
 *   - `dedupeKey` collapses repeats into a counter. A poller flapping against
 *     a dead node produced thirty identical stacked toasts in testing; now it
 *     produces one that reads "x30".
 *
 * @module toast
 */

import { el, clear, on } from './dom.js';
import { ApiError } from './api.js';

/** Tunables. Deliberately local: nothing outside this module needs them. */
const UI = Object.freeze({
  /** Long enough to read a sentence, short enough not to nag. */
  durationMs: 6000,
  /** Errors stay longer — they usually carry an action. */
  errorDurationMs: 10000,
  /** Beyond this the stack becomes a wall; the oldest is evicted. */
  max: 4,
  /** Must match the `--dur-2` transition in components.css. */
  exitMs: 180,
});

/** @typedef {'info' | 'success' | 'warning' | 'error'} ToastVariant */

/**
 * @typedef {object} ToastOptions
 * @property {string} [title] short headline; defaults to the variant name
 * @property {string} [description] secondary line, e.g. an error code
 * @property {number} [durationMs] 0 or `persistent` disables auto-dismiss
 * @property {boolean} [persistent] never auto-dismiss
 * @property {string} [actionLabel] renders a single action button
 * @property {() => void} [onAction] invoked by the action button
 * @property {string} [dedupeKey] collapse repeats into one counted toast
 */

/**
 * @typedef {object} ToastRecord
 * @property {string} id
 * @property {HTMLElement} node
 * @property {HTMLElement} countNode
 * @property {string | null} dedupeKey
 * @property {boolean} persistent
 * @property {number} durationMs
 * @property {number} remainingMs
 * @property {number | undefined} timer
 * @property {number} startedAt
 * @property {number} count
 * @property {(() => void)[]} teardown
 */

/** @type {HTMLElement | null} */
let region = null;

/** @type {Map<string, ToastRecord>} */
const active = new Map();

let sequence = 0;

/** @type {MediaQueryList | null} */
let reducedMotionQuery = null;

/**
 * @returns {boolean}
 */
function prefersReducedMotion() {
  if (reducedMotionQuery) return reducedMotionQuery.matches;
  try {
    reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    return reducedMotionQuery.matches;
  } catch {
    return false;
  }
}

/* ==================================================================== *
 * Lifecycle
 * ==================================================================== */

/**
 * Bind the module to its container. Called once by main.js. Safe to call
 * again — it re-binds and clears whatever was showing.
 *
 * @param {HTMLElement | null} [regionEl] defaults to `#toast-region`
 * @returns {() => void} teardown that removes every toast and unbinds
 */
export function initToasts(regionEl) {
  region = regionEl ?? /** @type {HTMLElement | null} */ (document.getElementById('toast-region'));
  if (region) clear(region);
  active.clear();
  return () => {
    dismissAll();
    region = null;
  };
}

/* ==================================================================== *
 * Node construction — every string goes through dom.js, so a server-supplied
 * error message can never be markup.
 * ==================================================================== */

/** Stroked 24x24 glyph paths, one per variant. Decorative: aria-hidden. */
const ICONS = {
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 8h.01M11 12h1v5h1'],
  success: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'm8.5 12.5 2.5 2.5 4.5-5'],
  warning: ['M12 4 2.8 20h18.4L12 4Z', 'M12 10v4M12 17h.01'],
  error: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'm9 9 6 6M15 9l-6 6'],
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {ToastVariant} variant
 * @returns {SVGElement}
 */
function buildIcon(variant) {
  const svgEl = document.createElementNS(SVG_NS, 'svg');
  for (const [name, value] of Object.entries({
    class: 'icon toast__icon',
    viewBox: '0 0 24 24',
    width: '18',
    height: '18',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  })) {
    svgEl.setAttribute(name, value);
  }
  for (const d of ICONS[variant]) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svgEl.appendChild(path);
  }
  return svgEl;
}

/** Human-readable default headline per variant. */
const DEFAULT_TITLE = {
  info: 'Notice',
  success: 'Done',
  warning: 'Warning',
  error: 'Error',
};

/* ==================================================================== *
 * Core
 * ==================================================================== */

/**
 * @param {ToastVariant} variant
 * @param {string} message
 * @param {ToastOptions} [options]
 * @returns {string} the toast id, usable with `dismiss()`
 */
function show(variant, message, options = {}) {
  if (!region) {
    // Never lose a message because boot order changed.
    region = /** @type {HTMLElement | null} */ (document.getElementById('toast-region'));
    if (!region) {
      console.warn('[toast] no #toast-region; message dropped:', message);
      return '';
    }
  }

  const dedupeKey = options.dedupeKey ?? null;
  if (dedupeKey) {
    const existing = findByDedupeKey(dedupeKey);
    if (existing) {
      bumpCount(existing);
      return existing.id;
    }
  }

  sequence += 1;
  const id = 'toast-' + sequence;
  const persistent = options.persistent === true;
  const durationMs =
    options.durationMs ?? (variant === 'error' ? UI.errorDurationMs : UI.durationMs);

  const countNode = el('span', { class: 'toast__count', hidden: true });

  const body = [
    el('p', { class: 'toast__title' }, options.title ?? DEFAULT_TITLE[variant], countNode),
    message ? el('p', { class: 'toast__message' }, message) : null,
    options.description ? el('p', { class: 'toast__body mono' }, options.description) : null,
  ];

  /** @type {(() => void)[]} */
  const teardown = [];

  const closeButton = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--ghost btn--icon toast__close',
      'aria-label': 'Dismiss notification',
      onClick: () => dismiss(id),
    },
    '×',
  );

  const actionButton =
    options.actionLabel && typeof options.onAction === 'function'
      ? el(
          'button',
          {
            type: 'button',
            class: 'btn btn--secondary toast__action',
            onClick: () => {
              const handler = options.onAction;
              dismiss(id);
              if (handler) handler();
            },
          },
          options.actionLabel,
        )
      : null;

  const node = el('div', {
    class: ['toast', 'toast--' + variant],
    // A live-region role, set on the shell BEFORE any content exists.
    role: variant === 'error' ? 'alert' : 'status',
    'aria-atomic': 'true',
    dataset: { toastId: id, variant },
  });

  region.appendChild(node);

  // Second step: fill it on the next frame so the live region registers a
  // change rather than arriving pre-populated (which often goes unannounced).
  window.requestAnimationFrame(() => {
    if (!node.isConnected) return;
    node.appendChild(buildIcon(variant));
    node.appendChild(el('div', { class: 'toast__content' }, body));
    if (actionButton) node.appendChild(actionButton);
    node.appendChild(closeButton);
    if (!prefersReducedMotion()) node.classList.add('toast--entered');
  });

  /** @type {ToastRecord} */
  const record = {
    id,
    node,
    countNode,
    dedupeKey,
    persistent,
    durationMs,
    remainingMs: durationMs,
    timer: undefined,
    startedAt: 0,
    count: 1,
    teardown,
  };
  active.set(id, record);

  // WCAG 2.2.1: reading or reaching for the action must stop the clock.
  teardown.push(on(node, 'mouseenter', () => pause(record)));
  teardown.push(on(node, 'mouseleave', () => resume(record)));
  teardown.push(on(node, 'focusin', () => pause(record)));
  teardown.push(on(node, 'focusout', () => resume(record)));

  if (!persistent && durationMs > 0) startTimer(record);

  evictOverflow(id);
  return id;
}

/**
 * @param {string} key
 * @returns {ToastRecord | null}
 */
function findByDedupeKey(key) {
  for (const record of active.values()) {
    if (record.dedupeKey === key) return record;
  }
  return null;
}

/**
 * Show "x N" instead of stacking identical toasts, and restart the clock so
 * the newest occurrence still gets its full reading time.
 *
 * @param {ToastRecord} record
 * @returns {void}
 */
function bumpCount(record) {
  record.count += 1;
  record.countNode.textContent = ' ×' + record.count;
  record.countNode.hidden = false;
  record.remainingMs = record.durationMs;
  if (!record.persistent && record.durationMs > 0) startTimer(record);
}

/**
 * @param {ToastRecord} record
 * @returns {void}
 */
function startTimer(record) {
  if (record.timer !== undefined) window.clearTimeout(record.timer);
  record.startedAt = Date.now();
  record.timer = window.setTimeout(() => dismiss(record.id), record.remainingMs);
}

/**
 * @param {ToastRecord} record
 * @returns {void}
 */
function pause(record) {
  if (record.timer === undefined) return;
  window.clearTimeout(record.timer);
  record.timer = undefined;
  record.remainingMs = Math.max(0, record.remainingMs - (Date.now() - record.startedAt));
}

/**
 * @param {ToastRecord} record
 * @returns {void}
 */
function resume(record) {
  if (record.persistent || record.durationMs <= 0) return;
  if (record.timer !== undefined) return;
  // Always leave enough time to finish the sentence after the pointer leaves.
  record.remainingMs = Math.max(record.remainingMs, 1500);
  startTimer(record);
}

/**
 * Keep the stack readable. Persistent toasts are never evicted — they are
 * carrying a condition that is still true.
 *
 * @param {string} exceptId
 * @returns {void}
 */
function evictOverflow(exceptId) {
  while (active.size > UI.max) {
    /** @type {ToastRecord | null} */
    let victim = null;
    for (const record of active.values()) {
      if (record.id !== exceptId && !record.persistent) {
        victim = record;
        break;
      }
    }
    if (!victim) return;
    dismiss(victim.id);
  }
}

/**
 * @param {string} id
 * @returns {void}
 */
export function dismiss(id) {
  const record = active.get(id);
  if (!record) return;
  active.delete(id);

  if (record.timer !== undefined) window.clearTimeout(record.timer);
  for (const off of record.teardown) off();

  // If focus is inside the toast being removed, park it on <body> rather than
  // letting the browser drop it into the void — a lost focus point silently
  // resets keyboard navigation to the top of the document.
  const node = record.node;
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && node.contains(focused)) focused.blur();

  if (prefersReducedMotion()) {
    node.remove();
    return;
  }
  node.classList.add('toast--leaving');
  window.setTimeout(() => node.remove(), UI.exitMs);
}

/**
 * @returns {void}
 */
export function dismissAll() {
  for (const id of Array.from(active.keys())) dismiss(id);
}

/**
 * How many toasts are on screen. Used by the System view's diagnostics.
 * @returns {number}
 */
export function toastCount() {
  return active.size;
}

/* ==================================================================== *
 * Public API
 * ==================================================================== */

export const toast = Object.freeze({
  /**
   * @param {string} message
   * @param {ToastOptions} [options]
   * @returns {string} toast id
   */
  info(message, options) {
    return show('info', message, options);
  },

  /**
   * @param {string} message
   * @param {ToastOptions} [options]
   * @returns {string}
   */
  success(message, options) {
    return show('success', message, options);
  },

  /**
   * @param {string} message
   * @param {ToastOptions} [options]
   * @returns {string}
   */
  warning(message, options) {
    return show('warning', message, options);
  },

  /**
   * Accepts an `ApiError`, any `Error`, or a plain string.
   *
   * For an `ApiError` the headline is `userMessage` (written for a human) and
   * the secondary line carries `code` and the request id (written for an
   * operator reading server logs). A cancelled request produces NOTHING — an
   * aborted fetch is a decision the app made, not a failure to report.
   *
   * The original error object is always mirrored to `console.error` so a
   * stack trace survives even after the toast is dismissed.
   *
   * @param {unknown} error an ApiError, Error, or message string
   * @param {ToastOptions} [options]
   * @returns {string} toast id, or '' when nothing was shown
   */
  error(error, options = {}) {
    if (error instanceof ApiError && error.code === 'aborted') return '';

    console.error('[toast]', error);

    if (error instanceof ApiError) {
      const parts = [error.code];
      if (error.status) parts.push('HTTP ' + error.status);
      if (error.requestId) parts.push(error.requestId);
      return show('error', error.userMessage, {
        description: parts.join(' · '),
        // A retriable failure gets a Retry button whenever the caller supplied
        // something to retry; otherwise it is just a report.
        actionLabel: options.onAction ? (options.actionLabel ?? 'Retry') : undefined,
        // Repeated identical failures collapse instead of stacking.
        dedupeKey: options.dedupeKey ?? 'err:' + error.code,
        ...options,
      });
    }

    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Something went wrong.';
    return show('error', message, options);
  },

  dismiss,
  dismissAll,
  count: toastCount,
});
