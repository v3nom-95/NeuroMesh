/**
 * NeuroMesh — hash router bound to the ARIA tablist.
 *
 * This replaces `switchTab()` and the two `onclick="switchTab('node-view')"`
 * attributes. Those attributes were not merely a CSP problem: `switchTab`
 * re-derived the active button with
 * `document.querySelector('button[onclick="switchTab(\'' + id + '\')"]')`,
 * so the handler STRING was load-bearing markup and changing its quoting
 * silently broke the active-state highlight.
 *
 * What this module owns:
 *   - the tab widget: `aria-selected`, roving `tabindex`, arrow/Home/End keys
 *   - panel visibility via the `hidden` PROPERTY (never a `.hidden` class,
 *     which validators and some assistive tech do not honour)
 *   - the URL: `#/overview` … `#/system`, with Back/Forward working
 *   - `document.title`
 *   - the mount/unmount handshake, which is what gives a view the chance to
 *     abort its in-flight requests before its panel is hidden. The old code
 *     refetched the whole simulation payload on every switch, with no abort,
 *     so two fast toggles raced two renders into the same containers.
 *
 * Keyboard model: MANUAL activation. Arrow keys move focus between tabs but
 * do not switch views; Enter or Space (native `<button>` behaviour) commits.
 * This is the WCAG-preferred pattern whenever revealing a panel starts network
 * work — automatic activation would fire five requests while the user arrows
 * past four tabs to reach the fifth.
 *
 * Shortcut ownership, so phases do not collide: this module binds ONLY the
 * digits 1-5. `t` belongs to theme.js; `r`, `/` and `?` belong to main.js.
 *
 * @module router
 */

import { announce, on, qsa } from './dom.js';
import { getSetting, setSetting } from './settings.js';

/** Canonical view order. Must match the tab order in index.html. */
export const VIEWS = Object.freeze(['overview', 'memory', 'semantic', 'reputation', 'system']);

/** @typedef {(typeof VIEWS)[number]} ViewSlug */

/** Used for `document.title` and for the live-region announcement. */
export const VIEW_TITLES = Object.freeze({
  overview: 'Overview',
  memory: 'Memory',
  semantic: 'Semantic',
  reputation: 'Reputation',
  system: 'System',
});

/** Below this width layout.css turns the rail into a bottom tab bar. */
/**
 * Ring applied by JS when focus is moved programmatically. Defined in
 * base.css; see focusPanel() for why the UA cannot supply it.
 */
const FOCUS_RING_CLASS = 'js-focus-ring-force';

const HORIZONTAL_QUERY = '(max-width: 60rem)';

/**
 * @param {unknown} value
 * @returns {value is ViewSlug}
 */
export function isView(value) {
  return typeof value === 'string' && VIEWS.includes(/** @type {ViewSlug} */ (value));
}

/**
 * Parse a location hash into a view slug. Accepts `#/memory`, `#memory` and
 * `#/memory?x=1`, and returns null for anything unrecognised — an unknown
 * route must not silently render the first view at a URL that does not name it.
 *
 * @param {string} hash
 * @returns {ViewSlug | null}
 */
