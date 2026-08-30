/**
 * NeuroMesh — operator-local settings, persisted in `localStorage`.
 *
 * Scope: things that belong to THIS browser on THIS machine and must never be
 * sent to the node as configuration — the write API key, how often to poll,
 * how many rows a page holds, UI density, and the last view visited.
 *
 * Three rules the whole module is built around:
 *
 * 1. STORAGE MAY THROW, not merely return null. In a Safari private window and
 *    anywhere site data is blocked, touching `window.localStorage` raises a
 *    SecurityError. Every access here is wrapped, and a failure downgrades to
 *    a process-lifetime in-memory map rather than breaking boot.
 * 2. READS GO THROUGH TO STORAGE. There is no cached snapshot to fall out of
 *    step with `js/theme.js`, which owns the `neuromesh.theme` key and writes
 *    it directly. A read-through design makes the two modules agree for free,
 *    and makes another tab's change visible after a `storage` event.
 * 3. THE API KEY IS A SECRET. It is never logged, never placed in a URL, never
 *    put in a change event payload, and never rendered unmasked. Anything that
 *    wants to print settings must run them through `redactSettings()`.
 *
 * @module settings
 */

/** Every key this app is allowed to occupy in localStorage. */
export const STORAGE_KEYS = Object.freeze({
  /** Owned and written by js/theme.js; mirrored here for the settings dialog. */
  theme: 'neuromesh.theme',
  apiKey: 'neuromesh.apiKey',
  pollIntervalMs: 'neuromesh.pollIntervalMs',
  pageSize: 'neuromesh.pageSize',
  density: 'neuromesh.density',
  lastView: 'neuromesh.lastView',
});

/**
 * @typedef {object} Settings
 * @property {'system' | 'light' | 'dark'} theme
 * @property {string} apiKey the raw key — treat as a secret at every call site
 * @property {number} pollIntervalMs status poll cadence
 * @property {number} pageSize memory-explorer page size
 * @property {'comfortable' | 'compact'} density
 * @property {string} lastView view slug restored on the next visit
 */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'system',
  apiKey: '',
  pollIntervalMs: 5000,
  pageSize: 20,
  density: 'comfortable',
  lastView: 'overview',
});

/** Bounds are enforced on write AND on read: storage is user-editable. */
const LIMITS = Object.freeze({
  pollIntervalMs: { min: 1000, max: 300000 },
  pageSize: { min: 5, max: 100 },
});

const THEMES = ['system', 'light', 'dark'];
const DENSITIES = ['comfortable', 'compact'];

/**
 * Fallback store used only when `localStorage` is unavailable. Values survive
 * for the life of the page, which is enough for the API key to work during a
 * single session in a locked-down browser.
 * @type {Map<string, string>}
 */
const memoryStore = new Map();

/** Latched after the first failure so we do not re-enter a throwing accessor. */
let storageWorks = /** @type {boolean | null} */ (null);

/** @type {Set<(settings: Readonly<Settings>, changedKeys: Set<keyof Settings>) => void>} */
const listeners = new Set();

/* ==================================================================== *
 * Storage primitives — nothing below this line may throw
 * ==================================================================== */

/**
 * @returns {Storage | null}
 */
function storage() {
  if (storageWorks === false) return null;
  try {
    const store = window.localStorage;
    // Touching a property is what actually throws in a blocked context.
    void store.length;
    storageWorks = true;
    return store;
  } catch {
    storageWorks = false;
    return null;
  }
}

/**
 * True when preferences will survive a reload. The settings dialog uses this
 * to warn the operator instead of silently forgetting their API key.
 *
 * @returns {boolean}
 */
export function isPersistent() {
  return storage() !== null;
}

/**
 * @param {string} key
 * @returns {string | null}
 */
function readRaw(key) {
  const store = storage();
  if (!store) return memoryStore.get(key) ?? null;
  try {
    return store.getItem(key);
  } catch {
    return memoryStore.get(key) ?? null;
  }
}

/**
 * @param {string} key
 * @param {string | null} value null removes the entry
 * @returns {void}
 */
function writeRaw(key, value) {
  if (value === null) {
    memoryStore.delete(key);
  } else {
    memoryStore.set(key, value);
  }
  const store = storage();
  if (!store) return;
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Quota exceeded or storage revoked mid-session. The in-memory copy above
    // keeps this page working; the preference just will not survive a reload.
  }
}

/* ==================================================================== *
 * Coercion — storage is untrusted input
 * ==================================================================== */

/**
 * @param {string | null} raw
 * @param {{ min: number, max: number }} bounds
 * @param {number} fallback
 * @returns {number}
 */
function coerceInt(raw, bounds, fallback) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

