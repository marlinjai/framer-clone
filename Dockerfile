# syntax=docker/dockerfile:1.7
#
# Multi-stage build for framer-clone on Coolify/Hetzner (aarch64 shared server).
#
#   Stage 1 (deps):    install deps with a frozen lockfile (single package, no
#                      pnpm workspace).
#   Stage 2 (builder): prisma generate + Next.js standalone build.
#   Stage 3 (runtime): minimal node + Infisical CLI + the prisma CLI sidecar.
#
# Secrets are NOT baked in. Infisical injects them at container start via
# entrypoint.sh (only INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/SECRET + INFISICAL_PROJECT_ID
# are plain Coolify env). The image is safe to push to a public registry.
#
# The image MUST be built for linux/arm64 (the shared Coolify host is Ampere
# ARM); the deploy workflow builds on `ubuntu-24.04-arm` with `platforms:
# linux/arm64`. Build and runtime share the SAME base image, but
# node:20-bookworm-slim ships WITHOUT libssl: so the builder installs openssl
# before `prisma generate` (otherwise Prisma mis-detects and emits the
# openssl-1.1.x engine while the runtime, which installs openssl 3.0.x, needs
# openssl-3.0.x). schema.prisma also pins binaryTargets to linux-arm64-openssl-3.0.x
# as a backstop.

ARG NODE_IMAGE=node:20-bookworm-slim
ARG PNPM_VERSION=9.15.0
# Pin matches "prisma" in package.json (6.19.3). Bump both together.
ARG PRISMA_VERSION=6.19.3

# ---------- Stage 1: deps ----------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

# Corepack activates the pnpm version pinned in package.json at BUILD time (not
# container start) to avoid a corepack-on-boot race.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# Only the manifests, so dep installs cache independently of source changes.
# postinstall runs `prisma generate`, which needs the schema present, so the
# prisma dir is copied before install and the postinstall script is ignored here
# (the builder stage runs prisma generate explicitly).
COPY package.json pnpm-lock.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ---------- Stage 2: builder ----------
FROM ${NODE_IMAGE} AS builder
ARG PNPM_VERSION
ARG COMMIT_SHA=unknown

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
ENV COMMIT_SHA=${COMMIT_SHA}

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# Reuse the deps layer, then bring in the source. .dockerignore keeps the
# heavyweight + secret-bearing trees out (node_modules, .next, .env*, .git, etc.).
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# node:20-bookworm-slim ships without libssl, so `prisma generate` cannot detect
# the openssl version and would default to the openssl-1.1.x engine. Install
# openssl (3.0.x on bookworm) BEFORE generate so native detection matches the
# runtime stage; binaryTargets in schema.prisma pins linux-arm64-openssl-3.0.x too.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Generate the Prisma client (emits @prisma/client + the matching query engine).
RUN pnpm exec prisma generate

# Next.js standalone build. DATABASE_URL is a stub: the page-data collection
# constructs the lazy Prisma client (which reads the var) but runs NO queries.
RUN DATABASE_URL=postgresql://stub:stub@localhost:5432/stub pnpm build

# ---------- Stage 3: runtime ----------
FROM ${NODE_IMAGE} AS runtime
ARG COMMIT_SHA=unknown
ARG PRISMA_VERSION

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Next.js standalone binds to process.env.HOSTNAME; the container runtime sets
# HOSTNAME to the container id, which would make the server listen on that host
# only and fail Coolify's loopback healthcheck. Force 0.0.0.0 so it is reachable.
ENV HOSTNAME=0.0.0.0
ENV COMMIT_SHA=${COMMIT_SHA}

# ca-certificates + openssl for HTTPS (auth-brain, analytics ingest) and Prisma;
# curl for the Infisical install script.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates \
         curl \
         openssl \
    && rm -rf /var/lib/apt/lists/*

# Infisical CLI (Cloudsmith Debian repo). The CLI prints a deprecation notice at
# runtime; the binary still functions. Switch install channels in a follow-up
# when artifacts-cli.infisical.com returns a non-403 response.
RUN curl -1sLfS 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh' \
      | bash \
    && apt-get install -y --no-install-recommends infisical \
    && rm -rf /var/lib/apt/lists/* \
    && infisical --version

WORKDIR /app

# The standalone server, static assets, public, and the prisma schema +
# migrations (entrypoint runs `prisma migrate deploy` at boot). Ownership set to
# the built-in non-root `node` user.
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/prisma ./prisma

# Install the `prisma` CLI + its full transitive dep tree in a SIDECAR under
# /opt, then point NODE_PATH at it. The Next standalone tracer prunes the prisma
# CLI (it is not reachable from server.js), so `prisma migrate deploy` at boot
# needs it supplied this way. A sidecar (not /app/node_modules) avoids the
# `EUNSUPPORTEDPROTOCOL workspace:` and missing-transitive-dep failures the
# cp/npm-install-in-/app approaches hit.
RUN set -e \
    && mkdir -p /opt/prisma \
    && cd /opt/prisma \
    && npm init -y --silent > /dev/null \
    && npm install --no-save --no-audit --no-fund prisma@${PRISMA_VERSION} > /dev/null \
    && chown -R node:node /opt/prisma \
    && /opt/prisma/node_modules/.bin/prisma --version

ENV NODE_PATH=/opt/prisma/node_modules
ENV PATH=/opt/prisma/node_modules/.bin:$PATH

# The Infisical-aware boot wrapper.
COPY --chown=node:node entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER node

EXPOSE 3000

# No Docker HEALTHCHECK: Coolify configures the healthcheck at the proxy layer
# (HTTP GET /api/health, host 127.0.0.1). A Docker-level HEALTHCHECK conflicts
# with Coolify's IPv6 localhost probe.

ENTRYPOINT ["./entrypoint.sh"]
