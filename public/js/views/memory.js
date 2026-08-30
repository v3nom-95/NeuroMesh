/**
 * Memory: compose a memory, and explore what has been committed.
 *
 * Two things here are corrections of specific defects rather than features.
 *
 * 1. The composer shows the five pipeline stages instead of one opaque
 *    spinner. The repo's own benchmark data records end-to-end latencies above
 *    24 seconds; a user watching an unlabelled spinner for that long cannot
 *    tell a slow IPFS pin from a hung transaction.
 * 2. A memory row renders only fields the API actually returns. Its
 *    predecessor read `ipfsData.raw_context`, a key nothing has ever written,
 *    so every card in the ledger displayed the literal string "undefined" as
 *    though it were the memory's content. When a record is encrypted this view
 *    says so in plain words; it never pretends to show content it does not
 *    have.
 *
 * @module views/memory
 */

import { ApiError, createMemory, getMemory, listMemories } from '../api.js';
import { announce, el, extLink, mount as mountNodes, on } from '../dom.js';
import {
  debounce,
  EMPTY,
  explorerTxUrl,
  formatBytes,
  formatCid,
  formatNumber,
  pluralize,
} from '../format.js';
import { gatewayUrl, normalizeMemory, normalizeMemoryList, normalizeStatus } from '../shape.js';
import { getSetting } from '../settings.js';
import { store } from '../store.js';
import { toast } from '../toast.js';
import {
  card,
  confirmDialog,
  createStepper,
  empties,
  errorState,
  field,
  idChip,
  isGated,
  kvList,
  loadingBlock,
  setButtonBusy,
  statusPill,
  timeAgo,
} from '../ui.js';

/**
 * Client-side cap on the composed text.
 *
 * This mirrors the server's validation schema. It is a UX affordance, not a
 * security control — the server enforces the real limit — but without it the
 * user discovers the limit only after a request that runs a transformer, an
 * AES seal, an IPFS pin and a chain transaction before rejecting them.
 */
export const MAX_CONTEXT_CHARS = 4000;

/** The stages the backend runs, in order, for the commit stepper. */
const PIPELINE = Object.freeze([
  { id: 'embed', label: 'Embed text locally' },
  { id: 'encrypt', label: 'Encrypt payload' },
  { id: 'pin', label: 'Pin to IPFS' },
  { id: 'sign', label: 'Sign proof' },
  { id: 'commit', label: 'Commit on chain' },
]);

/**
 * @typedef {object} MemoryViewState
 * @property {AbortController | null} abort
 * @property {AbortController | null} listAbort
 * @property {(() => void)[]} teardown
 * @property {Record<string, HTMLElement | null>} slots
 * @property {import('../shape.js').MemoryRecord[]} items
 * @property {string | null} nextCursor
 * @property {string[]} cursorStack
 * @property {number | null} total
 * @property {boolean} loading
 * @property {unknown} error
 * @property {{ q: string, encrypted: string, model: string, sort: string }} filters
 * @property {Set<string>} expanded
 */

/** @type {MemoryViewState} */
let view = freshState();

/**
 * Monotonic source of disclosure-panel ids.
 *
 * Deliberately NOT derived from the CID. A CID is remote, attacker-influencable
 * text: one containing whitespace would split the `aria-controls` IDREF list and
 * silently sever the button from the panel it controls, and two pins sharing a
 * CID would mint duplicate ids — the exact defect this rewrite exists to remove.
 */
let rowSeq = 0;

/**
 * @returns {MemoryViewState}
 */
function freshState() {
  return {
    abort: null,
    listAbort: null,
    teardown: [],
    slots: {},
    items: [],
    nextCursor: null,
    cursorStack: [],
    total: null,
    loading: false,
    error: null,
    filters: { q: '', encrypted: 'any', model: 'any', sort: 'newest' },
    expanded: new Set(),
  };
}

/* ==================================================================== *
 * Lifecycle
 * ==================================================================== */

