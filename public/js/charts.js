/**
 * NeuroMesh — hand-rolled, dependency-free, theme-reactive inline-SVG charts.
 *
 * The README used to advertise Chart.js; there was never a chart in the
 * codebase. This module is the honest version of that claim: six chart types,
 * zero dependencies, zero CDN, zero canvas, built entirely with the `svg()`
 * constructor from dom.js so that no string is ever parsed as markup.
 *
 * ------------------------------------------------------------------------
 * COLOUR: why there is not a single colour literal in this file
 * ------------------------------------------------------------------------
 * SVG presentation attributes cannot resolve `var()`. If a bar were drawn as
 * `fill="#4facfe"` the whole visualisation would be welded to one theme and a
 * light/dark toggle would produce an unreadable picture until the next render.
 *
 * So every fill and stroke in here is expressed as a CLASS defined in
 * css/charts.css, which reads the custom properties from css/tokens.css. The
 * browser resolves those properties at paint time against the live cascade,
 * which is strictly stronger than resolving them in JS at render time: a theme
 * flip recolours every chart on screen with no re-render, no ResizeObserver
 * churn, and no risk of a stale colour surviving in a chart a view forgot to
 * rebuild. `grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(' charts.js` is empty.
 *
 * Numeric presentation attributes (`stroke-width`, `stroke-opacity`, `r`, `x`)
 * ARE written from JS, because those encode data rather than theme.
 *
 * ------------------------------------------------------------------------
 * ACCESSIBILITY CONTRACT (applies to every export)
 * ------------------------------------------------------------------------
 *   - The `<svg>` carries `role="img"` and `aria-labelledby` pointing at its
 *     own `<title>` and `<desc>`, so a screen reader gets a one-sentence
 *     summary instead of a soup of anonymous shapes.
 *   - EVERY chart additionally emits an offscreen
 *     `<table class="visually-hidden-table sr-only">` with a real `<caption>`
 *     and `<th scope>` headers holding the actual numbers. `role="img"` prunes
 *     the SVG subtree from the accessibility tree, so this table — not the
 *     shapes — is how assistive technology reads the data. It is also
 *     selectable and copy-pasteable, which the picture is not.
 *   - Meaning is never carried by colour alone (WCAG 1.4.1): endorsements and
 *     reports differ by glyph (+ / −) and by line dash, untrusted nodes by a
 *     dashed ring, missing heatmap cells by a hatch pattern.
 *   - Charts are responsive through `viewBox` + `preserveAspectRatio` and
 *     `width:100%;height:auto`. No export ever writes a pixel width.
 *   - `prefers-reduced-motion: reduce` suppresses the entry animation at the
 *     source (the `chart--enter` class is simply not added), in addition to
 *     the global neutralising block in base.css.
 *
 * ------------------------------------------------------------------------
 * API SHAPE
 * ------------------------------------------------------------------------
 * Every export is callable two ways:
 *
 *     const fig = barChart({ data, labels });        // returns the element
 *     barChart(containerEl, { data, labels });       // ...and mounts it
 *
 * The return value IS the `<figure class="chart-frame">` element, so it can be
 * passed straight to `mount()` / `append()` from dom.js. `update()`,
 * `refresh()` and `destroy()` are attached to it as non-enumerable properties:
 *
 *     const fig = gauge({ value: 620, max: 1000 });
 *     mount(mountPoint, fig);
 *     fig.update({ value: 780 });   // re-render with merged options
 *     fig.destroy();                // disconnect observers, drop listeners
 *
 * Returning the element rather than a `{ el }` wrapper is deliberate: dom.js
 * coerces an unknown child to a text node, so `mount(x, chart)` with a plain
 * object would silently render "[object Object]" instead of failing loudly.
 *
 * @module charts
 */

import { append, clear, el, mount, on, svg } from './dom.js';
import {
  EMPTY,
  bucketIndex,
  clamp,
  debounce,
  formatDateTime,
  formatMs,
  formatNumber,
  formatSimilarity,
  niceTicks,
  quantile,
  truncateMiddle,
} from './format.js';

/* ==================================================================== *
 * Small numeric and geometric helpers
 * ==================================================================== */

/**
 * Monotonic id source. Chart ids appear in `aria-labelledby` and in `<marker>`
 * and `<pattern>` references, all of which must be unique per document or two
 * charts on one page will share a single arrowhead definition.
 */
let uidCounter = 0;

/**
 * @param {string} [prefix]
 * @returns {string}
 */
function nextId(prefix = 'nmc') {
  uidCounter += 1;
  return prefix + '-' + uidCounter.toString(36);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Path data with two decimals. Full float precision produces paths four times
 * longer with no visible difference at any zoom this console reaches.
 *
 * @param {number} value
 * @returns {number}
 */
function r2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Polar to cartesian with 0deg at twelve o'clock, angles increasing clockwise
 * — the convention every gauge and radial layout in this file uses.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @param {number} degrees
 * @returns {number[]} `[x, y]`
 */
function polar(cx, cy, radius, degrees) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
}

/**
 * A circular arc as path data.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 * @param {number} startDeg
 * @param {number} endDeg
 * @returns {string}
 */
function arcPath(cx, cy, radius, startDeg, endDeg) {
  const start = polar(cx, cy, radius, startDeg);
  const end = polar(cx, cy, radius, endDeg);
  const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const sweep = endDeg >= startDeg ? 1 : 0;
  return (
    'M ' +
    r2(start[0]) +
    ' ' +
    r2(start[1]) +
    ' A ' +
    r2(radius) +
    ' ' +
    r2(radius) +
    ' 0 ' +
    largeArc +
    ' ' +
    sweep +
    ' ' +
    r2(end[0]) +
    ' ' +
    r2(end[1])
  );
}

/**
 * Width of a string in user units, estimated rather than measured.
 * `getComputedTextLength()` needs the node laid out, which would force a
 * synchronous reflow per label mid-render; for deciding whether a column label
 * fits its cell, 0.58em per character is more than accurate enough.
 *
 * @param {string} value
 * @param {number} fontSize
 * @returns {number}
 */
function estimateTextWidth(value, fontSize) {
  return String(value).length * fontSize * 0.58;
}

/**
 * @returns {boolean} true when the user has asked for reduced motion
 */
function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Measured inline size of the frame, with a sane fallback for jsdom and for a
 * first render inside a hidden tab panel (both report 0).
 *
 * @param {Element} node
 * @returns {number}
 */
function measureWidth(node) {
  const rect =
    typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
  const width = rect ? rect.width : 0;
  return width > 0 ? width : 640;
}

/**
 * Tick density and label rotation are chosen from a coarse BAND rather than
 * the raw pixel width, so a one-pixel resize cannot trigger a render loop.
 *
 * @param {number} px
 * @returns {string} 'sm' | 'md' | 'lg'
 */
function densityBand(px) {
  if (px < 400) return 'sm';
  if (px < 760) return 'md';
  return 'lg';
}

/**
 * Coerce anything the backend might send into a finite number or null.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Labels come from remote data (agent ids, model names, CIDs) and can be
 * arbitrarily long. Everything on an axis is truncated in the middle so the
 * distinguishing tail survives; the full value stays in the tooltip, the
 * `aria-label` and the offscreen table.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function shortLabel(value, max) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.length > max
    ? truncateMiddle(text, Math.ceil(max * 0.6), Math.floor(max * 0.3))
    : text;
}

/* ==================================================================== *
 * Frame, offscreen data table, tooltip
 * ==================================================================== */

/**
 * Build the `<svg>` shell shared by every chart: viewBox sizing, `role="img"`,
 * and the title/desc pair wired through `aria-labelledby`.
 *
 * @param {object} spec
 * @param {string} spec.kind    modifier slug, e.g. 'bar'
 * @param {string} spec.title   one line, becomes `<title>`
 * @param {string} spec.desc    one sentence, becomes `<desc>`
 * @param {number} spec.width   viewBox width in user units
 * @param {number} spec.height  viewBox height in user units
 * @param {boolean} [spec.animate]
 * @returns {{ id: string, root: SVGElement }}
 */
function createSvgFrame(spec) {
  const id = nextId();
  const root = svg(
    'svg',
    {
      class: ['chart', 'chart--' + spec.kind, spec.animate ? 'chart--enter' : null],
      viewBox: '0 0 ' + spec.width + ' ' + spec.height,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-labelledby': id + '-t ' + id + '-d',
    },
    svg('title', { id: id + '-t' }, spec.title),
    svg('desc', { id: id + '-d' }, spec.desc),
  );
  return { id, root };
}

/**
 * The offscreen data equivalent. This is the part assistive technology
 * actually reads, because `role="img"` hides the shapes.
 *
 * The first cell of each row is a `<th scope="row">`, so a screen reader
 * announces "IPFS pin, 2.8 s" rather than two disconnected values.
 *
 * @param {object} spec
 * @param {string} spec.caption
 * @param {string[]} spec.headers
 * @param {Array<Array<unknown>>} spec.rows
 * @returns {HTMLElement}
 */
function dataTable(spec) {
  const head = el(
    'thead',
    null,
    el(
      'tr',
      null,
      spec.headers.map((header, index) =>
        el('th', { scope: 'col', class: index === 0 ? null : 'num' }, header),
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
          const value = cell === null || cell === undefined || cell === '' ? EMPTY : cell;
          return index === 0
            ? el('th', { scope: 'row' }, value)
            : el('td', { class: 'num' }, value);
        }),
      ),
    ),
  );
  return el(
    'table',
    { class: 'visually-hidden-table sr-only' },
    el('caption', null, spec.caption),
    head,
    body,
  );
}

