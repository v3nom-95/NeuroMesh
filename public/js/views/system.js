/**
 * System: health, metrics, versions, API entry points, and local settings.
 *
 * This is the operator's diagnostics tab, so its bias is towards showing the
 * node's own words rather than the console's interpretation of them: the
 * readiness table renders whatever check names the backend reports (a `disk`
 * probe added tomorrow needs no change here), and the raw `GET /api/status`
 * response is available verbatim as text.
 *
 * The metrics panel exists to replace four arithmetic means. The repo's own
 * benchmark file records chain latencies of `[16190, 21288, 7033, …]`, a
 * distribution whose mean is actively misleading; every latency on this page
 * is shown as p50/p95/p99 with the sample count beside it.
 *
 * @module views/system
 */

import { ApiError, ENDPOINTS, getHealth, getMetrics, getReady, getSimulation } from '../api.js';
import { barChart, groupedBarChart } from '../charts.js';
import { announce, el, extLink, mount as mountNodes, on } from '../dom.js';
import { EMPTY, formatDuration, formatMs, formatNumber, summarize } from '../format.js';
import { createPoller } from '../poll.js';
import {
  DEFAULT_SETTINGS,
  getSettings,
  hasApiKey,
  redact,
  resetSettings,
  setSettings,
} from '../settings.js';
import {
  normalizeChecks,
  normalizeSimulation,
  normalizeStatus,
  parsePrometheus,
  stageLatencies,
} from '../shape.js';
import { store } from '../store.js';
import { getTheme, setTheme } from '../theme.js';
import { toast } from '../toast.js';
import {
  card,
  dataTable,
  empties,
  errorState,
  field,
  idChip,
  kvList,
  loadingBlock,
  statusPill,
  switchControl,
  toneForCheck,
} from '../ui.js';

/** Cadence for the health probe while this view is on screen. */
const HEALTH_INTERVAL_MS = 15000;

/** Offered poll intervals, in milliseconds. */
const POLL_CHOICES = Object.freeze([
  [2000, 'Every 2 seconds'],
  [5000, 'Every 5 seconds'],
  [15000, 'Every 15 seconds'],
  [30000, 'Every 30 seconds'],
  [60000, 'Every minute'],
]);

/**
 * @typedef {object} SystemViewState
 * @property {AbortController | null} abort
 * @property {(() => void)[]} teardown
 * @property {Record<string, HTMLElement | null>} slots
 * @property {Array<{ destroy?: () => void }>} charts
 * @property {ReturnType<typeof createPoller> | null} healthPoller
 */

/** @type {SystemViewState} */
let view = freshState();

/**
 * @returns {SystemViewState}
 */
function freshState() {
  return { abort: null, teardown: [], slots: {}, charts: [], healthPoller: null };
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
    health: el('div'),
    metrics: el('div'),
    versions: el('div'),
    api: el('div'),
    settings: el('div'),
  };
  view.slots = slots;

  mountNodes(
    container,
    el(
      'div',
      { class: 'stack' },
      el('h2', { class: 'sr-only', 'data-view-heading': 'true' }, 'System'),
      slots.health,
      slots.metrics,
      el('div', { class: 'grid grid--2' }, slots.versions, slots.api),
      slots.settings,
    ),
  );

  mountNodes(slots.health, card({ title: 'Health', children: loadingBlock('health', 'row', 3) }));
  mountNodes(
    slots.metrics,
    card({ title: 'Metrics', children: loadingBlock('metrics', 'chart', 1) }),
  );
  renderVersions(ctx);
  renderApi();
  renderSettings(ctx);

  // A view-scoped poller: stopped in unmount(), so leaving this tab stops the
  // probe rather than leaving it running for the life of the page.
  view.healthPoller = createPoller({
    label: 'health',
    intervalMs: HEALTH_INTERVAL_MS,
    fn: async (signal) => {
      const [health, ready] = await Promise.allSettled([
        getHealth({ signal }),
        getReady({ signal }),
      ]);
      return { health, ready };
    },
    onData: (data) =>
      renderHealth(
        /** @type {{ health: PromiseSettledResult<unknown>, ready: PromiseSettledResult<unknown> }} */ (
          data
        ),
      ),
    onError: (error) => {
      const slot = view.slots.health;
      if (slot) {
        mountNodes(
          slot,
          card({
            id: 'card-health',
            title: 'Health',
            children: errorState(error, () => void refresh(ctx), 'health'),
          }),
        );
      }
    },
  });
  view.healthPoller.start();

  void loadMetrics(ctx);

  view.teardown.push(
    store.select(
      (state) => state.status.data,
      () => renderVersions(ctx),
    ),
  );
  view.teardown.push(on(document, 'nm:settingschange', () => renderSettings(ctx)));
}

