/**
 * Shared view primitives.
 *
 * Everything the five views draw more than once lives here: cards, stat tiles,
 * status pills, skeletons, empty and error states, copy buttons, key/value
 * lists, tables, the commit stepper, and the modal. The point is not brevity —
 * it is that "what a loading panel looks like" and "what a failed panel looks
 * like" are decided ONCE. The audit's finding that five async regions had no
 * loading state, no empty state and no error state between them is a direct
 * consequence of every panel having hand-rolled its own.
 *
 * Two invariants hold in every function below.
 *
 *   - Nodes are built with `dom.el`, which throws on `html:` and routes every
 *     URL through `sanitizeUrl`. There is no string-to-markup path anywhere in
 *     this file, so no server field can become an element.
 *   - Class names come from `css/components.css`; no colour, size or spacing
 *     literal appears here. A theme change repaints without a re-render.
 *
 * @module ui
 */

import { announce, el, extLink, on, qsa, svg } from './dom.js';
import { copyToClipboard, EMPTY, formatDateTime, formatRelative } from './format.js';
import { ApiError } from './api.js';

/* ==================================================================== *
 * Icons
 *
 * Inline paths rather than an icon font: a font is a network request, a FOUT
 * and a screen-reader hazard. Each is aria-hidden and inherits currentColor.
 * ==================================================================== */

/**
 * @param {string} pathData
 * @param {number} [size]
 * @returns {SVGElement}
 */