/**
 * Hover AND focus tooltip for data marks.
 *
 * The text lives in a `data-tip` ATTRIBUTE on the mark and is copied into the
 * tooltip with `textContent`, so a `reason` string out of
 * `simulation-results.json` — the exact payload the old dashboard interpolated
 * into raw markup — cannot become markup here even in principle.
 *
 * Positioning writes two CSS custom properties through the CSSOM rather than a
 * `style="left:…"` attribute; charts.css turns them into a `translate()`. CSP's
 * `style-src-attr` governs parsed attributes, not CSSOM writes, so this stays
 * clean under `default-src 'self'`.
 *
 * The tooltip is appended to the figure by this function rather than returned
 * as part of the render output. That is safe because `createChart` empties the
 * figure BEFORE it calls `build()`, never after — see the comment there.
 *
 * @param {HTMLElement} figure
 * @param {SVGElement} root
 * @param {Array<() => void>} disposers
 * @returns {HTMLElement} the tooltip node
 */
function attachTooltip(figure, root, disposers) {
  const tip = el('div', { class: 'ch-tip', hidden: true });
  figure.appendChild(tip);

  /**
   * @param {EventTarget | null} target
   * @returns {Element | null}
   */
  const markFor = (target) => (target instanceof Element ? target.closest('[data-tip]') : null);

  /** @param {Element} mark */
  const show = (mark) => {
    const label = mark.getAttribute('data-tip');
    if (!label) return;
    tip.textContent = label;
    tip.hidden = false;
    if (typeof figure.getBoundingClientRect !== 'function') return;
    const frameRect = figure.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    if (frameRect.width <= 0) return;
    tip.style.setProperty(
      '--tip-x',
      r2(markRect.left - frameRect.left + markRect.width / 2) + 'px',
    );
    tip.style.setProperty('--tip-y', r2(markRect.top - frameRect.top) + 'px');
  };

  const hide = () => {
    tip.hidden = true;
    tip.textContent = '';
  };

  disposers.push(
    on(root, 'pointerover', (event) => {
      const mark = markFor(event.target);
      if (mark) show(mark);
    }),
    on(root, 'pointerout', hide),
    on(root, 'focusin', (event) => {
      const mark = markFor(event.target);
      if (mark) show(mark);
    }),
    on(root, 'focusout', hide),
    on(root, 'keydown', (event) => {
      if (/** @type {KeyboardEvent} */ (event).key === 'Escape') hide();
    }),
    hide,
  );

  return tip;
}

/**
 * The empty state every chart falls back to. A chart with no data must never
 * render a bare pair of axes: on a fresh clone `GET /api/simulation-results` 404s,
 * and an empty axis reads as "every number is zero" rather than "there is
 * nothing here yet".
 *
 * @param {string} title
 * @param {string} message
 * @param {string} [hint] a command or next step, rendered as a code chip
 * @returns {HTMLElement}
 */
function emptyBlock(title, message, hint) {
  return el(
    'div',
    { class: 'empty empty--chart' },
    el('p', { class: 'empty__title' }, title),
    el('p', { class: 'empty__body' }, message),
    hint ? el('code', { class: 'empty__cmd' }, hint) : null,
  );
}

/**
 * A `<figcaption>`, or nothing when there is no caption to give.
 *
 * @param {unknown} caption
 * @returns {HTMLElement|null}
 */
function captionNode(caption) {
  if (!caption) return null;
  return el('figcaption', { class: 'chart-caption' }, String(caption));
}

/* ==================================================================== *
 * The chart lifecycle wrapper
 * ==================================================================== */

/**
 * Create the persistent `<figure>`, run `build` into it, and wire the resize
 * and teardown lifecycle.
 *
 * The figure element is stable across re-renders; only its children are
 * replaced. That matters because the caller holds a reference to it (it is the
 * return value) and because a `ResizeObserver` observing a node that got
 * swapped out would silently stop firing.
 *
 * @param {string} kind
 * @param {Element | null} container
 * @param {Record<string, any>} options
 * @param {(opts: Record<string, any>, ctx: Record<string, any>) => unknown} build
 * @returns {HTMLElement}
 */
function createChart(kind, container, options, build) {
  const figure = el('figure', { class: ['chart-frame', 'chart-frame--' + kind] });
  /** @type {Record<string, any>} */
  let opts = Object.assign({}, options);
  /** @type {Array<() => void>} */
  let disposers = [];
  let band = 'lg';
  let destroyed = false;

  const runDisposers = () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        console.warn('[charts] teardown failed', error);
      }
    }
    disposers = [];
  };

  function render() {
    if (destroyed) return;
    runDisposers();
    band = densityBand(measureWidth(figure));
    // Emptied BEFORE the build, not after. `attachTooltip` appends its tooltip
    // node to the figure while the chart is being constructed; clearing
    // afterwards would silently delete it and every chart would lose its
    // tooltip with no error anywhere.
    clear(figure);
    const ctx = { band, reduced: prefersReducedMotion(), figure, disposers };
    let parts;
    try {
      parts = build(opts, ctx);
    } catch (error) {
      // A malformed payload must degrade to a message, never to a blank panel
      // plus a console exception — that was the old dashboard's failure mode
      // for the entire Swarm tab.
      console.error('[charts] render failed for "' + kind + '"', error);
      parts = emptyBlock(
        'Chart unavailable',
        'This visualisation could not be drawn from the data the node returned.',
      );
    }
    append(figure, parts);
  }

  render();

  /** @type {ResizeObserver | null} */
  let observer = null;
  if (typeof ResizeObserver === 'function') {
    const onResize = debounce(() => {
      if (destroyed) return;
      if (densityBand(measureWidth(figure)) !== band) render();
    }, 120);
    observer = new ResizeObserver(onResize);
    observer.observe(figure);
    // Not pushed onto `disposers`: those are cleared on every render, and the
    // observer must outlive a render. It is cancelled in destroy() instead.
    const cancelResize = () => onResize.cancel();
    Object.defineProperty(figure, '__cancelResize', {
      value: cancelResize,
      enumerable: false,
      configurable: true,
    });
  }

  Object.defineProperties(figure, {
    options: { get: () => opts, enumerable: false, configurable: true },
    update: {
      value: (/** @type {Record<string, unknown>} */ next) => {
        opts = Object.assign({}, opts, next || {});
        render();
      },
      enumerable: false,
      configurable: true,
    },
    refresh: { value: render, enumerable: false, configurable: true },
    destroy: {
      value: () => {
        if (destroyed) return;
        destroyed = true;
        if (observer) observer.disconnect();
        observer = null;
        const cancel = /** @type {any} */ (figure).__cancelResize;
        if (typeof cancel === 'function') cancel();
        runDisposers();
        clear(figure);
        figure.remove();
      },
      enumerable: false,
      configurable: true,
    },
  });

  if (container) mount(container, figure);
  return figure;
}

/**
 * Both call styles resolve here: `chart(opts)` and `chart(container, opts)`.
 *
 * @param {unknown} first
 * @param {unknown} second
 * @returns {{ container: Element | null, options: Record<string, any> }}
 */
function normalizeArgs(first, second) {
  if (typeof Element !== 'undefined' && first instanceof Element) {
    return { container: first, options: /** @type {any} */ (second) || {} };
  }
  return { container: null, options: /** @type {any} */ (first) || {} };
}

/* ==================================================================== *
 * Shared cartesian plumbing (bars and grouped bars)
 * ==================================================================== */

/**
 * Normalise the two accepted bar-input shapes into one list.
 *
 *   { data: [9, 15, 13], labels: ['a', 'b', 'c'] }   // this task's shape
 *   { series: [{ label: 'a', value: 9 }, ...] }      // the frontend spec's
 *
 * @param {Record<string, any>} opts
 * @returns {Array<{ label: string, value: number, tone: number|null }>}
 */
function normalizeBarSeries(opts) {
  if (Array.isArray(opts.series)) {
    return opts.series
      .map((entry, index) => ({
        label: String(entry && entry.label !== undefined ? entry.label : index + 1),
        value: toNumber(entry && entry.value),
        tone: isNum(entry && entry.tone) ? entry.tone : null,
      }))
      .filter((entry) => entry.value !== null)
      .map((entry) => ({
        label: entry.label,
        value: /** @type {number} */ (entry.value),
        tone: entry.tone,
      }));
  }
  const values = Array.isArray(opts.data) ? opts.data : [];
  const labels = Array.isArray(opts.labels) ? opts.labels : [];
  /** @type {Array<{ label: string, value: number, tone: number|null }>} */
  const out = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = toNumber(values[index]);
    if (value === null) continue;
    out.push({
      label: String(labels[index] !== undefined ? labels[index] : index + 1),
      value,
      tone: null,
    });
  }
  return out;
}

/**
 * Draw the value axis: gridlines, ticks and the baseline.
 *
 * @param {object} spec
 * @param {number[]} spec.ticks
 * @param {(value: number) => number} spec.y
 * @param {number} spec.left
 * @param {number} spec.right
 * @param {number} spec.bottom
 * @param {(value: number) => string} spec.format
 * @returns {SVGElement}
 */
function valueAxis(spec) {
  const parts = spec.ticks.map((tick) => {
    const y = r2(spec.y(tick));
    return svg(
      'g',
      null,
      svg('line', { class: 'ch-grid', x1: spec.left, y1: y, x2: spec.right, y2: y }),
      svg(
        'text',
        { class: 'ch-tick', x: spec.left - 8, y: y + 3.5, 'text-anchor': 'end' },
        spec.format(tick),
      ),
    );
  });
  parts.push(
    svg('line', {
      class: 'ch-axis',
      x1: spec.left,
      y1: spec.bottom,
      x2: spec.right,
      y2: spec.bottom,
    }),
  );
  return svg('g', { class: 'ch-axis-group', 'aria-hidden': 'true' }, parts);
}

