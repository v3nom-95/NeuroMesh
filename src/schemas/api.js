/**
 * Every request and response schema the HTTP layer uses, in one module.
 *
 * ## Why one module
 *
 * `src/middleware/validate.js`, `src/routes/*.js` and `src/openapi.js` all read from here, so a
 * field exists in exactly one place: its zod definition. The v1 server had no schemas at all, and
 * the cost was concrete - the server wrote `{agent_did, encrypted_context, vector_embedding, ...}`
 * while the dashboard read `ipfsData.raw_context`, a key no payload has ever carried. Nothing
 * errored; `undefined` was interpolated and every memory card rendered fallback text.
 *
 * ## Rules that hold for every schema below
 *
 *  - **Request objects are `.strict()`.** An unknown field is a `400`, not a silent drop. That is
 *    the mechanism that catches a client/server drift on the request side, and it is the reason
 *    {@link DecryptBody} - an empty strict object - makes the decryption oracle structurally
 *    impossible to reintroduce: there is no field a caller could add to smuggle in ciphertext.
 *  - **Response objects are `.loose()`.** A response schema is a floor, not a ceiling: an additive
 *    field must never fail validation, because the frontend and the docs are versioned separately
 *    from this process. What these schemas pin down is that the fields other lanes were promised
 *    are present and correctly typed.
 *  - **Every field carries `.describe()` where the name is not self-explanatory.** That text is the
 *    OpenAPI field documentation, so there is exactly one place to keep accurate.
 *  - **No value is ever echoed into an error.** `validate()` reports `{path, code, message}` only.
 *
 * @module src/schemas/api
 */
import { getAddress } from 'ethers';
import { z } from 'zod';

import { getConfig } from '../config/index.js';
import { canonical, constants } from '../protocol/index.js';

const config = getConfig();

/* ========================================================================== */
/* Primitives                                                                 */
/* ========================================================================== */

/**
 * A 20-byte Ethereum address, normalised to its EIP-55 checksummed form.
 *
 * The transform is the point: downstream code never has to decide whether it is holding
 * `0xabc...` or `0xAbC...`, so an address can be used as a map key without a normalisation step
 * that someone will eventually forget. A mixed-case value whose checksum is wrong is rejected
 * rather than silently lowercased - a bad checksum is usually a transcription error, and accepting
 * it would point a funds-adjacent operation at an address the caller did not mean.
 */
export const AddressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
  .transform((value, ctx) => {
    try {
      return getAddress(value);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'the address checksum is invalid; send it all-lowercase or correctly checksummed',
      });
      return z.NEVER;
    }
  })
  .describe('An EIP-55 checksummed Ethereum address.');

/**
 * A CIDv1 over raw bytes with a sha2-256 multihash - the only kind this protocol produces.
 *
 * The regex alone would accept a dag-pb CID or a different hash function, which would then fail
 * much later inside the IPFS service with a message about digests. The refinement runs the real
 * decoder, so a wrong CID kind is refused here, with an explanation.
 */
export const CidSchema = z
  .string()
  .trim()
  .min(10)
  .max(256)
  .regex(/^b[a-z2-7]{20,}$/, 'must be a base32 CIDv1 (it starts with "b")')
  .refine(
    (value) => {
      try {
        return typeof canonical.digestFromCid(value) === 'string';
      } catch {
        return false;
      }
    },
    { message: 'must be a CIDv1 over raw bytes with a sha2-256 multihash' },
  )
  .describe('A CIDv1 (raw codec, sha2-256).');

/** A 0x-prefixed 32-byte hex string. */
export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be 0x followed by 64 hex characters')
  .describe('A 0x-prefixed 32-byte hex value.');

/** A UUIDv4 job identifier. Job ids are capabilities; see `src/routes/jobs.js`. */
export const JobIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'must be a UUIDv4',
  )
  .describe('A job identifier (UUIDv4).');

/** An opaque pagination cursor. Its contents are the server's business, never the client's. */
export const CursorSchema = z
  .string()
  .max(512)
  .describe('An opaque cursor from a previous page. Never construct one by hand.');

