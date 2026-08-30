/**
 * The OpenAPI 3.1 document, generated from `ROUTE_TABLE` and the zod schemas.
 *
 * ## Why generated
 *
 * A hand-maintained API reference is a second source of truth, and this repository already paid
 * for one: the published docs described `GET /api/v1/node` and `POST /api/v1/agents/{address}/endorse`
 * while the shipped client called `/api/status` and `/api/reputation/endorse`, and nothing failed
 * until someone tried to use the documentation. Here there is one table and one set of schemas, and
 * the document is a projection of them.
 *
 * ## No JSON-Schema conversion dependency
 *
 * zod v4 ships `z.toJSONSchema()`, which emits draft 2020-12 - exactly the dialect OpenAPI 3.1
 * uses. The spec for this file called for a hand-written ~150-line converter to avoid pulling in
 * `zod-to-json-schema`; the installed zod makes both unnecessary. Request schemas are converted in
 * `io: 'input'` mode (what a client sends, before defaults and transforms) and response schemas in
 * `io: 'output'` mode (what a client receives), which is a distinction a hand-rolled converter
 * would have had to get right and probably would not have.
 *
 * `unrepresentable: 'any'` keeps a `z.unknown()` field - a payload whose shape is the protocol's
 * business, not this document's - as an unconstrained schema rather than throwing.
 *
 * @module src/openapi
 */
import { z } from 'zod';

import { getConfig } from './config/index.js';
import { ROUTE_TABLE } from './routes/index.js';
import { SCHEMAS } from './schemas/api.js';

/** Human-readable descriptions for the tags, in the order they should be presented. */
export const TAGS = Object.freeze([
  { name: 'Health', description: 'Liveness, readiness, node status and this document.' },
  { name: 'Agents', description: 'On-chain identity: registration and lookup.' },
  { name: 'Memory', description: 'The memory lifecycle: create, list, read, verify, decrypt.' },
  { name: 'Jobs', description: 'Progress and results for asynchronous write operations.' },
  { name: 'Semantic', description: 'Cross-model alignment, retrieval and the similarity matrix.' },
  { name: 'Reputation', description: 'Trust scores and the two trust-writing actions.' },
  { name: 'Metrics', description: 'Prometheus exposition and the dashboard summary.' },
  { name: 'Simulation', description: 'Benchmark data from the last local simulation run.' },
]);

/** The shared error responses each path references rather than restating. */
const ERROR_RESPONSES = Object.freeze({
  400: [
    'BadRequest',
    'The request failed validation. `error.details` lists every problem at once.',
  ],
  401: ['Unauthorized', 'No API key, or an invalid one. Send X-API-Key or Authorization: Bearer.'],
  403: ['Forbidden', 'Authenticated, but not permitted to perform this action on this object.'],
  404: ['NotFound', 'No such route, or no such object.'],
  409: ['Conflict', 'The action contradicts current state (already registered, nonce conflict).'],
  413: ['PayloadTooLarge', 'The request body exceeded the configured limit.'],
  429: ['TooManyRequests', 'Rate limited. Honour Retry-After.'],
  502: ['BadGateway', 'An upstream (pinning service or RPC endpoint) failed.'],
  503: ['ServiceUnavailable', 'A dependency is not ready, or this node is read-only. Retriable.'],
  504: ['GatewayTimeout', 'An upstream did not answer within its budget.'],
});

/**
 * Convert one zod schema to JSON Schema, stripping the `$schema` key OpenAPI does not want.
 *
 * @param {import('zod').ZodType} schema The schema.
 * @param {'input'|'output'} io Which side of the transform to describe.
 * @returns {Record<string, any>} The JSON Schema object.
 */
export function toJsonSchema(schema, io) {
  const converted = /** @type {Record<string, any>} */ (
    z.toJSONSchema(schema, { io, unrepresentable: 'any', target: 'draft-2020-12' })
  );
  const { $schema: _ignored, ...rest } = converted;
  return rest;
}

/**
 * Turn an Express path (`/memories/:cid`) into an OpenAPI path (`/memories/{cid}`).
 *
 * @param {string} path Express-style path.
 * @returns {string} OpenAPI-style path.
 */
