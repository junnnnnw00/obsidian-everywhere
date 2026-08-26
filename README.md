<div align="center">

[English](README.md) | [한국어](README.ko.md)

# 🧠 Obsidian Everywhere

**Turn linked notes into AI context, use that context from agents anywhere, and checkpoint approved changes with Git.**

[![CI](https://github.com/junnnnnw00/obsidian-everywhere/actions/workflows/ci.yml/badge.svg)](https://github.com/junnnnnw00/obsidian-everywhere/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-20%E2%80%9326-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-server-6b4fbb)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/obsidian-everywhere?logo=npm)](https://www.npmjs.com/package/obsidian-everywhere)
[![npm downloads](https://img.shields.io/npm/dt/obsidian-everywhere?logo=npm&label=downloads)](https://www.npmjs.com/package/obsidian-everywhere)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

*Graph context · local semantic search · remote agents · guarded edits · opt-in Git checkpoints*

[![obsidian-everywhere MCP server](https://glama.ai/mcp/servers/junnnnnw00/obsidian-everywhere/badges/card.svg)](https://glama.ai/mcp/servers/junnnnnw00/obsidian-everywhere)

</div>

## Watch the Remote Vault Bridge in 44 seconds

![Remote Vault Bridge demo — a remote agent searches graph and semantic context, makes a guarded edit, and recovers from a disconnected local vault](assets/remote-vault-bridge-demo.gif)

[Remote setup guide](docs/ngrok-remote.md)

*Remote request → semantic search → graph context → guarded edit → mount-loss recovery.*

---

Obsidian Everywhere is built around three ideas:

1. **Notes are a graph and a semantic knowledge base, not a folder of text
   files.** Backlinks, n-hop neighborhoods, shortest paths, PageRank, full-text
   search, and local multilingual embeddings turn a topic into focused,
   token-budgeted context.
2. **Your vault should be usable where your agents run.** The Remote Vault
   Bridge exposes that same graph and its guarded write tools over authenticated
   Streamable HTTP. A Claude Code or Codex process on another server can search,
   reason over, append to, and reorganize a vault that remains on your own
   machine.
3. **Version-control actions deserve a narrower boundary than file writes.** If
   the vault or one configured folder inside it is already a Git repository, the
   opt-in Git tools can inspect status, bounded diffs, and local history. Commit
   and push each require a preview, explicit confirmation, and a short-lived
   one-use approval ID.

The local path stays the source of truth. Obsidian Everywhere does not create a
hosted copy, telemetry service, or mandatory cloud account; optional Git push
publishes only to a repository the operator already configured. Remote access
is a transport you operate, not a vault-sync product.

## Contents

- [Watch the Remote Vault Bridge in 44 seconds](#watch-the-remote-vault-bridge-in-44-seconds)
- [Features](#features)
- [Three core workflows](#three-core-workflows)
- [Vault Git](#vault-git)
- [Try it without your vault](#try-it-without-your-vault)
- [Why Obsidian Everywhere?](#why-obsidian-everywhere)
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
41 core MCP tools + 0–5 opt-in Git tools
  │
  ▼
local stdio  ·  authenticated remote HTTP  ·  OAuth HTTP
```

- 🧩 **Graph + semantic context engine** — a markdown parser (wikilinks, embeds,
  frontmatter, nested tags, headings, block references), a SQLite index
  with full-text search, and an in-memory [graphology](https://graphology.github.io/)
  layer for n-hop traversal, shortest paths, and PageRank. `get_context_bundle`
  packs a topic and its most useful neighbors into a requested token budget.
- 🌍 **Remote Vault Bridge** — agents on an external server get the same search,
  graph, context, and guarded editing tools over authenticated Streamable HTTP.
  Use a private network or an HTTPS tunnel such as ngrok; the vault itself stays
  on the machine you control.
- 📎 **Vault-wide file reading** — Markdown plus text/code/data files, PDF,
  DOCX, PPTX, XLSX, OpenDocument, EPUB, RTF, and common images are indexed and
  exposed without uploading them to a conversion service. Extraction is lazy,
  cached, size-limited, and searchable with `search_files`.
- 🧠 **Optional local semantic search** — `semantic_search` and `get_related` with
  `method: "semantic"` run a multilingual embedding model
  (`multilingual-e5-small`) entirely on your machine — no API key, cloud
  account, or Ollama process to run. Install the optional runtime with
  `npm install @huggingface/transformers@^4.2.0`; its model downloads once
  (~120MB, cached under
  `~/.obsidian-everywhere/`), then works fully offline. It is disabled by
  default to keep the server below the 200 MiB memory target; opt in with
  `OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC=true` when extra memory is available.
- 🛡️ **Safe writes and resilient mounts** — partial edits, dry-run-first bulk
  operations, rollback snapshots, recoverable deletion, and an opt-in Beta
  mount guard. If a removable drive, NAS share, or container mount disappears,
  the index is preserved, writes are blocked, and a full reconciliation runs
  after it returns.
- 🌱 **Reviewable Git checkpoints (off by default)** — inspect status, bounded
  diffs, and local history for the vault or one configured repository folder.
  Higher modes add selected-file commits and operator-pinned HTTPS pushes, both
  behind preview and a five-minute one-use approval.
- 🛠️ **41 core MCP tools, up to 46 when Git is explicitly enabled** — structured
  reads, attachment extraction, graph navigation, semantic retrieval, safe
  lifecycle operations, persisted Obsidian settings, and explicit health
  reporting.

## Three core workflows

### 1. Turn a linked vault into focused AI context

Exact search finds the words you wrote. Semantic search finds the idea even
when the wording or language differs. Graph traversal then explains how the
matching notes relate. `get_context_bundle` combines those signals into a
bounded context package instead of dumping an entire vault into the model.

### 2. Use and edit that context from an external server

Run Obsidian Everywhere beside the local vault, expose its HTTP endpoint through
your private network or an HTTPS tunnel, and register the URL in the remote MCP
client. The remote agent can read and search the local vault, then use the same
guarded tools to create, append, move, tag, or clean up notes. The server
reindexes each successful write before returning, so the next remote tool call
sees the change.

For the complete ngrok path, see the
**[Remote Vault Bridge with ngrok tutorial](docs/ngrok-remote.md)**.

### 3. Review and checkpoint vault changes with Git

When the vault or one real folder inside it contains its own `.git` directory,
an agent can inspect the same repository state you would inspect locally, then
create a commit from an explicit file list. Set
`OBSIDIAN_EVERYWHERE_GIT_REPO_PATH` to that vault-relative folder, or leave its
default `.` to use the vault root. Push is a separate, stricter capability: it
can only publish the current `HEAD` to its existing upstream branch through an
operator-pinned HTTPS destination. It never pulls, fetches, changes branches,
constructs a free-form refspec, or accepts arbitrary Git arguments.

Start with `OBSIDIAN_EVERYWHERE_GIT_MODE=read`; move to `commit` or `push` only
after reviewing the safety model in the **[Vault Git guide](docs/git-vault.md)**.

<details>
<summary><strong>Full tool list</strong></summary>

**Read**

| Tool | What it does |
|---|---|
| `vault_overview` | Note counts, top tags, PageRank hub notes, recently modified — a starting orientation |
| `vault_status` | Mount availability, index freshness, write availability, and last full reconciliation |
| `search_notes` | Full-text search with tag/folder filters (with a trigram fallback for CJK substring matches unicode61 alone would miss — see DECISIONS.md D9), each result annotated with link counts and tags |
| `search_files` | Search extracted text across PDF, Office/OpenDocument, EPUB, RTF, text/code/data, and Markdown-linked attachments |
| `semantic_search` | Optional meaning-based search via local embeddings (`multilingual-e5-small`, no external service); disabled in the default low-memory mode |
| `read_note` | Structured content/frontmatter/links/tags plus line pagination; optional heading-scoped read |
| `read_file` | Read any indexed vault file: extracted document text with page/slide/sheet selection, or native image content for capable MCP clients |
| `list_notes` | Explicit folder-aware note listing with pagination; optionally projects named frontmatter fields (e.g. `status`, `project`) per note |
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
| `get_related` | Similar notes that *aren't* directly linked yet — Jaccard over shared tags/neighbors by default, or `method: "semantic"` for embedding similarity |
| `get_hotkeys` / `get_obsidian_settings` | Persisted hotkey command IDs, Templates folder, and core-plugin settings |
| `validate_base` | Static YAML/shape validation for `.base` files or fenced Base blocks |

**Write**

| Tool | What it does |
|---|---|
| `create_note` | Create a new note (with frontmatter); reindexed immediately — the next tool call already sees it |
| `apply_template` | Create a note from a template, substituting `{{date}}`/`{{time}}`/`{{title}}` (Obsidian's core Templates variables) |
| `append_to_note` | Append to a note, optionally under a specific heading; fails closed if the heading isn't found |
| `move_note` / `rename_note` / `delete_note` | Lifecycle operations with inbound-link rewriting, backlink guardrails, and recoverable trash |
| `replace_text` / `patch_section` | Guarded exact-text and heading-scoped edits |
| `update_frontmatter` / `remove_frontmatter_field` | Change properties without replacing the note body |
| `bulk_update_frontmatter` / `bulk_remove_frontmatter_field` | Same, across every note in a folder (or the whole vault); dry-run first with rollback |
| `add_tags` / `remove_tags` | Add or remove frontmatter tags on one note |
| `rename_tag` | Rename a tag vault-wide across frontmatter and inline `#tag` text, dry-run first with rollback |
| `bulk_replace` / `rollback_bulk_edit` | Dry-run-first folder/regex replacement with snapshots and rollback |
| `set_hotkey` / `set_templates_folder` | Update persisted Obsidian settings (vault reload may be required) |

**Vault Git — registered only when explicitly enabled**

| Tool | Minimum Git mode | What it does |
|---|---|---|
| `git_status` | `read` | Safe, selected-repository-relative working-tree status and local ahead/behind information; no fetch |
| `git_diff` | `read` | Bounded patch for safe tracked paths, plus explicitly named untracked paths in `head` mode; external diff drivers, textconv, and submodules stay disabled |
| `git_log` | `read` | Recent local commit history, optionally for one safe file |
| `git_commit` | `commit` + normal write gate | Preview, then commit only explicitly selected safe files using a five-minute one-use approval ID |
| `git_push` | `push` + normal write gate | Preview, then push the approved current `HEAD` to its existing upstream through an operator-pinned HTTPS destination |

| Effective setup | Registered tools |
|---|---:|
| Git `off`, ordinary writes disabled | 22 |
| Git `off`, ordinary writes enabled | 41 |
| Git `read`, ordinary writes disabled | 25 |
| Git `read`, ordinary writes enabled | 44 |
| Git `commit`, ordinary writes disabled | 25 |
| Git `commit`, ordinary writes enabled | 45 |
| Git `push`, ordinary writes disabled | 25 |
| Git `push`, ordinary writes enabled | 46 |

If the ordinary write gate is disabled, `git_commit` and `git_push` stay absent
even when the configured Git mode is higher; the three Git read tools remain
available. OAuth therefore requires both a sufficient Git mode and
`OAUTH_ENABLE_WRITE_TOOLS=true` for commit or push.

Ordinary write tools are on by default for stdio and the
bearer-token HTTP transport, and off by default for the public OAuth
connector transport (opt in with `OAUTH_ENABLE_WRITE_TOOLS=true`) — see
[Configuration](#configuration) and DECISIONS.md D15. Git is independently off
by default on every transport.

</details>

## Vault Git

Vault Git is an optional checkpoint-and-publish layer for repositories already
inside a vault. It is not a sync engine and it never initializes a repository.
Git must be installed on the vault machine. The operator selects exactly one
repository with `OBSIDIAN_EVERYWHERE_GIT_REPO_PATH`, a safe vault-relative real
directory that defaults to `.`. That selected directory must be the exact root
of a normal repository with a real, local `.git` directory. The rest of the
vault remains indexed and available to ordinary graph, search, and note tools.

For example, a vault at `/Volumes/SanDisk/jwhong` can keep full-vault context
while Git tools operate only on `/Volumes/SanDisk/jwhong/DSLab`:

```bash
export OBSIDIAN_VAULT_PATH=/Volumes/SanDisk/jwhong
export OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=DSLab
export OBSIDIAN_EVERYWHERE_GIT_MODE=read
```

Git tool path inputs and outputs are relative to `DSLab` in that setup;
ordinary note and file tool paths remain relative to the vault root. Parent
repository discovery, linked worktrees, submodule roots, symlinked repository
paths, and unsafe external or symlinked object/ref/log/core metadata
layouts—including alternate object stores—are refused by every Git tool.
The canonical vault, selected repository, and `.git` directory identities are
captured at startup and rechecked before every Git subprocess; replacing a
directory or introducing a symlink fails closed until the operator verifies the
mount and restarts the service.
Commit and push additionally refuse detached branches, shallow history, sparse
checkouts, per-worktree Git configuration, grafts/replacement refs, and
in-progress history operations.

With the supplied Compose file, set
`OBSIDIAN_VAULT_HOST_PATH=/Volumes/SanDisk/jwhong` and
`OBSIDIAN_EVERYWHERE_HTTP_GIT_REPO_PATH=DSLab` for the bearer service. The OAuth
service has its own independent `OBSIDIAN_EVERYWHERE_OAUTH_GIT_REPO_PATH` input;
both service-specific repository paths default to `.`.

Choose the narrowest capability that covers your workflow:

| `OBSIDIAN_EVERYWHERE_GIT_MODE` | Tools added | Network access |
|---|---|---|
| `off` (default) | none | none |
| `read` | `git_status`, `git_diff`, `git_log` | none; history and ahead/behind are local only |
| `commit` | read tools + `git_commit` when ordinary writes are enabled | none |
| `push` | read/commit tools + `git_push` when ordinary writes are enabled | approved push to an existing upstream only |

Push mode also requires a comma-separated operator mapping from each allowed
upstream remote name to one exact credential-free HTTPS destination. Continuing
the `DSLab` example above:

```bash
export OBSIDIAN_EVERYWHERE_GIT_MODE=push
export OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=DSLab
export OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES=origin=https://github.com/owner/repo.git
```

Use `OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=.` instead only when the whole vault is
the repository.

The selected branch must already track a normal branch on the mapped remote,
and that remote's sole resolved push URL must exactly match the pinned mapping.
The URL is operator configuration, never MCP tool input; credentials, queries,
fragments, caller-selected branches, and caller-selected refspecs are refused.
Git must authenticate to that exact URL non-interactively using credentials
already configured on the vault machine.

The destination ref comes from the branch's existing upstream mapping, not from
the local branch name. For example, local `main` tracking `origin/release` can
push only to `release`; the caller cannot substitute another branch.

Commit and push are deliberately two-step operations:

```text
git_status
git_diff
git_commit { action: "preview", message: "docs: update project notes", paths: ["Projects/Atlas.md"] }
  → inspect the plan and explicitly approve it
git_commit { action: "execute", approvalId: "<UUID from preview>" }

git_push { action: "preview" }
  → inspect the exact HEAD, upstream, and outgoing count; explicitly approve it
git_push { action: "execute", approvalId: "<UUID from preview>" }
```

An approval ID expires after five minutes, works once, and is invalidated when
the reviewed repository state changes. A preview never creates a commit or
contacts the network. Hidden, excluded, and sensitive paths are omitted or
blocked; commits select exact changed paths whose resulting entries are regular
files, plus deletions; hooks, signing, clean filters (including Git LFS),
submodules, and suspected secrets are refused.
Push review is capped at 100 outgoing commits and 200 changed blobs, with an
8 MiB per-file/blob and 32 MiB aggregate content limit; commit messages and
merge results are scanned too. Commit messages are single-line and
secret-scanned, and commit approval binds the exact proposed tree.

Push execution uses the displayed literal HTTPS destination and an exact
OID lease for the reviewed upstream ref. That lease is a compare-and-swap
guard—not permission for an arbitrary force-push—so a deleted, advanced, or
reset remote ref fails instead of being overwritten.
Repository-local credential helpers, URL rewrites, `http.*` transport settings,
and selected-remote proxy overrides are also refused for push. Trusted HTTPS
credentials and any required network policy belong in the vault machine's user
or system Git configuration, outside the repository.

There is intentionally no `git_exec` or free-form command tool. Passing raw Git
arguments to a remote agent is effectively a remote-code-execution primitive:
Git aliases can expand to shell commands, hooks execute programs, diff/textconv
drivers run helpers, SSH transports launch commands, and credential helpers may
invoke executables. A small set of fixed commands with fixed arguments is the
safety boundary, not a cosmetic API choice.

Read the complete setup, operational limits, and troubleshooting guide before
enabling commit or push: **[Using a Git-backed vault](docs/git-vault.md)**.

## Try it without your vault

Run the built-in demo first. It creates a temporary sample vault, shows graph
orientation and unresolved-link discovery, previews a safe bulk edit, and then
removes the sample. It never reads or changes your own notes.

```bash
npx -y obsidian-everywhere demo
```

![Obsidian Everywhere demo: context bundles, related-note discovery, graph paths, unresolved links, link-safe moves, and rollback-ready bulk edits](assets/demo.gif)

When you are ready to connect a real vault, generate copyable configuration for
Codex, ChatGPT Desktop, Claude Code, and Claude Desktop:

```bash
npx -y obsidian-everywhere init /absolute/path/to/your/vault
npx -y obsidian-everywhere doctor /absolute/path/to/your/vault
```

`init` only prints configuration—it never edits global client settings.
`doctor` checks Node.js, permissions, Obsidian metadata, SQLite, parsing, and the
graph engine without printing note content. Add `--share` to redact the vault
path before pasting diagnostics into an issue.

## Why Obsidian Everywhere?

There are several good Obsidian MCPs. Pick the architecture that matches how
you work rather than assuming one server wins every category.

| | **Obsidian Everywhere** | [obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) | [TurboVault](https://github.com/epistates/turbovault) |
|---|---|---|---|---|
| Install | `npx` | `npx` | Obsidian community plugin | `cargo install` / binary |
| Published tools | **41 core; up to 46 with opt-in Git** | 14 | 16 | 74 |
| Obsidian must be open | **No** | Yes | Yes | **No** |
| Best graph capability | PageRank, shortest path, n-hop, unresolved links | Outgoing links in structured reads | Live Obsidian metadata/search | Multi-hop, centrality, clusters, suggestions |
| Safe editing | Partial edits; bulk dry-run, snapshot, rollback | Surgical edits and frontmatter/tag management | Live heading/block/frontmatter patching | Conflict hashes, audit rollback, Git-backed batch |
| Live app commands/current file | Persisted settings only | **Yes** | **Yes** | No |
| Remote transport | stdio, bearer HTTP over private network or HTTPS tunnel, **OAuth 2.1** | stdio, HTTP with JWT/OAuth | HTTP with API key | stdio, HTTP, WebSocket, TCP |
| Best fit | Graph + semantic context from a headless vault, including guarded remote access and edits | Rich app-driven CRUD and Omnisearch | Direct control of a running Obsidian app | Maximum breadth, multi-vault and advanced analysis |

Comparison checked against each project's published documentation on
2026-07-20. A blank or narrower cell means “not documented there,” not that a
project can never support it. If you need active-file state or command-palette
execution, choose a plugin-backed server. If you want a headless, one-command
graph server with token-budgeted context, guarded cleanup, and narrowly scoped
Git checkpoints, that is the niche Obsidian Everywhere is designed for.

Everything runs locally by default. There is no account, API key, hosted vault,
or telemetry requirement.

See [`docs/architecture.md`](docs/architecture.md) for how it's built,
[`docs/deploy.md`](docs/deploy.md) for the deployment topology, and
[`docs/ngrok-remote.md`](docs/ngrok-remote.md) for an end-to-end external
server tutorial. Git-backed vault operators should also read
[`docs/git-vault.md`](docs/git-vault.md).

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
| A different machine you control (a lab/work server, another laptop, an SSH box) | **Bearer-token HTTP** over a private network such as [Tailscale](https://tailscale.com/download), or an HTTPS tunnel such as [ngrok](docs/ngrok-remote.md). |
| claude.ai (web app or mobile app) | **OAuth HTTP** + a public HTTPS URL (via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)). claude.ai runs in Anthropic's cloud, not your network, so it can't reach Tailscale or `localhost` — it needs a real public address. |

You can run more than one of these at once (e.g. stdio on your laptop
*and* bearer-token HTTP for your work server) — they're independent
processes that all index the same vault.

## Quickstart

The fastest install needs no clone or build step. Run this **on the vault
machine** (wherever your `.md` files live):

```bash
npx -y obsidian-everywhere /absolute/path/to/your/vault
```

MCP clients normally launch this command for you using one of the
configurations below.

Not sure whether the path and runtime are ready? Run the privacy-safe diagnostic:

```bash
npx -y obsidian-everywhere doctor /absolute/path/to/your/vault
```

### Option A — Codex CLI and ChatGPT Desktop, same machine as the vault (stdio)

Codex CLI, the Codex IDE extension, and ChatGPT Desktop's Codex experience
share the same MCP configuration ([official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)).
Add the server once:

```bash
codex mcp add obsidian-everywhere -- npx -y obsidian-everywhere /absolute/path/to/your/vault
codex mcp list
```

Then restart ChatGPT Desktop (or the IDE extension). In ChatGPT Desktop you
can also add it through **Settings → MCP servers → Add server**, choose
**STDIO**, and enter the same command and arguments. Type `/mcp` in Codex to
confirm that the expected tools are connected: 41 with ordinary writes enabled
and Git off, or the conditional counts documented in [Vault Git](#vault-git).

For a project-scoped configuration instead, add this to a trusted project's
`.codex/config.toml`; use `~/.codex/config.toml` to make it available globally:

```toml
[mcp_servers.obsidian-everywhere]
command = "npx"
args = ["-y", "obsidian-everywhere", "/absolute/path/to/your/vault"]
startup_timeout_sec = 30
```

Use an absolute vault path. GUI apps may not inherit the same `PATH` as your
terminal; if `npx` is not found, replace `command` with the absolute result
of `command -v npx`.

### Option A′ — Claude Code, same machine as the vault (stdio)

Still on the vault machine:

```bash
claude mcp add obsidian-everywhere -- npx -y obsidian-everywhere /path/to/your/vault
```

Or with environment variables instead of a positional arg:

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/vault claude mcp add obsidian-everywhere -- npx -y obsidian-everywhere
```

### Option A″ — Claude Desktop, same machine as the vault

Add to `claude_desktop_config.json` on the vault machine:

```json
{
  "mcpServers": {
    "obsidian-everywhere": {
      "command": "npx",
      "args": ["-y", "obsidian-everywhere", "/absolute/path/to/your/vault"]
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
      "command": "npx",
      "args": ["-y", "obsidian-everywhere", "/absolute/path/to/your/vault"]
    }
  }
}
```

### Option B — Codex, ChatGPT Desktop, or Claude on a different machine

Choose one secure route to the vault machine:

- **Private network:** use Tailscale and follow the steps below.
- **Public HTTPS tunnel:** use the read-only-first
  [ngrok Remote Vault Bridge tutorial](docs/ngrok-remote.md). Never expose
  the local plaintext HTTP port directly.

**Step 1 — set up a private network between the two machines**, if you chose
Tailscale:

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
openssl rand -hex 32
# Save that output in a password manager, then use the same value on both machines.
export OBSIDIAN_EVERYWHERE_TOKEN="<saved token>"
OBSIDIAN_VAULT_PATH=/path/to/vault \
  npx -y --package obsidian-everywhere obsidian-everywhere-http
```

Keep the saved token — you'll need it in step 3. (To keep this running
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
[`docs/deploy.md`](docs/deploy.md#3-claudeai-webmobile-custom-connector-oauth-21-cloudflare-tunnel)
for the full Cloudflare Tunnel walkthrough. Once your server is reachable at
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
| `OBSIDIAN_EVERYWHERE_DB` | all | SQLite index path override. Filenames are transport-specific: `index-stdio.db`, `index-http.db`, or `index-oauth.db`. The normal default is `<vault>/.obsidian-everywhere/<filename>`; a directly launched macOS process whose vault is under `/Volumes/` instead uses a vault-specific file under `~/.obsidian-everywhere/` to avoid unsafe SQLite WAL behavior on external filesystems. Compose sets its own explicit `/vault/.obsidian-everywhere/` paths. |
| `OBSIDIAN_EVERYWHERE_TOKEN` | `http-cli.js` | Static bearer token |
| `PORT` | `http-cli.js`, `oauth-http-cli.js` | HTTP port (defaults 3737 / 3738) |
| `OAUTH_ISSUER_URL` | `oauth-http-cli.js` | Public HTTPS origin (e.g. your Cloudflare Tunnel hostname) |
| `OAUTH_LOGIN_SECRET` | `oauth-http-cli.js` | Single-user login secret |
| `OBSIDIAN_EVERYWHERE_READONLY` | `cli.js`, `http-cli.js` | Set to `true` to disable all write tools (default: write tools on) |
| `OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC` | all | Opt in after installing the optional `@huggingface/transformers` peer. Disabled by default because the model can exceed 500 MiB RSS; graph, FTS, and attachment search remain available. |
| `OBSIDIAN_EVERYWHERE_MAX_ATTACHMENT_MIB` | all | Maximum source attachment size for local extraction (default `64`, range 1–1024). Raising it can exceed the 200 MiB memory target. |
| `OBSIDIAN_EVERYWHERE_MAX_PDF_MIB` | all | PDF-specific extraction limit (default `48`, also capped by the attachment limit). |
| `OBSIDIAN_EVERYWHERE_MAX_ARCHIVE_ENTRY_MIB` | all | Maximum uncompressed XML/HTML entry read from Office/OpenDocument/EPUB archives (default `32`). |
| `OBSIDIAN_EVERYWHERE_MOUNT_GUARD` | all entrypoints | Opt-in Beta mount-loss protection and automatic reconciliation |
| `OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL` | all entrypoints | Optional vault-relative identity path, e.g. `.obsidian/app.json` |
| `OBSIDIAN_EVERYWHERE_MOUNT_RECHECK_MS` | all entrypoints | Runtime mount probe interval (default `5000`) |
| `OAUTH_ENABLE_WRITE_TOOLS` | `oauth-http-cli.js` | Set to `true` to enable all write tools on the public connector (default: off) |
| `OBSIDIAN_EVERYWHERE_GIT_MODE` | direct processes and container environment | Git capability: `off` (default), `read`, `commit`, or `push`. `commit`/`push` still require the transport's ordinary write gate. |
| `OBSIDIAN_EVERYWHERE_GIT_REPO_PATH` | direct processes and container environment | One safe vault-relative real directory containing the repository; defaults to `.`. Git tool paths are relative to this directory, while ordinary tool paths remain vault-relative. |
| `OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES` | direct processes and container environment | Comma-separated exact `name=https://host/path.git` mappings, e.g. `origin=https://github.com/owner/repo.git`; required in `push` mode. URLs must contain no credentials, query, or fragment. |
| `OBSIDIAN_EVERYWHERE_HTTP_GIT_MODE` / `OBSIDIAN_EVERYWHERE_HTTP_GIT_REPO_PATH` / `OBSIDIAN_EVERYWHERE_HTTP_GIT_ALLOWED_PUSH_REMOTES` | supplied Docker Compose `.env` | Bearer-service inputs mapped to the three generic Git variables inside its container; mode defaults to `off` and repository path to `.`. |
| `OBSIDIAN_EVERYWHERE_OAUTH_GIT_MODE` / `OBSIDIAN_EVERYWHERE_OAUTH_GIT_REPO_PATH` / `OBSIDIAN_EVERYWHERE_OAUTH_GIT_ALLOWED_PUSH_REMOTES` | supplied Docker Compose `.env` | Independent OAuth-service inputs mapped inside its container; mode defaults to `off` and repository path to `.`. OAuth commit/push still requires `OAUTH_ENABLE_WRITE_TOOLS=true`. |

Obsidian Everywhere does not modify a user's vault `.gitignore`. Built-in
Vault Git rejects hidden `.obsidian-everywhere` paths, but if an index directory
falls inside a repository you also manage with ordinary Git, add
`.obsidian-everywhere/` to that repository's own `.gitignore`.

Git configuration is independent of semantic search and ordinary note tools.
For stdio and bearer HTTP, `OBSIDIAN_EVERYWHERE_READONLY=true` removes both
ordinary write tools and Git commit/push. For OAuth, commit/push require both
`OBSIDIAN_EVERYWHERE_GIT_MODE=commit|push` and
`OAUTH_ENABLE_WRITE_TOOLS=true`. `git_status`, `git_diff`, and `git_log` remain
read-only tools at every mode above `off`.

Direct CLI, HTTP, OAuth, and LaunchAgent processes read the generic Git names.
The supplied `docker-compose.yml` deliberately uses the service-specific
HTTP/OAuth `.env` inputs above so enabling Git for one exposed service cannot
silently enable it for the other.

## Development

```bash
npm run dev:stdio          # tsx, no build step
npm run dev:http
npm run dev:oauth-http
npm test                   # vitest, runs against fixtures/test-vault
npm run typecheck
npm run lint
npm run format:check
npm run memory:smoke      # asserts the default attachment workload stays below 200 MiB RSS
```

`fixtures/test-vault/` is a 30+ note fixture vault exercising every link
and parsing edge case the parser needs to handle (piped aliases, heading
and block links, embeds, frontmatter-embedded wikilinks, nested tags,
duplicate filenames across folders, unresolved links, code-block
exclusion, and Korean filenames/tags/wikilinks). It's what every test in
`src/**/*.test.ts` runs against.

## Project status

The current release line includes the graph and optional local semantic context
engine, all three transports (stdio, bearer HTTP, OAuth HTTP), 41 core MCP
tools, guarded partial and bulk writes, and client setup for Codex, ChatGPT
Desktop, and Claude. Remote Vault Bridge is a first-class deployment path. Its
opt-in mount guard remains **Beta** while it receives cross-platform feedback
for removable drives, NAS shares, and container mounts. The separately opt-in
Vault Git tools expose `read`, `commit`, and `push` as progressively wider,
review-gated capabilities instead of a general-purpose Git shell.

Help test a real remote-vault setup in
[Beta Issue #18](https://github.com/junnnnnw00/obsidian-everywhere/issues/18),
or ask questions in
[Discussion #19](https://github.com/junnnnnw00/obsidian-everywhere/discussions/19).
A disposable vault is welcome; never share note contents, tokens, or private
hostnames.

## Contributing

Bug reports, feature requests, and PRs are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, testing conventions,
and how the fixture vault relates to the test suite. Security issues:
please see [`SECURITY.md`](SECURITY.md) rather than opening a public issue.

## License

MIT — see [`LICENSE`](LICENSE).