/**
 * Query strings carry text, so `?encrypted=true` arrives as the string `'true'`.
 *
 * `z.coerce.boolean()` is deliberately not used: it is `Boolean(value)`, so the string `'false'`
 * coerces to `true`. That is the single most common query-parameter bug there is.
 */
export const BooleanishSchema = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1')
  .describe('A boolean. In a query string: true, false, 1 or 0.');

/** The embedding models a client may name, in the lowercase spelling the API publishes. */
export const ModelKeySchema = z
  .enum(['minilm', 'distilroberta'])
  .describe('Embedding model: minilm (384-d) or distilroberta (768-d).');

/** Public model name to embedding-registry key. Exported so routes need no second table. */
export const MODEL_KEYS = Object.freeze({
  minilm: 'MiniLM',
  distilroberta: 'distilRoBERTa',
});

/** The reverse map, for reporting a registry key back to a client. */
export const MODEL_NAMES = Object.freeze({
  MiniLM: 'minilm',
  distilRoBERTa: 'distilroberta',
});

/* ========================================================================== */
/* Request schemas                                                            */
/* ========================================================================== */

/** `GET /agents/:address` and `GET /reputation/:address`. */
export const AddressParams = z.object({ address: AddressSchema }).strict();

/** Any route with a `:cid` path segment. */
export const MemoryParams = z.object({ cid: CidSchema }).strict();

/** `GET /jobs/:id`. */
export const JobParams = z.object({ id: JobIdSchema }).strict();

/** `POST /agents/register`. */
export const RegisterBody = z
  .object({
    metadataURI: z
      .string()
      .trim()
      .max(512)
      .refine((value) => /^(https?|ipfs|ipns):\/\//i.test(value), {
        message: 'must be an http(s), ipfs or ipns URI',
      })
      .optional()
      .describe('Optional off-chain profile document for this agent.'),
  })
  .strict();

/**
 * `POST /memories`.
 *
 * `context` is `z.string()`, which rejects an array, a number and `null`. That single constraint
 * is the fix for the worst data-integrity defect in v1: an array reached the tokenizer, was
 * treated as a batch, produced a 768- or 1920-float vector, and was then committed to the ledger
 * under a hardcoded `embeddingDim: 384` - a permanent on-chain record that did not describe the
 * payload it pointed at.
 */
export const CreateMemoryBody = z
  .object({
    context: z
      .string()
      .trim()
      .min(1)
      .max(config.embeddings.maxContextChars)
      .describe('The plaintext to remember. Sealed before it leaves this process.'),
    parentCid: CidSchema.nullable()
      .optional()
      .describe('The memory this one supersedes, forming a version chain.'),
    grantees: z
      .array(
        z
          .object({
            address: AddressSchema,
            publicKey: z
              .string()
              .regex(/^0x0[23][0-9a-fA-F]{64}$/, 'must be a 33-byte compressed secp256k1 key')
              .describe('The recipient ENCRYPTION public key, not their wallet public key.'),
            keyVersion: z.coerce.number().int().min(1).max(65535).optional(),
          })
          .strict(),
      )
      .max(16)
      .optional()
      .default([])
      .describe('Additional recipients the content encryption key is wrapped to.'),
    policy: z
      .object({
        embeddingVisibility: z.enum(['public', 'grantees', 'lsh-only']).default('grantees'),
        redistribution: z.enum(['forbidden', 'grantees', 'public']).default('grantees'),
        retentionUntil: z.coerce.number().int().positive().nullable().default(null),
      })
      .strict()
      .optional()
      .describe(
        'Access policy. Bound into the AEAD additional data, so it cannot be edited later.',
      ),
    model: ModelKeySchema.optional().default('minilm'),
  })
  .strict();

/** `GET /memories`. */
export const ListMemoriesQuery = z
  .object({
    cursor: CursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    encrypted: BooleanishSchema.optional(),
    model: z.string().max(200).optional().describe('Filter on the canonical model URI.'),
  })
  .strict();

/**
 * `POST /memories/:cid/decrypt`.
 *
 * Empty, and strict. This is not an oversight to be filled in later: the endpoint it replaces
 * accepted `{encryptedData:{encrypted,salt,iv,tag}}` from any origin and decrypted it with the
 * node's chain signing key. Keeping the body schema structurally empty means no future edit can
 * add a ciphertext field without deleting this comment first.
 */