export function icon(pathData, size = 16) {
  return svg(
    'svg',
    {
      class: 'icon',
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.7',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    svg('path', { d: pathData }),
  );
}

export const ICONS = Object.freeze({
  copy: 'M9 9h9v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9ZM7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1',
  check: 'm5 13 4 4L19 7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4-4',
  refresh: 'M20 11a8 8 0 1 0-.7 4.3M20 4v7h-7',
  chevron: 'm9 6 6 6-6 6',
  external: 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
  database:
    'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7',
});

/* ==================================================================== *
 * Cards and section headings
 * ==================================================================== */

/**
 * A titled card. The heading level is a parameter because a card nested inside
 * another labelled region must not restart the outline at `h2`.
 *
 * @param {object} spec
 * @param {string} [spec.id]
 * @param {string} [spec.title]
 * @param {'h2'|'h3'|'h4'} [spec.level]
 * @param {string} [spec.hint] secondary line under the title
 * @param {unknown} [spec.actions] nodes for the header's right-hand side
 * @param {unknown} [spec.children]
 * @param {string} [spec.className]
 * @returns {HTMLElement}
 */
export function card(spec) {
  const level = spec.level ?? 'h2';
  const head =
    spec.title || spec.actions
      ? el(
          'div',
          { class: 'card__header' },
          el(
            'div',
            null,
            spec.title ? el(level, { class: 'card__title' }, spec.title) : null,
            spec.hint ? el('p', { class: 'card__hint' }, spec.hint) : null,
          ),
          spec.actions ? el('div', { class: 'card__actions' }, spec.actions) : null,
        )
      : null;

  return el(
    'section',
    {
      class: ['card', spec.className],
      id: spec.id,
      'aria-labelledby': spec.title && spec.id ? spec.id + '-title' : null,
    },
    head ? decorateTitle(head, spec.id) : null,
    spec.children,
  );
}

/**
 * Give the card's title an id so the section can be labelled by it. Done here
 * rather than at the call site so the two can never fall out of step.
 *
 * @param {HTMLElement} head
 * @param {string | undefined} cardId
 * @returns {HTMLElement}
 */
function decorateTitle(head, cardId) {
  if (!cardId) return head;
  const title = head.querySelector('.card__title');
  if (title) title.id = cardId + '-title';
  return head;
}

/**
 * @param {string} title
 * @param {unknown} [actions]
 * @param {'h2'|'h3'} [level]
 * @returns {HTMLElement}
 */
export function sectionHead(title, actions, level = 'h2') {
  return el(
    'div',
    { class: 'section-head' },
    el(level, null, title),
    actions ? el('div', { class: 'section-head__actions' }, actions) : null,
  );
}

/* ==================================================================== *
 * Pills and badges
 * ==================================================================== */

/** @typedef {'neutral'|'success'|'warn'|'danger'|'info'} Tone */

/**
 * A status chip whose TEXT carries the status. Colour is a second channel, not
 * the only one — the console it replaces conveyed trust purely as a colour and
 * a bare emoji, which fails WCAG 1.4.1 and reads as "check mark button" aloud.
 *
 * @param {Tone} tone
 * @param {string} label
 * @param {{ pulse?: boolean, id?: string, title?: string }} [opts]
 * @returns {HTMLElement}
 */
export function statusPill(tone, label, opts = {}) {
  return el(
    'span',
    {
      class: ['pill', 'pill--' + tone, opts.pulse ? 'pill--pulse' : null],
      id: opts.id,
      title: opts.title,
    },
    el('span', { class: 'pill__dot', 'aria-hidden': 'true' }),
    el('span', { class: 'pill__label' }, label),
  );
}

/**
 * Map a readiness check status onto a pill tone.
 *
 * @param {'ok'|'warn'|'fail'|'unknown'} status
 * @returns {Tone}
 */
export function toneForCheck(status) {
  if (status === 'ok') return 'success';
  if (status === 'warn') return 'warn';
  if (status === 'fail') return 'danger';
  return 'neutral';
}

/**
 * @param {string} label
 * @param {'brand'|'accent'|'teal'|null} [variant]
 * @returns {HTMLElement}
 */
export function badge(label, variant) {
  return el('span', { class: ['badge', variant ? 'badge--' + variant : null] }, label);
}

/* ==================================================================== *
 * Stat tiles
 * ==================================================================== */

/**
 * A KPI tile.
 *
 * `value` is a node or a string. A missing value renders the em dash from
 * format.js rather than a zero: "no data yet" and "zero" are different facts
 * and an operator must be able to tell them apart at a glance.
 *
 * @param {object} spec
 * @param {string} [spec.id]
 * @param {string} spec.label
 * @param {unknown} [spec.value]
 * @param {string} [spec.unit]
 * @param {string} [spec.meta]
 * @param {unknown} [spec.spark] a chart element from charts.js
 * @param {boolean} [spec.loading]
 * @returns {HTMLElement}
 */
export function statTile(spec) {
  const body = spec.loading
    ? el('div', { class: 'skeleton skeleton--title' })
    : el(
        'div',
        { class: 'stat__value' },
        spec.value === null || spec.value === undefined || spec.value === '' ? EMPTY : spec.value,
        spec.unit ? el('span', { class: 'stat__unit' }, spec.unit) : null,
      );

  return el(
    'div',
    { class: 'stat', id: spec.id },
    el('div', { class: 'stat__label' }, spec.label),
    body,
    spec.meta ? el('div', { class: 'stat__meta' }, spec.meta) : null,
    spec.spark ? el('div', { class: 'stat__spark' }, spec.spark) : null,
  );
}

/**
 * A definition row inside a card: label on the left, value on the right.
 *
 * @param {string} label
 * @param {unknown} value
 * @returns {HTMLElement}
 */
export function statRow(label, value) {
  return el(
    'div',
    { class: 'stat__row' },
    el('span', { class: 'text-muted' }, label),
    el('span', null, value === null || value === undefined ? EMPTY : value),
  );
}

/* ==================================================================== *
 * Key/value lists
 * ==================================================================== */

/**
 * @param {Array<[string, unknown]>} pairs
 * @param {string} [id]
 * @returns {HTMLElement}
 */
export function kvList(pairs, id) {
  /** @type {unknown[]} */
  const children = [];
  for (const [term, value] of pairs) {
    children.push(el('dt', null, term));
    children.push(el('dd', null, value === null || value === undefined ? EMPTY : value));
  }
  return el('dl', { class: 'kv', id }, children);
}

/* ==================================================================== *
 * Copy button and identifier chips
 * ==================================================================== */

/**
 * Copy-to-clipboard with a transient, ANNOUNCED confirmation.
 *
 * The visual tick alone is invisible to a screen-reader user, and swapping the
 * button's own label would move the accessible name of the control under the
 * user's finger mid-interaction. So the label is stable, the tick is
 * decorative, and the outcome goes to the polite live region.
 *
 * @param {string | null} value
 * @param {{ label?: string, what?: string }} [opts]
 * @returns {HTMLElement | null} null when there is nothing to copy
 */
export function copyButton(value, opts = {}) {
  if (typeof value !== 'string' || value === '') return null;
  const what = opts.what ?? 'value';
  /** @type {number | undefined} */
  let resetTimer;

  const button = el(
    'button',
    {
      type: 'button',
      class: 'copy-btn',
      'aria-label': opts.label ?? 'Copy ' + what,
      title: opts.label ?? 'Copy ' + what,
      onClick: async () => {
        const ok = await copyToClipboard(value);
        button.classList.toggle('copy-btn--copied', ok);
        announce(
          ok ? what + ' copied to clipboard' : 'Copy failed. Select the text and press Ctrl+C.',
        );
        if (resetTimer !== undefined) window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => button.classList.remove('copy-btn--copied'), 1600);
      },
    },
    icon(ICONS.copy, 14),
  );
  return button;
}

