/**
 * Theme controller — three states: `system` | `light` | `dark`.
 *
 * Responsibilities:
 *   - read and persist the user's choice in `localStorage['neuromesh.theme']`
 *   - stamp (or remove) `data-theme` on `<html>`, which is what css/tokens.css
 *     keys its explicit-override blocks on
 *   - keep the active `<meta name="theme-color">` in step with `--bg-canvas`
 *   - follow the OS while, and only while, the mode is `system`
 *   - announce changes into the polite live region and emit `nm:themechange`
 *
 * Everything that touches `localStorage` is wrapped in try/catch: the accessor
 * itself throws (not just returns null) in a Safari private window and wherever
 * site data is blocked, and a theme preference is never worth a broken boot.
 *
 * There is no anti-FOUC inline script, because the CSP forbids inline script.
 * None is needed: tokens.css resolves the system palette on first paint, and
 * `data-theme` is only ever a deviation from that default.
 *
 * @module theme
 */

/** localStorage key. Kept here so this module has no import-time dependencies. */
const STORAGE_KEY = 'neuromesh.theme';

/** @typedef {'system' | 'light' | 'dark'} ThemeMode */
/** @typedef {'light' | 'dark'} ResolvedTheme */

/** @type {readonly ThemeMode[]} */
const MODES = ['system', 'light', 'dark'];

/**
 * Browser-chrome colour per resolved theme. These MUST track `--bg-canvas` in
 * css/tokens.css; if that value changes, change it here too.
 * @type {Record<ResolvedTheme, string>}
 */
