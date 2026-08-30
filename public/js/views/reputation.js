/**
 * Reputation: who is trusted, by whom, and the two on-chain actions that
 * change that.
 *
 * Every score and trusted flag on this page is READ from the node. The console
 * this replaces recomputed `(endorsers * 1000) / (1 + 3 * negatives)` and a
 * `>= 500` cutoff in the browser, duplicating ReputationManager.sol in a place
 * that could never be kept in step with it — and crashed outright on any event
 * naming an agent absent from the score list. There is no reputation
 * arithmetic in this file.
 *
 * Endorse and report are on-chain writes. Report in particular is a public,
 * permanent, attributable negative claim about another party, so it is gated
 * behind a typed confirmation rather than a click-through.
 *
 * @module views/reputation
 */

import { ApiError, endorse, getReputation, getSimulation, report } from '../api.js';
import { gauge, timelineChart, topologyGraph } from '../charts.js';
import { announce, el, extLink, mount as mountNodes } from '../dom.js';
import { EMPTY, explorerTxUrl, formatAddress, formatNumber } from '../format.js';
import {
  aggregateEdges,
  isAddress,
  normalizeReputation,
  normalizeSimulation,
  normalizeStatus,
} from '../shape.js';
import { store } from '../store.js';
import { toast } from '../toast.js';
import {
  addressChip,
  card,
  confirmDialog,
  dataTable,
  empties,
  errorState,
  field,
  idChip,
  isGated,
  loadingBlock,
  setButtonBusy,
  statRow,
  statusPill,
  timeAgo,
} from '../ui.js';

/** Reason strings are short by design: they go on chain and cost gas per byte. */
const MAX_REASON_CHARS = 200;

/** Above this many agents, per-agent dials stop being readable and are dropped. */
const MAX_GAUGES = 10;

/**
 * @typedef {object} RepViewState
 * @property {AbortController | null} abort
 * @property {(() => void)[]} teardown
 * @property {Record<string, HTMLElement | null>} slots
 * @property {Array<{ destroy?: () => void }>} charts
 * @property {ReturnType<typeof normalizeReputation> | null} data
 * @property {string} eventSource
 * @property {boolean} showEventTable
 * @property {'score'|'endorsements'|'reports'} sortKey
 */

/** @type {RepViewState} */
let view = freshState();

/**
 * @returns {RepViewState}
 */
function freshState() {
  return {
    abort: null,
    teardown: [],
    slots: {},
    charts: [],
    data: null,
    eventSource: '',
    showEventTable: false,
    sortKey: 'score',
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
    scores: el('div'),
    actions: el('div'),
    timeline: el('div'),
    topology: el('div'),
  };
  view.slots = slots;

  mountNodes(
    container,
    el(
      'div',
      { class: 'stack' },
      el('h2', { class: 'sr-only', 'data-view-heading': 'true' }, 'Reputation'),
      slots.scores,
      slots.actions,
      el('div', { class: 'grid grid--2' }, slots.timeline, slots.topology),
    ),
  );

  for (const [key, slot] of Object.entries(slots)) {
    mountNodes(
      slot,
      card({ title: titleFor(key), children: loadingBlock(titleFor(key), 'row', 3) }),
    );
  }

  void load(ctx);

  view.teardown.push(
    store.select(
      (state) => state.status.data,
      () => renderActions(ctx),
    ),
  );
}

/**
 * @param {string} key
 * @returns {string}
 */
function titleFor(key) {
  if (key === 'scores') return 'Agent reputation';
  if (key === 'actions') return 'Endorse or report an agent';
  if (key === 'timeline') return 'Trust events';
  return 'Swarm topology';
}

/**
 * @returns {void}
 */
export function unmount() {
  if (view.abort) view.abort.abort();
  for (const dispose of view.teardown) dispose();
  destroyCharts();
  view = freshState();
}

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
export function refresh(ctx) {
  void load(ctx);
}

/**
 * @returns {void}
 */
function destroyCharts() {
  for (const handle of view.charts) {
    if (handle && typeof handle.destroy === 'function') handle.destroy();
  }
  view.charts = [];
}

/* ==================================================================== *
 * Data
 * ==================================================================== */

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {Promise<void>}
 */
