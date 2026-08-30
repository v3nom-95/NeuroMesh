/**
 * Semantic: the cross-model similarity matrix, and trust-weighted search.
 *
 * The matrix is the project's headline claim — that two agents running
 * different embedding models can compare memories at all — so it is drawn on a
 * diverging scale centred at zero rather than as a table tinted by a
 * `similarity > 0.05` rule. Cosine similarity is signed; a scale that runs
 * pale-to-strong from one end makes "unrelated" look like "slightly related".
 *
 * The search panel exists to make the trust weighting VISIBLE: every result
 * shows the raw similarity, the reputation weight the node applied, and the
 * combined score it ranked by. If the node returns no combined score, this
 * view says so instead of quietly showing the raw similarity in the combined
 * column and passing an unweighted ranking off as a weighted one.
 *
 * @module views/semantic
 */

import { ApiError, getSimilarity, getSimulation, semanticSearch } from '../api.js';
import { heatmap, similarityBar } from '../charts.js';
import { announce, el, mount as mountNodes } from '../dom.js';
import {
  EMPTY,
  formatCid,
  formatMs,
  formatNumber,
  formatSimilarity,
  summarize,
} from '../format.js';
import { normalizeSearch, normalizeSimilarity, normalizeStatus } from '../shape.js';
import { store } from '../store.js';
import { toast } from '../toast.js';
import {
  card,
  dataTable,
  empties,
  errorState,
  field,
  idChip,
  isGated,
  loadingBlock,
  setButtonBusy,
  statTile,
  statusPill,
} from '../ui.js';

/**
 * @typedef {object} SemanticViewState
 * @property {AbortController | null} abort
 * @property {AbortController | null} searchAbort
 * @property {(() => void)[]} teardown
 * @property {Record<string, HTMLElement | null>} slots
 * @property {{ destroy?: () => void } | null} heatHandle
 * @property {ReturnType<typeof normalizeSimilarity> | null} similarity
 * @property {string} source which endpoint the matrix came from
 * @property {boolean} showTable
 * @property {import('../shape.js').SearchHit[]} hits
 * @property {number | null} tookMs
 * @property {string} lastQuery
 * @property {'node'|'similarity'} rankBy
 */

/** @type {SemanticViewState} */
let view = freshState();

/**
 * @returns {SemanticViewState}
 */
function freshState() {
  return {
    abort: null,
    searchAbort: null,
    teardown: [],
    slots: {},
    heatHandle: null,
    similarity: null,
    source: '',
    showTable: false,
    hits: [],
    tookMs: null,
    lastQuery: '',
    rankBy: 'node',
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
    matrix: el('div'),
    search: el('div'),
  };
  view.slots = slots;

  mountNodes(
    container,
    el(
      'div',
      { class: 'stack' },
      el('h2', { class: 'sr-only', 'data-view-heading': 'true' }, 'Semantic'),
      slots.matrix,
      slots.search,
    ),
  );

  renderSearchPanel(ctx);
  void loadMatrix();

  view.teardown.push(
    store.select(
      (state) => state.status.data,
      () => renderSearchPanel(ctx),
    ),
  );
}

/**
 * @returns {void}
 */
export function unmount() {
  if (view.abort) view.abort.abort();
  if (view.searchAbort) view.searchAbort.abort();
  for (const dispose of view.teardown) dispose();
  if (view.heatHandle && typeof view.heatHandle.destroy === 'function') view.heatHandle.destroy();
  view = freshState();
}

/**
 * @returns {void}
 */
export function refresh() {
  void loadMatrix();
}

/* ==================================================================== *
 * Similarity matrix
 * ==================================================================== */

/**
 * Load the matrix.
 *
 * The live endpoint is tried first. A node with no comparisons yet answers 404
 * or an empty payload, in which case the simulation file is used and the
 * caption SAYS which source produced the picture — an operator must never have
 * to guess whether they are looking at live data or a benchmark run.
 *
 * @returns {Promise<void>}
 */
