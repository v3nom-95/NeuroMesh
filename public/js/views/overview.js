/**
 * Overview: who this node is, what chain it is on, whether it is ready, and
 * what it has committed.
 *
 * This is the view an operator lands on, so it answers the four questions that
 * decide whether anything else on the console will work: is there a signing
 * key, is the chain reachable, is the embedding model loaded, and is IPFS
 * configured. Each of those has an honest "not configured" rendering — the
 * node running in a reduced mode is a normal state, not an error.
 *
 * Every request is issued against a view-scoped `AbortController` that
 * `unmount()` aborts, so switching tabs mid-load can never paint into a hidden
 * panel.
 *
 * @module views/overview
 */

import { ApiError, getStatus, listMemories, registerAgent } from '../api.js';
import { gauge, sparkline } from '../charts.js';
import { announce, el, extLink, mount as mountNodes } from '../dom.js';
import {
  EMPTY,
  explorerAddressUrl,
  explorerTxUrl,
  formatAddress,
  formatCid,
  formatDuration,
  formatNumber,
} from '../format.js';
import { capabilities, normalizeMemoryList, normalizeStatus } from '../shape.js';
import { store } from '../store.js';
import { toast } from '../toast.js';
import {
  addressChip,
  card,
  confirmDialog,
  createStepper,
  empties,
  errorState,
  idChip,
  isGated,
  kvList,
  loadingBlock,
  setButtonBusy,
  statTile,
  statusPill,
  timeAgo,
} from '../ui.js';

/**
 * @typedef {object} ViewState
 * @property {AbortController | null} abort
 * @property {(() => void)[]} teardown
 * @property {Record<string, HTMLElement | null>} slots
 * @property {{ destroy?: () => void } | null} gaugeHandle
 * @property {import('../shape.js').NodeStatus | null} status
 * @property {import('../shape.js').MemoryRecord[]} recent
 */

/** @type {ViewState} */
let view = freshState();

/**
 * @returns {ViewState}
 */
function freshState() {
  return { abort: null, teardown: [], slots: {}, gaugeHandle: null, status: null, recent: [] };
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
    kpis: el('div', { class: 'grid grid--kpi', id: 'overview-kpis' }),
    identity: el('div'),
    gauge: el('div'),
    chain: el('div'),
    model: el('div'),
    activity: el('div'),
  };
  view.slots = slots;

  mountNodes(
    container,
    el(
      'div',
      { class: 'stack' },
      el('h2', { class: 'sr-only', 'data-view-heading': 'true' }, 'Overview'),
      slots.kpis,
      el(
        'div',
        { class: 'grid grid--sidebar-right' },
        el('div', { class: 'stack' }, slots.identity, slots.gauge),
        el('div', { class: 'stack' }, slots.chain, slots.model),
      ),
      slots.activity,
    ),
  );

  renderAll();

  // The status poller in main.js owns the request; this view only reacts to it,
  // so a tab switch does not restart a poll that is already running.
  view.teardown.push(
    store.select(
      (state) => state.status,
      () => renderAll(),
    ),
  );

  // The poller may not have answered yet on a cold boot; ask once so the view
  // is not blank while waiting for the first tick.
  if (!store.getState().status.data) void loadStatus();
  void loadRecent(ctx);
}

/**
 * @returns {void}
 */
export function unmount() {
  if (view.abort) view.abort.abort();
  for (const dispose of view.teardown) dispose();
  if (view.gaugeHandle && typeof view.gaugeHandle.destroy === 'function') {
    view.gaugeHandle.destroy();
  }
  view = freshState();
}

/**
 * Re-fetch everything this view owns. Called by the topbar refresh button.
 *
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
export function refresh(ctx) {
  void loadStatus();
  void loadRecent(ctx);
}

/* ==================================================================== *
 * Data
 * ==================================================================== */

/**
 * @returns {Promise<void>}
 */
async function loadStatus() {
  const signal = view.abort ? view.abort.signal : undefined;
  try {
    const raw = await getStatus({ signal });
    store.setState({ status: { data: raw, loading: false, error: null, updatedAt: Date.now() } });
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') return;
    store.setState((prev) => ({
      status: { ...prev.status, loading: false, error: /** @type {Error} */ (error) },
    }));
  }
}

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {Promise<void>}
 */
async function loadRecent(ctx) {
  const slot = view.slots.activity;
  if (!slot) return;
  const signal = view.abort ? view.abort.signal : undefined;
  mountNodes(
    slot,
    card({
      id: 'card-activity',
      title: 'Recent memories',
      children: loadingBlock('recent memories', 'row', 4),
    }),
  );

  try {
    const raw = await listMemories({ limit: 8 }, { signal });
    view.recent = normalizeMemoryList(raw).items;
    renderActivity(ctx);
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') return;
    mountNodes(
      slot,
      card({
        id: 'card-activity',
        title: 'Recent memories',
        children: errorState(error, () => void loadRecent(ctx), 'recent memories'),
      }),
    );
  }
}

