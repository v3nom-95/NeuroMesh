# REST API Reference

> **Read this first.** At the time of writing, `src/http/` and `src/routes/` **do not exist** in the
> tree. `src/config/`, `src/errors.js`, `src/logger.js`, `src/middleware/` and `src/abi/` have landed;
> the routers have not. The process started by `npm start` is still the **legacy v1 `server.js`**.
>
> This document therefore has two parts, and neither is fiction:
>
> - **[Part A](#part-a--what-is-served-today)** documents the seven routes `server.js` actually
>   serves, transcribed from the file. Everything there is verifiable by running it.
> - **[Part B](#part-b--the-v2-surface-in-progress)** documents the v2 surface, with every element
>   traced to the artefact that defines it: the error taxonomy in `src/errors.js`, the auth rules in
>   `src/middleware/auth.js`, the request-id rules in `src/middleware/requestId.js`, the limits in
>   `src/config/env.js`, and the endpoint list the dashboard is written against in
>   `public/js/api.js`. Route handlers are marked **In progress**, and where the sources disagree the
>   disagreement is stated rather than resolved by guesswork.
>
> `docs/openapi.json` is owned by the backend lane and is the machine-readable spec once it exists.
> When it disagrees with this page, **the code wins, then `openapi.json`, then this page.**

---

## Contents

- [Part A — What is served today](#part-a--what-is-served-today)
- [Part B — The v2 surface (in progress)](#part-b--the-v2-surface-in-progress)
  - [B1. Conventions](#b1-conventions)
  - [B2. Authentication](#b2-authentication)
  - [B3. Error envelope](#b3-error-envelope)
  - [B4. Error code reference](#b4-error-code-reference)
  - [B5. Rate limits](#b5-rate-limits)
  - [B6. Operational endpoints](#b6-operational-endpoints)
  - [B7. Node and status](#b7-node-and-status)
  - [B8. Agents](#b8-agents)
  - [B9. Memories](#b9-memories)
  - [B10. Semantic](#b10-semantic)
  - [B11. Reputation](#b11-reputation)
  - [B12. Jobs](#b12-jobs)
  - [B13. Simulation results](#b13-simulation-results)
- [Known route drift](#known-route-drift)

---

# Part A — What is served today

Source: `server.js`. This is the **v1** node. It imports `lib/encryption.js` and
`lib/semantic-sync.js`, loads `@xenova/transformers` (the deprecated package, not
`@huggingface/transformers`), and binds hand-written ABI fragments for the **pre-rewrite** contracts.

**It has no authentication, no rate limiting, no structured logging, no security headers, and a bare
`cors()` with no origin allowlist.** Do not expose it to a network.

| Method | Path                      | Auth | Response                                                                                                                                              |
| ------ | ------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/status`             | none | `{ agentAddress, isRegistered }`. Returns `{ agentAddress: "Loading...", isRegistered: false }` before chain init completes                           |
| `POST` | `/api/register`           | none | `{ success: true }` on success, `500 { success: false, error }` on failure. Calls `registerAgent("pubKey_sepolia")` — a hardcoded placeholder string  |
| `POST` | `/api/memory`             | none | `{ success, cid, embeddingLength, encrypted }`. Embeds, encrypts, pins, commits. **No error handling — an exception here leaves the request hanging** |
| `GET`  | `/api/memories`           | none | `[{ cid, timestamp }]` from Pinata's pin list. Returns `[]` on any failure                                                                            |
| `GET`  | `/api/simulation-results` | none | The contents of `simulation-results.json`, or `404 { error }`                                                                                         |
| `POST` | `/api/decrypt`            | none | `{ success, context }`, or `403 { success: false, error: "Decryption failed. Unauthorized." }`                                                        |
| `GET`  | `/*`                      | none | Static files from `public/`                                                                                                                           |

### Why Part A is not the documented API

Six defects, each of which Part B exists to fix:

1. **No auth anywhere.** `POST /api/memory` spends gas and pins to a paid service. Anyone who can
   reach the port can drain the wallet.
2. **`cors()` with no allowlist.** Any page the operator merely _visits_ can drive
   `POST /api/memory` from their browser.
3. **The 403 on `/api/decrypt` is an ownership oracle.** It cannot distinguish "not shared with you"
   from "forged ciphertext", so it leaks which payloads a key can open.
4. **The passphrase is the wallet private key.** `encryptMemory(context, process.env.PRIVATE_KEY)`
   means anyone who can decrypt a memory also holds signing authority. Fixed in v2 by the HKDF key
   separation in [PROTOCOL.md §6](./PROTOCOL.md#6-key-hierarchy-and-identity).
5. **The signature argument is a placeholder.** `commitMemory` is called with
   `ethers.encodeBytes32String("sig")`. The v1 contract declared `bytes signature` and never read it.
6. **No error middleware.** A failure falls through to Express's default handler, which returns an
   HTML stack trace; the browser then fails to `JSON.parse` it and reports a `SyntaxError` instead of
   the real problem.

---

# Part B — The v2 surface (in progress)

## B1. Conventions

| Aspect         | Rule                                                                                                                                                                                                            | Source                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Base path      | `/api/v1/...` for versioned routes                                                                                                                                                                              | backend lane                  |
| Legacy aliases | Unversioned `/api/...` paths, mounted only when `ENABLE_LEGACY_ROUTES=true` (default `false`)                                                                                                                   | `src/config/env.js`           |
| Content type   | `application/json`; errors may use `application/problem+json` (RFC 9457)                                                                                                                                        | `public/js/api.js`            |
| Body limit     | `BODY_LIMIT`, default `256kb`                                                                                                                                                                                   | `src/config/env.js`           |
| Correlation    | Every response carries `X-Request-Id`. An inbound `X-Request-Id` is honoured **only** when it matches a strict character class, because an unvalidated header echoed into a response is a header-injection sink | `src/middleware/requestId.js` |
| Idempotency    | `Idempotency-Key` on commit routes, retained for `IDEMPOTENCY_TTL_MS` (default 24 h). A replay with the same key and a different body is `409 idempotency_conflict`                                             | `src/errors.js`               |
| Async writes   | A route that spends gas may return `202` with a job id; poll `/api/v1/jobs/{id}`                                                                                                                                | `src/config/env.js` (`JOB_*`) |

### Client timeouts

`public/js/api.js` is the reference client and sets these deadlines. They are useful as service-level
expectations:

| Class     | Timeout | Applies to                                                      |
| --------- | ------- | --------------------------------------------------------------- |
| `probe`   | 8 s     | `/healthz`, `/readyz`                                           |
| `status`  | 10 s    | status                                                          |
| `default` | 15 s    | most reads                                                      |
| `list`    | 15 s    | paginated lists                                                 |
| `search`  | 20 s    | semantic search (runs an embedding)                             |
| `mutate`  | 30 s    | register, endorse, report                                       |
| `commit`  | 90 s    | `POST /memories` — embed, seal, pin, and a Sepolia confirmation |

The 90 s commit budget is not a pessimistic guess: this repository's own measurements record
end-to-end latencies up to 24.3 s (see [BENCHMARKS.md](./BENCHMARKS.md)).

### Client retry policy

3 attempts, 400 ms base, 5 s cap, honouring `Retry-After` but capping it at 10 s so the UI cannot
hang on a hostile value. Retriable statuses: `408, 425, 429, 500, 502, 503, 504`. Retries apply to
`GET` and explicitly idempotent requests only.

---

## B2. Authentication

Source: `src/middleware/auth.js`.

Two header forms are accepted, and **`X-API-Key` wins when both are present**. The scheme match on
`Authorization` is case-insensitive, because clients disagree about `Bearer` versus `bearer`.

```http
X-API-Key: <token>
Authorization: Bearer <token>
```

Comparison is constant-time (`timingSafeCompare`). A failure sets `WWW-Authenticate: Bearer` and
returns:

```json
{
  "error": {
    "code": "api_key_required",
    "message": "A valid API key is required for this action. Send it as X-API-Key or Authorization: Bearer <token>.",
    "details": null
  },
  "requestId": "01J…"
}
```

| Rule                                          | Effect                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `API_AUTH_TOKEN` unset, `NODE_ENV=production` | **The process refuses to boot.** See [CONFIGURATION.md §4.1](./CONFIGURATION.md#41-production-requires-a-token) |
| `API_AUTH_TOKEN` unset, `HOST=0.0.0.0`        | **The process refuses to boot.** §4.3                                                                           |
| `API_AUTH_TOKEN` unset, local development     | Write routes are reachable without a token; the middleware warns once                                           |
| Token shorter than 32 characters              | Rejected by the schema at boot                                                                                  |
| Token that is one repeated character          | Rejected by the schema at boot                                                                                  |
| `METRICS_TOKEN` set                           | `/metrics` additionally requires it (`requireMetricsToken`)                                                     |

`readOnlyGuard` rejects every mutating route with `403 read_only` when the node has no signer or no
RPC URL. That is a normal configuration, not an error — see
[CONFIGURATION.md §6](./CONFIGURATION.md#6-derived-configuration).

---

## B3. Error envelope

Source: `src/errors.js`. **Every** error leaving the process has this shape:

```json
{
  "error": {
    "code": "validation_error",
    "message": "context must be a string of 1..8000 characters",
    "details": { "field": "context" }
  },
  "requestId": "01J…"
}
```

The contract, stated in the module's own header:

- **`code` is stable and machine-readable.** Clients branch on it. A code is never reworded.
- **`message` is for humans** and may change at any time.
- **`details` is structured, non-secret context.** It never contains a received _value_ — a value may
  be a secret or a 256 KB blob.
- **`retriable`** says whether repeating the identical request could plausibly succeed. It is what
  the frontend's retry policy reads, and it is why 503 and 504 differ from 400.
- **`expose`** decides whether `message` and `details` reach the client. **5xx defaults to not
  exposed**: anything that is not an `AppError` by the time it reaches the handler is a bug, and is
  reported as an opaque 500 with the real cause logged but never sent.

---

## B4. Error code reference

### HTTP-level classes

| Class                     | Status | Code                                  | Retriable |
| ------------------------- | ------ | ------------------------------------- | --------- |
| `ValidationError`         | 400    | `validation_error` (or `bad_request`) | no        |
| `UnauthorizedError`       | 401    | `api_key_required`                    | no        |
| `ForbiddenError`          | 403    | `forbidden`                           | no        |
| `NotFoundError`           | 404    | `not_found`                           | no        |
| `ConflictError`           | 409    | `conflict`                            | no        |
| `RateLimitError`          | 429    | `rate_limited`                        | yes       |
| `UpstreamError`           | 502    | `upstream_error`                      | —         |
| `ServiceUnavailableError` | 503    | `service_unavailable`                 | yes       |
| `TimeoutError`            | 504    | `upstream_timeout`                    | yes       |
| `ConfigError`             | 500    | `invalid_configuration`               | no        |

### Domain-specific codes

| Code                     | Status | Meaning                                                                                         |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------------- |
| `memory_not_found`       | 404    | No ledger record for that CID                                                                   |
| `job_not_found`          | 404    | No job with that id, or it aged out past `JOB_TTL_MS`                                           |
| `simulation_missing`     | 404    | `simulation-results.json` absent. **A normal state on a fresh clone**                           |
| `idempotency_conflict`   | 409    | Same `Idempotency-Key`, different body                                                          |
| `payload_too_large`      | 413    | Body over `BODY_LIMIT`, or a payload over 1 MiB                                                 |
| `unsupported_media_type` | 415    | Not JSON                                                                                        |
| `not_ready`              | 503    | The node has not finished starting                                                              |
| `model_not_ready`        | 503    | The embedding model is still loading                                                            |
| `chain_unavailable`      | 503    | RPC unreachable                                                                                 |
| `contracts_incompatible` | 503    | **The deployed contracts' ABI does not match `src/abi/`.** See [DEPLOYMENT.md](./DEPLOYMENT.md) |
| `ipfs_unavailable`       | 503    | Pinata unreachable or no JWT configured                                                         |
| `read_only`              | 403    | No signer or no RPC; write routes disabled. Not retriable                                       |
| `insufficient_funds`     | —      | The signer cannot pay for gas                                                                   |
| `overloaded`             | 503    | `EMBED_QUEUE_MAX` or `TX_QUEUE_MAX` exceeded                                                    |
| `internal_error`         | 500    | Unclassified. Message and details are **not** exposed                                           |

### Protocol errors mapped to HTTP

`src/errors.js` carries an explicit mapping table from every `ProtocolError.code` in
`src/protocol/errors.js`. This is the whole table:

| Protocol code                                                                    | Status  | HTTP code                   | Exposed |
| -------------------------------------------------------------------------------- | ------- | --------------------------- | ------- |
| `CANONICALIZATION_FAILED`                                                        | 422     | `canonicalization_error`    | yes     |
| `SCHEMA_INVALID`                                                                 | 400     | `validation_error`          | yes     |
| `PAYLOAD_TOO_LARGE`                                                              | 413     | `payload_too_large`         | yes     |
| `PROTOCOL_VERSION`                                                               | 409     | `protocol_version`          | yes     |
| `CID_MISMATCH`                                                                   | **502** | `cid_mismatch`              | yes     |
| `SIGNATURE_INVALID`                                                              | 400     | `bad_signature`             | yes     |
| `DEADLINE_EXPIRED`                                                               | 400     | `deadline_expired`          | yes     |
| `TAG_VERIFY_FAILED`                                                              | 403     | `decryption_failed`         | yes     |
| `NO_ENVELOPE_FOR_RECIPIENT`                                                      | 403     | `no_envelope_for_recipient` | yes     |
| `AAD_MISMATCH`, `AAD_REQUIRED`, `AAD_COMPONENT_MISSING`, `AAD_COMPONENT_INVALID` | 422     | `aad_mismatch`              | yes     |
| `CIPHER_BLOCK_MALFORMED`                                                         | 400     | `cipher_block_malformed`    | yes     |
| `CIPHER_ALG_UNSUPPORTED`                                                         | 422     | `cipher_alg_unsupported`    | yes     |
| `RECIPIENT_ENTRY_MALFORMED`                                                      | 400     | `recipient_entry_malformed` | yes     |
| `WRAP_ALG_UNSUPPORTED`                                                           | 422     | `wrap_alg_unsupported`      | yes     |
| `DERIVATION_FAILED`                                                              | 500     | `key_derivation_failed`     | **no**  |
| `KEY_SEPARATION_VIOLATED`                                                        | 500     | `key_separation_violated`   | **no**  |
| `INVALID_CEK`                                                                    | 400     | `invalid_key_material`      | yes     |
| `INVALID_DID`                                                                    | 400     | `invalid_did`               | yes     |
| `INVALID_KEY_VERSION`                                                            | 400     | `invalid_key_version`       | yes     |
| `INVALID_PRIVATE_KEY`                                                            | 500     | `invalid_key_material`      | **no**  |
| `INVALID_PUBLIC_KEY`                                                             | 400     | `invalid_key_material`      | yes     |
| `INVALID_HEX`                                                                    | 400     | `validation_error`          | yes     |
| `DIMENSION_MISMATCH`, `INVALID_SIMILARITY`, `INVALID_SIMHASH_BITS`               | 422     | `embedding_mismatch`        | yes     |
| `INVALID_REPUTATION`                                                             | 422     | `invalid_reputation`        | yes     |
| `REMOVED_UNSAFE_API`, `REMOVED_UNSOUND_API`                                      | **410** | `endpoint_removed`          | yes     |

Two entries deserve comment:

- **`CID_MISMATCH` is 502, not 400.** The client did nothing wrong; the _pinning service_ returned a
  CID that does not address the bytes submitted. That is an upstream failure.
- **`NO_ENVELOPE_FOR_RECIPIENT` and `TAG_VERIFY_FAILED` are distinct codes at the same status.**
  Collapsing them, as v1's blanket 403 did, hands an attacker an ownership oracle. Keeping them
  distinct is a deliberate operator-facing signal; both are still 403 to the caller.

---

## B5. Rate limits

Four independent buckets, all keyed per IP over `RATE_LIMIT_WINDOW_MS` (default 60 s):

| Bucket  | Variable                 | Default | Applies to                              |
| ------- | ------------------------ | ------- | --------------------------------------- |
| Read    | `RATE_LIMIT_MAX`         | 60      | Everything not below                    |
| Write   | `WRITE_RATE_LIMIT_MAX`   | 10      | Routes that spend gas                   |
| Search  | `SEARCH_RATE_LIMIT_MAX`  | 20      | Semantic routes, which run an embedding |
| Decrypt | `DECRYPT_RATE_LIMIT_MAX` | 5       | The decrypt route                       |

Exceeding a bucket returns `429 rate_limited` with a `Retry-After` header.

> **Set `TRUST_PROXY` correctly behind a reverse proxy**, or every request keys on the proxy's IP and
> the limiter protects nothing.

---

## B6. Operational endpoints

### `GET /healthz`

**Liveness.** Never touches the chain, IPFS or the model. Auth: none.

- `200` — the process is up.

This is the path the Docker `HEALTHCHECK` probes (`HEALTHCHECK_PATH`, default `/healthz`), with a
180 s `start-period` because the first boot may download the model.

### `GET /readyz`

**Readiness.** Auth: none.

```json
{
  "ready": true,
  "checks": {
    "model": { "loaded": true, "provider": "local", "model": "Xenova/all-MiniLM-L6-v2" },
    "chain": { "reachable": true, "chainId": 11155111, "contractsCompatible": false },
    "ipfs": { "enabled": true },
    "signer": { "configured": true, "readOnly": false }
  }
}
```

- `200` when ready; `503 not_ready` / `model_not_ready` / `chain_unavailable` otherwise.
- **`contractsCompatible: false` is the expected value today**, because `contract-addresses.json`
  points at pre-rewrite v1 contracts. The node stays in a _degraded_ state — read routes and the
  dashboard keep working — rather than crashing. The check inputs come from `src/abi/`:
  `EXPECTED_TYPEHASHES`, `DEPLOYED_BYTECODE_HASHES`, `DEPLOYED_BYTECODE_SIZES` and
  `SUPPORTS_EIP712`.

Point orchestrator readiness probes here and leave liveness on `/healthz`.

### `GET /metrics`

Prometheus exposition, `text/plain`. Served only when `METRICS_ENABLED=true` (default). Requires
`METRICS_TOKEN` when one is configured. Provided by `prom-client`.

---

## B7. Node and status

### `GET /api/v1/status`

Auth: none. The dashboard's `ENDPOINTS.status`.

```json
{
  "app": {
    "name": "neuromesh-protocol",
    "version": "2.0.0",
    "commit": "c7e3cfb",
    "nodeVersion": "v22.13.1"
  },
  "agent": {
    "address": "0x…",
    "did": "did:pkh:eip155:11155111:0x…",
    "registered": true,
    "keyVersion": 1
  },
  "chain": {
    "chainId": 11155111,
    "reachable": true,
    "contractsCompatible": false,
    "addresses": {
      "AgentIdentity": "0x…",
      "MemoryLedger": "0x…",
      "ReputationManager": "0x…",
      "MemoryAccessControl": null
    },
    "addressesSource": "./contract-addresses.json"
  },
  "protocol": {
    "version": "neuromesh/2.0.0",
    "specHash": "0x6ac1c0…",
    "projectionId": "neuromesh-proj/v1/achlioptas-s3/aes-256-ctr/384-384/d9fab4b5"
  },
  "features": { "write": true, "search": true, "metrics": true, "legacyRoutes": false },
  "signer": { "configured": true, "readOnly": false }
}
```

**No secret ever appears here.** `publicConfig()` asserts that none of the values named in
`SECRET_KEYS` occurs in its own JSON output.

---

## B8. Agents

### `GET /api/v1/agents/{address}`

Auth: none. Reads `AgentIdentity.getAgent` and `ReputationManager`.

| Status                  | Meaning                                     |
| ----------------------- | ------------------------------------------- |
| `200`                   | Record returned                             |
| `400 validation_error`  | Not a valid EVM address                     |
| `404 not_found`         | Never registered (`NotRegistered` on chain) |
| `503 chain_unavailable` | RPC unreachable                             |

```json
{
  "address": "0x…",
  "did": "did:pkh:eip155:11155111:0x…",
  "registeredAt": 1735689600,
  "statusChangedAt": 1735689600,
  "keyVersion": 1,
  "active": true,
  "publicKey": "0x02…",
  "metadataURI": "",
  "reputation": {
    "scoreWad": "631498571732822469",
    "bps": 6314,
    "isTrusted": true,
    "endorserCount": 3,
    "reporterCount": 0,
    "positiveMassWad": "…",
    "negativeMassWad": "…",
    "lastSettledAt": 1735689600
  }
}
```

> **Units changed in v2.** `globalReputation` used to be an unbounded integer scaled by 1000 with a
> hardcoded threshold of 500. It is now a **WAD ratio bounded in `[0, 1)`**, with `isTrusted` at
> `>= 0.6e18`. `IReputationManager` marks the old name deprecated with an explicit
> "UNITS CHANGED" note. Any client comparing against 500 is now wrong.

### `POST /api/v1/agents/register`

Auth: **required**. Rate bucket: write. Registers this node's DID on `AgentIdentity`.

Request:

```json
{ "metadataURI": "" }
```

The **encryption public key is not accepted from the request body.** It is derived from the node's
own wallet key by HKDF (`keys.deriveEncryptionKey`) at `ENCRYPTION_KEY_VERSION`, so a caller cannot
register a key the node does not hold.

| Status                       | Meaning                                  |
| ---------------------------- | ---------------------------------------- |
| `201` / `202`                | Registered, or accepted with a job id    |
| `401 api_key_required`       | Missing or wrong token                   |
| `403 read_only`              | No signer or no RPC                      |
| `409 conflict`               | Already registered (`AlreadyRegistered`) |
| `503 contracts_incompatible` | Deployed ABI mismatch                    |

---

## B9. Memories

### `POST /api/v1/memories`

Auth: **required**. Rate bucket: write. Accepts `Idempotency-Key`.

This is the full commit pipeline of [ARCHITECTURE.md §5](./ARCHITECTURE.md#5-data-flow-committing-a-memory):
embed → align → seal → wrap per recipient → canonicalise → local CID → pin → verify CID → sign
EIP-712 → commit → wait for `TX_CONFIRMATIONS`.

Request:

```json
{
  "context": "string, 1..MAX_CONTEXT_CHARS (default 8000)",
  "prevCid": "b… or null",
  "recipients": ["0x…"],
  "policy": {
    "embeddingVisibility": "grantees",
    "redistribution": "forbidden",
    "retentionUntil": 0
  }
}
```

Response `201`:

```json
{
  "cid": "b…",
  "cidHash": "0x…",
  "cidDigest": "0x…",
  "payloadHash": "0x…",
  "contentId": "0x…",
  "model": { "id": "0x…", "uri": "…", "dim": 384 },
  "alignment": { "projectionId": "neuromesh-proj/v1/…/384-384/d9fab4b5", "dim": 384 },
  "isEncrypted": true,
  "txHash": "0x…",
  "blockNumber": 1234567,
  "explorerUrl": "https://sepolia.etherscan.io/tx/0x…"
}
```

Response `202` (async): `{ "jobId": "…", "status": "pending" }` — poll `/api/v1/jobs/{id}`.

| Status | Code                                                                        | Cause                                                                                  |
| ------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `400`  | `validation_error`                                                          | Body failed the zod schema                                                             |
| `401`  | `api_key_required`                                                          | —                                                                                      |
| `403`  | `read_only`                                                                 | No signer or no RPC                                                                    |
| `409`  | `conflict`                                                                  | `MemoryAlreadyExists` — **this CID is already owned, possibly by a squatter (SEC-01)** |
| `409`  | `idempotency_conflict`                                                      | Same key, different body                                                               |
| `413`  | `payload_too_large`                                                         | Body over `BODY_LIMIT`, or canonical payload over 1 MiB                                |
| `422`  | `embedding_mismatch`                                                        | Dimension error during alignment                                                       |
| `429`  | `rate_limited`                                                              | Write bucket exhausted                                                                 |
| `502`  | `cid_mismatch`                                                              | **Pinata returned a CID that does not address the submitted bytes**                    |
| `503`  | `ipfs_unavailable` / `chain_unavailable` / `model_not_ready` / `overloaded` | Dependency down or queue full                                                          |
| `504`  | `upstream_timeout`                                                          | `IPFS_TIMEOUT_MS` or `TX_TIMEOUT_MS` exceeded                                          |

### `GET /api/v1/memories`

Auth: none. Rate bucket: read. Query: `limit` (1–100, per `Limits.MAX_PAGE_SIZE`), `cursor`.

```json
{
  "items": [
    {
      "cid": "b…",
      "cidHash": "0x…",
      "owner": "0x…",
      "committedAt": 1735689600,
      "version": 1,
      "prevCidHash": "0x00…",
      "model": "Xenova/all-MiniLM-L6-v2",
      "embeddingDim": 384,
      "isEncrypted": true,
      "revoked": false
    }
  ],
  "nextCursor": null,
  "total": 42
}
```

### `GET /api/v1/memories/{cid}`

Auth: none. Returns the on-chain record plus, when available, the payload's public metadata. Never
returns plaintext and never returns key material.

| Status | Code                                                                |
| ------ | ------------------------------------------------------------------- |
| `200`  | —                                                                   |
| `404`  | `memory_not_found`                                                  |
| `502`  | `cid_mismatch` — the fetched bytes do not hash to the requested CID |
| `503`  | `chain_unavailable`                                                 |

### `POST /api/v1/memories/{cid}/decrypt`

Auth: **required**. Rate bucket: **decrypt** (default 5 per minute — the tightest bucket in the
system).

Decrypts a payload for which this node holds a recipient key. It fetches the bytes, verifies the CID,
locates the recipient entry, unwraps the CEK, reconstructs the AAD from the payload's own fields, and
opens the block.

| Status | Code                        | Meaning                                                                                    |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------ |
| `200`  | —                           | `{ "context": "…", "embeddingVerified": true }`                                            |
| `403`  | `no_envelope_for_recipient` | **This memory was never shared with this node**                                            |
| `403`  | `decryption_failed`         | `TAG_VERIFY_FAILED` — wrong key, tampering, or a block copied from another agent's payload |
| `404`  | `memory_not_found`          | —                                                                                          |
| `422`  | `aad_mismatch`              | AAD could not be reconstructed                                                             |
| `429`  | `rate_limited`              | —                                                                                          |

The two 403 codes are deliberately distinct. See [B4](#b4-error-code-reference).

---

## B10. Semantic

### `POST /api/v1/semantic/search`

Auth: none. Rate bucket: search.

```json
{ "query": "string", "topK": 5, "minTrust": 0, "ranking": "trust" }
```

`ranking: "trust"` calls `similarity.rankMemories` (cosine × trust × recency);
`ranking: "similarity"` calls `similarity.semanticSearch` (pure cosine). See
[PROTOCOL.md §10.2](./PROTOCOL.md#102-off-chain-retrieval-ranking--presentational-floating-point).

Response:

```json
{
  "projectionId": "neuromesh-proj/v1/achlioptas-s3/aes-256-ctr/384-384/d9fab4b5",
  "noiseBaseline": 0.051031036307982884,
  "results": [{ "cid": "b…", "similarity": 0.7412, "score": 0.6103 }],
  "skipped": [{ "cid": "b…", "reason": "projection_mismatch: candidate is …, query is …" }]
}
```

**`noiseBaseline` and `skipped` are part of the contract, not debug output.** `noiseBaseline` is
`1/sqrt(dim)` — the standard deviation of the cosine between two _unrelated_ unit vectors in this
space. A similarity below roughly three times that value is indistinguishable from noise and must not
be presented as a semantic match. `skipped` makes every filtered candidate and the reason visible,
so a projection mismatch surfaces rather than being silently absorbed.

### `GET /api/v1/semantic/similarity`

Auth: none. Returns pairwise cosine similarities across indexed memories, **each annotated with its
`projectionId`**, and the `noiseBaseline` for the space.

> **A cross-model cell in this response is reproducible, not meaningful.** The deterministic
> Achlioptas projection makes the numbers stable across runs and nodes; it does not align two
> independently trained encoders. Read every value against `noiseBaseline` before believing it. See
> [PROTOCOL.md §7.2](./PROTOCOL.md#72-what-the-replacement-guarantees-and-what-it-does-not).

---

## B11. Reputation

### `GET /api/v1/reputation`

Auth: none. Scores plus the on-chain trust-event feed
(`ReputationManager.getTrustEvents`, newest first, bounded by the ring capacity).

```json
{
  "threshold": { "wad": "600000000000000000", "bps": 6000 },
  "parameters": {
    "halfLifeSeconds": 7776000,
    "priorWad": "3000000000000000000",
    "negativeMultiplierWad": "3000000000000000000",
    "baseEndorserWeightWad": "250000000000000000",
    "maxEndorserWeightWad": "1000000000000000000",
    "endorsementStakeWei": "0",
    "stakeLockPeriod": 604800
  },
  "events": [
    {
      "from": "0x…",
      "to": "0x…",
      "kind": "Endorse",
      "weightWad": "…",
      "timestamp": 1735689600,
      "reasonHash": "0x…"
    }
  ],
  "total": 17
}
```

`kind` is one of `None`, `Endorse`, `RevokeEndorse`, `Report`, `WithdrawReport`, `Slash`. Only
`reasonHash` is stored on chain; the plaintext reason lives in the event log.

### `POST /api/v1/reputation/endorse` · `POST /api/v1/reputation/report`

Auth: **required**. Rate bucket: write.

```json
{ "target": "0x…", "reason": "string, 1..MAX_REASON_CHARS" }
```

`MAX_REASON_CHARS` defaults to 200, but the contract caps the on-chain value at 128 **bytes**
(`Limits.MAX_REASON_BYTES`), so a longer reason reverts `StringTooLong`.

| Status | Code                                           | Cause                                                                                |
| ------ | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `400`  | `validation_error`                             | Bad address or reason                                                                |
| `403`  | `forbidden`                                    | `SelfAction` — an agent cannot endorse or report itself                              |
| `409`  | `conflict`                                     | `AlreadyEndorsed` / `AlreadyReported`                                                |
| `429`  | `rate_limited`                                 | HTTP bucket, **or** the on-chain `CooldownActive` (per-pair 1 day, per-actor 1 hour) |
| `503`  | `chain_unavailable` / `contracts_incompatible` | —                                                                                    |

> **Read [SECURITY-NOTES.md](./SECURITY-NOTES.md) before relying on these.** `reportAgent` is free,
> unstaked and permanent, and one throwaway identity can permanently destroy any agent's
> `isTrusted` status (SEC-03). Endorsement stake is unslashable (SEC-02). The documented sybil bar
> of 18 endorsers is wrong; the measured bound is 8 (SEC-06). `ReputationManager` has **no**
> meta-transaction entrypoint, so these calls always cost the caller gas.

---

## B12. Jobs

### `GET /api/v1/jobs/{id}`

Auth: none (an id is unguessable). Rate bucket: read.

```json
{
  "id": "…",
  "status": "pending|running|succeeded|failed",
  "createdAt": 1735689600,
  "updatedAt": 1735689612,
  "result": { "cid": "b…", "txHash": "0x…" },
  "error": null
}
```

Records are retained for `JOB_TTL_MS` (default 1 h), bounded by `JOB_MAX` (default 500). After that,
`404 job_not_found`.

---

## B13. Simulation results

### `GET /api/v1/simulation-results`

Auth: none. Serves `SIMULATION_RESULTS_PATH` (default `./simulation-results.json`).

`404 simulation_missing` is a **normal state on a fresh clone**, not an error — the dashboard renders
an empty state and says so. See [BENCHMARKS.md](./BENCHMARKS.md) for what the file contains and how
much weight it can carry.

---

## Known route drift

Three sources describe the v2 surface and they do not agree. All three differences are real and
unresolved at the time of writing.

| #   | Disagreement                          | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Path versioning**                   | The backend lane's route list uses `/api/v1/...`. `public/js/api.js` — the shipped dashboard — is written against **unversioned** `/api/status`, `/api/agents/{address}`, `/api/memories`, `/api/semantic/search`, `/api/reputation/endorse` and so on, with `API_BASE = ''`. Meanwhile `ENABLE_LEGACY_ROUTES` defaults to **`false`**. If the node mounts only `/api/v1/...`, **the dashboard 404s on every call** unless legacy aliases are enabled. This must be settled before release: either the dashboard moves to `/api/v1`, or the unversioned paths are mounted unconditionally rather than behind the legacy flag. |
| 2   | **Missing from the dashboard's list** | `public/js/api.js` has no entry for `/memories/{cid}/decrypt` or `/jobs/{id}`, so either the dashboard cannot use them or its endpoint table is incomplete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3   | **Naming**                            | The backend list has `/api/v1/agents/register`; the dashboard calls it `register()` at `/api/agents/register`. Same route, different prefix — a consequence of item 1.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**How to resolve any doubt:** read `src/http/` once it exists, then `docs/openapi.json`, then this
page. Do not resolve it from this page alone.

---

## See also

- [ARCHITECTURE.md](./ARCHITECTURE.md) — the request lifecycle and the middleware chain
- [CONFIGURATION.md](./CONFIGURATION.md) — every variable named above
- [PROTOCOL.md](./PROTOCOL.md) — payload shapes, envelope encryption, EIP-712, ranking
- [SECURITY-NOTES.md](./SECURITY-NOTES.md) — the contract findings behind the warnings on write routes