/**
 * @returns {void}
 */
export function unmount() {
  if (view.healthPoller) view.healthPoller.stop();
  if (view.abort) view.abort.abort();
  for (const dispose of view.teardown) dispose();
  for (const handle of view.charts) {
    if (handle && typeof handle.destroy === 'function') handle.destroy();
  }
  view = freshState();
}

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
export function refresh(ctx) {
  if (view.healthPoller) void view.healthPoller.refreshNow();
  void loadMetrics(ctx);
}

/* ==================================================================== *
 * Health
 * ==================================================================== */

/**
 * @param {{ health: PromiseSettledResult<unknown>, ready: PromiseSettledResult<unknown> }} results
 * @returns {void}
 */
function renderHealth(results) {
  const slot = view.slots.health;
  if (!slot) return;

  const health = results.health.status === 'fulfilled' ? results.health.value : null;
  const readyValue = results.ready.status === 'fulfilled' ? results.ready.value : null;
  const readyError = results.ready.status === 'rejected' ? results.ready.reason : null;

  // A 503 from /readyz is a NORMAL state while the embedding model loads. It
  // is reported as "starting up", not as a failure, because telling an
  // operator their node is broken during a routine boot trains them to ignore
  // this panel.
  const starting = readyError instanceof ApiError && readyError.status === 503;

  const checks = [...normalizeChecks(health), ...normalizeChecks(readyValue)];
  const overall = readyValue
    ? statusPill('success', 'Ready')
    : starting
      ? statusPill('info', 'Starting up', { pulse: true })
      : health
        ? statusPill('warn', 'Live but not ready')
        : statusPill('danger', 'Unreachable');

  const body =
    checks.length > 0
      ? dataTable({
          caption: 'Readiness checks',
          captionHidden: true,
          headers: ['Check', 'Status', 'Detail', 'Latency'],
          numericColumns: [3],
          rowHeaders: true,
          rows: checks.map((check) => [
            check.name,
            statusPill(toneForCheck(check.status), check.status),
            check.detail ?? EMPTY,
            check.latencyMs === null ? EMPTY : formatMs(check.latencyMs),
          ]),
        })
      : el(
          'p',
          { class: 'card__hint' },
          'The node answered but reported no individual checks. Liveness and readiness above are the whole story it tells.',
        );

  mountNodes(
    slot,
    card({
      id: 'card-health',
      title: 'Health and readiness',
      actions: overall,
      children: el(
        'div',
        { class: 'stack' },
        readyError && !starting
          ? el(
              'p',
              { class: 'callout callout--warn' },
              'Readiness probe failed: ' +
                (readyError instanceof ApiError ? readyError.userMessage : String(readyError)),
            )
          : null,
        body,
      ),
    }),
  );
}

/* ==================================================================== *
 * Metrics
 * ==================================================================== */

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {Promise<void>}
 */
