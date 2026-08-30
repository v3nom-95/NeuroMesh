/**
 * Entrypoint.
 *
 * Boots the console, owns everything that is global to it, and mounts the five
 * views through the router. Four of its jobs are direct corrections of
 * findings against the console it replaces:
 *
 *   - the status poll is bounded, cancellable, and pauses when nobody is
 *     looking, instead of a recursive `setTimeout` that ran forever;
 *   - an unhandled error or promise rejection becomes a visible toast rather
 *     than a console line nobody reads;
 *   - a node that is unreachable, read-only, still loading its model, or
 *     demanding an API key says so in a banner, instead of rendering blank
 *     panels;
 *   - controls the node cannot honour are gated with `aria-disabled` and an
 *     explanation, keeping them FOCUSABLE — `disabled` removes a control from
 *     the accessibility tree, so a screen-reader user cannot even discover
 *     that the action exists, let alone why it is unavailable.
 *
 * @module main
 */

import { abortAll, getStatus, installUnloadGuard } from './api.js';
import { announce, el, mount as mountNodes, on, qsa } from './dom.js';
import { formatMs } from './format.js';
import { createPoller } from './poll.js';
import { createRouter, VIEW_TITLES } from './router.js';
import { getSetting, getSettings, watchExternalChanges } from './settings.js';
import { capabilities, normalizeStatus } from './shape.js';
import { store } from './store.js';
import { initTheme } from './theme.js';
import { initToasts, toast } from './toast.js';
import { openModal, statusPill } from './ui.js';

import * as memoryView from './views/memory.js';
import * as overviewView from './views/overview.js';
import * as reputationView from './views/reputation.js';
import * as semanticView from './views/semantic.js';
import * as systemView from './views/system.js';

/**
 * @typedef {object} ViewModule
 * @property {(container: HTMLElement, ctx: ViewContext) => void} mount
 * @property {() => void} unmount
 * @property {(ctx?: ViewContext) => void} [refresh]
 */

/**
 * @typedef {object} ViewContext
 * @property {typeof store} store
 * @property {import('./router.js').Router} router
 * @property {import('./poll.js').Poller} poller
 * @property {() => void} refresh
 * @property {() => void} openSettings
 */

/** @type {Record<string, ViewModule>} */
const VIEW_MODULES = {
  overview: overviewView,
  memory: memoryView,
  semantic: semanticView,
  reputation: reputationView,
  system: systemView,
};

/** How many consecutive poll failures before the page says the node is down. */
const UNREACHABLE_AFTER = 2;

/** @type {string | null} */
let mountedView = null;

/** @type {ViewContext | null} */
let context = null;

/* ==================================================================== *
 * Boot
 * ==================================================================== */

/**
 * @returns {void}
 */
