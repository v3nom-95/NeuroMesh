# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For a change that alters the public HTTP API, a contract ABI, or on-chain storage layout, add an
entry under **BREAKING CHANGES** as well as under its usual section, and say what a consumer has to
do about it.

## [2.1.0] - 2026-09-26

### Security — contract hardening pass

Fixed 7 of the 12 tracked review findings, including the critical one. Each fix has a regression
test in `test/contracts/Hardening.v21.spec.js`. Per-issue status: `docs/V2.1-HARDENING-PLAN.md`.

- **NM-01 (critical) — CID front-running.** Memory ownership was first-come-first-served, so any
  observer who saw a CID could permanently claim another agent's content and lock the rightful
  owner out. `commitMemory` now requires a matured commit–reveal `precommit`.
- **NM-02 (high) — endorsement stake was unslashable.** An endorser could front-run the slasher with
  `revokeEndorsement` and recover 100%. Revoked-but-unclaimed edges are now slashable.
- **NM-04 (high) — decay was defeatable.** `settle` is permissionless and pinned the clock to `now`,
  discarding sub-bucket time, so settling faster than once per 1/16 half-life froze a score forever.
  The clock now advances only by the consumed portion and carries the residual.
- **NM-06 (high) — moderation was unenforceable.** A registrar-suspended agent could `reactivate()`
  itself in the next transaction. Suspension is now sticky until a registrar lifts it.
- **NM-07 (medium)** — an expired access grant no longer blocks re-granting.
- **NM-08 (medium)** — `revokeEndorsement` is pause-exempt, so escrow is recoverable during a pause.
- **NM-09 (medium)** — `withdrawTreasury` sends to the configured `treasury`, not an arbitrary address.
- **NM-05 / NM-12** — corrected two false NatSpec claims: the sybil bar is ~8 mutually-endorsing
  wallets (not 18), and `DecayMath` quantisation error is +4.43% biased upward (not 0.15%). The
  behavioural fixes are deferred.

Still open: 0 critical, 3 high (NM-03, NM-05, NM-10), 1 medium (NM-11).

### Changed — BREAKING (contracts)

- `commitMemory(MemoryInput)` → `commitMemory(MemoryInput, bytes32 salt)`
- added `precommit`, `precommitHash`, `precommittedAt`
- `Agent` struct gains `suspendedByRegistrar`
- `commitMemoryFor` is **unchanged** — it was already safe, so the backend needed no modification

### Added — toolchain

- `scripts/verify.js` and `scripts/benchmark.js` (both were referenced by npm scripts but missing)
- `scripts/deploy.js` rewritten for the v2 suite: correct constructor arity, deploys
  `MemoryAccessControl`, writes `deployments/<chainId>.json`
- `scripts/simulate.js` rewritten: distinct BIP-44 agents, so reputation is exercised on-chain
  rather than logged off-chain as in v1
- `docs/openapi.json` (23 paths)

### Fixed — quality gates

- typecheck 31 errors → 0; solhint 9 errors → 0
- 237 contract tests, 707 backend tests, production `npm audit` 0 vulnerabilities

## [Unreleased]

_Nothing yet._

## [2.0.0] - 2026-08-30

The v1 line was a research prototype: a single-file Express server, three contracts with no access
control, secrets that could be baked into a Docker image, and no CI at all. v2.0.0 is the production
hardening pass. It rewrites the contracts around real cryptographic provenance, replaces the
`npm test` failure stub with an enforced pipeline, corrects the licence metadata, moves runtime
dependencies out of `devDependencies`, and gives the repository a governance and supply-chain
surface it did not previously have.