/**
 * A monospace identifier chip: optional label, a truncated value with the full
 * string in `title`, and a copy button.
 *
 * @param {object} spec
 * @param {string} [spec.label]
 * @param {string | null} spec.value the full value; also what gets copied
 * @param {string} [spec.display] the shortened form to show
 * @param {string} [spec.what] noun for the copy button's label
 * @param {boolean} [spec.block]
 * @returns {HTMLElement}
 */
export function idChip(spec) {
  const value = spec.value;
  return el(
    'span',
    { class: ['chip', spec.block ? 'chip--block' : null] },
    spec.label ? el('span', { class: 'chip__label' }, spec.label) : null,
    el(
      'span',
      { class: 'chip__value', title: value ?? undefined },
      value === null ? EMPTY : (spec.display ?? value),
    ),
    copyButton(value, { what: spec.what ?? spec.label ?? 'value' }),
  );
}

/**
 * An address rendered as a chip plus, when the node told us which explorer
 * serves its chain, a link out to it. `explorerAddressUrl` returns null for an
 * unknown chain and this renders no link at all rather than a plausible-looking
 * link to the wrong network.
 *
 * @param {string | null} address
 * @param {object} [opts]
 * @param {string | null} [opts.explorerUrl] a fully built explorer URL
 * @param {string} [opts.display]
 * @param {string} [opts.label]
 * @returns {HTMLElement}
 */
export function addressChip(address, opts = {}) {
  return el(
    'span',
    { class: 'stack' },
    idChip({
      label: opts.label,
      value: address,
      display: opts.display,
      what: opts.label ?? 'address',
    }),
    opts.explorerUrl ? extLink(opts.explorerUrl, 'Explorer') : null,
  );
}

/* ==================================================================== *
 * Skeletons
 * ==================================================================== */

/**
 * @param {'text'|'title'|'pill'|'card'|'chart'|'row'} kind
 * @param {number} [count]
 * @returns {HTMLElement}
 */
export function skeleton(kind, count = 1) {
  return el(
    'div',
    { class: 'stack', 'aria-hidden': 'true' },
    Array.from({ length: Math.max(1, count) }, () =>
      el('div', { class: ['skeleton', 'skeleton--' + kind] }),
    ),
  );
}

/**
 * A skeleton with an accessible name, for a whole panel.
 *
 * `aria-busy` on the container is what stops a screen reader from announcing
 * every placeholder as it appears; the single "Loading" label is what tells
 * the user something is happening at all.
 *
 * @param {string} what
 * @param {'text'|'title'|'pill'|'card'|'chart'|'row'} [kind]
 * @param {number} [count]
 * @returns {HTMLElement}
 */