async function loadMatrix() {
  const slot = view.slots.matrix;
  if (!slot) return;
  const signal = view.abort ? view.abort.signal : undefined;

  mountNodes(
    slot,
    card({
      id: 'card-similarity',
      title: 'Cross-model similarity',
      children: loadingBlock('similarity matrix', 'chart', 1),
    }),
  );

  try {
    const raw = await getSimilarity({ signal });
    const parsed = normalizeSimilarity(raw);
    if (parsed.labels.length > 0) {
      view.similarity = parsed;
      view.source = 'live comparisons reported by this node';
      renderMatrix();
      return;
    }
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') return;
    // Fall through to the simulation: an unavailable live matrix is a normal
    // state on a node that has not compared anything yet.
  }

  try {
    const raw = await getSimulation({ signal });
    const parsed = normalizeSimilarity(raw);
    view.similarity = parsed.labels.length > 0 ? parsed : null;
    view.source = 'the last local simulation run, not live node data';
    renderMatrix();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') return;
    const slotNow = view.slots.matrix;
    if (!slotNow) return;
    mountNodes(
      slotNow,
      card({
        id: 'card-similarity',
        title: 'Cross-model similarity',
        children:
          error instanceof ApiError && error.code === 'simulation_missing'
            ? empties.noSimulation()
            : errorState(error, () => void loadMatrix(), 'the similarity matrix'),
      }),
    );
  }
}

/**
 * @returns {void}
 */
function renderMatrix() {
  const slot = view.slots.matrix;
  if (!slot) return;
  if (view.heatHandle && typeof view.heatHandle.destroy === 'function') {
    view.heatHandle.destroy();
    view.heatHandle = null;
  }

  const data = view.similarity;
  if (!data || data.labels.length === 0) {
    mountNodes(
      slot,
      card({
        id: 'card-similarity',
        title: 'Cross-model similarity',
        children: empties.noSimulation(),
      }),
    );
    return;
  }

  const stats = summarise(data);

  const chart = heatmap({
    labels: data.labels,
    matrix: data.matrix,
    scale: 'diverging',
    domain: [-1, 1],
    title: 'Cross-model cosine similarity',
    desc: 'A square matrix of cosine similarity between agents, drawn on a diverging scale centred at zero.',
    caption: 'Source: ' + view.source + '. Empty cells are pairs the node has not compared.',
    valueFormat: formatSimilarity,
  });
  view.heatHandle = /** @type {{ destroy?: () => void }} */ (/** @type {unknown} */ (chart));

  const tableToggle = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--secondary btn--sm',
      id: 'toggle-sim-table',
      'aria-pressed': view.showTable ? 'true' : 'false',
      onClick: () => {
        view.showTable = !view.showTable;
        renderMatrix();
      },
    },
    view.showTable ? 'Show heatmap' : 'Show pair table',
  );

  const pairTable = dataTable({
    caption: 'Every compared pair',
    headers: ['From', 'To', 'From model', 'To model', 'Similarity'],
    numericColumns: [4],
    rows: data.pairs.map((pair) => [
      pair.from,
      pair.to,
      pair.fromModel ?? modelOf(data, pair.from) ?? EMPTY,
      pair.toModel ?? modelOf(data, pair.to) ?? EMPTY,
      pair.similarity === null ? EMPTY : formatSimilarity(pair.similarity),
    ]),
  });

  mountNodes(
    slot,
    card({
      id: 'card-similarity',
      title: 'Cross-model similarity',
      hint: 'Cosine similarity between memory embeddings produced by different models, after alignment into a shared space.',
      actions: tableToggle,
      children: el(
        'div',
        { class: 'stack' },
        el(
          'div',
          { class: 'grid grid--3' },
          statTile({
            label: 'Mean same-model',
            value: Number.isFinite(stats.intra.mean) ? formatSimilarity(stats.intra.mean) : null,
            meta: stats.intra.count + ' pairs',
          }),
          statTile({
            label: 'Mean cross-model',
            value: Number.isFinite(stats.cross.mean) ? formatSimilarity(stats.cross.mean) : null,
            meta: stats.cross.count + ' pairs',
          }),
          statTile({
            label: 'Strongest pair',
            value: stats.best ? formatSimilarity(stats.best.similarity ?? 0) : null,
            meta: stats.best ? stats.best.from + ' → ' + stats.best.to : undefined,
          }),
        ),
        // Both renderings are always in the DOM in one form or another: the
        // chart carries its own offscreen data table, so the numbers are
        // reachable by a screen reader whichever toggle state is showing.
        view.showTable ? pairTable : chart,
        el('div', { class: 'card__actions' }, modelLegend(data)),
        el(
          'div',
          { class: 'callout callout--info' },
          el('h3', null, 'How this comparison is made'),
          el(
            'p',
            null,
            'Agents run different sentence encoders whose output dimensions and axes do not correspond, so raw vectors from two models are not comparable. Each embedding is first re-expressed as its similarities to a fixed, shared anchor set, which puts every model’s output in one relative space; cosine similarity is then taken in that space.',
          ),
          el(
            'p',
            null,
            'That means a value here measures agreement about meaning, not distance in any one model’s native geometry. Values near zero are the expected result for unrelated text, and negative values are meaningful rather than an error.',
          ),
        ),
      ),
    }),
  );
}

