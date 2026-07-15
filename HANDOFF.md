# Handoff — steps that need a human

Per the project spec's Anti-Mockup rules: anything requiring real external
network access or interactive account/browser flows can't be completed in
an unattended environment. This file is the checklist for what's left.

## 1. Docker image build/run verification

**Status:** blocked mid-build by a host disk-space exhaustion (`ENOSPC`)
during Phase 4, not by anything in the `Dockerfile`/`docker-compose.yml`
themselves. Disk space was freed and `docker compose config` (no daemon
required) confirms the compose file is syntactically valid and renders
correctly — see PROGRESS.md for the full output. The Docker daemon itself
did not come back up cleanly afterward (likely its own VM disk needs
attention after the ENOSPC event) despite several restart attempts.

**To finish this gate:**
```bash
# 1. Make sure Docker Desktop is fully up: `docker info` should succeed.
#    If it doesn't, Docker Desktop's disk image may need a reset:
#    Docker Desktop → Troubleshoot → "Clean / Purge data" (this only
#    affects Docker's own state, not your files).
docker info

# 2. Build
docker build -t obsidian-everywhere:test .

# 3. Run against the fixture vault and confirm it serves real requests
docker run --rm -p 3737:3737 \
  -e OBSIDIAN_EVERYWHERE_TOKEN=test-token \
  -v "$(pwd)/fixtures/test-vault:/vault" \
  obsidian-everywhere:test

# In another terminal:
curl http://localhost:3737/healthz
curl -X POST http://localhost:3737/mcp \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}'
```
Expected: `{"ok":true}` from `/healthz`, and a valid `initialize` JSON-RPC
response from `/mcp` (same shape verified in `src/http/app.test.ts` and the
curl gate evidence in PROGRESS.md's Phase 3 section, minus Docker itself).

## 2. Real Cloudflare Tunnel connection

`scripts/setup-cloudflare-tunnel.sh` does everything that's possible without
your Cloudflare account: checks `cloudflared` is installed and writes the
ingress config. The rest needs your browser and account:

```bash
cloudflared tunnel login
cloudflared tunnel create obsidian-everywhere
cloudflared tunnel route dns obsidian-everywhere <your-hostname>
cloudflared tunnel --config ~/.cloudflared/obsidian-everywhere.yml run obsidian-everywhere
```

Then verify from an *external* network (not the machine running the
tunnel) that HTTPS actually reaches the server:
```bash
curl https://<your-hostname>/healthz
curl https://<your-hostname>/.well-known/oauth-authorization-server
```

## 3. Registering the claude.ai custom connector

This is a claude.ai UI flow, not something scriptable:

1. claude.ai → Settings → Connectors → Add custom connector.
2. Server URL: `https://<your-hostname>/mcp`.
3. claude.ai should auto-discover the OAuth flow and redirect to this
   server's sign-in page (rendered by `SingleUserOAuthProvider.authorize`).
4. Enter the `OAUTH_LOGIN_SECRET` you configured.
5. Confirm the connector shows as connected, and that a test conversation
   can call e.g. `vault_overview` and get real data back.
6. `create_note`/`append_to_note` are **off by default** on this transport
   (see DECISIONS.md D15) — set `OAUTH_ENABLE_WRITE_TOOLS=true` before
   starting `oauth-http-cli.js` if you want claude.ai to be able to write
   to the vault too, not just read from it.

The local OAuth flow itself (DCR → PKCE authorize → login → token exchange
→ authenticated tools/call) **is** verified end-to-end already, against a
real listening HTTP server — see `src/oauth/http-app.test.ts` and the
Phase 4 section of PROGRESS.md. What's left here is specifically
claude.ai's own UI actually driving that flow, which needs a real
Anthropic account and browser session.

## 4. macOS LaunchAgent — real launchctl load

`scripts/install-launchagent.sh` was written and reviewed but not run for
real on this machine (would install a persistent background service on
whatever Mac the agent happens to execute this from, which is a
side-effecting change to the host outside the project directory — left for
you to run deliberately rather than doing it unattended). To install:

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/vault \
OBSIDIAN_EVERYWHERE_TOKEN=$(openssl rand -hex 32) \
./scripts/install-launchagent.sh
curl http://127.0.0.1:3737/healthz   # verify
```