/**
 * @param {HTMLElement} container
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
export function mount(container, ctx) {
  view = freshState();
  view.abort = new AbortController();

  const slots = {
    compose: el('div'),
    explorer: el('div'),
  };
  view.slots = slots;

  mountNodes(
    container,
    el(
      'div',
      { class: 'stack' },
      el('h2', { class: 'sr-only', 'data-view-heading': 'true' }, 'Memory'),
      slots.compose,
      slots.explorer,
    ),
  );

  renderComposer(ctx);
  renderExplorer(ctx);
  void loadPage(null, ctx);

  view.teardown.push(
    store.select(
      (state) => state.status.data,
      () => {
        renderComposer(ctx);
        renderRows(ctx);
      },
    ),
  );

  // `/` focuses the explorer's search box, the convention every search UI on
  // the web shares. Bound only while this view is mounted, and ignored while
  // the user is typing into a field.
  view.teardown.push(
    on(document, 'keydown', (/** @type {Event} */ event) => {
      const keyEvent = /** @type {KeyboardEvent} */ (event);
      if (keyEvent.key !== '/' || keyEvent.ctrlKey || keyEvent.metaKey || keyEvent.altKey) return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName))
      ) {
        return;
      }
      const search = document.getElementById('input-search');
      if (!(search instanceof HTMLInputElement)) return;
      keyEvent.preventDefault();
      search.focus();
      search.select();
    }),
  );
}

/**
 * @returns {void}
 */
export function unmount() {
  if (view.abort) view.abort.abort();
  if (view.listAbort) view.listAbort.abort();
  for (const dispose of view.teardown) dispose();
  view = freshState();
}

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
export function refresh(ctx) {
  void loadPage(null, ctx);
}

/* ==================================================================== *
 * Composer
 * ==================================================================== */

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
function renderComposer(ctx) {
  const slot = view.slots.compose;
  if (!slot) return;

  const status = store.getState().status.data
    ? normalizeStatus(store.getState().status.data)
    : null;

  const counter = el(
    'span',
    { class: 'counter', id: 'counter-context' },
    '0 / ' + MAX_CONTEXT_CHARS,
  );

  const textarea = /** @type {HTMLTextAreaElement} */ (
    el('textarea', {
      id: 'input-context',
      class: 'textarea',
      rows: '5',
      maxlength: String(MAX_CONTEXT_CHARS),
      'aria-describedby': 'input-context-hint counter-context',
      placeholder: '',
    })
  );

  const contextField = field({
    id: 'input-context',
    label: 'Contextual memory',
    required: true,
    control: textarea,
    headExtra: counter,
    hint: 'Embedded locally, sealed with AES-256-GCM, pinned to IPFS. Only the proof hash and the embedding metadata go on chain.',
  });

  // Announcing on every keystroke would make the field unusable with a screen
  // reader, so the visible counter updates immediately and the spoken one is
  // debounced and only speaks near and past the limit.
  const announceCount = debounce((/** @type {number} */ used) => {
    if (used > MAX_CONTEXT_CHARS)
      announce('Over the limit by ' + (used - MAX_CONTEXT_CHARS) + ' characters.');
    else if (used >= MAX_CONTEXT_CHARS * 0.9) {
      announce(MAX_CONTEXT_CHARS - used + ' characters remaining.');
    }
  }, 500);

  const syncCounter = () => {
    const used = textarea.value.length;
    counter.textContent = formatNumber(used, 0) + ' / ' + formatNumber(MAX_CONTEXT_CHARS, 0);
    counter.classList.toggle(
      'counter--near',
      used >= MAX_CONTEXT_CHARS * 0.9 && used <= MAX_CONTEXT_CHARS,
    );
    counter.classList.toggle('counter--over', used > MAX_CONTEXT_CHARS);
    announceCount(used);
  };
  textarea.addEventListener('input', syncCounter);
  view.teardown.push(() => announceCount.cancel());

  const progressSlot = el('div', { id: 'commit-progress' });

  const commitButton = el(
    'button',
    {
      type: 'submit',
      class: 'btn btn--primary btn--lg',
      id: 'btn-commit',
      dataset: { requires: 'chain model ipfs write' },
    },
    'Commit memory',
  );

  const form = el(
    'form',
    {
      id: 'form-compose',
      novalidate: true,
      onSubmit: (/** @type {Event} */ event) => {
        event.preventDefault();
        void handleCommit(textarea, contextField, commitButton, progressSlot, syncCounter, ctx);
      },
    },
    el(
      'div',
      { class: 'stack' },
      contextField.node,
      el('div', { class: 'card__actions' }, commitButton),
      progressSlot,
    ),
  );

  mountNodes(
    slot,
    card({
      id: 'card-compose',
      title: 'Commit a memory',
      hint:
        status && status.readOnly
          ? 'This node is read-only: no signing key is configured.'
          : undefined,
      children: form,
    }),
  );
}

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {{ setError: (message: string|null) => void }} contextField
 * @param {HTMLElement} button
 * @param {HTMLElement} progressSlot
 * @param {() => void} syncCounter
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {Promise<void>}
 */