export function loadingBlock(what, kind = 'row', count = 3) {
  return el(
    'div',
    { role: 'status', 'aria-busy': 'true', class: 'stack' },
    el('span', { class: 'sr-only' }, 'Loading ' + what + '…'),
    skeleton(kind, count),
  );
}

/* ==================================================================== *
 * Empty and error states
 * ==================================================================== */

/**
 * A purposeful empty state: what is missing, why, and the one thing to do
 * about it. A blank panel is not an empty state.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} [spec.body]
 * @param {string} [spec.command] a shell command, shown copyable
 * @param {string} [spec.actionLabel]
 * @param {() => void} [spec.onAction]
 * @param {boolean} [spec.chart] use the shorter chart-sized padding
 * @returns {HTMLElement}
 */
export function emptyState(spec) {
  return el(
    'div',
    { class: ['empty', spec.chart ? 'empty--chart' : null] },
    el('p', { class: 'empty__title' }, spec.title),
    spec.body ? el('p', { class: 'empty__body' }, spec.body) : null,
    spec.command
      ? el(
          'span',
          { class: 'empty__cmd' },
          el('code', null, spec.command),
          copyButton(spec.command, { what: 'command' }),
        )
      : null,
    spec.actionLabel && spec.onAction
      ? el(
          'button',
          { type: 'button', class: 'btn btn--secondary btn--sm', onClick: spec.onAction },
          spec.actionLabel,
        )
      : null,
  );
}

/** Ready-made empty states, so the same situation reads the same everywhere. */
export const empties = Object.freeze({
  /**
   * @param {() => void} [onCompose]
   * @returns {HTMLElement}
   */
  noMemories(onCompose) {
    return emptyState({
      title: 'No memories committed yet',
      body: 'Every committed memory is embedded locally, encrypted, pinned to IPFS and proved on chain. Nothing has been committed from this node.',
      actionLabel: onCompose ? 'Compose one' : undefined,
      onAction: onCompose,
    });
  },

  /**
   * @returns {HTMLElement}
   */
  noSimulation() {
    return emptyState({
      title: 'No benchmark data on this node',
      body: 'simulation-results.json is generated, not committed, so a fresh clone has none. Run the simulation to populate this panel.',
      command: 'npm run simulate',
      chart: true,
    });
  },

  /**
   * @param {string} what
   * @returns {HTMLElement}
   */
  notConfigured(what) {
    return emptyState({
      title: what + ' is not configured on this node',
      body: 'The node is running in a reduced mode. Configure it in the environment and restart to enable this panel.',
    });
  },

  /**
   * @param {string} query
   * @returns {HTMLElement}
   */
  noSearchResults(query) {
    return emptyState({
      title: 'No matches for “' + query + '”',
      body: 'Nothing in this node’s ledger is close enough to the query. Try broader wording, or commit more memories first.',
    });
  },

  /**
   * @returns {HTMLElement}
   */
  noReputation() {
    return emptyState({
      title: 'No trust events yet',
      body: 'Endorsements and reports appear here once agents have vouched for — or flagged — one another on chain.',
    });
  },
});

/**
 * The error state that replaces a blank panel.
 *
 * `ApiError.userMessage` is written for a human; `code`, HTTP status and the
 * request id are shown underneath for whoever has to read the node's logs. The
 * retry button is the whole point: the old dashboard's only recovery path was
 * reloading the page.
 *
 * @param {unknown} error
 * @param {() => void} [onRetry]
 * @param {string} [what] e.g. 'memories'
 * @returns {HTMLElement}
 */