export const DecryptBody = z.object({}).strict();

/** `POST /semantic/search`. */
export const SearchBody = z
  .object({
    query: z.string().trim().min(1).max(1000).describe('Text to embed and search for.'),
    topK: z.coerce.number().int().min(1).max(50).default(10),
    minSimilarity: z
      .number()
      .min(-1)
      .max(1)
      .default(0)
      .describe('Cosine floor. Compare it against diagnostics.noiseBaseline before trusting it.'),
    trustWeighted: z.boolean().default(true),
    model: ModelKeySchema.default('minilm'),
    owner: AddressSchema.optional().describe('Restrict to one owning agent.'),
  })
  .strict();

/** `GET /semantic/similarity`. */
export const SimilarityQuery = z
  .object({
    maxPairs: z.coerce
      .number()
      .int()
      .min(1)
      .max(20000)
      .default(2000)
      .describe('Upper bound on the pairs sampled per cell, so the request stays bounded.'),
  })
  .strict();

/** `GET /reputation`. */
export const ReputationQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: CursorSchema.optional(),
    addresses: z
      .string()
      .max(2000)
      .optional()
      .describe('Comma-separated addresses to score, instead of the on-chain agent index.'),
  })
  .strict();

/** `POST /reputation/endorse` and `POST /reputation/report`. */
export const TrustActionBody = z
  .object({
    target: AddressSchema.describe('The agent being endorsed or reported.'),
    reason: z.string().trim().min(1).max(config.embeddings.maxReasonChars),
  })
  .strict();

/** `GET /metrics/summary`. */
export const MetricsQuery = z
  .object({ window: z.enum(['5m', '1h', '24h']).default('1h') })
  .strict();

/** `GET /jobs`. */
export const JobListQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(25) })
  .strict();

/* ========================================================================== */
/* Response schemas                                                           */
/* ========================================================================== */

/** The one error envelope. Every non-2xx response in this API has exactly this shape. */
export const ErrorResponse = z
  .object({
    error: z
      .object({
        code: z.string().describe('A stable machine-readable code. Branch on this, not on text.'),
        message: z.string(),
        details: z.unknown().nullable(),
        stack: z.string().optional().describe('Development and test only; never in production.'),
      })
      .loose(),
    requestId: z.string().nullable().describe('Echoed as the X-Request-Id response header.'),
  })
  .loose();

/** `GET /healthz`. */
export const HealthResponse = z
  .object({
    status: z.enum(['ok', 'degraded']),
    uptimeSec: z.number(),
    version: z.string(),
    commit: z.string(),
    node: z.string(),
    draining: z.boolean(),
  })
  .loose();

/** One dependency's verdict inside {@link ReadinessResponse}. */
export const ReadinessCheck = z
  .object({
    name: z.string(),
    status: z.enum(['up', 'down', 'degraded', 'disabled']),
    critical: z.boolean(),
    detail: z.string().nullable(),
    latencyMs: z.number().nullable(),
    checkedAt: z.string(),
  })
  .loose();

/** `GET /readyz`. Identical body at 200 and 503, so a probe and the UI read one document. */
export const ReadinessResponse = z
  .object({
    ready: z.boolean(),
    draining: z.boolean(),
    checks: z.array(ReadinessCheck),
  })
  .loose();

