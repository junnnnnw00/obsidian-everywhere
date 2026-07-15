# Decisions

Format: Decision / Reason / Alternatives considered

---

## D1. ESM + NodeNext module resolution
**Decision:** `"type": "module"`, `moduleResolution: NodeNext`, all relative imports use `.js` extensions in TS source.
**Reason:** `@modelcontextprotocol/sdk` ships ESM-first; avoids dual-package hazard.
**Alternatives:** CommonJS — rejected, fights the SDK's module format.

## D2. Frontmatter parser: gray-matter
**Decision:** Use `gray-matter` (wraps js-yaml) for frontmatter extraction.
**Reason:** Battle-tested, preserves the raw YAML block for round-tripping, gives arbitrary-field passthrough for free.
**Alternatives:** Hand-rolled `---` splitter + `js-yaml` directly — more code for no benefit since gray-matter already exposes the parsed object and raw content split.

## D3. Fixture vault duplicate-name resolution semantics
**Decision:** For an unqualified link `[[Same Name]]` matching multiple files, resolve by (1) shortest path depth, (2) alphabetical full-path tie-break.
**Reason:** Approximates Obsidian's real "shortest path when possible" behavior without needing Obsidian's exact undocumented tie-break algorithm. Documented as a fixture test case (`Ambiguous Resolution Test.md`) so behavior is explicit and testable rather than guessed at silently.
**Alternatives:** First-match-in-directory-scan-order — rejected as non-deterministic across filesystems/OS.

## D4. Attachment files (non-markdown) tracked in index, not treated as "notes"
**Decision:** `Attachments/diagram.png` is indexed as a resolvable embed target but is not a `note` row with parsed content.
**Reason:** §3 requires `![[image.png]]` to resolve and be typed as an `embed` edge; the target doesn't need markdown parsing.
**Alternatives:** Ignore non-markdown files entirely — rejected, would make embed resolution always "unresolved" for images, contradicting real vault behavior.

## D5. Default exclude rules: `.obsidian/`, `.git/`, `node_modules/`
**Decision:** These three are excluded by default; attachment folders are NOT excluded by default (configurable) since embeds need to resolve against them.
**Reason:** Matches spec §3.9 ("설정 가능") — .obsidian is always noise, attachments are legitimate graph targets.
**Alternatives:** Exclude a hardcoded "Attachments/" folder — rejected, too vault-specific to hardcode.

## D6. Two graphology instances (directed + undirected) sharing edge keys
**Decision:** `VaultGraph` keeps a `directed` graph (source of truth for outlinks/backlinks/PageRank) and an `undirected` graph (n-hop neighborhood + shortest path), both mutated together and addressed by the same edge keys.
**Reason:** `graphology-shortest-path`'s `bidirectional` uses `inboundNeighbors`/`outboundNeighbors`, i.e. it respects edge direction. A "how are these two notes connected" query should not care that link A→B only exists in one direction — Obsidian's own graph view treats links as undirected for traversal. Maintaining a second graph is O(same edges) memory, not a full extra index.
**Alternatives:** Single directed graph + manually reverse-augment neighbor lookups per call — more error-prone than just maintaining the mirror incrementally in the same place edges are written.

## D7. Edge sync keyed by a locally-tracked key set, not DB link-row ids
**Decision:** `syncOutlinksFromDb(path)` remembers the edge keys it previously created for that node (in an in-memory `Map`) and drops exactly those before adding the fresh set, rather than trying to diff against SQLite `links.id`.
**Reason:** `VaultDB.replaceLinks` does delete-all + reinsert for a file's links, so `links.id` values are not stable across a re-parse of that file — using them as graph edge keys would leak orphaned edges every time a note is edited.
**Alternatives:** Make link ids stable (upsert-by-content instead of delete+reinsert) — more SQL complexity for no benefit, since the graph layer doesn't need SQL-level link identity, only "what does this node point at right now."

## D8. Rename handling has no special case in the watcher
**Decision:** chokidar's `unlink`+`add` pair (its cross-platform rename representation) is handled by the existing single-file add/delete paths; no rename-specific code exists in `watcher.ts`.
**Reason:** Both `applyFileUpsert` and `applyFileDelete` already end in a full `reresolveAllLinks` pass over the SQL link table, which is exactly what's needed to fix up other notes' links after a rename (e.g. an unqualified `[[Same Name]]` link resolving to a different duplicate once one candidate disappears). Verified with a real-fs `renameSync` test (`watcher.test.ts`).
**Alternatives:** Detect add+unlink pairs within a debounce window and treat as an atomic rename — adds complexity (timing windows, partial-pair handling) the SQL-level re-resolution pass already makes unnecessary.

## D9. FTS5 tokenizer: `unicode61`, not a CJK-aware tokenizer
**Decision:** `files_fts` uses SQLite's built-in `unicode61` tokenizer.
**Reason:** No extra native dependency required (unlike ICU-based tokenizers). Works correctly for our Korean fixtures because Korean note content in this vault is space-delimited at the word level, matching unicode61's word-boundary tokenization.
**Limitation (documented, not fixed for v0.1):** unicode61 does not do CJK n-gram segmentation, so a Korean *substring* query spanning less than a full space-delimited token (e.g. matching only part of a compound word) will not be found. Full CJK search would need `simple`/`icu` tokenizers or a trigram index — out of scope for v0.1.
