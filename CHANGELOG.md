# Changelog

All notable changes to this project are documented here. Format loosely
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this
project doesn't yet follow strict semver pre-1.0.

## [Unreleased]

## [0.9.1] — 2026-08-26

### Fixed

- Shortened the MCP Registry description to its 100-character limit and added
  a release preflight check so invalid registry metadata fails before publish.

## [0.9.0] — 2026-08-26

### Added

- Opt-in Git vault workflows: `git_status`, bounded `git_diff`, and
  `git_log`, plus preview/approval-gated `git_commit` and `git_push` at higher
  `OBSIDIAN_EVERYWHERE_GIT_MODE` capability levels.
- `OBSIDIAN_EVERYWHERE_GIT_REPO_PATH` selects one safe vault-relative real
  repository directory and defaults to `.`; the full vault remains indexed
  while Git tool paths are relative to the selected repository.
- `doctor` now reports Git availability and configured-root repository
  readiness without printing remote URLs.

### Changed

- Docker Compose keeps the bearer and OAuth services independently
  configurable, including separate Git capability, repository-path, and push
  mapping settings; selecting one no longer requires the other service's
  secrets.
- The macOS LaunchAgent installer now XML-escapes paths, tokens, sentinels, and
  Git remote mappings, preserves a configurable port, rebuilds native modules
  for the selected Node.js runtime, retries transient launchd registration
  failures, and writes the generated credential-bearing plist with user-only
  permissions.
- Docker builds compile native dependencies in disposable stages when no
  prebuilt binary is available (including ARM64), while the final runtime image
  retains Git and SQLite support without a compiler toolchain.

### Fixed

- Fast-exiting Git subprocesses no longer surface a platform-dependent uncaught
  `EPIPE` while Node.js closes their standard input.

### Security

- Git writes require an exact configured repository root, explicit changed paths,
  a five-minute one-use approval, and an unchanged proposed Git tree. Hooks,
  signing, clean filters/LFS, hidden or sensitive paths, suspected secrets,
  arbitrary Git arguments, caller-provided force/tags/refspecs, and non-HTTPS
  production remotes are blocked. Push additionally requires an exact
  remote-to-HTTPS mapping and an existing upstream branch, scans bounded blobs,
  merge results, and commit messages, and uses an exact-OID lease so a changed
  remote ref fails closed. Vault/repository/`.git` filesystem identities are
  rechecked before every Git subprocess, while repository-local HTTP/network
  overrides that could weaken the pinned TLS destination are refused.

## [0.8.1] — 2026-08-17

### Changed

- Raised the default attachment/PDF/archive-entry extraction limits from
  32/16/8 MiB to 64/48/32 MiB. All three limits are now configurable up to
  1 GiB through documented environment variables.

## [0.8.0] — 2026-08-17

### Added

- `read_file` and `search_files` provide local, cached access to text/code/data,
  PDF, DOCX, PPTX, XLSX, OpenDocument, EPUB, RTF, and common image attachments.
- A repeatable `npm run memory:smoke` gate covers lazy attachment extraction.

### Changed

- Transformer-backed semantic search now requires its optional peer plus an
  explicit `OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC=true` opt-in. The default
  install no longer includes its vulnerable heavyweight native runtime. The
  default graph, FTS, and attachment workload stays under the 200 MiB RSS target; the optional
  multilingual model can exceed 500 MiB RSS.

## [0.7.0] — 2026-07-29

### Added

- **Remote Vault Bridge** is now a first-class deployment path: an external
  Claude Code, Codex, or other Streamable HTTP client can use graph,
  full-text/semantic retrieval, context bundles, and guarded write tools
  against a vault that remains on the user's machine. New English and Korean
  ngrok tutorials cover read-only-first rollout, stable domains, automatic
  services, validation, writes, rotation, troubleshooting, and security.
- `vault_status` reports mount state, index freshness, indexed counts, write
  availability, configured sentinel, and last full reconciliation.