export function errorState(error, onRetry, what) {
  const isApi = error instanceof ApiError;
  const headline = isApi
    ? error.userMessage
    : error instanceof Error
      ? error.message
      : 'Something went wrong.';
  /** @type {string[]} */
  const details = [];
  if (isApi) {
    if (error.code) details.push(error.code);
    if (error.status) details.push('HTTP ' + error.status);
    if (error.requestId) details.push('request ' + error.requestId);
  }

  return el(
    'div',
    { class: 'callout callout--danger', role: 'group', 'aria-label': 'Error' },
    el('p', null, what ? 'Could not load ' + what + '. ' + headline : headline),
    details.length > 0 ? el('p', { class: 'mono text-muted' }, details.join(' · ')) : null,
    onRetry
      ? el(
          'button',
          { type: 'button', class: 'btn btn--secondary btn--sm', onClick: onRetry },
          'Try again',
        )
      : null,
  );
}

/* ==================================================================== *
 * Tables
 * ==================================================================== */

/**
 * A plain, scroll-contained data table.
 *
 * Wide content scrolls inside its own container rather than pushing the page
 * sideways, the caption is a real `<caption>` so the table has an accessible
 * name, and row headers use `scope` so a screen reader can say which row a
 * cell belongs to.
 *
 * @param {object} spec
 * @param {string} spec.caption
 * @param {boolean} [spec.captionHidden]
 * @param {readonly string[]} spec.headers
 * @param {ReadonlyArray<readonly unknown[]>} spec.rows cells: nodes or strings
 * @param {readonly number[]} [spec.numericColumns] indices rendered tabular
 * @param {boolean} [spec.rowHeaders] treat the first cell of each row as a th
 * @returns {HTMLElement}
 */
export function dataTable(spec) {
  const numeric = new Set(spec.numericColumns ?? []);

  const head = el(
    'thead',
    null,
    el(
      'tr',
      null,
      spec.headers.map((header, index) =>
        el('th', { scope: 'col', class: numeric.has(index) ? 'table__num' : null }, header),
      ),
    ),
  );

  const body = el(
    'tbody',
    null,
    spec.rows.map((row) =>
      el(
        'tr',
        null,
        row.map((cell, index) => {
          const content = cell === null || cell === undefined || cell === '' ? EMPTY : cell;
          if (index === 0 && spec.rowHeaders) return el('th', { scope: 'row' }, content);
          return el('td', { class: numeric.has(index) ? 'table__num' : null }, content);
        }),
      ),
    ),
  );

  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'table table--zebra' },
      el('caption', { class: spec.captionHidden ? 'sr-only' : null }, spec.caption),
      head,
      body,
    ),
  );
}

/* ==================================================================== *
 * Forms
 * ==================================================================== */

/**
 * A labelled field with hint, counter slot and an error slot.
 *
 * The label is a real `<label for>`, never a placeholder: a placeholder is the
 * accessible name only until the user types, at which point the field's
 * purpose disappears for exactly the people who most needed it.
 *
 * @param {object} spec
 * @param {string} spec.id the control's id
 * @param {string} spec.label
 * @param {HTMLElement} spec.control
 * @param {string} [spec.hint]
 * @param {unknown} [spec.headExtra] e.g. a character counter
 * @param {boolean} [spec.required]
 * @returns {{ node: HTMLElement, errorNode: HTMLElement, setError: (message: string|null) => void }}
 */
export function field(spec) {
  const errorNode = el('p', { class: 'field__error', id: spec.id + '-error', role: 'alert' });
  errorNode.hidden = true;

  const node = el(
    'div',
    { class: 'field' },
    el(
      'div',
      { class: 'field__head' },
      el(
        'label',
        { class: 'label', for: spec.id },
        spec.label,
        spec.required ? el('span', { class: 'label__required' }, ' (required)') : null,
      ),
      spec.headExtra ?? null,
    ),
    spec.control,
    spec.hint ? el('p', { class: 'field__hint', id: spec.id + '-hint' }, spec.hint) : null,
    errorNode,
  );

  return {
    node,
    errorNode,
    setError(message) {
      errorNode.textContent = message ?? '';
      errorNode.hidden = message === null || message === undefined || message === '';
      if (message) spec.control.setAttribute('aria-invalid', 'true');
      else spec.control.removeAttribute('aria-invalid');
    },
  };
}

