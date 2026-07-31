# syntax=docker/dockerfile:1
# ============================================================================
# Vietnamese (`vi`) fork of ghcr.io/zitadel/zitadel-login (Login V2 UI)
# ============================================================================
# WHY a source rebuild (not a `FROM ghcr.io/zitadel/zitadel-login` overlay):
#   * The supported-locale list lives in a hardcoded `LANGS` array
#     (apps/login/src/lib/i18n.ts). The locale switcher AND the
#     Accept-Language / NEXT_LOCALE-cookie gates all key off it. In the
#     published image that array is minified into the server bundle -> not
#     reliably patchable at runtime.
#   * Messages load via `import(`../../locales/${locale}.json`)`, a Next.js /
#     webpack build-time context module. Files added to locales/ AFTER the
#     build are NOT in the context map, so a runtime-COPYed vi.json is ignored.
#   Both facts mean `vi` must be baked in at BUILD time -> we rebuild from the
#   pinned upstream source with a tiny overlay.
#
# PINNED to the exact Zitadel monorepo release that ships the running server
# (the login image is versioned in lock-step with the server). Bump
# ZITADEL_VERSION to match your Zitadel core.
#
# BUILD CONTEXT = this repo root:
#   docker build -t zitadel-login-vi:v4.15.3 --build-arg ZITADEL_VERSION=v4.15.3 .
# ============================================================================

ARG ZITADEL_VERSION=v4.15.3
ARG NODE_VERSION=24
ARG PNPM_VERSION=10.30.3

# --------------------------------- builder ---------------------------------
# Debian (glibc) base: @bufbuild/buf + native codegen tools are friendlier here
# than on musl/alpine.
FROM node:${NODE_VERSION}-bookworm-slim AS builder
ARG ZITADEL_VERSION
ARG PNPM_VERSION

# basePath is baked into the Next.js standalone output at build time, so build
# it with the same path the reverse proxy serves the app under.
ARG NEXT_PUBLIC_BASE_PATH=/ui/v2/login
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /src
# Shallow clone of ONLY the pinned release tag.
RUN git clone --depth 1 --branch ${ZITADEL_VERSION} https://github.com/zitadel/zitadel.git .

# ---- Vietnamese fork overlay -------------------------------------------------
# 1) Bundle the vi message file (same strings you upload via the Settings v2
#    hosted-login-translation API -> single source of truth).
COPY login_v2_vi_translations.json apps/login/locales/vi.json
# 2) Register `vi` in LANGS + honour LOGIN_DEFAULT_LOCALE (idempotent, fails
#    loudly if the upstream anchors moved).
COPY apply-vi-locale.mjs /tmp/apply-vi-locale.mjs
RUN node /tmp/apply-vi-locale.mjs

# ---- Build the standalone Login app -----------------------------------------
# nx resolves `^build` first, so @zitadel/proto (buf codegen) and @zitadel/client
# are built before the Next.js standalone output (apps/login/.next/standalone).
RUN pnpm install --frozen-lockfile
RUN pnpm exec nx build @zitadel/login

# --------------------------------- runtime ---------------------------------
# Mirrors apps/login/Dockerfile from the pinned release (same base, user, env,
# healthcheck and entrypoint) so runtime behaviour matches the official image.
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs
# If /.env-file/.env is mounted, its vars are loaded before the server starts.
RUN mkdir -p /.env-file && touch /.env-file/.env && chown -R nextjs:nodejs /.env-file

# The standalone dir already contains scripts/* (entrypoint.sh, healthcheck.mjs,
# load-ssl-cert-dir.cjs, server.mjs) + apps/login/server.js — copied in by the
# login app's `build` script.
COPY --from=builder --chown=nextjs:nodejs /src/apps/login/.next/standalone ./

USER nextjs
ENV HOSTNAME="::" \
    PORT="3000" \
    NODE_ENV="production" \
    NODE_OPTIONS="--use-openssl-ca --require /app/load-ssl-cert-dir.cjs" \
    SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt" \
    ZITADEL_TLS_ENABLED="false" \
    OTEL_SERVICE_NAME="zitadel-login" \
    OTEL_EXPORTER_OTLP_PROTOCOL="http/protobuf"

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/node", "/app/healthcheck.mjs", "/ui/v2/login/ready"]

ENTRYPOINT ["/app/entrypoint.sh", "node", "apps/login/server.js"]
