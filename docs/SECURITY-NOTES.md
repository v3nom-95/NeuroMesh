# Security Notes — Open Contract Findings

> **This is the honest-disclosure page.** Every finding below exists in the contracts as they stand
> in `contracts/`. None is fixed. They are disclosed here, in [PROTOCOL.md §11](./PROTOCOL.md#11-honest-limitations)
> and in the README rather than concealed.
>
> **The suite is testnet-only, unaudited, and must not hold mainnet value.**
>
> To report a _new_ vulnerability, follow [SECURITY.md](../SECURITY.md). Do not open a public issue.

---

## How these were found

Three independent adversarial reviews — an exploit lens, a correctness lens and a spec-fidelity lens
— audited the freshly written contract suite and returned **21 findings**: 1 critical, 7 high,
9 medium, 4 low.

Several issues were reported by more than one reviewer. After merging duplicates, **14 distinct
issues** remain, tracked here as `SEC-01` … `SEC-14`. The v2.1 execution plan in
[V2.1-HARDENING-PLAN.md](./V2.1-HARDENING-PLAN.md) tracks **12** work items (`NM-01` … `NM-12`),
because it folds SEC-13 into NM-10 and SEC-14 into NM-12 as parts of the same change. Both numbers
are correct; they count different things.

The critical finding was independently re-verified by hand against `contracts/MemoryLedger.sol`
before being accepted. It is not a false positive. Several findings were reproduced against a
deployed fixture with measured values, which are quoted below.

### Severity after deduplication

| Severity     | Count | Findings                                       |
| ------------ | ----: | ---------------------------------------------- |
| **Critical** |     1 | SEC-01                                         |
| **High**     |     6 | SEC-02, SEC-03, SEC-04, SEC-06, SEC-07, SEC-11 |
| **Medium**   |     5 | SEC-08, SEC-09, SEC-10, SEC-12, SEC-13         |
| **Low**      |     2 | SEC-05, SEC-14                                 |

### Why they are deferred

v2.0.0 delivered the backend, frontend, DevOps and documentation rewrite. Five of these fixes
(SEC-01, SEC-03, SEC-10, SEC-11, SEC-12) change **ABI-visible signatures**, so they must land as one
coherent contract release rather than racing the backend that transcribes those signatures. Shipping
them incrementally would mean redeploying and re-transcribing several times.

### What the tests do and do not cover

**223 Hardhat tests pass.** That is not in tension with this page: every finding below is a case the
suite does not exercise, and each entry says which test would have caught it.

---

## Index

| ID                                                                           | Sev      | Title                                                 | File                             | v2.1  |
| ---------------------------------------------------------------------------- | -------- | ----------------------------------------------------- | -------------------------------- | ----- |
| [SEC-01](#sec-01--critical--cid-front-running-through-the-self-commit-path)  | Critical | CID front-running through the self-commit path        | `MemoryLedger.sol:143`           | NM-01 |
| [SEC-02](#sec-02--high--endorsement-stake-is-unslashable)                    | High     | Endorsement stake is unslashable                      | `ReputationManager.sol:415`      | NM-02 |
| [SEC-03](#sec-03--high--reports-are-free-unstaked-permanent-and-unremovable) | High     | Reports are free, unstaked, permanent and unremovable | `ReputationManager.sol:317`      | NM-03 |
| [SEC-04](#sec-04--high--decay-is-defeatable-by-frequent-settling)            | High     | Decay is defeatable by frequent settling              | `ReputationManager.sol:768`      | NM-04 |
| [SEC-05](#sec-05--low--decaymath-natspec-understates-its-own-error-by-30)    | Low      | DecayMath NatSpec understates its own error by ~30×   | `DecayMath.sol:25`               | NM-12 |
| [SEC-06](#sec-06--high--the-documented-sybil-bar-is-8-wallets-not-18)        | High     | The documented sybil bar is 8 wallets, not 18         | `ReputationManager.sol:77`       | NM-05 |
| [SEC-07](#sec-07--high--a-suspended-agent-can-self-reinstate)                | High     | A suspended agent can self-reinstate                  | `AgentIdentity.sol:195`          | NM-06 |
| [SEC-08](#sec-08--medium--pausing-freezes-every-endorsement-stake)           | Medium   | Pausing freezes every endorsement stake               | `ReputationManager.sol:295, 386` | NM-08 |
| [SEC-09](#sec-09--medium--an-expired-grant-blocks-re-granting)               | Medium   | An expired grant blocks re-granting                   | `MemoryAccessControl.sol:304`    | NM-07 |
| [SEC-10](#sec-10--medium--withdrawtreasury-ignores-the-treasury-variable)    | Medium   | `withdrawTreasury` ignores the `treasury` variable    | `ReputationManager.sol:433`      | NM-09 |
| [SEC-11](#sec-11--high--on-chain-eip-712-does-not-match-the-normative-spec)  | High     | On-chain EIP-712 does not match the normative spec    | 3 files                          | NM-10 |
| [SEC-12](#sec-12--medium--verification-binding-fields-are-not-recorded)      | Medium   | Verification-binding fields are not recorded          | `MemoryLedger.sol:415`           | NM-11 |
| [SEC-13](#sec-13--medium--signed-evidence-edges-are-unimplemented)           | Medium   | Signed evidence edges are unimplemented               | `ReputationManager.sol:257`      | NM-10 |
| [SEC-14](#sec-14--low--two-custom-errors-are-unreachable)                    | Low      | Two custom errors are unreachable                     | `NeuroMeshErrors.sol:59, 193`    | NM-12 |

---

# Critical

## SEC-01 · Critical · CID front-running through the self-commit path

**File:** `contracts/MemoryLedger.sol:143` (`commitMemory` → `_commit`) · **v2.1:** NM-01
**Reported by two reviewers independently, once as critical and once as high.**

### What is wrong

The rewrite exists partly to fix this, and it is fixed **only on the meta-transaction path**.
`commitMemoryFor` takes ownership from the recovered EIP-712 signer, so front-running it is inert.
`commitMemory` takes ownership from `msg.sender`, records are keyed by the **global** `cidHash`, and
`_commit` reverts `MemoryAlreadyExists` on any duplicate. **`commitMemory` is the path the node
actually uses.**

The contract header at lines 38–49 claims "front-running is inert". That is true only of
`commitMemoryFor`.

### Reproduced

```text
agentA is about to commit CID "QmVictimCidValueHere12345".
The CID is public the instant it is pinned — Pinata's public gateway, the pin-list
API, and the pending transaction in the mempool all expose it.

agentB (any registered, active agent) submits
  commitMemory({ cid: "QmVictimCidValueHere12345", ... })
at a higher gas price.

Result:  getMemory(keccak256(cid)).owner == agentB
         agentA's own commit reverts MemoryAlreadyExists — forever.
```

### Impact

- The squatter **permanently** holds the on-chain provenance record for someone else's memory.
- Recovery is impossible by construction. `revokeMemory` is owner-only, and `_revoke` is a tombstone
  that is never deleted, so the `cidHash` is never freed — **not even `MODERATOR_ROLE` can return it
  to the true author.**
- The squatter becomes the only party who can grant decryption access through
  `MemoryAccessControl`, because `_grant` reads ownership from the ledger (line 296).
- This defeats the protocol's central proof-of-ownership claim.

### Why the tests miss it

Every fixture and the backend use the self-commit path; no test attempts a competing commit of the
same CID from a second agent.

### Planned remediation (NM-01)

Commit–reveal:

```text
precommit(bytes32 blindedHash)   // blindedHash = keccak256(abi.encode(cidHash, agent, salt))
                                 // leaks nothing about the CID
commitMemory(input, salt)        // requires a matching precommit from msg.sender,
                                 // at least MIN_PRECOMMIT_DELAY old
```

An attacker cannot forge an earlier precommit for a CID first seen at reveal time.

**Alternatives considered.** (a) Delete `commitMemory` so every commit carries an EIP-712
authorisation — simpler, but forces a signature round-trip for the common case. (b) Key records by
`keccak256(abi.encode(agent, cidHash))` so two agents can each record a claim over the same bytes and
_block order_, not transaction order, decides priority — a cheaper partial mitigation.

**ABI impact:** additive `precommit` plus a new `salt` parameter on `commitMemory` — **breaking**.
**Effort:** M.
**Tests required:** a front-run attempt reverts; honest precommit→reveal succeeds; reveal before
`MIN_PRECOMMIT_DELAY` reverts; salt reuse reverts.

### Operational mitigation available today

Use `commitMemoryFor` with a relayer instead of `commitMemory`, and do not publish a CID before the
commit transaction is confirmed. Neither is enforced by the contract.

---

# High

## SEC-02 · High · Endorsement stake is unslashable

**File:** `contracts/ReputationManager.sol:415` (`slashEndorsement`) · **v2.1:** NM-02

### What is wrong

`slashEndorsement` requires a **live** edge:

```solidity
if (e.createdAt == 0 || e.revokedAt != 0) revert NotEndorsed(from, to);
```

but `revokeEndorsement` (line 295) is permissionless, instant, and has no cooldown gate of its own.
`claimStake` (line 386) then needs only `revokedAt + stakeLockPeriod`.

### Reproduced

```text
paramAdmin sets endorsementStakeWei = 1 ether
agentA endorses agentB, escrowing 1 ETH
slasher broadcasts slashEndorsement(agentA, agentB, "fraud")
agentA sees it in the mempool and lands revokeEndorsement(agentB, "run away") first

  -> the slasher's transaction reverts NotEndorsed
  -> 7 days later agentA calls claimStake(agentB) and recovers the full 1 ETH
     measured 1.000956 ETH gross of gas refunds
     treasuryBalance() == 0, stakeClaimed == true, slashed == false
```

### Impact

The stake mechanism, `SLASHER_ROLE` and `stakeLockPeriod` provide **no economic security**. No
endorser ever loses a stake unless it fails to watch the mempool. `stakeLockPeriod` is documented as
a "post-revocation stake lock", which only makes sense if slashing survives revocation — it does not.

### Planned remediation (NM-02)

Make revoked-but-unclaimed edges slashable:

```solidity
if (e.createdAt == 0 || e.slashed || e.stakeClaimed) revert NotEndorsed(from, to);
// only run _removeEndorsement when e.revokedAt == 0 — an already-revoked edge has had its
// mass and endorserCount removed, so re-running teardown would double-decrement
e.slashed = true;
treasuryBalance += e.stake;
```

`claimStake` already refuses a slashed edge, so the lock window becomes the slasher's real challenge
period.

**ABI impact:** none. **Effort:** S.
**Tests required:** revoke-then-slash still confiscates; `claimStake` refuses a slashed edge;
`endorserCount` is not double-decremented.

**Live risk today:** low. `endorsementStakeWei` defaults to `0`, so no stake exists to steal. The
risk materialises the moment staking is enabled.

---

## SEC-03 · High · Reports are free, unstaked, permanent and unremovable

**File:** `contracts/ReputationManager.sol:317` (`reportAgent`) · **v2.1:** NM-03
**The cheapest attack in the system.**

### What is wrong

`reportAgent` requires only that the reporter be a registered, active agent. Registration in
`AgentIdentity` is permissionless and free. `endorsementStakeWei` applies **exclusively** to
`endorseAgent` (line 279). And no role can undo a report: `SLASHER_ROLE` covers `slashEndorsement`
only, `MODERATOR_ROLE` and `REGISTRAR_ROLE` have no equivalent, and `withdrawReport` (line 355) is
callable solely by the reporter.

### Reproduced

```text
Start:  a legitimately trusted agent, score 0.6167, isTrusted() == true
Action: ONE previously unused registered address calls reportAgent(victim, "spam")
        msg.value irrelevant — endorsementStakeWei() == 0
Result: score 0.5628, isTrusted() == false — permanently
```

**Time does not heal it.** `_settle` and `_currentMasses` apply the _identical_ decay factor to `P`
and `N`, so the ratio `P/(P+N+prior)` is **decay-invariant**. Simulating three further years leaves
the agent at 0.00036 — still untrusted.

### Impact

The asymmetry is the exploit:

| Action               | Cost                                                |
| -------------------- | --------------------------------------------------- |
| Cross the trust line | 8 coordinated identities, ~56 transactions (SEC-06) |
| Remove it            | **1 identity, 1 transaction**                       |

`negativeMultiplierWad = 3.0` means each free report cancels three endorsements. With ~30 throwaway
identities (`N = 22.5`) the victim would need `P >= 38.25`, i.e. 39 maximum-weight endorsers — which
is unreachable. **That is a permanent, unappealable reputational kill for the price of about 60 cheap
transactions**, and a direct extortion primitive against any agent whose operation depends on
`isTrusted`.

### Planned remediation (NM-03)

1. Add `reportStakeWei` and require `msg.value == reportStakeWei` in `reportAgent`, escrowed on the
   `Report` struct with the same claim/lock/slash lifecycle as endorsements.
2. Add `slashReport(address from, address to, bytes32 reason)` under `SLASHER_ROLE`, running the
   negative-mass teardown and confiscating the report stake, so a proven sybil report ring can
   actually be dismantled.
3. Consider weighting reports by the reporter's own accumulated **positive mass** rather than by
   `previewEndorsementWeight`, so a zero-history address carries near-zero negative weight.
4. Consider report expiry, so stale reports decay out.

**ABI impact:** additive, and `reportAgent` becomes `payable` — **breaking**. **Effort:** M.
**Tests required:** an unstaked report reverts; a slashed report restores the target's score; expiry.

---

## SEC-04 · High · Decay is defeatable by frequent settling

**File:** `contracts/ReputationManager.sol:768` (`_settle`) · **v2.1:** NM-04

### What is wrong

`DecayMath.decayFactor` quantises to 1/16-half-life buckets, so it returns `WAD` — _no decay at all_
— for any elapsed time under `halfLife/16`. At the 90-day default that is **5.625 days**.

`_settle` nevertheless sets `_lastSettledAt[agent] = block.timestamp` **unconditionally**, throwing
away the elapsed time the quantised factor did not consume. Settling faster than one bucket therefore
freezes an agent's masses forever.

### Reproduced

```text
agentA endorses agentB and agentC (P = 0.25e18 each).
90 days elapse. During that time settle(agentB) is called every 5 days
(18 calls — permissionless, no role required). agentC is untouched.

  agentB  P = 250000000000000000  (unchanged)  reputationOf = 0.0769e18
  agentC  P = 125000000000000000  (one exact half-life)  reputationOf = 0.0400e18
```

### Impact

- **Griefing:** anyone can call `settle(x)` ~65 times a year to pin a reported agent's _negative_
  mass so its reputation can never recover.
- **Favouritism:** the same trick pins a favoured agent's _positive_ mass so it never ages out.
- **Passive failure:** `_settle(target)` runs inside every `endorse` / `report` / `revoke` /
  `withdraw` / `slash` aimed at that target, so **any agent receiving trust activity more often than
  every 5.6 days never decays at all.**

`IReputationManager` promises "decay applied as of `block.timestamp`" and the header promises a real
90-day half-life. Neither holds.

### Why the tests miss it

`test/contracts/ReputationManager.decay.spec.js` never re-settles inside a bucket — it jumps a whole
half-life, then settles once.

### Planned remediation (NM-04)

Advance the settle clock only by the time the quantised factor actually consumed, carrying the
residual forward:

```solidity
uint256 hl = halfLifeSeconds;
uint256 applied = hl == 0
    ? dt
    : (dt / hl) * hl + ((((dt % hl) * 16) / hl) * hl) / 16;
_lastSettledAt[agent] = uint64(last + applied);
```

The residual (`< hl/16`) is preserved, so successive settles compose to exactly the same factor as
one long settle. `_currentMasses` needs no change.

Note that `test/contracts/ReputationManager.decay.spec.js:139` asserts `last == now` after settle and
must become `last <= now`.

**ABI impact:** none. **Effort:** S.
**Tests required:** 100 rapid settles decay identically to one settle over the same total interval.

---

## SEC-06 · High · The documented sybil bar is 8 wallets, not 18

**File:** `contracts/ReputationManager.sol:77-82` (header NatSpec) · **v2.1:** NM-05
**Reported three times: once high, twice medium.**

### What is wrong

The header states:

> With `trustThresholdWad = 0.6` and `priorWad = 3.0`, crossing the trust line requires `P >= 4.5`.
> Each fresh, zero-reputation endorser contributes only 0.25, so an attacker needs **18 DISTINCT
> endorsers**.

That arithmetic assumes every endorser _stays_ at weight 0.25. But `previewEndorsementWeight`
(line 509) reads the endorser's **own live reputation**, and nothing normalises an endorser's
outgoing weight. A mutually-endorsing clique therefore bootstraps its own weights before endorsing
the target.

### The real fixed point

For a clique of `n` mutual endorsers:

```text
w = base + (max − base) · r
P = (n − 1) · w
r = P / (P + prior)
```

At default parameters (`base = 0.25`, `max = 1.0`, `prior = 3.0`), `n = 8` gives `w = 0.720`,
`P = 5.04`, `r = 0.627 >= 0.6`.

### Reproduced

```text
9 freshly registered addresses each endorse the other 8 (one round, spaced past the
1-hour actor cooldown). previewEndorsementWeight rises 0.25e18 -> 0.678e18.
Each then endorses the target once.

  target: P = 6.003e18, reputationOf = 0.667, endorserCount = 9, isTrusted() == true

Cliques of 5/6/7 reach 0.453 / 0.523 / 0.580 and stay untrusted.
An 8-address clique with two revoke/re-endorse ratchet rounds reaches ~0.62 for
every member — revokeEndorsement has no cooldown of its own and re-prices the frozen
edge weight at the endorser's now-higher reputation.

Cost: 8 free registrations, ~56-170 transactions, ZERO stake at default settings,
      spread over about 3 days of cooldown waiting.
```

### Impact

An operator sizing anti-sybil defences off the documented 18-endorser figure **over-estimates the
attack cost by more than 2×**. The 18-endorser number is the security claim the whole rewrite is
justified by. The refresh loop additionally lets a ring hold its score indefinitely against the
90-day decay.

### Why the tests miss it

`test/contracts/ReputationManager.spec.js:455` endorses only from _fresh_ wallets and never
constructs a clique.

### Planned remediation (NM-05)

Either implement the specified **outgoing-row normalisation** — cap an endorser's total outgoing
weight at `w(i)` and split it across its targets, so endorsement spam is self-defeating — **or**, at
minimum:

- freeze re-endorsement weight: `weight = min(previewEndorsementWeight(from), previousEdgeWeight)`
  for a pair that has been endorsed before;
- compute the endorser's contribution from a **lagged/settled** reputation that excludes edges inside
  the same clique;
- or discount the boost quadratically: `w = base + (max − base) · r²/WAD`;
- or set `endorsementStakeWei > 0` at deployment so a ring costs capital rather than gas.

Whichever is chosen, **the "SYBIL ARITHMETIC" block must be recomputed with the transitive term
included**, and the honest limitation stated: this is a trust-graph-resistant design, not a
sybil-proof one.

**ABI impact:** none (behaviour plus documentation). **Effort:** L — this is a trust-model change,
not a patch.
**Tests required:** the existing 18-wallet test must be joined by an 8-wallet clique test asserting
the target does **not** become trusted.

---

## SEC-07 · High · A suspended agent can self-reinstate

**File:** `contracts/AgentIdentity.sol:195` (`reactivate`) · **v2.1:** NM-06

### What is wrong

`adminSetActive` and `reactivate` write the **same single `active` flag**, and `reactivate` checks
only `exists && !active` — it has no notion of _who_ deactivated the agent.

### Reproduced

```text
admin (REGISTRAR_ROLE) calls adminSetActive(agentA, false, "abuse")
  -> agentA's commitMemory reverts AgentInactive
agentA calls identity.reactivate() in the very next transaction
  -> isActive(agentA) == true
  -> the identical commitMemory now SUCCEEDS and records agentA as owner
```

### Impact

**Moderation is unenforceable.** The same one-transaction escape re-enables endorsing and reporting
in `ReputationManager` and being granted access in `MemoryAccessControl`.

Two documented guarantees are void:

- `Roles.sol:41-43` advertises `REGISTRAR_ROLE` as the role that "may suspend or reinstate an agent".
- `AgentIdentity.sol:206-208` justifies leaving `adminSetActive` un-pause-gated as the operator's
  incident tool.

Both hold only until the suspended agent sends one transaction.

### Why the tests miss it

`test/contracts/AgentIdentity.spec.js:528-573` tests each path in isolation, never in sequence.

### Planned remediation (NM-06)

Record the authority of the last status change — add `bool suspendedByRegistrar` to the `Agent`
struct, or store `address statusChangedBy` — set it in `adminSetActive`, and have `reactivate()`
revert with a new `SuspendedByRegistrar(address)` error while it is set. Only
`adminSetActive(agent, true, reason)` clears it.

**ABI impact:** additive error plus a struct field. **Effort:** S.
**Tests required:** a registrar-suspended agent cannot self-reinstate and remains blocked from
`commitMemory`; a self-deactivated agent still can.

---

## SEC-11 · High · On-chain EIP-712 does not match the normative spec

**Files:** `MemoryLedger.sol:82,127`, `AgentIdentity.sol:88`, `MemoryAccessControl.sol:108` ·
**v2.1:** NM-10
**Reported twice: once high, once medium.**

### What is wrong

An earlier normative protocol specification fixes **one** domain, `("NeuroMesh", "2")`, with a
`bytes32 specHash` as the first member of every struct and a specific set of field names. The
contracts implement **three per-contract domains** and different struct field sets.

|                                   | Normative spec                                                                                                                                                                                                            | Implemented                                                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain                            | one: `("NeuroMesh", "2")`                                                                                                                                                                                                 | three: `("NeuroMeshAgentIdentity","1")`, `("NeuroMeshMemoryLedger","1")`, `("NeuroMeshAccessControl","1")`                                                     |
| `specHash` member                 | on every struct                                                                                                                                                                                                           | **absent everywhere**                                                                                                                                          |
| Registration                      | `AgentRegistration(bytes32 specHash, address agent, bytes32 didHash, bytes encPubKey, uint32 keyVersion, bytes32 metadataDigest, uint64 nonce, uint64 deadline)`                                                          | `Registration(address agent, bytes32 publicKeyHash, bytes32 metadataURIHash, uint256 nonce, uint256 deadline)`                                                 |
| Commit                            | `MemoryCommit(bytes32 specHash, address agent, bytes32 payloadHash, bytes32 cidDigest, bytes32 parentDigest, bytes32 modelId, bytes32 alignmentId, bytes32 policyId, uint32 embeddingDim, uint64 nonce, uint64 deadline)` | `MemoryCommit(address agent, bytes32 cidHash, bytes32 prevCidHash, bytes32 modelHash, uint32 embeddingDim, bool isEncrypted, uint256 nonce, uint256 deadline)` |
| Grant                             | `AccessGrant(bytes32 specHash, address grantor, address grantee, bytes32 scope, bytes32 wrappedKeyDigest, uint32 granteeKeyVersion, uint64 expiry, uint64 nonce)`                                                         | `AccessGrant(address owner, bytes32 cidHash, address grantee, bytes32 wrappedKeyHash, uint64 expiresAt, uint256 nonce, uint256 deadline)`                      |
| `KeyRotation`, `MemoryRevocation` | **no counterpart**                                                                                                                                                                                                        | implemented                                                                                                                                                    |
| `Endorsement`                     | specified                                                                                                                                                                                                                 | **no counterpart** (see SEC-13)                                                                                                                                |

The trust model diverges too: the spec mandates a `DECAY[e]` lookup with `EPOCH = 86400 s` and
`HALF_LIFE_EPOCHS = 30`, Beta/Jøsang local trust `c_ij = (s+WAD)/(s+f+2·WAD)`, per-edge
`raw_ij = max(0, s − 3f)` with row normalisation and damped EigenTrust off chain. The contract
implements `P/(P+N+prior)` with a 90-day half-life instead.

### Impact

**The system works end to end today**, because `src/protocol/eip712.js` is transcribed from the
_contracts_, not from the document, and `src/abi/typehashes.json` pins the values. What breaks is
**every third-party client written against the specification**: each such signature produces a
different digest, and every `commitMemoryFor` / `registerAgentFor` / `grantAccessFor` call reverts
`InvalidSignature(agent)` — 100% of the time.

An earlier implementer report claimed "EIP-712 domains and type strings match spec-protocol.json
exactly". **That claim is false**, and a reader of only that report would ship a backend whose
signatures are rejected. It is corrected here.

### Planned remediation (NM-10)

**This is an unresolved cross-lane conflict, not a typo, and it needs arbitration before either side
ships.** Two coherent options:

- **(a) Adopt the spec verbatim.** One domain `("NeuroMesh","2")`, add `specHash` to every struct,
  rename `Registration` → `AgentRegistration`, `owner` → `grantor`, `expiresAt` → `expiry`,
  `cidHash` → `scope`, `wrappedKeyHash` → `wrappedKeyDigest`, narrow nonce/deadline to `uint64`, and
  key `MemoryLedger` on `cidDigest`/`payloadHash` rather than on `keccak256(cid string)`. **Preferred**,
  because no external client is deployed yet and interoperability is the point.
- **(b) Amend the specification** to the three-domain, per-contract typed data actually implemented,
  and have every client generate its signer from the deployed `*_TYPEHASH()` getters and
  `eip712Domain()` rather than from the document.

Whichever is chosen, add a test asserting each typehash equals `ethers.id(<the chosen spec's exact
type string>)`.

**Until it is resolved, [PROTOCOL.md §8](./PROTOCOL.md#8-eip-712-typed-data) is the authority for
what is deployed.**

**ABI impact:** all typehashes change — **breaking for every existing signature**. **Effort:** M.

---

# Medium

## SEC-08 · Medium · Pausing freezes every endorsement stake

**File:** `contracts/ReputationManager.sol:295, 386` · **v2.1:** NM-08
**Reported twice, both medium.**

`NeuroMeshGuarded.sol:24-28` and `ReputationManager.sol:381-384` both state that `claimStake` is
deliberately left un-pause-gated because "user funds must remain withdrawable during an incident".
But `claimStake` requires `e.revokedAt != 0` (line 390), and the only way to set `revokedAt` for
one's own edge is `revokeEndorsement` — which carries `whenNotPaused` (line 295).

**Reproduced** with `setEndorsementStake(1 ether)`: agentB endorses agentA with 1 ETH escrowed;
`PAUSER` pauses; `revokeEndorsement` reverts `EnforcedPause` and `claimStake` reverts
`StakeLocked(type(uint256).max, now)`. The 1 ETH is unreachable.

**Impact.** Every endorser who has not already revoked — the normal state of a live endorsement — is
locked out of its escrow for the entire, unbounded, admin-controlled duration of the pause, plus a
further `stakeLockPeriod`. A single `PAUSER_ROLE` hot key — documented as "deliberately the least
powerful role — it cannot move funds" — can hold every endorser's escrow hostage indefinitely, since
`unpause` is the only exit and there is no timelock on the pause. This is exactly the property the
documentation says is guaranteed.

The pause tests assert the `claimStake` exemption in isolation and never test the escrow-exit path
end to end.

**Remediation (NM-08).** Drop `whenNotPaused` from `revokeEndorsement` — it is _strictly
restrictive_, removing positive mass and never creating protocol state, exactly like the already
exempt `AgentIdentity.deactivate` — or add a pause-exempt `emergencyExitStake(address target)` that
revokes the edge and starts the lock. Update the pause-exemption NatSpec in `NeuroMeshGuarded.sol`
accordingly. **ABI impact:** none or additive. **Effort:** S.
**Tests:** stake, pause, and successfully exit.

**Live risk today:** low — `endorsementStakeWei` defaults to `0`.

---

## SEC-09 · Medium · An expired grant blocks re-granting

**File:** `contracts/MemoryAccessControl.sol:304` (`_grant`) · **v2.1:** NM-07

`_grant` rejects a new grant with `if (g.exists && g.revokedAt == 0) revert AccessAlreadyGranted(...)`,
**ignoring `g.expiresAt`**, while `canAccess` (line 221) treats the same grant as inactive once
`block.timestamp >= expiresAt`. The two disagree.

**Reproduced:** agentA grants agentB access to `m1` with `expiresAt = now + 100`. After 200 seconds
`canAccess(m1, agentB) == false`, yet
`access.connect(agentA).grantAccess(m1, agentB, key, 0)` reverts `AccessAlreadyGranted`.

**Impact.** The owner cannot re-share a memory with a grantee whose time-boxed grant has lapsed
without first issuing a `revokeAccess` on a grant that is already inactive — which emits a
**misleading `AccessRevoked` event into the authoritative log**. The stored envelope also survives
expiry (`getWrappedKey` still returns it while `canAccess` says false), so "expired" is a third,
undocumented state that neither the grant path nor the key getter recognises.

**Remediation (NM-07).** Make the activity test in `_grant` match `canAccess`:

```solidity
bool live = g.exists && g.revokedAt == 0 && (g.expiresAt == 0 || block.timestamp < g.expiresAt);
if (live) revert AccessAlreadyGranted(cidHash, grantee);
```

Keep the `if (!g.exists)` index-push guard as is, so re-granting still does not duplicate index
entries. For consistency, also reject expired grants in `getWrappedKey`, using the
already-declared-but-unused `GrantExpired` error — which would additionally make that error reachable
(SEC-14). **ABI impact:** none. **Effort:** S.

---

## SEC-10 · Medium · `withdrawTreasury` ignores the `treasury` variable

**File:** `contracts/ReputationManager.sol:433` · **v2.1:** NM-09

`treasury` is written in the constructor (line 228) and by `setTreasury` (line 685) — gated on
`DEFAULT_ADMIN_ROLE` rather than `PARAM_ADMIN_ROLE` precisely because the NatSpec calls it "a
funds-adjacent decision" — but **it is never read by any code path.** `slashEndorsement` credits a
bare `treasuryBalance` counter (line 422), and `withdrawTreasury(address to, uint256 amount)`
validates only `to != address(0)` and `amount <= treasuryBalance`.

**Impact.** A multisig grants `TREASURER_ROLE` to an operational key and relies on `setTreasury`
(which only it can call) to constrain where confiscated stake can go. **That belief is false.** A
compromised or rogue `TREASURER` key calls `withdrawTreasury(attackerEOA, treasuryBalance())` and
drains 100% of slashed ether in one transaction — no timelock, no destination check, and a
`TreasuryUpdated` audit trail pointing at an address that was never involved. `Roles.sol` reinforces
the wrong mental model by describing `TREASURER_ROLE` purely as withdrawal of treasury funds.

**The current half-state is the dangerous one, because it advertises a control that does not exist.**

**Remediation (NM-09).** Either enforce the invariant —
`if (to != treasury) revert InvalidParameter(bytes32("to"), uint256(uint160(to)));`, or drop the `to`
parameter entirely and always send to `treasury` — **or** delete `treasury` / `setTreasury` /
`TreasuryUpdated` and document plainly that `TREASURER_ROLE` has unrestricted spending authority over
slashed stake. **ABI impact:** signature change — **breaking**. **Effort:** S.

---

## SEC-12 · Medium · Verification-binding fields are not recorded

**File:** `contracts/MemoryLedger.sol:415` · **v2.1:** NM-11

The protocol requires the ledger to store `payloadHash = keccak256(jcsBytes)`,
`cidDigest = sha256(jcsBytes)`, `modelId = keccak256(utf8(canonicalModelURI))`, `alignmentId` and
`policyId`. **`MemoryRecord` carries none of them.** It stores a caller-supplied `string cid`
validated only for length 8–100 (line 415) and a free-text `string model` capped at 64 bytes
(line 416).

**Impact.** A stranger executing the third-party verification procedure fetches the bytes at the CID
and recomputes `sha256` and `keccak256` — then **has nothing on chain to compare them against**. The
record's `cid` is a self-asserted string that the contract never relates to any bytes, so a record
naming a CID whose content was authored by somebody else, or which was never pinned, is
indistinguishable from a correct one.

`model` pins no weights digest — a full `hf:<repo>@sha256:<64hex>` URI does not even fit in 64 bytes
— so the embedding audit is unexecutable. These are steps 9 and 14 of
[PROTOCOL.md §9](./PROTOCOL.md#9-third-party-verification-procedure), marked **[blocked]** there.

**Remediation (NM-11).** Extend `MemoryInput` / `MemoryRecord` with `bytes32 payloadHash`,
`bytes32 cidDigest`, `bytes32 modelId`, `bytes32 alignmentId`, `bytes32 policyId`; include them in
`MEMORY_COMMIT_TYPEHASH` and the `MemoryCommitted` event; and key records by `cidDigest` rather than
by keccak of a CID string, so the on-chain record is bound to bytes a verifier can recompute. If the
CID string is kept, document it as a **non-authoritative convenience field**. Bundle with SEC-11's
breaking change. **ABI impact:** breaking. **Effort:** M.

---

## SEC-13 · Medium · Signed evidence edges are unimplemented

**File:** `contracts/ReputationManager.sol:257` · **v2.1:** folded into NM-10

The specification defines
`Endorsement{bytes32 specHash; address from; address to; uint8 kind; uint8 weight; uint8 reasonCode; bytes32 contextDigest; bytes32 evidenceDigest; uint64 nonce; uint64 deadline}`
and says the chain stores _signed evidence edges_ as the inputs to an off-chain, bit-reproducible
damped EigenTrust published as a Merkle root.

**`ReputationManager` does not inherit `EIP712` or `Nonces` at all.** `endorseAgent` (line 257) and
`reportAgent` (line 317) authorise purely from `msg.sender`, and none of `weight`, `reasonCode`,
`contextDigest` or `evidenceDigest` exists on chain.

**Two concrete consequences.**

1. An agent with no ETH can register, commit and grant access through the three `…For`
   meta-transaction paths, but **cannot endorse or report at all** — there is no relayer path in this
   contract.
2. A canonical off-chain reputation computation **cannot be written against the emitted events**,
   because the specified `s_ij = Σ mulWad(weight_k·WAD/100, DECAY[age_k])` has no `weight_k` and no
   `reasonCode` to read. The contract's own `isTrusted` comes from a model (per-agent
   `P/(P+N+prior)`, no outgoing-row normalisation, no teleport, no genesis set) that no spec-conformant
   recomputation can reproduce, so any input-commitment replay would disagree with the contract **by
   construction**.

**Remediation.** Add `endorseAgentFor` / `reportAgentFor` taking the specified `Endorsement` struct
plus an EIP-712 signature verified with `SignatureChecker` and OpenZeppelin `Nonces`, and persist
`reasonCode`, `contextDigest` and `evidenceDigest` in the edge and the event. Separately, either
implement outgoing-row normalisation on chain **or** rename and demote `isTrusted` / `reputationOf`
in NatSpec to "local heuristic, not the normative protocol score", so consumers stop treating it as
one. **ABI impact:** additive plus a NatSpec correction. **Effort:** M.

---

# Low

## SEC-05 · Low · DecayMath NatSpec understates its own error by ~30×

**File:** `contracts/libraries/DecayMath.sol:25` · **v2.1:** NM-12
**Reported three times, all low.**

Line 24-25 promises two things, and **both are wrong**:

> "Always rounds DOWN, so aggregate decayed mass can never exceed the sum of its parts."
> "Maximum relative error against true `2^-x` is below 0.15%."

`decayFactor` computes `idx = ((elapsed % halfLife) * 16) / halfLife` and looks up the bucket's
**left** edge. Flooring the _exponent_ inflates the _factor_, so it is rounded **up** — less decay,
not more — and the piecewise-constant bucketing adds a systematic error of up to
`2^(1/16) − 1 = 4.43%` on top of the table's own rounding error.

**Measured** against the deployed `DecayMathHarness` at the production `halfLife = 90 days`:

| Input                      | Returned              | True `2^-x`   | Error       |
| -------------------------- | --------------------- | ------------- | ----------- |
| `decayFactor(H − 1, H)`    | `522136891213916000`  | `0.500000004` | **+4.427%** |
| `decayFactor(H/16 − 1, H)` | `1000000000000000000` | `0.957603`    | **+4.427%** |
| `decayFactor(2H − 1, H)`   | `261068445606958000`  | `0.250000`    | **+4.427%** |

A 500-point sweep across one half-life gives a maximum relative overshoot of **4.391%**, matching the
theoretical bound.

**Impact.** Every score in the system is systematically **overstated at read time**, and an agent
sitting just under `trustThresholdWad` can read as trusted for up to 4.4% longer than the model
prescribes. There is **zero decay for the first 5.625 days of every half-life** (which is also the
root of SEC-04). Downstream NatSpec at `ReputationManager.sol:84-96` relies on the 0.15% bound when
justifying the saturating subtractions; the real justification is the governance half-life reframing,
not rounding direction. **Anyone sizing risk off the documented figure is out by a factor of thirty.**

The existing test only probes `H/2`, which is exactly bucket 8 and therefore hits the table-rounding
case the 0.15% figure describes — so the false claim is never falsified.

**Remediation (NM-12).** Either state the true bound and direction:

> "Piecewise constant in 1/16-half-life buckets. The factor is exact at bucket boundaries (table
> rounding below 1e-15 relative) and **over**-reports the true `2^-x` by at most
> `2^(1/16) − 1 = 4.43%` within a bucket, always in the under-decay direction."

**or** reduce the error: round to nearest —
`idx = ((elapsed % halfLife) * 16 + halfLife / 2) / halfLife`, clamped to 15 — which halves the error
to ~2.2% and centres it; widen the table to 64 entries for ~1.09%; or interpolate linearly between
adjacent entries to actually reach sub-0.15%.

**ABI impact:** none. **Effort:** S.
**Tests required:** a harness test sampling the **top** of a bucket, e.g. asserting
`decayFactor(H−1, H) > WAD/2`, so the documented bound is enforced rather than asserted.

---

## SEC-14 · Low · Two custom errors are unreachable

**File:** `contracts/libraries/NeuroMeshErrors.sol:59, 193` · **v2.1:** folded into NM-12

`error EmptyField(bytes32 field)` (line 59) and
`error GrantExpired(bytes32 cidHash, address grantee, uint64 expiresAt)` (line 193) are **never
raised by any contract**. Empty fields are rejected by `Limits.checkBytesLen` as `StringTooShort`,
and grant expiry is a non-reverting `false` from `MemoryAccessControl.canAccess` (line 221).

**Impact.** The stated acceptance criterion — "every custom error declared in `NeuroMeshErrors.sol`
is reached by at least one test asserting it with `revertedWithCustomError`" — is **unsatisfiable**.
They are dead ABI surface of exactly the kind the original review flagged for the never-emitted
`MemoryVerified` event, and **a client that branches on `GrantExpired` will never see it.**

**Remediation.** Delete both declarations, or give them a call site: raise `EmptyField` for a
zero-length `cid` / `model` / `wrappedKey` before the length range check, and add a reverting
`requireAccess(bytes32 cidHash, address account)` — or make `getWrappedKey` revert `GrantExpired` —
for callers that want a revert rather than a boolean. **The second option composes with SEC-09.**
**ABI impact:** removal is breaking for a client that decodes the selector; adding a call site is
not. **Effort:** S.

---

## Suggested execution order

From [V2.1-HARDENING-PLAN.md](./V2.1-HARDENING-PLAN.md):

| Order | Findings                       | Rationale                                                                    |
| ----- | ------------------------------ | ---------------------------------------------------------------------------- |
| 1     | SEC-11, SEC-12, SEC-13         | Decide the typehash question first — everything else is rework if it changes |
| 2     | SEC-01                         | Ownership integrity; the critical finding                                    |
| 3     | SEC-02, SEC-03, SEC-04         | Reputation economics; interlocking, must land together                       |
| 4     | SEC-07, SEC-08, SEC-09, SEC-10 | Independent and parallelisable                                               |
| 5     | SEC-06                         | Trust-model change; largest and least urgent                                 |
| 6     | SEC-05, SEC-14                 | Documentation truth-up                                                       |
| 7     | —                              | Regenerate ABIs, re-verify the backend, second adversarial review            |

**SEC-01, SEC-03, SEC-10, SEC-11 and SEC-12 are all ABI-breaking.** Ship them as a _single_ contract
release and redeploy, rather than in increments.

### v2.1 release gate

- [ ] Every finding fixed, or explicitly accepted with written rationale
- [ ] A regression test per finding, named after its ID
- [ ] `npx hardhat compile` clean, zero warnings
- [ ] `npx hardhat test` all green (currently **223**; expect ~250+ after regressions)
- [ ] `npx solhint "contracts/**/*.sol"` zero errors
- [ ] ABIs regenerated into `src/abi/` via `node scripts/gen-abi.js`, backend re-verified,
      `npm run ci` green
- [ ] A second adversarial review round returns no new critical or high findings
- [ ] `docs/PROTOCOL.md`, this page and the README claim tables updated to match the code

---

## Non-contract security notes

These are not contract findings but belong on the same page.

| Item                       | Status                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production `npm audit`     | **0 vulnerabilities**, via the `sharp` and `adm-zip` overrides in `package.json`. Enforced in CI at `--audit-level=high --omit=dev`                                          |
| Secret handling            | `SECRET_KEYS` in `src/config/env.js` drives log redaction; configuration errors print paths and messages but **never values**                                                |
| CI hermeticity             | No CI job consumes a repository secret, and two jobs assert that fact                                                                                                        |
| Container hardening        | Non-root, `tini` as PID 1, `read_only`, `cap_drop: ALL`, `no-new-privileges`, an explicit runtime payload allowlist, and a build-context secret scan that fails the build    |
| Legacy `server.js`         | **No auth, no rate limiting, bare `cors()`, and the AES passphrase is the wallet private key.** Do not expose it. See [API.md Part A](./API.md#part-a--what-is-served-today) |
| Deployed Sepolia contracts | **Pre-rewrite v1.** No access control, no pause, no EIP-712, no nonces. See [DEPLOYMENT.md §8](./DEPLOYMENT.md#8-the-currently-deployed-addresses)                           |

---

## See also

- [V2.1-HARDENING-PLAN.md](./V2.1-HARDENING-PLAN.md) — the fix plan, with effort and ABI impact
- [THREAT_MODEL.md](./THREAT_MODEL.md) — these findings mapped to adversaries and residual risk
- [PROTOCOL.md §11](./PROTOCOL.md#11-honest-limitations) — the protocol-level limitations
- [ROADMAP.md](./ROADMAP.md) — when this work is scheduled
- [SECURITY.md](../SECURITY.md) — how to report a new vulnerability