/* ==================================================================== *
 * 1. barChart — latency bars with p50 / p95 reference markers
 * ==================================================================== */

/**
 * Vertical bar chart with a value axis and dashed percentile reference lines.
 *
 * This is the replacement for the four arithmetic means the old dashboard
 * printed as `<h3>` numbers. The repo's own `simulation-results.json` records
 * `blockchainLatencies` of `[16190, 21288, 7033, …]`, a distribution whose mean
 * is actively misleading; the p50/p95 markers exist so the shape is visible.
 *
 * Accepted input (either shape):
 *   `{ data: number[], labels: string[], unit?: string }`
 *   `{ series: Array<{ label: string, value: number, tone?: number }> }`
 *
 * Other options:
 *   `unit`        — 'ms' (default, uses formatMs), 'count', or a bare suffix
 *   `valueFormat` — explicit `(n) => string`, overrides `unit`
 *   `markers`     — `Array<{ label, value, variant?: 'p50'|'p95' }>`; when
 *                   omitted, p50 and p95 are computed from the data itself
 *                   unless `autoMarkers: false`
 *   `title` / `desc` / `caption` / `height` / `colorIndex` (1..6)
 *
 * @param {unknown} first  container element, or the options object
 * @param {unknown} [second] options, when a container was passed
 * @returns {HTMLElement} the `<figure>`, with update/refresh/destroy attached
 */
export function barChart(first, second) {
  const args = normalizeArgs(first, second);
  return createChart('bar', args.container, args.options, (opts, ctx) => {
    const items = normalizeBarSeries(opts);
    const title = String(opts.title || 'Latency by stage');

    if (items.length === 0) {
      return [
        emptyBlock(
          'No measurements yet',
          String(
            opts.emptyMessage ||
              'This node has not recorded any timings for these stages. Commit a memory, or run the benchmark, to populate the chart.',
          ),
          opts.emptyHint ? String(opts.emptyHint) : 'npm run simulate',
        ),
      ];
    }

    const format =
      typeof opts.valueFormat === 'function'
        ? opts.valueFormat
        : opts.unit === 'ms' || opts.unit === undefined
          ? formatMs
          : (/** @type {number} */ value) =>
              formatNumber(value) + (opts.unit ? ' ' + opts.unit : '');

    const values = items.map((item) => item.value);
    /** @type {Array<{ label: string, value: number, variant: string }>} */
    let markers = [];
    if (Array.isArray(opts.markers)) {
      markers = opts.markers
        .map((marker) => ({
          label: String(marker && marker.label ? marker.label : ''),
          value: toNumber(marker && marker.value),
          variant: String((marker && marker.variant) || 'p50'),
        }))
        .filter((marker) => marker.value !== null)
        .map((marker) => ({
          label: marker.label,
          value: /** @type {number} */ (marker.value),
          variant: marker.variant,
        }));
    } else if (opts.autoMarkers !== false && values.length >= 3) {
      markers = [
        { label: 'p50', value: quantile(values, 0.5), variant: 'p50' },
        { label: 'p95', value: quantile(values, 0.95), variant: 'p95' },
      ].filter((marker) => isNum(marker.value));
    }

    const width = 680;
    const height = isNum(opts.height) ? opts.height : 300;
    const rotate =
      ctx.band === 'sm' ||
      items.some((item) => estimateTextWidth(item.label, 11) > (width - 90) / items.length);
    const left = 62;
    const right = width - 22;
    const top = 20;
    const bottom = height - (rotate ? 74 : 42);
    const plotWidth = right - left;
    const plotHeight = bottom - top;

    const dataMax = Math.max(...values, ...markers.map((marker) => marker.value), 0);
    const ticks = niceTicks(0, dataMax || 1, ctx.band === 'sm' ? 3 : 5);
    const axisMax = ticks.length ? Math.max(ticks[ticks.length - 1], dataMax) : dataMax || 1;
    /** @param {number} value */
    const y = (value) => top + plotHeight * (1 - clamp(value / (axisMax || 1), 0, 1));

    const slot = plotWidth / items.length;
    const barWidth = Math.max(6, Math.min(slot * 0.62, 72));
    const toneClass = isNum(opts.colorIndex) ? 'ch-bar--c' + opts.colorIndex : null;

    const bars = items.map((item, index) => {
      const cx = left + slot * (index + 0.5);
      const barTop = y(item.value);
      const label = item.label + ': ' + format(item.value);
      return svg(
        'g',
        null,
        svg('rect', {
          class: ['ch-bar', item.tone ? 'ch-bar--c' + item.tone : toneClass],
          x: r2(cx - barWidth / 2),
          y: r2(barTop),
          width: r2(barWidth),
          height: r2(Math.max(1, bottom - barTop)),
          rx: 3,
          tabindex: '0',
          role: 'img',
          'aria-label': label,
          'data-tip': label,
        }),
        svg(
          'text',
          {
            class: 'ch-value',
            x: r2(cx),
            y: r2(Math.max(top + 10, barTop - 6)),
            'text-anchor': 'middle',
          },
          format(item.value),
        ),
      );
    });

    const categoryLabels = items.map((item, index) => {
      const cx = left + slot * (index + 0.5);
      const short = shortLabel(item.label, ctx.band === 'sm' ? 8 : 16);
      return rotate
        ? svg(
            'text',
            {
              class: 'ch-label',
              x: r2(cx),
              y: bottom + 14,
              'text-anchor': 'end',
              transform: 'rotate(-35 ' + r2(cx) + ' ' + (bottom + 14) + ')',
            },
            short,
          )
        : svg(
            'text',
            { class: 'ch-label', x: r2(cx), y: bottom + 18, 'text-anchor': 'middle' },
            short,
          );
    });

    const markerNodes = markers.map((marker) => {
      const my = r2(y(marker.value));
      const text = marker.label + ' · ' + format(marker.value);
      return svg(
        'g',
        { class: 'ch-marker-group', 'data-tip': text },
        svg('line', {
          class: ['ch-marker', marker.variant === 'p95' ? 'ch-marker--p95' : null],
          x1: left,
          y1: my,
          x2: right,
          y2: my,
        }),
        svg(
          'text',
          { class: 'ch-marker-label', x: right - 2, y: my - 5, 'text-anchor': 'end' },
          text,
        ),
      );
    });

    const desc =
      String(opts.desc || '') ||
      items.length +
        ' stages, values from ' +
        format(Math.min(...values)) +
        ' to ' +
        format(Math.max(...values)) +
        (markers.length
          ? ', with ' + markers.map((m) => m.label).join(' and ') + ' reference lines'
          : '') +
        '.';

    const frame = createSvgFrame({
      kind: 'bar',
      title,
      desc,
      width,
      height,
      animate: !ctx.reduced,
    });
    append(
      frame.root,
      valueAxis({ ticks, y, left, right, bottom, format }),
      svg('g', { class: 'ch-bars' }, bars),
      svg('g', { class: 'ch-category-labels', 'aria-hidden': 'true' }, categoryLabels),
      svg('g', { class: 'ch-markers' }, markerNodes),
    );
    attachTooltip(ctx.figure, frame.root, ctx.disposers);

    const rows = items.map((item) => [item.label, format(item.value)]);
    for (const marker of markers) rows.push([marker.label + ' (reference)', format(marker.value)]);

    return [
      frame.root,
      captionNode(opts.caption),
      dataTable({ caption: title + ' — data table', headers: ['Stage', 'Value'], rows }),
    ];
  });
}

/* ==================================================================== *
 * 2. groupedBarChart — one group per stage, one bar per statistic
 * ==================================================================== */

/**
 * Clustered bars with a real legend of `<button aria-pressed>` toggles.
 *
 * Used for the p50 / p95 / p99 breakdown per pipeline stage. Toggling a series
 * hides its bars without rescaling the axis: a scale that jumps when a series
 * is hidden makes the remaining bars impossible to compare against the reading
 * the user just took.
 *
 * @param {unknown} first
 * @param {unknown} [second] `{ groups: Array<{label, values:number[]}>, seriesNames: string[] }`
 * @returns {HTMLElement}
 */
