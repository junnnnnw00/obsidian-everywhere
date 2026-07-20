<div align="center">

[English](README.md) | [한국어](README.ko.md)

# 🧠 Obsidian Everywhere

**Your Obsidian vault, as a graph, in Codex, ChatGPT, Claude, and other MCP clients.**

[![CI](https://github.com/junnnnnw00/obsidian-everywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/junnnnnw00/obsidian-everywhere/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518.17-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-server-6b4fbb)](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

*Codex CLI · ChatGPT Desktop (Codex) · Claude Code/Desktop · remote clients — one server, every surface.*

</div>

---

**This is a graph server, not a markdown file server.** Your AI client shouldn't see
your vault as "a folder of `.md` files" — it should see notes and links as a
graph: backlink traversal, n-hop neighborhoods, and topic-centered context
bundles are first-class tools, not an afterthought bolted onto a file
reader. Unresolved links stay in the graph (that's a real signal about your
vault, same as it is in Obsidian itself), and every response is structured
for what an LLM actually needs — explicit link relationships, not just raw
text.

## Contents

- [Features](#features)
- [Where does this actually run?](#where-does-this-actually-run)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Development](#development)
- [Project status](#project-status)
- [Contributing](#contributing)
- [License](#license)

## Features

```
vault (.md files)
  │  parse · watch
  ▼
SQLite index (FTS5)  ⇄  in-memory graph (graphology)
  │                       n-hop · shortest path · PageRank
  ▼
31 MCP tools
  │
  ▼
stdio  ·  bearer-token HTTP  ·  OAuth HTTP
```

- 🧩 **Real graph engine** — a markdown parser (wikilinks, embeds,
  frontmatter, nested tags, headings, block references), a SQLite index
  with full-text search, and an in-memory [graphology](https://graphology.github.io/)
  layer for n-hop traversal, shortest paths, and PageRank — kept in sync
  incrementally as files change, never rebuilt from scratch.
- 🛠️ **31 graph-native MCP tools** — graph navigation, structured/paginated reads, safe lifecycle and partial edits, rollback-capable bulk cleanup, regex/listing, Base checks, and persisted Obsidian settings.
- 🔌 **Three ways to connect** — stdio for local MCP clients (including
  Codex CLI, ChatGPT Desktop, and Claude), Streamable HTTP with a static
  bearer token for private remote clients, and Streamable HTTP with OAuth
  2.1 (PKCE + Dynamic Client Registration) for public connectors.

<details>
<summary><strong>Full tool list</strong></summary>

**Read**

| Tool | What it does |
|---|---|
| `vault_overview` | Note counts, top tags, PageRank hub notes, recently modified — a starting orientation |
| `search_notes` | Full-text search with tag/folder filters, each result annotated with link counts and tags |
| `read_note` | Structured content/frontmatter/links/tags plus line pagination; optional heading-scoped read |
| `list_notes` | Explicit folder-aware note listing with pagination |
| `list_folder` | Immediate child folders, notes, and attachments |
| `regex_search` | JavaScript-regex search with file, line, and excerpt |
| `get_backlinks` | Every note linking to a given note, with the linking sentence |
| `get_neighborhood` | Explicit n-hop node/edge list around a note (links treated as undirected) |
| `get_context_bundle` | **The killer feature.** Center note + prioritized 1-hop neighbors packed into a token budget |
| `list_tags` | Full nested tag hierarchy with counts |
| `get_notes_by_tag` | Notes carrying a given tag (nested-aware) |
| `find_orphans` | Notes with no incoming or outgoing links |
| `find_unresolved` | Links that don't resolve to any note, grouped by target |
| `find_path` | Shortest connection path between two notes, with a one-line summary per hop |
| `get_related` | Similar notes that *aren't* directly linked yet (Jaccard similarity over shared tags/neighbors) |
| `get_hotkeys` / `get_obsidian_settings` | Persisted hotkey command IDs, Templates folder, and core-plugin settings |
| `validate_base` | Static YAML/shape validation for `.base` files or fenced Base blocks |

**Write**

| Tool | What it does |
|---|---|
| `create_note` | Create a new note (with frontmatter); reindexed immediately — the next tool call already sees it |
| `append_to_note` | Append to a note, optionally under a specific heading; fails closed if the heading isn't found |
| `move_note` / `rename_note` / `delete_note` | Lifecycle operations with inbound-link rewriting, backlink guardrails, and recoverable trash |
| `replace_text` / `patch_section` | Guarded exact-text and heading-scoped edits |
| `update_frontmatter` / `remove_frontmatter_field` | Change properties without replacing the note body |
| `bulk_replace` / `rollback_bulk_edit` | Dry-run-first folder/regex replacement with snapshots and rollback |
| `set_hotkey` / `set_templates_folder` | Update persisted Obsidian settings (vault reload may be required) |

Write tools are on by default for stdio and the
bearer-token HTTP transport, and off by default for the public OAuth
connector transport (opt in with `OAUTH_ENABLE_WRITE_TOOLS=true`) — see
[Configuration](#configuration) and DECISIONS.md D15.

</details>

See [`docs/architecture.md`](docs/architecture.md) for how it's built and
[`docs/deploy.md`](docs/deploy.md) for the full deployment topology
(LaunchAgent, Docker, Cloudflare Tunnel).

## Where does this actually run?

**The `obsidian-everywhere` process needs direct filesystem access to your
vault's `.md` files** (to parse them, watch for changes, etc.) — so it
must always run on **the machine where your vault physically lives**
("the vault machine": your laptop, most likely). It does not matter which
client machine you're working from — the *server* always runs on the vault
machine; only the *client* connection method changes.

| Where you use the MCP client | What you need |
|---|---|
| The same machine as the vault | **stdio.** Nothing else — Codex, ChatGPT Desktop, Claude Code/Desktop, or another local client spawns the server directly. |
| A different machine you control (a lab/work server, another laptop, an SSH box) | **Bearer-token HTTP** + a private network between the two machines (we recommend [Tailscale](https://tailscale.com/download)). |
| claude.ai (web app or mobile app) | **OAuth HTTP** + a public HTTPS URL (via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)). claude.ai runs in Anthropic's cloud, not your network, so it can't reach Tailscale or `localhost` — it needs a real public address. |

You can run more than one of these at once (e.g. stdio on your laptop
*and* bearer-token HTTP for your work server) — they're independent
processes that all index the same vault.

## Quickstart

Run this **on the vault machine** (wherever your `.md` files live):

```bash
git clone https://github.com/junnnnnw00/obsidian-everywhere.git
cd obsidian-everywhere
npm install
npm run build
```

### Option A — Codex CLI and ChatGPT Desktop, same machine as the vault (stdio)

Codex CLI, the Codex IDE extension, and ChatGPT Desktop's Codex experience
share the same MCP configuration ([official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)).
Add the server once:

```bash
codex mcp add obsidian-everywhere -- node "$(pwd)/dist/cli.js" /absolute/path/to/your/vault
codex mcp list
```

Then restart ChatGPT Desktop (or the IDE extension). In ChatGPT Desktop you
can also add it through **Settings → MCP servers → Add server**, choose
**STDIO**, and enter the same command and arguments. Type `/mcp` in Codex to
confirm that the server and its 31 tools are connected.

For a project-scoped configuration instead, add this to a trusted project's
`.codex/config.toml`; use `~/.codex/config.toml` to make it available globally:

```toml
[mcp_servers.obsidian-everywhere]
command = "node"
args = ["/absolute/path/to/obsidian-everywhere/dist/cli.js", "/absolute/path/to/your/vault"]
startup_timeout_sec = 30
```

Use absolute paths. GUI apps often do not inherit the same `PATH` as your
terminal; if `node` is not found, replace `command` with the result of
`command -v node`.

### Option A′ — Claude Code, same machine as the vault (stdio)

Still on the vault machine:

```bash
claude mcp add obsidian-everywhere -- node "$(pwd)/dist/cli.js" /path/to/your/vault
```

Or with environment variables instead of a positional arg:

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/vault claude mcp add obsidian-everywhere -- node "$(pwd)/dist/cli.js"
```

### Option A″ — Claude Desktop, same machine as the vault

Add to `claude_desktop_config.json` on the vault machine:

```json
{
  "mcpServers": {
    "obsidian-everywhere": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-everywhere/dist/cli.js", "/absolute/path/to/your/vault"]
    }
  }
}
```

### Option A‴ — Google Antigravity CLI (agy)

Add to your global Antigravity MCP configuration file (`~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "obsidian-everywhere": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-everywhere/dist/cli.js", "/absolute/path/to/your/vault"]
    }
  }
}
```

### Option B — Codex, ChatGPT Desktop, or Claude on a different machine

**Step 1 — set up a private network between the two machines**, if you
don't have one already. Easiest option is Tailscale:

```bash
# on BOTH the vault machine and the MCP client machine
curl -fsSL https://tailscale.com/install.sh | sh   # or: brew install tailscale (macOS)
tailscale up                                        # opens a browser to log in / join your "tailnet"
tailscale status                                    # confirm both machines can see each other
```

Note the vault machine's Tailscale hostname/IP from `tailscale status`
(something like `my-macbook.tailnet-name.ts.net` or `100.x.y.z`).

**Step 2 — start the server, on the vault machine:**

```bash
OBSIDIAN_VAULT_PATH=/path/to/vault OBSIDIAN_EVERYWHERE_TOKEN=$(openssl rand -hex 32) \
  node dist/http-cli.js
```

Keep this token — you'll need it in step 3. (To keep this running
persistently instead of in a foreground terminal, see the LaunchAgent
setup in [`docs/deploy.md`](docs/deploy.md#2-remote-clients-over-tailscale-static-bearer-token),
or run it in Docker via `docker-compose.yml` if the vault machine is a server.)

**Step 3 — connect from the *other* machine** (the lab server, etc.), using
the vault machine's Tailscale address from step 1. For Codex (and the shared
ChatGPT Desktop configuration), keep the token in an environment variable:

```bash
export OBSIDIAN_EVERYWHERE_CLIENT_TOKEN="<the token from step 2>"
codex mcp add obsidian-everywhere \
  --url http://<vault-machine-tailscale-name>:3737/mcp \
  --bearer-token-env-var OBSIDIAN_EVERYWHERE_CLIENT_TOKEN
```

Ensure ChatGPT Desktop is launched with that environment variable available,
then restart it. Alternatively, use **Settings → MCP servers** to add the
Streamable HTTP URL and bearer credential if your app version exposes those
fields.

For Claude Code:

```bash
claude mcp add --transport http obsidian-everywhere \
  http://<vault-machine-tailscale-name>:3737/mcp \
  --header "Authorization: Bearer <the token from step 2>"
```

The second machine now has access to the vault indexed on the first. Full
walkthrough (Docker, LaunchAgent):
[`docs/deploy.md`](docs/deploy.md#2-remote-clients-over-tailscale-static-bearer-token).

### Option C — claude.ai web/mobile app (custom connector, OAuth)

This needs a public HTTPS endpoint — claude.ai's servers can't reach your
Tailscale network or `localhost`. See
[`docs/deploy.md`](docs/deploy.md#3-claudeai-webmobile-custom-connector-oauth-21--cloudflare-tunnel)
for the full Cloudflare Tunnel walkthrough (including the no-domain-needed
Quick Tunnel option for testing). Once your server is reachable at
`https://your-domain`:

1. claude.ai → Settings → Connectors → Add custom connector
2. Server URL: `https://your-domain/mcp`
3. claude.ai auto-discovers the OAuth flow and shows this server's sign-in
   page — enter the `OAUTH_LOGIN_SECRET` you configured.

**You only need this if you actually want claude.ai's web/mobile apps to
read your vault.** If you only ever use Claude Code (locally or from
another machine), skip this entirely — Option A/B already fully covers
that with no Cloudflare/OAuth involved.

## Configuration

| Env var | Used by | Meaning |
|---|---|---|
| `OBSIDIAN_VAULT_PATH` | all | Vault path (or pass as a positional CLI arg) |
| `OBSIDIAN_EVERYWHERE_DB` | all | SQLite index path override. Defaults are transport-specific: `index-stdio.db`, `index-http.db`, or `index-oauth.db` under `<vault>/.obsidian-everywhere/`. |
| `OBSIDIAN_EVERYWHERE_TOKEN` | `http-cli.js` | Static bearer token |
| `PORT` | `http-cli.js`, `oauth-http-cli.js` | HTTP port (defaults 3737 / 3738) |
| `OAUTH_ISSUER_URL` | `oauth-http-cli.js` | Public HTTPS origin (e.g. your Cloudflare Tunnel hostname) |
| `OAUTH_LOGIN_SECRET` | `oauth-http-cli.js` | Single-user login secret |
| `OBSIDIAN_EVERYWHERE_READONLY` | `cli.js`, `http-cli.js` | Set to `true` to disable all write tools (default: write tools on) |
| `OAUTH_ENABLE_WRITE_TOOLS` | `oauth-http-cli.js` | Set to `true` to enable all write tools on the public connector (default: off) |

## Development

```bash
npm run dev:stdio          # tsx, no build step
npm run dev:http
npm run dev:oauth-http
npm test                   # vitest, runs against fixtures/test-vault
npm run typecheck
npm run lint
npm run format:check
```

`fixtures/test-vault/` is a 30+ note fixture vault exercising every link
and parsing edge case the parser needs to handle (piped aliases, heading
and block links, embeds, frontmatter-embedded wikilinks, nested tags,
duplicate filenames across folders, unresolved links, code-block
exclusion, and Korean filenames/tags/wikilinks). It's what every test in
`src/**/*.test.ts` runs against.

## Project status

v0.2: full graph engine, all three transports (stdio,
bearer-token HTTP, OAuth HTTP), 31 MCP tools including safe partial/bulk writes, and
client setup for Codex, ChatGPT Desktop, and Claude. Browser/account steps
such as registering a public connector and provisioning a Cloudflare Tunnel
remain manual — see `docs/deploy.md`. Tested against both the fixture vault
and a real 58-note personal vault with Korean content.

## Contributing

Bug reports, feature requests, and PRs are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, testing conventions,
and how the fixture vault relates to the test suite. Security issues:
please see [`SECURITY.md`](SECURITY.md) rather than opening a public issue.

## License

MIT — see [`LICENSE`](LICENSE).
