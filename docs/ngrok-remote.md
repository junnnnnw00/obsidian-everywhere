# Remote Vault Bridge with ngrok

[English](ngrok-remote.md) | [한국어](ngrok-remote.ko.md)

This tutorial connects an MCP client running on an external server to an
Obsidian vault that stays on your local machine. The remote agent gets the full
Obsidian Everywhere toolset: graph navigation, full-text and semantic search,
token-budgeted context bundles, and—when you enable them—guarded note edits.

```text
remote Claude Code / Codex
           │  MCP over HTTPS + Bearer token
           ▼
     stable ngrok URL
           │  encrypted tunnel; no inbound router port
           ▼
Obsidian Everywhere HTTP server
           │  direct filesystem access
           ▼
      local Obsidian vault
```

The tunnel does not upload or synchronize the vault. Obsidian Everywhere still
runs beside the vault and reads the files locally; ngrok forwards authenticated
MCP requests to it.

## Security model

The bearer token grants every tool exposed by this HTTP process. Treat it like a
password to the vault.

- Use a freshly generated 32-byte or longer random token.
- Keep the local HTTP port bound behind a firewall; expose only the ngrok HTTPS
  URL.
- Start in read-only mode. Enable writes only after remote reads are verified.
- Never paste the token into an issue, chat, shell history screenshot, or log.
- Rotate the token if it is disclosed.
- The server compares tokens in constant time and rate-limits failed bearer
  authentication, but a strong secret and HTTPS remain essential.
- This is a single-user bridge, not a multi-tenant authorization system.

For multiple users or browser-based public connectors, prefer the OAuth
transport described in [deploy.md](deploy.md).

## Prerequisites

