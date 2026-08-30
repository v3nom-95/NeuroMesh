# syntax=docker/dockerfile:1.7
# =============================================================================
#  NeuroMesh Protocol - production container image
#
#  Multi-stage:
#    1. builder  - full `npm ci` (dev + prod), syntax-gates the source, and
#                  assembles an explicit runtime payload allowlist at /out.
#    2. runtime  - `npm ci --omit=dev`, non-root, tini as PID 1, health-probed.
#
#  BASE IMAGE: node:22-bookworm-slim, NOT alpine. This is measured, not assumed.
#  `@huggingface/transformers@4` depends on `onnxruntime-node@1.24.3`, whose
#  prebuilt native library is glibc-only. On node:22-alpine `npm ci --omit=dev`
#  SUCCEEDS (no install-time error at all) and the failure only surfaces at
#  runtime on the first import:
#
#    Error loading shared library ld-linux-x86-64.so.2: No such file or directory
#    (needed by .../onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime.so.1)
#
#  A musl base is therefore only viable with NEUROMESH_EMBEDDING_PROVIDER=mock
#  or a remote embedding backend. Do not "optimise" this back to alpine.
#
#  SECRETS: never as ARG or ENV. Both are permanently visible in
#  `docker history`. Secrets are runtime-only (--env-file / -e / compose).
# =============================================================================

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------------------
# Stage 1: builder - full dependency tree, source validation, payload assembly
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS builder

ENV HUSKY=0 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app

# Dependency layer first so it caches independently of source churn.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-fund --no-audit

COPY . .

# Defence in depth: if .dockerignore ever regresses, fail the build loudly
# rather than baking a funded PRIVATE_KEY / PINATA_JWT into an image layer.
RUN set -eu; \
    for f in .env .env.local .env.production; do \
      if [ -e "$f" ]; then \
        echo "FATAL: '$f' is present in the build context - .dockerignore is broken." >&2; \
        exit 1; \
      fi; \
    done; \
    echo "build context secret scan: clean"

# Cheap correctness gate: a syntactically broken entrypoint fails here, in the
# throwaway stage, instead of at container start. There is no transpile or
# bundle step (plain Node ESM), and no `hardhat compile` step either: server.js
# carries its contract ABI fragments inline, so the runtime image needs no
# Solidity toolchain and no artifacts/ directory.
RUN node --check server.js \
 && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('source gate: ok')"

# Explicit runtime payload allowlist. This is the real reason the runtime stage
# never does `COPY . .`: .git, .env, test/, scripts/, docs/, hardhat config and
# the host node_modules cannot reach the final image even if .dockerignore is
# edited badly later. Optional paths are tolerated so this keeps working while
# other lanes add src/ and remove lib/.
RUN set -eu; \
    mkdir -p /out; \
    cp -a package.json package-lock.json server.js /out/; \
    for p in src lib public protocol deployments contract-addresses.json; do \
      if [ -e "$p" ]; then cp -a "$p" /out/; echo "payload += $p"; fi; \
    done; \
    ls -A /out

# ---------------------------------------------------------------------------
# Stage 2: runtime - production dependencies only, non-root, tini, healthcheck
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG VERSION=2.0.0
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="NeuroMesh Protocol" \
      org.opencontainers.image.description="Decentralized cognitive memory protocol for autonomous AI agents: on-chain identity and reputation, IPFS-anchored encrypted memories, and cross-model semantic synchronization." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.source="https://github.com/v3nom-95/NeuroMesh" \
      org.opencontainers.image.url="https://github.com/v3nom-95/NeuroMesh#readme" \
      org.opencontainers.image.documentation="https://github.com/v3nom-95/NeuroMesh/blob/main/docs/DEPLOYMENT.md" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="NeuroMesh Protocol contributors" \
      org.opencontainers.image.base.name="docker.io/library/node:22-bookworm-slim"

# tini reaps zombies and forwards SIGTERM/SIGINT to node, so `docker stop`
# actually triggers the server's graceful-shutdown path instead of being
# swallowed by PID 1 default signal handling and then SIGKILLed.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && test -x /usr/bin/tini

ENV NODE_ENV=production \
    HUSKY=0 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=7860 \
    HOST=0.0.0.0 \
    LOG_PRETTY=false \
    HEALTHCHECK_PATH=/healthz \
    TRANSFORMERS_CACHE=/app/.cache/transformers \
    HF_HOME=/app/.cache/huggingface \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Production dependency tree, installed inside this image so the onnxruntime /
# sharp native binaries match this exact base. npm's cache is dropped in the
# same layer so it never ships.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-fund --no-audit \
 && npm cache clean --force

# Application payload, allowlisted and validated in the builder stage.
COPY --from=builder --chown=node:node /out/ ./

# Writable state for the transformers model cache (mount a volume here in
# production so the ~90MB model is not re-downloaded on every restart).
RUN mkdir -p /app/.cache/transformers /app/.cache/huggingface /app/reports \
 && chown -R node:node /app/.cache /app/reports

USER node

EXPOSE 7860

# Liveness only. start-period is generous because the first boot may download
# the embedding model. If the backend also exposes /readyz, point orchestrator
# readiness probes there and leave this on /healthz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "const u='http://127.0.0.1:'+(process.env.PORT||7860)+(process.env.HEALTHCHECK_PATH||'/healthz');fetch(u,{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