async function loadMetrics(ctx) {
  const slot = view.slots.metrics;
  if (!slot) return;
  const signal = view.abort ? view.abort.signal : undefined;

  try {
    const text = await getMetrics({ signal });
    const rows = stageLatencies(parsePrometheus(text));
    if (rows.length > 0) {
      renderMetrics(rows, 'live /metrics on this node');
      return;
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') return;
    // No metrics endpoint, or nothing latency-shaped in it. The benchmark file
    // is the next best source and is labelled as such.
  }

  try {
    const raw = await getSimulation({ signal });
    const sim = normalizeSimulation(raw);
    const rows = sim.stages.map((stage) => {
      const stats = summarize(stage.values);
      return {
        label: stage.label,
        count: stats.count,
        p50: stats.p50,
        p95: stats.p95,
        p99: stats.p99,
        mean: stats.mean,
        estimated: false,
        values: stage.values,
      };
    });
    if (rows.length === 0) {
      mountNodes(
        slot,
        card({ id: 'card-metrics', title: 'Latency', children: empties.noSimulation() }),
      );
      return;
    }
    renderMetrics(rows, 'the last local simulation run, not live traffic');
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') return;
    mountNodes(
      slot,
      card({
        id: 'card-metrics',
        title: 'Latency',
        children:
          error instanceof ApiError && error.code === 'simulation_missing'
            ? empties.noSimulation()
            : errorState(error, () => void loadMetrics(ctx), 'metrics'),
      }),
    );
  }
}

/**
 * @param {Array<{ label: string, count: number|null, p50: number|null, p95: number|null,
 *   p99: number|null, mean: number|null, estimated: boolean, values?: number[] }>} rows
 * @param {string} source
 * @returns {void}
 */
function renderMetrics(rows, source) {
  const slot = view.slots.metrics;
  if (!slot) return;
  for (const handle of view.charts) {
    if (handle && typeof handle.destroy === 'function') handle.destroy();
  }
  view.charts = [];

  const grouped = groupedBarChart({
    groups: rows.map((row) => ({
      label: row.label,
      values: [row.p50, row.p95, row.p99].map((value) =>
        value === null || !Number.isFinite(value) ? null : value,
      ),
    })),
    seriesNames: ['p50', 'p95', 'p99'],
    valueFormat: formatMs,
    title: 'Latency percentiles by stage',
    caption:
      'Source: ' +
      source +
      (rows.some((row) => row.estimated)
        ? '. Percentiles marked in the table are interpolated from histogram buckets.'
        : '.'),
  });
  view.charts.push(/** @type {{ destroy?: () => void }} */ (/** @type {unknown} */ (grouped)));

  // A mean-only bar chart is included ONLY where the raw samples exist, so the
  // p50/p95 reference lines the chart draws are real rather than derived from
  // the same three numbers already in the grouped chart.
  const withSamples = rows.filter((row) => Array.isArray(row.values) && row.values.length > 0);
  /** @type {HTMLElement | null} */
  let distribution = null;
  if (withSamples.length > 0) {
    const stage = withSamples[withSamples.length - 1];
    const chart = barChart({
      data: /** @type {number[]} */ (stage.values),
      labels: /** @type {number[]} */ (stage.values).map((_value, index) => String(index + 1)),
      unit: 'ms',
      title: stage.label + ' — every sample',
      caption:
        'Each bar is one run. The dashed lines are p50 and p95, which is what a single mean would have hidden.',
    });
    view.charts.push(/** @type {{ destroy?: () => void }} */ (/** @type {unknown} */ (chart)));
    distribution = chart;
  }

  mountNodes(
    slot,
    card({
      id: 'card-metrics',
      title: 'Latency',
      hint: 'Source: ' + source + '.',
      children: el(
        'div',
        { class: 'stack' },
        grouped,
        dataTable({
          caption: 'Latency by stage',
          headers: ['Stage', 'Samples', 'p50', 'p95', 'p99', 'Mean'],
          numericColumns: [1, 2, 3, 4, 5],
          rowHeaders: true,
          rows: rows.map((row) => [
            row.label + (row.estimated ? ' (estimated)' : ''),
            row.count === null ? EMPTY : formatNumber(row.count, 0),
            fmtMs(row.p50),
            fmtMs(row.p95),
            fmtMs(row.p99),
            fmtMs(row.mean),
          ]),
        }),
        distribution,
      ),
    }),
  );
}

/**
 * @param {number | null | undefined} value
 * @returns {string}
 */
function fmtMs(value) {
  return value === null || value === undefined || !Number.isFinite(value) ? EMPTY : formatMs(value);
}

/* ==================================================================== *
 * Versions and transport
 * ==================================================================== */

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
function renderVersions(ctx) {
  const slot = view.slots.versions;
  if (!slot) return;
  const raw = store.getState().status.data;
  const status = raw ? normalizeStatus(raw) : null;
  const transport = ctx && ctx.poller ? ctx.poller.getState() : null;

  mountNodes(
    slot,
    card({
      id: 'card-versions',
      title: 'Versions and transport',
      children: kvList([
        ['Node name', status ? (status.node.name ?? EMPTY) : EMPTY],
        [
          'Server version',
          status && status.node.version
            ? idChip({ value: status.node.version, what: 'version' })
            : EMPTY,
        ],
        [
          'Commit',
          status && status.node.commit
            ? idChip({ value: status.node.commit, what: 'commit' })
            : EMPTY,
        ],
        [
          'Uptime',
          status && status.node.uptimeSec !== null ? formatDuration(status.node.uptimeSec) : EMPTY,
        ],
        ['Network', status ? (status.chain.network ?? EMPTY) : EMPTY],
        [
          'Live updates',
          transport
            ? transport.mode === 'retrying'
              ? 'Retrying, backing off to ' + formatMs(transport.intervalMs)
              : transport.mode === 'paused'
                ? 'Paused while the tab is hidden'
                : 'Polling every ' + formatMs(transport.intervalMs)
            : EMPTY,
        ],
        [
          'Last successful poll',
          transport && transport.lastSuccessAt
            ? new Date(transport.lastSuccessAt).toLocaleTimeString()
            : EMPTY,
        ],
      ]),
    }),
  );
}

/* ==================================================================== *
 * API entry points
 * ==================================================================== */

/**
 * @returns {void}
 */
function renderApi() {
  const slot = view.slots.api;
  if (!slot) return;
  const raw = store.getState().status.data;

  mountNodes(
    slot,
    card({
      id: 'card-api',
      title: 'API',
      children: el(
        'div',
        { class: 'stack' },
        el(
          'ul',
          null,
          el('li', null, extLink(ENDPOINTS.openapi(), 'OpenAPI specification')),
          el('li', null, extLink(ENDPOINTS.docs(), 'Interactive API documentation')),
          el('li', null, extLink(ENDPOINTS.metrics(), 'Prometheus metrics (raw)')),
        ),
        el(
          'details',
          { id: 'card-api-raw' },
          el('summary', null, 'Latest /api/status response'),
          // JSON.stringify then textContent. This pane exists to show remote
          // data verbatim, which is precisely why it must never be parsed as
          // markup: it is the highest-value injection target on the page.
          el(
            'pre',
            { class: 'mono break-all' },
            raw === null || raw === undefined
              ? 'No status response yet.'
              : JSON.stringify(raw, null, 2),
          ),
        ),
      ),
    }),
  );
}

/* ==================================================================== *
 * Settings
 * ==================================================================== */

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
function renderSettings(ctx) {
  const slot = view.slots.settings;
  if (!slot) return;
  const settings = getSettings();

  const keyInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'password',
      id: 'input-api-key',
      class: 'input input--mono',
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: '',
    })
  );
  // The stored key is NEVER written back into the field. Rendering it would
  // put a secret into the DOM, into an autofill store and onto the screen of
  // anyone standing behind the operator; the masked summary below says whether
  // one is set without disclosing it.
  const keyField = field({
    id: 'input-api-key',
    label: 'API key',
    control: keyInput,
    hint: 'Sent as the x-api-key header on write requests. Stored in this browser’s localStorage on this device only — it is not encrypted and anyone with access to this profile can read it.',
  });

  const keyState = el(
    'p',
    { class: 'card__hint' },
    hasApiKey()
      ? 'A key is stored for this node: ' + redact(getSettings().apiKey)
      : 'No API key stored. Write actions will fail if this node requires one.',
  );

  const showSwitch = switchControl({
    id: 'switch-show-key',
    label: 'Show what I am typing',
    checked: false,
    onChange: (checked) => {
      keyInput.type = checked ? 'text' : 'password';
    },
  });

  const pollSelect = /** @type {HTMLSelectElement} */ (
    el(
      'select',
      {
        id: 'select-poll',
        class: 'select',
        onChange: () => {
          const value = Number(pollSelect.value);
          setSettings({ pollIntervalMs: value });
          if (ctx && ctx.poller) ctx.poller.setInterval(value);
          announce('Status poll interval set to ' + formatMs(value) + '.');
        },
      },
      POLL_CHOICES.map(([value, label]) => el('option', { value: String(value) }, label)),
    )
  );
  pollSelect.value = String(settings.pollIntervalMs);

  const pageSizeInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'number',
      id: 'input-page-size',
      class: 'input',
      min: '5',
      max: '100',
      step: '5',
      value: String(settings.pageSize),
      onChange: () => setSettings({ pageSize: Number(pageSizeInput.value) }),
    })
  );

  const themeRadios = ['system', 'light', 'dark'].map((mode) =>
    el(
      'label',
      { class: 'switch', for: 'theme-' + mode },
      el('input', {
        type: 'radio',
        id: 'theme-' + mode,
        name: 'theme',
        value: mode,
        checked: getTheme() === mode,
        onChange: () => setTheme(/** @type {'system'|'light'|'dark'} */ (mode), { announce: true }),
      }),
      el('span', null, mode.charAt(0).toUpperCase() + mode.slice(1)),
    ),
  );

  mountNodes(
    slot,
    card({
      id: 'card-settings',
      title: 'Local settings',
      hint: 'These live in this browser only. Nothing here is sent to the node except the API key, and only as a request header.',
      children: el(
        'div',
        { class: 'stack' },
        el(
          'div',
          { class: 'stack' },
          keyField.node,
          showSwitch.node,
          keyState,
          el(
            'div',
            { class: 'card__actions' },
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn--primary btn--sm',
                onClick: () => {
                  const value = keyInput.value.trim();
                  if (value === '') {
                    keyField.setError('Enter a key, or use Clear to remove the stored one.');
                    keyInput.focus();
                    return;
                  }
                  keyField.setError(null);
                  setSettings({ apiKey: value });
                  keyInput.value = '';
                  toast.success('API key saved in this browser.');
                  announce('API key saved.');
                  renderSettings(ctx);
                },
              },
              'Save key',
            ),
            el(
              'button',
              {
                type: 'button',
                class: 'btn btn--secondary btn--sm',
                onClick: () => {
                  setSettings({ apiKey: '' });
                  keyInput.value = '';
                  toast.info('API key cleared.');
                  announce('API key cleared.');
                  renderSettings(ctx);
                },
              },
              'Clear key',
            ),
          ),
        ),
        el(
          'div',
          { class: 'grid grid--2' },
          field({ id: 'select-poll', label: 'Status poll interval', control: pollSelect }).node,
          field({ id: 'input-page-size', label: 'Memories per page', control: pageSizeInput }).node,
        ),
        el(
          'fieldset',
          null,
          el('legend', { class: 'label' }, 'Theme'),
          el('div', { class: 'card__actions' }, themeRadios),
        ),
        el(
          'div',
          { class: 'card__actions' },
          el(
            'button',
            {
              type: 'button',
              class: 'btn btn--danger btn--sm',
              onClick: () => {
                resetSettings();
                setTheme(DEFAULT_SETTINGS.theme, { announce: false });
                toast.info('Local settings reset.');
                announce('Local settings reset.');
                renderSettings(ctx);
              },
            },
            'Reset local settings',
          ),
        ),
      ),
    }),
  );
}
