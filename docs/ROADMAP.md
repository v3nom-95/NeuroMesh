# Roadmap

> **How to read this page.** Every item carries a status, and the statuses mean exactly what they
> say:
>
> | Status          | Meaning                                              |
> | --------------- | ---------------------------------------------------- |
> | **Done**        | Implemented, in the tree, and verifiable today       |
> | **In progress** | Partially in the tree; some files exist, some do not |
> | **Planned**     | Not implemented. No code exists                      |
> | **Research**    | Not designed. It may turn out to be a bad idea       |
> | **Blocked**     | Cannot start until a named decision is made          |
>
> Nothing on this page is described in the present tense unless it is **Done**. Dates are absent
> deliberately — this is a research prototype with no release commitments.

---

## Contents

- [1. Where things stand](#1-where-things-stand)
- [2. v2.0.x — finish the backend](#2-v20x--finish-the-backend)
- [3. v2.1 — contract hardening](#3-v21--contract-hardening)
- [4. v2.2 — verifiable retrieval](#4-v22--verifiable-retrieval)
- [5. v2.3 — real cross-model alignment](#5-v23--real-cross-model-alignment)
- [6. v3.0 — federation and persistence](#6-v30--federation-and-persistence)
- [7. Research track](#7-research-track)
- [8. Not scheduled](#8-not-scheduled)
- [9. Explicit non-goals](#9-explicit-non-goals)
- [10. Open decisions](#10-open-decisions)

---

## 1. Where things stand

### Done

| Item                                                                                          | Evidence                           |
| --------------------------------------------------------------------------------------------- | ---------------------------------- |
| Ten-module protocol core with no HTTP, chain or filesystem dependency                         | `src/protocol/`                    |
| Canonical v2 payload: RFC 8785 profile, strict zod schema, local CIDv1                        | `canonical.js`, `payload.js`       |
| Envelope encryption: per-memory CEK, AAD binding, ECIES per-recipient wrap                    | `envelope.js`                      |
| Key separation: HKDF-derived encryption keypair, one-way from the wallet key                  | `keys.js`                          |
| Deterministic, seeded, versioned projection, with `noiseBaseline` as a first-class export     | `projection.js`                    |
| Trust-weighted retrieval ranking, with a hard projection-equality filter                      | `similarity.js`                    |
| Four v2 contracts on OpenZeppelin v5: AccessControl, Pausable, EIP-712, Nonces, custom errors | `contracts/`                       |
| **223 Hardhat tests passing**, including fuzz invariants and a gas snapshot                   | `test/contracts/`                  |
| 7 protocol test suites under `node:test`                                                      | `test/backend/protocol/`           |
| Boot-time environment validation with cross-field safety rules                                | `src/config/env.js`                |
| HTTP error taxonomy with a full protocol-error mapping table                                  | `src/errors.js`                    |
| Auth, request-id, validation and async-handler middleware                                     | `src/middleware/`                  |
| Generated ABIs with typehash and bytecode fingerprints; no hand-written fragments             | `src/abi/`, `scripts/gen-abi.js`   |
| CI: lint, typecheck, contracts, backend matrix, audit, Docker, hermeticity assertions         | `.github/workflows/`               |
| Hardened container: non-root, tini, read-only, payload allowlist, build-context secret scan   | `Dockerfile`, `docker-compose.yml` |
| Production `npm audit` at **0 vulnerabilities**                                               | `package.json` overrides           |
| Vanilla ES-module dashboard, five views, no bundler, no runtime dependencies                  | `public/`                          |

### Not done, and honest about it

| Gap                                                                                                        | Where it is tracked                      |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `src/http/`, `src/services/`, `src/adapters/` do not exist; `npm start` runs the **legacy v1 `server.js`** | [§2](#2-v20x--finish-the-backend)        |
| **14 open contract findings**, one critical                                                                | [§3](#3-v21--contract-hardening)         |
| `scripts/deploy.js` is stale and fails against the v2 constructors                                         | [§2](#2-v20x--finish-the-backend)        |
| `scripts/verify.js` is referenced by `npm run verify` and does not exist                                   | [§2](#2-v20x--finish-the-backend)        |
| No committed benchmark harness — `npm run benchmark` aliases the legacy simulation                         | [§2](#2-v20x--finish-the-backend)        |
| No cross-model alignment; the projection is reproducible, not meaningful                                   | [§5](#5-v23--real-cross-model-alignment) |
| No retrieval-quality evaluation of any kind                                                                | [§4](#4-v22--verifiable-retrieval)       |
| No persistent index, no federation                                                                         | [§6](#6-v30--federation-and-persistence) |
| No zero-knowledge anything                                                                                 | [§7](#7-research-track)                  |

---

## 2. v2.0.x — finish the backend

**Goal: the documented API is the API that runs.** Until this ships, `npm start` runs a v1 server
with no auth, no rate limiting and an AES passphrase that is the wallet private key.

| #    | Item                                                                                                                  | Status          |
| ---- | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| 2.1  | `src/http/` — Express 5 app, middleware chain, routers                                                                | **In progress** |
| 2.2  | `src/services/` — memory, identity, reputation, search                                                                | **In progress** |
| 2.3  | `src/adapters/` — embedder, IPFS, chain                                                                               | **In progress** |
| 2.4  | Retire `server.js`, `lib/encryption.js`, `lib/semantic-sync.js`                                                       | **Planned**     |
| 2.5  | `docs/openapi.json` generated from the zod schemas                                                                    | **In progress** |
| 2.6  | **Resolve the route-versioning conflict** — see [§10](#10-open-decisions)                                             | **Blocked**     |
| 2.7  | Fix `scripts/deploy.js` for the v2 constructors, including `MemoryAccessControl`                                      | **Planned**     |
| 2.8  | Write `scripts/verify.js`, or repoint `npm run verify` at `hardhat verify`                                            | **Planned**     |
| 2.9  | Add an `etherscan` block to `hardhat.config.js`                                                                       | **Planned**     |
| 2.10 | **`scripts/benchmark.js`** — a real harness producing `n`/mean/p50/p95/min/max/stddev, so `bench.json` is regenerable | **Planned**     |
| 2.11 | Record CPU model and core count in the benchmark environment block                                                    | **Planned**     |
| 2.12 | Re-measure the projection against the shipped AES-CTR keystream (`bench.json` records the older xorshift variant)     | **Planned**     |
| 2.13 | Reconcile `.env.example` with `src/config/env.js` — see [CONFIGURATION.md §7](./CONFIGURATION.md#7-known-drift)       | **Planned**     |
| 2.14 | Backend integration tests over the finished routes with `supertest`                                                   | **Planned**     |
| 2.15 | CI doc-drift check: fail if a path named in the README or docs does not exist                                         | **Planned**     |
| 2.16 | Capture a real dashboard screenshot from a running instance                                                           | **Planned**     |

**Exit criteria.** `npm start` serves the surface in [API.md Part B](./API.md#part-b--the-v2-surface-in-progress);
the dashboard works end to end against it; `lib/` is gone; `npm run ci` is green.

---

## 3. v2.1 — contract hardening

**Goal: close the 14 open findings.** Full detail, with reproductions and planned fixes, is in
[SECURITY-NOTES.md](./SECURITY-NOTES.md); the execution plan is in
[V2.1-HARDENING-PLAN.md](./V2.1-HARDENING-PLAN.md).

**Why it is deferred, not ignored.** Five of these fixes change ABI-visible signatures, so they must
land as **one** contract release and redeploy rather than racing the backend that transcribes them.

### Order of work

| Order | Findings                                                                                                      | Status                                      | Why this order                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------- |
| 1     | SEC-11, SEC-12, SEC-13 — EIP-712 conformance, binding fields, signed evidence edges                           | **Blocked** on [§10 D1](#10-open-decisions) | Everything else is rework if the typehashes change                    |
| 2     | **SEC-01 — CID front-running** (critical)                                                                     | Planned                                     | Ownership integrity. `precommit(blindedHash)` + `MIN_PRECOMMIT_DELAY` |
| 3     | SEC-02, SEC-03, SEC-04 — stake slashability, report staking and slashing, decay residual carry                | Planned                                     | Reputation economics; interlocking, must land together                |
| 4     | SEC-07, SEC-08, SEC-09, SEC-10 — self-reinstatement, pause/stake exit, expired re-grant, treasury destination | Planned                                     | Independent and parallelisable                                        |
| 5     | SEC-06 — outgoing-row normalisation, or a damped transitive term                                              | Planned                                     | A trust-model change, not a patch. Largest and least urgent           |
| 6     | SEC-05, SEC-14 — DecayMath NatSpec truth-up, unreachable errors                                               | Planned                                     | Documentation and dead ABI surface                                    |
| 7     | Regenerate ABIs, re-verify the backend, second adversarial review                                             | Planned                                     | —                                                                     |

### Release gate

- [ ] Every finding fixed, or explicitly accepted with written rationale
- [ ] A regression test per finding, named after its ID
- [ ] `npx hardhat compile` clean, zero warnings
- [ ] `npx hardhat test` all green — currently **223**, expect ~250+ after regressions
- [ ] `npx solhint "contracts/**/*.sol"` zero errors
- [ ] ABIs regenerated, backend re-verified, `npm run ci` green
- [ ] A second adversarial review returns no new critical or high findings
- [ ] `docs/PROTOCOL.md`, `docs/SECURITY-NOTES.md` and the README claim tables updated

### Deployment consequence

The Sepolia addresses in `contract-addresses.json` are **pre-rewrite v1 contracts** whose ABI does
not match the v2 suite. v2.1 must:

1. Deploy all four contracts in dependency order — see
   [DEPLOYMENT.md §6](./DEPLOYMENT.md#6-contract-deployment-to-sepolia).
2. Write `deployments/11155111.json`.
3. Verify on Etherscan.
4. Move the three v1 addresses to a legacy section.
5. Hand `DEFAULT_ADMIN_ROLE` to a multisig behind a timelock and have the deployer renounce.

---

## 4. v2.2 — verifiable retrieval

**Goal: make the claims about retrieval measurable, and make the third-party verification procedure
fully executable.**

| #   | Item                                                                                                                                         | Status                                | Notes                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 4.1 | **A labelled retrieval corpus and an evaluation harness** — recall@k, MRR, nDCG                                                              | **Planned**                           | Nobody has demonstrated that trust weighting improves retrieval. This is the gap that most needs closing |
| 4.2 | Ablation: pure cosine vs trust-weighted vs trust-and-recency, on the same corpus                                                             | **Planned**                           | Turns `RANK_THETA` and `RANK_PHI` from guesses into measurements                                         |
| 4.3 | Persistent local vector index at `SEMANTIC_INDEX_PATH`                                                                                       | **Planned**                           | The variables exist; the index does not                                                                  |
| 4.4 | Approximate nearest neighbours above a few thousand vectors                                                                                  | **Planned**                           | Brute-force cosine is fine at 10k, not at 10M                                                            |
| 4.5 | Publish `projectionMatrixDigest` in the status route and cross-check it between nodes                                                        | **Planned**                           | Two nodes disagreeing on the digest are exchanging noise                                                 |
| 4.6 | A standalone verifier package implementing [PROTOCOL.md §9](./PROTOCOL.md#9-third-party-verification-procedure) with no NeuroMesh dependency | **Planned**                           | The strongest possible proof that the spec is complete                                                   |
| 4.7 | Unblock verification steps 9, 14 and 15                                                                                                      | **Blocked** on SEC-11, SEC-12, SEC-13 | The chain has to record the binding fields first                                                         |

---

## 5. v2.3 — real cross-model alignment

**Goal: make a cross-model similarity number mean something.**

Today the projection is _deterministic and versioned_, which buys reproducibility. It does **not**
align two independently trained encoders — Johnson–Lindenstrauss is a within-space guarantee. Every
cross-model cosine must currently be read against `noiseBaseline = 1/sqrt(384) = 0.051`.

| #   | Item                                                                                                      | Status                |
| --- | --------------------------------------------------------------------------------------------------------- | --------------------- |
| 5.1 | Anchor-set format and a published anchor corpus (`ANCHOR_SET_PATH` exists; no format does)                | **Planned**           |
| 5.2 | Relative representations (Moschella et al., ICLR 2023) as the alignment primitive                         | **Planned**           |
| 5.3 | Orthogonal Procrustes / CCA fitted on a paired corpus, as a baseline to beat                              | **Planned**           |
| 5.4 | Alignment-bundle format, versioned and content-addressed (`ALIGNMENT_BUNDLE_PATH` exists; no format does) | **Planned**           |
| 5.5 | `alignmentId` recorded on chain so a verifier can check which bundle produced a vector                    | **Blocked** on SEC-12 |
| 5.6 | A measured cross-model retrieval benchmark, reported against the noise baseline                           | **Planned**           |
| 5.7 | Model-weights digest pinned on chain, so `model` is a version rather than a name                          | **Blocked** on SEC-12 |

**Acceptance:** a cross-model retrieval benchmark that beats the noise baseline by a stated margin
with a stated confidence interval. **Until that exists, no cross-model similarity claim is made
anywhere in this documentation set**, and the historical similarity matrix stays unpublished — it fit
the pure-noise null at p = 0.70.

---

## 6. v3.0 — federation and persistence

**Goal: more than one node.**

| #   | Item                                                                           | Status                                                                                            |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| 6.1 | Node discovery and a peer registry                                             | **Planned**                                                                                       |
| 6.2 | Cross-node retrieval over SimHash candidates, so vectors need not be exchanged | **Planned**                                                                                       |
| 6.3 | Replicated pinning across several providers, plus re-pin logic                 | **Planned** — closes the availability half of [T-06](./THREAT_MODEL.md#t-06--ipfs-unavailability) |
| 6.4 | Chain-state verification: light client or state proofs                         | **Planned** — closes [T-07](./THREAT_MODEL.md#t-07--rpc-censorship-and-lying)                     |
| 6.5 | Automatic RPC failover and cross-checking across `RPC_URLS`                    | **Planned**                                                                                       |
| 6.6 | Reproducible off-chain reputation computation published as a Merkle root       | **Blocked** on SEC-13                                                                             |
| 6.7 | Backup and restore for the local index and key material                        | **Planned**                                                                                       |

---

## 7. Research track

Not designed. Each may turn out to be a bad idea, and saying so now is cheaper than saying so later.

| #   | Item                                                                                | Status       | The honest question                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 7.1 | Zero-knowledge proofs of memory properties without disclosure                       | **Research** | **No ZK exists in this repository today.** What property is worth proving, and is the prover cost survivable at commit time?                                                   |
| 7.2 | Private set intersection for retrieval                                              | **Research** | Can candidate selection avoid revealing the query at all?                                                                                                                      |
| 7.3 | Differential privacy on published embeddings                                        | **Research** | Sentence embeddings are substantially invertible. Can noise help without destroying retrieval?                                                                                 |
| 7.4 | Threshold decryption so no single key opens a memory                                | **Research** | —                                                                                                                                                                              |
| 7.5 | Economic security: staking, slashing, and an incentive layer that survives analysis | **Research** | The current stake mechanism is front-runnable ([SEC-02](./SECURITY-NOTES.md#sec-02--high--endorsement-stake-is-unslashable)) and defaults to zero. Fix that before adding more |
| 7.6 | Memory-poisoning detection beyond reputation                                        | **Research** | Reputation re-ranks; it never gates                                                                                                                                            |
| 7.7 | L2 or app-chain deployment to remove the 16 s commit latency                        | **Research** | 98.7% of end-to-end latency is IPFS plus chain confirmation                                                                                                                    |

---

## 8. Not scheduled

| Item                     | Why not                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| External security audit  | Required before any mainnet consideration. Not scheduled; the v2.1 findings must land first                |
| Mainnet or L2 deployment | **Explicitly out of scope** until an audit passes                                                          |
| A token                  | No incentive design exists, and none is planned                                                            |
| Managed hosting          | —                                                                                                          |
| SDKs beyond JavaScript   | The protocol spec is written to be reimplementable; a Python or Rust verifier is welcome as a contribution |

---

## 9. Explicit non-goals

Naming these prevents scope creep and prevents false expectations.

- **Not a zero-knowledge system.** Confidentiality by encryption is a different property.
- **Not a general-purpose data marketplace.** No pricing, no compute-to-data, no monetisation.
- **Not an agent runtime.** NeuroMesh persists what agents _learned_, not what they _do_.
- **Not a token or an incentive layer.**
- **Not a content-moderation system.** `MODERATOR_ROLE` tombstones a record; it cannot unpublish
  IPFS bytes.
- **Not sybil-proof.** The design is trust-graph-resistant at best, and the current parameters do not
  even achieve that ([SEC-06](./SECURITY-NOTES.md#sec-06--high--the-documented-sybil-bar-is-8-wallets-not-18)).
- **Not a database.** There is no query language, no transactions, no joins.

---

## 10. Open decisions

Each of these blocks work and needs an answer before the dependent items can start.

### D1 · EIP-712 conformance — blocks §3 order 1 and much of §4–§5

The deployed contracts use **three** per-contract domains with no `specHash`; an earlier normative
specification requires **one** domain, `("NeuroMesh","2")`, with `specHash` on every struct and
different field names.

| Option                                           | Consequence                                                                                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) Adopt the spec verbatim**                  | Every typehash changes; every existing signature stops verifying; `MemoryLedger` keys on `cidDigest` rather than on `keccak256(cid string)`. **Preferred** — no external client is deployed yet, and interoperability is the point |
| **(b) Amend the spec** to the implemented layout | Cheaper, but clients must generate signers from the deployed `*_TYPEHASH()` getters and `eip712Domain()` rather than from a document                                                                                               |

**Until this is decided, [PROTOCOL.md §8](./PROTOCOL.md#8-eip-712-typed-data) is the authority for
what is deployed.** See [SEC-11](./SECURITY-NOTES.md#sec-11--high--on-chain-eip-712-does-not-match-the-normative-spec).

### D2 · Route versioning — blocks §2.6

The backend route list uses `/api/v1/...`. The shipped dashboard (`public/js/api.js`) is written
against **unversioned** `/api/...` with `API_BASE = ''`. Meanwhile `ENABLE_LEGACY_ROUTES` defaults to
**`false`**.

If the node mounts only `/api/v1/...`, **the dashboard 404s on every call.** Either the dashboard
moves to `/api/v1`, or the unversioned paths are mounted unconditionally rather than behind the
legacy flag. See [API.md — Known route drift](./API.md#known-route-drift).

### D3 · Keep or delete `commitMemory`

SEC-01's fix can be commit–reveal (keeps the self-commit path, adds a `salt` parameter and a
precommit round-trip) or deletion (every commit carries an EIP-712 authorisation, which is simpler
but forces a signature round-trip for the common case). A third option — keying records by
`keccak256(abi.encode(agent, cidHash))` — is a cheaper partial mitigation that lets _block order_
rather than _transaction order_ decide priority.

### D4 · Sybil resistance versus usability

SEC-06's fix ranges from a NatSpec correction to full outgoing-row normalisation. Full normalisation
is a trust-model change with knock-on effects on every score. A cheaper option is a non-zero
`endorsementStakeWei` at deployment — which makes a ring cost capital rather than gas, but also makes
honest endorsement cost money.

### D5 · Reputation model authority

The contract implements `P/(P+N+prior)` with a 90-day half-life. The earlier specification mandates a
Beta/Jøsang local trust with row normalisation and damped EigenTrust computed off chain. These are
different models with different security properties. Either implement the spec, or **demote
`isTrusted` / `reputationOf` in NatSpec to "local heuristic, not the normative protocol score"** so
consumers stop treating it as one. See
[SEC-13](./SECURITY-NOTES.md#sec-13--medium--signed-evidence-edges-are-unimplemented).

---

## See also

- [V2.1-HARDENING-PLAN.md](./V2.1-HARDENING-PLAN.md) — the contract work in execution detail
- [SECURITY-NOTES.md](./SECURITY-NOTES.md) — the findings driving §3
- [THREAT_MODEL.md](./THREAT_MODEL.md) — the residual risks driving §4 and §6
- [BENCHMARKS.md](./BENCHMARKS.md) — the measurement gaps driving §2.10–2.12 and §4.1
- [ARCHITECTURE.md](./ARCHITECTURE.md) — what exists today
