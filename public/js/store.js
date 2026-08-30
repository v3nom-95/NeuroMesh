/**
 * NeuroMesh — the observable store. ~120 lines of state management, no
 * dependencies, no framework, no build step.
 *
 * Design decisions, each one a reaction to how the old dashboard behaved:
 *
 *   - SHALLOW MERGE, SHALLOW COMPARE. `setState` merges top-level keys and
 *     compares them with `Object.is`. A view that owns a slice replaces the
 *     whole slice object; it never mutates in place. That single convention is
 *     what makes `select()` cheap and correct without deep equality.
 *
 *   - NO NOTIFICATION WHEN NOTHING CHANGED. Writing the same status payload on
 *     every poll tick must not re-render five panels every five seconds.
 *
 *   - SYNCHRONOUS NOTIFY. Listeners run inside the `setState` call. Debugging a
 *     microtask-deferred update means the stack that caused the render is
 *     already gone; here the stack trace points straight at the writer. Views
 *     that need coalescing debounce their own render, which is a decision they
 *     are better placed to make than the store is.
 *
 *   - ONE BAD LISTENER CANNOT BREAK THE APP. Every listener call is wrapped;
 *     a throw is reported through `console.error` and the pass continues. The
 *     old code let one `TypeError` in the reputation render abort the whole
 *     simulation load, leaving three panels permanently blank.
 *
 *   - RE-ENTRANCY IS SAFE. The listener set is copied before iteration, so a
 *     listener may subscribe, unsubscribe, or call `setState` again without
 *     corrupting the pass in progress.
 *
 * @module store
 */

/**
 * @template S
 * @typedef {(state: Readonly<S>, prevState: Readonly<S>, changedKeys: Set<string>) => void} StoreListener
 */

/**
 * @template S
 * @typedef {object} Store
 * @property {() => Readonly<S>} getState
 * @property {(patchOrFn: Partial<S> | ((prev: Readonly<S>) => Partial<S> | null | undefined)) => Readonly<S>} setState
 * @property {(listener: StoreListener<S>) => () => void} subscribe
 * @property {<V>(selector: (state: Readonly<S>) => V, listener: (value: V, prevValue: V) => void, isEqual?: (a: V, b: V) => boolean) => () => void} select
 * @property {() => Readonly<S>} reset
 */

/**
 * Create an independent store. The app uses one (`store`, below), but views
 * and tests can make their own — nothing here is a singleton.
 *
 * @template {Record<string, unknown>} S
 * @param {S} initialState
 * @returns {Store<S>}
 */