async function handleCommit(textarea, contextField, button, progressSlot, syncCounter, ctx) {
  if (isGated(button) || button.dataset.busy === 'true') return;

  const value = textarea.value.trim();
  // Validation mirrors the server's schema. Inline and focused, never a toast
  // alone: a toast about a field the user cannot see is not an error message.
  if (value === '') {
    contextField.setError('Enter the text to remember before committing.');
    textarea.focus();
    return;
  }
  if (value.length > MAX_CONTEXT_CHARS) {
    contextField.setError(
      'Too long by ' + formatNumber(value.length - MAX_CONTEXT_CHARS, 0) + ' characters.',
    );
    textarea.focus();
    return;
  }
  contextField.setError(null);

  const confirmed = await confirmDialog({
    title: 'Commit this memory?',
    message: 'The node will embed the text, encrypt it, pin it to IPFS and send a transaction.',
    consequences: [
      'The ciphertext and its metadata become permanently retrievable by CID.',
      'The transaction spends testnet gas from this node’s key.',
      'A commit can take well over twenty seconds.',
    ],
    confirmLabel: 'Commit memory',
  });
  if (!confirmed) {
    textarea.focus();
    return;
  }

  const stepper = createStepper(PIPELINE);
  const errorSlot = el('div');
  const commitAbort = new AbortController();
  const cancelButton = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--secondary btn--sm',
      onClick: () => commitAbort.abort(),
    },
    'Cancel',
  );

  mountNodes(
    progressSlot,
    el(
      'div',
      { class: 'stack' },
      stepper.node,
      el(
        'p',
        { class: 'card__hint' },
        'The node commits in a single request and does not stream per-stage progress, so stages resolve when it answers.',
      ),
      cancelButton,
      errorSlot,
    ),
  );
  for (const step of PIPELINE) stepper.set(step.id, 'active');

  setButtonBusy(button, true, 'Committing memory, please wait');
  announce('Committing memory. This can take up to a minute.');

  const startedAt = Date.now();
  const elapsedTimer = window.setInterval(() => {
    stepper.set('commit', 'active', Math.round((Date.now() - startedAt) / 1000) + ' s');
  }, 1000);

  try {
    const raw = await createMemory({ context: value }, { signal: commitAbort.signal });
    const memory = normalizeMemory(raw);

    // The commit succeeded, so every stage ran; the evidence in the response
    // is attached to the two stages that produce an artefact.
    for (const step of PIPELINE) stepper.set(step.id, 'done');
    if (memory.cid) stepper.set('pin', 'done', formatCid(memory.cid));
    stepper.set('commit', 'done', Math.round((Date.now() - startedAt) / 1000) + ' s');

    const status = store.getState().status.data
      ? normalizeStatus(store.getState().status.data)
      : null;
    const txUrl = explorerTxUrl(status ? status.chain.explorerBase : null, memory.txHash);

    toast.success('Memory committed', {
      description: memory.cid ?? undefined,
      actionLabel: txUrl ? 'View proof' : undefined,
      onAction: txUrl ? () => window.open(txUrl, '_blank', 'noopener,noreferrer') : undefined,
    });
    announce('Memory committed' + (memory.cid ? ' with CID ' + memory.cid : '') + '.');

    textarea.value = '';
    syncCounter();
    textarea.focus();
    void loadPage(null, ctx);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') {
      stepper.reset();
      mountNodes(
        errorSlot,
        el(
          'p',
          { class: 'callout callout--warn' },
          'Request cancelled. The node may still finish this commit — check the explorer below before retrying.',
        ),
      );
      return;
    }
    stepper.failFrom(stageFromError(error), 'failed');
    mountNodes(
      errorSlot,
      errorState(
        error,
        () => void handleCommit(textarea, contextField, button, progressSlot, syncCounter, ctx),
      ),
    );
    toast.error(error);
    announce('Commit failed.', true);
  } finally {
    window.clearInterval(elapsedTimer);
    setButtonBusy(button, false);
    cancelButton.remove();
  }
}

/**
 * Guess which stage failed from the error text.
 *
 * Deliberately conservative: when nothing in the message names a stage, the
 * first stage is marked and the rest are shown as skipped rather than failed,
 * because claiming the chain call failed when the embedding may never have run
 * would send an operator to the wrong logs.
 *
 * @param {unknown} error
 * @returns {string}
 */