/**
 * @param {string | null} raw
 * @param {readonly string[]} allowed
 * @param {string} fallback
 * @returns {string}
 */
function coerceEnum(raw, allowed, fallback) {
  return typeof raw === 'string' && allowed.indexOf(raw) !== -1 ? raw : fallback;
}

/* ==================================================================== *
 * Public read API
 * ==================================================================== */

/**
 * The complete, validated settings object. Always safe: every field is present
 * and within range even if storage holds garbage.
 *
 * The returned object CONTAINS THE API KEY. Do not log it; use
 * `redactSettings()` for anything that produces output.
 *
 * @returns {Readonly<Settings>}
 */
export function getSettings() {
  return Object.freeze({
    theme: /** @type {Settings['theme']} */ (
      coerceEnum(readRaw(STORAGE_KEYS.theme), THEMES, DEFAULT_SETTINGS.theme)
    ),
    apiKey: readRaw(STORAGE_KEYS.apiKey) ?? DEFAULT_SETTINGS.apiKey,
    pollIntervalMs: coerceInt(
      readRaw(STORAGE_KEYS.pollIntervalMs),
      LIMITS.pollIntervalMs,
      DEFAULT_SETTINGS.pollIntervalMs,
    ),
    pageSize: coerceInt(readRaw(STORAGE_KEYS.pageSize), LIMITS.pageSize, DEFAULT_SETTINGS.pageSize),
    density: /** @type {Settings['density']} */ (
      coerceEnum(readRaw(STORAGE_KEYS.density), DENSITIES, DEFAULT_SETTINGS.density)
    ),
    lastView: readRaw(STORAGE_KEYS.lastView) ?? DEFAULT_SETTINGS.lastView,
  });
}

/**
 * @template {keyof Settings} K
 * @param {K} key
 * @returns {Settings[K]}
 */
export function getSetting(key) {
  return getSettings()[key];
}

/* ==================================================================== *
 * Public write API
 * ==================================================================== */

/**
 * Apply a partial update. Unknown keys are ignored; values are coerced with
 * the same rules used on read, so an out-of-range poll interval is clamped
 * rather than rejected. Notifies subscribers once, synchronously, and only if
 * something actually changed.
 *
 * @param {Partial<Settings>} patch
 * @returns {Readonly<Settings>} the settings after the update
 */
export function setSettings(patch) {
  const before = getSettings();
  /** @type {Set<keyof Settings>} */
  const changed = new Set();

  if (patch && typeof patch === 'object') {
    if ('theme' in patch) {
      const value = coerceEnum(String(patch.theme), THEMES, DEFAULT_SETTINGS.theme);
      // 'system' is the absence of a preference, which is how theme.js stores it.
      writeRaw(STORAGE_KEYS.theme, value === 'system' ? null : value);
    }
    if ('apiKey' in patch) {
      const value = typeof patch.apiKey === 'string' ? patch.apiKey.trim() : '';
      writeRaw(STORAGE_KEYS.apiKey, value === '' ? null : value);
    }
    if ('pollIntervalMs' in patch) {
      const value = coerceInt(
        String(patch.pollIntervalMs),
        LIMITS.pollIntervalMs,
        DEFAULT_SETTINGS.pollIntervalMs,
      );
      writeRaw(STORAGE_KEYS.pollIntervalMs, String(value));
    }
    if ('pageSize' in patch) {
      const value = coerceInt(String(patch.pageSize), LIMITS.pageSize, DEFAULT_SETTINGS.pageSize);
      writeRaw(STORAGE_KEYS.pageSize, String(value));
    }
    if ('density' in patch) {
      const value = coerceEnum(String(patch.density), DENSITIES, DEFAULT_SETTINGS.density);
      writeRaw(STORAGE_KEYS.density, value);
    }
    if ('lastView' in patch) {
      const value = typeof patch.lastView === 'string' ? patch.lastView : '';
      writeRaw(STORAGE_KEYS.lastView, value === '' ? null : value);
    }
  }

  const after = getSettings();
  for (const key of /** @type {(keyof Settings)[]} */ (Object.keys(after))) {
    if (!Object.is(before[key], after[key])) changed.add(key);
  }
  if (changed.size > 0) emit(after, changed);
  return after;
}

/**
 * @template {keyof Settings} K
 * @param {K} key
 * @param {Settings[K]} value
 * @returns {Readonly<Settings>}
 */
export function setSetting(key, value) {
  return setSettings(/** @type {Partial<Settings>} */ ({ [key]: value }));
}

/**
 * Remove every NeuroMesh key. Used by the settings dialog's "Reset local
 * settings" action; it deliberately clears the API key too.
 *
 * @returns {Readonly<Settings>}
 */
