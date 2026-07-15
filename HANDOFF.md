# Handoff — steps that need a human

Per the project spec's Anti-Mockup rules: anything requiring real external
network access or interactive account/browser flows can't be completed in
an unattended environment. This file is the checklist for what's left.

## 1. Docker image build/run verification — ✅ DONE (2026-07-16)

Resolved. Root cause of the earlier failure: Docker Desktop was mid
self-update when the host disk filled up (`~/Library/Application
Support/com.docker.install/in_progress/`), the delta-patch failed, and
the interrupted pull left corrupted/orphaned blobs in the local image
store (`docker system df` showed 242MB of untracked, unreclaimable
"Images" usage with `docker images` listing nothing). Fixed by: quitting
Docker Desktop, deleting the stale `in_progress` update-staging directory,
relaunching, then `docker builder prune -af && docker system prune -af
--volumes` to clear the orphaned blobs before rebuilding.

Both `docker build` and `docker compose up` verified for real against the
fixture vault — see PROGRESS.md for full output. No changes were needed
to the `Dockerfile`/`docker-compose.yml` themselves; they were correct all
along, just blocked by the corrupted local Docker state.

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