export function groupedBarChart(first, second) {
  const args = normalizeArgs(first, second);
  return createChart('grouped', args.container, args.options, (opts, ctx) => {
    const groups = (Array.isArray(opts.groups) ? opts.groups : [])
      .map((group, index) => ({
        label: String(group && group.label !== undefined ? group.label : index + 1),
        values: (Array.isArray(group && group.values) ? group.values : []).map(toNumber),
      }))
      .filter((group) => group.values.some((value) => value !== null));
    const seriesNames = (Array.isArray(opts.seriesNames) ? opts.seriesNames : []).map(String);
    const title = String(opts.title || 'Distribution by stage');

    if (groups.length === 0 || seriesNames.length === 0) {
      return [
        emptyBlock(
          'No distribution data',
          'The node has not reported enough samples to compute per-stage percentiles yet.',
          'npm run simulate',
        ),
      ];
    }

    const format = typeof opts.valueFormat === 'function' ? opts.valueFormat : formatMs;
    const hidden = new Set(Array.isArray(opts.hiddenSeries) ? opts.hiddenSeries.map(Number) : []);

    const width = 680;
    const height = isNum(opts.height) ? opts.height : 320;
    const left = 62;
    const right = width - 22;
    const top = 20;
    const bottom = height - 46;
    const plotWidth = right - left;
    const plotHeight = bottom - top;

    /** @type {number[]} */
    const flat = [];
    for (const group of groups) {
      for (const value of group.values) if (value !== null) flat.push(value);
    }
    const ticks = niceTicks(0, Math.max(...flat, 1), ctx.band === 'sm' ? 3 : 5);
    const axisMax = Math.max(ticks[ticks.length - 1] || 1, ...flat);
    /** @param {number} value */
    const y = (value) => top + plotHeight * (1 - clamp(value / axisMax, 0, 1));

    const groupSlot = plotWidth / groups.length;
    const visibleCount = seriesNames.filter((_, index) => !hidden.has(index)).length || 1;
    const barWidth = Math.max(4, Math.min((groupSlot * 0.72) / visibleCount, 40));

    const bars = [];
    const labels = [];
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      const groupCentre = left + groupSlot * (groupIndex + 0.5);
      let slotIndex = 0;
      for (let seriesIndex = 0; seriesIndex < seriesNames.length; seriesIndex += 1) {
        if (hidden.has(seriesIndex)) continue;
        const value = group.values[seriesIndex];
        const offset = (slotIndex - (visibleCount - 1) / 2) * barWidth;
        slotIndex += 1;
        if (value === null) continue;
        const barTop = y(value);
        const label = group.label + ' · ' + seriesNames[seriesIndex] + ': ' + format(value);
        bars.push(
          svg('rect', {
            class: ['ch-bar', 'ch-bar--c' + ((seriesIndex % 6) + 1)],
            x: r2(groupCentre + offset - barWidth / 2 + 1),
            y: r2(barTop),
            width: r2(Math.max(2, barWidth - 2)),
            height: r2(Math.max(1, bottom - barTop)),
            rx: 2,
            tabindex: '0',
            role: 'img',
            'aria-label': label,
            'data-tip': label,
          }),
        );
      }
      labels.push(
        svg(
          'text',
          { class: 'ch-label', x: r2(groupCentre), y: bottom + 18, 'text-anchor': 'middle' },
          shortLabel(group.label, ctx.band === 'sm' ? 8 : 16),
        ),
      );
    }

    const frame = createSvgFrame({
      kind: 'grouped',
      title,
      desc:
        String(opts.desc || '') || seriesNames.join(', ') + ' across ' + groups.length + ' stages.',
      width,
      height,
      animate: !ctx.reduced,
    });
    append(
      frame.root,
      valueAxis({ ticks, y, left, right, bottom, format }),
      svg('g', { class: 'ch-bars' }, bars),
      svg('g', { class: 'ch-category-labels', 'aria-hidden': 'true' }, labels),
    );
    attachTooltip(ctx.figure, frame.root, ctx.disposers);

    const legend = el(
      'div',
      { class: 'ch-legend', role: 'group', 'aria-label': 'Toggle series' },
      seriesNames.map((name, index) =>
        el(
          'button',
          {
            type: 'button',
            class: ['ch-legend__item', 'ch-legend__item--c' + ((index % 6) + 1)],
            'aria-pressed': hidden.has(index) ? 'false' : 'true',
            onClick: () => {
              const next = new Set(hidden);
              if (next.has(index)) next.delete(index);
              else next.add(index);
              // Never let the user hide every series — an axis with no bars is
              // indistinguishable from a load failure.
              if (next.size >= seriesNames.length) return;
              /** @type {any} */ (ctx.figure).update({ hiddenSeries: Array.from(next) });
            },
          },
          el('span', { class: 'ch-legend__swatch', 'aria-hidden': 'true' }),
          el('span', { class: 'ch-legend__label' }, name),
        ),
      ),
    );

    const rows = groups.map((group) => [
      group.label,
      ...group.values.map((value) => (value === null ? EMPTY : format(value))),
    ]);

    return [
      frame.root,
      legend,
      captionNode(opts.caption),
      dataTable({
        caption: title + ' — data table',
        headers: ['Stage', ...seriesNames],
        rows,
      }),
    ];
  });
}

/* ==================================================================== *
 * 3. heatmap — cross-model cosine similarity, diverging scale about zero
 * ==================================================================== */

/**
 * Bin count for both the diverging and the sequential ramps. Seven is the
 * largest number of steps that stays distinguishable for a viewer with
 * deuteranopia on the tokens.css ramps.
 */
const HEAT_BINS = 7;

/**
 * Cross-model similarity matrix.
 *
 * The headline result of the paper is a 20-entry similarity list that the old
 * dashboard rendered as a scrolling table coloured by `similarity > 0.05`.
 * Here it is a matrix on a diverging scale centred at zero: negative values run
 * violet, zero is the neutral surface, positive values run cyan. The centre bin
 * is a real neutral rather than a pale tint of one end, so "no relationship"
 * does not read as "slightly related".
 *
 * Accepted input (either shape):
 *   `{ matrix: (number|null)[][], labels: string[] }`
 *   `{ values: (number|null)[][], rowLabels: string[], colLabels: string[] }`
 *
 * Other options: `domain` (default `[-1, 1]`), `scale` (`'diverging'` |
 * `'sequential'`), `valueFormat`, `showValues` (`'auto'` by default),
 * `title`, `desc`, `caption`.
 *
 * Cells are focusable and navigable with the arrow keys, Home/End (row ends)
 * and Ctrl+Home/Ctrl+End (matrix ends). Missing cells — the diagonal, or a pair
 * the node has not compared — are drawn with a hatch pattern, not a colour, and
 * announce as "no data".
 *
 * @param {unknown} first
 * @param {unknown} [second]
 * @returns {HTMLElement}
 */
