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
