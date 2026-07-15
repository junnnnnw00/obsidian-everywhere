# Architecture

Obsidian Everywhere is a graph server, not a file server. The design
question at every layer was "does this let Claude reason about the vault
as a graph," not "does this let Claude read a file."

```
┌───────────────────────────────────────────────────────────┐
│  obsidian-everywhere (single Node.js/TypeScript package)   │
│                                                             │
│  Vault Graph Engine                                        │
│   parser (src/parser) → SQLite index (src/index) → watcher │
│   (src/watcher)                                             │
│   SQLite  ↔  in-memory graph (src/graph, graphology)        │
│                                                             │
│  MCP Tool Layer (src/mcp) — graph-native tools, shared      │
│  by every transport                                        │
│                                                             │
│  Transport A: stdio (src/cli.ts)            ← local Claude  │
│  Transport B: Streamable HTTP (src/http)    ← remote/HTTP   │
│      auth: static bearer token (src/http) or                │
│            OAuth 2.1 (src/oauth)                             │
└───────────────────────────────────────────────────────────┘
```

## Vault Graph Engine

### Parser (`src/parser/markdown.ts`)

Turns one note's raw text into `{ frontmatter, body, links, tags, aliases,
headings, blocks, title }`. Notable design points:

- Frontmatter is parsed with `gray-matter`; frontmatter *string values* are
  also scanned for `[[wikilinks]]`, because Obsidian users routinely put
  links in frontmatter fields (`related: "[[Some Note]]"`) and those are
  real graph edges too.
- Fenced code blocks and inline code spans are masked out line-by-line
  before the wikilink/tag regexes run, so `` `[[Note A]]` `` inside a code
  span is never mistaken for a link.
- Wikilinks, embeds (`![[...]]`), and markdown links (`[text](note.md)`)
  are parsed into a common `ParsedLink` shape with a `type` discriminant —
  embeds are a distinct link type from plain wikilinks throughout the
  system (SQL rows, graph edges, tool output).
- Tags support arbitrary nesting (`#a/b/c`) and are collected from both
  frontmatter (`tags: [...]`) and inline `#tag` text.

### Resolution (`src/vault/resolve.ts`)

Given a link's raw target text and the current set of vault files (with
their aliases), resolves to a specific file or `null` (unresolved).
Qualified paths (containing `/`) resolve exactly. Unqualified names
(the common case — `[[Note B]]`) match by basename across the whole vault;
if more than one file shares that basename, the shallowest path wins, with
an alphabetical tie-break for same-depth duplicates. Falls back to alias
matching if no basename matches. This mirrors Obsidian's own "shortest
path when possible" behavior closely enough to be predictable, and the
tie-break rule is deterministic and unit-tested rather than
filesystem-scan-order-dependent.

Unresolved links are **not** dropped — they're stored in the `links` table
with `target_id = NULL` and surfaced by the `find_unresolved` tool. A vault
graph's broken edges are signal, not noise.

### SQLite index (`src/index/`)

`schema.ts` defines `files / links / tags / aliases / headings / blocks`
tables plus an FTS5 virtual table (`files_fts`, `unicode61` tokenizer) for
full-text search. `db.ts` (`VaultDB`) is the only thing that touches the
database — every query used by a tool lives there as a named method
(`getBacklinks`, `findOrphans`, `search`, ...), not as ad hoc SQL scattered
through the tool layer.

`scan.ts` is where indexing actually happens:

- `fullScan` walks the vault, and for each file compares a hash (sha1 of
  full content for markdown, cheap size+mtime hash for attachments —
  reading every attachment's bytes just to hash them isn't worth it)
  against the stored value. Unchanged files are skipped entirely — this is
  the "mtime+hash" short-circuit the spec calls for.
- **Link resolution is a separate, SQL-only pass** (`reresolveAllLinks`)
  from parsing. Every scan/watch operation ends by re-resolving every link
  row's `target_id` against the current file set and returning only the
  rows that actually changed. This is what makes rename handling correct
  without re-parsing anything: when a file disappears, other notes'
  previously-resolved (or unresolved) links to it get re-evaluated for
  free, without touching their file content at all.

