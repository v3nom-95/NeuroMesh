# Threat Model

> **Bottom line up front.** NeuroMesh is an unaudited research prototype on a public testnet. Of the
> nine adversary classes below, **three are substantially mitigated, two are partially mitigated, and
> four are unmitigated today.** The single most severe unmitigated risk is that memory ownership is
> first-come-first-served, so anyone who observes a CID can permanently steal the record
> ([T-04](#t-04--cid-front-running)).
>
> This page states what an attacker can do, what stops them, and what does not. Where nothing stops
> them, it says so.

---

## Contents

- [1. Scope and assets](#1-scope-and-assets)
- [2. Trust assumptions](#2-trust-assumptions)
- [3. Adversary capabilities](#3-adversary-capabilities)
- [4. Summary matrix](#4-summary-matrix)
- [5. Threats in detail](#5-threats-in-detail)
- [6. What is out of scope](#6-what-is-out-of-scope)
- [7. Residual risk statement](#7-residual-risk-statement)

---

## 1. Scope and assets

### In scope

`contracts/`, `src/protocol/`, `src/config/`, `src/errors.js`, `src/middleware/`, `src/abi/`, the
HTTP surface, the container image, and the protocol's interaction with IPFS and Ethereum.

### Assets, in priority order

| #   | Asset                                                         | Compromise means                                                                                 |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A1  | **Agent signing key** (`PRIVATE_KEY`)                         | Total. It _is_ the identity, and every encryption key at every version is derivable from it      |
| A2  | **Memory plaintext**                                          | Confidentiality loss for that memory and every memory sharing its CEK — which is none, by design |
| A3  | **Memory ownership records**                                  | Provenance is falsified; the squatter controls access delegation                                 |
| A4  | **Content-encryption keys**                                   | Plaintext for one memory                                                                         |
| A5  | **Reputation state**                                          | Trust decisions are corrupted for anyone who reads `isTrusted`                                   |
| A6  | **Node operational secrets** (`API_AUTH_TOKEN`, `PINATA_JWT`) | Unauthorised writes; wallet drained via gas; pinning quota abused                                |
| A7  | **Availability**                                              | Memories cannot be committed or retrieved                                                        |
| A8  | **Metadata** (who committed what, when, to whom granted)      | Social graph and activity pattern disclosed. **Public by construction**                          |

---

## 2. Trust assumptions

Stated explicitly, because an unstated assumption is a vulnerability.

| #   | We assume                                                                            | If false                                                                                  |
| --- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| TA1 | secp256k1, keccak256, sha2-256, HKDF-SHA256 and AES-256-GCM are secure               | Everything fails                                                                          |
| TA2 | Node's `crypto.randomBytes` is a working CSPRNG                                      | CEKs and ephemeral keys become predictable                                                |
| TA3 | The Ethereum L1 achieves finality and is not reorganised past our confirmation depth | Commits can be reverted. `TX_CONFIRMATIONS=1` on a testnet is a weak assumption           |
| TA4 | The operator's machine is not compromised                                            | A1 falls, and everything with it                                                          |
| TA5 | An IPFS pinning service returns the bytes it was given                               | **We do not rely on this.** `verifyCid` checks locally                                    |
| TA6 | The RPC provider returns honest chain state                                          | **Not verified.** A malicious provider can lie about any read                             |
| TA7 | The published `AgentIdentity` public key belongs to the address                      | **Explicitly false.** The registry records a _self-assertion_ with no proof of possession |
| TA8 | Sybil identities are expensive                                                       | **False.** Registration is permissionless and free                                        |
| TA9 | `MemoryAccessControl` grants can be recalled                                         | **False for confidentiality.** A published envelope cannot be un-published                |

TA6, TA7, TA8 and TA9 are the load-bearing weaknesses. Each drives a threat below.

---

## 3. Adversary capabilities

| Class                           | Can                                                                                                  | Cannot                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Passive network observer**    | Read the chain, read IPFS, watch the mempool, correlate timing                                       | Forge signatures, decrypt                                          |
| **Registered agent**            | Everything above, plus commit, endorse, report, grant, revoke. **Free and permissionless to become** | Act as another address                                             |
| **Sybil operator**              | Control N registered agents at essentially zero marginal cost                                        | Forge another agent's signature                                    |
| **Front-runner / MEV searcher** | Observe the mempool and land a transaction first at a higher gas price                               | Alter another party's transaction contents                         |
| **Malicious RPC provider**      | Return false chain state, censor transactions, delay inclusion                                       | Forge signatures, produce blocks                                   |
| **Malicious pinning service**   | Refuse to pin, unpin, return wrong bytes, disclose the pin list                                      | Cause a wrong-bytes result to be accepted (blocked by `verifyCid`) |
| **Revoked grantee**             | Retain any key material it once held                                                                 | Obtain _new_ grants                                                |
| **Privileged role holder**      | Pause, moderate, suspend, slash, withdraw the treasury, change parameters                            | Forge an agent signature; rewrite ownership; unpublish IPFS bytes  |
| **Local attacker**              | Read process memory, heap snapshots, core dumps, disk                                                | —                                                                  |

---

## 4. Summary matrix

| ID                                             | Threat                          | Assets     | Mitigation status  | Severity     |
| ---------------------------------------------- | ------------------------------- | ---------- | ------------------ | ------------ |
| [T-01](#t-01--memory-poisoning)                | Memory poisoning                | A5, A7     | **Partial**        | Medium       |
| [T-02](#t-02--sybil-attack)                    | Sybil attack                    | A5         | **Weak**           | High         |
| [T-03](#t-03--replay-and-signature-attacks)    | Replay and signature attacks    | A1, A3     | **Strong**         | Low          |
| [T-04](#t-04--cid-front-running)               | **CID front-running**           | **A3**     | **NONE**           | **Critical** |
| [T-05](#t-05--key-compromise)                  | Key compromise                  | A1, A2, A4 | **Partial**        | High         |
| [T-06](#t-06--ipfs-unavailability)             | IPFS unavailability             | A7         | **Weak**           | Medium       |
| [T-07](#t-07--rpc-censorship-and-lying)        | RPC censorship and lying        | A3, A5, A7 | **NONE**           | Medium       |
| [T-08](#t-08--metadata-leakage)                | Metadata leakage                | A8, A2     | **NONE by design** | Medium       |
| [T-09](#t-09--node-and-operational-compromise) | Node and operational compromise | A1, A6     | **Strong**         | High         |

---

## 5. Threats in detail

### T-01 · Memory poisoning

**Adversary:** any registered agent. **Goal:** get false or harmful memories retrieved and acted on
by other agents.

**Attack.** Register (free). Commit memories whose embeddings sit near high-traffic queries but whose
content is wrong or adversarial. Optionally bootstrap reputation first (T-02) so the trust term
amplifies the poison rather than damping it.

| Mitigation                                                                                                                               | Strength                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `trustWeightedScore` multiplies cosine by `theta + (1−theta)·tau^phi`, so a zero-reputation agent's memories rank at 20% of their cosine | Partial                                                                                            |
| `rankMemories` supports a `tauMin` hard filter                                                                                           | **Off by default** (`TAU_MIN = 0`)                                                                 |
| Recency decay, `2^(−age/180d)`, ages out stale poison                                                                                    | Weak                                                                                               |
| `MODERATOR_ROLE` can tombstone a record via `moderatorRevokeMemory`                                                                      | Reactive only                                                                                      |
| Commits require `identity.isActive(agent)`, and `REGISTRAR_ROLE` can suspend                                                             | **Undermined by [SEC-07](./SECURITY-NOTES.md#sec-07--high--a-suspended-agent-can-self-reinstate)** |

**Residual risk — MEDIUM.**

- `theta = 0.2` is a **floor by design**. Reputation re-ranks; it never gates. An agent with zero
  reputation is always reachable.
- Suspension is unenforceable: a `REGISTRAR_ROLE` suspension is undone by the agent's next
  transaction ([SEC-07](./SECURITY-NOTES.md#sec-07--high--a-suspended-agent-can-self-reinstate)).
- Tombstoning removes the on-chain record, **not the IPFS bytes**. Anyone with the CID still fetches
  them.
- There is **no content validation of any kind**. The protocol has no notion of a memory being true.
- **No retrieval-quality evaluation exists** ([BENCHMARKS.md §6](./BENCHMARKS.md#6-what-is-deliberately-not-measured)),
  so nobody has demonstrated that trust weighting actually reduces poisoned retrievals.

---

### T-02 · Sybil attack

**Adversary:** sybil operator. **Goal:** manufacture `isTrusted`, or destroy someone else's.

**Attack A — manufacture trust.** Register N addresses, have them endorse each other to bootstrap
their own endorsement weights, then have all N endorse the target.

**Attack B — destroy trust.** Register one address and file one report.

| Mitigation                                                         | Reality                                      |
| ------------------------------------------------------------------ | -------------------------------------------- |
| Bayesian prior `priorWad = 3.0` requires `P >= 4.5` to cross `0.6` | Real, but see below                          |
| Fresh endorsers contribute only `base = 0.25`                      | **Only while their own reputation stays 0**  |
| Per-pair cooldown 1 day, per-actor cooldown 1 hour                 | Slows an attack to ~3 days; does not stop it |
| `endorsementStakeWei`                                              | **Defaults to `0`**                          |
| `require(target != msg.sender)`                                    | Prevents self-endorsement only               |

**Residual risk — HIGH.**

- **The documented sybil bar is wrong.** The contract header claims 18 distinct endorsers.
  `previewEndorsementWeight` reads the endorser's _live_ reputation and nothing normalises outgoing
  weight, so a clique bootstraps itself. **Measured bound: 8 mutually-endorsing wallets**, ~56–170
  transactions, zero stake, about 3 days
  ([SEC-06](./SECURITY-NOTES.md#sec-06--high--the-documented-sybil-bar-is-8-wallets-not-18)).
- **Attack B is catastrophically asymmetric.** Crossing the trust line costs 8 identities. Removing
  someone's costs **1 identity and 1 transaction**, is free, is permanent, and cannot be undone by
  any role. Time does not heal it: `_settle` applies the same factor to `P` and `N`, so the ratio is
  **decay-invariant** — three simulated years leave the victim at 0.00036
  ([SEC-03](./SECURITY-NOTES.md#sec-03--high--reports-are-free-unstaked-permanent-and-unremovable)).
  This is a working extortion primitive.
- **Decay is defeatable.** Anyone calling `settle(x)` more often than once per 5.625 days freezes
  that agent's masses forever — pinning a victim's negative mass, or a favourite's positive mass
  ([SEC-04](./SECURITY-NOTES.md#sec-04--high--decay-is-defeatable-by-frequent-settling)).
- **The stake mechanism provides no economic security even when enabled**, because an endorser
  front-runs the slasher with `revokeEndorsement` and recovers 100%
  ([SEC-02](./SECURITY-NOTES.md#sec-02--high--endorsement-stake-is-unslashable)).

**Do not treat `isTrusted` as a security boundary.** It is a re-ranking signal.

---

### T-03 · Replay and signature attacks

**Adversary:** any observer of a signed authorisation. **Goal:** replay it, or forge one.

| Attack                               | Mitigation                                                                                                                                             | Strength   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Replay on the same contract          | OpenZeppelin `Nonces`, per agent per contract                                                                                                          | **Strong** |
| Replay on another chain              | `chainId` in the EIP-712 domain                                                                                                                        | **Strong** |
| Replay on another deployment         | `verifyingContract` in the domain                                                                                                                      | **Strong** |
| Replay across contracts              | Three distinct domain names                                                                                                                            | **Strong** |
| Indefinite validity                  | `deadline`, plus `DeadlineTooFar` at `MAX_SIGNATURE_VALIDITY` = 30 days                                                                                | **Strong** |
| Signature malleability               | `assertCanonicalSignature` rejects high-`s` off chain; OpenZeppelin `ECDSA` rejects it on chain                                                        | **Strong** |
| Signed-data / stored-data divergence | The digest is computed from the very `input` struct written to storage                                                                                 | **Strong** |
| Ciphertext cut-and-paste             | The AAD binds `(version, specHash, agentDid, contentId, policyId, modelId, keyVersion)`. Lifting another agent's ciphertext yields `TAG_VERIFY_FAILED` | **Strong** |
| Key-wrap re-addressing               | The wrap AAD binds grantor, content, recipient address, key version and the ephemeral key                                                              | **Strong** |
| Smart-wallet signatures              | `SignatureChecker` handles ERC-1271; exercised by `contracts/mocks/ERC1271Wallet.sol`                                                                  | **Strong** |

**Residual risk — LOW.** This is the best-defended area of the system.

Two caveats. (1) **`ReputationManager` has no signed entrypoint at all** — `endorseAgent` and
`reportAgent` authorise from `msg.sender` only. There is nothing to replay, but also no relayer path
and no signed evidence ([SEC-13](./SECURITY-NOTES.md#sec-13--medium--signed-evidence-edges-are-unimplemented)).
(2) **A client written against the earlier normative EIP-712 spec produces signatures the contracts
reject 100% of the time** ([SEC-11](./SECURITY-NOTES.md#sec-11--high--on-chain-eip-712-does-not-match-the-normative-spec)).
That is an interoperability failure, not a forgery risk.

---

### T-04 · CID front-running

**Adversary:** any registered agent watching the mempool or a public pin list.
**Goal:** permanently own another agent's memory record.

> **This is the most severe unmitigated issue in the system.**

**Attack.**

```text
1. agentA pins a memory. The CID is public the instant it is pinned —
   Pinata's public gateway, the pin-list API, and agentA's own pending
   commitMemory transaction in the mempool all expose it.
2. agentB submits commitMemory with the same CID at a higher gas price.
3. agentB's transaction lands first.
4. agentA's commit reverts MemoryAlreadyExists. Forever.
```

| Mitigation                                                          | Reality                                                                                                                             |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `commitMemoryFor` takes ownership from the recovered EIP-712 signer | **Correct, but it is not the path the node uses**                                                                                   |
| `commitMemory`                                                      | Ownership from `msg.sender`; records keyed by the **global** `cidHash`                                                              |
| Recovery via revocation                                             | **Impossible.** `revokeMemory` is owner-only, and the tombstone never frees the `cidHash` — not even `MODERATOR_ROLE` can return it |
| Commit–reveal                                                       | **Not implemented**                                                                                                                 |

**Residual risk — CRITICAL, unmitigated.**

**Impact beyond the record itself.** `MemoryAccessControl._grant` reads ownership from the ledger, so
the squatter becomes the **only** party who can delegate decryption of that memory. The victim
retains the plaintext and the CEK but loses the provenance record and the ability to share it
on chain.

**What an operator can do today** — neither is enforced by the contract:

1. Use `commitMemoryFor` with a relayer instead of `commitMemory`.
2. Do not publish or expose the CID until the commit is confirmed. Note that this is hard: pinning
   _is_ publication.

Tracked as [SEC-01 / NM-01](./SECURITY-NOTES.md#sec-01--critical--cid-front-running-through-the-self-commit-path).
The planned fix is `precommit(blindedHash)` with a minimum delay.

---

### T-05 · Key compromise

Four distinct compromises, with very different blast radii — which is the point of the key hierarchy.

#### T-05a · Wallet signing key (A1)

**Total compromise.** The attacker controls the identity: commits, revocations, grants, endorsements,
reports, and the wallet's funds. Because encryption keys are HKDF-derived _from_ the wallet key,
**every encryption key at every version is also derivable**, so every memory the node ever sealed is
readable.

_Mitigation:_ none within the protocol. _Response:_ sweep the wallet, register a new agent, treat
every past memory as disclosed. Key rotation is **not** sufficient.

#### T-05b · Derived encryption key (A4)

**Bounded, and deliberately so.** HKDF-Expand is built on HMAC-SHA256, so recovering the wallet key
from a derived key is a preimage problem.

> **A leaked encryption key yields nothing about the signing key. A leaked signing key does yield the
> encryption key.** That asymmetry is the design, because the signing key is the identity and its
> compromise is already total.

_Response:_ bump `ENCRYPTION_KEY_VERSION`, restart, call `AgentIdentity.rotateKey`. Memories sealed
under the old version remain readable **only** with the old key — rotation is not re-encryption.

#### T-05c · A single content-encryption key (A4)

**One memory.** Every payload gets its own CEK, used for exactly one encryption. There is no key
reuse to exploit, and GCM's 2^32-encryptions bound is satisfied by construction with an enormous
margin.

#### T-05d · A revoked grantee's retained key material (A2)

**Unmitigated, and structural.** Once an ECIES-wrapped CEK is inside a payload on IPFS, anyone
holding the matching private key can decrypt it forever.
`MemoryAccessControl.revokeAccess` stops _future_ grants and tells cooperating nodes to stop serving.
**It cannot un-publish.** `policy.redistribution` is advisory and enforced by nothing.

**Residual risk — HIGH for T-05a, LOW for T-05b/c, MEDIUM and structural for T-05d.**

Supporting mitigations: `zeroize` and `withKey` clear key material (best-effort in a GC'd runtime —
V8 may have copied the bytes, but the long-lived copy that lands in a heap snapshot is removed); the
boot schema **refuses to start** if `MEMORY_ENCRYPTION_KEY == PRIVATE_KEY`; `SECRET_KEYS` keeps every
secret out of logs, error messages and status responses; and configuration errors print paths and
messages but **never values**.

---

### T-06 · IPFS unavailability

**Adversary:** a failing or hostile pinning service, or ordinary network partition.

| Attack                                                | Mitigation                                                                                                         | Strength             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------- |
| Return wrong bytes for a CID                          | `verifyCid(bytes, cid)` recomputes sha2-256 locally; disagreement is `CID_MISMATCH` (**502**, an upstream failure) | **Strong**           |
| Claim a CID that does not address the submitted bytes | Same check, before any transaction is sent                                                                         | **Strong**           |
| Refuse to pin                                         | Commit aborts before anything is anchored                                                                          | **Correct ordering** |
| Unpin after the fact                                  | **Nothing.** Single pinning provider, no replication                                                               | **None**             |
| Serve a CIDv0 record                                  | `digestFromCid` rejects `Qm…` loudly rather than mis-parsing                                                       | **Strong**           |
| Slow-loris the gateway                                | `IPFS_TIMEOUT_MS` (30 s), `IPFS_MAX_BYTES` (1 MiB)                                                                 | **Strong**           |
| Disclose the pin list                                 | **Nothing.** Feeds T-04 and T-08                                                                                   | **None**             |

**Residual risk — MEDIUM.**

The **integrity** side is well handled: the pinning service is removed from the proof chain, and a
lying service is caught, not trusted. The **availability** side is not handled at all. There is a
single provider, no replication, and no re-pin logic. If Pinata unpins or the account lapses,
**every memory becomes undecryptable in practice** — the on-chain record survives and proves a
commitment to bytes nobody can fetch.

_Operator mitigation:_ pin to a second provider or a self-hosted node. Not implemented.

---

### T-07 · RPC censorship and lying

**Adversary:** the configured RPC provider, or anyone who controls it.

| Attack                                                               | Mitigation                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Censor transactions                                                  | `RPC_URLS` accepts several endpoints, but **no automatic failover or cross-check is implemented**      |
| Return false state (fake reputation, wrong owner, wrong `isTrusted`) | **None.** The node has no light client and does not verify state proofs                                |
| Delay inclusion to enable front-running                              | **None**, and it composes with T-04                                                                    |
| Report a wrong chain id                                              | `CHAIN_ID` is configured and can be compared, but this only catches a mistake, not a lie about _state_ |
| Drop reads                                                           | `503 chain_unavailable`, surfaced honestly                                                             |

**Residual risk — MEDIUM, unmitigated.**

**A malicious RPC provider can make any agent look trusted or untrusted, any memory look owned by
anyone, and any commit look confirmed when it was not.** The node believes what its provider tells
it. TA6 is a real assumption, not a formality.

_Partial defences available today:_ configure several `RPC_URLS` from independent operators; set
`TX_CONFIRMATIONS` above 1; verify critical reads against a block explorer out of band. None is
automatic.

---

### T-08 · Metadata leakage

**Adversary:** any passive observer. **Goal:** learn who is doing what with whom, and infer content.

**Public by construction, on chain:** committer address, `cidHash`, CID string, `prevCidHash`,
version number, model name, embedding dimension, `isEncrypted`, commit timestamp, revocation events,
every access grant and revocation with grantor and grantee, and every endorsement and report edge
with its weight and timestamp.

**Public on IPFS:** the payload structure, `agentDid`, `contentId`, `keyVersion`, `createdAt`,
`policy`, the model reference, the alignment reference, `embedding.dataDigest`, the **full recipient
list with addresses and key versions**, and — depending on policy — the embedding itself or its
SimHash.

| Mitigation                                                       | Strength                                          |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| `embeddingVisibility` defaults to `grantees`, not `public`       | Real                                              |
| `lsh-only` publishes a 256-bit SimHash instead of the vector     | Partial                                           |
| `contentId` may be randomised via `envelope.generateContentId()` | Real, if used                                     |
| Recipient ordering is canonical, so ordering leaks nothing       | Minor                                             |
| Everything else                                                  | **None. This is a design property, not a defect** |

**Residual risk — MEDIUM, unmitigated by design.**

Three specific consequences:

1. **A public embedding is approximately the plaintext.** Sentence embeddings are substantially
   invertible — Song and Raghunathan (CCS 2020); Morris et al. (EMNLP 2023) recover 92% of 32-token
   inputs from a 768-d vector. The schema documents `public` as roughly equivalent to publishing the
   text. `lsh-only` reduces the leak but still exposes coarse semantics.
2. **The recipient list is a social graph.** Every payload names, in clear, exactly who was granted
   access.
3. **A deterministic `contentId` is a guessing oracle.** `computeContentId` is a deterministic
   function of the plaintext, so an observer who guesses the content can confirm the guess. Use
   `generateContentId()` when that linkability is unwanted.

**Do not put anything in a memory whose existence, timing, authorship or recipient set is sensitive.**
The _content_ is confidential. Nothing else is.

---

### T-09 · Node and operational compromise

**Adversary:** anyone who can reach the node's port, or who lands code on the host.

| Attack                              | Mitigation                                                                                                                                                                              | Strength                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Unauthenticated writes              | `API_AUTH_TOKEN`, constant-time compare; **required in production and whenever `HOST=0.0.0.0`** — the process refuses to boot otherwise                                                 | **Strong**                               |
| Weak token                          | Minimum 32 characters; a repeated single character is rejected at boot                                                                                                                  | **Strong**                               |
| Browser-driven writes (CSRF-shaped) | Explicit `CORS_ALLOWED_ORIGINS`; **`*` is rejected outright**; empty means same-origin only                                                                                             | **Strong**                               |
| LAN exposure                        | `HOST` defaults to `127.0.0.1`; compose publishes on `127.0.0.1:7860`                                                                                                                   | **Strong**                               |
| Rate-limit evasion via proxy        | `TRUST_PROXY`                                                                                                                                                                           | Strong **if configured correctly**       |
| Resource exhaustion                 | Four independent limiter buckets, `BODY_LIMIT`, `EMBED_QUEUE_MAX`, `TX_QUEUE_MAX`, `IPFS_MAX_BYTES`, 1 MiB payload cap                                                                  | **Strong**                               |
| Secrets in logs                     | `SECRET_KEYS` redaction; config errors never print values                                                                                                                               | **Strong**                               |
| Secrets in the image                | Runtime-only; the builder stage **fails the build** if `.env` reaches the build context; an explicit payload allowlist keeps `.git`, `.env`, `test/`, `scripts/` and `docs/` out        | **Strong**                               |
| Container escape                    | Non-root, `read_only`, `cap_drop: ALL`, `no-new-privileges`, `tini` as PID 1                                                                                                            | **Strong**                               |
| Supply chain                        | `npm ci` with a lockfile; **production audit is 0 vulnerabilities** via the `sharp`/`adm-zip` overrides, enforced in CI at `--audit-level=high`; CodeQL and secret scanning; Dependabot | **Strong**                               |
| Header injection via `X-Request-Id` | Inbound value honoured **only** if it matches a strict character class                                                                                                                  | **Strong**                               |
| Local memory reading                | `zeroize`, `withKey`                                                                                                                                                                    | **Weak** — best-effort in a GC'd runtime |
| Ownership oracle on decrypt         | `NO_ENVELOPE_FOR_RECIPIENT` and `TAG_VERIFY_FAILED` are distinct codes; the v1 blanket 403 was the oracle                                                                               | **Strong**                               |

**Residual risk — HIGH, but concentrated in one place.**

The v2 posture is genuinely good. The risk is that **`server.js` — the legacy v1 process — is what
`npm start` runs today**, and it has _none_ of the above: no auth, no rate limiting, no security
headers, bare `cors()`, no error middleware, and an AES passphrase that **is** the wallet private key.
See [API.md Part A](./API.md#part-a--what-is-served-today).

**Do not expose the current `server.js` to any network.**

Secondary: a compromised `PINATA_JWT` lets an attacker unpin (T-06) and read the pin list (T-04,
T-08). A compromised `API_AUTH_TOKEN` lets an attacker spend the wallet's gas.

---

## 6. What is out of scope

| Out of scope                                                        | Why                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Ethereum L1 consensus                                               | Assumed (TA3)                                                                                                                  |
| The correctness of OpenZeppelin, ethers, Express, zod, ONNX Runtime | Assumed; tracked by `npm audit` and Dependabot                                                                                 |
| Physical and host security of the operator's machine                | TA4                                                                                                                            |
| Browser and OS vulnerabilities on a dashboard user's device         | —                                                                                                                              |
| The content of memories                                             | The protocol has no notion of a memory being true                                                                              |
| Legal, regulatory and data-protection obligations                   | Operator's responsibility. Note that IPFS bytes are effectively **undeletable**, which has direct erasure-request implications |
| Economic security                                                   | There is none. `endorsementStakeWei` defaults to `0` and no incentive layer exists                                             |
| Mainnet deployment                                                  | Explicitly unsupported                                                                                                         |

---

## 7. Residual risk statement

**Substantially mitigated (3):**
[T-03](#t-03--replay-and-signature-attacks) replay and signature attacks;
[T-09](#t-09--node-and-operational-compromise) node compromise _for the v2 stack_;
the **integrity** half of [T-06](#t-06--ipfs-unavailability).

**Partially mitigated (2):**
[T-01](#t-01--memory-poisoning) memory poisoning — reputation re-ranks but never gates, and
suspension is unenforceable;
[T-05](#t-05--key-compromise) key compromise — the hierarchy correctly bounds an encryption-key leak,
but a wallet-key leak is total and a revoked grantee keeps what it had.

**Unmitigated (4):**

| Threat                                                 | Status                                                                                                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [T-04](#t-04--cid-front-running) **CID front-running** | **Critical.** Ownership is first-come-first-served and unrecoverable. [SEC-01](./SECURITY-NOTES.md#sec-01--critical--cid-front-running-through-the-self-commit-path) |
| [T-02](#t-02--sybil-attack) **Sybil**                  | **High.** 8 wallets manufacture trust; **1 free transaction destroys it, permanently and unappealably**. SEC-02, SEC-03, SEC-04, SEC-06                              |
| [T-07](#t-07--rpc-censorship-and-lying) RPC lying      | **Medium.** No light client, no state-proof verification, no automatic cross-checking                                                                                |
| [T-08](#t-08--metadata-leakage) Metadata               | **Medium, by design.** The chain and the payload publish the social graph and the activity pattern                                                                   |

Plus the **availability** half of [T-06](#t-06--ipfs-unavailability): a single pinning provider with
no replication.

### The honest summary

> NeuroMesh currently provides **strong confidentiality for memory content**, **strong replay and
> signature integrity**, and **strong node-level operational hardening in the v2 stack** — while
> providing **no ownership integrity** (anyone can steal a CID), **no sybil resistance** (one free
> transaction destroys any agent's trusted status, permanently), **no protection against a lying RPC
> provider**, and **no metadata privacy**.
>
> It is suitable for research, for demonstrating the protocol design, and for testnet
> experimentation. It is **not** suitable for anything where ownership, trust, or availability
> matters, and it must not hold mainnet value.

---

## See also

- [SECURITY-NOTES.md](./SECURITY-NOTES.md) — the 14 deduplicated contract findings in full
- [PROTOCOL.md §11](./PROTOCOL.md#11-honest-limitations) — protocol-level limitations
- [ARCHITECTURE.md §11](./ARCHITECTURE.md#11-failure-modes) — operational failure modes
- [CONFIGURATION.md §4](./CONFIGURATION.md#4-cross-field-rules-that-block-boot) — the boot rules that
  enforce T-09's mitigations
- [SECURITY.md](../SECURITY.md) — how to report a vulnerability