function stageFromError(error) {
  const text = (
    (error instanceof ApiError ? error.code + ' ' + error.message : String(error)) || ''
  ).toLowerCase();
  if (/embed|model|transformer/.test(text)) return 'embed';
  if (/encrypt|cipher|aes/.test(text)) return 'encrypt';
  if (/ipfs|pin|pinata|gateway/.test(text)) return 'pin';
  if (/sign|signature|key/.test(text)) return 'sign';
  if (/chain|transaction|tx|gas|nonce|rpc/.test(text)) return 'commit';
  return 'embed';
}

/* ==================================================================== *
 * Explorer
 * ==================================================================== */

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
function renderExplorer(ctx) {
  const slot = view.slots.explorer;
  if (!slot) return;

  const searchInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'search',
      id: 'input-search',
      class: 'input',
      autocomplete: 'off',
      placeholder: '',
    })
  );
  const runFilter = debounce(() => {
    view.filters.q = searchInput.value.trim().toLowerCase();
    renderRows(ctx);
  }, 250);
  searchInput.addEventListener('input', () => runFilter());
  view.teardown.push(() => runFilter.cancel());

  const encryptedSelect = selectControl('select-encrypted', [
    ['any', 'Any'],
    ['yes', 'Encrypted'],
    ['no', 'Plaintext'],
  ]);
  encryptedSelect.addEventListener('change', () => {
    view.filters.encrypted = encryptedSelect.value;
    renderRows(ctx);
  });

  const modelSelect = selectControl('select-model', [['any', 'Any model']]);
  modelSelect.addEventListener('change', () => {
    view.filters.model = modelSelect.value;
    renderRows(ctx);
  });

  const sortSelect = selectControl('select-sort', [
    ['newest', 'Newest first'],
    ['oldest', 'Oldest first'],
  ]);
  sortSelect.addEventListener('change', () => {
    view.filters.sort = sortSelect.value;
    renderRows(ctx);
  });

  const toolbar = el(
    'div',
    { class: 'grid grid--3' },
    field({ id: 'input-search', label: 'Filter loaded memories', control: searchInput }).node,
    field({ id: 'select-encrypted', label: 'Encryption', control: encryptedSelect }).node,
    field({ id: 'select-model', label: 'Model', control: modelSelect }).node,
  );

  const rowsSlot = el('div', { id: 'memory-rows' });
  const countSlot = el('p', { class: 'card__hint', id: 'memory-count' });
  const pagerSlot = el('div', { class: 'card__actions', id: 'memory-pager' });

  view.slots.rows = rowsSlot;
  view.slots.count = countSlot;
  view.slots.pager = pagerSlot;
  view.slots.modelSelect = modelSelect;

  mountNodes(
    slot,
    card({
      id: 'card-explorer',
      title: 'Memory explorer',
      hint: 'Filters and sorting apply to the page currently loaded; paging is cursor-based against the node.',
      actions: el(
        'button',
        {
          type: 'button',
          class: 'btn btn--secondary btn--sm',
          id: 'btn-refresh-memories',
          onClick: () => void loadPage(null, ctx),
        },
        'Reload',
      ),
      children: el(
        'div',
        { class: 'stack' },
        toolbar,
        field({ id: 'select-sort', label: 'Sort', control: sortSelect }).node,
        countSlot,
        rowsSlot,
        pagerSlot,
      ),
    }),
  );
}

/**
 * @param {string} id
 * @param {ReadonlyArray<[string, string]>} options
 * @returns {HTMLSelectElement}
 */
function selectControl(id, options) {
  return /** @type {HTMLSelectElement} */ (
    el(
      'select',
      { id, class: 'select' },
      options.map(([value, label]) => el('option', { value }, label)),
    )
  );
}

/**
 * Fetch one page.
 *
 * Each call aborts the previous one, so two fast clicks on Next cannot race
 * two renders into the same container and let the loser win by arriving late.
 *
 * @param {string | null} cursor
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {Promise<void>}
 */
