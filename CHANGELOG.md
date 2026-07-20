# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project doesn't yet follow strict semver pre-1.0.

## [0.2.0] — 2026-07-20

### Added

- Safe note lifecycle tools: `move_note`, `rename_note`, and recoverable-by-default `delete_note`; moves rewrite resolvable inbound wikilinks and Markdown links.
- Partial editors: `replace_text`, `patch_section`, `update_frontmatter`, and `remove_frontmatter_field`.
- Dry-run-first `bulk_replace` with folder/regex filters, changed-file reports, file-count guardrails, snapshots, and `rollback_bulk_edit`.
- Explicit folder/note enumeration and pattern search through `list_folder`, `list_notes`, and `regex_search`.
- Persisted Obsidian configuration tools for hotkeys, Templates folder, and core-plugin settings.
- Static `.base`/fenced Base validation with explicit reporting of live-rendering limits.

### Changed

- `read_note` now returns MCP `structuredContent` with separate `content`, `frontmatter`, `outlinks`, `backlinks`, `tags`, and pagination metadata. Text output remains for older clients.
- All note/config writes use same-filesystem atomic replacement and immediate index reconciliation.
- `ENOSPC` errors now include target-filesystem free-space diagnostics and distinguish byte capacity from quota/inode limits.
- `.trash`, internal rollback snapshots, and atomic-write temporary files are excluded from indexing and watching.
- Stdio, bearer HTTP, and OAuth HTTP now use separate default SQLite files to prevent cross-process index corruption.

## [0.1.0] — 2026-07-16

Initial release. A graph-native MCP server for Obsidian vaults.

### Added

- **Graph engine**: markdown parser (wikilinks, embeds, frontmatter, nested
  tags, headings, block references), SQLite index with FTS5 full-text
  search, Obsidian-style link resolution (shortest-path + alias fallback,
  unresolved links kept as first-class graph data), and an in-memory
  graphology layer (n-hop neighborhoods, shortest path, PageRank) kept in
  sync incrementally via a `chokidar` filesystem watcher.
- **14 MCP tools**: `vault_overview`, `search_notes`, `read_note`,
  `get_backlinks`, `get_neighborhood`, `get_context_bundle`, `list_tags`,
  `get_notes_by_tag`, `find_orphans`, `find_unresolved`, `find_path`,
  `get_related`, `create_note`, `append_to_note`.
- **Three transports**: stdio (local Claude Code/Desktop), Streamable HTTP
  with a static bearer token (remote Claude Code over Tailscale), and
  Streamable HTTP with OAuth 2.1 — PKCE + Dynamic Client Registration —
  for the claude.ai custom connector.
- **Deployment assets**: `Dockerfile` + `docker-compose.yml`, a macOS
  LaunchAgent template + install/uninstall scripts, a Cloudflare Tunnel
  config-generator script, and `docs/deploy.md` tying it together.
- Fixture vault (`fixtures/test-vault/`, 30+ notes incl. Korean content)
  and a test suite (99 tests) run against real files, a real SQLite
  database, real filesystem events, and a real HTTP server — no mocking
  of the core engine.

### Known limitations

- Read-only-by-default is not the story here — write tools ship, but only
  create/append; there's no delete or full-file overwrite outside
  `create_note(overwrite: true)`.
- FTS5 uses the `unicode61` tokenizer, which doesn't do CJK n-gram
  segmentation — Korean search works at the space-delimited word level,
  not sub-word substrings (see DECISIONS.md D9).
- The OAuth provider is single-user by design, not a general identity
  system (see DECISIONS.md D11).

[0.1.0]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.1.0
[0.2.0]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.2.0
