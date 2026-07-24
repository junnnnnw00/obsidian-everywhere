# Deployment guide

[English](deploy.md) | [한국어](deploy.ko.md)

Obsidian Everywhere has three deployment targets, matching local, private
remote, and public MCP clients. All three can point at the same vault
simultaneously. Their default SQLite files are transport-specific
(`index-stdio.db`, `index-http.db`, and `index-oauth.db`). If you override
`OBSIDIAN_EVERYWHERE_DB`, keep the path unique per process. The write tools modify
Markdown files, so avoid concurrent writes to the same note and let your
vault sync system resolve cross-host conflicts. See "Vault sync" below.

| Client | Transport | Auth | Where it runs |
|---|---|---|---|
| Local Codex CLI / ChatGPT Desktop / Claude | stdio | none (local process) | Same machine as the vault |
| Remote Codex / ChatGPT Desktop / Claude | Streamable HTTP | static bearer token | Behind Tailscale only — never expose publicly |
| claude.ai web/mobile custom connector | Streamable HTTP | OAuth 2.1 (PKCE + DCR) | Public HTTPS via a reverse proxy (Cloudflare Tunnel) |

## Topology this was built for

- **Host 1 — M1 MacBook**: runs locally via stdio for Codex, ChatGPT Desktop,
  Claude, or another MCP client, *and* runs the bearer-token HTTP service
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

## 1. Local stdio (Codex / ChatGPT Desktop / Claude on the same machine)

```bash
codex mcp add obsidian-everywhere -- npx -y obsidian-everywhere /path/to/your/vault
```

Codex CLI, its IDE extension, and ChatGPT Desktop share `~/.codex/config.toml`.
Restart ChatGPT Desktop after adding the server. Claude Code can register the
same stdio command separately:

```bash
claude mcp add obsidian-everywhere -- npx -y obsidian-everywhere /path/to/your/vault
```

See the README for manual `config.toml` and Claude Desktop JSON examples.

## 2. Remote clients over Tailscale (static bearer token)

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

On the *other* machine (e.g. the lab server), point the MCP client at it over
your Tailscale network. Codex and ChatGPT Desktop share this registration:

```bash
export OBSIDIAN_EVERYWHERE_CLIENT_TOKEN="<the token>"
codex mcp add obsidian-everywhere-remote \
  --url http://<macbook-tailscale-name>:3737/mcp \
  --bearer-token-env-var OBSIDIAN_EVERYWHERE_CLIENT_TOKEN
```

The token environment variable must be available to the client process,
including when ChatGPT Desktop launches. For Claude Code:

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

(Or run it directly: `OBSIDIAN_VAULT_PATH=... OAUTH_ISSUER_URL=https://your-domain OAUTH_LOGIN_SECRET=... npx -y --package obsidian-everywhere obsidian-everywhere-oauth-http`.)

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

### External or network-mounted vaults

If the vault lives on a removable/external drive or a network mount, and
the server is set to start automatically at boot/login (a LaunchAgent,
systemd unit, etc.), it can start racing the OS's own mount step: the
directory technically exists but its listing is still filling in. A
`fullScan` that runs during that window indexes whatever partial listing
it saw — not an error, just a much smaller vault than expected — and
nothing re-triggers a rescan on its own afterwards.

`VaultEngine.init()` guards against this by waiting for the vault
directory's top-level listing to read identically twice in a row before
scanning (bounded by a timeout, so a genuinely empty vault or an
unmountable path doesn't hang startup). Tune it with:

- `OBSIDIAN_EVERYWHERE_MOUNT_WAIT_MS` — max time to wait for the listing to
  stabilize before giving up and scanning anyway (default `5000`).
- `OBSIDIAN_EVERYWHERE_MOUNT_POLL_MS` — delay between listing attempts
  (default `200`).

If a scan still ends up short, `obsidian-everywhere doctor <vault-path>`
reports the note count it found — rerun it after confirming the drive is
fully mounted, then restart the server to force a fresh `fullScan`.