const THEME_COLOR = {
  light: '#f4f6fb',
  dark: '#050a14',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icon geometry per mode, drawn as stroked paths on a 24x24 grid. */
const ICON_PATHS = {
  light: [
    'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
    'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  ],
  dark: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z'],
  system: [
    'M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 14.5v-9Z',
    'M8 20h8M12 16v4',
  ],
};

/** @type {ThemeMode} */
let currentMode = 'system';

/** @type {HTMLElement | null} */
let toggleButton = null;

/** @type {MediaQueryList | null} */
let darkQuery = null;

/* ------------------------------------------------------------------ *
 * Storage (never allowed to throw out of this module)
 * ------------------------------------------------------------------ */

/**
 * @returns {ThemeMode | null} the persisted mode, or null if absent/invalid/unreadable
 */
function readStoredMode() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {ThemeMode} mode
 * @returns {void}
 */
function writeStoredMode(mode) {
  try {
    if (mode === 'system') {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, mode);
    }
  } catch {
    /* Quota exceeded, private mode, or site data blocked. The theme still
       applies for this page view; it just will not survive a reload. */
  }
}

/**
 * @param {unknown} value
 * @returns {value is ThemeMode}
 */
function isMode(value) {
  return typeof value === 'string' && MODES.indexOf(/** @type {ThemeMode} */ (value)) !== -1;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * The user's chosen mode, which may be `system`.
 * @returns {ThemeMode}
 */
export function getTheme() {
  return currentMode;
}

/**
 * The theme actually being rendered right now, with `system` resolved against
 * the OS preference.
 * @returns {ResolvedTheme}
 */
export function getResolvedTheme() {
  if (currentMode === 'light' || currentMode === 'dark') return currentMode;
  return prefersDark() ? 'dark' : 'light';
}

/**
 * Apply a theme mode: stamp the root element, persist, refresh the toggle
 * button and the browser-chrome colour, announce, and notify listeners.
 *
 * @param {ThemeMode} mode
 * @param {{ announce?: boolean, persist?: boolean }} [options]
 * @returns {void}
 */
export function setTheme(mode, options) {
  const opts = options || {};
  const next = isMode(mode) ? mode : 'system';
  currentMode = next;

  const root = document.documentElement;
  if (next === 'system') {
    // Absence of the attribute is what lets the prefers-color-scheme block win.
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', next);
  }

  if (opts.persist !== false) writeStoredMode(next);

  const resolved = getResolvedTheme();
  updateMetaThemeColor(next, resolved);
  renderToggle(next);

  if (opts.announce) announce('Theme set to ' + next);

  document.dispatchEvent(new CustomEvent('nm:themechange', { detail: { mode: next, resolved } }));
}

/**
 * Advance system -> light -> dark -> system.
 * @returns {ThemeMode} the mode now active
 */
export function cycleTheme() {
  const next = MODES[(MODES.indexOf(currentMode) + 1) % MODES.length];
  setTheme(next, { announce: true });
  return next;
}

/**
 * Boot the controller. Safe to call once, early, before any view renders.
 *
 * @param {HTMLElement | null} [buttonEl] the topbar theme toggle, if present
 * @returns {ThemeMode} the mode that was applied
 */
export function initTheme(buttonEl) {
  toggleButton = buttonEl || null;
  darkQuery = safeMatchMedia('(prefers-color-scheme: dark)');

  // Persisted choice wins; otherwise follow the OS.
  setTheme(readStoredMode() || 'system', { announce: false, persist: false });

  if (toggleButton) {
    toggleButton.addEventListener('click', () => {
      cycleTheme();
    });
  }

  // Only meaningful while the mode is `system`, but the listener is cheap and
  // staying subscribed means switching back to `system` is instantly correct.
  if (darkQuery && typeof darkQuery.addEventListener === 'function') {
    darkQuery.addEventListener('change', () => {
      if (currentMode !== 'system') return;
      const resolved = getResolvedTheme();
      updateMetaThemeColor('system', resolved);
      document.dispatchEvent(
        new CustomEvent('nm:themechange', { detail: { mode: 'system', resolved } }),
      );
    });
  }

  // `t` cycles the theme. This module owns that shortcut; main.js must not
  // bind it again.
  document.addEventListener('keydown', onShortcut);

  return currentMode;
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/**
 * @param {KeyboardEvent} event
 * @returns {void}
 */
function onShortcut(event) {
  if (event.key !== 't' && event.key !== 'T') return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTypingTarget(event.target)) return;
  event.preventDefault();
  cycleTheme();
}

/**
 * True when the event originated inside a control where `t` means the letter t.
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * @returns {boolean}
 */
function prefersDark() {
  if (darkQuery) return darkQuery.matches;
  const query = safeMatchMedia('(prefers-color-scheme: dark)');
  return query ? query.matches : false;
}

/**
 * `matchMedia` is missing in some embedded/headless contexts.
 * @param {string} query
 * @returns {MediaQueryList | null}
 */
function safeMatchMedia(query) {
  try {
    return typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
}

/**
 * Keep the OS/browser chrome in step.
 *
 * The document ships two media-scoped `theme-color` metas so an unscripted page
 * is still correct. A browser uses the FIRST meta whose media query matches, so
 * rather than fighting that with a third tag, an explicit choice simply writes
 * the same colour into both — whichever one matches then yields the right
 * answer. Returning to `system` restores the per-scheme colours.
 *
 * @param {ThemeMode} mode
 * @param {ResolvedTheme} resolved
 * @returns {void}
 */
function updateMetaThemeColor(mode, resolved) {
  const lightMeta = document.getElementById('meta-theme-color-light');
  const darkMeta = document.getElementById('meta-theme-color-dark');
  if (!lightMeta || !darkMeta) return;

  if (mode === 'system') {
    lightMeta.setAttribute('content', THEME_COLOR.light);
    darkMeta.setAttribute('content', THEME_COLOR.dark);
    return;
  }
  const color = THEME_COLOR[resolved];
  lightMeta.setAttribute('content', color);
  darkMeta.setAttribute('content', color);
}

/**
 * Update the toggle's accessible name and swap its icon. Built with
 * createElementNS + setAttribute; nothing here parses a markup string.
 *
 * @param {ThemeMode} mode
 * @returns {void}
 */
function renderToggle(mode) {
  if (!toggleButton) return;

  toggleButton.setAttribute('aria-label', 'Theme: ' + mode);
  toggleButton.setAttribute('title', 'Theme: ' + mode + ' (press t)');
  toggleButton.setAttribute('data-theme-mode', mode);

  const previous = toggleButton.querySelector('[data-theme-icon]');
  const icon = buildIcon(mode);
  if (previous) {
    toggleButton.replaceChild(icon, previous);
  } else {
    toggleButton.appendChild(icon);
  }
}

/**
 * @param {ThemeMode} mode
 * @returns {SVGElement}
 */
function buildIcon(mode) {
  const svg = svgEl('svg', {
    'data-theme-icon': mode,
    class: 'icon',
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
  });
  for (const d of ICON_PATHS[mode]) {
    svg.appendChild(svgEl('path', { d }));
  }
  return svg;
}

/**
 * @param {string} name
 * @param {Record<string, string>} attrs
 * @returns {SVGElement}
 */
function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const key of Object.keys(attrs)) {
    el.setAttribute(key, attrs[key]);
  }
  return el;
}

/**
 * Write into the polite live region. Deliberately a local, dependency-free
 * helper so theme.js can boot before the rest of the app exists; a11y.js
 * provides the general-purpose version for every other module.
 *
 * @param {string} message
 * @returns {void}
 */
function announce(message) {
  const region = document.getElementById('live-polite');
  if (!region) return;
  // Clearing first guarantees a re-announcement when the text repeats.
  region.textContent = '';
  window.setTimeout(() => {
    region.textContent = message;
  }, 50);
}