**This release is not backward compatible with v1.** Every contract must be redeployed, every ABI
fragment updated, and every API client repointed. It remains unaudited testnet software — see
[`SECURITY.md`](SECURITY.md#known-limitations).

### BREAKING CHANGES

**Contract ABIs changed; all three v1 contracts must be redeployed.** The addresses in
`contract-addresses.json` point at v1 bytecode and are incompatible with this release.

- `MemoryLedger` is now keyed by `bytes32 cidHash = keccak256(bytes(cid))` instead of by the CID
  string. Every getter that took a `string ipfsCID` now takes a `bytes32 cidHash`;
  `cidHashOf(string)` converts, and `getMemoryByCid(string)` is provided for callers that only hold
  the string.
- `commitMemory(string ipfsCID, string previousVersionCID, bytes signature, bool isEncrypted, uint256 embeddingDim, string embeddingModel)`
  is replaced by `commitMemory(MemoryInput calldata)` returning the record's `bytes32` key. The
  `signature` parameter — accepted and silently discarded in v1 — is gone from this entry point;
  sponsored commits use the new `commitMemoryFor` path, where the signature is actually verified.
- `verifyMemory` no longer returns the v1 five-tuple. `getMemory(bytes32)` returns the full
  `MemoryRecord` struct instead.
- `getOwnerMemoryAtIndex(address, uint256)` is replaced by paginated
  `getOwnerMemories(address, offset, limit)` and `getOwnerMemoryRecords(...)`, each returning a page
  plus a total.
- `AgentIdentity.registerAgent(string publicKey)` becomes
  `registerAgent(bytes publicKey, string metadataURI)`. Public keys are now validated bytes rather
  than an arbitrary string. `getAgentStatus(address)` is retained as a deprecated alias for
  `isActive(address)`.
- `ReputationManager.globalReputation(address)` was a public mapping holding an unbounded integer
  produced by `endorserCount * avgLocalTrust * 1000`. It is now a function returning a WAD-scaled
  value in `[0, 1e18)`. **A client that compares the returned value against the old `>= 500` trust
  threshold will be wrong in both directions.** Use `isTrusted(address)`, or `reputationBps(address)`
  for a 0–10000 integer.
- The `localTrust`, `totalPositiveInteractions`, `totalNegativeInteractions` and `endorserCount`
  public mappings are removed. They were partly dead storage in v1, and `endorserCount` was
  monotonically increasing and inflatable. `massesOf(address)` exposes the replacement state.
- All three contracts now revert with custom errors instead of revert strings. Code that matches on
  revert prose will stop working; decode the error selector instead.
- New required constructor arguments: every contract takes an `admin` address, and `MemoryLedger`,
  `ReputationManager` and `MemoryAccessControl` take the `AgentIdentity` address, which is stored
  `immutable` and checked to be a contract.

**HTTP API changed.** The unversioned v1 routes (`GET /api/status`, `POST /api/register`,
`POST /api/memory`, `GET /api/memories`, `GET /api/simulation-results`, `POST /api/decrypt`) are
replaced by a versioned `/api/v1/*` surface. Mutating routes now require an `API_AUTH_TOKEN`; in v1
anyone who could reach the port could spend the node's ETH and use it as a decryption oracle.
Clients must update their base path and send the token.

**`@xenova/transformers` is replaced by `@huggingface/transformers`.** The Xenova package is the
predecessor of the official HuggingFace release and is no longer the maintained line. The embedding
provider is now selected by `NEUROMESH_EMBEDDING_PROVIDER` (`local` or `mock`), so tests and CI no
longer download a model. Code importing `@xenova/transformers` directly must be updated.

**Package identity changed.** `majorproj` is now `neuromesh-protocol`, and `main` resolves to a real
entry point instead of a nonexistent `index.js`. Anything resolving the old package name breaks.

**Node 20 or newer is required**, declared in `engines` and enforced by `engine-strict=true` in
`.npmrc`. Node 18 is end-of-life and is no longer supported anywhere, including the Docker image.

### Added

- **Smart contract security layer.** `contracts/base/NeuroMeshGuarded.sol` gives every contract
  `AccessControlEnumerable` plus `Pausable` with a split role set (`PAUSER`, `PARAM_ADMIN`,
  `REGISTRAR`, `MODERATOR`, `SLASHER`, `TREASURER`) rather than a single owner. Shared
  `contracts/libraries/` modules hold the custom errors, role identifiers, numeric limits,
  fixed-point decay math and pagination semantics, so the four contracts cannot disagree about them.
  `contracts/interfaces/` publishes a stable ABI surface for each contract.
- **Real EIP-712 provenance.** `AgentIdentity`, `MemoryLedger` and `MemoryAccessControl` implement
  typed-data signing with OpenZeppelin `EIP712` and `Nonces`, verified through
  `SignatureChecker.isValidSignatureNow` so smart-contract agent wallets (ERC-1271) work alongside
  EOAs. Every meta-transaction carries a bounded `deadline`, and authority is derived from the
  recovered signer, never from `msg.sender`.
- **`MemoryAccessControl` contract** — delegated decryption rights. An owner publishes a per-grantee
  wrapped key on chain, and `canAccess(cidHash, account)` is the authorisation predicate the backend
  reads. Grants are revocable individually and by a moderator.
- **Agent lifecycle in `AgentIdentity`:** metadata URIs, versioned public-key rotation,
  self-deactivation and reactivation, an admin override, paginated enumeration, and gasless
  registration and rotation through the `*For` entry points.
- **Stake-backed, decaying reputation in `ReputationManager`:** revocable endorsements with an ETH
  stake and a lock period, endorsement weight scaled by the endorser's own reputation, reports that
  auto-revoke the reporter's endorsement, lazy exponential time decay computed on read, slashing, a
  treasury, and parameter setters gated behind `PARAM_ADMIN`. The trust log is a fixed-capacity ring
  buffer with a monotone counter instead of an unbounded array of unbounded strings; reason text is
  hashed into storage and emitted in full in the event.
- **Pagination on every list getter** — `(offset, limit) -> (page, total)`, capped page size, and an
  empty page past the end rather than a revert, so a client can loop without a bounds race.
- **A real test suite.** Per-contract Hardhat specs with `loadFixture` snapshot isolation, plus
  shared helpers under `test/helpers/` for protocol constants, fixtures, ethers v6 typed-data
  builders, and deterministic gas snapshots. Tests assert on custom errors with `withArgs`, never on
  revert strings.
- **CI pipeline** (`.github/workflows/ci.yml`): seven jobs — lint and format, typecheck, contract
  compile and test, backend tests on a Node 20/22 matrix, production dependency audit, Docker build
  with image assertions, and a `CI success` gate that aggregates them for branch protection. No job
  consumes a repository secret, and the contract and backend jobs assert that every chain and IPFS
  credential is empty.
- **CodeQL analysis** (`.github/workflows/codeql.yml`) with `security-extended,security-and-quality`
  over JavaScript/TypeScript and over the workflow definitions, on push, pull request, and weekly.
- **Secret scanning** (`.github/workflows/secret-scan.yml`): gitleaks with a project-specific
  `.github/gitleaks.toml`, plus assertions gitleaks cannot make on its own — that no `.env` has ever
  existed in any commit on any ref, and that `.gitignore` still ignores it.
- **`.env.example`** documenting every environment variable the project reads, across runtime, HTTP security,
  Ethereum, IPFS, cryptography, embedding and tooling groups, each with purpose, type, requiredness
  and an obviously fake placeholder. Introduces `MEMORY_ENCRYPTION_KEY` and `API_AUTH_TOKEN`.
- **Toolchain configuration:** ESLint flat config (separate Node and browser blocks, with
  `innerHTML`/`eval`/`document.write` banned in `public/`), Prettier, solhint tuned for 0.8.24 and
  OpenZeppelin v5, `.editorconfig`, `.npmrc`, and a `tsconfig.json` that typechecks JSDoc-annotated
  JavaScript with `checkJs` and emits nothing.
- **`docker-compose.yml`** for one-command local development, with a local-chain profile.
- **Governance surface:** `SECURITY.md` (supported versions, private disclosure, response targets,
  scope, key-handling rules, rotation runbook), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor
  Covenant 2.1), this changelog, `CODEOWNERS`, structured issue forms with blank issues disabled,
  and a pull-request template carrying on-chain-impact and secret-hygiene checklists.