export function resetSettings() {
  const before = getSettings();
  for (const key of Object.values(STORAGE_KEYS)) writeRaw(key, null);
  const after = getSettings();
  /** @type {Set<keyof Settings>} */
  const changed = new Set();
  for (const key of /** @type {(keyof Settings)[]} */ (Object.keys(after))) {
    if (!Object.is(before[key], after[key])) changed.add(key);
  }
  if (changed.size > 0) emit(after, changed);
  return after;
}

/* ==================================================================== *
 * API key — a named surface so grepping for the secret is easy
 * ==================================================================== */

/**
 * @returns {string} the raw key, or '' when none is stored
 */
export function getApiKey() {
  return getSettings().apiKey;
}

/**
 * @returns {boolean}
 */
export function hasApiKey() {
  return getApiKey() !== '';
}

/**
 * @param {string} value
 * @returns {void}
 */
export function setApiKey(value) {
  setSettings({ apiKey: value });
}

/**
 * @returns {void}
 */
export function clearApiKey() {
  setSettings({ apiKey: '' });
}

/* ==================================================================== *
 * Redaction — the only sanctioned way to put a secret near an output
 * ==================================================================== */

/**
 * Mask a secret for display or logging. Reveals a length hint and, optionally,
 * a short suffix so an operator can tell two keys apart without exposing one.
 *
 * @param {string | null | undefined} value
 * @param {{ keepLast?: number }} [options] characters of the tail to reveal
 * @returns {string}
 */
export function redact(value, options) {
  if (typeof value !== 'string' || value === '') return '(not set)';
  const keepLast = Math.max(0, Math.min(4, options?.keepLast ?? 0));
  const hidden = Math.max(1, value.length - keepLast);
  const dots = '•'.repeat(Math.min(hidden, 12));
  const tail = keepLast > 0 ? value.slice(value.length - keepLast) : '';
  return dots + tail + ' (' + value.length + ' chars)';
}

/**
 * A logging-safe copy of the settings. Anything that writes settings to the
 * console, a diagnostics panel, or a bug report must use this — never the
 * object returned by `getSettings()`.
 *
 * @param {Readonly<Settings>} [settings]
 * @returns {Record<string, unknown>}
 */
export function redactSettings(settings) {
  const source = settings ?? getSettings();
  return {
    theme: source.theme,
    apiKey: redact(source.apiKey, { keepLast: 0 }),
    pollIntervalMs: source.pollIntervalMs,
    pageSize: source.pageSize,
    density: source.density,
    lastView: source.lastView,
    persistent: isPersistent(),
  };
}

/* ==================================================================== *
 * Change notification
 * ==================================================================== */

/**
 * @param {Readonly<Settings>} settings
 * @param {Set<keyof Settings>} changedKeys
 * @returns {void}
 */
function emit(settings, changedKeys) {
  // Copy first: a listener is allowed to unsubscribe itself during the pass.
  for (const listener of Array.from(listeners)) {
    try {
      listener(settings, changedKeys);
    } catch (error) {
      console.error('[settings] listener failed', error);
    }
  }
  // A DOM event as well, so modules that do not import settings.js (and the
  // System view's diagnostics panel) can react. The detail carries the CHANGED
  // KEY NAMES ONLY — never the values, because one of them is the API key.
  document.dispatchEvent(
    new CustomEvent('nm:settingschange', { detail: { changed: Array.from(changedKeys) } }),
  );
}

/**
 * @param {(settings: Readonly<Settings>, changedKeys: Set<keyof Settings>) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Mirror changes made in another tab. Without this, opening the settings
 * dialog in a second tab and saving an API key leaves the first tab sending
 * the old one until reload.
 *
 * Called once by main.js; safe to call more than once.
 *
 * @returns {() => void} teardown
 */
export function watchExternalChanges() {
  /** @param {StorageEvent} event */
  const onStorage = (event) => {
    if (event.storageArea !== null && event.storageArea !== window.localStorage) return;

    /** @type {Set<keyof Settings>} */
    const changed = new Set();
    if (event.key === null) {
      // A null key means the whole store was cleared, so treat every field as
      // potentially changed rather than trying to work out which ones were.
      for (const name of /** @type {(keyof Settings)[]} */ (Object.keys(DEFAULT_SETTINGS))) {
        changed.add(name);
      }
    } else {
      for (const [name, storageKey] of Object.entries(STORAGE_KEYS)) {
        if (storageKey === event.key) changed.add(/** @type {keyof Settings} */ (name));
      }
    }

    // Not one of ours: another app shares this origin's storage.
    if (changed.size === 0) return;
    emit(getSettings(), changed);
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}