- Opt-in Beta mount guard (`OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true`) for
  removable drives, NAS shares, and container mounts. Startup fails closed on
  an unavailable mount; runtime unlink storms preserve the index; writes are
  blocked while stale; and a returning mount triggers full reconciliation.
  Guarded scans also verify the mount again before committing, so a mount loss
  during reconciliation rolls the index transaction back.
- A 44-second, source-controlled Swift demo shows the complete remote workflow:
  authenticated tunnel access, semantic and graph context, guarded writes,
  mount-loss protection, and automatic reconciliation.

### Security

- Static bearer authentication now uses constant-time digest comparison and
  rate-limits failed attempts, making the HTTP transport suitable behind a
  TLS-terminating public tunnel as well as a private network.
- `/healthz` returns `503` while guarded content may be stale, and guarded MCP
  writes fail closed during `unavailable` and `reconciling` states.
- Patched transitive `sharp` and `adm-zip` dependencies are enforced with npm
  overrides, clearing the two high-severity Dependabot alerts inherited
  through `@huggingface/transformers`.

## [0.6.0] — 2026-07-27

### Added

- `bulk_update_frontmatter` / `bulk_remove_frontmatter_field` — folder- or vault-wide frontmatter edits in one call, mirroring `bulk_replace`'s dry-run default, `maxFiles` guard, and rollback snapshot (restorable via the existing `rollback_bulk_edit`). Only notes where a value actually changes are touched.
- `list_notes` gained an optional `properties: string[]` to project named frontmatter fields alongside each listed note (from the already-indexed data, no extra reads) — e.g. `properties: ["status", "project"]` to audit consistency across a folder without a `read_note` per file.
- See DECISIONS.md D23 for the rationale — both gaps were found live during a real vault reorganization, where removing one redundant field from ~90 notes required 88 individual tool calls.

## [0.5.2] — 2026-07-27

### Fixed

- Every tool's input arguments are now strictly validated (`z.object(shape).strict()`) instead of silently dropping unrecognized parameters. Previously a typo'd param name (e.g. `regex_search({ paths: [...] })` instead of the real `{ folder: ... }`) produced no error at all — the call "succeeded" but silently ran with that parameter unset, returning subtly wrong (often whole-vault-scoped) results indistinguishable from a correct call. Now it returns a clear `Unrecognized key(s) in object: '...'` tool error. See DECISIONS.md D22.

## [0.5.1] — 2026-07-27

### Fixed

- `fullScan`, `applyFileUpsert`, and `applyFileDelete` now run inside a single SQLite transaction (`VaultDB.transaction`). Previously a crash partway through a scan — e.g. the frontmatter-YAML crash fixed in 0.5.0, hit repeatedly on a real deployment before that fix shipped — could leave files with their content written but their links not yet written (a separate, later pass), and the mtime+hash "unchanged" short-circuit meant those files were silently skipped on every future scan, permanently undercounting backlinks/outlinks and inflating orphan counts. See DECISIONS.md D21.

## [0.5.0] — 2026-07-27

### Added

