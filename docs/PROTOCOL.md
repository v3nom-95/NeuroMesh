# NeuroMesh Protocol Specification

**Version tag:** `neuromesh/2.0.0`
**Spec hash:** `0x6ac1c037bafe66d990d342a8e34613e13d769ee364e6754ce6601459df8a6d8c`
**Status:** research prototype. Sepolia testnet only. **Not audited. Not for mainnet value.**

> **How to read this document.** Sections 1–9 are normative and describe the protocol **as
> implemented** in `src/protocol/` and `contracts/`. Every constant, type string and formula here was
> transcribed from the source, and the source file and symbol are named so you can diff them by eye.
> Section 10 is the honest-limitations section and is as normative as the rest: it tells you what the
> protocol does _not_ do.
>
> Where the implementation diverges from an earlier design specification, the divergence is called
> out inline and marked **DIVERGENCE**. It is not silently reconciled.

---

## Contents

- [1. Protocol identity](#1-protocol-identity)
- [2. Canonicalisation](#2-canonicalisation)
- [3. Content addressing](#3-content-addressing)
- [4. The canonical memory payload, v2](#4-the-canonical-memory-payload-v2)
- [5. Envelope encryption](#5-envelope-encryption)
- [6. Key hierarchy and identity](#6-key-hierarchy-and-identity)
- [7. Cross-model projection](#7-cross-model-projection)
- [8. EIP-712 typed data](#8-eip-712-typed-data)
- [9. Third-party verification procedure](#9-third-party-verification-procedure)
- [10. Trust, decay and ranking](#10-trust-decay-and-ranking)
- [11. Honest limitations](#11-honest-limitations)

---

## 1. Protocol identity

Source: `src/protocol/constants.js`.

| Symbol              | Value                                                                                                      | Notes                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROTOCOL_VERSION`  | `neuromesh/2.0.0`                                                                                          | Appears verbatim as `payload.v` and as the first AAD component                                                                                 |
| `SPEC_HASH`         | `keccak256(utf8(PROTOCOL_VERSION))` = `0x6ac1c037bafe66d990d342a8e34613e13d769ee364e6754ce6601459df8a6d8c` | Computed at load time, never hardcoded, so the two can never drift. Used as the HKDF salt for every derivation and as the second AAD component |
| `UNIT_SEP`          | `U+001F`                                                                                                   | The AAD component separator. Any string containing it is rejected everywhere                                                                   |
| `MAX_PAYLOAD_BYTES` | `1048576` (1 MiB)                                                                                          | Keeps a memory a single raw IPFS block                                                                                                         |
| `WAD`               | `1000000000000000000`                                                                                      | Fixed-point scale for every on-chain ratio; mirrors `Limits.WAD`                                                                               |

Nothing in `constants.js` is configurable at runtime. A change to that file is a protocol change,
because these values are baked into hashes, key-derivation domains, AAD strings and the projection
identifier. Every exported object is frozen and the module holds no mutable state, so importing it in
two processes yields byte-identical values.

`LIMITS` in the same file is a byte-for-byte mirror of `contracts/libraries/Limits.sol`, with each
member naming the Solidity constant it copies. Any divergence is a bug in the JavaScript, not in the
Solidity — the contracts are the authority for those bounds.

---

## 2. Canonicalisation

Source: `src/protocol/canonical.js`. The bytes this produces are the preimage of the CID, of the
on-chain `cidHash`, and of `payloadHash`. Two implementations that disagree here by one byte disagree
on everything above.

The profile is RFC 8785 (JSON Canonicalization Scheme), restricted further:

1. **Object members are emitted in ascending order of the key's UTF-16 code units.** JavaScript's
   default `Array.prototype.sort()` on strings compares exactly that way, which is why no comparator
   is passed (RFC 8785 §3.2.3).
2. **Arrays preserve their order.**
3. **Strings use `JSON.stringify` escaping**, which is the minimal escaping RFC 8785 §3.2.2.2
   mandates.
4. **Numbers must be safe integers.** Floats, `NaN`, `Infinity`, `-0` and `BigInt` are rejected
   outright rather than serialised. This removes every dependence on cross-language float printing,
   the single largest source of canonicalisation disagreement between implementations.
   _Real vectors travel as base64url of a little-endian `Float32Array` instead._
5. **`undefined`, functions and symbols are rejected** wherever they appear, including as object
   values, so a typo can never silently drop a field from the hash preimage.
6. **Class instances are rejected.** Only plain objects (prototype `Object.prototype` or `null`) and
   arrays are canonicalisable.
7. **Cycles are detected and rejected.**
8. **Any string containing `U+001F` is rejected**, because that byte is the AAD separator and
   allowing it here would let a payload field forge an AAD boundary.

`assertCanonical(bytes)` re-canonicalises a fetched byte string and asserts the bytes were already
canonical. A payload whose bytes differ from the canonical form of their own parse cannot be
reproduced by a verifier and MUST be rejected. This is step 3 of §9.

### Float encoding

`f32ToB64(values)` writes each element with `DataView.setFloat32(offset, value, /* littleEndian */ true)`.
Endianness is explicit, so the encoding is identical on a big-endian machine. `b64ToF32` is the
inverse and rejects a byte length that is not a multiple of 4.

---

## 3. Content addressing

Source: `src/protocol/canonical.js`.

A payload's CID is **CIDv1, `raw` codec, sha2-256, 32-byte digest, multibase base32-lower**:

```text
multihash = 0x01 0x55 0x12 0x20 || sha256(bytes)
            └v1  └raw └sha2 └32
cid       = "b" || base32-lower-unpadded(multihash)
```

Because payloads are capped at 1 MiB the object is always a single raw block, so there is no UnixFS
framing and no DAG. A verifier reproduces this in four lines in any language.

Three derived values, all from `payload.addressPayload(payload)`:

| Value         | Definition                     | Consumed by                       |
| ------------- | ------------------------------ | --------------------------------- |
| `bytes`       | canonical UTF-8 of the payload | pinned to IPFS, verbatim          |
| `cid`         | as above                       | `MemoryInput.cid`, IPFS retrieval |
| `cidDigest`   | `sha256(bytes)` as 0x-hex      | cross-check against the CID       |
| `payloadHash` | `keccak256(bytes)` as 0x-hex   | the hash Solidity speaks          |

`digestFromCid(cid)` parses a CID string and returns its sha2-256 digest. It **rejects loudly** rather
than mis-parsing: a v0 `Qm…` CID throws, because CIDv0 implies the dag-pb codec and UnixFS framing, so
its digest is _not_ sha256 of the payload bytes. Any non-`b` multibase prefix, any wrong length and
any non-raw/non-sha2-256 prefix also throw.

`verifyCid(bytes, cid)` asserts that a CID supplied by a third party really addresses the bytes in
hand. This is the check that removes the pinning service from the middle of the proof chain: the node
computes the CID itself and refuses whatever the remote API claims if the two disagree.

> **DIVERGENCE — CID format.** The on-chain records made by the _legacy_ v1 node carry CIDv0 `Qm…`
> strings (Pinata's `pinJSONToIPFS` returns v0). The v2 protocol core produces and accepts only
> CIDv1 raw. Legacy records are therefore not verifiable through the §9 procedure. This is a real
> break, not a compatibility shim.

---

## 4. The canonical memory payload, v2

Source: `src/protocol/payload.js`, schema `MemoryPayloadV2` (zod, `strictObject` throughout — an
unknown top-level key is an error, not a passthrough, because a verifier that ignored unknown keys
would hash bytes it did not understand).

### 4.1 Top-level shape

| Field        | Type                     | Constraint                         | Meaning                                                  |
| ------------ | ------------------------ | ---------------------------------- | -------------------------------------------------------- |
| `v`          | string literal           | `"neuromesh/2.0.0"`                | Protocol version                                         |
| `contentId`  | `0x` + 32 lower-case hex | 16 bytes                           | Identifier of the logical memory; bound into the AAD     |
| `agentDid`   | string                   | `did:pkh:eip155:<chainId>:<0x…40>` | Authoring agent                                          |
| `keyVersion` | integer                  | `0 … 4294967295`                   | Author's encryption key version at seal time             |
| `createdAt`  | integer                  | `>= 0`                             | Unix seconds, **signer-asserted**                        |
| `prevCid`    | string \| null           | 1…100 chars                        | Parent version, or `null` for a root                     |
| `model`      | `ModelRef`               | —                                  | The embedding model, pinned by digest                    |
| `alignment`  | `AlignmentRef`           | —                                  | Which projection produced the aligned vector             |
| `embedding`  | `EmbeddingBlock`         | —                                  | The aligned embedding or its digest                      |
| `lsh`        | `LshBlock` \| null       | —                                  | Optional published SimHash signature                     |
| `policy`     | `PolicyBlock`            | —                                  | Per-memory policy; hashed into `policyId`                |
| `cipher`     | `CipherBlock` \| null    | —                                  | Present iff the context is sealed                        |
| `context`    | string \| null           | ≤ 65536 chars                      | Plaintext context; only for a deliberately public memory |
| `recipients` | `RecipientEntry[]`       | ≤ 256                              | Per-recipient wrapped CEKs                               |

`createdAt` is **not proof of when the memory was formed.** The only temporal fact anyone can verify
is the block timestamp of the commit, which is an upper bound on inclusion time (proposer-chosen
within consensus bounds, plus or minus one slot), not a statement about authorship time. The schema
says so in its own comment.

### 4.2 Cross-field invariants

`parseMemoryPayload` enforces two invariants beyond the schema, because either one being wrong makes
the payload self-contradictory rather than merely odd:

1. **Exactly one of `cipher` and `context` is present.** A payload is either sealed or public.
2. **A sealed payload has at least one recipient.** Otherwise nobody — including its own author — can
   ever open it, and the memory is write-only garbage occupying a paid pin.

### 4.3 Block schemas

```jsonc
// ModelRef — the model is pinned by a digest, not by a human-readable name.
// A name is not a version: "all-MiniLM-L6-v2" can be re-uploaded, re-quantised
// or re-exported to ONNX, and every such change moves the embedding space
// while the name stays put.
{
  "id":  "0x…64 hex",       // keccak256 of the canonical model URI
  "uri": "string, 1..512",  // resolved URI carrying the weights digest
  "dim": 1..8192            // native output dimensionality
}

// AlignmentRef
{
  "projectionId": "string, 1..160",  // see §7
  "dim": 1..8192                     // target dimensionality
}

// EmbeddingBlock
{
  "visibility": "public" | "grantees" | "lsh-only",
  "encoding":   "f32-b64",           // literal
  "dim":        1..8192,
  "data":       "base64url" | null,  // present iff visibility === "public"
  "dataDigest": "0x…64 hex"          // sha2-256 over the decoded float32 bytes
}

// LshBlock (optional)
{ "alg": "simhash", "bits": 8..4096, "sig": "base64url" }

// PolicyBlock — hashed into policyId, which is bound into the content AAD
{
  "embeddingVisibility": "public" | "grantees" | "lsh-only",
  "redistribution":      "forbidden" | "grantees" | "public",  // advisory, unenforceable off-chain
  "retentionUntil":      integer >= 0                          // unix seconds, 0 = never
}

// CipherBlock
{ "alg": "NM-SEAL-AES256GCM/v1", "iv": "b64url(12B)", "ct": "b64url", "tag": "b64url(16B)" }

// RecipientEntry
{
  "alg":        "ECIES-secp256k1-HKDF-SHA256-AES256GCM/v1",
  "addr":       "0x…40",           // checksummed recipient address
  "keyVersion": 0..4294967295,
  "epk":        "0x02… or 0x03…",  // 33-byte compressed ephemeral public key
  "iv":  "b64url(12B)", "ct": "b64url", "tag": "b64url(16B)"
}
```

`EmbeddingBlock` is cross-validated: `data` is **required** when `visibility === "public"`, **must be
null** otherwise (a non-public embedding travels inside the sealed content block), and when present
must decode to exactly `dim * 4` bytes.

### 4.4 Embedding visibility, and why it is a per-memory decision

`policy.embeddingVisibility` has three values and defaults to `grantees`, because publishing a
plaintext embedding alongside an encrypted context protects very little. Sentence embeddings are
substantially invertible — Song and Raghunathan (CCS 2020); Morris et al., _Text Embeddings Reveal
(Almost) As Much As Text_ (EMNLP 2023), which recovers 92% of 32-token inputs from a 768-d vector.
The schema documents `public` as **approximately equivalent to publishing the text**. `lsh-only`
publishes a SimHash signature instead; that is a privacy _improvement_, not a guarantee — the bits
still leak coarse semantics.

### 4.5 Identifiers

| Identifier             | Definition                                                                                 | Source                     |
| ---------------------- | ------------------------------------------------------------------------------------------ | -------------------------- |
| `contentId`            | first 16 bytes of `sha256(canonicalBytes(content))`, over the **plaintext content object** | `payload.computeContentId` |
| `policyId`             | `keccak256(canonicalBytes(PolicyBlock))`                                                   | `payload.computePolicyId`  |
| `embedding.dataDigest` | `sha256(le-float32(vector))`                                                               | `payload.embeddingDigest`  |

`contentId` is derived from the plaintext rather than from the assembled payload, and this is not a
stylistic choice. `contentId` is bound into the encryption AAD, the AAD produces the ciphertext, the
ciphertext goes into the payload, and the payload produces the CID. Deriving `contentId` from the
payload would close that loop into a cycle with no fixed point.

Determinism means re-authoring the same content twice produces the same `contentId`, which makes
duplicate commits detectable. When that linkability is unwanted — `contentId` is public, and a
deterministic id lets an observer test a guessed plaintext — use `envelope.generateContentId()`,
which draws 16 random bytes instead.

---

## 5. Envelope encryption

Source: `src/protocol/envelope.js`. This is **symmetric authenticated encryption with per-recipient
public-key key wrapping.** It is not, and does not claim to be, zero knowledge.

### 5.1 Shape of the scheme

Every memory is sealed under its **own** random content-encryption key. The CEK is then wrapped
separately for each recipient with ECIES over secp256k1. Nothing is ever encrypted directly under a
long-term key, and no long-term key is ever an AES key.

```text
CEK        <- 32 random bytes, used for exactly one payload
ciphertext <- AES-256-GCM(CEK, iv = 12 random bytes, aad = buildAad(...)) over the plaintext
recipient  <- ECIES-wrap(CEK) under that recipient's *encryption* public key
```

Because each CEK performs exactly one encryption, GCM's "at most 2^32 encryptions per key" bound is
satisfied by construction with an enormous margin.

| Parameter              | Value                                      | Constant        |
| ---------------------- | ------------------------------------------ | --------------- |
| AEAD                   | `aes-256-gcm`                              | `AEAD_ALG`      |
| Content algorithm tag  | `NM-SEAL-AES256GCM/v1`                     | `CONTENT_ALG`   |
| Key-wrap algorithm tag | `ECIES-secp256k1-HKDF-SHA256-AES256GCM/v1` | `ECIES_ALG`     |
| GCM nonce              | **12 bytes**, never 16                     | `AES_IV_BYTES`  |
| GCM tag                | 16 bytes (128-bit)                         | `AES_TAG_BYTES` |
| CEK length             | 32 bytes                                   | `CEK_BYTES`     |
| KDF                    | HKDF-SHA256                                | `HKDF_HASH`     |

> The 12-byte nonce is deliberate. A non-96-bit IV is folded through GHASH to derive J0, which is
> slower and silently non-interoperable with implementations that accept only the standard nonce. The
> v1 code used 16 bytes; v1 cipher blocks are **not readable** by this implementation and `open()`
> rejects them with an explicit message rather than failing obscurely.

### 5.2 Additional authenticated data

The content AAD is seven components joined by `U+001F`:

```text
AAD = PROTOCOL_VERSION ␟ SPEC_HASH ␟ agentDid ␟ contentId ␟ policyId ␟ modelId ␟ keyVersion
```

Every component is rejected if it is empty or contains `U+001F`, so the encoding is unambiguous.

This is what makes the cut-and-paste attack the v1 design permitted impossible. Previously an
attacker could lift another agent's `encrypted_context` object verbatim into their own payload under
their own DID, and GCM would verify happily, because the ciphertext was bound to nothing. Now the tag
verifies only against the exact `(agent, content, policy, model, key version)` tuple that produced it.

**The AAD deliberately does not contain the CID.** That would be circular: the CID is the hash of the
payload, the payload contains the ciphertext, and the ciphertext depends on the AAD. The chain closes
through the ledger instead — the payload carries `contentId`, the CID is the hash of the payload, and
the on-chain `MemoryCommit` signature covers `cidHash`. End-to-end binding, no cycle.

`buildAad` is a **public export** on purpose: a third-party verifier must be able to reconstruct the
exact AAD bytes from the payload's own fields in order to check the tag. A verifier MUST NOT trust an
`aad` echo stored inside the payload — reconstruct, then compare.

The key-wrap AAD is separate:

```text
wrapAAD = ECIES_ALG ␟ SPEC_HASH ␟ grantorDid ␟ contentId ␟ recipientAddress ␟ recipientKeyVersion ␟ epk
```

It binds the wrap to the grantor, the content, the recipient address, the recipient's key version and
the ephemeral public key, so a wrap cannot be re-addressed to a different recipient or reused for a
different memory.

### 5.3 ECIES key wrap, step by step

`deriveKek` is specified precisely enough to reimplement:

1. Validate the counterparty's 33-byte compressed public key, **including the on-curve check**. This
   is not ceremony: an attacker-supplied point that is not on the curve turns ECDH into an
   invalid-curve attack that can leak bits of the private key.
2. ECDH: `shared = d · Q`. Take the **x coordinate only** — the leading `0x04` byte of the encoded
   uncompressed point is dropped, because including it would make the secret depend on the point
   encoding rather than on the shared value.
3. `salt = sha256(SPEC_HASH_BYTES ‖ contentId_bytes)`, so a KEK is scoped to one memory.
4. `info = utf8("neuromesh/kek/v2") ‖ recipientAddress(20 bytes) ‖ uint32be(keyVersion)`.
5. `KEK = HKDF-SHA256(ikm = sharedX, salt, info, 32)`.
6. Wrap: `AES-256-GCM(KEK, iv = 12 random bytes, aad = wrapAAD)` over the 32-byte CEK.

Unwrapping runs the same derivation with `(recipientPrivateKey, epk)` and reconstructs the same
`wrapAAD`. Every intermediate key is zeroised in a `finally` block.

### 5.4 Error taxonomy

Two failure modes are kept distinguishable to an operator while an external caller sees one generic
failure:

| Code                        | Meaning                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `NO_ENVELOPE_FOR_RECIPIENT` | This key material was never wrapped for you (`findEntry` returned `null`)                                                  |
| `TAG_VERIFY_FAILED`         | The ciphertext is not bound to the AAD you supplied — wrong key, tampering, or a block copied from another agent's payload |

Collapsing these two into one blanket 403 — which the v1 `/api/decrypt` route did — hands an attacker
an ownership oracle.

Other codes: `CIPHER_BLOCK_MALFORMED`, `CIPHER_ALG_UNSUPPORTED`, `WRAP_ALG_UNSUPPORTED`,
`RECIPIENT_ENTRY_MALFORMED`, `AAD_REQUIRED`, `AAD_COMPONENT_MISSING`, `AAD_COMPONENT_INVALID`.
Sealing without an AAD is refused outright: `AAD_REQUIRED` exists so nobody can reintroduce the v1
defect by passing an empty buffer.

### 5.5 Recipient ordering

`sortRecipients` puts entries in ascending checksummed address, then ascending key version.
Deterministic ordering keeps the payload bytes — and therefore the CID — a function of the recipient
_set_ rather than of the order a caller happened to pass them in.

---

## 6. Key hierarchy and identity

Source: `src/protocol/keys.js`.

### 6.1 The v1 defect this replaces

The v1 design used the wallet's secp256k1 signing key directly as the PBKDF2 input for the AES key.
Three consequences, all fatal:

1. **Sharing a memory required sharing the signing key.** The only way for agent B to decrypt agent
   A's memory was for A to hand over the KDF input — which is A's identity.
2. **No domain separation.** One 256-bit secret was simultaneously an ECDSA scalar and a KDF input,
   so a weakness or leak in either path compromised both.
3. **Wrong primitive.** PBKDF2 stretches _low-entropy passwords_. The input was already a uniformly
   random 256-bit scalar, so 100 000 SHA-512 iterations bought nothing and cost about 53 ms per
   memory (measured — see [BENCHMARKS.md](./BENCHMARKS.md)).

### 6.2 The replacement

A **separate encryption keypair**, derived from the wallet key by HKDF-SHA256 under an info string
used for nothing else:

```text
ikm   = wallet private key (32 bytes)
salt  = SPEC_HASH_BYTES
info  = utf8("neuromesh/enckey/v2") ‖ uint32be(keyVersion) ‖ uint32be(counter)
d_enc = int(HKDF-SHA256(ikm, salt, info, 32)), rejection-sampled into [1, n-1]
```

Rejection sampling increments `counter` and retries; it **never reduces mod n**, because reduction
would bias the scalar. The loop bounds at 256 attempts; `P(256 consecutive out-of-range outputs)` is
below `2^-2000`.

**The direction of the derivation is the point of the design.** HKDF-Expand is built on HMAC-SHA256,
so recovering `ikm` from `d_enc` is a preimage problem. A leaked _encryption_ key therefore yields
nothing about the signing key, while a leaked _signing_ key does yield the encryption key — which is
the correct asymmetry, because the signing key is the identity and its compromise is already total.

Derivation is deterministic in `(walletPrivateKey, keyVersion)` alone: two processes, two machines and
a restart all produce byte-identical output, which is what lets a node recover its own memories after
a restart without persisting a second secret.

`deriveEncryptionKey` asserts that the derived key does not equal the wallet key and throws
`KEY_SEPARATION_VIOLATED` if it does. HKDF makes a collision impossible in practice; the assertion
exists so a future refactor that accidentally short-circuits the derivation fails loudly instead of
silently reintroducing the v1 defect.

`importEncryptionKey` wraps an independently generated key in the same shape, for agents that manage
key material in an HSM, a KMS or a hardware wallet.

### 6.3 Key rotation

`keyVersion` is a first-class input, so rotating the encryption key is a one-integer change producing
an entirely unrelated keypair without touching the wallet, the address or the DID. The new public key
is published on chain through `AgentIdentity.rotateKey` / `rotateKeyFor`, which increments the
on-chain `keyVersion` and emits `AgentKeyRotated(agent, newKeyVersion, newPublicKey)`.

### 6.4 Agent identifiers

`did:pkh:eip155:<chainId>:<EIP-55 checksummed address>`. The address is **always** checksummed, so
the DID is a canonical string and can be compared with `===` and hashed into the AAD with no
normalisation step. `fromDid` rejects a DID whose address is not correctly checksummed.

> **The registry does not prove key ownership.** `IAgentIdentity` states it explicitly: the contract
> records an _opaque, self-asserted_ encryption public key and cannot prove it corresponds to the
> address. Consumers MUST treat `publicKey` as a self-assertion. There is no proof-of-possession.

### 6.5 Handling rules

Values returned by `keys.js` and `envelope.js` are key material. They MUST NOT be logged, MUST NOT be
returned by an HTTP route, and MUST NOT be persisted. Use `withKey(key, fn)` where possible so
zeroisation is structural rather than remembered. `zeroize` is best-effort in a garbage-collected
runtime — V8 may have copied the bytes — but it removes the long-lived copy, which is the one that
ends up in a heap snapshot or a core dump.

---

## 7. Cross-model projection

Source: `src/protocol/projection.js`.

### 7.1 The bug this replaces

`lib/semantic-sync.js` built its projection matrix from `Math.random()`. The matrix was therefore
different on every process start and different on every node, so two nodes projected their 768-d
embeddings into two _independent_ random 384-d subspaces. The cosine between node A's projected vector
and node B's projected vector then has expectation 0 and standard deviation `1/sqrt(384) = 0.051` — it
carries no semantic information at all.

Measured against this repository's own committed results: six cross-model cosines with sample standard
deviation 0.0441 against the 0.0510 noise prediction, chi-square 3.82 on 6 degrees of freedom,
p = 0.70. **The published similarity matrix fit the pure-noise null comfortably.** That matrix is not
reproduced anywhere in this documentation set.

### 7.2 What the replacement guarantees, and what it does not

It guarantees **determinism**. The same `(fromDim, toDim)` produces a byte-identical matrix in every
process, on every machine, because the matrix is drawn from an AES-256-CTR keystream under a seed
derived by keccak256 from protocol constants and the two dimensions. There is no entropy source, no
wall clock and no module state that survives a call; `Math.random` appears nowhere in the file, and a
test greps for it.

It does **not** claim that projecting two independently trained encoders into a shared space makes
their coordinates comparable. Johnson–Lindenstrauss is a _within-space_ guarantee: it approximately
preserves distances between points that already live in one space. Two encoders share no basis, so a
shared seed buys reproducibility, not meaning. Cross-model comparison is only sound once an
anchor-based alignment bundle exists (relative representations — Moschella et al., ICLR 2023). Until
then, treat cross-model scores as _reproducible_ and compare them against `noiseBaseline` before
believing them.

`noiseBaseline(k) = 1 / sqrt(k)` is a first-class export precisely because omitting it is what
produced the original overclaim. For the shared 384-d space it is **0.051031036307982884**. A cosine
of 0.05 in that space is exactly one standard deviation of pure noise, not a weak match.

### 7.3 The construction, specified exactly

**Seed.**

```text
seedKey = keccak256(utf8("neuromesh/projection/v1" ‖ "|" ‖ "achlioptas-s3" ‖ "|" ‖ from ‖ "->" ‖ to))
```

**Keystream.** `AES-256-CTR` with `key = seedKey` (32 bytes) and `iv = 16 zero bytes`, encrypting an
all-zero plaintext. Words are consumed as **big-endian uint32** in stream order.

**Entries.** Sparse Achlioptas, density parameter `s = 3` (one third of entries non-zero). For each
entry one uint32 `u` is drawn and mapped:

| Condition                          | Value |
| ---------------------------------- | ----- |
| `u < 715827882` (`floor(2^32/6)`)  | `+1`  |
| `u < 1431655765` (`floor(2^32/3)`) | `-1`  |
| otherwise                          | `0`   |

then scaled by `sqrt(3 / toDim)`, which preserves expected norms. The two thresholds give
`P(+1) = P(-1) = 0.1666666665`, a bias of `8e-11` from exactly 1/6 — far below any effect on the
distance-preservation bound, and stated here rather than hidden.

**Generation order.** Row-major, `i` (source dimension) outer, `j` (target dimension) inner, one
uint32 per entry.

Reproducing the matrix in another language requires only AES-CTR and the paragraphs above.

### 7.4 Projection identifier

```text
projectionId = "neuromesh-proj/" ‖ version ‖ "/" ‖ alg ‖ "/" ‖ prng ‖ "/" ‖ from ‖ "-" ‖ to ‖ "/" ‖ seed[2:10]
```

Two currently reachable values, computed from the live code:

| Pair      | `projectionId`                                                 |
| --------- | -------------------------------------------------------------- |
| 768 → 384 | `neuromesh-proj/v1/achlioptas-s3/aes-256-ctr/768-384/d5180223` |
| 384 → 384 | `neuromesh-proj/v1/achlioptas-s3/aes-256-ctr/384-384/d9fab4b5` |

For 768 → 384: `seed = 0xd51802239c45ae456d69613f3a5a5c9b2e0ed63c76d236cf91b002f1bc89bf21`, and
`projectionMatrixDigest(768, 384) = 0xa5748f8da76fd64749a5ccc1e2ce9979bcec7a74cdcb800ecf17b5cc5be789ff`
(sha2-256 over the matrix's little-endian float64 bytes). Two nodes that disagree on that digest are
projecting into different subspaces, and every cross-node similarity they exchange is noise.

Every aligned vector, every index entry and every search response carries the `projectionId`. **Two
vectors may only be compared when their `projectionId` values are equal.** `similarity.rankMemories`
enforces this and emits a `projection_mismatch` skip rather than a number.

Bumping `PROJECTION_VERSION`, `PROJECTION_ALG`, `PROJECTION_PRNG` or `PROJECTION_SEED_LABEL` changes
every `projectionId`, which is the versioning mechanism.

### 7.5 Alignment cases

`alignEmbedding({embedding, targetDim})` has exactly three cases:

| Case                      | Behaviour                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sourceDim === targetDim` | No projection. The vector is L2-normalised and returned. This is a **no-op, not an alignment** — two different models that happen to share a dimension are still not comparable. |
| `sourceDim > targetDim`   | Deterministic Achlioptas projection, then L2 normalisation.                                                                                                                      |
| `sourceDim < targetDim`   | **Throws `DimensionMismatchError`.** There is no zero-padding path.                                                                                                              |

The v1 code zero-padded in the third case and returned the result as "aligned"; the cosine that
follows is then computed over arbitrary coordinate correspondences plus a block of zeros and has no
interpretation. The error message says so.

### 7.6 SimHash

`simhash(vector, bits = 256)` draws deterministic random hyperplanes from the same keystream
construction under seed `keccak256(utf8("neuromesh/projection/v1|simhash|<dim>|<bits>"))`, then emits
one bit per plane, most-significant bit first. `bits` must be a multiple of 8 and at least 8.
`hammingDistance` compares two equal-length signatures.

Published in place of the vector when `embeddingVisibility !== "public"`. Honestly: the bits still
leak coarse semantics. This is a privacy _improvement_ over publishing 384 floats, not a privacy
guarantee.

---

## 8. EIP-712 typed data

Source: `src/protocol/eip712.js`, transcribed from the deployed Solidity. **Field order is part of the
typehash** — the type string is built by concatenating fields in declaration order and the typehash is
its keccak256, so reordering a single line silently changes every digest and every signature stops
verifying on chain.

### 8.1 Domains — three, not one

The protocol does **not** use one shared EIP-712 domain. Each contract mixes in OpenZeppelin's
`EIP712` under its own name:

| Contract              | Domain name              | Version | Source                                      |
| --------------------- | ------------------------ | ------- | ------------------------------------------- |
| `AgentIdentity`       | `NeuroMeshAgentIdentity` | `1`     | `contracts/AgentIdentity.sol:88`            |
| `MemoryLedger`        | `NeuroMeshMemoryLedger`  | `1`     | `contracts/MemoryLedger.sol:127`            |
| `MemoryAccessControl` | `NeuroMeshAccessControl` | `1`     | `contracts/MemoryAccessControl.sol:108`     |
| `ReputationManager`   | **none**                 | —       | no `EIP712` mixin; `eip712Domain()` reverts |

Both `chainId` and `verifyingContract` are mandatory (OpenZeppelin's `EIP712` always includes them).
That binding is what stops a signature produced for the Sepolia ledger from being replayed against a
mainnet deployment, or against a different contract on the same chain.

### 8.2 The five signed structs

Type strings verbatim, with the typehashes computed from the live code and cross-checked against the
`keccak256("…")` literals in the contracts:

**`Registration`** — `AgentIdentity.registerAgentFor`, `contracts/AgentIdentity.sol:63-64`

```text
Registration(address agent,bytes32 publicKeyHash,bytes32 metadataURIHash,uint256 nonce,uint256 deadline)
typehash = 0xe26beaeac1093ef4abf34fe924b2e8901da1bf3f52ef2f26ba1153d4c6226013
```

**`KeyRotation`** — `AgentIdentity.rotateKeyFor`, `contracts/AgentIdentity.sol:67-68`

```text
KeyRotation(address agent,bytes32 publicKeyHash,uint256 nonce,uint256 deadline)
typehash = 0x42e4fec868f42b9b63174ebef878ed7171da35b37d973619402c0402c5dadd95
```

**`MemoryCommit`** — `MemoryLedger.commitMemoryFor`, `contracts/MemoryLedger.sol:80-83`

```text
MemoryCommit(address agent,bytes32 cidHash,bytes32 prevCidHash,bytes32 modelHash,uint32 embeddingDim,bool isEncrypted,uint256 nonce,uint256 deadline)
typehash = 0xd537da8d8ff1559f87f59432cd5ee7bd8772f0021831af2f900c1c805b36e15b
```

**`MemoryRevocation`** — `MemoryLedger.revokeMemoryFor`, `contracts/MemoryLedger.sol:86-87`

```text
MemoryRevocation(address agent,bytes32 cidHash,bytes32 reason,uint256 nonce,uint256 deadline)
typehash = 0x70ea8314b377ec34bdb94e724f95fdbd476011dea78d621167b1323a0c906d77
```

**`AccessGrant`** — `MemoryAccessControl.grantAccessFor`, `contracts/MemoryAccessControl.sol:67-70`

```text
AccessGrant(address owner,bytes32 cidHash,address grantee,bytes32 wrappedKeyHash,uint64 expiresAt,uint256 nonce,uint256 deadline)
typehash = 0x95c19433783b1cfd701b63cced7f4844b63f729f32da41c09e4bb1995569223e
```

There is deliberately **no `Endorsement` type**: `ReputationManager` has no `EIP712` mixin and no
signed entrypoint, so a JavaScript-side `Endorsement` struct would describe a signature that nothing
verifies.

### 8.3 Field hashing rules

Every variable-length value is pre-hashed into a `bytes32` by the caller, so no NeuroMesh struct
contains a nested struct, an array, a `string` or a `bytes` field. The hashing must match the contract
exactly:

| Field             | Computed as                                             | Note                                    |
| ----------------- | ------------------------------------------------------- | --------------------------------------- |
| `cidHash`         | `keccak256(utf8(cid))` — `ethers.id(cid)`               | matches `keccak256(bytes(input.cid))`   |
| `modelHash`       | `keccak256(utf8(model))` — `ethers.id(model)`           | matches `keccak256(bytes(input.model))` |
| `metadataURIHash` | `keccak256(utf8(metadataURI))` — `ethers.id(uri)`       | UTF-8 string hash                       |
| `publicKeyHash`   | `keccak256(publicKeyBytes)` — `ethers.keccak256(bytes)` | **raw bytes, not `ethers.id`**          |
| `wrappedKeyHash`  | `keccak256(wrappedKeyBytes)`                            | raw bytes                               |
| `prevCidHash`     | `bytes32` of the parent, or 32 zero bytes for a root    | passed through                          |

Passing a pre-hashed value where a string is expected — or vice versa — produces a digest the contract
disagrees with, and the call reverts `InvalidSignature(agent)`.

### 8.4 Digest computation and the tripwire

`digest(typed)` uses `ethers.TypedDataEncoder.hash`. `digestFromParts(typed)` computes the same value
from first principles:

```text
domainSeparator = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
    keccak256(name), keccak256(version), chainId, verifyingContract))

structHash      = keccak256(abi.encode(TYPEHASH, ...fields in declaration order))

digest          = keccak256(0x1901 ‖ domainSeparator ‖ structHash)
```

The second implementation exists to be _independent_: it walks the `TYPES` array in declaration order
and ABI-encodes each field exactly the way `MemoryLedger.hashCommit` does. A test asserts the two
agree, which is the tripwire that catches a transcription error in `TYPES` or `TYPE_STRINGS`.
`MemoryLedger.hashCommit(agent, input, nonce, deadline)` is a public view returning the exact digest
`commitMemoryFor` will verify, so a client can check its own construction against the chain.

### 8.5 Signature validity rules

- **Low-`s` only.** `assertCanonicalSignature` rejects `s > N/2`. secp256k1 signatures come in pairs
  `(r, s)` and `(r, N − s)` that both verify; OpenZeppelin's `ECDSA` accepts only the low half, so a
  high-`s` signature would be recoverable off chain and rejected on chain. Failing loudly is better
  than a silent divergence.
- **65 bytes, 0x-prefixed hex.** Anything else is `SIGNATURE_INVALID`.
- **Deadline.** `assertFresh` throws `DeadlineExpiredError` when `now > deadline`. On chain, the
  ledger additionally rejects a deadline further out than `Limits.MAX_SIGNATURE_VALIDITY` (30 days)
  with `DeadlineTooFar`.
- **Nonces.** Per-agent, per-contract, via OpenZeppelin `Nonces`. Replay protection within a
  deployment; the domain gives it across chains and deployments.
- **ERC-1271.** The contracts verify with `SignatureChecker`, so a smart-contract wallet can
  authorise. `contracts/mocks/ERC1271Wallet.sol` exercises that path in the test suite.

### 8.6 DIVERGENCE — the contracts do not match the earlier normative design spec

This is the largest known divergence in the project, and it is **an unresolved cross-lane conflict,
not a typo**. An earlier normative protocol specification (§4 of `spec-protocol.json`) fixes:

- **one** domain, `EIP712Domain{name: "NeuroMesh", version: "2"}`;
- a `bytes32 specHash` as the first member of every struct;
- `AgentRegistration` rather than `Registration`, with fields `didHash`, `encPubKey`, `keyVersion`,
  `metadataDigest`;
- `MemoryCommit` with `payloadHash`, `cidDigest`, `parentDigest`, `modelId`, `alignmentId`,
  `policyId`, and `uint64` nonce/deadline;
- `AccessGrant` with `grantor` (not `owner`), `scope` (not `cidHash`), `wrappedKeyDigest` (not
  `wrappedKeyHash`), `expiry` (not `expiresAt`), and no `deadline`;
- an `Endorsement` struct with `kind`, `weight`, `reasonCode`, `contextDigest`, `evidenceDigest`.

**None of that is what is deployed.** The contracts implement three per-contract domains and the
struct field sets transcribed in §8.2 — consistently, and the JavaScript in `src/protocol/eip712.js`
is transcribed from the _contracts_, so the system works end to end today. What breaks is any
third-party client written against the older design document: every such signature produces a
different digest and every `commitMemoryFor` / `registerAgentFor` / `grantAccessFor` call reverts
`InvalidSignature(agent)`.

The `KeyRotation` and `MemoryRevocation` structs have no counterpart in the older spec at all, and the
spec's `Endorsement` has no on-chain counterpart here.

**This document (§8.2) is the authority for what is deployed.** Reconciliation is tracked as NM-10 /
SEC-11 in [SECURITY-NOTES.md](./SECURITY-NOTES.md) and is a release gate for v2.1.

---

## 9. Third-party verification procedure

A stranger with no NeuroMesh software can check a memory record end to end using only an IPFS gateway,
an Ethereum RPC endpoint, keccak256, sha2-256 and AES-256-GCM. This is the procedure. Steps marked
**[blocked]** cannot be completed against the current contracts, and why is stated.

1. **Read the record.** Call `MemoryLedger.getMemoryByCid(cid)` — or `getMemory(cidHash)` with
   `cidHash = keccak256(utf8(cid))`. Confirm it exists and note `owner`, `committedAt`, `committedBy`,
   `prevCidHash`, `version`, `embeddingDim`, `isEncrypted`, `model` and `revoked`.
2. **Fetch the bytes.** `GET <gateway>/ipfs/<cid>`. Do not parse yet.
3. **Check canonicality.** Parse the bytes as JSON, re-serialise under the §2 rules, and assert the
   result is byte-identical to what you fetched. If not, reject: the payload cannot be reproduced.
4. **Recompute the CID.** `sha256(bytes)`, prefix `0x01 0x55 0x12 0x20`, base32-lower encode, prefix
   `b`. Assert it equals the `cid` you asked for. This is the step that removes the pinning service
   from the trust chain.
5. **Recompute `cidHash`.** `keccak256(utf8(cid))`. Assert it equals the ledger key you read.
6. **Validate the payload** against the §4 schema, including the two cross-field invariants.
7. **Check the declared model and dimension.** Assert `payload.model.dim` and
   `payload.alignment.dim` are consistent with the record's `embeddingDim`, and that
   `keccak256(utf8(record.model))` equals the `modelHash` that was signed.
8. **Check the encryption flag.** Assert `record.isEncrypted === (payload.cipher !== null)`.
9. **Verify the commit signature** — _for meta-transaction commits only._ Rebuild the `MemoryCommit`
   typed data from §8.2 under domain `("NeuroMeshMemoryLedger", "1", chainId, ledgerAddress)`, using
   the agent's nonce at the time of the commit, and confirm it recovers to `record.owner`.
   `MemoryLedger.hashCommit` gives you the digest to compare against.
   **[blocked for self-commits]** — a `commitMemory` call carries no signature. Its only authorisation
   is the transaction signature, and `committedBy === owner` is the whole proof. See §11.
10. **Reconstruct the AAD** from the payload's own fields (never from an echoed value) and verify the
    GCM tag if you hold a recipient key. `TAG_VERIFY_FAILED` here means the ciphertext is not bound to
    this `(agentDid, contentId, policyId, modelId, keyVersion)` tuple.
11. **Check the embedding digest.** If `visibility === "public"`, decode `embedding.data`, recompute
    `sha256(le-float32(vector))` and assert it equals `embedding.dataDigest`. If sealed, do the same
    check on the vector you decrypt.
12. **Reproduce the alignment.** Rebuild the projection matrix from §7.3 using the `fromDim`/`toDim`
    encoded in `alignment.projectionId`, and confirm the matrix digest matches
    `projectionMatrixDigest`. This proves you and the author are in the same subspace.
13. **Walk the version chain.** `MemoryLedger.getVersionChain(cidHash, maxDepth)` returns the chain
    leaf-first, bounded by `Limits.MAX_CHAIN_WALK` (512). Assert each parent exists, belongs to the
    same agent, is not revoked, and that `version` increments by one.
14. **Audit the weights.** **[blocked]** — the ledger stores a free-text `model` string capped at 64
    bytes, not a `modelId` bound to a weights digest, so nothing on chain pins which weights produced
    the vector. `payload.model.uri` carries a digest, but the chain never commits to it. Tracked as
    NM-11 / SEC-12.
15. **Recompute the trust score.** **[blocked]** — the on-chain score is a local heuristic
    (§10), not a reproducible off-chain computation. No `weight`, `reasonCode`, `contextDigest` or
    `evidenceDigest` is recorded, so the emitted events do not carry enough information to replay a
    canonical trust computation. Tracked as SEC-13.

Steps 1 through 8 and 10 through 13 are executable today against the v2 contracts. Steps 9 (partially),
14 and 15 are not, and that is a property of the current contracts rather than of the procedure.

---

## 10. Trust, decay and ranking

Two entirely separate systems live under the word "trust". They are not the same arithmetic and must
never be mixed.

### 10.1 On-chain reputation — consensus-critical, integer WAD

Source: `contracts/ReputationManager.sol`, `contracts/libraries/DecayMath.sol`.

**Endorsement weight.** A one-hop transitive weight, read live from the endorser's own reputation:

```text
w(i) = baseEndorserWeightWad + (maxEndorserWeightWad - baseEndorserWeightWad) * reputationOf(i) / WAD
w(i) = min(w(i), maxEndorserWeightWad)
```

A report by the same actor carries `w(i) * negativeMultiplierWad / WAD`.

**Score.**

```text
score(j) = P / (P + N + prior)        [WAD, bounded in [0, 1)]
```

where `P` and `N` are the time-decayed positive and negative evidence masses accumulated against `j`.
The score is monotone increasing in `P`, monotone decreasing in `N`, never truncates, and is directly
comparable across agents with very different endorser populations. `prior` is a Bayesian pseudo-count
representing "unknown".

**Default parameters** (constructor, `contracts/ReputationManager.sol:234-244`):

| Parameter               | Default         | Bound (`Limits`)                         |
| ----------------------- | --------------- | ---------------------------------------- |
| `halfLifeSeconds`       | `90 days`       | `1 hour … 3650 days`; `0` disables decay |
| `priorWad`              | `3e18` (3.0)    | `1e17 … 100e18`                          |
| `trustThresholdWad`     | `6e17` (0.6)    | —                                        |
| `negativeMultiplierWad` | `3e18` (3.0)    | `1e18 … 10e18`                           |
| `baseEndorserWeightWad` | `2.5e17` (0.25) | ≤ `2e18`                                 |
| `maxEndorserWeightWad`  | `1e18` (1.0)    | ≤ `2e18`                                 |
| `endorseCooldown`       | `1 day`         | ≤ 365 days                               |
| `reportCooldown`        | `1 day`         | ≤ 365 days                               |
| `actorCooldown`         | `1 hour`        | ≤ 365 days                               |
| `endorsementStakeWei`   | `0`             | —                                        |
| `stakeLockPeriod`       | `7 days`        | ≤ 365 days                               |

`isTrusted(a)` is `reputationOf(a) >= trustThresholdWad`.

**Decay is lazy.** Nothing ever loops over an agent's endorsers. Each agent carries
`(P, N, lastSettledAt)`; `_settle` multiplies both masses by the decay factor and moves the timestamp
forward. Views apply the same factor without writing, so a score decays correctly even if no
transaction touches the agent for a year. `settle` / `settleBatch` are permissionless upkeep.

**The decay factor, exactly.** `DecayMath.decayFactor(elapsed, halfLife)`:

```solidity
if (halfLife == 0 || elapsed == 0) return WAD;
uint256 halves = elapsed / halfLife;
if (halves >= 64) return 0;
uint256 f   = WAD >> halves;                              // exact, one opcode
uint256 idx = ((elapsed % halfLife) * 16) / halfLife;     // FLOOR into a 1/16 bucket
return Math.mulDiv(f, pow2NegSixteenths(idx), WAD);       // 16-entry table of 2^(-k/16)
```

The whole-half-life part is an exact right shift; the fractional part is quantised into one of sixteen
buckets from a precomputed table of `round(1e18 * 2^(-k/16))`.

> **DIVERGENCE — the library's own accuracy claim is wrong.** `DecayMath`'s NatSpec (line 24-25)
> states that it "always rounds DOWN" and that the "maximum relative error against true `2^-x` is
> below 0.15%". Both are false. `idx` **floors the exponent**, so the factor is the value at the
> bucket's _left_ edge, which is larger than the true value — decay is _under_-applied and scores are
> systematically **overstated**. The worst case is one full bucket:
> `2^(1/16) - 1 = 4.43%`, measured at 4.39–4.43% against the deployed `DecayMathHarness` with the
> production 90-day half-life. Concretely, `decayFactor(H/16 - 1, H)` returns exactly `1e18` — zero
> decay for the first 5.625 days of every half-life — where the true value is `0.9576e18`.
> This is 30× the documented figure and in the opposite rounding direction. Tracked as SEC-05 /
> NM-12. **Anyone sizing risk off the 0.15% figure is out by a factor of thirty.**

`Limits.satSub` clamps every mass subtraction at zero rather than reverting. Removing an edge subtracts
that edge's individually decayed weight from an aggregate decayed in a different bucketing frame, and
a governance half-life change re-frames past accruals entirely, so the recomputed amount can exceed
the aggregate by a few wei. A checked subtraction would permanently brick `revokeEndorsement` for that
pair. As an exactness anchor, removing the last endorsement (or report) zeroes the corresponding mass
outright, so residual drift cannot accumulate across cycles.

**Funds invariant.** There is deliberately no `receive()` and no `fallback()`, so the only way ether
enters the contract is `endorseAgent`. That makes
`treasuryBalance + sum(unclaimed stakes) == address(this).balance` a testable invariant.

### 10.2 Off-chain retrieval ranking — presentational, floating point

Source: `src/protocol/similarity.js`, parameters in `src/protocol/constants.js`.

**Trust calibration.** `calibrateTau(score, reference) = score / (score + reference)` maps an unbounded
reputation onto `tau` in `[0, 1)`. `reference` is conventionally the median non-zero score in the
population. This is a saturating map with no free parameters beyond the reference, so it does not need
re-tuning as absolute scores drift — which a fixed threshold would.

**The ranking score.**

```text
score = max(0, similarity) * (theta + (1 - theta) * tau^phi) * 2^(-ageDays / halfLife)
```

| Term                                 | Default    | Why                                                                                                                  |
| ------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| `max(0, similarity)`                 | —          | A negative cosine is an anti-match; clamped rather than allowed to flip the sign of the trust term                   |
| `theta` (`RANK_THETA`)               | `0.2`      | A **floor**. An agent with no reputation ranks low but stays reachable. Reputation re-ranks; it never gates          |
| `phi` (`RANK_PHI`)                   | `0.5`      | Concave, so the first units of reputation matter most and a very high score cannot dominate a genuinely better match |
| `halfLife` (`RECENCY_HALFLIFE_DAYS`) | `180` days | Exponential recency                                                                                                  |
| `tauMin` (`TAU_MIN`)                 | `0`        | Hard filter; disabled by default                                                                                     |

Floating point is deliberate and safe here: ranking is a presentation concern, and no two nodes must
agree on it bit for bit.

`rankMemories` applies two hard filters _before_ scoring — `projectionId` equality and `tauMin` — and
returns both `results` and a `skipped` list carrying the reason for every drop, so a mismatch is
visible rather than silently absorbed. Ties break on ascending `cid` so the ordering is total and
stable across processes.

`semanticSearch` is the pure-similarity variant: same projection filter, no trust term, no recency
term. Use it when you mean "nearest neighbours"; use `rankMemories` when you mean "what should I
show".

`cosineSimilarity` returns **0, not NaN**, when either vector has zero norm — a zero vector has no
direction, and propagating NaN through a ranking pipeline hides the problem instead of neutralising
it.

---

## 11. Honest limitations

Every item here is a property of the code as it stands. None is speculative.

### 11.1 Cryptography and privacy

1. **There is no zero-knowledge anything.** No circuit, prover, verifier contract, or ZK dependency.
   The protocol proves _that_ a memory was committed and never anything _about_ its content.
   Confidentiality comes from AES-256-GCM. That is a different property, and calling it ZK would be a
   category error.
2. **On-chain access revocation cannot recall a published envelope.** Once an ECIES-wrapped CEK is in
   an IPFS payload, anyone holding the matching key can decrypt it forever.
   `MemoryAccessControl.revokeAccess` stops _future_ grants and tells cooperating nodes to stop
   serving; it un-publishes nothing.
3. **`policy.redistribution` is advisory.** Nothing enforces it. A grantee who re-wraps the CEK for a
   third party breaks no mechanism.
4. **Published embeddings are close to published text.** `visibility: "public"` is documented as
   approximately equivalent to publishing the plaintext (Song and Raghunathan 2020; Morris et al.
   2023). `lsh-only` reduces the leak; it does not eliminate it.
5. **Metadata is public by construction.** The chain reveals who committed what CID, when, under which
   parent, with which model name and dimension, and who was granted access. The _content_ is
   confidential; the _social graph and activity pattern_ are not.
6. **The identity registry does not prove key ownership.** `publicKey` is a self-assertion with no
   proof of possession, so a registered agent can publish a key it does not hold.
7. **`zeroize` is best-effort.** V8 may have copied key bytes before the overwrite.

### 11.2 Semantics

8. **Cross-model similarity is reproducible, not meaningful.** The projection is deterministic and
   versioned; it does not align two independently trained encoders. Any cross-model cosine must be
   read against `noiseBaseline = 1/sqrt(384) = 0.051` before it is believed. No cross-model similarity
   matrix is published in this documentation set, because the historical one was noise.
9. **Same-dimension is a no-op, not an alignment.** Two 384-d models are still not comparable just
   because their dimensions match. `alignEmbedding` says so in its own comment.
10. **Nothing on chain pins the model weights.** `MemoryRecord.model` is a free-text string capped at
    64 bytes. A full `hf:<repo>@sha256:<64hex>` URI does not fit. So step 14 of §9 is unexecutable.

### 11.3 On-chain

11. **CID ownership is first-come-first-served on the self-commit path.** `commitMemory` takes
    ownership from `msg.sender`, records are keyed by the global `cidHash`, and a duplicate reverts
    `MemoryAlreadyExists`. An observer who sees a CID in the mempool or on a public pin list can
    front-run and permanently own another agent's memory. Revocation is a tombstone that never frees
    the key, so not even a moderator can recover it. `commitMemoryFor` is safe — ownership follows the
    recovered signer — but it is not the path the node uses. **Critical, unmitigated.** SEC-01 / NM-01.
12. **Endorsement stake is unslashable.** `slashEndorsement` requires a live edge; `revokeEndorsement`
    is permissionless, instant and ungated, so an endorser front-runs the slasher and recovers 100%.
    SEC-02 / NM-02.
13. **Reports are free, unstaked, permanent and unremovable.** One throwaway registered address
    destroys any agent's trusted status, and time does not heal it — because `_settle` applies the
    same factor to `P` and `N`, the ratio `P/(P+N+prior)` is decay-invariant. SEC-03 / NM-03.
14. **Decay is defeatable.** Anyone calling `settle(agent)` more often than once per `halfLife/16`
    (5.625 days at the default) freezes that agent's masses forever, because `_settle` advances
    `lastSettledAt` to `block.timestamp` unconditionally while `decayFactor` returned `WAD`.
    SEC-04 / NM-04.
15. **The documented sybil bar is wrong.** The contract header claims 18 distinct endorsers are needed
    to cross the trust line. `previewEndorsementWeight` reads the endorser's _live_ reputation and
    nothing normalises outgoing weight, so a mutually-endorsing clique bootstraps itself. The measured
    bound is **8 mutually-endorsing wallets**, at zero stake with default parameters. SEC-06 / NM-05.
16. **A suspended agent can self-reinstate.** `reactivate()` and `adminSetActive` write the same flag
    and `reactivate` has no notion of who suspended the agent, so a `REGISTRAR_ROLE` suspension is
    undone in the next transaction. SEC-07 / NM-06.
17. **`ReputationManager` has no meta-transaction path.** An agent with no ETH can register, commit
    and grant access gaslessly, but cannot endorse or report at all.
18. **The on-chain score is a local heuristic.** No outgoing-row normalisation, no teleport, no genesis
    set, no signed evidence edges. It should not be treated as a normative, independently
    recomputable protocol trust value. SEC-13.
19. **The deployed Sepolia addresses are pre-rewrite v1 contracts.** Their ABI does not match this
    specification. See [DEPLOYMENT.md](./DEPLOYMENT.md).

### 11.4 Documentation and conformance

20. **The deployed EIP-712 layout differs from the earlier normative design spec** — three domains
    rather than one, no `specHash`, different field names and types. §8.2 is the authority for what is
    deployed; §8.6 records the conflict. SEC-11 / NM-10.
21. **Two custom errors are unreachable.** `EmptyField` and `GrantExpired` are declared in
    `NeuroMeshErrors.sol` and raised by nothing. A client branching on `GrantExpired` will never see
    it. SEC-14.

The full list, grouped by severity with impact and planned remediation, is in
[SECURITY-NOTES.md](./SECURITY-NOTES.md). The adversary-by-adversary view is in
[THREAT_MODEL.md](./THREAT_MODEL.md).