/**
 * A checkbox styled as a switch. A real `<input type="checkbox">` because that
 * is what gives keyboard operation, form participation and the correct role
 * for free; `<div role="switch">` gets none of them.
 *
 * @param {object} spec
 * @param {string} spec.id
 * @param {string} spec.label
 * @param {boolean} [spec.checked]
 * @param {(checked: boolean) => void} [spec.onChange]
 * @returns {{ node: HTMLElement, input: HTMLInputElement }}
 */
export function switchControl(spec) {
  const input = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'checkbox',
      class: 'switch__input',
      id: spec.id,
      checked: spec.checked === true,
      onChange: () => {
        if (spec.onChange) spec.onChange(input.checked);
      },
    })
  );
  const node = el(
    'label',
    { class: 'switch', for: spec.id },
    input,
    el('span', { class: 'switch__track', 'aria-hidden': 'true' }),
    el('span', null, spec.label),
  );
  return { node, input };
}

/* ==================================================================== *
 * Capability gating
 * ==================================================================== */

/**
 * True when main.js has gated this control because the node cannot perform the
 * action. Handlers must consult it: the control stays FOCUSABLE (so a screen
 * reader can find it and read why it is unavailable, which `disabled` makes
 * impossible), which means the click still arrives.
 *
 * @param {Element | null | undefined} node
 * @returns {boolean}
 */
export function isGated(node) {
  return !!node && node.getAttribute('aria-disabled') === 'true';
}

/**
 * Put a control into or out of a busy state without ever removing it from the
 * accessibility tree — the old console set `disabled = true` on the button the
 * user had just activated, which drops focus to `<body>` mid-interaction.
 *
 * @param {HTMLElement} button
 * @param {boolean} busy
 * @param {string} [busyLabel]
 * @returns {void}
 */
export function setButtonBusy(button, busy, busyLabel) {
  button.dataset.busy = busy ? 'true' : 'false';
  if (busy) {
    button.setAttribute('aria-disabled', 'true');
    if (busyLabel) button.setAttribute('aria-label', busyLabel);
  } else {
    button.removeAttribute('aria-disabled');
    button.removeAttribute('aria-label');
  }
}

/* ==================================================================== *
 * Pipeline stepper
 * ==================================================================== */

/**
 * @typedef {'pending'|'active'|'done'|'failed'|'skipped'} StepState
 */

/**
 * The commit pipeline, drawn as five states rather than one opaque spinner.
 *
 * The repo's own benchmark data records end-to-end latencies above 24 seconds.
 * A user staring at an unlabelled spinner for 24 seconds cannot tell a slow
 * IPFS pin from a hung transaction, so each stage carries its own state and
 * elapsed time.
 *
 * State lives in `data-state`, which drives both the CSS and the marker glyph,
 * so the visual and the announced state cannot drift apart.
 *
 * @param {ReadonlyArray<{ id: string, label: string }>} steps
 * @returns {{ node: HTMLElement, set: (id: string, state: StepState, detail?: string) => void,
 *   startAll: () => void, reset: () => void, failFrom: (id: string, detail?: string) => void }}
 */