export function heatmap(first, second) {
  const args = normalizeArgs(first, second);
  return createChart('heatmap', args.container, args.options, (opts, ctx) => {
    const raw = Array.isArray(opts.matrix)
      ? opts.matrix
      : Array.isArray(opts.values)
        ? opts.values
        : [];
    const matrix = raw.map((row) => (Array.isArray(row) ? row.map(toNumber) : []));
    const rowCount = matrix.length;
    const colCount = matrix.reduce((max, row) => Math.max(max, row.length), 0);
    const title = String(opts.title || 'Cross-model semantic similarity');

    if (rowCount === 0 || colCount === 0) {
      return [
        emptyBlock(
          'No similarity matrix',
          String(
            opts.emptyMessage ||
              'The node has not compared any embeddings across models yet. Similarity appears once two or more agents have committed memories.',
          ),
          opts.emptyHint ? String(opts.emptyHint) : 'npm run simulate',
        ),
      ];
    }

    const labels = Array.isArray(opts.labels) ? opts.labels.map(String) : null;
    const rowLabels = (Array.isArray(opts.rowLabels) ? opts.rowLabels.map(String) : labels) || [];
    const colLabels = (Array.isArray(opts.colLabels) ? opts.colLabels.map(String) : labels) || [];
    /** @param {number} index */
    const rowName = (index) => rowLabels[index] || 'Row ' + (index + 1);
    /** @param {number} index */
    const colName = (index) => colLabels[index] || 'Column ' + (index + 1);

    const sequential = opts.scale === 'sequential';
    const domain =
      Array.isArray(opts.domain) && opts.domain.length === 2
        ? opts.domain
        : sequential
          ? [0, 1]
          : [-1, 1];
    const [domainMin, domainMax] = [toNumber(domain[0]) ?? -1, toNumber(domain[1]) ?? 1];
    const binPrefix = sequential ? 'ch-cell--h' : 'ch-cell--d';
    // Generated up front: the "no data" cells reference it by url(#id) as they
    // are built, and two heatmaps on one page must not share one pattern.
    const hatchId = nextId('hatch');
    const format = typeof opts.valueFormat === 'function' ? opts.valueFormat : formatSimilarity;

    const cellSize = clamp(
      Math.floor((ctx.band === 'sm' ? 320 : 620) / Math.max(colCount, 1)),
      14,
      54,
    );
    const labelFont = 10;
    const rotateColumns = colLabels.some(
      (label) => estimateTextWidth(shortLabel(label, 14), labelFont) > cellSize,
    );
    const left = clamp(
      Math.max(
        ...rowLabels.map((label) => estimateTextWidth(shortLabel(label, 14), labelFont)),
        40,
      ) + 12,
      52,
      140,
    );
    const top = rotateColumns ? 74 : 30;
    const gridWidth = cellSize * colCount;
    const gridHeight = cellSize * rowCount;
    const legendHeight = 46;
    const width = left + gridWidth + 20;
    const height = top + gridHeight + legendHeight;

    const showValues = opts.showValues === true || (opts.showValues !== false && cellSize >= 34);

    /** @type {Element[]} */
    const rowGroups = [];
    /** @type {Element[]} */
    const focusables = [];
    let present = 0;
    let sum = 0;
    let minSeen = Infinity;
    let maxSeen = -Infinity;

    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      /** @type {Element[]} */
      const cells = [];
      for (let colIndex = 0; colIndex < colCount; colIndex += 1) {
        const value = matrix[rowIndex][colIndex];
        const x = left + colIndex * cellSize;
        const y = top + rowIndex * cellSize;
        const pairName = rowName(rowIndex) + ' to ' + colName(colIndex);
        const hasValue = value !== null && value !== undefined;
        if (hasValue) {
          present += 1;
          sum += /** @type {number} */ (value);
          minSeen = Math.min(minSeen, /** @type {number} */ (value));
          maxSeen = Math.max(maxSeen, /** @type {number} */ (value));
        }
        const bin = hasValue
          ? bucketIndex(/** @type {number} */ (value), domainMin, domainMax, HEAT_BINS)
          : -1;
        const label = pairName + ', ' + (hasValue ? 'similarity ' + format(value) : 'no data');
        const cell = svg('rect', {
          class: ['ch-cell', hasValue ? binPrefix + bin : 'ch-cell--none'],
          x: r2(x),
          y: r2(y),
          width: r2(cellSize),
          height: r2(cellSize),
          tabindex: rowIndex === 0 && colIndex === 0 ? '0' : '-1',
          role: 'img',
          'aria-label': label,
          'data-tip': label,
          'data-row': String(rowIndex),
          'data-col': String(colIndex),
          fill: hasValue ? null : 'url(#' + hatchId + ')',
        });
        focusables.push(cell);
        cells.push(cell);
        if (showValues && hasValue) {
          cells.push(
            svg(
              'text',
              {
                class: 'ch-cell-text',
                x: r2(x + cellSize / 2),
                y: r2(y + cellSize / 2 + 3),
                'text-anchor': 'middle',
                'aria-hidden': 'true',
              },
              format(value),
            ),
          );
        }
      }
      rowGroups.push(svg('g', { class: 'ch-heat-row' }, cells));
    }

    const defs = svg(
      'defs',
      null,
      svg(
        'pattern',
        {
          id: hatchId,
          width: 6,
          height: 6,
          patternUnits: 'userSpaceOnUse',
          patternTransform: 'rotate(45)',
        },
        svg('rect', { class: 'ch-cell-nodata-bg', width: 6, height: 6 }),
        svg('line', { class: 'ch-cell-nodata-line', x1: 0, y1: 0, x2: 0, y2: 6 }),
      ),
    );

    const rowLabelNodes = rowLabels.slice(0, rowCount).map((label, index) =>
      svg(
        'text',
        {
          class: 'ch-label',
          x: left - 8,
          y: r2(top + index * cellSize + cellSize / 2 + 3),
          'text-anchor': 'end',
        },
        shortLabel(label, 16),
      ),
    );
    const colLabelNodes = colLabels.slice(0, colCount).map((label, index) => {
      const x = left + index * cellSize + cellSize / 2;
      return rotateColumns
        ? svg(
            'text',
            {
              class: 'ch-label',
              x: r2(x),
              y: top - 8,
              'text-anchor': 'start',
              transform: 'rotate(-45 ' + r2(x) + ' ' + (top - 8) + ')',
            },
            shortLabel(label, 14),
          )
        : svg(
            'text',
            { class: 'ch-label', x: r2(x), y: top - 10, 'text-anchor': 'middle' },
            shortLabel(label, 14),
          );
    });

    // Discrete legend: seven swatches plus an explicit "no data" swatch, so the
    // hatch is documented rather than left as a mystery.
    const legendY = top + gridHeight + 20;
    // A narrow matrix must never produce a negative rect width — that is an
    // invalid attribute value and the whole legend silently disappears.
    const swatchWidth = clamp((gridWidth - 90) / HEAT_BINS, 8, 26);
    const legendNodes = [];
    for (let bin = 0; bin < HEAT_BINS; bin += 1) {
      legendNodes.push(
        svg('rect', {
          class: ['ch-cell', binPrefix + bin],
          x: r2(left + bin * swatchWidth),
          y: legendY,
          width: r2(swatchWidth),
          height: 12,
        }),
      );
    }
    legendNodes.push(
      svg(
        'text',
        { class: 'ch-tick', x: r2(left - 6), y: legendY + 10, 'text-anchor': 'end' },
        format(domainMin),
      ),
      svg(
        'text',
        { class: 'ch-tick', x: r2(left + HEAT_BINS * swatchWidth + 6), y: legendY + 10 },
        format(domainMax),
      ),
      svg('rect', {
        class: 'ch-cell ch-cell--none',
        x: r2(left + HEAT_BINS * swatchWidth + 56),
        y: legendY,
        width: 12,
        height: 12,
        fill: 'url(#' + hatchId + ')',
      }),
      svg(
        'text',
        { class: 'ch-tick', x: r2(left + HEAT_BINS * swatchWidth + 72), y: legendY + 10 },
        'no data',
      ),
    );

    const mean = present > 0 ? sum / present : NaN;
    const desc =
      String(opts.desc || '') ||
      rowCount +
        ' by ' +
        colCount +
        ' matrix, ' +
        present +
        ' compared pairs' +
        (present > 0
          ? ', values from ' + format(minSeen) + ' to ' + format(maxSeen) + ', mean ' + format(mean)
          : '') +
        '. Colour runs violet for negative through neutral at zero to cyan for positive.';

    const frame = createSvgFrame({
      kind: 'heatmap',
      title,
      desc,
      width,
      height,
      animate: !ctx.reduced,
    });
    const grid = svg('g', { class: 'ch-heat-grid' }, rowGroups);
    append(
      frame.root,
      defs,
      svg('g', { class: 'ch-heat-labels', 'aria-hidden': 'true' }, rowLabelNodes, colLabelNodes),
      grid,
      svg('g', { class: 'ch-heat-legend', 'aria-hidden': 'true' }, legendNodes),
    );
    attachTooltip(ctx.figure, frame.root, ctx.disposers);

    // ---- Two-dimensional roving focus -------------------------------
    // A 20x20 matrix is 400 tab stops if every cell is tabbable. Exactly one
    // cell holds tabindex="0"; the arrow keys move both focus and that
    // attribute, so the matrix costs one Tab press to enter and one to leave.
    /** @param {number} rowIndex @param {number} colIndex */
    const cellAt = (rowIndex, colIndex) => focusables[rowIndex * colCount + colIndex] || null;

    ctx.disposers.push(
      on(grid, 'keydown', (event) => {
        const key = /** @type {KeyboardEvent} */ (event).key;
        const target = /** @type {Element} */ (event.target);
        if (!(target instanceof Element) || !target.hasAttribute('data-row')) return;
        let rowIndex = Number(target.getAttribute('data-row'));
        let colIndex = Number(target.getAttribute('data-col'));
        const ctrl = /** @type {KeyboardEvent} */ (event).ctrlKey;
        if (key === 'ArrowRight') colIndex += 1;
        else if (key === 'ArrowLeft') colIndex -= 1;
        else if (key === 'ArrowDown') rowIndex += 1;
        else if (key === 'ArrowUp') rowIndex -= 1;
        else if (key === 'Home') {
          colIndex = 0;
          if (ctrl) rowIndex = 0;
        } else if (key === 'End') {
          colIndex = colCount - 1;
          if (ctrl) rowIndex = rowCount - 1;
        } else return;
        rowIndex = clamp(rowIndex, 0, rowCount - 1);
        colIndex = clamp(colIndex, 0, colCount - 1);
        const next = cellAt(rowIndex, colIndex);
        if (!next || next === target) return;
        event.preventDefault();
        target.setAttribute('tabindex', '-1');
        next.setAttribute('tabindex', '0');
        /** @type {any} */ (next).focus();
      }),
    );

    const rows = matrix.map((row, rowIndex) => [
      rowName(rowIndex),
      ...Array.from({ length: colCount }, (_, colIndex) => {
        const value = row[colIndex];
        return value === null || value === undefined ? 'no data' : format(value);
      }),
    ]);

    return [
      frame.root,
      captionNode(opts.caption),
      dataTable({
        caption: title + ' — data table',
        headers: ['Agent', ...Array.from({ length: colCount }, (_, index) => colName(index))],
        rows,
      }),
    ];
  });
}

/* ==================================================================== *
 * 4. sparkline — compact trend, no axes
 * ==================================================================== */

/**
 * A 120x32 trend line for a KPI tile: area, line, and a dot on the last point.
 *
 * Deliberately axis-free. A sparkline answers "which way is this going", and
 * the exact numbers live in the tile beside it and in the offscreen table.
 *
 * @param {unknown} first
 * @param {unknown} [second] `{ values: number[] }` or `{ points: number[] }`
 * @returns {HTMLElement}
 */
export function sparkline(first, second) {
  const args = normalizeArgs(first, second);
  return createChart('spark', args.container, args.options, (opts, ctx) => {
    const source = Array.isArray(opts.values)
      ? opts.values
      : Array.isArray(opts.points)
        ? opts.points
        : [];
    const values = source.map(toNumber).filter((value) => value !== null);
    const title = String(opts.title || 'Trend');
    const format = typeof opts.valueFormat === 'function' ? opts.valueFormat : formatNumber;

    if (values.length < 2) {
      return [emptyBlock('Not enough history', 'At least two samples are needed to draw a trend.')];
    }

    const width = 120;
    const height = 32;
    const pad = 3;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    /** @param {number} index */
    const x = (index) => pad + ((width - pad * 2) * index) / (values.length - 1);
    /** @param {number} value */
    const y = (value) => height - pad - ((height - pad * 2) * (value - min)) / span;

    const points = values.map((value, index) => r2(x(index)) + ' ' + r2(y(value)));
    const line = 'M ' + points.join(' L ');
    const area =
      line +
      ' L ' +
      r2(x(values.length - 1)) +
      ' ' +
      (height - pad) +
      ' L ' +
      pad +
      ' ' +
      (height - pad) +
      ' Z';

    const first0 = values[0];
    const last = values[values.length - 1];
    const direction = last > first0 ? 'rising' : last < first0 ? 'falling' : 'flat';

    const frame = createSvgFrame({
      kind: 'spark',
      title,
      desc:
        String(opts.desc || '') ||
        values.length +
          ' samples, ' +
          direction +
          ' from ' +
          format(first0) +
          ' to ' +
          format(last) +
          '.',
      width,
      height,
      animate: !ctx.reduced,
    });
    append(
      frame.root,
      svg('path', { class: 'ch-spark-area', d: area }),
      svg('path', { class: 'ch-spark', d: line }),
      svg('circle', {
        class: 'ch-spark-dot',
        cx: r2(x(values.length - 1)),
        cy: r2(y(last)),
        r: 2.4,
      }),
    );

    // A 500-point series would produce a 500-row offscreen table that a screen
    // reader user has to walk past. Long series are summarised instead.
    const rows =
      values.length <= 60
        ? values.map((value, index) => [String(index + 1), format(value)])
        : [
            ['Samples', String(values.length)],
            ['First', format(first0)],
            ['Last', format(last)],
            ['Minimum', format(min)],
            ['Maximum', format(max)],
          ];

    return [
      frame.root,
      dataTable({
        caption: title + ' — data table',
        headers: values.length <= 60 ? ['Sample', 'Value'] : ['Statistic', 'Value'],
        rows,
      }),
    ];
  });
}

