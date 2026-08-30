/**
 * NeuroMesh — the safe DOM construction layer.
 *
 * This module exists for exactly one reason: the previous dashboard had eleven
 * raw-markup sinks, five of which concatenated remote IPFS / CID / reputation
 * strings straight into markup — one of them into an `href` attribute. A CID
 * containing a double quote was enough to inject arbitrary attributes, and a
 * `reason` string from `simulation-results.json` was enough to run script
 * same-origin against the decrypt endpoint.
 *
 * The fix is not "escape carefully at each call site". The fix is to make the
 * unsafe thing unavailable:
 *
 *   - Every string that reaches the document does so as a TEXT NODE. There is
 *     no code path in `el()` or `svg()` that parses a string as markup.
 *   - Passing `{ html: ... }` throws a TypeError rather than being ignored, so
 *     the mistake is loud at development time.
 *   - Every URL-bearing attribute crosses `sanitizeUrl()`, which allowlists
 *     schemes and rejects `javascript:`, `data:`, `blob:`, `vbscript:` and
 *     `file:`. A rejected URL drops the attribute instead of rendering a live
 *     hostile link.
 *   - `clear()` empties a node by removing children, never by assigning a
 *     markup string — which additionally avoids re-parsing and is faster.
 *
 * ESLint enforces the same rule structurally: `no-restricted-syntax` bans the
 * whole markup-string family — both HTML-assignment properties, the
 * insert-adjacent variant, and document-level markup writes — across
 * `public/**`, so the two defences are independent.
 *
 * @module dom
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * ASCII control characters, stripped before any URL check. `java\u000Ascript:`
 * is a real filter bypass: it survives a naive prefix test but the HTML parser
 * strips the newline and executes it as `javascript:`, so removal must come first.
 */
// eslint-disable-next-line no-control-regex -- matching control chars is the point.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Schemes a URL may carry before it is allowed near the document.
 * `data:` is absent deliberately: `data:text/html` is a script-execution
 * vector in some navigation contexts, and nothing in this console needs it.
 */
export const ALLOWED_URL_SCHEMES = Object.freeze(['https:', 'http:', 'mailto:']);

/** Attributes whose value is fetched or navigated to, and so must be checked. */
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'poster', 'xlink:href']);

/**
 * Keys set as DOM PROPERTIES rather than attributes. For these, the property
 * is the live value and the attribute is only the initial one — setting
 * `value` as an attribute on an input the user has typed into does nothing.
 */
const DOM_PROPERTIES = new Set([
  'checked',
  'disabled',
  'hidden',
  'indeterminate',
  'inert',
  'multiple',
  'open',
  'readOnly',
  'required',
  'selected',
  'value',
]);

/* ==================================================================== *
 * URL safety
 * ==================================================================== */

/**
 * Validate a URL for use in an attribute.
 *
 * Algorithm, in order:
 *   1. Coerce and trim; strip ASCII control characters and every Unicode
 *      whitespace class. `java\nscript:alert(1)` is a real bypass against
 *      naive prefix checks, and stripping first defeats it.
 *   2. A value beginning with a single `/` is a same-origin path and is
 *      returned unchanged. `//host` is NOT — that is a protocol-relative URL
 *      to another origin, and it falls through to full parsing.
 *   3. Anything else is parsed with `new URL(value, location.origin)`. A parse
 *      failure is a rejection, and the resulting protocol must be allowlisted.
 *
 * @param {unknown} value
 * @returns {string | null} a safe URL string, or null when it must be dropped
 */
export function sanitizeUrl(value) {
  if (value == null) return null;
  const raw = String(value);
  const cleaned = raw.replace(CONTROL_CHARS, '').replace(/\s+/g, '');
  if (cleaned === '') return null;

  // Same-origin absolute path, and not a protocol-relative URL.
  if (cleaned.startsWith('/') && !cleaned.startsWith('//')) return cleaned;

  // Fragment and query-only references are same-document by definition.
  if (cleaned.startsWith('#') || cleaned.startsWith('?')) return cleaned;

  let parsed;
  try {
    parsed = new URL(cleaned, window.location.origin);
  } catch {
    return null;
  }
  if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) return null;
  return parsed.href;
}

/* ==================================================================== *
 * Element construction
 * ==================================================================== */