async function loadPage(cursor, ctx) {
  if (view.listAbort) view.listAbort.abort();
  const local = new AbortController();
  view.listAbort = local;

  view.loading = true;
  view.error = null;
  const rowsSlot = view.slots.rows;
  if (rowsSlot) mountNodes(rowsSlot, loadingBlock('memories', 'row', 5));

  try {
    const raw = await listMemories(
      { limit: getSetting('pageSize'), cursor },
      { signal: local.signal },
    );
    if (local.signal.aborted) return;
    const page = normalizeMemoryList(raw);
    view.items = page.items;
    view.nextCursor = page.nextCursor;
    view.total = page.total;
    view.loading = false;
    view.expanded.clear();
    refreshModelOptions();
    renderRows(ctx);
  } catch (error) {
    if (local.signal.aborted || (error instanceof ApiError && error.code === 'aborted')) return;
    view.loading = false;
    view.error = error;
    if (rowsSlot)
      mountNodes(
        rowsSlot,
        errorState(error, () => void loadPage(cursor, ctx), 'memories'),
      );
    if (view.slots.pager) mountNodes(view.slots.pager);
    if (view.slots.count) view.slots.count.textContent = '';
  }
}

/**
 * Keep the model filter's options in step with what the page actually holds,
 * so it can never offer a model that filters everything out.
 *
 * @returns {void}
 */
function refreshModelOptions() {
  const select = view.slots.modelSelect;
  if (!(select instanceof HTMLSelectElement)) return;
  const previous = select.value;
  const models = Array.from(
    new Set(view.items.map((memory) => memory.model).filter((model) => typeof model === 'string')),
  ).sort();
  mountNodes(
    select,
    el('option', { value: 'any' }, 'Any model'),
    models.map((model) => el('option', { value: /** @type {string} */ (model) }, model)),
  );
  select.value = models.includes(previous) ? previous : 'any';
  view.filters.model = select.value;
}

/**
 * @returns {import('../shape.js').MemoryRecord[]}
 */
function visibleItems() {
  const { q, encrypted, model, sort } = view.filters;
  const filtered = view.items.filter((memory) => {
    if (encrypted === 'yes' && memory.encrypted !== true) return false;
    if (encrypted === 'no' && memory.encrypted === true) return false;
    if (model !== 'any' && memory.model !== model) return false;
    if (q === '') return true;
    const haystack = [memory.cid, memory.agent, memory.model, memory.preview]
      .filter((value) => typeof value === 'string')
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });

  return filtered.sort((a, b) => {
    const left = a.createdAt ?? 0;
    const right = b.createdAt ?? 0;
    return sort === 'oldest' ? left - right : right - left;
  });
}

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
function renderRows(ctx) {
  const rowsSlot = view.slots.rows;
  const countSlot = view.slots.count;
  const pagerSlot = view.slots.pager;
  if (!rowsSlot) return;
  if (view.loading || view.error) return;

  const status = store.getState().status.data
    ? normalizeStatus(store.getState().status.data)
    : null;
  const items = visibleItems();

  if (countSlot) {
    const loaded = view.items.length;
    const shown =
      items.length === loaded
        ? formatNumber(loaded, 0) + ' ' + pluralize(loaded, 'memory', 'memories')
        : formatNumber(items.length, 0) +
          ' of ' +
          formatNumber(loaded, 0) +
          ' ' +
          pluralize(loaded, 'memory', 'memories');
    countSlot.textContent =
      view.total === null
        ? shown + ' on this page'
        : shown + ' on this page · ' + formatNumber(view.total, 0) + ' total';
  }

  if (view.items.length === 0) {
    mountNodes(
      rowsSlot,
      status && status.ipfs.configured === false
        ? empties.notConfigured('IPFS pinning')
        : empties.noMemories(() => {
            const textarea = document.getElementById('input-context');
            if (textarea instanceof HTMLTextAreaElement) textarea.focus();
          }),
    );
  } else if (items.length === 0) {
    mountNodes(
      rowsSlot,
      empties.noSearchResults(view.filters.q === '' ? 'the current filters' : view.filters.q),
    );
  } else {
    mountNodes(
      rowsSlot,
      items.map((memory) => memoryRow(memory, status, ctx)),
    );
  }

  if (pagerSlot) {
    mountNodes(
      pagerSlot,
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--secondary btn--sm',
          'aria-disabled': view.cursorStack.length === 0 ? 'true' : null,
          onClick: () => {
            if (view.cursorStack.length === 0) return;
            view.cursorStack.pop();
            const previous =
              view.cursorStack.length > 0 ? view.cursorStack[view.cursorStack.length - 1] : null;
            void loadPage(previous, ctx);
          },
        },
        'Previous',
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--secondary btn--sm',
          'aria-disabled': view.nextCursor ? null : 'true',
          onClick: () => {
            if (!view.nextCursor) return;
            view.cursorStack.push(view.nextCursor);
            void loadPage(view.nextCursor, ctx);
          },
        },
        'Next',
      ),
    );
  }
}