- **Dependabot** (`.github/dependabot.yml`) for npm, GitHub Actions and Docker base images, weekly,
  with patch and minor updates grouped.
- **`prom-client`** for metrics, and `pino` / `pino-http` for structured logging.

### Changed

- Package metadata is complete and correct: `neuromesh-protocol` 2.0.0, a real description and
  keyword set, `repository`, `bugs` and `homepage` pointing at the GitHub project, `author`,
  `engines`, and a `files` allowlist so `npm pack` no longer sweeps up build output.
- **Licence metadata corrected from `ISC` to `Apache-2.0`**, matching the `LICENSE` file and the
  README badge. The previous mismatch gave every automated licence scanner a legally wrong answer
  about attribution and patent grant.
- `npm test` now runs both suites — `node --test` for backend tests and `hardhat test` for contract
  tests — and `npm run ci` runs the whole local gate (lint, solhint, format check, typecheck,
  compile, test), matching what CI enforces.
- Hardhat is configured for production: the optimizer is enabled at 200 runs with `evmVersion:
cancun` and `viaIR: false`, so deployed bytecode is reproducible and gas figures mean something.
  In v1 `solidity: "0.8.24"` in string form left the optimizer off.
- The Docker image is a multi-stage build on `node:22-bookworm-slim`: a builder stage running the
  full `npm ci`, and a runtime stage with `npm ci --omit=dev`, `tini` as PID 1 so `SIGTERM` is
  forwarded and zombies are reaped, a non-root `USER`, OCI labels, and a `HEALTHCHECK` with a start
  period long enough to cover model load. v1 ran `npm install` as root on end-of-life
  `node:18-bullseye` in a single stage with no health probe.
- `.gitignore` is restructured: `.env` and `.env.*` are ignored with an explicit `!.env.example`
  negation, and coverage, logs, key material, reports and editor droppings are covered by category
  rather than by hard-coded scratch filenames.
- `zod` v4 and `express-rate-limit` v8 replace their v3 and v7 predecessors.

### Fixed

- **Critical — production installs crashed on boot.** `ethers` and `dotenv` were declared in
  `devDependencies` while being imported at module load by the server and by the deploy and
  simulation scripts. Every `npm ci --omit=dev` install, and every correctly built Docker runtime
  stage, produced a node that died immediately with `ERR_MODULE_NOT_FOUND`. Both are now runtime
  dependencies, and the container job asserts devDependencies are absent from the runtime image.
