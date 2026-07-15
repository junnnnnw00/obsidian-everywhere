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
# unless OBSIDIAN_EVERYWHERE_DB points elsewhere).
ENV OBSIDIAN_VAULT_PATH=/vault
VOLUME ["/vault"]

EXPOSE 3737 3738
LABEL org.opencontainers.image.source="https://github.com/junnnnnw00/obsidian-everywhere"

# Default to the static-bearer-token HTTP transport (the "lab server,
# always-on fallback" role from docs/deploy.md — reached over Tailscale,
# never exposed publicly). docker-compose.yml overrides the command to
# dist/oauth-http-cli.js for the separate claude.ai-connector service.
CMD ["node", "dist/http-cli.js"]