export function createStore(initialState) {
  /** @type {S} */
  let state = { ...initialState };
  /** @type {Set<StoreListener<S>>} */
  const listeners = new Set();

  /**
   * @returns {Readonly<S>}
   */
  function getState() {
    return state;
  }

  /**
   * Merge a partial state. Accepts an updater function so a caller can derive
   * the patch from the current state without a separate `getState()` read
   * (which would otherwise race with a re-entrant write).
   *
   * @param {Partial<S> | ((prev: Readonly<S>) => Partial<S> | null | undefined)} patchOrFn
   * @returns {Readonly<S>} the state after the merge
   */
  function setState(patchOrFn) {
    const patch = typeof patchOrFn === 'function' ? patchOrFn(state) : patchOrFn;
    if (patch == null || typeof patch !== 'object') return state;

    /** @type {Set<string>} */
    const changedKeys = new Set();
    for (const key of Object.keys(patch)) {
      const next = /** @type {Record<string, unknown>} */ (patch)[key];
      if (!Object.is(/** @type {Record<string, unknown>} */ (state)[key], next)) {
        changedKeys.add(key);
      }
    }
    // The common case on a poll tick: identical payload, zero work.
    if (changedKeys.size === 0) return state;

    const prevState = state;
    state = { ...state, ...patch };
    notify(state, prevState, changedKeys);
    return state;
  }

  /**
   * @param {Readonly<S>} next
   * @param {Readonly<S>} prev
   * @param {Set<string>} changedKeys
   * @returns {void}
   */
  function notify(next, prev, changedKeys) {
    for (const listener of Array.from(listeners)) {
      // A listener removed during this same pass must not be called.
      if (!listeners.has(listener)) continue;
      try {
        listener(next, prev, changedKeys);
      } catch (error) {
        console.error('[store] listener threw; continuing', error);
      }
    }
  }

  /**
   * Subscribe to every change.
   *
   * @param {StoreListener<S>} listener
   * @returns {() => void} unsubscribe; calling it twice is harmless
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('store.subscribe(listener): listener must be a function');
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Subscribe to a derived value. The listener fires ONLY when the selected
   * value changes, which is what keeps a `memories` update from re-rendering
   * the reputation view.
   *
   * The selector is run on subscribe to capture a baseline, but the listener
   * is NOT invoked at that point — call it yourself if you want an initial
   * render, so the subscription and the first paint stay separable.
   *
   * @template V
   * @param {(state: Readonly<S>) => V} selector
   * @param {(value: V, prevValue: V) => void} listener
   * @param {(a: V, b: V) => boolean} [isEqual] defaults to Object.is
   * @returns {() => void} unsubscribe
   */
  function select(selector, listener, isEqual = Object.is) {
    if (typeof selector !== 'function' || typeof listener !== 'function') {
      throw new TypeError('store.select(selector, listener): both must be functions');
    }
    let previous = selector(state);
    return subscribe((next) => {
      const current = selector(next);
      if (isEqual(current, previous)) return;
      const before = previous;
      previous = current;
      listener(current, before);
    });
  }

  /**
   * Restore the state the store was created with. Notifies with the full set
   * of changed keys. Used by tests and by the "Reset local settings" action.
   *
   * @returns {Readonly<S>}
   */
  function reset() {
    const prevState = state;
    /** @type {Set<string>} */
    const changedKeys = new Set();
    for (const key of Object.keys(initialState)) {
      if (!Object.is(/** @type {Record<string, unknown>} */ (prevState)[key], initialState[key])) {
        changedKeys.add(key);
      }
    }
    state = { ...initialState };
    if (changedKeys.size > 0) notify(state, prevState, changedKeys);
    return state;
  }

  return { getState, setState, subscribe, select, reset };
}

/* ==================================================================== *
 * Async slice helpers
 *
 * Every remote resource in this app is modelled the same way, so that every
 * panel can render the same four states: skeleton, empty, error-with-retry,
 * data. Hand-rolling the triad per view is how panels end up with no error
 * state at all, which is exactly what the audit found.
 * ==================================================================== */

/**
 * @template T
 * @typedef {object} AsyncSlice
 * @property {T | null} data
 * @property {boolean} loading
 * @property {import('./api.js').ApiError | Error | null} error
 * @property {number | null} updatedAt epoch ms of the last successful load
 */

/**
 * @template T
 * @param {T | null} [data]
 * @returns {AsyncSlice<T>}
 */
export function asyncSlice(data = null) {
  return { data, loading: false, error: null, updatedAt: null };
}

/**
 * Replace one async slice, preserving the fields the patch does not mention.
 * Always produces a NEW object, which is what the shallow comparison in
 * `setState` needs in order to notice the change.
 *
 * @template {Record<string, unknown>} S
 * @param {Store<S>} target
 * @param {keyof S & string} key
 * @param {Partial<AsyncSlice<unknown>>} patch
 * @returns {Readonly<S>}
 */
export function setSlice(target, key, patch) {
  const current = /** @type {Record<string, unknown>} */ (target.getState())[key];
  const base = current && typeof current === 'object' ? current : asyncSlice();
  return target.setState(/** @type {Partial<S>} */ ({ [key]: { ...base, ...patch } }));
}

