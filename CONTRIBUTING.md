# Contributing to NeuroMesh

Thanks for taking the time to contribute. This guide takes you from a fresh clone to a merged pull
request, and documents the conventions the review process expects.

Before anything else, two hard rules:

- **Never commit a secret.** This project asks you to put an Ethereum private key and an IPFS
  credential in a local `.env`. See [Secret hygiene](#secret-hygiene) below, and
  [`SECURITY.md`](SECURITY.md) for the full policy.
- **Never report a vulnerability in a public issue or pull request.** Use the private advisory form
  linked from [`SECURITY.md`](SECURITY.md).

---

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Secret hygiene](#secret-hygiene)
- [Local chain workflow](#local-chain-workflow)
- [Project layout](#project-layout)
- [Scripts reference](#scripts-reference)
- [Running tests](#running-tests)
- [Coding standards](#coding-standards)
- [Commit conventions](#commit-conventions)
- [Developer Certificate of Origin](#developer-certificate-of-origin)
- [Pull request process](#pull-request-process)
- [Adding a dependency](#adding-a-dependency)
- [How to add a new API route](#how-to-add-a-new-api-route)
- [How to add a new contract function](#how-to-add-a-new-contract-function)
- [Reporting security issues](#reporting-security-issues)

---

## Code of Conduct

This project is governed by the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you
agree to uphold it. Report unacceptable behaviour through the channel named in that document.

---

## Prerequisites

| Tool   | Version                      | Notes                                                                                                                                                                                                       |
| ------ | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node   | `>=20` (CI builds 20 and 22) | Enforced by `engines` in `package.json` plus `engine-strict=true` in `.npmrc`, so an older Node fails at install rather than at runtime. The code uses `node --test`, `node --watch` and top-level `await`. |
| npm    | `>=10`                       | Ships with Node 20+. Use `npm`, not yarn or pnpm — `package-lock.json` is the only lockfile.                                                                                                                |
| git    | any recent                   | `git filter-repo` is useful to have available for incident response.                                                                                                                                        |
| Docker | 24+ (optional)               | Only needed for `npm run docker:build` and `docker-compose.yml`.                                                                                                                                            |

**Windows contributors:** run the shell snippets in this guide under Git Bash or WSL2. `.editorconfig`
sets LF endings for every file type, so configure your editor to honour it. Avoid PowerShell for the
`&&`-chained commands below — it does not support them in Windows PowerShell 5.1.

---

## Setup

```bash
git clone https://github.com/v3nom-95/NeuroMesh.git
cd NeuroMesh

npm ci                       # never `npm install` on a first clone: `ci` honours the lockfile exactly

cp .env.example .env         # Windows: copy .env.example .env
# then fill in, at minimum:
#   SEPOLIA_RPC_URL        a real RPC endpoint, not the public fallback
#   PRIVATE_KEY            a TESTNET-ONLY key that has never held mainnet value
#   PINATA_JWT             scoped to pinning only
#   MEMORY_ENCRYPTION_KEY  openssl rand -hex 32  (must NOT equal PRIVATE_KEY)
#   API_AUTH_TOKEN         openssl rand -hex 32

npm run compile              # compile the Solidity contracts
npm run test:contracts       # prove the toolchain works before changing anything
npm run dev                  # start the node with file watching
```

`.env.example` documents every variable the project reads, with its purpose, type, whether it is
required, and a default. Every value in it is an obviously fake placeholder.

You do **not** need chain credentials to work on most of the codebase. Contract tests run against
Hardhat's in-process EVM, and backend tests run against a mock embedding provider — the same way CI
runs them, with no secrets at all.

---

## Secret hygiene

Before your first commit, and before every push:

```bash
git check-ignore -v .env   # must print a .gitignore rule
git ls-files .env          # must print NOTHING
```

If the second command prints a path, **stop**. Do not push. Rotate the secrets first (sweep the
wallet, revoke the Pinata credential), then ask a maintainer for help purging history. The order is
always rotate, then purge — see [`SECURITY.md`](SECURITY.md#if-a-secret-is-exposed-rotate-first-then-purge).

CI enforces this from two directions: gitleaks scans every push and pull request over full history,
and separate assertions fail the build if `.env` is tracked, has ever existed in any commit, or if
`.gitignore` stops ignoring it. Those gates exist so a mistake is loud; they are not a substitute for
checking.

---

## Local chain workflow

Run everything against a local Hardhat node instead of Sepolia. Nothing costs gas and nothing is
permanent.

```bash
# terminal 1
npm run node:local           # hardhat node on http://127.0.0.1:8545, chain id 31337

# terminal 2
npm run deploy:local         # deploys to that node and writes the address manifest
```

Point the server at it by setting the RPC URL and chain id in your `.env`:

```bash
SEPOLIA_RPC_URL=http://127.0.0.1:8545
CHAIN_ID=31337
PRIVATE_KEY=<one of the keys hardhat node prints on startup>
```

Those keys are published in Hardhat's documentation and are known to the entire internet. They are
fine for a local node and must never be funded anywhere else.

---

## Project layout

| Path                   | What lives there                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts/`           | Solidity 0.8.24 sources. `base/` holds the shared guarded base, `interfaces/` the stable ABI surfaces, `libraries/` errors, roles, limits and math, `mocks/` test-only adversary contracts. |
| `src/`                 | Backend application modules — routing, middleware, services, configuration, and the protocol library.                                                                                       |
| `lib/`                 | Legacy shared helpers retained for compatibility while callers migrate to `src/`.                                                                                                           |
| `public/`              | The dashboard: a dependency-free ES-module frontend. No build step, no bundler, no framework.                                                                                               |
| `scripts/`             | Operational scripts run through Node or Hardhat: deployment, verification, simulation, report generation.                                                                                   |
| `test/`                | Contract specs (`*.spec.js`) executed by Hardhat and Mocha, plus `helpers/` shared by them.                                                                                                 |
| `test/backend/`        | Backend unit and API tests executed by `node --test` with `supertest`. Never Mocha.                                                                                                         |
| `docs/`                | Long-form documentation the README links to: architecture, API reference, protocol spec, deployment, benchmarks.                                                                            |
| `.github/`             | CI workflows, Dependabot, CODEOWNERS, issue forms, and the pull-request template.                                                                                                           |
| `deployments/`         | Per-network deployment manifests: chain id, addresses, deploy block, deployer, commit.                                                                                                      |
| `artifacts/`, `cache/` | Hardhat build output. Generated, gitignored, safe to delete.                                                                                                                                |

Anything generated belongs in `reports/`, `artifacts/`, `cache/` or `coverage/` — all gitignored.
Do not commit build output, and do not add a per-file `.gitignore` entry to hide a scratch file;
delete the file or move it under a generated directory.

---

## Scripts reference

Every script below is defined in `package.json` and runs on Windows, macOS and Linux.

| Script                   | Command                                              | When to run it                                                                           |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm start`              | `node server.js`                                     | Run the node as it runs in production.                                                   |
| `npm run dev`            | `node --watch server.js`                             | Local development with automatic restart on file change.                                 |
| `npm run lint`           | `eslint .`                                           | JavaScript static analysis. Run before every push.                                       |
| `npm run lint:fix`       | `eslint . --fix`                                     | Apply the mechanical fixes ESLint can make itself.                                       |
| `npm run lint:sol`       | `solhint "contracts/**/*.sol"`                       | Solidity static analysis: reentrancy, `tx.origin`, visibility, custom errors.            |
| `npm run lint:all`       | lint + lint:sol                                      | Both linters in one pass.                                                                |
| `npm run format`         | `prettier --write .`                                 | Rewrite files to the project format. Run this instead of arguing about style.            |
| `npm run format:check`   | `prettier --check .`                                 | What CI runs. Fails without modifying anything.                                          |
| `npm run typecheck`      | `tsc --noEmit -p tsconfig.json`                      | Typecheck the JSDoc annotations. Emits nothing; there is no TypeScript build.            |
| `npm run compile`        | `hardhat compile`                                    | Compile contracts. Required before contract tests and after any `.sol` change.           |
| `npm run clean`          | `hardhat clean` + remove generated dirs              | When artifacts or coverage output go stale.                                              |
| `npm test`               | `test:unit` then `test:contracts`                    | The full suite. Run before opening a pull request.                                       |
| `npm run test:unit`      | `node --test --test-reporter=spec test/backend`      | Backend and frontend unit tests under `node:test`.                                       |
| `npm run test:watch`     | `node --test --watch test/backend`                   | The same tests, re-run on save.                                                          |
| `npm run test:contracts` | `hardhat test`                                       | Contract specs under Hardhat's in-process EVM.                                           |
| `npm run test:coverage`  | `node --test --experimental-test-coverage`           | Backend coverage using Node's built-in reporter. No external coverage tool is installed. |
| `npm run coverage:sol`   | `hardhat coverage`                                   | Solidity coverage.                                                                       |
| `npm run deploy:sepolia` | `hardhat run scripts/deploy.js --network sepolia`    | Deploy to Sepolia. Spends real testnet gas — maintainers only.                           |
| `npm run deploy:local`   | `hardhat run scripts/deploy.js --network localhost`  | Deploy to a local `hardhat node`.                                                        |
| `npm run verify`         | `hardhat run scripts/verify.js --network sepolia`    | Publish source to Etherscan. Needs `ETHERSCAN_API_KEY`.                                  |
| `npm run node:local`     | `hardhat node`                                       | Start a local chain on `127.0.0.1:8545`.                                                 |
| `npm run simulate`       | `node scripts/simulate.js`                           | Run the end-to-end benchmark harness. Needs real credentials; writes to `reports/`.      |
| `npm run benchmark`      | alias of `simulate`                                  | Same harness, named for the benchmark tables in the docs.                                |
| `npm run report`         | `node scripts/generate-report.js`                    | Regenerate the project report document from simulation output.                           |
| `npm run audit`          | `npm audit --omit=dev --audit-level=high`            | Production dependency audit. Must report zero findings.                                  |
| `npm run docker:build`   | `docker build -t neuromesh-protocol:local .`         | Build the multi-stage production image.                                                  |
| `npm run docker:run`     | `docker run --rm --env-file .env -p 7860:7860 …`     | Run that image with runtime-only secrets.                                                |
| `npm run ci`             | lint:all + format:check + typecheck + compile + test | **Run this before you push.** It is the same gate CI applies.                            |

---

## Running tests

There are two test runners in this repository and they are deliberately kept apart. Putting a
`node:test` file where Hardhat's Mocha will glob it — or the reverse — produces confusing failures
that look like broken imports.

**Contract tests — Hardhat + Mocha + Chai.**

```bash
npm run compile
npm run test:contracts
npx hardhat test test/MemoryLedger.spec.js   # a single file
```

They use `describe`/`it`, `loadFixture` for snapshot isolation, and assert on custom errors with
`revertedWithCustomError(contract, 'Name').withArgs(...)` rather than on revert strings. Shared
literals, fixtures, EIP-712 builders and gas helpers live in `test/helpers/`.

**Backend tests — `node --test` + supertest.**

```bash
npm run test:unit
node --test test/backend/some-file.test.js   # a single file
```

They use `node:test` and `node:assert/strict`, import the app directly, and drive it with supertest.
They must be hermetic: no chain, no IPFS, no model download, no network. CI asserts that every chain
and IPFS secret is empty while they run.

> **Set the mock provider locally.** CI exports `NEUROMESH_EMBEDDING_PROVIDER=mock`,
> `MODEL_PRELOAD=false` and `NODE_ENV=test` at the workflow level, but `npm run test:unit` sets no
> environment variables of its own — there is no `cross-env` in this project, and an inline
> `VAR=x npm run …` prefix does not work in Windows shells. Either put those three values in your
> local `.env`, or make the test file default to the mock provider itself. A test that downloads a
> 90 MB model is a broken test.

Every behavioural change needs a test that fails without it. "I ran it manually" is not coverage.

---

## Coding standards

**JavaScript**

- ES modules only (`"type": "module"`). No CommonJS, no bundler, no transpile step.
- No TypeScript source files. Types are expressed as JSDoc annotations and checked with
  `npm run typecheck` (`allowJs` + `checkJs` + `noEmit`). Add types to what you touch.
- Validate at every I/O boundary — HTTP bodies, query parameters, environment variables, and
  anything fetched from IPFS or a chain — with zod, before the value reaches business logic.
- No `console.log` in application code. Use the structured `pino` logger. `console` is permitted in
  `scripts/` and in tests, and ESLint is configured accordingly.
- Never log a secret, a full private key, or a raw request body that might contain one.
- Prefer the standard library. Node 20+ has `fetch`, `node:crypto`, `node:test` and
  `AbortController` built in; reach for a dependency only when the standard library genuinely will
  not do.

**Frontend (`public/`)**

- Dependency-free ES modules. No framework, no bundler, no CDN script tags.
- Must stay CSP-safe: no inline `on*` attributes, no inline `style=`, no `eval`, no `new Function`.
  Wire events with `addEventListener`.
- Never assign to `innerHTML`, `outerHTML`, or call `insertAdjacentHTML` or `document.write`. Build
  nodes and set `textContent`. ESLint fails the build on all four. Remote data — CIDs, agent
  addresses, reasons — is attacker-controlled text.
- The browser talks only to this node's own API. Third-party gateways are fetched server-side.

**Solidity**

- `pragma solidity 0.8.24;` pinned, no caret. A floating pragma breaks reproducible verification.
- OpenZeppelin v5 for access control, pausability, reentrancy protection, EIP-712 and nonces. Do not
  hand-roll what OpenZeppelin already audits.
- Custom errors, never revert strings. Revert prose costs bytecode and carries no arguments.
- Checks–effects–interactions in every function that moves value, plus `nonReentrant` where an
  external call can re-enter.
- Every list getter is paginated `(offset, limit) -> (page, total)`. No unbounded arrays, no
  unbounded loops, no unbounded strings in storage.
- NatSpec on every external function, and it must describe what the code does — not what the
  roadmap hopes it will do.

**Formatting** is not a matter of opinion: `npm run format` writes it, `npm run format:check` gates
it. Configuration lives in `.prettierrc.json` and `.editorconfig`.

---

## Commit conventions

This project uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
type(scope): subject
```

**Types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `revert`,
`security`.

**Scopes:** `contracts`, `backend`, `frontend`, `repo`, `ci`, `docker`, `docs`, `deps`, `crypto`,
`ipfs`, `chain`.

**Subject:** imperative mood, lower case, no trailing period, and the whole header at or under 100
characters.

```
feat(contracts): verify EIP-712 signatures on commitMemory
fix(backend): reject a CID that does not match locally computed bytes
security(crypto): separate the memory encryption key from the chain key
docs(repo): document the key rotation procedure
```

A breaking change is marked with `!` after the scope and explained in the commit body under a
`BREAKING CHANGE:` footer:

```
feat(backend)!: move every route under /api/v1

BREAKING CHANGE: the unversioned /api/* routes are removed. Clients must
update their base path.
```

The convention is not yet enforced by an automated commit-message check, so it is enforced in
review. Squash-merge titles must follow it, because they are what the changelog is written from.

---

## Developer Certificate of Origin

Every commit must be signed off, certifying that you wrote the contribution or otherwise have the
right to submit it under the project's Apache-2.0 licence:

```bash
git commit -s -m "fix(backend): ..."
```

That appends a trailer to the message:

```
Signed-off-by: Your Name <your.email@example.com>
```

Signing off means you agree to the [Developer Certificate of Origin 1.1](https://developercertificate.org/):

> By making a contribution to this project, I certify that:
>
> (a) The contribution was created in whole or in part by me and I have the right to submit it under
> the open source license indicated in the file; or
>
> (b) The contribution is based upon previous work that, to the best of my knowledge, is covered
> under an appropriate open source license and I have the right under that license to submit that
> work with modifications, whether created in whole or in part by me, under the same open source
> license (unless I am permitted to submit under a different license), as indicated in the file; or
>
> (c) The contribution was provided directly to me by some other person who certified (a), (b) or
> (c) and I have not modified it.
>
> (d) I understand and agree that this project and the contribution are public and that a record of
> the contribution (including all personal information I submit with it, including my sign-off) is
> maintained indefinitely and may be redistributed consistent with this project or the open source
> license(s) involved.

A pull request with unsigned commits will be asked to `git rebase --signoff main` before merge.

---

## Pull request process

1. **Branch from `main`.** Name it `type/short-description`, matching the commit type:
   `feat/memory-access-control`, `fix/cid-verification`, `docs/threat-model`,
   `security/api-auth-token`.
2. **Keep it focused.** One logical change. A refactor bundled with a behaviour change is
   effectively unreviewable, and a contract change bundled with anything else is a security risk.
3. **Run the gate locally before pushing:**

   ```bash
   npm run ci
   ```

   Pushing something that fails `npm run lint` or `npm run format:check` burns a reviewer's turn on
   a machine-fixable problem.

4. **Add a `CHANGELOG.md` entry under `## [Unreleased]`,** in the right subsection (Added, Changed,
   Deprecated, Removed, Fixed, Security). Write it for someone upgrading, not for someone reading
   the diff.
5. **Fill in the pull-request template.** The security and on-chain-impact checklists are not
   ceremony: they are where the classes of bug this project has already shipped get caught.
6. **Pass `CI success`.** That gate aggregates lint, typecheck, contracts, backend tests on Node 20
   and 22, the production audit, and the Docker build. It is the single required check.
7. **Get a review from a code owner.** `.github/CODEOWNERS` routes contracts, workflows, Docker,
   `package.json` and `SECURITY.md` to the maintainers.
8. **Squash-merge with a Conventional Commit title.** History on `main` stays linear and readable.

Draft pull requests are welcome early — say what you are trying to do and what you are unsure about.
It is much cheaper to redirect a design in a draft than to reject a finished branch.

---

## Adding a dependency

Every dependency is permanent attack surface, a supply-chain risk, and weight in the production
image. Before adding one:

- **Justify it in the pull-request description.** What does it do, what would it take to write
  instead, and what does it pull in transitively (`npm ls <pkg>` after installing)?
- **Prefer zero dependencies.** Node's standard library covers HTTP, crypto, testing, streams and
  file system work.
- **Put runtime imports in `dependencies`, never `devDependencies`.** Anything imported by code that
  runs in production belongs in `dependencies`. In v1 `ethers` and `dotenv` sat in
  `devDependencies`; every `npm ci --omit=dev` install — including the Docker runtime stage —
  produced a node that crashed on boot with `ERR_MODULE_NOT_FOUND`. Build tooling, test tooling,
  linters, type definitions and report generation go in `devDependencies`.
- **Watch for install scripts.** A package with a `postinstall` that downloads and executes a binary
  is the highest-risk shape in the tree. Say so in the pull request if you are adding one.
- **Run `npm run audit` afterwards** and confirm it still reports zero high-severity findings in the
  production tree.
- **Do not touch the `overrides` block** in `package.json` (`sharp`, `adm-zip`) without saying why.
  It is what took the production audit from 51 vulnerabilities to zero; removing it turns the
  `audit` job red immediately, by design.
- **Commit the lockfile change** in the same pull request. `package-lock.json` is generated — never
  hand-edit it, and resolve conflicts by re-running `npm install`, not by merging the diff.

---

## How to add a new API route

1. **Design the contract first.** Decide the method, the versioned path (`/api/v1/...`), the request
   and response shapes, and the error cases. Routes are versioned; a breaking change to an existing
   route means a new version, not a silent edit.
2. **Decide whether it mutates state.** Anything that spends gas, writes on chain, pins to IPFS, or
   touches key material is a mutating route: it requires the API token, the tighter write rate
   limit, and an explicit note in the pull-request description. Read-only routes may be public.
3. **Write the zod schema** for the request body, params and query, and reject anything that does
   not validate — before the handler does any work. Never pass an unvalidated value to a contract
   call, a file path, a URL, or a shell.
4. **Implement the handler thin.** Parse, delegate to a service module, map the result. Business
   logic belongs in a service, not in the route, so that it can be unit-tested without HTTP.
5. **Map errors deliberately.** Return a stable machine-readable error code and a safe message.
   Never leak a stack trace, an RPC error body, a file path, or anything derived from a secret.
6. **Add a test under `test/backend/`** driving the route with supertest: the success path, each
   validation failure, and — for a mutating route — the unauthenticated case returning 401.
7. **Document it** in the API reference under `docs/`, and add any new environment variable to
   `.env.example` with a purpose comment and an obviously fake placeholder.
8. **Update the frontend endpoint map** if the dashboard calls it. Frontend paths live in a single
   configuration module for exactly this reason.

---

## How to add a new contract function

1. **Start with the interface.** Add the signature, the NatSpec and any new custom error to the
   `contracts/interfaces/I*.sol` file and to `contracts/libraries/NeuroMeshErrors.sol`. The
   interface is the published ABI; treat it as a contract with downstream consumers.
2. **Answer the access-control question explicitly.** Who may call this — anyone, a registered and
   active agent, the record's owner, or a role from `contracts/libraries/Roles.sol`? "Anyone" is a
   valid answer only when you can say why. Never authorise on `tx.origin`.
3. **Answer the pause question explicitly.** Should this be `whenNotPaused`? State-advancing
   functions generally should. Functions that let a user get out — self-deactivation, withdrawals,
   revocation — generally should not, so an incident pause cannot trap anyone.
4. **Validate every input at the boundary:** zero addresses, empty bytes, lengths against
   `contracts/libraries/Limits.sol`, deadlines against the maximum signature validity, and pagination
   arguments against `MAX_PAGE_SIZE`.
5. **If it accepts a signature,** verify it with OpenZeppelin `SignatureChecker.isValidSignatureNow`
   (never raw `ECDSA.recover`), consume a nonce, enforce the deadline, and derive authority from the
   recovered signer — never from `msg.sender`. Add the typed-data struct to the EIP-712 definitions
   and mirror it exactly in `test/helpers/eip712.js`; field order must match the typehash string.
6. **Bound the storage.** No unbounded array growth, no unbounded string in storage — hash the text
   and put the full string in the event. Paginate every getter.
7. **Follow checks–effects–interactions** and add `nonReentrant` wherever an external call or an
   ETH transfer occurs.
8. **Emit an event** with everything an indexer needs, indexing the fields people will filter on.
   The event log is the authoritative history; storage is a bounded cache of it.
9. **Test the negative space, not just the happy path:** the wrong caller, the paused contract, the
   expired deadline, the replayed signature, the zero address, the boundary value, the reentrant
   caller. Assert on custom errors with `withArgs`.
10. **Check the size and gas budget.** Run `npm run test:contracts` and confirm the contract still
    fits under the EIP-170 runtime limit and that gas has not regressed.
11. **Redeploy and record it.** Contract changes mean new addresses. Update the deployment manifest,
    verify on Etherscan, and note in the pull request that consumers must update — the ABI fragments
    in the backend and the frontend do not update themselves.

---

## Reporting security issues

Do not open an issue. Use the private advisory form and follow the process in
[`SECURITY.md`](SECURITY.md):

> <https://github.com/v3nom-95/NeuroMesh/security/advisories/new>

If you have already pushed a secret, rotate it first and read
[`SECURITY.md`](SECURITY.md#if-a-secret-is-exposed-rotate-first-then-purge) before doing anything
else with git.