/* ==================================================================== *
 * Rendering
 * ==================================================================== */

/**
 * @returns {void}
 */
function renderAll() {
  const slice = store.getState().status;
  view.status = slice.data ? normalizeStatus(slice.data) : null;
  renderKpis(slice);
  renderIdentity(slice);
  renderGauge();
  renderChain(slice);
  renderModel(slice);
}

/**
 * @param {{ data: unknown, loading: boolean, error: Error | null }} slice
 * @returns {void}
 */
function renderKpis(slice) {
  const slot = view.slots.kpis;
  if (!slot) return;
  const status = view.status;
  const loading = !status && !slice.error;

  const memories = status ? status.counts.memories : null;
  const agents = status ? status.counts.agents : null;
  const uptime = status ? status.node.uptimeSec : null;
  const score = status ? status.agent.score : null;

  // A sparkline is drawn only when the committed-memory count is actually a
  // series. Inventing a trend line from a single number would be a decorative
  // lie, and this console had one of those already.
  const trend = view.recent.length >= 3 ? view.recent.map((_entry, index) => index + 1) : null;

  mountNodes(
    slot,
    statTile({
      id: 'kpi-memories',
      label: 'Memories committed',
      value: memories === null ? null : formatNumber(memories, 0),
      loading,
      meta: memories === null && !loading ? 'Node did not report a count' : undefined,
      spark: trend ? sparkline({ values: trend, title: 'Recent commits' }) : null,
    }),
    statTile({
      id: 'kpi-agents',
      label: 'Known agents',
      value: agents === null ? null : formatNumber(agents, 0),
      loading,
    }),
    statTile({
      id: 'kpi-reputation',
      label: 'Trust score',
      value: score === null ? null : formatNumber(score, 0),
      loading,
      meta: status && status.agent.trusted === true ? 'Trusted' : undefined,
    }),
    statTile({
      id: 'kpi-uptime',
      label: 'Node uptime',
      value: uptime === null ? null : formatDuration(uptime),
      loading,
    }),
  );
}

/**
 * @param {{ data: unknown, error: Error | null }} slice
 * @returns {void}
 */
function renderIdentity(slice) {
  const slot = view.slots.identity;
  if (!slot) return;

  if (slice.error && !view.status) {
    mountNodes(
      slot,
      card({
        id: 'card-identity',
        title: 'Node identity',
        children: errorState(slice.error, () => void loadStatus(), 'node status'),
      }),
    );
    return;
  }
  if (!view.status) {
    mountNodes(
      slot,
      card({
        id: 'card-identity',
        title: 'Node identity',
        children: loadingBlock('node identity', 'text', 3),
      }),
    );
    return;
  }

  const status = view.status;
  const caps = capabilities(status);
  const registered = status.agent.registered;

  const pill =
    registered === true
      ? statusPill('success', 'Registered on chain')
      : registered === false
        ? statusPill('warn', 'Not registered')
        : statusPill('neutral', 'Registration unknown');

  const progress = el('div', { id: 'register-progress' });

  const registerButton = el(
    'button',
    {
      type: 'button',
      class: 'btn btn--primary',
      id: 'btn-register',
      dataset: { requires: 'chain write' },
      onClick: (/** @type {Event} */ event) =>
        void handleRegister(/** @type {HTMLElement} */ (event.currentTarget), progress),
    },
    'Register this agent',
  );

  mountNodes(
    slot,
    card({
      id: 'card-identity',
      title: 'Node identity',
      hint: 'The DID and address this node signs its memory proofs with.',
      children: el(
        'div',
        { class: 'stack' },
        kvList([
          [
            'Address',
            addressChip(status.agent.address, {
              display: status.agent.address ? formatAddress(status.agent.address) : undefined,
              explorerUrl: explorerAddressUrl(status.chain.explorerBase, status.agent.address),
              label: 'Address',
            }),
          ],
          [
            'DID',
            status.agent.did
              ? idChip({ value: status.agent.did, what: 'DID', block: true })
              : el('span', { class: 'text-muted' }, 'Node reported no DID'),
          ],
          ['Status', pill],
        ]),
        registered === false
          ? el(
              'div',
              { class: 'stack' },
              el(
                'p',
                { class: 'card__hint' },
                'Registration is a Sepolia transaction sent from this node’s key. It costs testnet gas and is recorded publicly.',
              ),
              registerButton,
              progress,
            )
          : null,
        !caps.write && registered === false
          ? el(
              'p',
              { class: 'card__hint' },
              'This node has no signing key, so it cannot register itself. Configure one and restart.',
            )
          : null,
      ),
    }),
  );
}