### In-memory graph (`src/graph/graph.ts`)

SQLite is the persistent store and does simple lookups (backlinks, tag
membership) well, but traversal algorithms don't belong in recursive SQL
CTEs — that's what `graphology` is for. `VaultGraph` keeps **two**
graphology instances built from the same nodes/edges:

- `directed` — preserves link direction. Used for outlinks, backlinks, and
  PageRank (a directed algorithm; treating it as undirected would make
  every note's "hub-ness" just its degree).
- `undirected` — same nodes/edges, direction discarded. Used for n-hop
  neighborhoods and shortest-path queries, because "how are these two
  notes connected" shouldn't care that the link only goes one way — that's
  how Obsidian's own graph view behaves, and it's the more useful lens for
  the `get_context_bundle`/`get_neighborhood` tools.

Both graphs are updated incrementally. `syncOutlinksFromDb(path)` resyncs
*exactly one node's* outgoing edges — it remembers the edge keys it
created last time (in a local `Map`, since SQLite `links.id` isn't stable
across a re-parse — see DECISIONS.md D7) and swaps them for the current
set. Nothing else in the graph is touched. `applyScanResult` wires a
`ScanResult` (added/updated/removed file paths + the cross-file link
changes from `reresolveAllLinks`) to the right `syncOutlinksFromDb`/
`removeNodeByPath` calls. The graph is never rebuilt from scratch except at
process startup (`loadFull`).

`consistencyCheck(db)` diffs the graph's node/edge counts and node
presence against the DB directly — used in tests and available for
runtime sanity-checking.

### Watcher (`src/watcher/watcher.ts`)

A thin `chokidar` wrapper: `add`/`change` → `applyFileUpsert`, `unlink` →
`applyFileDelete`, each followed by `graph.applyScanResult`. There's no
special-cased "rename" handling — chokidar (like the underlying OS watch
APIs) reports a rename as an unlink+add pair, and both halves already end
in a full link-resolution pass, which is exactly what's needed to fix up
other notes' links after a rename. Verified with real filesystem events
(`fs.renameSync` etc.), not simulated ones — see `src/watcher/watcher.test.ts`.

### Orchestrator (`src/vault-engine.ts`)

`VaultEngine` ties `VaultDB` + `VaultGraph` + the watcher together behind
one object: `init()` (full scan + graph load), `watch()`, `close()`. This
is what every transport (`src/cli.ts`, `src/http-cli.ts`,
`src/oauth-http-cli.ts`) constructs and hands to the MCP tool layer.

## MCP Tool Layer (`src/mcp/tools.ts`, `src/mcp/server.ts`)

Twelve read-only tools (`readOnlyHint: true` on every one), each a pure
function `(engine, args) => markdown string`, registered identically
regardless of transport. `resolveNoteArg` lets every tool accept a note
reference as a path, bare title, or alias — it reuses the exact same
`vault/resolve.ts` logic that in-vault links use, so "the way Claude refers
to a note" and "the way notes refer to each other" are the same code path.

`get_context_bundle` is the one tool worth calling out: it packs the
center note plus its 1-hop neighbors (sorted by backlink count, then
recency) into a token budget, using a cheap chars/4 estimate for the
packing decisions themselves (has to run on every call, so it stays fast)
while the test suite double-checks actual compliance with a real BPE
tokenizer (`gpt-tokenizer`, devDependency only — see DECISIONS.md D10).

## Transports (`src/http/`, `src/oauth/`)

`mountMcpEndpoint` (`src/http/app.ts`) is the shared plumbing: one
`StreamableHTTPServerTransport` + one `McpServer` instance per session,
keyed by `Mcp-Session-Id`. Both the static-bearer app (`createHttpApp`) and
the OAuth app (`createOAuthHttpApp`, `src/oauth/http-app.ts`) mount it
behind different auth middleware — the transport/session bookkeeping only
exists once. See `docs/deploy.md` for which transport is meant for which
deployment target, and DECISIONS.md D11/D12 for why the OAuth provider is
deliberately minimal and why there are three separate CLI entrypoints.