export function boot() {
  // Theme first: it stamps `data-theme` on <html> before any view paints, so
  // there is no flash of the wrong palette.
  initTheme(document.getElementById('btn-theme'));
  initToasts();
  installUnloadGuard();
  watchExternalChanges();
  installErrorHandlers();
  installConnectivityListeners();
  ensureCapabilityNotes();

  const poller = createPoller({
    label: 'status',
    intervalMs: getSetting('pollIntervalMs'),
    maxBackoffMs: 30000,
    fn: (signal) => getStatus({ signal }),
    onData: (data) => {
      store.setState({
        status: { data, loading: false, error: null, updatedAt: Date.now() },
        connection: { mode: 'polling', attempts: 0, nextRetryAt: null, lastError: null },
      });
      const status = normalizeStatus(data);
      store.setState({ readOnly: status.readOnly || !status.chain.configured });
      renderGlobalPills(status);
      applyCapabilityGates();
      renderBanners();
    },
    onError: (error, attempts) => {
      store.setState((prev) => ({
        status: { ...prev.status, loading: false, error: /** @type {Error} */ (error) },
        connection: {
          mode: attempts >= UNREACHABLE_AFTER ? 'down' : 'retrying',
          attempts,
          nextRetryAt: null,
          lastError: /** @type {Error} */ (error),
        },
      }));
      renderGlobalPills(null);
      renderBanners();
    },
    onStateChange: () => renderBanners(),
  });

  const router = createRouter({
    tablistEl: /** @type {HTMLElement | null} */ (document.getElementById('view-tabs')),
    onEnter: (view, { mount: mountEl }) => {
      if (!mountEl) return;
      const module = VIEW_MODULES[view];
      if (!module) return;
      try {
        module.mount(mountEl, /** @type {ViewContext} */ (context));
        mountedView = view;
        applyCapabilityGates();
      } catch (error) {
        console.error('[main] view "' + view + '" failed to mount', error);
        mountNodes(
          mountEl,
          el(
            'div',
            { class: 'callout callout--danger' },
            el('p', null, 'The ' + (VIEW_TITLES[view] ?? view) + ' view failed to load.'),
          ),
        );
        toast.error(error, { dedupeKey: 'view-mount' });
      }
    },
    onLeave: (view) => {
      const module = VIEW_MODULES[view];
      if (!module) return;
      try {
        module.unmount();
      } catch (error) {
        console.error('[main] view "' + view + '" failed to unmount', error);
      }
      if (mountedView === view) mountedView = null;
    },
  });

  context = {
    store,
    router,
    poller,
    refresh: refreshEverything,
    openSettings: () => router.go('system', { focus: true }),
  };

  wireTopbar();
  wireShortcuts();
  renderBanners();

  poller.start();

  // Last, so the first view mounts with the poller running and `context` built.
  router.start();

  /**
   * @returns {void}
   */
  function refreshEverything() {
    void poller.refreshNow();
    const module = mountedView ? VIEW_MODULES[mountedView] : null;
    if (module && typeof module.refresh === 'function') {
      module.refresh(/** @type {ViewContext} */ (context));
    }
    announce('Refreshing.');
  }

  /**
   * @returns {void}
   */
  function wireTopbar() {
    on(document.getElementById('btn-refresh'), 'click', () => refreshEverything());
    on(document.getElementById('btn-settings'), 'click', () => openSettingsDialog(poller));
  }

  /**
   * `t` belongs to theme.js and `1`-`5` to router.js; this claims `r` and `?`.
   * `/` is claimed by the Memory view while it is mounted.
   *
   * @returns {void}
   */
  function wireShortcuts() {
    on(document, 'keydown', (/** @type {Event} */ event) => {
      const keyEvent = /** @type {KeyboardEvent} */ (event);
      if (keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName))
      ) {
        return;
      }
      if (keyEvent.key === 'r') {
        keyEvent.preventDefault();
        refreshEverything();
        return;
      }
      if (keyEvent.key === '?') {
        keyEvent.preventDefault();
        openShortcutsDialog();
      }
    });
  }
}

/* ==================================================================== *
 * Global error surface
 * ==================================================================== */

/**
 * Surface what used to vanish.
 *
 * Both handlers dedupe onto one key: a render loop that throws every frame
 * must not bury the screen in toasts, and the console still receives every
 * individual error for a stack trace.
 *
 * @returns {void}
 */