export function toOpenApiPath(path) {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Every `:param` name in a path, in order.
 *
 * @param {string} path Express-style path.
 * @returns {string[]} Parameter names.
 */
function pathParams(path) {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

/**
 * Build the document.
 *
 * @param {object} [options] Options.
 * @param {Record<string, any>} [options.config] Application config.
 * @param {readonly Record<string, any>[]} [options.routeTable] Route table.
 * @param {Record<string, any>} [options.schemas] Schema registry.
 * @returns {Record<string, any>} The OpenAPI 3.1 document.
 */
export function buildOpenApi({
  config = getConfig(),
  routeTable = ROUTE_TABLE,
  schemas = SCHEMAS,
} = {}) {
  /** @type {Record<string, any>} */
  const components = {};
  for (const [name, schema] of Object.entries(schemas)) {
    // Response schemas describe what a client receives, so they are converted in output mode;
    // request schemas describe what a client sends, before defaults are applied.
    const io = /Response$|^Job$|^JobStep$|^MemorySummary$|^ReadinessCheck$/.test(name)
      ? /** @type {const} */ ('output')
      : /** @type {const} */ ('input');
    components[name] = toJsonSchema(/** @type {any} */ (schema), io);
  }

  /** @type {Record<string, any>} */
  const responses = {};
  for (const [status, [name, description]] of Object.entries(ERROR_RESPONSES)) {
    responses[name] = {
      description: `${status} - ${description}`,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    };
  }

  /** @type {Record<string, any>} */
  const paths = {};
  for (const route of routeTable) {
    const key = toOpenApiPath(route.path);
    paths[key] ??= {};

    /** @type {any[]} */
    const parameters = [];
    const paramSchema = route.params ? components[route.params] : null;
    for (const name of pathParams(route.path)) {
      parameters.push({
        name,
        in: 'path',
        required: true,
        description: paramSchema?.properties?.[name]?.description ?? undefined,
        schema: paramSchema?.properties?.[name] ?? { type: 'string' },
      });
    }
    if (route.query) {
      const querySchema = components[route.query] ?? {};
      const required = new Set(querySchema.required ?? []);
      for (const [name, schema] of Object.entries(querySchema.properties ?? {})) {
        parameters.push({
          name,
          in: 'query',
          required: required.has(name),
          description: /** @type {any} */ (schema).description ?? undefined,
          schema,
        });
      }
    }

    /** @type {Record<string, any>} */
    const operationResponses = {};
    for (const status of route.statuses) {
      if (status === route.success) {
        operationResponses[String(status)] = {
          description: route.summary,
          content: route.response
            ? {
                'application/json': {
                  schema: { $ref: `#/components/schemas/${route.response}` },
                },
              }
            : undefined,
        };
      } else if (status === 304) {
        operationResponses['304'] = { description: 'Not modified; the ETag still matches.' };
      } else {
        const shared = /** @type {Record<number, [string, string]>} */ (ERROR_RESPONSES)[status];
        operationResponses[String(status)] = shared
          ? { $ref: `#/components/responses/${shared[0]}` }
          : { description: `HTTP ${status}.` };
      }
    }

    paths[key][route.method] = {
      operationId: route.id,
      tags: [route.tag],
      summary: route.summary,
      description:
        route.aliases.length > 0
          ? `${route.description}\n\nAlso served at: ${route.aliases.join(', ')}.`
          : route.description,
      security: route.auth ? [{ ApiKeyAuth: [] }, { BearerAuth: [] }] : [],
      parameters: parameters.length > 0 ? parameters : undefined,
      requestBody: route.body
        ? {
            required: route.body !== 'DecryptBody',
            description:
              route.body === 'DecryptBody'
                ? 'Deliberately empty and strict. This endpoint accepts NO caller-supplied ' +
                  'ciphertext; the only input is the CID in the path.'
                : undefined,
            content: {
              'application/json': { schema: { $ref: `#/components/schemas/${route.body}` } },
            },
          }
        : undefined,
      responses: operationResponses,
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'NeuroMesh Node API',
      version: config.app.version,
      summary: 'Decentralized cognitive memory for autonomous agents.',
      description:
        'Every path below is served by a single NeuroMesh node. Paths are canonical at /api/v1; ' +
        'each operation also lists the unversioned aliases the bundled dashboard uses.\n\n' +
        'Error responses always have the shape `{error:{code,message,details},requestId}`. Branch ' +
        'on `error.code`, never on the message text.\n\n' +
        'Write operations return `202` with a job document and a `Location` header; poll ' +
        '`GET /api/v1/jobs/{id}` for per-step progress.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: '/', description: 'This node.' }],
    tags: [...TAGS],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        BearerAuth: { type: 'http', scheme: 'bearer' },
      },
      schemas: components,
      responses,
    },
    paths,
  };
}

/** @type {Record<string, any>|null} */
let memoized = null;

/**
 * The memoized document.
 *
 * @returns {Record<string, any>} The OpenAPI document.
 */
export function openApiDocument() {
  memoized ??= buildOpenApi();
  return memoized;
}

/**
 * Render a dependency-free HTML view of the document.
 *
 * No CDN, no external script and no inline handler: the CSP this app sets is `script-src 'self'`
 * with no `unsafe-inline`, so a Swagger-UI bundle from a CDN would simply be blocked and the page
 * would render blank. A server-rendered list is less pretty and actually works.
 *
 * Everything interpolated here comes from this repository's own frozen route table and schema
 * descriptions, never from a request, and it is HTML-escaped regardless.
 *
 * @param {Record<string, any>} doc The OpenAPI document.
 * @returns {string} A complete HTML page.
 */
export function renderDocsHtml(doc) {
  /**
   * @param {unknown} value Text to escape.
   * @returns {string} HTML-safe text.
   */
  const esc = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  /** @type {Map<string, string[]>} */
  const byTag = new Map();
  for (const [path, operations] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(/** @type {any} */ (operations))) {
      const op = /** @type {any} */ (operation);
      const tag = op.tags?.[0] ?? 'Other';
      const rows = byTag.get(tag) ?? [];
      rows.push(
        [
          '<article class="op">',
          `<h3><span class="m m-${esc(method)}">${esc(method.toUpperCase())}</span>`,
          `<code>${esc(path)}</code>`,
          op.security?.length ? '<span class="auth" title="API key required">key</span>' : '',
          '</h3>',
          `<p class="summary">${esc(op.summary)}</p>`,
          `<p class="desc">${esc(op.description).replace(/\n\n/g, '</p><p class="desc">')}</p>`,
          `<p class="codes">Statuses: ${Object.keys(op.responses ?? {})
            .map((code) => `<code>${esc(code)}</code>`)
            .join(' ')}</p>`,
          '</article>',
        ].join(''),
      );
      byTag.set(tag, rows);
    }
  }

  const sections = (doc.tags ?? [])
    .filter((/** @type {any} */ tag) => byTag.has(tag.name))
    .map(
      (/** @type {any} */ tag) =>
        `<section><h2 id="${esc(tag.name)}">${esc(tag.name)}</h2>` +
        `<p class="tagdesc">${esc(tag.description)}</p>` +
        (byTag.get(tag.name) ?? []).join('') +
        '</section>',
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.info.title)} ${esc(doc.info.version)}</title>
<link rel="stylesheet" href="/css/tokens.css">
<link rel="stylesheet" href="/css/base.css">
</head>
<body class="docs">
<main>
<h1>${esc(doc.info.title)} <small>v${esc(doc.info.version)}</small></h1>
<p>${esc(doc.info.summary)}</p>
<p>Machine-readable document: <a href="/openapi.json">/openapi.json</a></p>
<nav>${(doc.tags ?? [])
    .filter((/** @type {any} */ tag) => byTag.has(tag.name))
    .map((/** @type {any} */ tag) => `<a href="#${esc(tag.name)}">${esc(tag.name)}</a>`)
    .join(' &middot; ')}</nav>
${sections}
</main>
</body>
</html>
`;
}

export default openApiDocument;
