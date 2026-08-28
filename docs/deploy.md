# Deployment guide

[English](deploy.md) | [한국어](deploy.ko.md)

Obsidian Everywhere has three deployment targets, matching local, private
remote, and public MCP clients. All three can point at the same vault
simultaneously. Their default SQLite files are transport-specific
(`index-stdio.db`, `index-http.db`, and `index-oauth.db`). If you override
`OBSIDIAN_EVERYWHERE_DB`, keep the path unique per process. The write tools modify
Markdown files, so avoid concurrent writes to the same note and let your
vault sync system resolve cross-host conflicts. The opt-in Git tools can
create and publish outbound checkpoints, but they do not pull or synchronize
hosts. See "Vault Git" and "Vault sync" below.

| Client | Transport | Auth | Where it runs |
|---|---|---|---|
| Local Codex CLI / ChatGPT Desktop / Claude | stdio | none (local process) | Same machine as the vault |
| Remote Codex / ChatGPT Desktop / Claude | Streamable HTTP | static bearer token | Private network or public HTTPS tunnel |
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

Both hosts point at copies of the same vault, kept in sync by your existing
sync or Git pipeline. Obsidian Everywhere's Git tools can commit and push
from one chosen vault machine; they never pull changes onto the other host.
See "Vault sync" below for the boundary.

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

Install as a LaunchAgent on the MacBook (Host 1). From a source checkout,
install the locked dependencies first:

```bash
npm ci
```

Generate the bearer token once, save the output in a password manager, and use
that same value for the LaunchAgent and remote client:

```bash
openssl rand -hex 32

OBSIDIAN_VAULT_PATH=/Volumes/SanDisk/jwhong \
OBSIDIAN_EVERYWHERE_TOKEN="<saved token>" \
OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true \
OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=.obsidian/app.json \
OBSIDIAN_EVERYWHERE_GIT_MODE=read \
OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=DSLab \
./scripts/install-launchagent.sh
```

This starts `dist/http-cli.js` on port 3737, `RunAtLoad`+`KeepAlive`, logging
to `logs/http.{out,err}.log`. It indexes the whole `jwhong` vault and persists
read-only Git inspection for its `DSLab` repository. Use `.` instead of `DSLab`
only for a whole-vault repository. Re-run the installer whenever you change the
Git mode, repository path, push mappings, read-only state, token, or port; those
values are copied into the LaunchAgent plist. Verify:

```bash
curl http://127.0.0.1:3737/healthz
```

On the *other* machine (e.g. the lab server), point the MCP client at it over
your Tailscale network. Use the saved token from the installation step. Codex
and ChatGPT Desktop share this registration:

```bash
export OBSIDIAN_EVERYWHERE_CLIENT_TOKEN="<saved token>"
codex mcp add obsidian-everywhere-remote \
  --url http://<macbook-tailscale-name>:3737/mcp \
  --bearer-token-env-var OBSIDIAN_EVERYWHERE_CLIENT_TOKEN
```

The token environment variable must be available to the client process,
including when ChatGPT Desktop launches. For Claude Code:

```bash
claude mcp add --transport http obsidian-everywhere-remote \
  http://<macbook-tailscale-name>:3737/mcp \
  --header "Authorization: Bearer <saved token>"
```

Or run the same service inside the lab-server Docker container (Host 2, the
always-on fallback) instead:

```bash
cp .env.example .env   # fill in OBSIDIAN_VAULT_HOST_PATH and OBSIDIAN_EVERYWHERE_TOKEN
docker compose up -d obsidian-everywhere
```

**Do not expose port 3737 directly to the public internet.** It has no TLS of
its own. Use a private network or a TLS-terminating tunnel. For a detailed
external-server setup with read/write validation, token rotation, automatic
startup, and mount recovery, see
[Remote Vault Bridge with ngrok](ngrok-remote.md).

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

## Vault Git on any transport

Git is completely off by default. The process needs a Git executable on its
`PATH`. `OBSIDIAN_EVERYWHERE_GIT_REPO_PATH` selects one vault-relative real
directory, defaults to `.`, and that directory must be the exact root of a
normal repository with a real local `.git` directory. Parent discovery,
symlinked repository paths, linked worktrees, and unsafe external or symlinked
object/ref/log/core metadata are refused. The full vault remains indexed; only
Git tool paths switch to the selected-repository-relative namespace. Start with
local-only inspection for a direct process or LaunchAgent:

```bash
export OBSIDIAN_EVERYWHERE_GIT_MODE=read
export OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=.
```

The supplied Compose file instead reads service-specific settings from its
host-side `.env`, then maps them to the generic names inside each container:

| Compose service | Mode input | Repository-path input | Push-mapping input |
|---|---|---|---|
| Bearer HTTP (`obsidian-everywhere`) | `OBSIDIAN_EVERYWHERE_HTTP_GIT_MODE` | `OBSIDIAN_EVERYWHERE_HTTP_GIT_REPO_PATH` | `OBSIDIAN_EVERYWHERE_HTTP_GIT_ALLOWED_PUSH_REMOTES` |
| OAuth (`obsidian-everywhere-oauth`) | `OBSIDIAN_EVERYWHERE_OAUTH_GIT_MODE` | `OBSIDIAN_EVERYWHERE_OAUTH_GIT_REPO_PATH` | `OBSIDIAN_EVERYWHERE_OAUTH_GIT_ALLOWED_PUSH_REMOTES` |