/* ==================================================================== *
 * 5. timeline — reputation trust events over time
 * ==================================================================== */

/**
 * Normalise one trust event out of whatever the backend or the simulation
 * payload calls its fields.
 *
 * @param {any} event
 * @param {number} index
 * @returns {{from: string, to: string, action: string, reason: string, time: number|null, index: number}}
 */
function normalizeEvent(event, index) {
  const action = String(
    (event && (event.action || event.type || event.kind)) || 'endorse',
  ).toLowerCase();
  const time = toNumber(
    event && (event.timestamp ?? event.time ?? event.at ?? event.blockTimestamp),
  );
  // Solidity timestamps are seconds; JS wants milliseconds. Anything below
  // 1e11 cannot be a plausible millisecond epoch for this decade.
  const millis = time === null ? null : time < 1e11 ? time * 1000 : time;
  return {
    from: String((event && (event.from || event.by || event.source)) || EMPTY),
    to: String((event && (event.to || event.target || event.subject)) || EMPTY),
    action: action.startsWith('report') || action.startsWith('slash') ? 'report' : 'endorse',
    reason: String((event && event.reason) || ''),
    time: millis,
    index,
  };
}

/**
 * Reputation trust events plotted against time, one lane per target agent.
 *
 * Endorsements and reports are distinguished three ways — colour, a `+`/`−`
 * glyph, and position in the legend — because colour alone fails WCAG 1.4.1
 * and because these two events have opposite meaning.
 *
 * The simulation payload's `reputationEvents` carry no timestamps. Rather than
 * inventing them, the chart falls back to ordinal spacing and SAYS SO in the
 * caption, so nobody reads sequence as rate.
 *
 * @param {unknown} first
 * @param {unknown} [second] `{ events: Array<{from, to, action, reason, timestamp}> }`
 * @returns {HTMLElement}
 */
export function timeline(first, second) {
  const args = normalizeArgs(first, second);
  return createChart('timeline', args.container, args.options, (opts, ctx) => {
    const events = (Array.isArray(opts.events) ? opts.events : []).map(normalizeEvent);
    const title = String(opts.title || 'Trust events');

    if (events.length === 0) {
      return [
        emptyBlock(
          'No trust events',
          String(
            opts.emptyMessage ||
              'No agent has endorsed or reported another yet. Events appear here as soon as one is recorded on chain.',
          ),
        ),
      ];
    }

    const laneKey = opts.laneKey === 'from' ? 'from' : 'to';
    /** @type {string[]} */
    const lanes = [];
    for (const event of events) {
      const lane = event[laneKey];
      if (!lanes.includes(lane)) lanes.push(lane);
    }

    const timed = events.filter((event) => event.time !== null);
    const times = timed.map((event) => /** @type {number} */ (event.time));
    const useTime =
      timed.length === events.length && times.length > 1 && Math.max(...times) > Math.min(...times);
    const minTime = useTime ? Math.min(...times) : 0;
    const maxTime = useTime ? Math.max(...times) : Math.max(events.length - 1, 1);

    const width = 680;
    const laneHeight = 34;
    const top = 24;
    const bottom = top + lanes.length * laneHeight;
    const height = bottom + 52;
    const left = clamp(
      Math.max(...lanes.map((lane) => estimateTextWidth(shortLabel(lane, 14), 10)), 60) + 14,
      70,
      160,
    );
    const right = width - 20;

    /** @param {{time: number|null, index: number}} event */
    const x = (event) => {
      const value = useTime ? /** @type {number} */ (event.time) : event.index;
      const span = maxTime - minTime || 1;
      return left + ((right - left) * (value - minTime)) / span;
    };

    const laneNodes = lanes.map((lane, index) => {
      const y = top + index * laneHeight + laneHeight / 2;
      return svg(
        'g',
        null,
        svg('line', { class: 'ch-lane', x1: left, y1: r2(y), x2: right, y2: r2(y) }),
        svg(
          'text',
          { class: 'ch-label', x: left - 10, y: r2(y + 3.5), 'text-anchor': 'end' },
          shortLabel(lane, 16),
        ),
      );
    });

    const eventNodes = events.map((event) => {
      const laneIndex = lanes.indexOf(event[laneKey]);
      const cy = top + laneIndex * laneHeight + laneHeight / 2;
      const cx = x(event);
      const when = event.time !== null ? formatDateTime(event.time) : 'event ' + (event.index + 1);
      const label =
        (event.action === 'endorse' ? 'Endorsement' : 'Report') +
        ': ' +
        shortLabel(event.from, 18) +
        ' → ' +
        shortLabel(event.to, 18) +
        ' · ' +
        when +
        (event.reason ? ' · ' + event.reason : '');
      // The glyph is two separate path elements for an endorsement and one for
      // a report, so the difference survives a monochrome print and a forced
      // colours theme.
      const glyph =
        event.action === 'endorse'
          ? [
              svg('path', {
                class: 'ch-event-glyph',
                d: 'M ' + r2(cx - 3) + ' ' + r2(cy) + ' h 6',
              }),
              svg('path', {
                class: 'ch-event-glyph',
                d: 'M ' + r2(cx) + ' ' + r2(cy - 3) + ' v 6',
              }),
            ]
          : [
              svg('path', {
                class: 'ch-event-glyph',
                d: 'M ' + r2(cx - 3) + ' ' + r2(cy) + ' h 6',
              }),
            ];
      return svg(
        'g',
        {
          class: ['ch-event', 'ch-event--' + event.action],
          tabindex: '0',
          role: 'img',
          'aria-label': label,
          'data-tip': label,
        },
        svg('circle', { class: 'ch-event-dot', cx: r2(cx), cy: r2(cy), r: 6 }),
        glyph,
      );
    });

    /** @type {Element[]} */
    const axisNodes = [
      svg('line', { class: 'ch-axis', x1: left, y1: bottom + 6, x2: right, y2: bottom + 6 }),
    ];
    if (useTime) {
      const tickCount = ctx.band === 'sm' ? 2 : 4;
      for (let index = 0; index <= tickCount; index += 1) {
        const value = minTime + ((maxTime - minTime) * index) / tickCount;
        const tickX = left + ((right - left) * index) / tickCount;
        axisNodes.push(
          svg(
            'text',
            {
              class: 'ch-tick',
              x: r2(tickX),
              y: bottom + 20,
              'text-anchor': index === 0 ? 'start' : index === tickCount ? 'end' : 'middle',
            },
            formatDateTime(value),
          ),
        );
      }
    }

    const endorsements = events.filter((event) => event.action === 'endorse').length;
    const caption =
      opts.caption ||
      (useTime
        ? null
        : 'These events carry no timestamps, so they are spaced in the order the node returned them. Horizontal position shows sequence, not elapsed time.');

    const frame = createSvgFrame({
      kind: 'timeline',
      title,
      desc:
        String(opts.desc || '') ||
        events.length +
          ' trust events across ' +
          lanes.length +
          ' agents: ' +
          endorsements +
          ' endorsements and ' +
          (events.length - endorsements) +
          ' reports' +
          (useTime
            ? ', plotted on a time axis.'
            : ', plotted in sequence because no timestamps were supplied.'),
      width,
      height,
      animate: !ctx.reduced,
    });
    append(
      frame.root,
      svg('g', { class: 'ch-lanes', 'aria-hidden': 'true' }, laneNodes),
      svg('g', { class: 'ch-axis-group', 'aria-hidden': 'true' }, axisNodes),
      svg('g', { class: 'ch-events' }, eventNodes),
    );
    attachTooltip(ctx.figure, frame.root, ctx.disposers);

    const legend = el(
      'div',
      { class: 'ch-legend ch-legend--static' },
      el(
        'span',
        { class: 'ch-legend__item' },
        el(
          'span',
          { class: 'ch-legend__swatch ch-legend__swatch--endorse', 'aria-hidden': 'true' },
          '+',
        ),
        el('span', { class: 'ch-legend__label' }, 'Endorsement'),
      ),
      el(
        'span',
        { class: 'ch-legend__item' },
        el(
          'span',
          { class: 'ch-legend__swatch ch-legend__swatch--report', 'aria-hidden': 'true' },
          '−',
        ),
        el('span', { class: 'ch-legend__label' }, 'Report'),
      ),
    );

    const rows = events.map((event) => [
      event.time !== null ? formatDateTime(event.time) : '#' + (event.index + 1),
      event.action === 'endorse' ? 'Endorsement' : 'Report',
      event.from,
      event.to,
      event.reason || EMPTY,
    ]);

    return [
      frame.root,
      legend,
      captionNode(caption),
      dataTable({
        caption: title + ' — data table',
        headers: ['When', 'Action', 'From', 'To', 'Reason'],
        rows,
      }),
    ];
  });
}

/** The frontend spec names this export `timelineChart`; both names are live. */
export const timelineChart = timeline;

/* ==================================================================== *
 * 6. topology — the agent swarm, deterministic circular layout
 * ==================================================================== */