- Node.js 20.9–26 on the machine that can read the vault.
- An [ngrok account and agent](https://ngrok.com/download).
- A stable ngrok development or custom domain. Current free accounts receive
  one assigned development domain; check the ngrok dashboard for its exact
  hostname.
- Claude Code, Codex, or another Streamable HTTP MCP client on the external
  server.

Run these checks on the vault machine:

```bash
npx -y obsidian-everywhere doctor "/absolute/path/to/vault"
test -e "/absolute/path/to/vault/.obsidian/app.json"
```

The second command checks the recommended mount sentinel. If your vault does
not have `.obsidian/app.json`, choose another existing vault-relative path that
only appears when the intended drive/share is mounted.

## 1. Generate the MCP bearer token

```bash
openssl rand -hex 32
```

Store the result in a password manager. The ngrok authtoken and the MCP bearer
token are different credentials:

- **ngrok authtoken**: lets the local ngrok agent open endpoints in your ngrok
  account.
- **MCP bearer token**: authorizes a remote MCP client to use your vault tools.

Do not reuse one as the other.

## 2. Start Obsidian Everywhere locally

Start read-only for the first connection:

```bash
export OBSIDIAN_VAULT_PATH="/absolute/path/to/vault"
export OBSIDIAN_EVERYWHERE_TOKEN="<your-new-MCP-bearer-token>"
export OBSIDIAN_EVERYWHERE_READONLY=true
export OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true
export OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=".obsidian/app.json"
export PORT=3737

npx -y --package obsidian-everywhere obsidian-everywhere-http
```

In another terminal:

```bash
curl --fail http://127.0.0.1:3737/healthz
```

A healthy response looks like:

```json
{"ok":true,"vaultState":"healthy","mountGuardEnabled":true}
```

The Beta mount guard is opt-in. When enabled it:

1. refuses an empty or sentinel-less mount at startup;
2. preserves the existing index if the mount disappears at runtime;
3. blocks all write tools while the index may be stale;
4. fully reconciles the index when the mount returns;
5. rolls a guarded scan back if the mount disappears before it can commit.

Without a sentinel, the guard falls back to a non-empty top-level directory
check. A sentinel is safer because an unmounted fallback directory can itself
contain unrelated files.

## 3. Configure ngrok

Install and authenticate the ngrok agent:

```bash
ngrok config add-authtoken "<your-ngrok-authtoken>"
ngrok config check
```

`ngrok config check` prints the active configuration path. Typical locations
are:

| OS | Default path |
|---|---|
| macOS | `~/Library/Application Support/ngrok/ngrok.yml` |
| Linux | `~/.config/ngrok/ngrok.yml` |
| Windows | `%LocalAppData%\ngrok\ngrok.yml` |

Use ngrok Agent config v3:

```yaml
version: "3"

agent:
  authtoken: <your-ngrok-authtoken>

endpoints:
  - name: obsidian-everywhere
    url: https://your-assigned-domain.ngrok-free.app
    upstream:
      url: http://127.0.0.1:3737
```

Validate and start only this endpoint:

```bash
ngrok config check
ngrok start obsidian-everywhere
```

From a different network or the external server:

```bash
curl --fail https://your-assigned-domain.ngrok-free.app/healthz
```

The ngrok browser interstitial does not affect programmatic API requests. Do
not add `ngrok-skip-browser-warning` to MCP configuration unless a future ngrok
behavior specifically requires it.

## 4. Register the remote MCP client

### Claude Code

On the external server:

```bash
claude mcp add --transport http obsidian-everywhere \
  https://your-assigned-domain.ngrok-free.app/mcp \
  --header "Authorization: Bearer <your-MCP-bearer-token>"

claude mcp get obsidian-everywhere
```

The result should report `Type: http` and `Status: Connected`. Do not share the
unredacted output because it includes the Authorization header.

### Codex

```bash
export OBSIDIAN_EVERYWHERE_CLIENT_TOKEN="<your-MCP-bearer-token>"

codex mcp add obsidian-everywhere \
  --url https://your-assigned-domain.ngrok-free.app/mcp \
  --bearer-token-env-var OBSIDIAN_EVERYWHERE_CLIENT_TOKEN
```

Make sure the environment variable is available to the process that launches
Codex or ChatGPT Desktop.

## 5. Verify context before enabling writes

Start a fresh remote client session and ask it to:

1. call `vault_status`;
2. call `list_notes(limit=5, recursive=true)`;
3. search for a topic you know exists;
4. call `get_context_bundle` for that topic.

Verify that:

- `vault_status` says `healthy`;
- note counts match `obsidian-everywhere doctor` on the vault machine;
- the returned folders and notes belong to the intended vault;
- context bundles include the expected linked neighbors.

If the count is zero, do not enable writes. See Troubleshooting below.

## 6. Enable remote writes

Stop the local HTTP process, remove the read-only flag, and start it again:

```bash
unset OBSIDIAN_EVERYWHERE_READONLY
npx -y --package obsidian-everywhere obsidian-everywhere-http
```

Test with a disposable note and explicit user approval:

1. create `Remote Bridge Test.md`;
2. read it back from the remote client;
3. confirm it appears in Obsidian;
4. delete it using the default recoverable trash behavior.

Successful writes are indexed synchronously before the MCP response returns.
The next remote tool call sees the new state without waiting for the filesystem
watcher.

## 7. Run both services automatically

### macOS

From a source checkout:

```bash
OBSIDIAN_VAULT_PATH="/absolute/path/to/vault" \
OBSIDIAN_EVERYWHERE_TOKEN="<your-MCP-bearer-token>" \
OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true \
OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=".obsidian/app.json" \
./scripts/install-launchagent.sh
```

Then install ngrok's native service using the config path printed by
`ngrok config check`:

```bash
sudo ngrok service install --config "/absolute/path/to/ngrok.yml"
sudo ngrok service start
```

The LaunchAgent uses `RunAtLoad` and `KeepAlive`. If the external drive is not
mounted at login, mount-guard makes startup fail closed and launchd retries
instead of replacing the populated index with an empty scan.

### Linux

Docker Compose is the least host-specific option:

```bash
cp .env.example .env
```

Set at minimum:

```dotenv
OBSIDIAN_VAULT_HOST_PATH=/absolute/path/to/vault
OBSIDIAN_EVERYWHERE_TOKEN=<your-MCP-bearer-token>
OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true
OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=.obsidian/app.json
```

Then:

```bash
docker compose up -d obsidian-everywhere
ngrok service install --config /absolute/path/to/ngrok.yml
ngrok service start
```

If the vault is a network share, mount it at the host OS level before Docker.
The sentinel must be expressed relative to the container's `/vault` root.

### Windows

Use an absolute Windows host path in `.env`, start the HTTP service with Docker
Compose, and install ngrok as a Windows service:

```powershell
ngrok service install --config "$env:LocalAppData\ngrok\ngrok.yml"
ngrok service start
```

Use `.obsidian/app.json` with forward slashes as the vault-relative sentinel.

## Operations

### Health and status

- `GET /healthz`: unauthenticated, minimal service/mount status. Probes the
  mount immediately and returns `503` while guarded content may be stale.
- `vault_status`: probes immediately, then returns authenticated detail
  including indexed counts, write availability, sentinel, and last
  reconciliation.
- `vault_overview`: includes a warning when indexed reads may be stale.

### Token rotation

1. Generate a new MCP bearer token.
2. Update the local service environment and restart it.
3. Remove and re-add the remote MCP registration with the new header.
4. Confirm the old token receives `401`.

Rotating the ngrok authtoken does not rotate the MCP bearer token.

### Backups

Remote write access makes normal vault backups more important. Use Obsidian
Sync, Git, filesystem snapshots, or another system you already trust.
Obsidian Everywhere's bulk operations add rollback snapshots, but they are not
a replacement for a vault backup.

## Troubleshooting

| Symptom | Likely cause | Check |
|---|---|---|
| MCP is `Connected`, but reports 0 notes | The HTTP process indexed an empty/wrong mount | Compare `vault_status`, local `doctor`, and the configured absolute path; enable mount-guard with a sentinel |
| `/healthz` returns 503 | Mount is unavailable or reconciliation is running | Restore the drive/share; watch service logs; wait for `vault_status: healthy` |
| 401 Unauthorized | Client and server bearer tokens differ | Re-enter the MCP registration; redact output before sharing |
| 429 Too Many Requests | Repeated invalid bearer attempts | Stop the bad client, verify its header, then wait for the auth-failure window |
| ngrok URL works in a browser but MCP fails | Wrong `/mcp` URL or Authorization header | Use `https://domain/mcp`, not just the origin |
| `list_notes` is correct locally but wrong remotely | ngrok points to another local port/process | Inspect the ngrok `upstream.url` and Traffic Inspector |
| Writes say they are blocked | mount-guard is unavailable/reconciling | Do not bypass it; restore the mount and wait for reconciliation |
| URL changed after restart | An ephemeral endpoint was used | Configure the assigned stable development domain or a reserved/custom domain |
| Native SQLite module version error | Node version changed after install | Use a supported Node version and reinstall/rebuild dependencies |

ngrok's local Traffic Inspector is normally available at
`http://127.0.0.1:4040` when the foreground agent enables it. The ngrok
Dashboard Traffic Inspector also shows whether requests reached the intended
upstream. Captured MCP bodies may contain private note data; enable full-body
capture only when necessary and disable it afterward.

## What this feature is—and is not

Remote Vault Bridge provides remote access to one locally mounted vault. It
does not:

- synchronize vault files between machines;
- provide multi-user authorization or per-folder permissions;
- make concurrent edits conflict-free;
- keep serving fresh file content while the vault is unmounted.

During a guarded outage, indexed read/search results remain available but are
explicitly marked stale; writes are denied until reconciliation succeeds.