/**
 * @param {ReturnType<typeof normalizeSimilarity>} data
 * @param {string} id
 * @returns {string | null}
 */
function modelOf(data, id) {
  const entry = data.models.get(id);
  return entry ? entry.model : null;
}

/**
 * @param {ReturnType<typeof normalizeSimilarity>} data
 * @returns {HTMLElement}
 */
function modelLegend(data) {
  if (data.models.size === 0) {
    return el('p', { class: 'card__hint' }, 'The source did not say which model each agent runs.');
  }
  return el(
    'div',
    { class: 'card__actions' },
    Array.from(data.models, ([id, info]) =>
      el(
        'span',
        { class: 'chip' },
        el('span', { class: 'chip__value' }, id),
        el(
          'span',
          { class: 'chip__label' },
          (info.model ?? 'model unknown') + (info.dim === null ? '' : ' · ' + info.dim + 'd'),
        ),
      ),
    ),
  );
}

/**
 * Split the pairs into same-model and cross-model populations.
 *
 * This is the one number the matrix exists to produce: if cross-model
 * similarity were indistinguishable from noise, the alignment would not work.
 *
 * @param {ReturnType<typeof normalizeSimilarity>} data
 * @returns {{ intra: ReturnType<typeof summarize>, cross: ReturnType<typeof summarize>,
 *   best: { from: string, to: string, similarity: number | null } | null }}
 */
function summarise(data) {
  /** @type {number[]} */
  const intra = [];
  /** @type {number[]} */
  const cross = [];
  /** @type {{ from: string, to: string, similarity: number | null } | null} */
  let best = null;

  for (const pair of data.pairs) {
    if (pair.similarity === null) continue;
    const from = pair.fromModel ?? modelOf(data, pair.from);
    const to = pair.toModel ?? modelOf(data, pair.to);
    if (from && to) (from === to ? intra : cross).push(pair.similarity);
    if (!best || (best.similarity ?? -Infinity) < pair.similarity) best = pair;
  }
  return { intra: summarize(intra), cross: summarize(cross), best };
}