/** `GET /status`. */
export const StatusResponse = z
  .object({
    node: z
      .object({
        name: z.string(),
        version: z.string(),
        commit: z.string(),
        env: z.string(),
        uptimeSec: z.number(),
        startedAt: z.string(),
      })
      .loose(),
    agent: z
      .object({
        address: z.string().nullable(),
        did: z.string().nullable(),
        registered: z.boolean().nullable(),
        active: z.boolean().nullable(),
        keyVersion: z.number().nullable(),
        encryptionPublicKey: z.string().nullable(),
        reputation: z.unknown().nullable(),
      })
      .loose(),
    chain: z
      .object({
        configured: z.boolean(),
        network: z.string().nullable(),
        chainId: z.number().nullable(),
        blockNumber: z.number().nullable(),
        contractsCompatible: z.boolean(),
        explorerBase: z.string().nullable(),
        balance: z.string().nullable(),
        contracts: z.record(z.string(), z.string().nullable()),
      })
      .loose(),
    model: z
      .object({
        ready: z.boolean(),
        loading: z.boolean(),
        provider: z.enum(['local', 'mock']),
        name: z.string().nullable(),
        dim: z.number().nullable(),
        dimensions: z.number().nullable(),
        error: z.unknown().nullable(),
      })
      .loose(),
    ipfs: z
      .object({
        configured: z.boolean(),
        provider: z.string(),
        gateway: z.string().nullable(),
      })
      .loose(),
    protocol: z
      .object({
        version: z.string(),
        specHash: z.string(),
        sharedDim: z.number(),
        projectionId: z.string().nullable(),
      })
      .loose(),
    features: z
      .object({
        write: z.boolean(),
        search: z.boolean(),
        decrypt: z.boolean(),
        metrics: z.boolean(),
        legacyRoutes: z.boolean(),
        sseToken: z.literal(false),
      })
      .loose(),
    counts: z.object({ memories: z.number(), jobs: z.number() }).loose(),
    memoryCount: z.number(),
    readOnly: z.boolean(),
  })
  .loose();

/** One row of `GET /memories`. */
export const MemorySummary = z
  .object({
    cid: z.string(),
    owner: z.string(),
    agentDid: z.string().nullable(),
    model: z.string().nullable(),
    embeddingDim: z.number(),
    isEncrypted: z.boolean(),
    createdAt: z.number().describe('Unix seconds.'),
    txHash: z.string().nullable(),
    blockNumber: z.number().nullable(),
    sizeBytes: z.number().nullable(),
  })
  .loose();

/** `GET /memories`. */
export const MemoryListResponse = z
  .object({
    items: z.array(MemorySummary),
    nextCursor: z.string().nullable(),
    total: z.number(),
    source: z.string().describe('Where the page came from. Currently always the local index.'),
  })
  .loose();

/** `GET /memories/:cid`. */
export const MemoryDetail = z
  .object({
    cid: z.string(),
    cidDigest: z.string(),
    payloadVersion: z.string().describe('Branch on this. v2 is camelCase; v1 was snake_case.'),
    payload: z.unknown(),
    sizeBytes: z.number(),
    onchain: z.unknown().nullable(),
    onchainReason: z.string().nullable(),
    gatewayUrl: z.string(),
  })
  .loose();

/** One step of the commit pipeline. Render from the array, never from a fixed list. */
export const JobStep = z
  .object({
    name: z.string(),
    state: z.enum(['pending', 'active', 'done', 'failed', 'skipped']),
    ms: z.number().nullable(),
    detail: z.unknown(),
  })
  .loose();

/** `GET /jobs/:id`, and the 202 body of every write route. */
export const Job = z
  .object({
    id: z.string(),
    kind: z.string(),
    state: z.enum(['queued', 'running', 'succeeded', 'failed']),
    steps: z.array(JobStep),
    result: z.record(z.string(), z.unknown()).nullable(),
    error: z.unknown().nullable(),
    warnings: z.array(z.string()),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  })
  .loose();

/** `GET /memories/:cid/verify`. */
export const VerificationResponse = z
  .object({
    cid: z.string(),
    ok: z.boolean(),
    steps: z.array(
      z
        .object({
          name: z.string(),
          state: z.enum(['pass', 'fail', 'skip']),
          detail: z.string(),
        })
        .loose(),
    ),
  })
  .loose();

/** `POST /memories/:cid/decrypt`. */
export const DecryptResponse = z
  .object({
    cid: z.string(),
    context: z.string(),
    contentId: z.string(),
    verified: z.literal(true),
    embeddingVerified: z.boolean(),
  })
  .loose();

/** `POST /semantic/search`. */
export const SearchResponse = z
  .object({
    query: z.string().nullable(),
    topK: z.number(),
    trustWeighted: z.boolean(),
    results: z.array(z.record(z.string(), z.unknown())),
    tookMs: z.number(),
    diagnostics: z
      .object({
        indexSize: z.number(),
        candidateCount: z.number(),
        projectionId: z.string(),
        outDim: z.number(),
        noiseBaseline: z.number().describe('1/sqrt(dim). Treat anything near it as noise.'),
      })
      .loose(),
  })
  .loose();