async function load(ctx) {
  const signal = view.abort ? view.abort.signal : undefined;
  try {
    const raw = await getReputation({ signal });
    view.data = normalizeReputation(raw);
    view.eventSource = 'on-chain trust events reported by this node';

    // A node with an empty ledger still has a benchmark file worth drawing, so
    // the simulation supplies the graph when the chain has nothing yet — and
    // the caption says which is on screen.
    if (view.data.events.length === 0 && view.data.entries.length === 0) {
      await loadSimulationFallback(signal);
    }
    renderAll(ctx);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') return;
    try {
      await loadSimulationFallback(signal);
      renderAll(ctx);
      toast.warning('Showing simulation data: the node’s reputation endpoint is unavailable.');
    } catch {
      const slot = view.slots.scores;
      if (slot) {
        mountNodes(
          slot,
          card({
            id: 'card-scores',
            title: 'Agent reputation',
            children: errorState(error, () => void load(ctx), 'reputation data'),
          }),
        );
      }
      for (const key of ['actions', 'timeline', 'topology']) {
        const other = view.slots[key];
        if (other) mountNodes(other);
      }
      renderActions(ctx);
    }
  }
}

/**
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
async function loadSimulationFallback(signal) {
  const raw = await getSimulation({ signal });
  const sim = normalizeSimulation(raw);
  view.data = {
    entries: sim.agents.map((agent) => ({
      address: agent.wallet ?? agent.id,
      label: agent.id,
      score: null,
      trusted: null,
      endorsements: null,
      reports: null,
    })),
    events: sim.events,
    thresholds: { trusted: null, max: null },
  };
  view.eventSource = 'the last local simulation run, not live chain data';
}

/* ==================================================================== *
 * Rendering
 * ==================================================================== */

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
function renderAll(ctx) {
  destroyCharts();
  renderScores();
  renderActions(ctx);
  renderTimeline();
  renderTopology();
}

/**
 * @returns {void}
 */
function renderScores() {
  const slot = view.slots.scores;
  if (!slot) return;
  const data = view.data;

  if (!data || data.entries.length === 0) {
    mountNodes(
      slot,
      card({ id: 'card-scores', title: 'Agent reputation', children: empties.noReputation() }),
    );
    return;
  }

  const status = store.getState().status.data
    ? normalizeStatus(store.getState().status.data)
    : null;

  const sorted = data.entries.slice().sort((a, b) => {
    const key = view.sortKey;
    return (b[key] ?? -Infinity) - (a[key] ?? -Infinity);
  });
  const withGauges = sorted.length <= MAX_GAUGES;

  const sortSelect = /** @type {HTMLSelectElement} */ (
    el(
      'select',
      {
        id: 'select-rep-sort',
        class: 'select',
        'aria-label': 'Sort agents by',
        onChange: () => {
          const value = sortSelect.value;
          view.sortKey = value === 'endorsements' || value === 'reports' ? value : 'score';
          renderScores();
        },
      },
      el('option', { value: 'score' }, 'Score'),
      el('option', { value: 'endorsements' }, 'Endorsements'),
      el('option', { value: 'reports' }, 'Reports'),
    )
  );
  sortSelect.value = view.sortKey;

  const tiles = sorted.map((entry) => {
    /** @type {HTMLElement | null} */
    let dial = null;
    if (withGauges && entry.score !== null) {
      const chart = gauge({
        value: entry.score,
        max: data.thresholds.max ?? 1000,
        min: 0,
        label: entry.label,
        title: 'Trust score for ' + entry.label,
        thresholds:
          data.thresholds.trusted === null
            ? []
            : [{ value: data.thresholds.trusted, label: 'Trusted' }],
      });
      view.charts.push(/** @type {{ destroy?: () => void }} */ (/** @type {unknown} */ (chart)));
      dial = chart;
    }

    return el(
      'article',
      { class: 'card card--tight' },
      el(
        'div',
        { class: 'memory-row__head' },
        entry.address && isAddress(entry.address)
          ? addressChip(entry.address, {
              display: formatAddress(entry.address),
              explorerUrl: agentExplorerUrl(status, entry.address),
              label: 'Agent',
            })
          : idChip({ value: entry.label, what: 'agent' }),
        entry.trusted === true
          ? statusPill('success', 'Trusted')
          : entry.trusted === false
            ? statusPill('warn', 'Untrusted')
            : statusPill('neutral', 'Not rated'),
      ),
      dial,
      statRow('Score', entry.score === null ? EMPTY : formatNumber(entry.score, 0)),
      statRow(
        'Endorsements',
        entry.endorsements === null ? EMPTY : formatNumber(entry.endorsements, 0),
      ),
      statRow('Reports', entry.reports === null ? EMPTY : formatNumber(entry.reports, 0)),
    );
  });

  mountNodes(
    slot,
    card({
      id: 'card-scores',
      title: 'Agent reputation',
      hint: 'Scores and the trusted flag are computed on chain and read here verbatim — the browser does no reputation arithmetic.',
      actions: sortSelect,
      children: el('div', { class: 'grid grid--agents' }, tiles),
    }),
  );
}

/**
 * @param {import('../shape.js').NodeStatus | null} status
 * @param {string} address
 * @returns {string | null}
 */