/* ==================================================================== *
 * Search
 * ==================================================================== */

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
function renderSearchPanel(ctx) {
  const slot = view.slots.search;
  if (!slot) return;

  const status = store.getState().status.data
    ? normalizeStatus(store.getState().status.data)
    : null;
  const modelReady = status ? status.model.ready : null;

  const queryInput = /** @type {HTMLInputElement} */ (
    el('input', { type: 'search', id: 'input-query', class: 'input', autocomplete: 'off' })
  );
  const queryField = field({
    id: 'input-query',
    label: 'Query',
    required: true,
    control: queryInput,
    hint: 'The query is embedded on this node and compared against every memory it can read.',
  });

  const topkOutput = el('output', { for: 'range-topk', class: 'num' }, '5');
  const topkInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'range',
      id: 'range-topk',
      class: 'range',
      min: '1',
      max: '20',
      step: '1',
      value: '5',
      'aria-valuetext': '5 results',
      onInput: () => {
        topkOutput.textContent = topkInput.value;
        topkInput.setAttribute('aria-valuetext', topkInput.value + ' results');
      },
    })
  );

  const rankSelect = /** @type {HTMLSelectElement} */ (
    el(
      'select',
      {
        id: 'select-rank',
        class: 'select',
        onChange: () => {
          view.rankBy = rankSelect.value === 'similarity' ? 'similarity' : 'node';
          renderResults();
        },
      },
      el('option', { value: 'node' }, 'Node ranking (trust-weighted)'),
      el('option', { value: 'similarity' }, 'Raw similarity'),
    )
  );

  const submitButton = el(
    'button',
    { type: 'submit', class: 'btn btn--primary', id: 'btn-search', dataset: { requires: 'model' } },
    'Search',
  );

  const resultsSlot = el('div', { id: 'search-results' });
  view.slots.results = resultsSlot;

  const form = el(
    'form',
    {
      id: 'form-search',
      novalidate: true,
      onSubmit: (/** @type {Event} */ event) => {
        event.preventDefault();
        void runSearch(queryInput, queryField, topkInput, submitButton, ctx);
      },
    },
    el(
      'div',
      { class: 'stack' },
      queryField.node,
      el(
        'div',
        { class: 'grid grid--2' },
        field({
          id: 'range-topk',
          label: 'Results to return',
          control: topkInput,
          headExtra: topkOutput,
        }).node,
        field({
          id: 'select-rank',
          label: 'Order results by',
          control: rankSelect,
          hint: 'Re-orders the results the node already returned; it does not change what the node retrieved.',
        }).node,
      ),
      el('div', { class: 'card__actions' }, submitButton),
    ),
  );

  mountNodes(
    slot,
    card({
      id: 'card-search',
      title: 'Trust-weighted semantic search',
      hint: 'Results are ranked by similarity combined with the author agent’s reputation, so a high-similarity memory from an untrusted agent does not outrank a good one from a trusted peer.',
      actions:
        modelReady === false
          ? statusPill('info', 'Embedding model still loading', { pulse: true })
          : null,
      children: el('div', { class: 'stack' }, form, resultsSlot),
    }),
  );
}

/**
 * @param {HTMLInputElement} queryInput
 * @param {{ setError: (message: string|null) => void }} queryField
 * @param {HTMLInputElement} topkInput
 * @param {HTMLElement} button
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {Promise<void>}
 */
async function runSearch(queryInput, queryField, topkInput, button, ctx) {
  if (isGated(button) || button.dataset.busy === 'true') return;

  const query = queryInput.value.trim();
  if (query === '') {
    // No request at all for an empty query: an inline message costs nothing
    // and a round trip that can only fail costs the operator time.
    queryField.setError('Enter something to search for.');
    queryInput.focus();
    return;
  }
  queryField.setError(null);

  if (view.searchAbort) view.searchAbort.abort();
  const local = new AbortController();
  view.searchAbort = local;

  const slot = view.slots.results;
  if (slot) mountNodes(slot, loadingBlock('search results', 'row', 3));
  setButtonBusy(button, true, 'Searching');

  try {
    const raw = await semanticSearch(
      { query, topK: Number(topkInput.value) || 5 },
      { signal: local.signal },
    );
    if (local.signal.aborted) return;
    const parsed = normalizeSearch(raw);
    view.hits = parsed.hits;
    view.tookMs = parsed.tookMs;
    view.lastQuery = query;
    renderResults();
    announce(
      parsed.hits.length === 0
        ? 'No results for ' + query
        : pluralResults(parsed.hits.length) + ' for ' + query,
    );
  } catch (error) {
    if (local.signal.aborted || (error instanceof ApiError && error.code === 'aborted')) return;
    if (slot)
      mountNodes(
        slot,
        errorState(
          error,
          () => void runSearch(queryInput, queryField, topkInput, button, ctx),
          'search results',
        ),
      );
    toast.error(error);
  } finally {
    setButtonBusy(button, false);
  }
}