/**
 * Build an HTML element.
 *
 * `props` recognises:
 *   - `class`     string | string[] | Record<string, boolean>  -> classList
 *   - `dataset`   Record<string, string|number|boolean>        -> el.dataset
 *   - `style`     Record<string, string>                       -> setProperty
 *   - `aria`      Record<string, string|boolean>               -> aria-* attrs
 *   - `onClick`, `onInput`, `onKeydown`, ...  -> addEventListener('click', …);
 *     the value may be `handler` or `[handler, options]`
 *   - `ref`       (el) => void, invoked with the finished element
 *   - `html`      THROWS. There is no supported way to inject markup.
 *   - anything else -> setAttribute, except the DOM_PROPERTIES set above.
 *     `null` / `undefined` / `false` values skip the attribute entirely.
 *
 * `children` are variadic AND accept arrays, so both `el('p', {}, a, b)` and
 * `el('p', {}, [a, b])` work. Strings and numbers become text nodes; `null`,
 * `undefined`, `true` and `false` are skipped, which makes
 * `cond && el('span', …)` a safe idiom.
 *
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {...unknown} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  applyProps(node, props, false);
  appendChildren(node, children);
  return node;
}

/** Terse alias. `h` reads better inside deeply nested view trees. */
export const h = el;

/**
 * Build an SVG element in the SVG namespace. `document.createElement('rect')`
 * silently produces an unknown HTML element that renders as nothing, which is
 * a genuinely hard bug to spot — this is the only correct constructor.
 *
 * Attributes are always set with `setAttribute`: most SVG presentation
 * attributes have no matching DOM property, and `className` on an SVG element
 * is a read-only `SVGAnimatedString`.
 *
 * @param {string} tag
 * @param {Record<string, unknown> | null} [props]
 * @param {...unknown} children
 * @returns {SVGElement}
 */
export function svg(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  applyProps(node, props, true);
  appendChildren(node, children);
  return node;
}

/**
 * Prop names that would hand a string to the HTML parser. Compared lower-cased
 * so casing typos ('innerHtml') are caught too, and held as data rather than a
 * chain of literals so a repo-wide grep for the banned APIs stays clean.
 *
 * @type {ReadonlySet<string>}
 */
const RAW_MARKUP_PROPS = new Set([
  'html',
  'innerhtml',
  'outerhtml',
  'insertadjacenthtml',
  'dangerouslysetinnerhtml',
]);

/**
 * @param {Element} node
 * @param {Record<string, unknown> | null | undefined} props
 * @param {boolean} isSvg
 * @returns {void}
 */
