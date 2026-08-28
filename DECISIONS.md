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

## D9. FTS5 search: `unicode61` primary index, `trigram` fallback for CJK substrings
**Decision:** `files_fts` (word-based, `unicode61` tokenizer) stays the primary search index — unchanged ranking/behavior for the common case. A second virtual table, `files_fts_trigram` (SQLite's built-in `trigram` tokenizer, indexes every 3-character sequence), is populated in parallel via the same `upsertFts`/`deleteFileByPath` calls. `VaultDB.search()` only queries it when the primary query returns fewer than `limit` results, and only *appends* trigram hits not already found — it never reorders or replaces `files_fts` results.
**Reason:** unicode61 tokenizes on word boundaries, so it can't match a substring inside a Korean/Chinese/Japanese compound "word" (those scripts don't space-delimit the way English does) — e.g. a note containing "그래프이론" as one token isn't found by searching "그래프". Trigram indexes any 3+ character sequence regardless of script, so it closes that gap without touching the tuned word-based ranking everyone else's queries rely on. No extra native dependency: trigram is a built-in FTS5 tokenizer, already present in better-sqlite3's bundled SQLite (confirmed ≥3.34).
**Known remaining limitation:** FTS5's trigram tokenizer can't produce a trigram from (and therefore can't match) a query under 3 characters — a 2-character Korean term (not uncommon) still won't be found via the fallback. True CJK word segmentation would need an external tokenizer (MeCab/ICU) and is still out of scope.
**Migration:** `files_fts_trigram` is created with `CREATE VIRTUAL TABLE IF NOT EXISTS`, so it starts empty on an existing index database; `VaultDB`'s constructor backfills it once from `files` (`backfillTrigramIndexIfNeeded`, a no-op after the first run) since `fullScan`'s mtime+hash gating means unchanged files would otherwise never populate it.
**Alternatives:** Replace `unicode61` outright with `trigram` — rejected: it changes relevance ranking for everyone (trigram doesn't reason about whole words the way BM25-over-tokens does) and can't match queries under 3 characters at all, a real regression for short terms unicode61 handles fine (e.g. "AI", "Go"). A real CJK segmenter (MeCab/ICU) — rejected as a native-dependency, install-complexity cost this project has consistently avoided (see D1/D2/D10).

## D10. New dependency: `gpt-tokenizer` (devDependency only)
**Decision:** Added `gpt-tokenizer` as a devDependency, used only in `src/mcp/server.test.ts` to verify `get_context_bundle` actually respects its token budget.
**Reason:** Spec §Phase 2 gate explicitly requires checking the token budget "tiktoken 근사치로 카운트" (tiktoken-approximate count). `gpt-tokenizer` is a pure-JS BPE tokenizer (no WASM/native build step, unlike `tiktoken`), so it's a lighter-weight way to satisfy that gate requirement without adding a runtime dependency — the tool's actual packing logic still uses a cheap char/4 heuristic (`src/mcp/format.ts`) so token counting stays fast on every call.
**Alternatives:** `tiktoken` (official, WASM-based) — heavier install/build footprint for a devDependency-only use case; rejected in favor of the pure-JS option.

## D11. Single-user OAuth provider: one process is both AS and RS, "login" is one shared secret
**Decision:** `SingleUserOAuthProvider` (`src/oauth/provider.ts`) implements the SDK's `OAuthServerProvider` interface with in-memory Maps for pending authorizations/codes/access & refresh tokens. There is no user table — `authorize()` renders an HTML form, and the only credential check is `secret === OAUTH_LOGIN_SECRET` (one env var). The authorization server and resource server are the same process (spec explicitly says not to build a full multi-tenant IdP).
**Reason:** This server has exactly one legitimate user (whoever deployed it) and exists only to satisfy claude.ai's requirement that custom connectors speak OAuth 2.1 — the protocol is mandatory, but a real identity system would be pure overhead for a single-user personal tool.
**Alternatives considered:** Proxy to a real IdP (Auth0/Clerk/etc.) — rejected, adds an external dependency and account for zero benefit at N=1 users. Static-bearer-token-only (skip OAuth) — rejected because claude.ai's custom connector UI specifically requires the OAuth discovery flow; a raw bearer token isn't a supported connector auth mode.
**Known limitation (acceptable for v0.1):** a wrong secret entry burns that specific `authzId` (one-shot by design, see `completeLogin`), forcing the user to click "connect" again in claude.ai rather than retry inline on the same page. Chosen over allowing multiple attempts against one `authzId`, which would enable secret brute-forcing.

## D12. Three separate CLI entrypoints instead of one with a mode flag
**Decision:** `dist/cli.js` (stdio), `dist/http-cli.js` (static bearer HTTP), and `dist/oauth-http-cli.js` (OAuth HTTP) are three separate entrypoints/bin targets rather than one binary with `--mode=stdio|http|oauth`.
**Reason:** These map to genuinely different deployment targets in the spec's topology (a LaunchAgent plist has one `ProgramArguments` array; a Docker Compose service has one `command`) — a mode flag would just move the same branching into every deployment artifact instead of into the package's `bin` map. Each entrypoint also fails fast on its own required env vars (e.g. oauth-http-cli refuses to start without `OAUTH_ISSUER_URL`), which is clearer as three small files than one file with mode-conditional validation.
**Alternatives:** Single `server-cli.ts` with a `--transport` flag — rejected, mostly moves complexity around without reducing it, and makes the systemd/LaunchAgent/Docker examples in docs/deploy.md less copy-pasteable.

## D13. `get_related` feature set: tags ∪ 1-hop neighbor node ids, single combined Jaccard score
**Decision:** `featureSet(fileId)` returns one `Set<string>` mixing `tag:<name>` and `node:<id>` members; `get_related` computes a single Jaccard similarity over that combined set rather than separate tag-similarity and neighbor-similarity scores.
**Reason:** Spec explicitly says "Jaccard 유사도면 충분" (Jaccard is enough) — a single combined score is simpler to reason about and rank by than a weighted blend of two scores, and avoids inventing an arbitrary weighting between "shares tags" and "shares neighbors" with no data to justify a particular weight.
**Alternatives:** Two separate scores (tag-Jaccard, neighbor-Jaccard) shown side by side — rejected as more informative but out of scope for "simple similarity recommendation," and harder to sort a single ranked list by.

## D14. Watcher integration tests use platform-appropriate real events
**Decision:** On macOS, integration tests use fast chokidar polling—the same
production path selected for vaults under `/Volumes`. On other platforms,
add/change/unlink tests retain native watcher coverage. The
rename/re-resolution case explicitly uses polling everywhere.
**Reason:** Native fsevents repeatedly omitted both rename halves and ordinary
add events under parallel test I/O, even with a longer timeout. That made
otherwise-correct index/graph tests flaky. Polling still observes real
filesystem changes and is the path this project's primary external-drive
deployment actually runs; Linux CI continues to exercise native inotify.
Rename assertions wait for both independent unlink and add halves before
checking the final index, rather than assuming link re-resolution implies the
new path has already been indexed.
**Alternatives:** Increase the timeout again — rejected because a missing event
does not arrive merely by waiting longer. Mock all watcher events — rejected
because it would remove real filesystem integration coverage.

## D15. Write tools (`create_note`, `append_to_note`) ship in v0.1, enabled by default — except on the public OAuth connector
**Decision:** Implemented as real tools (not left as a "Phase 5 optional" stub). `readOnlyHint: false, destructiveHint: true` per MCP annotation conventions. Registration is gated by `enableWriteTools` (`createServer` option), which every transport can set independently:
- stdio (`cli.ts`) and the bearer-token HTTP transport (`http-cli.ts`): **enabled by default**, disable with `OBSIDIAN_EVERYWHERE_READONLY=true`.
- the OAuth/claude.ai transport (`oauth-http-cli.ts`): **disabled by default** (inverted), enable with `OAUTH_ENABLE_WRITE_TOOLS=true`.
**Reason:** Promoted from "optional" after real usage feedback — note creation/editing is core to actually using this day to day, not a nice-to-have. The per-transport default split exists because the OAuth transport is designed for browser-facing public connector flows and is a meaningfully larger attack surface than a local process or a single-user bearer bridge; defaulting it to read-only and requiring an explicit opt-in is a deliberate, cheap safety margin that doesn't cost the primary use case anything. A bearer bridge exposed through a public TLS tunnel should still begin read-only as an operational rollout practice (D24), even though its backward-compatible code default remains writable.
**Safety design:** every write path goes through `toSafeVaultRelPath`/`resolveWithinVault` (`src/vault/paths.ts`) — rejects absolute paths, `.`/`..` traversal segments, and paths inside excluded directories (`.obsidian`, `.git`, ...), with a resolved-path-escapes-vault check as defense in depth. `append_to_note` fails closed (writes nothing) if a requested heading isn't found, rather than guessing where to insert. Both tools reindex synchronously via `VaultEngine.indexFileNow` right after writing, so the *next* tool call in the same conversation already sees the update — no reliance on watcher debounce timing (verified with a real-vault write/read/cleanup round trip against a live personal vault, not just the fixture).
**Alternatives:** A single global on/off flag instead of per-transport defaults — rejected, conflates "is write functionality wanted at all" (yes) with "is this specific network exposure trusted with it" (varies by transport). Requiring path allowlisting/confirmation prompts — out of scope for v0.1; the path-safety validation plus fail-closed heading lookup covers the realistic failure modes (typos, wrong tool call) without adding a confirmation round-trip to every write.

## D16. Removed unused `nanoid` dependency
**Decision:** `nanoid` was added to `package.json` during Phase 0 scaffolding (before any code existed) as an anticipated dependency for generating IDs/tokens, but every place that ended up needing a random ID (OAuth codes/tokens, DCR client ids, HTTP session ids) used `node:crypto`'s built-in `randomUUID()` instead. Removed via `npm uninstall nanoid` once the FOSS-readiness pass surfaced it as dead weight.
**Reason:** Ships-what-it-uses is part of "keep the dependency bar high" (see D1/D2/D10) — an unused runtime dependency is pure liability (supply-chain surface, install size) with zero benefit.
**Alternatives:** None — this is just cleanup, not a design trade-off.

## D17. ESLint (flat config, typescript-eslint) + Prettier added as dev tooling
**Decision:** Added `eslint` + `@eslint/js` + `typescript-eslint` (flat `eslint.config.js`) and `prettier` (`.prettierrc.json`) as devDependencies. `npm run lint`/`format`/`format:check` wired into `package.json` and into CI. Prettier is scoped to code only (`.prettierignore` excludes `*.md` and `fixtures/`) — markdown docs are hand-formatted prose, and the fixture vault's exact whitespace/link syntax is test data, not something a formatter should touch.
**Reason:** Requested as part of making this a real FOSS project with a contribution workflow (`CONTRIBUTING.md` references both). Consistent formatting/linting lowers the bar for outside contributors and catches an entire class of nitpick review comments before a human has to make them.
**Alternatives:** Biome (single tool, faster) — reasonable alternative, not chosen simply because ESLint + Prettier is the more widely recognized combination for contributors coming from other TypeScript projects, and the project's lint surface is small enough that Biome's speed advantage doesn't matter here.

## D18. Growth CLI commands generate or diagnose, but do not silently edit client settings
**Decision:** The stdio binary keeps its backward-compatible `<vault-path>` server mode and adds `demo`, `init`, and `doctor` subcommands. `demo` uses and deletes a runtime-created temporary vault; `init` prints copyable client-specific configuration; `doctor` performs a read-only in-memory index check and supports `--share` path redaction. None of these commands modifies Codex, Claude, or ChatGPT global settings.
**Reason:** The largest adoption barrier is getting to a safe first successful call, but global configuration locations and merge semantics vary by client and OS. Generating exact configuration is deterministic and reversible; silently editing user-wide settings from an npm package is not.
**Alternatives:** An interactive `init --apply` that rewrites global configuration — deferred until every supported client's merge behavior can be tested without risking unrelated user configuration.

## D19. `apply_template` implements Obsidian's core Templates variables only, not Templater
**Decision:** `apply_template` substitutes exactly the variable set Obsidian's built-in core Templates plugin supports — `{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{time:FORMAT}}`, `{{title}}` — using a small hand-written subset of moment.js format tokens (`YYYY/YY/MM/DD/HH/mm/ss`). Templater-only syntax (`<% tp.file.title %>`, user scripts, prompts) is left untouched as literal text rather than guessed at or partially evaluated.
**Reason:** Templater is a community plugin that executes arbitrary JavaScript inside Obsidian's live app context (`tp.file`, `tp.system.prompt()`, etc.) — reimplementing even a useful subset headlessly would mean either running untrusted user-authored JS server-side (a real security surface for a tool whose other write paths are all deliberately narrow and non-executable) or silently mis-rendering the parts that need live app state, which is worse than not touching them. Core Templates' variable set is small, fully deterministic, and needs no app state beyond "what note is this becoming" — safe to implement exactly.
**Alternatives:** A full Templater-compatible JS execution engine — rejected as scope and security surface far beyond a template-variable substitution tool. Pulling in `moment` for full format-token coverage — rejected per the dependency bar in D1/D2/D10; the hand-written 7-token subset covers the date/time formats real daily-note templates actually use.

## D20. Semantic search: local `transformers.js` embeddings, brute-force cosine, lazy/on-demand indexing
**Decision:** `semantic_search` and `get_related`'s `method: "semantic"` are backed by `@huggingface/transformers` running `Xenova/multilingual-e5-small` (int8-quantized, `dtype: "q8"`, ~120MB) fully locally — no external server, account, or API key. Vectors are stored as BLOBs in a new `embeddings` SQLite table (one row per markdown file) and compared with a plain in-JS cosine similarity loop, not a vector-search extension (`sqlite-vec`, pgvector, etc.). Embedding is never run during `init()`/`fullScan()`/the watcher; `VaultEngine.ensureEmbeddingsFresh(limit)` computes it lazily, bounded per call, the first time a semantic tool is actually used. `VaultDB.upsertFts` deletes a file's embedding whenever its content actually changes (it's only called on real content changes, per D-scan's hash-gating), so `ensureEmbeddingsFresh`'s "missing embedding" query naturally covers both new and changed files with no separate staleness tracking. The model's cache directory is redirected to `~/.obsidian-everywhere/models/` (transformers.js defaults to caching inside its own `node_modules` folder, which `npm install`/reinstall wipes).
**Reason:** Surveyed what comparable Obsidian MCP/semantic-search projects actually ship (see conversation research): the two real patterns are "fully local, zero setup" (Smart Connections — the most popular project in this space by far; `obsidian-companion-mcp` — an existing project using this exact model+runtime combination) versus "cloud/DB-backed" (Postgres+pgvector, Cloudflare Vectorize, OpenAI/Ollama endpoints) — the latter directly conflicts with this project's zero-external-service, works-out-of-the-box positioning (D1/D2/D10, the Docker zero-config fix, doctor/demo commands). `transformers.js` runs as a real native addon (`onnxruntime-node`, prebuilt binaries) rather than pure WASM in Node — the same dependency *tier* as `better-sqlite3`, already accepted, not a new category of risk. Brute-force cosine avoids adding a second native/extension dependency purely for vector search; at personal-vault scale (hundreds to low thousands of notes, each a 384-float vector) a full scan is low-single-digit milliseconds, nowhere near where an index would pay for its own complexity. e5 models require a "query: "/"passage: " prefix (asymmetric retrieval) — notes are embedded as "passage", search queries and note-to-note comparisons (both sides, per the model's own guidance for symmetric similarity) as covered in `index/embeddings.ts`.
**Known trade-offs (accepted, not silently hidden):** First use requires internet access to download the model from Hugging Face (cached afterward). CPU-only inference is slower than a GPU-backed or Ollama-served larger model — acceptable for a single user's vault, not for scale. `npm audit` reports two high-severity advisories with no fix available, both in `onnxruntime-node`'s/`sharp`'s transitive dependencies (`adm-zip`, bundled `libvips`) — both are unreachable via this project's actual usage (text-only feature-extraction never triggers zip extraction or image decoding), verified by inspection rather than assumed.
**Testing:** The real model is never loaded in the automated test suite (would make CI network-dependent, slow, and non-hermetic — a real regression from this project's fully-local test suite so far). `VaultEngineOptions.embedder` is injectable; tests use a deterministic bag-of-character-trigrams fake embedder (`src/mcp/semantic.test.ts`) that has no real semantic understanding but correlates similarity with textual overlap enough to test the actual thing that needs testing: storage, staleness invalidation, budget bounding, cascade delete, and ranking/wiring. The real embedder was verified manually (not as part of the automated suite) against a small multilingual fixture and correctly ranked a Korean note above an unrelated English note for an English query with zero shared vocabulary, confirming genuine cross-lingual retrieval rather than disguised lexical matching.
**Alternatives:** Ollama (external local server) — better quality/speed if the user happens to have it running, but reintroduces an external-process dependency this project has consistently avoided; could be added later as an opt-in accelerator without changing this default. `sqlite-vec`/pgvector — rejected at this scale per the brute-force reasoning above. Chunk-level (paragraph/heading) embeddings instead of one-per-note — more precise for long notes, deferred as added complexity not justified for a v1; note-level embeddings match how full-text search already treats a note as one document.

## D21. `fullScan`/`applyFileUpsert`/`applyFileDelete` run inside a DB transaction
**Decision:** `VaultDB.transaction(fn)` wraps `fn` in a `better-sqlite3` transaction (commits only if `fn` returns normally; rolls back every write it made if it throws). `fullScan`, `applyFileUpsert`, and `applyFileDelete` (`index/scan.ts`) now run their entire body through it.
**Reason:** Found on a real, long-running deployment: `fullScan` writes every file's content in one pass, then every file's *links* in a second, later pass (`buildResolverIndex` + `replaceLinks` per file). Before this fix, a crash between those two passes (e.g. an earlier, since-fixed bug where one file's unparseable frontmatter threw and took down the whole scan) left every file processed in the first pass with content correctly stored but zero rows in `links` — and `upsertFileContent`'s mtime+hash "unchanged" short-circuit is blind to that: it only compares content hashes, so a file in that half-written state looks identical to a fully-correct one on every future scan and is never revisited. Confirmed on the reporting vault by direct SQLite inspection: `raw_content` for `daily/2026-06-15.md` clearly contained `[[DSLab/weekly/2026-W25.md|2026-W25]]`, but its `links` table row count was 0 — repeated across ~40 files (all of `daily/` and `weekly/`), inflating `find_orphans` results and undercounting backlinks/outlinks vault-wide (48 total resolved links where a fresh, transactional rescan found 364). The existing vault's corrupted index was repaired by deleting and letting a fresh `fullScan` rebuild it (the transaction fix prevents recurrence, it doesn't retroactively repair already-corrupted state from before it existed).
**Testing:** `src/index/scan.test.ts` — a direct `VaultDB.transaction` rollback test, and a `fullScan` integration test that makes one file unreadable (`chmodSync 0o000`) partway through a second scan and asserts an *earlier-processed* file's content update was rolled back too, not just the unreadable file skipped.
**Alternatives:** Track a per-file "links successfully written" flag and repair opportunistically — more invasive (schema change, extra bookkeeping) for a problem transactions solve for free. Wrap only the links-writing loop rather than the whole scan — narrower, but the content-writing loop has the same class of risk (a crash after file 50 of 100 leaves files 1-50 committed and 51-100 not, which is a less severe but still real inconsistency); wrapping the whole scan is one primitive that removes the entire class of partial-scan states.

## D22. Every tool's `inputSchema` is wrapped in `z.object(shape).strict()`
**Decision:** Added a `strictSchema(shape)` helper in `src/mcp/server.ts` that every `registerTool` call now passes its raw zod shape through, instead of handing the SDK a bare raw shape object.
**Reason:** Found live, twice, independently, during a vault-reorganization session: a caller (an agent, in this case) that mistypes a parameter name — `list_folder({path: "PROVE"})` instead of `{folder: "PROVE"}`, `regex_search({paths: [...]})` instead of `{folder: ...}` — got no error at all. `@modelcontextprotocol/sdk` wraps a raw zod-shape `inputSchema` in a plain `z.object(shape)` internally (`zod-compat.js`'s `objectFromShape`), and zod's default parse mode is "strip": unknown keys are silently dropped, not rejected, even though the tool's *published* JSON Schema says `additionalProperties: false`. The practical effect: the call still "succeeds," just silently ignoring the caller's actual intent and running with whatever that parameter's default is (here: `folder` unset, so it searched/listed the whole vault instead of the intended subfolder) — indistinguishable from a correct call except that the results are subtly wrong. `.strict()` turns the same input into an explicit `Unrecognized key(s) in object: 'paths'` error surfaced through the normal tool-error path.
**Testing:** `src/mcp/server.test.ts` calls `regex_search` with a `paths` argument (which doesn't exist — the real param is `folder`) over the real MCP client/server pair and asserts `result.isError === true` with the unrecognized-key message in the response text, rather than a silently-wrong empty/whole-vault result.
**Alternatives:** Fix only the two tools that actually tripped this — rejected, every one of the 36 registered tools has the identical latent gap, and the next one to bite a caller is just whichever param name they happen to typo next. Validate manually inside each tool's implementation function instead of at the schema layer — rejected, duplicates work the schema layer already does for every other (recognized) field and would need to be repeated per tool instead of once in a shared helper.

## D23. `bulk_update_frontmatter` / `bulk_remove_frontmatter_field`, and `list_notes` property projection
**Decision:** Two new write tools mirror `bulk_replace`'s shape exactly (folder-or-vault scope, dry-run default, `maxFiles` guard, rollback snapshot via the existing `applyRollbackableChanges`/`rollback_bulk_edit` machinery) but operate on one frontmatter field at a time instead of a text find/replace: `bulk_update_frontmatter({fields, folder?, dryRun?, maxFiles?})` merges fields into every note where at least one value actually differs; `bulk_remove_frontmatter_field({field, folder?, dryRun?, maxFiles?})` removes one field from every note that carries it. Separately, `list_notes` gained an optional `properties: string[]` that projects named frontmatter fields (from the already-indexed `frontmatter_json` column, no extra file reads) alongside each listed note; a note missing a requested field reports it as `null`/`—` rather than being silently omitted.
**Reason:** Found live, during a real ~90-note vault reorganization: removing one redundant field (`reviewed`, superseded by file mtime) from every note required 88 individual `remove_frontmatter_field` calls looped by hand, and auditing "does every note in this folder have a consistent `status`" required a `read_note` per file since `regex_search` deliberately only searches note bodies, never frontmatter (D-scan's body/frontmatter split is intentional, not a bug — see the caller confusion this also caused, D22). Both gaps turn a one-shot bulk operation into O(n) individual tool calls with no atomicity or rollback across them.
**Testing:** `src/mcp/write-tools.test.ts` — dry-run-then-apply-then-rollback round trips for both new tools against a real isolated vault copy, asserting only notes with an actual value change are touched; and a `list_notes` test asserting a note missing a requested property reports it as missing rather than being dropped from the result.
**Alternatives:** Extend `bulk_replace`'s regex-over-raw-text to also cover frontmatter — rejected, YAML values aren't reliably text-replaceable (type changes, list vs scalar, quoting) the way body prose is; a dedicated frontmatter-aware merge (parse → merge → reserialize, same as the single-note `update_frontmatter`/`remove_frontmatter_field`) is the same operation `bulk_replace` already isn't used for on body prose. A generic "run this JS transform over every note's frontmatter" tool — rejected as arbitrary code execution against the vault, well outside this project's narrow, non-executable write-tool surface (see D19's Templater reasoning for the same principle applied elsewhere).

## D24. Remote Vault Bridge and mount-guard are one safety boundary

**Decision:** Treat authenticated remote graph/read/write access as a primary
product capability, and ship removable/network/container mount protection as
an opt-in Beta safety boundary around it. `VaultEngine` owns a cross-platform
state machine (`disabled`, `healthy`, `unavailable`, `reconciling`) instead of
putting deployment-specific `/Volumes` behavior in the MCP or watcher layer.
The watcher asks the engine whether an unlink is safe; the engine preserves the
persistent index on mount loss, blocks every registered write tool while stale,
replaces any active filesystem watcher after the mount returns, waits for that
watcher's initial walk, and then performs a stable full reconciliation.
Guarded full scans remain inside an outer SQLite transaction until a post-scan
mount check passes, so a mid-scan disconnect rolls the index back. A
vault-relative sentinel is optional but recommended because "directory is
non-empty" alone cannot distinguish the intended share from an exposed fallback
mount point. Static bearer authentication is acceptable on a public endpoint
only behind a TLS-terminating tunnel, with a high-entropy token, constant-time
comparison, failed-auth rate limiting, and a read-only-first deployment flow.

**Reason:** A remote client being "Connected" proves only transport health. In
a real external-drive deployment, the HTTP process twice remained healthy while
its index contained zero notes: first because it started before the mount was
ready, then because an active unmount produced an unlink storm. Remote writes
make silently targeting that state unacceptable. Availability must be visible
to the agent (`vault_status` and `vault_overview`), to operators (`/healthz`),
and to the write boundary itself.

**Alternatives:** Always enable the guard — rejected because genuinely empty
vaults are valid and mass deletion can be intentional. Detect only macOS
`/Volumes` paths — rejected because the same failure exists on Linux mounts,
Windows drives, NAS shares, and Docker bind mounts. Stop serving all indexed
reads during outage — rejected because clearly marked stale search/context can
still be useful; writes are the operation that must fail closed. Automatically
create a hidden sentinel — rejected because the server should not mutate a
vault merely to identify it.

## D25. Attachment content is extracted lazily, locally, sequentially, and cached

**Decision:** Index every non-excluded vault file as before, and add an
`attachment_extractions` cache keyed by file hash plus extractor version.
`read_file` extracts one requested file immediately; `search_files` processes a
bounded queue of at most ten stale attachments per call and combines
case-insensitive filename/path matches with extracted-text results. Attachment,
folder, and extension predicates are applied inside the FTS query before its
limit, so note matches cannot crowd attachment results out. An exact safe
`read_file` path may synchronously add one missed on-disk file to the index;
the recovery rejects traversal, excluded paths, and every symlink component,
and obeys mount-guard's pre/post availability checks. Extraction is always
sequential. PDF uses `pdfjs-dist`; OOXML/OpenDocument/EPUB containers use the
exact `adm-zip` dependency and narrowly scoped XML text extraction. Plain
text/code/data, RTF, and common images are handled directly. Source size, PDF
size, ZIP entry expansion, extracted characters, and inline image payloads all
have hard limits. Extracted text joins the existing FTS index, while Markdown
search remains explicitly filtered to notes.

**Reason:** The vault is often a knowledge graph whose evidence lives in PDFs,
slides, spreadsheets, and documents. Local lazy extraction preserves privacy,
avoids startup spikes, and means unchanged files pay the parsing cost only once.
The measured PDF+DOCX+text fixture workload peaks at about 123 MiB RSS, within
the project's 200 MiB default-process ceiling.

**Alternatives:** Eagerly parse the entire vault at startup — rejected for
latency and memory. Upload files to a cloud conversion API — rejected for
privacy and offline operation. `officeparser` — evaluated and removed because
its dependency tree introduced high-severity vulnerable PDF packages. Native
LibreOffice/Tika subprocesses — broader fidelity, but rejected as heavyweight
system dependencies for the default FOSS install. Unknown binary formats remain
indexed with metadata and an explicit unsupported status rather than being
silently decoded or omitted.

## D26. The default runtime is low-memory; transformer semantics are opt-in

**Decision:** `@huggingface/transformers` is an optional peer and
`multilingual-e5-small` is loaded only when the peer is installed and
`OBSIDIAN_EVERYWHERE_ENABLE_SEMANTIC=true`. The `semantic_search` tool remains
discoverable and returns an actionable low-memory message when disabled;
`get_related` keeps its lightweight Jaccard default. Injected test embedders
enable the semantic path automatically.

**Reason:** RSS measurements on the actual Node process showed roughly 69 MiB
idle, 123 MiB after attachment extraction, but more than 500 MiB after loading
and using the multilingual q8 transformer. A q4 experiment was worse (over 600
MiB after inference). Leaving this implicit would violate the explicit
100–200 MiB operating target on an 8GB machine. Graph traversal, FTS, context
bundles, attachments, and writes do not require the model.

**Alternatives:** Keep lazy loading as sufficient — rejected because memory
remains retained after first use. Run the model in a child process — rejected
because total machine memory still exceeds the user's limit. Replace it with an
English-only tiny model — rejected because Korean/multilingual vault support is
a core requirement. Label lexical hashing as semantic search — rejected as
misleading. A genuinely small multilingual model can become a future default
after repeatable quality and RSS gates pass.

## D27. Vault Git is an opt-in, capability-ordered, preview-approved boundary—not a remote Git shell

**Decision:** Add an opt-in Git feature with one ordered startup setting,
`OBSIDIAN_EVERYWHERE_GIT_MODE=off|read|commit|push`, defaulting to `off` on every
transport. `read` registers `git_status`, `git_diff`, and `git_log`; `commit`
also registers `git_commit` when the transport's ordinary write gate is open;
`push` also registers `git_push` behind that same gate. OAuth therefore needs
both a sufficient Git mode and `OAUTH_ENABLE_WRITE_TOOLS=true` for commit or
push. Push mode additionally fails fast unless
`OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES` contains at least one valid,
comma-separated exact `name=https://host/path.git` mapping. Production mappings
accept HTTPS only and reject credentials, queries, and fragments.

`OBSIDIAN_EVERYWHERE_GIT_REPO_PATH` is a second operator-only startup setting.
It defaults to `.`, may select one safe vault-relative real directory, and is
never caller input. The selected directory must itself be the canonical root of
a normal repository with a real local `.git` directory and its canonical
Git/common directories inside it. The full vault remains indexed; only Git
operations and their path namespace are scoped to the selected repository.
Parent discovery, linked worktrees, submodule roots, symlinked repository path
components, symlinked/external core metadata, alternate object stores, and
unsafe object/ref/log layouts are rejected for every Git tool. Commit and push
additionally reject shallow repositories, sparse checkouts, per-worktree Git
configuration, grafts/replacement refs, detached targets, and
merge/rebase/cherry-pick/revert/bisect state. Every Git operation probes Mount
Guard and fails closed while the live vault is unavailable or reconciling.
The canonical vault, selected repository, and `.git` device/inode identities
are captured at startup, rechecked before every Git subprocess, and included in
commit/push approval fingerprints. A changed mount, replaced directory, or new
symlink therefore requires operator verification and a process restart.

`git_commit` and `git_push` use the same explicit two-step shape:
`action: "preview"` returns a random UUID that expires after five minutes;
`action: "execute"` accepts only that UUID, consumes it on the first attempt,
recomputes the reviewed state, and aborts on any mismatch. Commit approval binds
the branch/ref, old `HEAD`, single-line secret-scanned message, exact paths and
rename paths, selected content, and exact proposed tree. A temporary index
builds a commit from only those paths; execution rebuilds the tree, then an
expected-old-value ref update advances the branch without including unrelated
staged changes. Push approval binds the branch, `HEAD`, exact existing upstream,
remote name, reviewed local-tracking OID, and literal operator-pinned URL.
Preview performs no network access; execute pushes the one approved `HEAD` to
Git's exact configured upstream remote ref through that literal URL. The target
comes from `%(upstream:remoteref)`, not the local branch name, so a local `main`
tracking `origin/release` updates only `release`.

**Safety design:** Git commands are fixed argument arrays executed with
`shell: false`. Caller paths are literal, selected-repository-relative, exact changed paths;
proposed entries must be regular files, while explicit deletions are supported.
Hidden/excluded/sensitive paths, traversal, pathspec magic, symlinks,
directories, unmerged entries, and suspected credentials are refused. External
diff/textconv, fsmonitor, hooks, signing, clean filters and Git LFS, submodule
recursion, unconditional force, tags, follow-tags, caller-provided refspecs, and
interactive prompts are disabled. An exact-OID `--force-with-lease` is used only
as a compare-and-swap guard so a deleted, advanced, or reset remote ref fails.
Push also rejects repository-local credential helpers, URL rewrites, all
`http.*` transport settings, and selected-remote proxy settings; trusted
credentials and network policy remain in operator-controlled user/system Git
configuration.
Automatic content review is bounded to 8 MiB per file/blob and 32 MiB total;
outgoing push review is additionally capped at 100 commits and 200 changed blobs
and scans commit messages and merge results. `git_diff` exposes untracked content
only for explicit safe paths in `head` mode.

Push accepts no caller URL, credential, remote, branch, or refspec. The current
branch must already track a normal branch whose remote name has an exact
operator-provided HTTPS mapping. The repository remote must resolve to exactly
one push URL and its normalized value must equal that mapping. Execution then
supplies the mapped URL literally. SSH, HTTP, `git://`, file/local paths, custom
remote helpers, multiple push URLs, and credentials/query/fragment in the
mapping are rejected. Behind/divergent state or an exact-lease mismatch must be
reconciled with trusted local Git. The existing non-interactive HTTPS credential
configuration on the vault machine remains an explicit operator trust
dependency.

**Reason:** Status, diff, local history, a selected-file checkpoint, and an
explicitly approved outbound push form a useful end-to-end workflow after an
agent edits a vault—especially through Remote Vault Bridge. But Git's command
surface is also a code-execution surface: aliases can expand to shell commands;
hooks, filters, diff/textconv drivers, SSH configuration, and credential helpers
can execute programs; arbitrary refspecs can rewrite or delete remote refs. The
same default-on boundary used for ordinary note writes is therefore too broad
for repository history and publication. A separate mode, pinned push mappings,
fixed commands, and reviewed state-bound approvals make the capability visible
and incremental without pretending Git can be safely sandboxed by a loose
argument filter.

**Alternatives:** A generic `git_exec` or shell tool — rejected as remote code
execution by design. A single `GIT_ENABLED=true` flag — rejected because local
inspection, local history mutation, and network publication are materially
different capabilities. Automatically commit every vault change — rejected
because it can capture unrelated, hidden, staged, or sensitive work. Accept a
remote URL/refspec per call, support unconditional force/tags, or create
upstreams — rejected because it bypasses operator configuration and widens
remote impact. Add
pull/fetch/merge as “sync” — rejected because incoming history introduces
conflicts and working-tree mutation that cannot be safely reduced to the same
preview primitive. Run hooks, signing, filters/LFS, or submodules for feature
parity — rejected because those features intentionally execute local code and
must remain in the operator's trusted local Git workflow.

**Testing:** `src/git/vault-git.test.ts` covers configured subdirectory and
exact-root/metadata enforcement;
safe status/diff/log including explicit untracked-head diff; single-line message
and outgoing message/merge secret review; Unicode/space-containing paths;
explicit new/delete/rename commits; exact-tree approval and preservation of
unrelated staged changes; hook/filter suppression; expired, one-use, and
state-invalidated approvals; pinned literal destinations; exact-OID lease failure; and a local
branch tracking a differently named remote branch. `src/mcp/git-tools.test.ts`
covers capability and ordinary-write gating, annotations, strict schemas,
preview/execute behavior, and Mount Guard failure.
