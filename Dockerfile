# Multi-stage Debian/glibc build. Native dependencies use a prebuilt binary
# when one exists, but ARM64 and newly released Node patch versions can still
# require node-gyp, so compilation tools live only in disposable stages.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci \
    && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && npm ci --omit=dev \
    && npm cache clean --force \
    && apt-get purge -y --auto-remove python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && git config --system --add safe.directory /vault \
    && rm -rf /var/lib/apt/lists/*
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Mount your vault at /vault (read/write — the index db lives alongside it
# unless OBSIDIAN_EVERYWHERE_DB points elsewhere). Bind- or volume-mounting
# here replaces the small bundled sample vault baked in below, so a real
# deployment never sees it. Git trusts this exact container mount path via the
# system config above; no wildcard safe.directory entry is used.
ENV OBSIDIAN_VAULT_PATH=/vault
COPY fixtures/test-vault /vault
VOLUME ["/vault"]

EXPOSE 3737 3738
LABEL org.opencontainers.image.source="https://github.com/junnnnnw00/obsidian-everywhere"

# Default to the zero-config stdio MCP server against the bundled sample
# vault above, so `docker run <image>` alone starts and responds to MCP
# introspection with no mounted volume, port, or secret required — this is
# what lets automated MCP directories (e.g. Glama) evaluate the image.
# docker-compose.yml overrides `command` (to dist/http-cli.js or
# dist/oauth-http-cli.js) and always mounts a real vault for the two
# always-on HTTP services described in docs/deploy.md.
CMD ["node", "dist/cli.js"]