function applyProps(node, props, isSvg) {
  if (!props) return;

  for (const key of Object.keys(props)) {
    const value = props[key];

    if (RAW_MARKUP_PROPS.has(key.toLowerCase())) {
      throw new TypeError(
        'dom.el(): raw HTML is not supported. Pass text children or build nodes instead.',
      );
    }

    if (value === null || value === undefined) continue;

    if (key === 'class' || key === 'className') {
      applyClass(node, value, isSvg);
      continue;
    }
    if (key === 'dataset' && typeof value === 'object') {
      for (const dataKey of Object.keys(/** @type {object} */ (value))) {
        const dataValue = /** @type {Record<string, unknown>} */ (value)[dataKey];
        if (dataValue === null || dataValue === undefined) continue;
        node.setAttribute('data-' + toKebab(dataKey), String(dataValue));
      }
      continue;
    }
    if (key === 'aria' && typeof value === 'object') {
      for (const ariaKey of Object.keys(/** @type {object} */ (value))) {
        const ariaValue = /** @type {Record<string, unknown>} */ (value)[ariaKey];
        if (ariaValue === null || ariaValue === undefined) continue;
        node.setAttribute('aria-' + toKebab(ariaKey), String(ariaValue));
      }
      continue;
    }
    if (key === 'style') {
      applyStyle(node, value);
      continue;
    }
    if (key === 'ref') {
      if (typeof value === 'function') /** @type {(n: Element) => void} */ (value)(node);
      continue;
    }
    if (key === 'text') {
      node.appendChild(document.createTextNode(String(value)));
      continue;
    }
    if (isEventProp(key)) {
      const [handler, options] = Array.isArray(value) ? value : [value, undefined];
      if (typeof handler === 'function') {
        node.addEventListener(
          key.slice(2).toLowerCase(),
          /** @type {EventListener} */ (handler),
          /** @type {AddEventListenerOptions | undefined} */ (options),
        );
      }
      continue;
    }

    if (URL_ATTRIBUTES.has(key)) {
      const safe = sanitizeUrl(value);
      if (safe === null) {
        console.warn('[dom] refused unsafe URL for attribute "' + key + '"');
        continue;
      }
      if (key === 'xlink:href') node.setAttributeNS(XLINK_NS, 'href', safe);
      else node.setAttribute(key, safe);
      continue;
    }

    if (!isSvg && DOM_PROPERTIES.has(key)) {
      // Boolean-ish DOM properties: assigning false must remove the state,
      // which `setAttribute(key, 'false')` would not do.
      /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (node))[key] = value;
      continue;
    }

    if (value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
}

/**
 * @param {string} key
 * @returns {boolean} true for `onClick`, `onKeydown`, … but not `once`
 */
function isEventProp(key) {
  return key.length > 2 && key[0] === 'o' && key[1] === 'n' && key[2] === key[2].toUpperCase();
}

/**
 * @param {Element} node
 * @param {unknown} value
 * @param {boolean} isSvg
 * @returns {void}
 */
function applyClass(node, value, isSvg) {
  /** @type {string[]} */
  const names = [];
  if (typeof value === 'string') {
    names.push(...value.split(/\s+/).filter(Boolean));
  } else if (Array.isArray(value)) {
    for (const entry of value) if (entry) names.push(String(entry));
  } else if (typeof value === 'object' && value !== null) {
    for (const name of Object.keys(value)) {
      if (/** @type {Record<string, unknown>} */ (value)[name]) names.push(name);
    }
  }
  if (names.length === 0) return;
  // SVG elements support classList in every browser this targets, but the
  // attribute form works identically and avoids the SVGAnimatedString trap.
  if (isSvg) node.setAttribute('class', names.join(' '));
  else node.classList.add(...names);
}

/**
 * Inline styles are permitted ONLY as a `Record<string, string>` applied
 * through the CSSOM, and in practice only for two things: CSS custom
 * properties that feed a stylesheet rule, and computed geometry a class
 * cannot express (a bar's height, a heatmap cell's offset). A string value is
 * rejected outright, because that is how a `style="…"` attribute carrying
 * remote data gets built by accident.
 *
 * @param {Element} node
 * @param {unknown} value
 * @returns {void}
 */
function applyStyle(node, value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('dom.el(): style must be an object of property/value pairs.');
  }
  const style = /** @type {HTMLElement} */ (node).style;
  if (!style) return;
  for (const property of Object.keys(value)) {
    const propertyValue = /** @type {Record<string, unknown>} */ (value)[property];
    if (propertyValue === null || propertyValue === undefined) continue;
    style.setProperty(
      property.startsWith('--') ? property : toKebab(property),
      String(propertyValue),
    );
  }
}

/**
 * @param {string} value camelCase or kebab-case
 * @returns {string} kebab-case
 */
function toKebab(value) {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * @param {Node} parent
 * @param {unknown[]} children
 * @returns {void}
 */
function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
      continue;
    }
    if (child instanceof Node) {
      parent.appendChild(child);
      continue;
    }
    // The single conversion point for untrusted data: a text node, always.
    parent.appendChild(document.createTextNode(String(child)));
  }
}

/* ==================================================================== *
 * Node utilities
 * ==================================================================== */

/**
 * @param {unknown} value
 * @returns {Text}
 */
export function text(value) {
  return document.createTextNode(value === null || value === undefined ? '' : String(value));
}

/**
 * @param {...unknown} children
 * @returns {DocumentFragment}
 */