/**
 * Mark a slice as loading without discarding the data already on screen —
 * a refresh should dim the table, not blank it.
 *
 * @template {Record<string, unknown>} S
 * @param {Store<S>} target
 * @param {keyof S & string} key
 * @returns {Readonly<S>}
 */
export function beginLoad(target, key) {
  return setSlice(target, key, { loading: true, error: null });
}

/**
 * @template {Record<string, unknown>} S
 * @param {Store<S>} target
 * @param {keyof S & string} key
 * @param {unknown} data
 * @returns {Readonly<S>}
 */
export function finishLoad(target, key, data) {
  return setSlice(target, key, { data, loading: false, error: null, updatedAt: Date.now() });
}

/**
 * @template {Record<string, unknown>} S
 * @param {Store<S>} target
 * @param {keyof S & string} key
 * @param {Error} error
 * @returns {Readonly<S>}
 */
export function failLoad(target, key, error) {
  return setSlice(target, key, { loading: false, error });
}

/* ==================================================================== *
 * The application store
 * ==================================================================== */

/**
 * The exact shape of application state. Views read from here and never hold
 * their own copy of server data; that is what made two fast tab switches race
 * two renders into the same container in the old dashboard.
 */
export const INITIAL_STATE = {
  /** Current view slug, kept in step with the router. */
  view: 'overview',
  /** Navigator connectivity, driven by the `online`/`offline` events. */
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  /** Set when the node answers 401 with `api_key_required`. */
  apiKeyRequired: false,
  /** True when the node reports no signing key: writes are unavailable. */
  readOnly: false,

  /** GET /api/status */
  status: asyncSlice(),
  /** GET /healthz */
  health: asyncSlice(),
  /** GET /readyz */
  ready: asyncSlice(),
  /** GET /metrics (prometheus text) */
  metrics: asyncSlice(),
  /** GET /api/agents/:address */
  agent: asyncSlice(),

  /** GET /api/memories — list plus its query, filter and paging state. */
  memories: {
    items: /** @type {unknown[]} */ ([]),
    nextCursor: /** @type {string | null} */ (null),
    total: /** @type {number | null} */ (null),
    loading: false,
    error: /** @type {Error | null} */ (null),
    updatedAt: /** @type {number | null} */ (null),
    query: '',
    filters: { encrypted: 'any', model: 'any' },
    sort: { key: 'createdAt', dir: 'desc' },
  },
  /** GET /api/memories/:cid */
  memoryDetail: {
    cid: /** @type {string | null} */ (null),
    data: /** @type {unknown} */ (null),
    loading: false,
    error: /** @type {Error | null} */ (null),
  },
  /** In-flight commit pipeline, driven by the composer's stepper. */
  commit: {
    active: false,
    step: /** @type {string | null} */ (null),
    startedAt: /** @type {number | null} */ (null),
    result: /** @type {unknown} */ (null),
    error: /** @type {Error | null} */ (null),
  },

  /** POST /api/semantic/search */
  search: {
    query: '',
    topK: 5,
    trustWeighted: true,
    results: /** @type {unknown[]} */ ([]),
    loading: false,
    error: /** @type {Error | null} */ (null),
    tookMs: /** @type {number | null} */ (null),
  },
  /** GET /api/semantic/similarity */
  similarity: asyncSlice(),
  /** GET /api/reputation */
  reputation: asyncSlice(),
  /** GET /api/simulation-results — 404 on a fresh clone, by design. */
  simulation: asyncSlice(),

  /** Transport health, rendered by the connection banner and the System view. */
  connection: {
    mode: /** @type {'idle' | 'polling' | 'stream' | 'retrying' | 'down'} */ ('idle'),
    attempts: 0,
    nextRetryAt: /** @type {number | null} */ (null),
    lastError: /** @type {Error | null} */ (null),
  },
};

/** @typedef {typeof INITIAL_STATE} AppState */

/** The single application store. */
export const store = createStore(INITIAL_STATE);