/**
 * One memory, rendered from fields the API actually returned.
 *
 * @param {import('../shape.js').MemoryRecord} memory
 * @param {import('../shape.js').NodeStatus | null} status
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {HTMLElement}
 */
function memoryRow(memory, status, ctx) {
  const cid = memory.cid;
  const detailId = 'memory-detail-' + ++rowSeq;
  const detail = el('div', { id: detailId, class: 'stack' });
  detail.hidden = !(cid && view.expanded.has(cid));

  const toggle = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--ghost btn--sm',
      'aria-expanded': detail.hidden ? 'false' : 'true',
      'aria-controls': detailId,
      onClick: () => {
        const nowOpen = detail.hidden;
        detail.hidden = !nowOpen;
        toggle.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
        if (!cid) return;
        if (nowOpen) {
          view.expanded.add(cid);
          void loadDetail(cid, detail, ctx);
        } else {
          view.expanded.delete(cid);
        }
      },
    },
    'Details',
  );

  const gateway = gatewayUrl(status ? status.ipfs.gateway : null, cid);
  const txUrl = explorerTxUrl(status ? status.chain.explorerBase : null, memory.txHash);

  return el(
    'article',
    { class: 'memory-row' },
    el(
      'div',
      { class: 'memory-row__head' },
      idChip({ value: cid, display: cid ? formatCid(cid) : undefined, what: 'CID' }),
      memory.encrypted === true
        ? statusPill('info', 'Encrypted')
        : memory.encrypted === false
          ? statusPill('warn', 'Plaintext')
          : statusPill('neutral', 'Encryption not reported'),
      txUrl ? extLink(txUrl, 'On-chain proof') : null,
      // A public gateway is opened only by an explicit click. The page itself
      // never fetches one: that would leak every viewer's IP and the CIDs they
      // read to a third party, and is blocked by connect-src anyway.
      gateway ? extLink(gateway, 'IPFS gateway') : null,
      toggle,
    ),
    el(
      'div',
      { class: 'memory-row__meta' },
      el('span', null, memory.model ?? 'model not reported'),
      el('span', null, memory.dims === null ? EMPTY : formatNumber(memory.dims, 0) + ' dims'),
      el('span', null, memory.size === null ? EMPTY : formatBytes(memory.size)),
      timeAgo(memory.createdAt),
    ),
    memory.preview
      ? el('p', { class: 'truncate' }, memory.preview)
      : el(
          'p',
          { class: 'text-muted' },
          memory.encrypted === false
            ? 'The node returned no preview for this memory.'
            : 'Encrypted at rest. This console does not hold the decryption key and shows no plaintext.',
        ),
    detail,
  );
}

/**
 * Load the full record for one CID, lazily, when its disclosure is opened.
 *
 * @param {string} cid
 * @param {HTMLElement} slot
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {Promise<void>}
 */
async function loadDetail(cid, slot, ctx) {
  mountNodes(slot, loadingBlock('memory detail', 'text', 3));
  try {
    const raw = await getMemory(cid, { signal: view.abort ? view.abort.signal : undefined });
    const memory = normalizeMemory(raw);
    mountNodes(
      slot,
      kvList([
        ['Agent', memory.agent ?? EMPTY],
        ['Model', memory.model ?? EMPTY],
        ['Dimensions', memory.dims === null ? EMPTY : formatNumber(memory.dims, 0)],
        ['Encrypted', memory.encrypted === null ? EMPTY : memory.encrypted ? 'Yes' : 'No'],
        ['Block', memory.blockNumber === null ? EMPTY : formatNumber(memory.blockNumber, 0)],
        ['Transaction', memory.txHash ?? EMPTY],
        ['Pinned', timeAgo(memory.createdAt)],
      ]),
      el(
        'details',
        null,
        el('summary', null, 'Raw record'),
        // textContent, always: this is remote JSON and it is rendered as text.
        el('pre', { class: 'mono break-all' }, JSON.stringify(raw, null, 2)),
      ),
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') return;
    mountNodes(
      slot,
      errorState(error, () => void loadDetail(cid, slot, ctx), 'this memory'),
    );
  }
}