/**
 * The agent swarm as a directed graph.
 *
 * The layout is a plain circle — `angle = 2*PI*i/n` — with no force
 * simulation and no randomness anywhere. That is a requirement, not a
 * shortcut: a force layout re-renders to a different picture every time the
 * poll refreshes, so the operator loses their spatial memory of which node is
 * which, and nothing can be asserted about the output in a test.
 *
 * Node radius encodes reputation on a square-root scale, so AREA rather than
 * radius is proportional to the score. Edge colour, dash pattern and arrowhead
 * encode endorsement versus report; edge width and opacity encode weight.
 *
 * Focusing or hovering a node dims every edge not incident to it, which is the
 * only way a 20-node mesh stays readable.
 *
 * @param {unknown} first
 * @param {unknown} [second] `{ nodes: Array<{id,label,reputation,trusted}>, edges: Array<{from,to,type,weight}> }`
 * @returns {HTMLElement}
 */
export function topology(first, second) {
  const args = normalizeArgs(first, second);
  return createChart('topology', args.container, args.options, (opts, ctx) => {
    const rawNodes = Array.isArray(opts.nodes) ? opts.nodes : [];
    const title = String(opts.title || 'Agent swarm');

    const nodes = rawNodes
      .map((node, index) => {
        const id = String((node && (node.id || node.address || node.agent)) || index);
        const score = toNumber(node && (node.reputation ?? node.score ?? node.value));
        return {
          id,
          label: String((node && (node.label || node.name)) || id),
          score: score === null ? 0 : score,
          hasScore: score !== null,
          trusted:
            node && node.trusted !== undefined
              ? Boolean(node.trusted)
              : /** @type {boolean|null} */ (null),
        };
      })
      .filter((node) => node.id !== '');

    if (nodes.length === 0) {
      return [
        emptyBlock(
          'No agents discovered',
          String(
            opts.emptyMessage ||
              'This node has not seen any peers yet. Register an identity, or run the swarm simulation, to populate the mesh.',
          ),
          opts.emptyHint ? String(opts.emptyHint) : 'npm run simulate',
        ),
      ];
    }

    // Aggregate parallel edges: five endorsements from A to B are one arrow of
    // weight five, not five arrows drawn on top of each other.
    /** @type {Map<string, {from: string, to: string, type: string, weight: number}>} */
    const edgeMap = new Map();
    for (const edge of Array.isArray(opts.edges) ? opts.edges : []) {
      const from = String((edge && (edge.from || edge.by || edge.source)) || '');
      const to = String((edge && (edge.to || edge.target)) || '');
      if (!from || !to || from === to) continue;
      const rawType = String((edge && (edge.type || edge.action)) || 'endorse').toLowerCase();
      const type =
        rawType.startsWith('report') || rawType.startsWith('slash') ? 'report' : 'endorse';
      const weight = toNumber(edge && edge.weight);
      const key = from + '\u0000' + to + '\u0000' + type;
      const existing = edgeMap.get(key);
      if (existing) existing.weight += weight === null ? 1 : weight;
      else edgeMap.set(key, { from, to, type, weight: weight === null ? 1 : weight });
    }
    const edges = Array.from(edgeMap.values()).filter(
      (edge) => nodes.some((n) => n.id === edge.from) && nodes.some((n) => n.id === edge.to),
    );

    const width = 660;
    const height = isNum(opts.height) ? opts.height : 480;
    const cx = width / 2;
    const cy = (height - 46) / 2 + 10;
    const ring = Math.min(width, height - 46) * 0.38;

    const maxScore = Math.max(...nodes.map((node) => node.score), 1);
    const placed = nodes.map((node, index) => {
      const angle = (360 * index) / nodes.length;
      const [x, y] = polar(cx, cy, ring, angle);
      const ratio = maxScore > 0 ? clamp(node.score / maxScore, 0, 1) : 0;
      return {
        ...node,
        x,
        y,
        angle,
        radius: nodes.length > 12 ? 8 + 9 * Math.sqrt(ratio) : 11 + 13 * Math.sqrt(ratio),
      };
    });
    /** @type {Map<string, typeof placed[0]>} */
    const byId = new Map(placed.map((node) => [node.id, node]));

    const maxWeight = Math.max(...edges.map((edge) => edge.weight), 1);
    const markerEndorse = nextId('arrow-endorse');
    const markerReport = nextId('arrow-report');

    /** @type {Element[]} */
    const edgeNodes = [];
    for (const edge of edges) {
      const source = byId.get(edge.from);
      const targetNode = byId.get(edge.to);
      if (!source || !targetNode) continue;
      const dx = targetNode.x - source.x;
      const dy = targetNode.y - source.y;
      const distance = Math.hypot(dx, dy) || 1;
      // Trim both ends to the node rim so the arrowhead is visible and the
      // line does not disappear underneath the circles.
      const startX = source.x + (dx / distance) * (source.radius + 2);
      const startY = source.y + (dy / distance) * (source.radius + 2);
      const endX = targetNode.x - (dx / distance) * (targetNode.radius + 9);
      const endY = targetNode.y - (dy / distance) * (targetNode.radius + 9);
      // Bow the curve away from the centre. A -> B and B -> A therefore bow to
      // opposite sides and a reciprocal pair reads as two arrows, not one.
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      const outX = midX - cx;
      const outY = midY - cy;
      const outLength = Math.hypot(outX, outY) || 1;
      const bow = distance * 0.16;
      const controlX = midX + (-dy / distance) * bow + (outX / outLength) * 4;
      const controlY = midY + (dx / distance) * bow + (outY / outLength) * 4;
      const ratio = edge.weight / maxWeight;
      const label =
        (edge.type === 'endorse' ? 'Endorsement' : 'Report') +
        ': ' +
        shortLabel(edge.from, 18) +
        ' → ' +
        shortLabel(edge.to, 18) +
        ' (' +
        formatNumber(edge.weight, 0) +
        ')';
      edgeNodes.push(
        svg('path', {
          class: ['ch-edge', 'ch-edge--' + edge.type],
          d:
            'M ' +
            r2(startX) +
            ' ' +
            r2(startY) +
            ' Q ' +
            r2(controlX) +
            ' ' +
            r2(controlY) +
            ' ' +
            r2(endX) +
            ' ' +
            r2(endY),
          'stroke-width': r2(1 + 3 * ratio),
          'stroke-opacity': r2(0.35 + 0.65 * ratio),
          'marker-end': 'url(#' + (edge.type === 'endorse' ? markerEndorse : markerReport) + ')',
          'data-from': edge.from,
          'data-to': edge.to,
          'data-tip': label,
        }),
      );
    }

    /** @param {string} id @param {string} tone */
    const marker = (id, tone) =>
      svg(
        'marker',
        {
          id,
          viewBox: '0 0 10 10',
          refX: 8,
          refY: 5,
          markerWidth: 6,
          markerHeight: 6,
          orient: 'auto-start-reverse',
        },
        svg('path', { class: 'ch-arrow ch-arrow--' + tone, d: 'M 0 0 L 10 5 L 0 10 z' }),
      );

    const nodeNodes = placed.map((node) => {
      const trustText = node.trusted === null ? '' : node.trusted ? ', trusted' : ', not trusted';
      const label =
        node.label +
        (node.hasScore ? ', reputation ' + formatNumber(node.score, 0) : ', reputation unknown') +
        trustText;
      return svg(
        'g',
        {
          class: [
            'ch-node',
            node.trusted === true ? 'ch-node--trusted' : null,
            node.trusted === false ? 'ch-node--untrusted' : null,
          ],
          tabindex: '0',
          role: 'img',
          'aria-label': label,
          'data-tip': label,
          'data-node': node.id,
        },
        svg('circle', {
          class: 'ch-node-dot',
          cx: r2(node.x),
          cy: r2(node.y),
          r: r2(node.radius),
        }),
        svg(
          'text',
          {
            class: 'ch-node-label',
            x: r2(node.x),
            y: r2(node.y + node.radius + 13),
            'text-anchor': 'middle',
          },
          shortLabel(node.label, 12),
        ),
      );
    });

    const frame = createSvgFrame({
      kind: 'topology',
      title,
      desc:
        String(opts.desc || '') ||
        nodes.length +
          ' agents arranged on a circle with ' +
          edges.length +
          ' trust relationships; node size encodes reputation, solid arrows are endorsements and dashed arrows are reports.',
      width,
      height,
      animate: !ctx.reduced,
    });
    const edgeLayer = svg('g', { class: 'ch-edges' }, edgeNodes);
    const nodeLayer = svg('g', { class: 'ch-nodes' }, nodeNodes);
    append(
      frame.root,
      svg('defs', null, marker(markerEndorse, 'endorse'), marker(markerReport, 'report')),
      edgeLayer,
      nodeLayer,
    );
    attachTooltip(ctx.figure, frame.root, ctx.disposers);

    // ---- Focus / hover isolation ------------------------------------
    /** @param {string|null} id */
    const setFocus = (id) => {
      for (const edge of Array.from(edgeLayer.children)) {
        const incident =
          id === null ||
          edge.getAttribute('data-from') === id ||
          edge.getAttribute('data-to') === id;
        edge.classList.toggle('is-dim', !incident);
      }
      for (const node of Array.from(nodeLayer.children)) {
        const own = node.getAttribute('data-node');
        const related =
          id === null ||
          own === id ||
          edges.some(
            (edge) =>
              (edge.from === id && edge.to === own) || (edge.to === id && edge.from === own),
          );
        node.classList.toggle('is-dim', !related);
      }
    };
    /** @param {Event} event */
    const onEnter = (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-node]') : null;
      setFocus(target ? target.getAttribute('data-node') : null);
    };
    ctx.disposers.push(
      on(nodeLayer, 'pointerover', onEnter),
      on(nodeLayer, 'focusin', onEnter),
      on(nodeLayer, 'pointerout', () => setFocus(null)),
      on(nodeLayer, 'focusout', () => setFocus(null)),
      () => setFocus(null),
    );

    const legend = el(
      'div',
      { class: 'ch-legend ch-legend--static' },
      el(
        'span',
        { class: 'ch-legend__item' },
        el(
          'span',
          { class: 'ch-legend__swatch ch-legend__swatch--endorse', 'aria-hidden': 'true' },
          '→',
        ),
        el('span', { class: 'ch-legend__label' }, 'Endorsement'),
      ),
      el(
        'span',
        { class: 'ch-legend__item' },
        el(
          'span',
          { class: 'ch-legend__swatch ch-legend__swatch--report', 'aria-hidden': 'true' },
          '⇢',
        ),
        el('span', { class: 'ch-legend__label' }, 'Report (dashed)'),
      ),
      el(
        'span',
        { class: 'ch-legend__item' },
        el('span', {
          class: 'ch-legend__swatch ch-legend__swatch--untrusted',
          'aria-hidden': 'true',
        }),
        el('span', { class: 'ch-legend__label' }, 'Dashed ring: below trust threshold'),
      ),
    );

    const rows = placed.map((node) => [
      node.label,
      node.hasScore ? formatNumber(node.score, 0) : EMPTY,
      node.trusted === null ? EMPTY : node.trusted ? 'Trusted' : 'Not trusted',
      String(edges.filter((edge) => edge.to === node.id && edge.type === 'endorse').length),
      String(edges.filter((edge) => edge.to === node.id && edge.type === 'report').length),
    ]);

    return [
      frame.root,
      legend,
      captionNode(opts.caption),
      dataTable({
        caption: title + ' — data table',
        headers: ['Agent', 'Reputation', 'Trust', 'Endorsements in', 'Reports in'],
        rows,
      }),
    ];
  });
}