export function createStepper(steps) {
  /** @type {Map<string, { row: HTMLElement, time: HTMLElement, label: HTMLElement, startedAt: number|null }>} */
  const rows = new Map();

  const node = el(
    'ol',
    { class: 'stepper' },
    steps.map((step, index) => {
      const time = el('span', { class: 'step__time' });
      const label = el('span', { class: 'step__label' }, step.label);
      const row = el(
        'li',
        { class: 'step', dataset: { state: 'pending', step: step.id } },
        el('span', { class: 'step__marker', 'aria-hidden': 'true' }, String(index + 1)),
        label,
        time,
      );
      rows.set(step.id, { row, time, label, startedAt: null });
      return row;
    }),
  );

  /**
   * @param {string} id
   * @param {StepState} state
   * @param {string} [detail]
   * @returns {void}
   */
  function set(id, state, detail) {
    const entry = rows.get(id);
    if (!entry) return;
    entry.row.dataset.state = state;

    if (state === 'active') entry.startedAt = Date.now();
    if ((state === 'done' || state === 'failed') && entry.startedAt !== null) {
      entry.time.textContent = String(Date.now() - entry.startedAt) + ' ms';
    }
    if (detail) entry.time.textContent = detail;

    // The status is written into the row's own accessible text rather than
    // into a live region: the stepper changes five times in twenty seconds,
    // and announcing each one would talk over everything else the app says.
    entry.row.setAttribute('aria-label', entry.label.textContent + ': ' + state);
  }

  return {
    node,
    set,
    startAll() {
      for (const [id] of rows) set(id, 'pending');
    },
    reset() {
      for (const [, entry] of rows) {
        entry.row.dataset.state = 'pending';
        entry.time.textContent = '';
        entry.startedAt = null;
      }
    },
    failFrom(id, detail) {
      let reached = false;
      for (const [stepId] of rows) {
        if (stepId === id) reached = true;
        if (!reached) continue;
        set(stepId, stepId === id ? 'failed' : 'skipped', stepId === id ? detail : undefined);
      }
    },
  };
}

/* ==================================================================== *
 * Modals
 * ==================================================================== */

/** The stack of open dialogs, so nesting restores focus in the right order. */
/** @type {Array<{ close: () => void }>} */
const modalStack = [];

/**
 * Open a focus-trapped modal dialog.
 *
 * Everything a `window.confirm()` cannot do and this must: it is styled, it is
 * dismissible with Escape, focus is trapped inside while open and returned to
 * the element that opened it on close, and the page behind it is marked
 * `inert` so a screen reader cannot wander out of the dialog.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {unknown} spec.body
 * @param {unknown} [spec.footer] the action buttons
 * @param {boolean} [spec.wide]
 * @param {() => void} [spec.onClose]
 * @returns {{ close: () => void, root: HTMLElement }}
 */
export function openModal(spec) {
  const host = document.getElementById('modal-root');
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const appShell = document.getElementById('app');

  const titleId = 'modal-title-' + modalStack.length;
  let closed = false;

  const dialog = el(
    'div',
    {
      class: ['modal', spec.wide ? 'modal--wide' : null],
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
    },
    el(
      'div',
      { class: 'modal__head' },
      el('h2', { class: 'modal__title', id: titleId }, spec.title),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--ghost btn--icon',
          'aria-label': 'Close dialog',
          onClick: () => close(),
        },
        icon('M6 6l12 12M18 6 6 18'),
      ),
    ),
    el('div', { class: 'modal__body' }, spec.body),
    spec.footer ? el('div', { class: 'modal__foot' }, spec.footer) : null,
  );

  const scrim = el(
    'div',
    {
      class: 'modal-scrim',
      onMousedown: (/** @type {Event} */ event) => {
        if (event.target === scrim) close();
      },
    },
    dialog,
  );

  /**
   * @param {KeyboardEvent} event
   * @returns {void}
   */
  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = qsa(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      dialog,
    ).filter((node) => node instanceof HTMLElement && node.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = /** @type {HTMLElement} */ (focusable[0]);
    const last = /** @type {HTMLElement} */ (focusable[focusable.length - 1]);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const detachKeys = on(document, 'keydown', /** @type {EventListener} */ (onKeydown), true);

  /**
   * @returns {void}
   */
  function close() {
    if (closed) return;
    closed = true;
    detachKeys();
    scrim.remove();
    const index = modalStack.findIndex((entry) => entry.close === close);
    if (index !== -1) modalStack.splice(index, 1);
    if (modalStack.length === 0 && appShell) appShell.removeAttribute('inert');
    if (opener && document.contains(opener)) opener.focus();
    if (spec.onClose) spec.onClose();
  }

  if (host) host.appendChild(scrim);
  else document.body.appendChild(scrim);
  if (appShell) appShell.setAttribute('inert', '');
  modalStack.push({ close });

  // Focus the first control in the dialog, not the dialog itself: a keyboard
  // user should land on something actionable.
  const target = qsa('button, [href], input, select, textarea', dialog).find(
    (node) => node instanceof HTMLElement,
  );
  if (target instanceof HTMLElement) target.focus();

  return { close, root: dialog };
}