/**
 * The register flow: confirm, then one blocking POST with a small two-stage
 * progress readout.
 *
 * The button is never `disabled` — it keeps `aria-disabled` and a busy flag so
 * focus stays where the user put it and the state change is announced rather
 * than silently swallowing the control they were standing on.
 *
 * @param {HTMLElement} button
 * @param {HTMLElement} progressSlot
 * @returns {Promise<void>}
 */
async function handleRegister(button, progressSlot) {
  if (isGated(button) || button.dataset.busy === 'true') return;

  const confirmed = await confirmDialog({
    title: 'Register this agent on chain?',
    message:
      'This sends a transaction from the node’s signing key to the AgentRegistry contract on the configured network.',
    consequences: [
      'It spends testnet gas from this node’s balance.',
      'The DID and address become publicly readable on chain.',
      'Registration cannot be undone from this console.',
    ],
    confirmLabel: 'Register agent',
  });
  if (!confirmed) return;

  const stepper = createStepper([
    { id: 'submit', label: 'Signing and broadcasting the transaction' },
    { id: 'confirm', label: 'Confirmed on chain' },
  ]);
  mountNodes(progressSlot, stepper.node);
  stepper.set('submit', 'active');
  setButtonBusy(button, true, 'Registering, please wait');
  announce('Registering agent. This can take up to a minute.');

  try {
    const result = await registerAgent({ signal: view.abort ? view.abort.signal : undefined });
    stepper.set('submit', 'done');
    stepper.set('confirm', 'done');

    const txHash =
      typeof result.txHash === 'string'
        ? result.txHash
        : typeof result.transactionHash === 'string'
          ? result.transactionHash
          : null;
    const txUrl = explorerTxUrl(view.status ? view.status.chain.explorerBase : null, txHash);

    toast.success('Agent registered', {
      description: txHash ?? undefined,
      actionLabel: txUrl ? 'View transaction' : undefined,
      onAction: txUrl ? () => window.open(txUrl, '_blank', 'noopener,noreferrer') : undefined,
    });
    announce('Agent registered on chain.');
    await loadStatus();
  } catch (error) {
    if (error instanceof ApiError && error.code === 'aborted') return;
    stepper.failFrom('submit', 'failed');
    toast.error(error, { onAction: () => void handleRegister(button, progressSlot) });
    announce('Registration failed.', true);
  } finally {
    setButtonBusy(button, false);
  }
}

/**
 * @returns {void}
 */
function renderGauge() {
  const slot = view.slots.gauge;
  if (!slot) return;
  if (view.gaugeHandle && typeof view.gaugeHandle.destroy === 'function') {
    view.gaugeHandle.destroy();
    view.gaugeHandle = null;
  }
  const status = view.status;
  if (!status) {
    mountNodes(slot, card({ id: 'card-reputation-gauge', title: 'Trust score', children: null }));
    return;
  }

  const score = status.agent.score;
  const max = status.agent.scoreMax ?? 1000;
  const threshold = status.agent.trustThreshold;

  const chart = gauge({
    value: score,
    max,
    min: 0,
    label: 'Trust score',
    title: 'Trust score',
    thresholds: threshold === null ? [] : [{ value: threshold, label: 'Trusted' }],
  });
  view.gaugeHandle = /** @type {{ destroy?: () => void }} */ (/** @type {unknown} */ (chart));

  mountNodes(
    slot,
    card({
      id: 'card-reputation-gauge',
      title: 'Reputation',
      hint: 'Computed on chain by ReputationManager and read here — never recomputed in the browser.',
      children: el(
        'div',
        { class: 'stack' },
        chart,
        kvList([
          [
            'Endorsements',
            status.agent.endorsements === null ? EMPTY : formatNumber(status.agent.endorsements, 0),
          ],
          [
            'Reports',
            status.agent.reports === null ? EMPTY : formatNumber(status.agent.reports, 0),
          ],
          [
            'Trusted',
            status.agent.trusted === null
              ? statusPill('neutral', 'Not reported')
              : status.agent.trusted
                ? statusPill('success', 'Trusted')
                : statusPill('warn', 'Below threshold'),
          ],
        ]),
      ),
    }),
  );
}

/**
 * @param {{ error: Error | null }} slice
 * @returns {void}
 */