/** The frontend spec names this export `topologyGraph`; both names are live. */
export const topologyGraph = topology;

/* ==================================================================== *
 * 7. gauge — trust-score dial
 * ==================================================================== */

/**
 * A 240-degree dial for a single bounded score.
 *
 * The fill is the same arc as the track, drawn a second time with
 * `pathLength="100"` and a `stroke-dasharray` of `<percent> 100`. That is the
 * whole trick: the browser normalises the path to 100 units, so the fill
 * fraction is exact with no trigonometry and no risk of an arc-flag bug at the
 * 180-degree crossing.
 *
 * `thresholds` accepts `[500]`, `[{ value: 500, label: 'Trusted' }]`, or a mix.
 * Ticks are drawn on the arc, and the fill tone steps up as each threshold is
 * passed (danger below the first, warning between, success at or above the
 * last), so the dial is readable without reading the number.
 *
 * @param {unknown} first
 * @param {unknown} [second] `{ value, max, thresholds, label, title }`
 * @returns {HTMLElement}
 */
export function gauge(first, second) {
  const args = normalizeArgs(first, second);
  return createChart('gauge', args.container, args.options, (opts, ctx) => {
    const value = toNumber(opts.value);
    const max = toNumber(opts.max) ?? 1000;
    const min = toNumber(opts.min) ?? 0;
    const title = String(opts.title || 'Trust score');
    const label = opts.label === undefined ? title : String(opts.label);
    const format =
      typeof opts.valueFormat === 'function'
        ? opts.valueFormat
        : (/** @type {number} */ n) => formatNumber(n, 0);

    if (value === null) {
      return [
        emptyBlock(
          'No score yet',
          String(
            opts.emptyMessage ||
              'This agent has no reputation on chain yet. A score appears after the first endorsement or report.',
          ),
        ),
      ];
    }

    const thresholds = (Array.isArray(opts.thresholds) ? opts.thresholds : [])
      .map((entry) => {
        const raw = typeof entry === 'object' && entry !== null ? entry.value : entry;
        const at = toNumber(raw);
        return at === null
          ? null
          : {
              value: at,
              // A bare number gets the generic name, so the tooltip reads
              // "Threshold: 500" rather than the useless "500: 500".
              label: String(
                (typeof entry === 'object' && entry !== null && entry.label) || 'Threshold',
              ),
            };
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => /** @type {any} */ (a).value - /** @type {any} */ (b).value);

    const passed = thresholds.filter((entry) => value >= /** @type {any} */ (entry).value).length;
    const tone =
      thresholds.length === 0
        ? 'brand'
        : passed === 0
          ? 'danger'
          : passed >= thresholds.length
            ? 'success'
            : 'warn';

    const width = 260;
    const height = 176;
    const cx = width / 2;
    const cy = 118;
    const radius = 84;
    const startDeg = -120;
    const endDeg = 120;
    const span = max - min || 1;
    const fraction = clamp((value - min) / span, 0, 1);

    const frame = createSvgFrame({
      kind: 'gauge',
      title,
      desc:
        String(opts.desc || '') ||
        title +
          ' is ' +
          format(value) +
          ' out of ' +
          format(max) +
          (thresholds.length
            ? '. ' +
              thresholds
                .map(
                  (entry) =>
                    /** @type {any} */ (entry).label +
                    ' ' +
                    format(/** @type {any} */ (entry).value) +
                    (value >= /** @type {any} */ (entry).value ? ': met' : ': not met'),
                )
                .join('; ') +
              '.'
            : '.'),
      width,
      height,
      animate: !ctx.reduced,
    });

    const tickNodes = thresholds.map((entry) => {
      const at = /** @type {any} */ (entry).value;
      const deg = startDeg + (endDeg - startDeg) * clamp((at - min) / span, 0, 1);
      const [x1, y1] = polar(cx, cy, radius - 13, deg);
      const [x2, y2] = polar(cx, cy, radius + 13, deg);
      return svg('line', {
        class: 'ch-gauge-threshold',
        x1: r2(x1),
        y1: r2(y1),
        x2: r2(x2),
        y2: r2(y2),
        'data-tip': /** @type {any} */ (entry).label + ': ' + format(at),
      });
    });

    append(
      frame.root,
      svg('path', {
        class: 'ch-gauge-track',
        d: arcPath(cx, cy, radius, startDeg, endDeg),
      }),
      svg('path', {
        class: ['ch-gauge-fill', 'ch-gauge-fill--' + tone],
        d: arcPath(cx, cy, radius, startDeg, endDeg),
        pathLength: 100,
        'stroke-dasharray': r2(fraction * 100) + ' 100',
      }),
      svg('g', { class: 'ch-gauge-thresholds' }, tickNodes),
      svg(
        'text',
        { class: 'ch-gauge-value', x: cx, y: cy + 2, 'text-anchor': 'middle' },
        format(value),
      ),
      svg(
        'text',
        { class: 'ch-gauge-caption', x: cx, y: cy + 24, 'text-anchor': 'middle' },
        'of ' + format(max),
      ),
      svg(
        'text',
        { class: 'ch-gauge-label', x: cx, y: cy + 46, 'text-anchor': 'middle' },
        shortLabel(label, 28),
      ),
    );
    attachTooltip(ctx.figure, frame.root, ctx.disposers);

    /** @type {Array<Array<unknown>>} */
    const rows = [
      [label, format(value)],
      ['Maximum', format(max)],
      ['Share of maximum', Math.round(fraction * 100) + '%'],
    ];
    for (const entry of thresholds) {
      rows.push([
        /** @type {any} */ (entry).label,
        format(/** @type {any} */ (entry).value) +
          (value >= /** @type {any} */ (entry).value ? ' (met)' : ' (not met)'),
      ]);
    }

    return [
      frame.root,
      captionNode(opts.caption),
      dataTable({ caption: title + ' — data table', headers: ['Measure', 'Value'], rows }),
    ];
  });
}

/* ==================================================================== *
 * 8. similarityBar — a single inline mark for a table row
 * ==================================================================== */

/**
 * A miniature signed bar, for the similarity column of a search-results table.
 *
 * Not a full chart: no frame, no observer, no offscreen table, because it sits
 * inside a real table cell that already carries the number as text. It is
 * `aria-hidden` for exactly that reason — announcing it would duplicate the
 * cell.
 *
 * @param {number|null|undefined} value  a cosine similarity in -1..1
 * @param {number} [max]
 * @returns {SVGElement}
 */
export function similarityBar(value, max = 1) {
  const width = 72;
  const height = 10;
  const mid = width / 2;
  const numeric = toNumber(value);
  const bar = svg('svg', {
    class: 'chart chart--simbar',
    viewBox: '0 0 ' + width + ' ' + height,
    preserveAspectRatio: 'xMidYMid meet',
    'aria-hidden': 'true',
    focusable: 'false',
  });
  append(bar, svg('line', { class: 'ch-simbar-axis', x1: mid, y1: 0, x2: mid, y2: height }));
  if (numeric !== null) {
    const ratio = clamp(numeric / (max || 1), -1, 1);
    const length = Math.abs(ratio) * (mid - 1);
    append(
      bar,
      svg('rect', {
        class: ['ch-simbar', ratio < 0 ? 'ch-simbar--neg' : 'ch-simbar--pos'],
        x: r2(ratio < 0 ? mid - length : mid),
        y: 2,
        width: r2(Math.max(length, 0.75)),
        height: height - 4,
        rx: 1,
      }),
    );
  }
  return bar;
}

/* ==================================================================== *
 * Exports index (for readers, and for a quick grep)
 * ==================================================================== *
 *   barChart          latency bars + p50/p95 reference markers
 *   groupedBarChart   clustered bars + toggleable legend
 *   heatmap           diverging cosine-similarity matrix, arrow-key grid
 *   sparkline         120x32 trend line for KPI tiles
 *   timeline          reputation trust events, +/- glyphs
 *   topology          deterministic circular swarm graph
 *   gauge             240-degree trust dial
 *   similarityBar     inline signed bar for a table cell
 *   timelineChart     alias of timeline    (spec name)
 *   topologyGraph     alias of topology    (spec name)
 * ==================================================================== */
