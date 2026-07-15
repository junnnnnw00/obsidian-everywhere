# Progress Log

## 2026-07-15 21:06 — Phase 0 complete

- Scaffolded TS/Node project (ESM, NodeNext), vitest, package.json with pinned deps
  (@modelcontextprotocol/sdk, better-sqlite3, chokidar, graphology(+shortest-path,metrics),
  gray-matter, express, zod, nanoid).
- Built `fixtures/test-vault/`: 31 markdown notes + 1 attachment (`Attachments/diagram.png`)
  + 1 excluded config (`.obsidian/app.json`). Covers: wikilinks, piped aliases, heading
  links, block links, embeds (note + image), markdown links (encoded/literal/external/
  broken), frontmatter (tags/aliases/custom fields/wikilink-valued field), inline tags incl.
  nested `#a/b/c`, code-block/inline-code wikilink exclusion, unresolved links, duplicate
  filenames in two folders (ambiguous + qualified resolution), a hub note with 3 backlinks
  (for PageRank test), Korean filenames/tags/aliases/wikilinks.
- Gate evidence:

```
$ npm run build
> tsc -p tsconfig.json
(no errors)

$ npm test
✓ src/fixtures.test.ts (2 tests) 2ms
Test Files  1 passed (1)
     Tests  2 passed (2)
```

## 2026-07-15 21:18 — Phase 1 complete

- Parser (`src/parser/markdown.ts`): frontmatter (gray-matter) + line-scanned
  wikilinks/embeds/markdown-links/tags/headings/blocks, with fenced-code and
  inline-code masking so `[[...]]` inside code is never treated as a link.
  Frontmatter string values are also scanned for embedded wikilinks.
- Resolver (`src/vault/resolve.ts`): Obsidian-style resolution — qualified
  paths resolve exactly, unqualified names match by basename with
  shortest-path-then-alphabetical tie-break, falling back to alias lookup.
- SQLite index (`src/index/`): `files/links/tags/aliases/headings/blocks/
  files_fts` schema (FTS5, unicode61 tokenizer). `scan.ts` does mtime+hash
  short-circuited re-parsing; `fullScan`/`applyFileUpsert`/`applyFileDelete`/
  `applyFileRename` all funnel through `reresolveAllLinks`, a SQL-only pass
  (no re-parsing) that recomputes `target_id` for every link row and reports
  only the ones that changed.
- Graph layer (`src/graph/graph.ts`): two graphology instances sharing edge
  keys — `directed` (backlinks/outlinks/PageRank) and `undirected`
  (n-hop neighborhood + shortest path, since link direction shouldn't gate
  "how are these connected"). `syncOutlinksFromDb` resyncs exactly one
  node's outgoing edges (tracked via a local key set, since DB link-row ids
  aren't stable across re-parses) — no full graph rebuild on any file event.
  `consistencyCheck` diffs node/edge counts and node presence against the DB.
- Watcher (`src/watcher/watcher.ts`) + orchestrator (`src/vault-engine.ts`):
  chokidar wired straight into `applyFileUpsert`/`applyFileDelete` +
  `graph.applyScanResult`. Renames are chokidar unlink+add pairs (no native
  rename event cross-platform) — verified this still re-resolves other
  notes' links correctly via a real-fs rename test.
- Gate evidence:

```
$ npm run build   # tsc, 0 errors
$ npm test
✓ src/fixtures.test.ts (2 tests)
✓ src/vault/resolve.test.ts (6 tests)
✓ src/parser/markdown.test.ts (14 tests)
✓ src/index/scan.test.ts (16 tests)      — full pipeline against fixture vault
✓ src/graph/graph.test.ts (8 tests)      — hand-computed hop/path cases + consistency check
✓ src/watcher/watcher.test.ts (4 tests)  — real fs events: add/edit/delete/rename
Test Files  6 passed (6)
     Tests  50 passed (50)
```

Two real bugs caught and fixed during this phase (not just fixture typos):
1. Markdown-link regex `[^)\s]+` silently dropped links whose target had an
   unencoded space (e.g. `(Note C.md)`); loosened to `[^)]+` since only the
   unescaped `)` should terminate the target.
2. Initial `computeHash` design intent (mtime+hash) — implemented sha1 of
   full content for markdown (needed for parsing anyway) and a cheap
   size+mtime hash for non-markdown attachments to avoid reading binaries.