/**
 * A confirmation dialog that resolves to a boolean.
 *
 * `requireTyped` exists for irreversible, publicly attributable, on-chain
 * actions — filing a report against another agent is one. Typing the word is
 * friction on purpose: it makes the operator restate the intent, which a
 * reflexive click on "OK" does not.
 *
 * @param {object} spec
 * @param {string} spec.title
 * @param {string} spec.message
 * @param {readonly string[]} [spec.consequences] bulleted, shown before the buttons
 * @param {string} [spec.confirmLabel]
 * @param {string} [spec.cancelLabel]
 * @param {boolean} [spec.danger]
 * @param {string} [spec.requireTyped] a word the user must type verbatim
 * @returns {Promise<boolean>}
 */
export function confirmDialog(spec) {
  return new Promise((resolve) => {
    let settled = false;
    /**
     * @param {boolean} value
     * @returns {void}
     */
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    /** @type {HTMLInputElement | null} */
    let typedInput = null;

    const confirmButton = el(
      'button',
      {
        type: 'button',
        class: ['btn', spec.danger ? 'btn--danger' : 'btn--primary'],
        onClick: () => {
          if (spec.requireTyped && typedInput && typedInput.value.trim() !== spec.requireTyped) {
            typedInput.setAttribute('aria-invalid', 'true');
            typedInput.focus();
            return;
          }
          settle(true);
          handle.close();
        },
      },
      spec.confirmLabel ?? 'Confirm',
    );

    if (spec.requireTyped) {
      confirmButton.setAttribute('aria-disabled', 'true');
      typedInput = /** @type {HTMLInputElement} */ (
        el('input', {
          type: 'text',
          class: 'input input--mono',
          id: 'confirm-typed',
          autocomplete: 'off',
          'aria-describedby': 'confirm-typed-hint',
          onInput: () => {
            const matches = typedInput !== null && typedInput.value.trim() === spec.requireTyped;
            if (matches) confirmButton.removeAttribute('aria-disabled');
            else confirmButton.setAttribute('aria-disabled', 'true');
            if (typedInput) typedInput.removeAttribute('aria-invalid');
          },
        })
      );
    }

    const handle = openModal({
      title: spec.title,
      body: el(
        'div',
        { class: 'stack' },
        el('p', null, spec.message),
        spec.consequences && spec.consequences.length > 0
          ? el(
              'ul',
              null,
              spec.consequences.map((line) => el('li', null, line)),
            )
          : null,
        typedInput
          ? el(
              'div',
              { class: 'field' },
              el(
                'label',
                { class: 'label', for: 'confirm-typed' },
                'Type ' + spec.requireTyped + ' to continue',
              ),
              typedInput,
              el(
                'p',
                { class: 'field__hint', id: 'confirm-typed-hint' },
                'This action is recorded on a public chain and cannot be withdrawn.',
              ),
            )
          : null,
      ),
      footer: el(
        'div',
        { class: 'card__actions' },
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--secondary',
            onClick: () => {
              settle(false);
              handle.close();
            },
          },
          spec.cancelLabel ?? 'Cancel',
        ),
        confirmButton,
      ),
      onClose: () => settle(false),
    });
  });
}

/* ==================================================================== *
 * Time
 * ==================================================================== */

/**
 * A relative timestamp with the absolute one in `title` and in a `<time>`
 * element's `datetime`, so hover, copy and assistive tech all get the precise
 * value while the glanceable text stays short.
 *
 * @param {number | null} epochMs
 * @returns {HTMLElement}
 */
export function timeAgo(epochMs) {
  if (epochMs === null || !Number.isFinite(epochMs)) return el('span', null, EMPTY);
  const absolute = formatDateTime(epochMs);
  return el(
    'time',
    { datetime: new Date(epochMs).toISOString(), title: absolute },
    formatRelative(epochMs),
  );
}