export function parseHash(hash) {
  if (typeof hash !== 'string' || hash === '') return null;
  const slug = hash.replace(/^#\/?/, '').split(/[?&]/)[0].trim().toLowerCase();
  return isView(slug) ? slug : null;
}

/**
 * @typedef {object} RouterOptions
 * @property {HTMLElement | null} [tablistEl] defaults to `#view-tabs`
 * @property {(view: ViewSlug, context: { panel: HTMLElement, mount: HTMLElement | null }) => void} [onEnter]
 * @property {(view: ViewSlug) => void} [onLeave] the place to abort in-flight requests
 * @property {boolean} [persist] remember the last view across visits
 * @property {boolean} [shortcuts] bind the 1-5 jump keys
 */

/**
 * @typedef {object} Router
 * @property {(view: string, options?: { focus?: boolean, replace?: boolean, force?: boolean }) => ViewSlug} go
 * @property {() => ViewSlug} current
 * @property {() => void} start resolve the initial route and mount the first view
 * @property {() => void} destroy
 */

/**
 * @param {RouterOptions} [options]
 * @returns {Router}
 */
export function createRouter(options = {}) {
  const tablist =
    options.tablistEl ?? /** @type {HTMLElement | null} */ (document.getElementById('view-tabs'));
  const persist = options.persist !== false;
  const wantShortcuts = options.shortcuts !== false;

  /** @type {HTMLElement[]} */
  const tabs = tablist
    ? /** @type {HTMLElement[]} */ (qsa('[role="tab"]', tablist).filter(isHtmlElement))
    : [];

  /** @type {Map<ViewSlug, { tab: HTMLElement, panel: HTMLElement, mount: HTMLElement | null }>} */
  const entries = new Map();

  for (const tab of tabs) {
    const slug = tab.dataset.view;
    if (!isView(slug)) {
      console.warn('[router] tab with unknown data-view ignored:', slug);
      continue;
    }
    const panelId = tab.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    if (!panel) {
      console.warn('[router] tab "' + slug + '" has no panel for aria-controls', panelId);
      continue;
    }
    entries.set(slug, {
      tab,
      panel,
      mount: /** @type {HTMLElement | null} */ (panel.querySelector('.view__mount')),
    });
  }

  /** @type {ViewSlug} */
  let currentView = VIEWS[0];
  let started = false;

  /** @type {(() => void)[]} */
  const teardown = [];

  /** @type {MediaQueryList | null} */
  let horizontalQuery = null;
  try {
    horizontalQuery = window.matchMedia(HORIZONTAL_QUERY);
  } catch {
    horizontalQuery = null;
  }

  /**
   * The tablist is vertical as a sidebar rail and horizontal as a bottom bar.
   * Getting this wrong is not cosmetic: a screen-reader user is told which
   * arrow keys to press by `aria-orientation`.
   *
   * @returns {'vertical' | 'horizontal'}
   */
  function orientation() {
    return horizontalQuery && horizontalQuery.matches ? 'horizontal' : 'vertical';
  }

  /**
   * @returns {void}
   */
  function syncOrientation() {
    if (tablist) tablist.setAttribute('aria-orientation', orientation());
  }

  /* ---------------------------------------------------------------- *
   * Navigation
   * ---------------------------------------------------------------- */

  /**
   * Switch views.
   *
   * @param {string} view
   * @param {{ focus?: boolean, replace?: boolean, force?: boolean }} [navOptions]
   * @returns {ViewSlug} the view actually shown
   */
  function go(view, navOptions = {}) {
    // Unknown route: fall back rather than render nothing, and REPLACE the URL
    // so Back does not bounce the user through a route that does not exist.
    const next = isView(view) ? view : VIEWS[0];
    const replace = navOptions.replace === true || next !== view;

    if (next === currentView && started && navOptions.force !== true) {
      writeHash(next, true);
      if (navOptions.focus) focusPanel(next);
      return next;
    }

    const previous = currentView;
    const target = entries.get(next);
    if (!target) {
      console.warn('[router] no panel registered for view', next);
      return currentView;
    }

    // Tear down first: a view must be able to abort its requests BEFORE its
    // panel is hidden, so a late response cannot render into a hidden panel.
    if (started && previous !== next && options.onLeave) {
      try {
        options.onLeave(previous);
      } catch (error) {
        console.error('[router] onLeave failed for "' + previous + '"', error);
      }
    }

    currentView = next;

    for (const [slug, entry] of entries) {
      const selected = slug === next;
      entry.tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      // Roving tabindex: exactly one tab is in the tab order at any time.
      entry.tab.tabIndex = selected ? 0 : -1;
      entry.panel.hidden = !selected;
    }

    writeHash(next, replace);
    document.title = VIEW_TITLES[next] + ' · NeuroMesh';
    if (persist) setSetting('lastView', next);

    if (options.onEnter) {
      try {
        options.onEnter(next, { panel: target.panel, mount: target.mount });
      } catch (error) {
        console.error('[router] onEnter failed for "' + next + '"', error);
      }
    }

    announce(VIEW_TITLES[next] + ' view');
    if (navOptions.focus) focusPanel(next);
    started = true;
    return next;
  }

  /**
   * Keep the URL in step without ever pushing a duplicate history entry —
   * that is what makes a single Back press leave the console instead of
   * cycling through the same view twice.
   *
   * @param {ViewSlug} view
   * @param {boolean} replace
   * @returns {void}
   */
  function writeHash(view, replace) {
    const hash = '#/' + view;
    if (window.location.hash === hash) return;
    const url = window.location.pathname + window.location.search + hash;
    try {
      if (replace) window.history.replaceState({ view }, '', url);
      else window.history.pushState({ view }, '', url);
    } catch {
      // A sandboxed or file:// context rejects history writes. The view still
      // switched; only the address bar is out of step.
      window.location.hash = hash;
    }
  }

  /**
   * Move focus into the newly revealed panel.
   *
   * Preference order: the panel's own heading (so a screen reader reads the
   * section name and the user lands at the top of the content), then the panel
   * itself, which carries `tabindex="0"` in the markup.
   *
   * The heading gets a TEMPORARY `tabindex="-1"`, removed on blur, because a
   * permanently focusable heading is announced as interactive when it is not.
   *
   * @param {ViewSlug} view
   * @returns {void}
   */
  function focusPanel(view) {
    const entry = entries.get(view);
    if (!entry) return;
    const heading = /** @type {HTMLElement | null} */ (
      entry.panel.querySelector('h2, [data-view-heading]')
    );
    const target = heading ?? entry.panel;
    const addedTabindex = !target.hasAttribute('tabindex');
    if (addedTabindex) target.setAttribute('tabindex', '-1');

    // A programmatic .focus() on a tabindex="-1" container does not match
    // :focus-visible, so the UA paints no ring and a sighted keyboard user
    // loses the caret entirely on a view change. base.css defines
    // .js-focus-ring-force for exactly this case; applying it is what makes
    // the move visible (WCAG 2.4.7). Removed again on blur so the ring never
    // outlives the focus it describes.
    target.classList.add(FOCUS_RING_CLASS);
    target.addEventListener(
      'blur',
      () => {
        target.classList.remove(FOCUS_RING_CLASS);
        if (addedTabindex) target.removeAttribute('tabindex');
      },
      { once: true },
    );

    target.focus({ preventScroll: false });
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  for (const [slug, entry] of entries) {
    teardown.push(
      on(entry.tab, 'click', (event) => {
        event.preventDefault();
        go(slug, { focus: false });
      }),
    );
  }

  if (tablist) {
    teardown.push(on(tablist, 'keydown', onTablistKeydown));
    syncOrientation();
  }

  if (horizontalQuery && typeof horizontalQuery.addEventListener === 'function') {
    const onQueryChange = () => syncOrientation();
    horizontalQuery.addEventListener('change', onQueryChange);
    teardown.push(() => horizontalQuery?.removeEventListener('change', onQueryChange));
  }

  /**
   * Roving focus. Movement does NOT activate — see the manual-activation note
   * in the module header.
   *
   * @param {Event} event
   * @returns {void}
   */
  function onTablistKeydown(event) {
    const keyEvent = /** @type {KeyboardEvent} */ (event);
    const order = Array.from(entries.values()).map((entry) => entry.tab);
    if (order.length === 0) return;
    const index = order.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (index === -1) return;

    const isHorizontal = orientation() === 'horizontal';
    // In RTL the physical arrow keys swap meaning; `dir` is the authority.
    const rtl = document.documentElement.getAttribute('dir') === 'rtl';
    const nextKey = isHorizontal ? (rtl ? 'ArrowLeft' : 'ArrowRight') : 'ArrowDown';
    const prevKey = isHorizontal ? (rtl ? 'ArrowRight' : 'ArrowLeft') : 'ArrowUp';

    /** @type {number | null} */
    let target = null;
    if (keyEvent.key === nextKey) target = (index + 1) % order.length;
    else if (keyEvent.key === prevKey) target = (index - 1 + order.length) % order.length;
    else if (keyEvent.key === 'Home') target = 0;
    else if (keyEvent.key === 'End') target = order.length - 1;
    if (target === null) return;

    keyEvent.preventDefault();
    const tab = order[target];
    // The roving tabindex must follow focus, or Tab out and back returns to
    // the previously selected tab instead of the one the user arrowed to.
    for (const candidate of order) candidate.tabIndex = candidate === tab ? 0 : -1;
    tab.focus();
  }

  /**
   * Digits 1-5 jump straight to a view. Ignored while typing, and ignored
   * with any modifier so browser shortcuts (Ctrl+1 = first tab) still work.
   *
   * @param {KeyboardEvent} event
   * @returns {void}
   */
  function onShortcut(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    if (isTypingTarget(event.target)) return;
    const index = Number.parseInt(event.key, 10);
    if (!Number.isInteger(index) || index < 1 || index > VIEWS.length) return;
    event.preventDefault();
    go(VIEWS[index - 1], { focus: true });
  }

  if (wantShortcuts) {
    teardown.push(on(document, 'keydown', /** @type {EventListener} */ (onShortcut)));
  }

  /** Back/Forward, and a hash typed directly into the address bar. */
  const onLocationChange = () => {
    const fromHash = parseHash(window.location.hash);
    if (fromHash && fromHash !== currentView) go(fromHash, { replace: true });
    else if (!fromHash) go(currentView, { replace: true });
  };
  teardown.push(on(window, 'popstate', onLocationChange));
  teardown.push(on(window, 'hashchange', onLocationChange));

  /* ---------------------------------------------------------------- *
   * Public surface
   * ---------------------------------------------------------------- */

  return {
    go,
    current: () => currentView,

    /**
     * Resolve the initial route and mount the first view. Called LAST by
     * main.js, so the first `onEnter` runs after global state exists.
     *
     * Resolution order: the URL wins (a shared link must land where it says),
     * then the remembered last view, then the first view.
     *
     * @returns {void}
     */
    start() {
      const fromHash = parseHash(window.location.hash);
      const remembered = persist ? getSetting('lastView') : null;
      const initial = fromHash ?? (isView(remembered) ? remembered : VIEWS[0]);
      // replace, never push: the initial route must not create a history entry
      // the user has to press Back through to leave the page.
      go(initial, { replace: true, force: true });
    },

    destroy() {
      for (const off of teardown) off();
      teardown.length = 0;
      started = false;
    },
  };
}

/**
 * @param {Element} node
 * @returns {node is HTMLElement}
 */
function isHtmlElement(node) {
  return node instanceof HTMLElement;
}

/**
 * True when a keystroke means "the letter", not "the shortcut".
 *
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
