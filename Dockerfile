# Multi-stage build. Debian-slim (not alpine) so better-sqlite3's prebuilt
# native binary matches glibc and doesn't need to compile from source.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Mount your vault at /vault (read/write — the index db lives alongside it
# unless OBSIDIAN_EVERYWHERE_DB points elsewhere). Bind- or volume-mounting
# here replaces the small bundled sample vault baked in below, so a real
# deployment never sees it.
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