function installErrorHandlers() {
  window.addEventListener('error', (event) => {
    // Resource load failures (a missing image) arrive here with no `error`.
    if (!event.error) return;
    console.error('[main] uncaught error', event.error);
    toast.error('Something went wrong in the console.', {
      description: String(event.message ?? ''),
      dedupeKey: 'unexpected',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.error('[main] unhandled rejection', event.reason);
    toast.error(event.reason, { dedupeKey: 'unexpected' });
  });

  // api.js fires this when a node answers 401 with `api_key_required`.
  document.addEventListener('nm:apikeyrequired', () => {
    store.setState({ apiKeyRequired: true });
    renderBanners();
  });

  document.addEventListener('nm:settingschange', (event) => {
    const detail = /** @type {CustomEvent<{ changed: string[] }>} */ (event).detail;
    if (detail && Array.isArray(detail.changed) && detail.changed.includes('apiKey')) {
      store.setState({ apiKeyRequired: false });
      renderBanners();
    }
  });
}

/**
 * @returns {void}
 */
function installConnectivityListeners() {
  const sync = () => {
    store.setState({ online: navigator.onLine !== false });
    renderBanners();
  };
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  window.addEventListener('pagehide', () => abortAll());
}

/* ==================================================================== *
 * Topbar status pills
 * ==================================================================== */

/**
 * @param {import('./shape.js').NodeStatus | null} status
 * @returns {void}
 */
function renderGlobalPills(status) {
  /**
   * @param {string} id
   * @param {HTMLElement} pill
   * @returns {void}
   */
  const swap = (id, pill) => {
    const current = document.getElementById(id);
    if (!current || !current.parentNode) return;
    pill.id = id;
    current.replaceWith(pill);
  };

  if (!status) {
    swap('pill-chain', statusPill('danger', 'Node unreachable'));
    swap('pill-model', statusPill('neutral', 'Model: unknown'));
    swap('pill-ipfs', statusPill('neutral', 'IPFS: unknown'));
    return;
  }

  swap(
    'pill-chain',
    status.chain.configured
      ? statusPill(
          'success',
          (status.chain.network ?? 'Chain') +
            (status.chain.blockNumber === null ? '' : ' · #' + status.chain.blockNumber),
        )
      : statusPill('warn', 'No chain key'),
  );

  swap(
    'pill-model',
    status.model.ready === true
      ? statusPill(
          'success',
          (status.model.name ?? 'Model') +
            (status.model.dimensions === null ? '' : ' · ' + status.model.dimensions + 'd'),
        )
      : status.model.ready === false
        ? statusPill('info', 'Model loading', { pulse: true })
        : statusPill('neutral', 'Model: not reported'),
  );

  swap(
    'pill-ipfs',
    status.ipfs.configured === false
      ? statusPill('warn', 'IPFS not configured')
      : statusPill('success', 'IPFS ready'),
  );

  const version = document.getElementById('node-version');
  if (version) version.textContent = status.node.version ?? 'version unknown';
}

/* ==================================================================== *
 * Degradation banners
 * ==================================================================== */

/**
 * Render the banner region from scratch on every change.
 *
 * Rebuilding rather than patching is deliberate: the failure mode of an
 * incrementally-updated banner stack is a stale banner that outlives the
 * condition it described, which is worse than no banner at all.
 *
 * @returns {void}
 */
function renderBanners() {
  const region = document.getElementById('banner-region');
  if (!region) return;

  const state = store.getState();
  const status = state.status.data ? normalizeStatus(state.status.data) : null;

  /** @type {HTMLElement[]} */
  const banners = [];

  if (!state.online) {
    banners.push(
      banner('warn', 'You are offline. The console is showing the last data it received.'),
    );
  }

  if (state.connection.mode === 'down') {
    banners.push(
      banner(
        'danger',
        'Cannot reach this node’s API. Retrying automatically' +
          (context && context.poller
            ? ', next attempt within ' + formatMs(context.poller.getState().intervalMs)
            : '') +
          '.',
        {
          label: 'Retry now',
          onClick: () => {
            if (context) void context.poller.refreshNow();
          },
        },
      ),
    );
  }

  if (state.apiKeyRequired) {
    banners.push(
      banner('warn', 'This node requires an API key for write actions. None is stored here.', {
        label: 'Open settings',
        onClick: () => {
          if (context) context.openSettings();
        },
      }),
    );
  }

  if (status && (status.readOnly || !status.chain.configured)) {
    banners.push(
      banner(
        'info',
        'Read-only mode: this node has no signing key configured, so Register, Commit, Endorse and Report are unavailable.',
      ),
    );
  }

  if (status && status.model.ready === false) {
    banners.push(
      banner(
        'info',
        'The embedding model is still loading. Committing and searching will fail until it is ready.',
      ),
    );
  }

  mountNodes(region, banners);
}

/**
 * @param {'info'|'warn'|'danger'} tone
 * @param {string} message
 * @param {{ label: string, onClick: () => void }} [action]
 * @returns {HTMLElement}
 */
function banner(tone, message, action) {
  return el(
    'div',
    { class: ['banner', 'banner--' + tone], role: 'status' },
    el('p', { class: 'banner__text' }, message),
    action
      ? el(
          'div',
          { class: 'banner__actions' },
          el(
            'button',
            { type: 'button', class: 'btn btn--secondary btn--sm', onClick: action.onClick },
            action.label,
          ),
        )
      : null,
  );
}

/* ==================================================================== *
 * Capability gating
 * ==================================================================== */

/** Reason text for each capability a control can require. */
const CAPABILITY_NOTES = Object.freeze({
  chain: 'Unavailable: this node has no chain access configured.',
  model: 'Unavailable: the embedding model is not loaded yet.',
  ipfs: 'Unavailable: IPFS pinning is not configured on this node.',
  write: 'Unavailable: this node is read-only and has no signing key.',
});

/**
 * Create the four visually-hidden explanation nodes once, so a gated control
 * can point at one with `aria-describedby`.
 *
 * @returns {void}
 */
function ensureCapabilityNotes() {
  if (document.getElementById('cap-note-chain')) return;
  const host = el(
    'div',
    { class: 'sr-only' },
    Object.entries(CAPABILITY_NOTES).map(([key, text]) =>
      el('span', { id: 'cap-note-' + key }, text),
    ),
  );
  document.body.appendChild(host);
}

/**
 * Walk every `[data-requires]` control and mark the ones this node cannot
 * honour.
 *
 * `aria-disabled` rather than `disabled`, always: the control keeps its place
 * in the tab order and announces the reason, and the click handlers guard
 * themselves with `isGated()`.
 *
 * @returns {void}
 */
function applyCapabilityGates() {
  const state = store.getState();
  const status = state.status.data ? normalizeStatus(state.status.data) : null;
  const caps = capabilities(status);

  for (const node of qsa('[data-requires]')) {
    if (!(node instanceof HTMLElement)) continue;
    const required = (node.dataset.requires ?? '').split(/\s+/).filter(Boolean);
    const missing = required.filter(
      (name) => name in caps && !caps[/** @type {keyof typeof caps} */ (name)],
    );

    if (missing.length === 0) {
      node.removeAttribute('aria-disabled');
      if (node.dataset.gatedBy) {
        node.removeAttribute('aria-describedby');
        delete node.dataset.gatedBy;
      }
      continue;
    }
    node.setAttribute('aria-disabled', 'true');
    node.setAttribute('aria-describedby', 'cap-note-' + missing[0]);
    node.dataset.gatedBy = missing[0];
  }
}

// Views re-render their own subtrees constantly, so gates are re-applied
// whenever the main region changes rather than only when status does.
const gateObserver =
  typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver(() => {
        window.requestAnimationFrame(() => applyCapabilityGates());
      });

/* ==================================================================== *
 * Dialogs owned by the shell
 * ==================================================================== */

/**
 * @param {import('./poll.js').Poller} poller
 * @returns {void}
 */
function openSettingsDialog(poller) {
  const settings = getSettings();
  openModal({
    title: 'Settings',
    body: el(
      'div',
      { class: 'stack' },
      el(
        'p',
        null,
        'The full settings panel, including the API key field, lives in the System view so that it is linkable and reloadable.',
      ),
      el(
        'ul',
        null,
        el('li', null, 'Status poll interval: ' + formatMs(settings.pollIntervalMs)),
        el('li', null, 'Memories per page: ' + settings.pageSize),
        el('li', null, 'API key stored: ' + (settings.apiKey ? 'yes' : 'no')),
        el(
          'li',
          null,
          'Live updates: ' +
            (poller.getState().mode === 'paused' ? 'paused (tab hidden)' : poller.getState().mode),
        ),
      ),
    ),
    footer: el(
      'div',
      { class: 'card__actions' },
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--primary btn--sm',
          onClick: () => {
            if (context) context.openSettings();
          },
        },
        'Open System settings',
      ),
    ),
  });
}

/**
 * @returns {void}
 */
function openShortcutsDialog() {
  openModal({
    title: 'Keyboard shortcuts',
    body: el(
      'dl',
      { class: 'kv' },
      el('dt', null, '1 – 5'),
      el('dd', null, 'Jump to a section'),
      el('dt', null, 'r'),
      el('dd', null, 'Refresh everything'),
      el('dt', null, 't'),
      el('dd', null, 'Cycle theme: system, light, dark'),
      el('dt', null, '/'),
      el('dd', null, 'Focus the memory filter (Memory view)'),
      el('dt', null, '?'),
      el('dd', null, 'This dialog'),
      el('dt', null, 'Esc'),
      el('dd', null, 'Close a dialog'),
    ),
  });
}

/* ==================================================================== *
 * Start
 * ==================================================================== */

/**
 * @returns {void}
 */
function start() {
  boot();
  const main = document.getElementById('main');
  if (gateObserver && main) gateObserver.observe(main, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