Each Compose service defaults independently to `off`, with repository path `.`.
For example, enable only bearer-side read inspection with
`OBSIDIAN_EVERYWHERE_HTTP_GIT_MODE=read`; setting that value does not expose Git
through OAuth. Direct CLI/HTTP/OAuth processes and the LaunchAgent continue to
use `OBSIDIAN_EVERYWHERE_GIT_MODE`,
`OBSIDIAN_EVERYWHERE_GIT_REPO_PATH`, and
`OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES`.

For a full vault at `/Volumes/SanDisk/jwhong` whose Git repository is the
`DSLab` folder, use:

```dotenv
OBSIDIAN_VAULT_HOST_PATH=/Volumes/SanDisk/jwhong
OBSIDIAN_EVERYWHERE_HTTP_GIT_MODE=read
OBSIDIAN_EVERYWHERE_HTTP_GIT_REPO_PATH=DSLab
```

The bearer service continues to index `/vault` in full, while its Git tools use
`/vault/DSLab`. Configure the OAuth service independently with
`OBSIDIAN_EVERYWHERE_OAUTH_GIT_REPO_PATH` if it should expose Git too.

For Compose push, use the corresponding service-specific mode and mapping.
Continuing the `DSLab` example:

```dotenv
OBSIDIAN_EVERYWHERE_HTTP_GIT_MODE=push
OBSIDIAN_EVERYWHERE_HTTP_GIT_REPO_PATH=DSLab
OBSIDIAN_EVERYWHERE_HTTP_GIT_ALLOWED_PUSH_REMOTES=origin=https://github.com/owner/repo.git
```

The capability levels are cumulative:

| Mode | Git tools |
|---|---|
| `off` | none |
| `read` | `git_status`, `git_diff`, `git_log` |
| `commit` | read tools plus `git_commit`, if normal writes are enabled |
| `push` | all five, if normal writes are enabled and exact HTTPS destinations are mapped |

For a direct process, push mode fails fast without an exact operator-pinned
destination mapping. The same repository selection must be retained:

```bash
export OBSIDIAN_EVERYWHERE_GIT_MODE=push
export OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=DSLab
export OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES=origin=https://github.com/owner/repo.git
```

Use repository path `.` in either form only when the whole vault is the
repository.

The current branch must already track the intended remote branch. Its upstream
remote name selects the exact `name=https://host/path.git` mapping, and that
remote's sole resolved push URL must match it. The URL must authenticate
non-interactively on the vault machine. Production mappings reject credentials,
queries, and fragments. The preview displays the exact credential-free
destination. The agent cannot provide a URL, credential, branch, or refspec.

The transport's ordinary write gate remains authoritative:

- stdio and bearer HTTP: `OBSIDIAN_EVERYWHERE_READONLY=true` removes commit and
  push even when the Git mode is higher;
- OAuth: commit and push additionally require
  `OAUTH_ENABLE_WRITE_TOOLS=true`;
- Git status, diff, and log remain available at any mode above `off`.

For a remote service, add the applicable direct-process or Compose Git variables
to the service configuration and restart the process. Confirm the resulting MCP
tool list before using it. A container must include the Git executable and a
deliberately configured non-interactive HTTPS credential path; installing Git
only in the host shell does not make it available inside the container.

Commit and push each require a preview followed by a five-minute, one-use,
state-bound approval UUID. Commit messages are single-line and secret-scanned;
approval binds the exact proposed tree. Push preview never contacts the network.
Execution uses the pinned URL literally and an exact-OID lease as a
compare-and-swap guard; unconditional force, hooks, signing, filters/LFS,
submodules, tags, hidden/sensitive paths, and free-form Git input are blocked.
Outgoing review stops above 100 commits or 200 changed blobs, scans messages and
merge results, and enforces 8 MiB per-blob / 32 MiB aggregate bounds. See the
complete [Git-backed vault tutorial](git-vault.md) before enabling either write
level.

---

## Vault sync

This server does **not** synchronize vaults. `git_commit` records selected local
changes and `git_push` publishes the approved current `HEAD`, but there is no
MCP pull/fetch/merge operation. Keeping files identical across hosts remains the
job of your existing Obsidian Sync, filesystem, or locally managed Git pipeline.
Incoming Git reconciliation and conflicts must be handled locally.

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
- `OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true` — Beta protection for auto-started
  services, do not accept an empty mount point as a ready vault. If it is
  still empty after the timeout, startup fails before the existing index can
  be replaced by an empty scan, allowing the service manager to retry. While
  running, the same guard preserves the index during an unmount, recreates the
  filesystem watcher, and performs a full reconciliation after the mount
  returns. It blocks ordinary write tools and every live Git tool while state
  is `unavailable` or `reconciling`.
- `OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=.obsidian/app.json` — optional
  vault-relative path that must exist for the intended mount to be considered
  available. Strongly recommended.
- `OBSIDIAN_EVERYWHERE_MOUNT_RECHECK_MS` — runtime mount probe interval
  (default `5000`).

`OBSIDIAN_EVERYWHERE_REQUIRE_NONEMPTY_VAULT=true` remains a deprecated
compatibility alias for enabling the guard.

If a scan still ends up short, `obsidian-everywhere doctor <vault-path>`
reports the note count it found — rerun it after confirming the drive is
fully mounted, then restart the server to force a fresh `fullScan`.