function agentExplorerUrl(status, address) {
  if (!status) return null;
  const base = status.chain.explorerBase;
  if (!base) return null;
  return base.replace(/\/+$/, '') + '/address/' + encodeURIComponent(address);
}

/**
 * The two write actions.
 *
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
function renderActions(ctx) {
  const slot = view.slots.actions;
  if (!slot) return;

  const status = store.getState().status.data
    ? normalizeStatus(store.getState().status.data)
    : null;
  const known = view.data ? view.data.entries : [];

  const otherInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'text',
      id: 'input-target-address',
      class: 'input input--mono',
      autocomplete: 'off',
      placeholder: '',
    })
  );
  const otherField = field({
    id: 'input-target-address',
    label: 'Agent address',
    control: otherInput,
    hint: 'A 40-character hex address prefixed with 0x.',
  });
  otherField.node.hidden = known.length > 0;

  const targetSelect = /** @type {HTMLSelectElement} */ (
    el(
      'select',
      {
        id: 'select-target',
        class: 'select',
        onChange: () => {
          otherField.node.hidden = targetSelect.value !== '__other';
          if (targetSelect.value === '__other') otherInput.focus();
        },
      },
      known
        .filter((entry) => typeof entry.address === 'string')
        .map((entry) =>
          el('option', { value: /** @type {string} */ (entry.address) }, entry.label),
        ),
      el('option', { value: '__other' }, 'Other address…'),
    )
  );
  if (known.length === 0) targetSelect.value = '__other';

  const reasonCounter = el('span', { class: 'counter' }, '0 / ' + MAX_REASON_CHARS);
  const reasonInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'text',
      id: 'input-reason',
      class: 'input',
      maxlength: String(MAX_REASON_CHARS),
      onInput: () => {
        reasonCounter.textContent = reasonInput.value.length + ' / ' + MAX_REASON_CHARS;
      },
    })
  );
  const reasonField = field({
    id: 'input-reason',
    label: 'Reason',
    required: true,
    control: reasonInput,
    headExtra: reasonCounter,
    hint: 'Stored on chain and publicly readable forever. Do not put anything private here.',
  });

  const endorseButton = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--primary',
      id: 'btn-endorse',
      dataset: { requires: 'chain write' },
    },
    'Endorse agent',
  );
  const reportButton = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--danger',
      id: 'btn-report',
      dataset: { requires: 'chain write' },
    },
    'Report agent',
  );

  /**
   * @param {'endorse'|'report'} kind
   * @param {HTMLElement} button
   * @returns {Promise<void>}
   */
  const submit = async (kind, button) => {
    if (isGated(button) || button.dataset.busy === 'true') return;

    const target =
      targetSelect.value === '__other' ? otherInput.value.trim() : targetSelect.value.trim();
    if (!isAddress(target)) {
      otherField.setError('Enter a valid 0x-prefixed 40-character address.');
      otherField.node.hidden = false;
      otherInput.focus();
      return;
    }
    otherField.setError(null);

    const reason = reasonInput.value.trim();
    if (reason === '') {
      reasonField.setError('A reason is required; it is what makes the claim auditable.');
      reasonInput.focus();
      return;
    }
    reasonField.setError(null);

    const confirmed = await confirmDialog({
      title: kind === 'endorse' ? 'Endorse this agent?' : 'File a report against this agent?',
      message:
        (kind === 'endorse'
          ? 'You are vouching for ' + formatAddress(target) + ' on chain.'
          : 'You are publicly accusing ' + formatAddress(target) + ' on chain.') +
        ' The reason you wrote is stored with it.',
      consequences: [
        'The transaction spends testnet gas from this node’s key.',
        'Your agent address is permanently attached to this claim.',
        'It is written to a public chain and cannot be deleted or edited.',
        kind === 'report'
          ? 'A report lowers the target’s score and is visible to every peer.'
          : 'An endorsement raises the target’s score and is visible to every peer.',
      ],
      confirmLabel: kind === 'endorse' ? 'Endorse' : 'File report',
      danger: kind === 'report',
      requireTyped: kind === 'report' ? 'REPORT' : undefined,
    });
    if (!confirmed) return;

    setButtonBusy(button, true, kind === 'endorse' ? 'Endorsing' : 'Reporting');
    try {
      const call = kind === 'endorse' ? endorse : report;
      const result = await call(
        { target, reason },
        { signal: view.abort ? view.abort.signal : undefined },
      );
      const txHash = typeof result.txHash === 'string' ? result.txHash : null;
      const txUrl = explorerTxUrl(status ? status.chain.explorerBase : null, txHash);
      toast.success(kind === 'endorse' ? 'Endorsement submitted' : 'Report submitted', {
        description: txHash ?? undefined,
        actionLabel: txUrl ? 'View transaction' : undefined,
        onAction: txUrl ? () => window.open(txUrl, '_blank', 'noopener,noreferrer') : undefined,
      });
      announce(kind === 'endorse' ? 'Endorsement submitted.' : 'Report submitted.');
      reasonInput.value = '';
      reasonCounter.textContent = '0 / ' + MAX_REASON_CHARS;
      void load(ctx);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'aborted') return;
      toast.error(error);
      announce('The transaction failed.', true);
    } finally {
      setButtonBusy(button, false);
    }
  };

  endorseButton.addEventListener('click', () => void submit('endorse', endorseButton));
  reportButton.addEventListener('click', () => void submit('report', reportButton));

  mountNodes(
    slot,
    card({
      id: 'card-trust-actions',
      title: 'Endorse or report an agent',
      hint: 'Both are transactions on the configured network. Neither can be reversed from this console.',
      children: el(
        'form',
        {
          id: 'form-trust',
          novalidate: true,
          onSubmit: (/** @type {Event} */ event) => event.preventDefault(),
        },
        el(
          'div',
          { class: 'stack' },
          field({ id: 'select-target', label: 'Target agent', control: targetSelect }).node,
          otherField.node,
          reasonField.node,
          el('div', { class: 'card__actions' }, endorseButton, reportButton),
          status && !status.chain.configured
            ? el(
                'p',
                { class: 'callout callout--warn' },
                'This node has no chain access configured, so neither action can be sent.',
              )
            : null,
        ),
      ),
    }),
  );
}