/**
 * @param {number} count
 * @returns {string}
 */
function pluralResults(count) {
  return count + (count === 1 ? ' result' : ' results');
}

/**
 * @returns {void}
 */
function renderResults() {
  const slot = view.slots.results;
  if (!slot) return;
  if (view.lastQuery === '') {
    mountNodes(slot);
    return;
  }
  if (view.hits.length === 0) {
    mountNodes(slot, empties.noSearchResults(view.lastQuery));
    return;
  }

  const hits = view.hits.slice().sort((a, b) => {
    if (view.rankBy === 'similarity')
      return (b.similarity ?? -Infinity) - (a.similarity ?? -Infinity);
    return (b.score ?? b.similarity ?? -Infinity) - (a.score ?? a.similarity ?? -Infinity);
  });

  const anyCombined = hits.some((hit) => hit.score !== null);
  const anyWeight = hits.some((hit) => hit.trustWeight !== null);

  mountNodes(
    slot,
    el(
      'div',
      { class: 'stack' },
      el(
        'p',
        { class: 'card__hint' },
        pluralResults(hits.length) +
          ' for “' +
          view.lastQuery +
          '”' +
          (view.tookMs === null ? '' : ' in ' + formatMs(view.tookMs)),
      ),
      !anyCombined || !anyWeight
        ? el(
            'p',
            { class: 'callout callout--warn' },
            'This node returned ' +
              (anyWeight ? 'no combined ranking score' : 'no reputation weight') +
              ' with its results, so the trust weighting cannot be shown. The similarity column below is the raw cosine value and nothing here is inferred from it.',
          )
        : null,
      el(
        'ol',
        { class: 'stack' },
        hits.map((hit, index) => resultRow(hit, index + 1)),
      ),
    ),
  );
}

/**
 * @param {import('../shape.js').SearchHit} hit
 * @param {number} rank
 * @returns {HTMLElement}
 */
function resultRow(hit, rank) {
  return el(
    'li',
    { class: 'card card--tight' },
    el(
      'div',
      { class: 'memory-row__head' },
      el('span', { class: 'badge badge--brand' }, '#' + rank),
      idChip({ value: hit.cid, display: hit.cid ? formatCid(hit.cid) : undefined, what: 'CID' }),
      hit.model ? el('span', { class: 'badge' }, hit.model) : null,
    ),
    el(
      'div',
      { class: 'stat__row' },
      el('span', { class: 'text-muted' }, 'Similarity'),
      el(
        'span',
        { class: 'stack' },
        similarityBar(hit.similarity),
        el(
          'span',
          { class: 'num' },
          hit.similarity === null ? EMPTY : formatSimilarity(hit.similarity),
        ),
      ),
    ),
    el(
      'div',
      { class: 'stat__row' },
      el('span', { class: 'text-muted' }, 'Reputation weight'),
      el(
        'span',
        { class: 'num' },
        hit.trustWeight === null ? 'not reported' : formatNumber(hit.trustWeight, 3),
      ),
    ),
    el(
      'div',
      { class: 'stat__row' },
      el('span', { class: 'text-muted' }, 'Combined ranking score'),
      el(
        'span',
        { class: 'num' },
        hit.score === null ? 'not reported' : formatNumber(hit.score, 4),
      ),
    ),
    el('div', { class: 'memory-row__meta' }, el('span', null, hit.agent ?? 'agent not reported')),
    hit.preview ? el('p', { class: 'truncate' }, hit.preview) : null,
  );
}
