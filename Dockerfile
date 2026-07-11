# syntax=docker/dockerfile:1.7
#
# Production image for the BTC Power Law Model daemon.
#
# Builds the TypeScript sources in a builder stage, then assembles a
# minimal runtime image carrying only the compiled `dist/` output and
# `package.json` - the app has ZERO runtime npm dependencies (just
# node:http, node:fs, and the global fetch built into Node 22), so there
# is no node_modules to copy into the runtime stage at all. Multi-arch
# (linux/amd64 + linux/arm64) - Pi-class ARM64 is a hard requirement for
# Umbrel. The CI workflow at `.github/workflows/docker-publish.yml`
# produces both architectures via `docker buildx` on every `v*` tag.
#
# The image listens on port 3013 by default and persists everything
# operator-relevant (settings.json, canonical price history, model fit
# history, activity log, job stats) under `/data` - mount that as a
# volume on the host so state survives container recreation.

ARG NODE_VERSION=22

# Short git SHA threaded in by CI (`docker buildx build --build-arg
# GIT_SHA=...`). Surfaced in /api/status so the running build can be
# identified from the dashboard. .dockerignore excludes the .git/ dir
# from the build context, so without this arg it would always read "dev".
ARG GIT_SHA=dev

# App semver version threaded in the same way. .dockerignore also
# excludes hmlebtc-powerlaw-model/ (the Umbrel app dir where the
# canonical umbrel-app.yml lives), so version.ts cannot read the manifest
# off disk during a Docker build - without this arg it falls back to the
# version baked into package.json instead (which is also kept at 0.1.0).
ARG APP_VERSION=unknown

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /app

# Prime the dependency layer with manifests only - this layer rebuilds
# only when package.json/package-lock.json changes, not on every source
# edit.
COPY package.json package-lock.json ./
RUN npm ci

# Now copy source and compile (tsc → dist/).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app

# Re-declare in this stage's scope so they can be promoted to ENV below.
ARG GIT_SHA
ARG APP_VERSION

# Only the compiled output + package.json are needed at runtime - there
# are zero runtime npm dependencies, so no node_modules is copied here.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Persistent state directory. Operators should mount a volume here
# (Umbrel does this declaratively in docker-compose.yml; for `docker run`
# use `-v btc-powerlaw-model-data:/data`).
RUN mkdir -p /data
VOLUME /data

EXPOSE 3013

ENV NODE_ENV=production \
    BPL_HTTP_PORT=3013 \
    BPL_DATA_DIR=/data \
    GIT_SHA=${GIT_SHA} \
    APP_VERSION=${APP_VERSION}

# Health probe - GET /healthz is the canonical liveness endpoint, also
# used by Umbrel/Docker to gate "started" status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3013/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Runs the daemon, which serves its dashboard + JSON API on BPL_HTTP_PORT
# (3013) bound to 0.0.0.0.
CMD ["node", "dist/main.js"]
