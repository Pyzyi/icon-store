# syntax=docker/dockerfile:1

# Pinned by version AND digest: rebuilds are reproducible and a re-tagged
# upstream image cannot slip in unnoticed. Renovate/Dependabot can bump both.
ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# ---- dependencies: installed at build time, never at container start ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Optional extra CA (build secret "ca") for networks with TLS inspection; absent in normal builds.
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="icon-store" \
      org.opencontainers.image.description="Self-hosted, hardened icon store for dashboards" \
      org.opencontainers.image.source="https://github.com/Pyzyi/icon-store" \
      org.opencontainers.image.licenses="MIT"

# The app never needs a package manager at runtime; removing them shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    NODE_OPTIONS=--max-old-space-size=160

WORKDIR /app
# Code is owned by root and therefore read-only for the "node" user that runs it.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data

USER node
VOLUME ["/app/data"]
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server.js"]