- **Critical — secrets could be baked into image layers.** The build had no `.dockerignore` and
  copied the whole working tree, so a real `.env` containing `PRIVATE_KEY` and `PINATA_JWT` — along
  with host `node_modules`, `.git` history, and build artifacts — entered the image and persisted in
  its layers. A thorough `.dockerignore` now excludes them, secrets are runtime-only, and CI fails
  the build if a `.env` or `.git` directory is found in the image.
- **Critical — `commitMemory` never verified the signature it accepted.** Provenance was decorative:
  any address could commit any CID and claim ownership, and because the first caller won the mapping
  slot permanently, another agent's CID could be front-run and squatted. Ownership now follows the
  recovered EIP-712 signer.
- **Critical — no contract had access control, pausability, or an identity gate.** All four now
  inherit role-based access control and a pause switch whose scope deliberately excludes the
  functions a user needs to exit (self-deactivation, stake withdrawal, revocation).
- **High — reputation was inflatable and purchasable.** `endorserCount` was incremented on first
  endorsement and never decremented, and the documented transitive trust and time decay did not
  exist at all. Two registrations and one transaction produced a `TRUSTED` agent. The score is now
  `P / (P + N + prior)` in WAD, bounded, weighted by endorser reputation, decayed over time, and
  backed by a slashable stake.
- **High — unbounded on-chain storage.** The v1 trust log was an unbounded array of structs each
  containing an unbounded string, and `MemoryLedger` stored every CID three times with no input
  length limits and no pagination.
- `npm test` no longer exits 1 unconditionally. In v1 it was `echo "Error: no test specified" && exit 1`,
  which made the existing contract suite unreachable from any CI provider or reviewer workflow.
- `main` no longer points at a nonexistent `index.js`.
- The Sepolia RPC URL no longer falls back silently to the rate-limited public endpoint in a way
  that makes a misconfigured deployment look like a hang. A missing endpoint is a configuration
  error, and `.env.example` says so.

### Removed

- The `test/NeuroMesh.js` monolithic spec, superseded by per-contract suites.
- The `scratch_test.js` throwaway script and the `.gitignore` entry that was hiding it.
- `@xenova/transformers`, replaced by `@huggingface/transformers`.
- Root-level generated output. Simulation results are written to a gitignored `reports/` directory
  rather than committed at the repository root.
- The unauthenticated `POST /api/decrypt` route, which was a decryption oracle for the node's own
  key material, available to anyone who could reach the port.

### Security

- **Key separation.** The chain signing key and the memory encryption key are now distinct
  variables. In v1 the raw wallet private key was passed to the encryption routine as the AES
  passphrase, so a single leak destroyed both signing authority and the confidentiality of every
  memory, and sharing a memory was equivalent to disclosing the signing key.
- **Authentication on state-changing routes.** A node holds a funded hot wallet; mutating routes now
  require `API_AUTH_TOKEN` and are rate-limited separately from reads.
- **Documented incident response.** [`SECURITY.md`](SECURITY.md) specifies private disclosure through
  GitHub Security Advisories, acknowledgement and triage targets, explicit in-scope and out-of-scope
  boundaries, seven non-negotiable key-handling rules, and a rotate-before-purge runbook for an
  exposed credential.
- **Supply chain.** `npm audit --omit=dev --audit-level=high` is an unsuppressed CI gate, and the
  `overrides` block pinning `sharp` and `adm-zip` is what took the production dependency tree from
  51 vulnerabilities to zero. The pull-request template has a checkbox specifically to stop that
  block being removed by accident.
- **Verified clean history.** `.env` has never been committed on any ref — checked, not assumed —
  and a CI assertion now fails the build if that ever stops being true.

## [1.0.0] - 2026-08-07

Initial research prototype.

### Added

- `AgentIdentity`, `MemoryLedger` and `ReputationManager` Solidity contracts on Sepolia.
- A single-file Express server exposing agent registration, memory commit, memory listing and
  decryption.
- AES-256-GCM encryption of memory payloads before pinning to IPFS via Pinata.
- A Johnson–Lindenstrauss random-projection module presented as cross-model semantic
  synchronisation. See the v2 notes: the projection was unseeded and did not align independently
  trained embedding spaces.
- A vanilla JavaScript dashboard.
- A simulation harness producing the benchmark figures quoted in the v1 README.

<!-- Comparison links. These resolve once the corresponding tags exist on the remote. -->

[unreleased]: https://github.com/v3nom-95/NeuroMesh/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/v3nom-95/NeuroMesh/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/v3nom-95/NeuroMesh/releases/tag/v1.0.0
