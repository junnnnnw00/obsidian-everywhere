# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project doesn't yet follow strict semver pre-1.0.

## [0.3.2] — 2026-07-24

### Fixed

- `read_note` no longer masks a "note not found" result behind a generic `Output validation error` — it declares an `outputSchema`, and its not-found branch wasn't returning `structuredContent` to satisfy it, so the MCP SDK's own validation overwrote the real error message. It now returns `structuredContent: { error }` alongside the readable text.
- Vault scanning now skips every dotfile and dot-directory (not just the explicitly named ones like `.obsidian`), which stops macOS's AppleDouble sidecar files (`._Some Note.md`) — written for every file on a non-APFS/HFS+ external drive (exFAT, FAT32) — from being indexed as real notes. Previously these could surface in search results and even get selected as a `get_context_bundle` center note, returning binary resource-fork data as note content.

## [0.3.1] — 2026-07-24

### Fixed

- `VaultDB.upsertFileMeta` now upserts (`ON CONFLICT ... DO UPDATE`) instead of plain `INSERT`, fixing a `SQLITE_CONSTRAINT` crash the filesystem watcher could hit on a duplicate/racing write event; the watcher also no longer takes the whole process down on a single file's indexing error.
- External-volume vaults (paths under `/Volumes/...`) now index over polling (`chokidar`'s `usePolling`) instead of native FS events, and store their SQLite index under `~/.obsidian-everywhere/` instead of on the (often exFAT/FAT32) external drive itself.
- `VaultEngine.init()` now waits for the vault directory's listing to read stable twice in a row before running the initial `fullScan`, so a server that auto-starts before an external/network drive finishes mounting no longer silently indexes a near-empty vault. See `docs/deploy.md` (External or network-mounted vaults) for the tuning env vars.

## [0.3.0] — 2026-07-20

### Added

- Self-contained `demo`, client configuration generator `init`, and privacy-safe vault/runtime diagnostics through `doctor` and `doctor --share`.
- Interactive-graph terminal demo and a source-linked comparison with released Obsidian MCP alternatives.
- CodeQL, OpenSSF Scorecard, Dependabot, and a private-artifact weekly growth report workflow.
- A Show and Tell discussion template for community use cases and feedback.

### Changed

- All 31 MCP tools now declare explicit read-only, destructive, idempotent, and open-world annotations matched to their behavior.
- README onboarding now starts with a sample-vault trial before asking users to connect private notes.

## [0.2.2] — 2026-07-20

### Fixed

- Upgraded `better-sqlite3` to 12.11.1 so fresh `npx` installs work across supported Node.js 20–26 releases.

## [0.2.1] — 2026-07-20

### Added

- npm and official MCP Registry package metadata for one-command installation and ecosystem discovery.
- Project icon, GitHub social preview artwork, and reproducible macOS render scripts.
- Release/discovery automation and contributor-friendly starter tasks.

### Changed

- Repository and package metadata now describe Codex, ChatGPT, Claude, and generic MCP client support consistently.

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
[0.2.1]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.2.1
[0.2.2]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.2.2
[0.3.0]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.3.0