/**
 * @returns {void}
 */
function renderTimeline() {
  const slot = view.slots.timeline;
  if (!slot) return;
  const data = view.data;
  const events = data ? data.events : [];

  if (events.length === 0) {
    mountNodes(
      slot,
      card({ id: 'card-timeline', title: 'Trust events', children: empties.noReputation() }),
    );
    return;
  }

  const status = store.getState().status.data
    ? normalizeStatus(store.getState().status.data)
    : null;

  const chart = timelineChart({
    events: events.map((event) => ({
      from: event.from,
      to: event.to,
      action: event.action,
      reason: event.reason,
      timestamp: event.at,
    })),
    title: 'Trust events',
    caption: 'Source: ' + view.eventSource + '.',
  });
  view.charts.push(/** @type {{ destroy?: () => void }} */ (/** @type {unknown} */ (chart)));

  const toggle = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--secondary btn--sm',
      id: 'toggle-timeline-table',
      'aria-pressed': view.showEventTable ? 'true' : 'false',
      onClick: () => {
        view.showEventTable = !view.showEventTable;
        renderTimeline();
      },
    },
    view.showEventTable ? 'Show chart' : 'Show table',
  );

  const table = dataTable({
    caption: 'Trust events',
    headers: ['When', 'Action', 'From', 'To', 'Reason', 'Proof'],
    rows: events.map((event) => [
      timeAgo(event.at),
      event.action === 'endorse'
        ? statusPill('success', 'Endorsed')
        : statusPill('danger', 'Reported'),
      event.from ?? EMPTY,
      event.to ?? EMPTY,
      event.reason ?? EMPTY,
      txLink(status, event.txHash),
    ]),
  });

  mountNodes(
    slot,
    card({
      id: 'card-timeline',
      title: 'Trust events',
      actions: toggle,
      children: view.showEventTable ? table : chart,
    }),
  );
}

/**
 * @param {import('../shape.js').NodeStatus | null} status
 * @param {string | null} txHash
 * @returns {unknown}
 */
function txLink(status, txHash) {
  const url = explorerTxUrl(status ? status.chain.explorerBase : null, txHash);
  return url ? extLink(url, 'Transaction') : EMPTY;
}

/**
 * @returns {void}
 */
function renderTopology() {
  const slot = view.slots.topology;
  if (!slot) return;
  const data = view.data;

  if (!data || data.entries.length === 0) {
    mountNodes(
      slot,
      card({
        id: 'card-topology',
        title: 'Swarm topology',
        children: empties.noReputation(),
      }),
    );
    return;
  }

  const nodes = data.entries.map((entry) => ({
    id: entry.address ?? entry.label,
    label: entry.label,
    reputation: entry.score ?? 0,
    trusted: entry.trusted === true,
  }));
  const edges = aggregateEdges(data.events);

  const chart = topologyGraph({
    nodes,
    edges,
    title: 'Agent swarm',
    caption:
      'Node size encodes reputation; a dashed ring marks an agent below the trust threshold. Focus a node to dim the edges it is not part of.',
  });
  view.charts.push(/** @type {{ destroy?: () => void }} */ (/** @type {unknown} */ (chart)));

  mountNodes(
    slot,
    card({
      id: 'card-topology',
      title: 'Swarm topology',
      hint: 'Endorsements and reports between the same pair are aggregated into one weighted edge.',
      children: chart,
    }),
  );
}