- `semantic_search` — meaning-based search via local embeddings (`Xenova/multilingual-e5-small`, int8-quantized, ~120MB), finding conceptually related notes even without shared vocabulary, including across languages. Fully local: no API key, cloud account, or Ollama process. Embeddings are computed lazily (only once a semantic tool is actually used) and incrementally (only new/changed notes, up to 50 per call).
- `get_related` gained an optional `method: "semantic"` (default stays `"jaccard"`, unchanged) using the same embedding infrastructure, for finding topically similar notes that share no tags or links at all.
- See DECISIONS.md D20 for the full design rationale (why local-only, why brute-force cosine over a vector-search extension, why lazy/bounded indexing, and the two `npm audit` advisories accepted as unreachable for this project's text-only usage).

### Fixed

- A note whose frontmatter isn't valid YAML (e.g. a Templater placeholder like `{{date:YYYY-[W]ww}}`, valid template syntax but not valid YAML) no longer crashes the entire indexing pass — and with it the whole process, repeatedly, on every restart. It now degrades to "no frontmatter, whole file as body" for that one note and keeps going.

## [0.4.0] — 2026-07-27

### Added

- `add_tags` / `remove_tags` — add or remove frontmatter tags on one note, deduplicated and normalized (accepts a leading `#` or not), consolidating a legacy singular `tag` key into the canonical `tags` array.
- `rename_tag` — renames a tag vault-wide across both frontmatter `tags` arrays and inline `#tag` text (code fences and inline code are skipped). Defaults to dry-run; applying returns a rollback ID restorable via the existing `rollback_bulk_edit`. Optional `includeNested` also renames `from/child` tags.
- `apply_template` — creates a note from an existing template note, substituting Obsidian's core Templates plugin variables (`{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{time:FORMAT}}`, `{{title}}`); Templater-only `<% %>` syntax is left untouched rather than guessed at (see DECISIONS.md D19).
- CJK substring search: `search_notes` now falls back to a trigram-tokenized FTS5 index when the word-based (`unicode61`) query comes up short, so a Korean/Chinese/Japanese compound "word" can be found by a 3+ character substring inside it (see DECISIONS.md D9). Existing index databases backfill the new trigram table automatically on next start.

## [0.3.5] — 2026-07-27

### Security

- The OAuth login route (`POST /login`) is now rate-limited (20 requests / 15 min per IP). It was the one route in the OAuth flow not covered by the SDK's own rate-limited auth router; `completeLogin`'s one-shot-per-authzId design (see DECISIONS.md D11) stops repeated guesses against a single authorization attempt, but didn't stop a script from minting fresh ones indefinitely. Flagged by CodeQL (`js/missing-rate-limiting`).
- Overrode the transitive `@hono/node-server` (pulled in by `@modelcontextprotocol/sdk`'s HTTP transport) to `^2.0.12`, resolving a moderate-severity path-traversal advisory in an older 1.x release. `npm audit` now reports zero vulnerabilities.

## [0.3.4] — 2026-07-24

### Fixed

- Note path matching (`read_note`, `get_backlinks`, wikilink resolution, `create_note`, ...) is now Unicode-normalization-insensitive: paths, wikilink text, and frontmatter aliases are compared as NFC regardless of which form the underlying filename or note content happens to use. Previously a note whose file was NFD-named — the common case for Korean/accented filenames on a dumb external filesystem like exFAT or FAT32 — couldn't be found by a caller sending the (more common) NFC form, and `create_note` could silently write a byte-different duplicate next to it.
- Every write tool that reads or rewrites an *existing* note (`replace_text`, `patch_section`, `update_frontmatter`, `remove_frontmatter_field`, `append_to_note`, `move_note`/`rename_note` — including its vault-wide link-rewrite scan — `delete_note`, `bulk_replace`, `rollback_bulk_edit`, `validate_base`) now falls back to the alternate Unicode normalization form when the DB's canonical (NFC) path isn't the exact on-disk name, on filesystems that don't unify NFC/NFD themselves.
- The published Docker image now starts and responds to MCP introspection with zero configuration (`docker run <image>` alone), by defaulting to the stdio transport against a small bundled sample vault instead of the bearer-token HTTP server, which always required a mounted volume and a secret to even start. This is what lets automated MCP directories (e.g. Glama) build and evaluate the image. Real deployments are unaffected — docker-compose.yml already mounts a real vault and overrides the command explicitly for both HTTP services.
- Added `glama.json` so Glama can read maintainer ownership from the repo.

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

[Unreleased]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.3.5...v0.4.0
[0.3.5]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.3.2...v0.3.4
[0.3.2]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/junnnnnw00/obsidian-everywhere/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.3.0
[0.2.2]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.2.2
[0.2.1]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.2.1
[0.2.0]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.2.0
[0.1.0]: https://github.com/junnnnnw00/obsidian-everywhere/releases/tag/v0.1.0
