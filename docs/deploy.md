# Deployment guide

Obsidian Everywhere has three deployment targets, matching three different
Claude clients. All three can point at the same vault simultaneously — the
SQLite index (`.obsidian-everywhere/index.db`) is per-process, so if you run
more than one transport against the same vault directory, either point them
at different `OBSIDIAN_EVERYWHERE_DB` paths or accept that each process
maintains its own index (writes to the vault's markdown files are never
made by this server itself in v0.1, so there's no write-write conflict —
see "Vault sync" below).

| Client | Transport | Auth | Where it runs |
|---|---|---|---|
| Local Claude Code / Claude Desktop | stdio | none (local process) | Same machine as the client |
| Remote Claude Code (e.g. lab server ↔ MacBook) | Streamable HTTP | static bearer token | Behind Tailscale only — never expose publicly |
| claude.ai web/mobile custom connector | Streamable HTTP | OAuth 2.1 (PKCE + DCR) | Public HTTPS via a reverse proxy (Cloudflare Tunnel) |

## Topology this was built for

- **Host 1 — M1 MacBook**: runs locally via `claude mcp add` (stdio) for the
  user's own Claude Code/Desktop, *and* runs the bearer-token HTTP service
  as a LaunchAgent so other machines on the Tailscale network can reach it
  when the laptop is awake.
- **Host 2 — lab server container**: Docker, always-on fallback for when
  the laptop is asleep/closed. Same two services (bearer-token HTTP +
  optionally the OAuth HTTP service, if you want the lab server rather than
  the laptop to serve claude.ai).

Both hosts point at the *same* vault, kept in sync by your own existing git
pipeline (private GitHub repo) — this project does not do vault
synchronization. See "Vault sync" below for what it does handle.

---

## 1. Local stdio (Claude Code / Claude Desktop on the same machine)

```bash
npm install
npm run build
claude mcp add obsidian-everywhere -- node "$(pwd)/dist/cli.js" /path/to/your/vault
```

See the README for the Claude Desktop `claude_desktop_config.json` equivalent.

## 2. Remote Claude Code over Tailscale (static bearer token)

Install as a LaunchAgent on the MacBook (Host 1):

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/vault \
OBSIDIAN_EVERYWHERE_TOKEN=$(openssl rand -hex 32) \
./scripts/install-launchagent.sh
```

This starts `dist/http-cli.js` on port 3737, `RunAtLoad`+`KeepAlive`, logging
to `logs/http.{out,err}.log`. Verify:

```bash
curl http://127.0.0.1:3737/healthz
```

On the *other* machine (e.g. the lab server), point Claude Code at it over
your Tailscale network — put the MacBook's Tailscale hostname and the token
in the client's MCP HTTP transport config, e.g.:

```bash
claude mcp add --transport http obsidian-everywhere-remote \
  http://<macbook-tailscale-name>:3737/mcp \
  --header "Authorization: Bearer <the token>"
```

Or run the same service inside the lab-server Docker container (Host 2, the
always-on fallback) instead:

```bash
cp .env.example .env   # fill in OBSIDIAN_VAULT_HOST_PATH and OBSIDIAN_EVERYWHERE_TOKEN
docker compose up -d obsidian-everywhere
```

**Do not expose port 3737 publicly.** It has no encryption of its own and a
single static token — it is designed to sit behind Tailscale's private
network, not the public internet.

## 3. claude.ai web/mobile custom connector (OAuth 2.1 + Cloudflare Tunnel)

claude.ai's servers connect to your MCP server from Anthropic's cloud, not
from your private network — Tailscale can't reach it, so this path needs a
real public HTTPS endpoint. That's what Cloudflare Tunnel is for: it
exposes a local port at a public HTTPS hostname without you opening any
inbound firewall port.

### 3a. Start the OAuth HTTP service

```bash
cp .env.example .env   # fill in OBSIDIAN_VAULT_HOST_PATH, OAUTH_ISSUER_URL, OAUTH_LOGIN_SECRET
docker compose up -d obsidian-everywhere-oauth
```

(Or run it directly: `OBSIDIAN_VAULT_PATH=... OAUTH_ISSUER_URL=https://your-domain OAUTH_LOGIN_SECRET=... node dist/oauth-http-cli.js`.)

`OAUTH_ISSUER_URL` must be the exact public HTTPS origin you're about to
point the tunnel at (step 3b) — the OAuth discovery documents and the
resource metadata are derived from it.

### 3b. Set up the Cloudflare Tunnel

```bash
brew install cloudflared   # or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
TUNNEL_HOSTNAME=obsidian.example.com ./scripts/setup-cloudflare-tunnel.sh
```

This writes `~/.cloudflared/obsidian-everywhere.yml` (ingress rule pointing
at `http://localhost:3738`) and prints the remaining commands, which need
your Cloudflare account and a browser, so they can't be automated here:

```bash
cloudflared tunnel login
cloudflared tunnel create obsidian-everywhere
cloudflared tunnel route dns obsidian-everywhere obsidian.example.com
cloudflared tunnel --config ~/.cloudflared/obsidian-everywhere.yml run obsidian-everywhere
```

Verify from any machine (not just your Tailscale network):

```bash
curl https://obsidian.example.com/healthz
curl https://obsidian.example.com/.well-known/oauth-authorization-server
```

### 3c. Register the connector in claude.ai

1. claude.ai → Settings → Connectors → Add custom connector.
2. Enter `https://obsidian.example.com/mcp` as the server URL.
3. claude.ai discovers the OAuth metadata automatically (via the
   `.well-known` endpoints and the `WWW-Authenticate` header on a 401) and
   redirects you to the sign-in page this server renders.
4. Enter the `OAUTH_LOGIN_SECRET` you set in step 3a. That's the entire
   "login" — there is one user.
5. claude.ai completes the PKCE code exchange and the connector is live.

This step is a claude.ai UI flow — it needs your browser and Anthropic
account, so there's no way to script it.

---

## Vault sync

This server does **not** sync your vault. Keeping the vault's files
identical across hosts is your existing git pipeline's job (`git pull` on
whichever host, on whatever schedule/hook you already use).

What this server *does* guarantee: once new/changed files land on disk
(from a `git pull`, an editor save, anything), the filesystem watcher
(`chokidar`) picks up every create/change/delete/rename and incrementally
updates the SQLite index and the in-memory graph — no restart required. If
a host has been offline long enough that events could plausibly have been
missed (mtime+hash comparison catches this), the next process start
performs `fullScan`, which is itself mtime+hash-gated so only files that
actually differ get re-parsed.