export function frag(...children) {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

/**
 * Remove every child. Never by assigning an empty markup string.
 *
 * @template {Node} T
 * @param {T | null | undefined} node
 * @returns {T | null} the same node, for chaining
 */
export function clear(node) {
  if (!node) return null;
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Replace a container's contents in one shot. Children are assembled into a
 * fragment first, so the container is touched exactly once and the browser
 * performs a single layout pass.
 *
 * @template {Element} T
 * @param {T | null | undefined} container
 * @param {...unknown} nodes
 * @returns {T | null} the container
 */
export function mount(container, ...nodes) {
  if (!container) return null;
  const fragment = frag(...nodes);
  clear(container);
  container.appendChild(fragment);
  return container;
}

/**
 * Append without clearing.
 *
 * @template {Element | DocumentFragment} T
 * @param {T | null | undefined} container
 * @param {...unknown} nodes
 * @returns {T | null}
 */
export function append(container, ...nodes) {
  if (!container) return null;
  appendChildren(container, nodes);
  return container;
}

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {Element | null}
 */
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {Element[]} a real Array, so `.map` / `.filter` work
 */
export function qsa(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/* ==================================================================== *
 * Events
 * ==================================================================== */

/**
 * Add a listener and get its removal back. Views collect these unsubscribers
 * and call them all in `unmount()`, which is what stops listeners leaking
 * across tab switches.
 *
 * @param {EventTarget | null | undefined} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} handler
 * @param {AddEventListenerOptions | boolean} [options]
 * @returns {() => void} unsubscribe; safe to call more than once
 */
export function on(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    target.removeEventListener(type, handler, options);
  };
}

/**
 * Delegated listener. One handler on a container serves any number of rows,
 * so re-rendering a 200-row table does not churn 200 listeners.
 *
 * The handler receives `(event, matchedElement)`.
 *
 * @param {Element | null | undefined} root
 * @param {string} selector
 * @param {string} type
 * @param {(event: Event, matched: Element) => void} handler
 * @param {AddEventListenerOptions | boolean} [options]
 * @returns {() => void} unsubscribe
 */
export function delegate(root, selector, type, handler, options) {
  return on(
    root,
    type,
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const matched = target.closest(selector);
      if (!matched || !root || !root.contains(matched)) return;
      handler(event, matched);
    },
    options,
  );
}

/* ==================================================================== *
 * Accessibility helpers
 * ==================================================================== */

/**
 * Mark a region as updating. Screen readers suppress churn inside an
 * `aria-busy` container and announce it once when it settles.
 *
 * @param {Element | null | undefined} node
 * @param {boolean} busy
 * @returns {void}
 */
export function setBusy(node, busy) {
  if (!node) return;
  if (busy) node.setAttribute('aria-busy', 'true');
  else node.removeAttribute('aria-busy');
}

/**
 * Announce a message to assistive technology.
 *
 * The two live regions in index.html are the ONLY live regions in the app;
 * nothing else may create one, because overlapping live regions produce
 * duplicate and out-of-order announcements.
 *
 * The clear-then-set dance is required: writing the same text twice in a row
 * is a no-op change to the accessibility tree and is silently not announced.
 * A frame (not a microtask) between the two writes is what makes the second
 * write register.
 *
 * @param {string} message
 * @param {boolean} [assertive] true for failures that interrupt the user
 * @returns {void}
 */
export function announce(message, assertive = false) {
  const region = document.getElementById(assertive ? 'live-assertive' : 'live-polite');
  if (!region || typeof message !== 'string' || message === '') return;
  region.textContent = '';
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      region.textContent = message;
    });
  });
}

/** Elements that can hold focus, in document order. */
export const TABBABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  'details > summary:first-of-type',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

/**
 * Focus the first genuinely focusable descendant, skipping anything hidden or
 * inside an `[inert]` / `[hidden]` subtree. Falls back to the container itself
 * when it can hold focus, which is how a freshly revealed tabpanel receives it.
 *
 * @param {Element | null | undefined} container
 * @returns {HTMLElement | null} the element that received focus
 */
export function focusFirst(container) {
  if (!container) return null;
  for (const candidate of qsa(TABBABLE_SELECTOR, container)) {
    if (!(candidate instanceof HTMLElement)) continue;
    if (candidate.closest('[hidden], [inert]')) continue;
    // offsetParent is null for display:none; getClientRects covers position:fixed.
    if (candidate.offsetParent === null && candidate.getClientRects().length === 0) continue;
    candidate.focus();
    return candidate;
  }
  if (container instanceof HTMLElement && container.hasAttribute('tabindex')) {
    container.focus();
    return container;
  }
  return null;
}

/* ==================================================================== *
 * Links
 * ==================================================================== */

/**
 * An external link that is safe by construction: the URL is sanitized, the
 * tab-nabbing vector is closed with `rel="noopener noreferrer"`, and the
 * new-tab behaviour is announced rather than left as a surprise.
 *
 * When the URL is rejected the function returns a plain `<span class="mono">`
 * holding the label — never a live anchor to an unvetted scheme.
 *
 * @param {string | null | undefined} href
 * @param {string} label
 * @param {Record<string, unknown>} [props] extra props merged onto the anchor
 * @returns {HTMLElement}
 */
export function extLink(href, label, props) {
  const safe = sanitizeUrl(href);
  if (safe === null) return el('span', { class: 'mono' }, label);
  return el(
    'a',
    { ...props, href: safe, target: '_blank', rel: 'noopener noreferrer' },
    label,
    el('span', { class: 'sr-only' }, ' (opens in a new tab)'),
  );
}
