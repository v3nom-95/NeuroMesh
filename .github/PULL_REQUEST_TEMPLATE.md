<!--
Thanks for contributing to NeuroMesh Protocol.

Delete any section that genuinely does not apply, but do not delete the
Security checklist - it applies to every change.

Do not paste private keys, JWTs, or .env contents anywhere in this PR.
-->

## Summary

<!-- What changes, and why. One paragraph. Link the issue: Closes #123 -->

## Type of change

- [ ] `fix` - non-breaking bug fix
- [ ] `feat` - non-breaking new capability
- [ ] `breaking` - changes the HTTP API, the contract ABI, or on-chain storage
- [ ] `refactor` / `perf` - no behaviour change
- [ ] `docs` / `ci` / `build` / `chore`

## Area

- [ ] contracts
- [ ] backend / API
- [ ] frontend / dashboard
- [ ] protocol (crypto, alignment, trust)
- [ ] repo / CI / Docker
- [ ] docs

## On-chain impact

- [ ] No contract changes
- [ ] Contracts changed - redeploy required, and the new addresses are committed under `deployments/`
- [ ] Storage layout changed - migration described below
- [ ] Public ABI changed - `server.js` / frontend ABI fragments updated to match

Gas delta (`REPORT_GAS=true npm run test:contracts`):

<!-- paste the relevant rows, or write "none" -->

## How this was tested

Every box below should be checked locally before review, not just left to CI.

- [ ] `npm run lint` and `npm run lint:sol` pass
- [ ] `npm run format:check` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run test:contracts` passes
- [ ] `npm run test:unit` passes on Node 20 and Node 22
- [ ] `npm audit --omit=dev --audit-level=high` still reports zero findings
- [ ] New behaviour has a test that fails without this change
- [ ] Manual verification (describe what you clicked or called)

## Security checklist

- [ ] I reviewed `git diff --stat` and the full diff: no private key, JWT, RPC URL with an embedded API key, or `.env` content is included
- [ ] Any new environment variable is documented in `.env.example` with an obviously fake placeholder
- [ ] Any new external input is validated at the boundary before use
- [ ] Any new contract function has the access control, pause coverage, and reentrancy protection it needs
- [ ] Any new dependency is justified in the Summary above, and I checked what it pulls in transitively
- [ ] No new install script or postinstall hook was introduced
- [ ] `package.json` `overrides` (sharp, adm-zip) is untouched, or its removal is justified and the audit job still passes

## Documentation

- [ ] README and/or the relevant page under `docs/` is updated
- [ ] `CHANGELOG.md` has an entry under `## [Unreleased]`
- [ ] Any claim added to the README is backed by code or a measurement, and is recorded in `docs/CLAIMS.md`

## Reviewer notes

<!-- Anything you want the reviewer to look at hardest, and anything you are unsure about. -->
