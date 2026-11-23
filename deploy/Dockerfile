# syntax=docker/dockerfile:1
# Brain server image. Build context: repository root.
#   docker compose -f deploy/compose.yml build
# Stages: build (tsc + vite, dev deps) → deps (production node_modules only) → runtime.

ARG NODE_IMAGE=node:22-slim

# --- build: server dist/ and web/dist/ ---------------------------------------------------------
FROM ${NODE_IMAGE} AS build
# Toolchain only for a native fallback build of better-sqlite3 when no prebuilt binary matches.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/package.json web/package-lock.json ./web/
RUN npm --prefix web ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
COPY web ./web
RUN npm run build && npm --prefix web run build

# --- deps: production dependencies only ---------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- runtime -----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    BRAIN_HOST=0.0.0.0 \
    BRAIN_PORT=7460 \
    BRAIN_DATA_DIR=/data \
    BRAIN_WEB_DIR=/app/web/dist
WORKDIR /app
# Everything under /app belongs to root and is read-only for the `node` user (uid 1000) that runs
# the server; the only writable place is /data (named volume) plus a tmpfs /tmp from compose.
COPY package.json package-lock.json ./
COPY migrations ./migrations
# Served as GET /inbox-poll.sh.
COPY scripts/inbox-poll.sh ./scripts/inbox-poll.sh
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/web/dist ./web/dist
# A new named volume copies this directory's owner (node) and mode, so /data is writable for node.
RUN mkdir -p /data && chown node:node /data && chmod 0700 /data
VOLUME ["/data"]
USER node
EXPOSE 7460
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:7460/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--max-old-space-size=192", "dist/src/main.js"]
