# Obsidian Everywhere

An MCP server that exposes your Obsidian vault's knowledge graph to every
Claude client — local Claude Code, Claude Desktop, a remote Claude Code
over Tailscale, and the claude.ai web/mobile custom connector.

**This is a graph server, not a markdown file server.** Claude shouldn't
see your vault as "a folder of `.md` files" — it should see notes and
links as a graph: backlink traversal, n-hop neighborhoods, and
topic-centered context bundles are first-class tools, not an afterthought
bolted onto a file reader. Unresolved links stay in the graph (that's a
real signal about your vault, same as it is in Obsidian itself), and every
response is structured for what an LLM actually needs — explicit link
relationships, not just raw text.

## Features

- **Real graph engine**: a markdown parser (wikilinks, embeds, frontmatter,
  nested tags, headings, block references), a SQLite index with full-text
  search, and an in-memory [graphology](https://graphology.github.io/)
  layer for n-hop traversal, shortest paths, and PageRank — kept in sync
  incrementally as files change, never rebuilt from scratch.
- **14 graph-native MCP tools** — 12 read-only, 2 write:

  | Tool | What it does |
  |---|---|
  | `vault_overview` | Note counts, top tags, PageRank hub notes, recently modified — a starting orientation |
  | `search_notes` | Full-text search with tag/folder filters, each result annotated with link counts and tags |
  | `read_note` | Full note + graph context header (outlinks/backlinks/tags/frontmatter); optional heading-scoped read |
  | `get_backlinks` | Every note linking to a given note, with the linking sentence |
  | `get_neighborhood` | Explicit n-hop node/edge list around a note (links treated as undirected) |
  | `get_context_bundle` | **The killer feature.** Center note + prioritized 1-hop neighbors packed into a token budget |
  | `list_tags` | Full nested tag hierarchy with counts |
  | `get_notes_by_tag` | Notes carrying a given tag (nested-aware) |
  | `find_orphans` | Notes with no incoming or outgoing links |
  | `find_unresolved` | Links that don't resolve to any note, grouped by target |
  | `find_path` | Shortest connection path between two notes, with a one-line summary per hop |
  | `get_related` | Similar notes that *aren't* directly linked yet (Jaccard similarity over shared tags/neighbors) |
  | `create_note` | Create a new note (with frontmatter); reindexed immediately — the next tool call already sees it |
  | `append_to_note` | Append to a note, optionally under a specific heading; fails closed if the heading isn't found |

  `create_note`/`append_to_note` are on by default for stdio and the
  bearer-token HTTP transport, and off by default for the public OAuth
  connector transport (opt in with `OAUTH_ENABLE_WRITE_TOOLS=true`) — see
  [Configuration](#configuration) and DECISIONS.md D15.

- **Three ways to connect**: stdio for local Claude clients, Streamable
  HTTP with a static bearer token for a remote Claude Code over Tailscale,
  and Streamable HTTP with OAuth 2.1 (PKCE + Dynamic Client Registration)
  for the claude.ai custom connector.

See [`docs/architecture.md`](docs/architecture.md) for how it's built and
[`docs/deploy.md`](docs/deploy.md) for the full deployment topology
(LaunchAgent, Docker, Cloudflare Tunnel).

## Quickstart

```bash
git clone <this-repo>
cd obsidian-everywhere
npm install
npm run build
```

### Claude Code (local, stdio)

```bash
claude mcp add obsidian-everywhere -- node "$(pwd)/dist/cli.js" /path/to/your/vault
```

Or with environment variables instead of a positional arg:

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/vault claude mcp add obsidian-everywhere -- node "$(pwd)/dist/cli.js"
```

### Claude Desktop

Add to `claude_desktop_config.json`:

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

### Remote Claude Code (Tailscale + bearer token)

```bash
OBSIDIAN_VAULT_PATH=/path/to/vault OBSIDIAN_EVERYWHERE_TOKEN=$(openssl rand -hex 32) \
  node dist/http-cli.js
```

Then from another machine on your Tailscale network:

```bash
claude mcp add --transport http obsidian-everywhere-remote \
  http://<host-tailscale-name>:3737/mcp \
  --header "Authorization: Bearer <the token>"
```

Full walkthrough (including running this as a LaunchAgent or in Docker):
[`docs/deploy.md`](docs/deploy.md#2-remote-claude-code-over-tailscale-static-bearer-token).

### claude.ai web/mobile (custom connector, OAuth)

Needs a public HTTPS endpoint — see
[`docs/deploy.md`](docs/deploy.md#3-claudeai-webmobile-custom-connector-oauth-21--cloudflare-tunnel)
for the full Cloudflare Tunnel setup. Once your server is reachable at
`https://your-domain`:

1. claude.ai → Settings → Connectors → Add custom connector
2. Server URL: `https://your-domain/mcp`
3. claude.ai auto-discovers the OAuth flow and shows this server's sign-in
   page — enter the `OAUTH_LOGIN_SECRET` you configured.

## Configuration

| Env var | Used by | Meaning |
|---|---|---|
| `OBSIDIAN_VAULT_PATH` | all | Vault path (or pass as a positional CLI arg) |
| `OBSIDIAN_EVERYWHERE_DB` | all | SQLite index path (default: `<vault>/.obsidian-everywhere/index.db`) |
| `OBSIDIAN_EVERYWHERE_TOKEN` | `http-cli.js` | Static bearer token |
| `PORT` | `http-cli.js`, `oauth-http-cli.js` | HTTP port (defaults 3737 / 3738) |
| `OAUTH_ISSUER_URL` | `oauth-http-cli.js` | Public HTTPS origin (e.g. your Cloudflare Tunnel hostname) |
| `OAUTH_LOGIN_SECRET` | `oauth-http-cli.js` | Single-user login secret |
| `OBSIDIAN_EVERYWHERE_READONLY` | `cli.js`, `http-cli.js` | Set to `true` to disable `create_note`/`append_to_note` (default: write tools on) |
| `OAUTH_ENABLE_WRITE_TOOLS` | `oauth-http-cli.js` | Set to `true` to enable `create_note`/`append_to_note` on the public connector (default: off) |

## Development

```bash
npm run dev:stdio          # tsx, no build step
npm run dev:http
npm run dev:oauth-http
npm test                   # vitest, runs against fixtures/test-vault
npm run typecheck
```

`fixtures/test-vault/` is a 30+ note fixture vault exercising every link
and parsing edge case the parser needs to handle (piped aliases, heading
and block links, embeds, frontmatter-embedded wikilinks, nested tags,
duplicate filenames across folders, unresolved links, code-block
exclusion, and Korean filenames/tags/wikilinks). It's what every test in
`src/**/*.test.ts` runs against.

## Project status

v0.1, feature-complete against the spec including write tools. See
`PROGRESS.md` for what shipped and `HANDOFF.md` for the handful of steps
that need a human (registering the claude.ai connector, the actual
Cloudflare Tunnel account setup, and a final Docker build/run check — see
`HANDOFF.md` for why those specifically couldn't be finished unattended).
Tested against a real personal vault (58 notes, 36 attachments, Korean
content) in addition to the fixture vault — see PROGRESS.md.

## License

MIT — see [`LICENSE`](LICENSE).
