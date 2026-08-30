# Security Policy

NeuroMesh is a decentralized cognitive-memory protocol. A node signs Ethereum transactions with a
hot wallet, encrypts memory payloads with a symmetric key, and pins those payloads to IPFS through a
third-party credential. Three long-lived secrets therefore sit on every operator's machine, and the
most damaging mistake anyone can make in this repository is committing one of them.

This document covers which versions receive fixes, how to report a vulnerability privately, what is
in and out of scope, the non-negotiable key-handling rules, and the automated controls that back
them up.

---

## Supported versions

| Version | Supported    | Notes                                                                                                                                                                                                                                                                                                               |
| ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2.x`   | Yes (active) | Current line. Security fixes land on `main` and ship as `2.x.y`.                                                                                                                                                                                                                                                    |
| `1.x`   | No           | Research prototype with known, unfixed defects: runtime dependencies declared as devDependencies, an unauthenticated API surface including a decryption oracle, contracts with no access control and no signature verification, and an AES key derived from the chain private key. Do not run it. Upgrade to `2.x`. |

There is no long-term-support branch. Only the latest `2.x` release receives fixes, and there are no
backports to earlier `2.x` patch releases.

---

## Reporting a vulnerability

**Do not open a public issue, pull request, or Discussion for a security problem.** Blank issues are
disabled in this repository specifically so that no vulnerability report lands in a public tracker by
accident.

Use **GitHub Private Vulnerability Reporting**:

> <https://github.com/v3nom-95/NeuroMesh/security/advisories/new>

The advisory is visible only to you and the maintainers until it is published.

### What to include

- **Affected component** — the contract name and deployed address, the HTTP route, or the file path.
- **Version or commit SHA** — `git rev-parse HEAD`, or the release tag.
- **Reproduction steps** — the smallest sequence that demonstrates the issue. A failing test, a
  `curl` invocation, or a Hardhat script is ideal.
- **Impact** — what an attacker gains: funds, another agent's plaintext, forged provenance,
  permanent denial of service, and so on.
- **Suggested fix**, if you have one. Optional, and never required.

Redact your own credentials from any log or transcript you attach. If a reproduction genuinely
requires a key, generate a throwaway one — never paste a key that has held value.

### Response commitments

| Stage                                         | Target                                               |
| --------------------------------------------- | ---------------------------------------------------- |
| Acknowledgement that the report was received  | 72 hours                                             |
| Triage and severity assignment                | 7 days                                               |
| Fix, or a written mitigation plan with a date | 30 days for high and critical; best effort otherwise |
| Coordinated public disclosure                 | After a fix ships, or by agreement with the reporter |

This is a small research project, not a funded security team. These are targets held in good faith,
not a contractual SLA. If a target slips you will be told why rather than left waiting.

Reporters are credited by name or handle in the published advisory and in `CHANGELOG.md` unless you
ask to remain anonymous.

**There is no bug bounty.** No payment is offered or implied for any report. This is unaudited
research software running on a public testnet with no economic value at stake.

---

## Scope

### In scope

- `contracts/` — `AgentIdentity`, `MemoryLedger`, `ReputationManager`, `MemoryAccessControl`, their
  shared base and libraries, and the instances deployed to Sepolia recorded in
  `contract-addresses.json` and `deployments/`.
- The HTTP API and its middleware: authentication, input validation, rate limiting, CORS, headers.
- Cryptographic code: payload sealing, key derivation and key separation, key wrapping, canonical
  encoding, signature construction and verification.
- The content-identifier pipeline, including whether the CID returned by the pinning service is
  checked against locally computed bytes.
- Semantic alignment code where a defect produces a security consequence — for example leaking
  plaintext-derived data through a published vector.
- The Docker image and `docker-compose.yml`: image contents, privileges, exposed surface.
- CI workflows under `.github/workflows/`, in particular anything that lets untrusted code or
  untrusted input escalate into the repository or its secrets.
- The dashboard under `public/` — XSS, injection, and anything that causes a browser to send a
  credential somewhere it should not go.

### Out of scope

- Third-party services and their infrastructure: RPC providers, Pinata, IPFS gateways, HuggingFace
  model hosting, GitHub itself. Report those to the vendor.
- The content or behaviour of downloaded model weights.
- Denial of service against a testnet RPC endpoint, a public IPFS gateway, or a demo deployment.
  Rate limiting exists to protect a node's gas budget, not to survive a determined flood.
- Findings that require an already-compromised operator machine, a stolen `.env`, or physical
  access. If the attacker already holds the private key, everything else follows by design.
- Missing hardening with no demonstrated impact — an absent header, a version banner, a TLS cipher
  preference — unless you can show what it actually buys an attacker here.
- Social engineering of maintainers or contributors.
- Anything in `1.x`. Those defects are known and documented; the fix is to upgrade.

---

## Key handling rules (non-negotiable)

1. **`.env` is gitignored and must never be committed.** Verify before every push:

   ```bash
   git check-ignore -v .env   # must print a .gitignore rule
   git ls-files .env          # must print nothing
   ```

   `.gitignore` ignores `.env` and `.env.*` while negating `!.env.example`, so the template is
   tracked and nothing else is. Never run `git add -f` on a dotenv file.

2. **`PRIVATE_KEY` must be a dedicated testnet key that has never held mainnet value.** This
   repository targets Sepolia. Reusing a key that holds real funds — or later funding this key on
   mainnet — converts every bug in this codebase into a financial loss. Fund it with faucet ETH
   only, and only as much as the workload needs.

3. **`MEMORY_ENCRYPTION_KEY` must be independent of `PRIVATE_KEY`.** In `1.x` the chain private key
   was passed directly to the encryption routine as the AES passphrase. One leak then destroyed both
   signing authority and the confidentiality of every memory ever written, and sharing a memory was
   equivalent to disclosing the signing key. Generate the two independently:

   ```bash
   openssl rand -hex 32
   ```

4. **`PINATA_JWT` must be scoped to pinning only** — not to account administration or key
   management — and rotated on any suspicion of exposure. A leaked pinning credential lets an
   attacker pin arbitrary content to your account and enumerate what you have pinned.

5. **`API_AUTH_TOKEN` gates every state-changing route, and must be set.** A node runs a funded hot
   wallet: the routes that register agents, commit memories, or record reputation events spend the
   operator's ETH and write permanently to a public chain, and any decryption route speaks with the
   node's key material. An unauthenticated node is simultaneously an open faucet and an open
   decryption oracle — that was the `1.x` behaviour, and it is a large part of why `1.x` is
   unsupported. Generate the token with `openssl rand -hex 32`, deliver it over TLS only, and
   rotate it whenever someone who knew it leaves the project. Read-only `GET` routes may stay
   public; mutating routes may not.

6. **Never expose a node holding a funded key without a reverse proxy and TLS.** `HOST` defaults to
   `127.0.0.1` outside containers for exactly this reason; `0.0.0.0` belongs inside a container
   behind something that terminates TLS.

7. **Secrets are supplied at runtime, never at build time.** Use `--env-file`, an orchestrator
   secret store, or GitHub Actions secrets. A secret passed as a Docker `ARG` or baked into an `ENV`
   persists in `docker history` and in the image layers forever. `.dockerignore` excludes `.env`
   from the build context so it cannot be copied in by accident — do not weaken that.

8. **No CI job in this repository consumes a repository secret**, and the `contracts` and `backend`
   jobs actively assert that `SEPOLIA_RPC_URL`, `PRIVATE_KEY`, `PINATA_JWT` and `ETHERSCAN_API_KEY`
   are all empty. Contract tests run against Hardhat's in-process EVM; backend tests run with
   `NEUROMESH_EMBEDDING_PROVIDER=mock`. Never wire a secret into a workflow triggered by
   `pull_request` — a fork PR would gain it.

### If a secret is exposed: rotate first, then purge

The order matters. History rewriting is slow and can fail; rotation is fast and is what actually
stops the attack. Anything pushed to GitHub must be assumed to have been scraped within seconds, and
a force-push does not remove a blob that has already been fetched, forked, or cached.

1. **Rotate immediately.**
   - `PRIVATE_KEY` — sweep every remaining balance to a fresh wallet, stop using the address, and
     redeploy or reassign any on-chain role it holds. A leaked key cannot be un-leaked.
   - `PINATA_JWT` — revoke the credential in the Pinata dashboard and issue a new one.
   - `MEMORY_ENCRYPTION_KEY` — treat every payload sealed under it as public. Rotating protects
     future memories; it cannot retract ciphertext already pinned to IPFS.
   - `API_AUTH_TOKEN` — generate a new one and restart every node.
2. **Notify the maintainers** through the private advisory link above, so on-chain state written by
   the compromised key can be reviewed and, where the contracts permit, revoked or moderated.
3. **Purge the value from history**, only after rotation:

   ```bash
   git filter-repo --path .env --invert-paths    # or --replace-text for an inline value
   git push --force --all
   git push --force --tags
   ```

   Then ask GitHub Support to expire cached views of the affected commits, and have every
   collaborator re-clone rather than merge the rewritten history.

4. **Fix the gate that missed it.** Add the pattern to `.github/gitleaks.toml` so the same shape of
   secret is caught next time, and re-run the scan over full history.

---

## Automated controls

These run on this repository today. They are gates, not advisories — a failure blocks the merge.

| Control                  | Where                               | What it does                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret scanning          | `.github/workflows/secret-scan.yml` | gitleaks over the PR diff, and over the whole repository on push, using `.github/gitleaks.toml`. Runs on every push and pull request to `main`.                                                                     |
| History assertion        | same workflow                       | Fails if a `.env` file has ever existed in any commit on any ref, and if `.gitignore` stops ignoring `.env`. Catches secrets whose shape gitleaks does not know.                                                    |
| Working-tree assertion   | `.github/workflows/ci.yml` (`lint`) | Fails if `.env` is tracked, or if `.env.example` contains something that looks like a real key or JWT rather than a placeholder.                                                                                    |
| Hermetic-test assertion  | `ci.yml` (`contracts`, `backend`)   | Fails if any chain or IPFS secret is non-empty in a test job, so a future change cannot leak a credential into logs or make fork PRs unrunnable.                                                                    |
| Static analysis          | `.github/workflows/codeql.yml`      | CodeQL with `security-extended,security-and-quality` over JavaScript/TypeScript and over the workflow definitions themselves, on push, pull request, and weekly.                                                    |
| Dependency audit         | `ci.yml` (`audit`)                  | `npm audit --omit=dev --audit-level=high`, unsuppressed. The `overrides` block in `package.json` (`sharp`, `adm-zip`) is what holds the production tree at zero high-severity findings; removing it turns this red. |
| Dependency updates       | `.github/dependabot.yml`            | Weekly updates for npm, GitHub Actions, and Docker base images, with patch and minor grouped.                                                                                                                       |
| Container hygiene        | `ci.yml` (`docker`)                 | Builds the image and never pushes it, then asserts that no `.env` or `.git` was baked in, that the container does not run as root, and that devDependencies are absent from the runtime stage.                      |
| Solidity static analysis | `ci.yml` (`lint`)                   | solhint with reentrancy, `tx.origin`, send-result, state-visibility and custom-error rules against every contract.                                                                                                  |
| Review routing           | `.github/CODEOWNERS`                | Contracts, workflows, Docker, `package.json` and this file require maintainer review once branch protection is enabled.                                                                                             |

`CI success` is the aggregate gate: it depends on every other job and is the single status check
branch protection should require on `main`.

---

## Known limitations

Stated plainly, because a security policy that oversells its system is itself a hazard.

- **The contracts are not audited.** They have been reviewed and tested by their authors, and
  nothing more. No third-party audit has been performed or commissioned.
- **This is testnet software.** It targets Sepolia. Do not deploy it to a mainnet, and do not put a
  key with real value anywhere near it. There are no economic guarantees, no insurance, and no
  incident response beyond a maintainer reading an advisory.
- **On-chain and IPFS data are public and permanent.** Only the memory payload is encrypted. Content
  identifiers, owner addresses, timestamps, version links, endorsement and report graphs, and every
  access pattern are public metadata that anyone can read, index and correlate, forever. Encryption
  protects the content — not the fact that you wrote it, when, or to whom you granted access.
  Content pinned to IPFS cannot be reliably deleted; on-chain revocation is a statement of intent,
  not erasure.
- **Confidentiality is bounded by key hygiene, with no forward secrecy.** A `MEMORY_ENCRYPTION_KEY`
  disclosed today exposes every payload ever sealed under it, including payloads already pinned and
  beyond your reach.
- **Reputation is sybil-resistant only in a narrow sense.** It resists a set of fresh wallets with
  no inflow from already-trusted agents. It does not resist an attacker who can obtain genuine
  endorsements, and it is not a proof of honesty.
- **The node is a trusted component.** It holds the signing key and the encryption key. Anyone who
  can reach a mutating route with a valid API token, or who compromises the host, controls both.

---

## Related documents

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, the local check suite, and the review process.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — community standards and enforcement.
- [`CHANGELOG.md`](CHANGELOG.md) — what changed in each release, including security fixes.
- [`.env.example`](.env.example) — every environment variable, with safe placeholders.