/** `GET /semantic/similarity`. */
export const SimilarityResponse = z
  .object({
    labels: z.array(z.string()),
    matrix: z.array(z.array(z.number().nullable())),
    pairs: z.array(z.record(z.string(), z.unknown())),
    models: z.array(z.record(z.string(), z.unknown())),
    diagnostics: z.record(z.string(), z.unknown()),
  })
  .loose();

/** `GET /reputation`. */
export const ReputationResponse = z
  .object({
    entries: z.array(z.record(z.string(), z.unknown())),
    events: z.array(z.record(z.string(), z.unknown())),
    thresholds: z.object({ trusted: z.number().nullable(), max: z.number() }).loose(),
    nextCursor: z.string().nullable(),
    total: z.number(),
  })
  .loose();

/** `GET /agents/:address`. */
export const AgentResponse = z
  .object({
    address: z.string(),
    did: z.string(),
    registered: z.boolean(),
    active: z.boolean(),
    keyVersion: z.number().nullable(),
    publicKey: z.string().nullable(),
    metadataURI: z.string().nullable(),
    registeredAt: z.number().nullable(),
    reputation: z.unknown().nullable(),
  })
  .loose();

/** `GET /metrics/summary`. */
export const MetricsResponse = z
  .object({
    window: z.string(),
    latency: z.record(z.string(), z.unknown()),
    counters: z.record(z.string(), z.number()),
    gauges: z.record(z.string(), z.number()),
  })
  .loose();

/**
 * `GET /simulation-results`.
 *
 * `available` is the discriminator, and it is why this route answers `200` on a fresh clone rather
 * than `404`: `simulation-results.json` is generated by `npm run simulate` and is gitignored, so
 * its absence is the DEFAULT state of a correct checkout, not a fault. The five array/object names
 * below are load-bearing for the dashboard's charts and are always present - empty when there is
 * no file - so no view has to special-case a missing key.
 */
export const SimulationResponse = z
  .object({
    available: z.boolean(),
    reason: z.string().nullable(),
    hint: z.string().nullable(),
    generatedAt: z.string().nullable(),
    agents: z.array(z.unknown()),
    memoryCommits: z.array(z.unknown()),
    reputationEvents: z.array(z.unknown()),
    crossModelSimilarity: z.array(z.unknown()),
    benchmarks: z
      .object({
        embeddingLatencies: z.array(z.number()),
        encryptionLatencies: z.array(z.number()),
        ipfsLatencies: z.array(z.number()),
        blockchainLatencies: z.array(z.number()),
        totalLatencies: z.array(z.number()),
      })
      .loose(),
  })
  .loose();

/* ========================================================================== */
/* Registry                                                                   */
/* ========================================================================== */

/**
 * Every named schema, for the OpenAPI generator's `components.schemas`.
 *
 * @type {Readonly<Record<string, import('zod').ZodType>>}
 */
export const SCHEMAS = Object.freeze({
  AddressParams,
  MemoryParams,
  JobParams,
  RegisterBody,
  CreateMemoryBody,
  ListMemoriesQuery,
  DecryptBody,
  SearchBody,
  SimilarityQuery,
  ReputationQuery,
  TrustActionBody,
  MetricsQuery,
  JobListQuery,
  ErrorResponse,
  HealthResponse,
  ReadinessCheck,
  ReadinessResponse,
  StatusResponse,
  MemorySummary,
  MemoryListResponse,
  MemoryDetail,
  JobStep,
  Job,
  VerificationResponse,
  DecryptResponse,
  SearchResponse,
  SimilarityResponse,
  ReputationResponse,
  AgentResponse,
  MetricsResponse,
  SimulationResponse,
});

/** The protocol constants the status route publishes. Re-exported so routes import one module. */
export const PROTOCOL_INFO = Object.freeze({
  version: constants.PROTOCOL_VERSION,
  specHash: constants.SPEC_HASH,
  sharedDim: constants.SHARED_EMBEDDING_DIM,
});