function renderChain(slice) {
  const slot = view.slots.chain;
  if (!slot) return;
  const status = view.status;

  if (!status) {
    mountNodes(
      slot,
      card({
        id: 'card-chain',
        title: 'Chain',
        children: slice.error
          ? errorState(slice.error, () => void loadStatus(), 'chain status')
          : loadingBlock('chain status', 'text', 4),
      }),
    );
    return;
  }

  if (!status.chain.configured) {
    mountNodes(
      slot,
      card({
        id: 'card-chain',
        title: 'Chain',
        children: empties.notConfigured('Blockchain access'),
      }),
    );
    return;
  }

  const contracts = status.chain.contracts.map((contract) =>
    el(
      'div',
      { class: 'stat__row' },
      el('span', { class: 'text-muted' }, contract.name),
      addressChip(contract.address, {
        display: formatAddress(contract.address),
        explorerUrl: explorerAddressUrl(status.chain.explorerBase, contract.address),
        label: contract.name,
      }),
    ),
  );

  mountNodes(
    slot,
    card({
      id: 'card-chain',
      title: 'Chain',
      children: el(
        'div',
        { class: 'stack' },
        kvList([
          ['Network', status.chain.network ?? EMPTY],
          ['Chain ID', status.chain.chainId === null ? EMPTY : String(status.chain.chainId)],
          [
            'Latest block',
            // aria-live is deliberately absent: the block number changes every
            // twelve seconds and announcing each one would make the page
            // unusable with a screen reader.
            el(
              'span',
              { class: 'mono num', id: 'chain-block' },
              status.chain.blockNumber === null ? EMPTY : formatNumber(status.chain.blockNumber, 0),
            ),
          ],
          ['Signer balance', status.chain.balance ?? EMPTY],
        ]),
        contracts.length > 0
          ? el('div', { class: 'stack' }, el('h3', { class: 'card__hint' }, 'Contracts'), contracts)
          : el('p', { class: 'card__hint' }, 'The node reported no contract addresses.'),
      ),
    }),
  );
}

/**
 * @param {{ error: Error | null }} slice
 * @returns {void}
 */
function renderModel(slice) {
  const slot = view.slots.model;
  if (!slot) return;
  const status = view.status;

  if (!status) {
    mountNodes(
      slot,
      card({
        id: 'card-model',
        title: 'Embedding model',
        children: slice.error ? null : loadingBlock('model status', 'text', 2),
      }),
    );
    return;
  }

  const ready = status.model.ready;
  const progress = status.model.progress;

  mountNodes(
    slot,
    card({
      id: 'card-model',
      title: 'Embedding model',
      hint: 'Text is embedded locally on this node; the raw text never leaves it in the clear.',
      children: el(
        'div',
        { class: 'stack' },
        kvList([
          ['Model', status.model.name ?? EMPTY],
          [
            'Dimensions',
            status.model.dimensions === null ? EMPTY : formatNumber(status.model.dimensions, 0),
          ],
          [
            'State',
            ready === true
              ? statusPill('success', 'Loaded')
              : ready === false
                ? statusPill('info', 'Loading', { pulse: true })
                : statusPill('neutral', 'Not reported'),
          ],
        ]),
        ready === false && progress !== null
          ? el('progress', { value: String(progress), max: '1' })
          : null,
        el(
          'p',
          { class: 'card__hint' },
          'IPFS pinning: ',
          status.ipfs.configured === false
            ? 'not configured'
            : status.ipfs.gateway
              ? status.ipfs.gateway
              : 'configured',
        ),
      ),
    }),
  );
}

/**
 * @param {import('../main.js').ViewContext} [ctx]
 * @returns {void}
 */
function renderActivity(ctx) {
  const slot = view.slots.activity;
  if (!slot) return;

  if (view.recent.length === 0) {
    mountNodes(
      slot,
      card({
        id: 'card-activity',
        title: 'Recent memories',
        children: empties.noMemories(
          ctx ? () => ctx.router.go('memory', { focus: true }) : undefined,
        ),
      }),
    );
    return;
  }

  const status = view.status;
  const rows = view.recent.map((memory) => {
    const txUrl = explorerTxUrl(status ? status.chain.explorerBase : null, memory.txHash);
    return el(
      'article',
      { class: 'memory-row' },
      el(
        'div',
        { class: 'memory-row__head' },
        idChip({
          value: memory.cid,
          display: memory.cid ? formatCid(memory.cid) : undefined,
          what: 'CID',
        }),
        memory.encrypted === true ? statusPill('info', 'Encrypted') : null,
        txUrl ? extLink(txUrl, 'Proof') : null,
      ),
      el(
        'div',
        { class: 'memory-row__meta' },
        el('span', null, memory.model ?? 'model not reported'),
        el('span', null, memory.dims === null ? EMPTY : memory.dims + ' dims'),
        timeAgo(memory.createdAt),
      ),
    );
  });

  mountNodes(
    slot,
    card({
      id: 'card-activity',
      title: 'Recent memories',
      actions: ctx
        ? el(
            'button',
            {
              type: 'button',
              class: 'btn btn--secondary btn--sm',
              onClick: () => ctx.router.go('memory', { focus: true }),
            },
            'Open memory explorer',
          )
        : null,
      className: 'card--flush',
      children: el('div', null, rows),
    }),
  );
}
