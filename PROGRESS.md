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

## 2026-07-15 21:24 — Phase 2 complete

- All 10 v0.1 tools implemented (`src/mcp/tools.ts`) over the `VaultEngine`:
  `vault_overview`, `search_notes`, `read_note`, `get_backlinks`,
  `get_neighborhood`, `get_context_bundle`, `list_tags`, `get_notes_by_tag`,
  `find_orphans`, `find_unresolved`. All registered with
  `annotations: {readOnlyHint: true, openWorldHint: false}` in
  `src/mcp/server.ts`. User-supplied note references (path/title/alias) are
  resolved via `resolveNoteArg`, which reuses the exact same
  `vault/resolve.ts` logic links use internally.
- `get_context_bundle` packs the center note + 1-hop neighbors (sorted by
  backlink count, then recency) into a token budget using a cheap chars/4
  estimator for packing decisions, verified against a real BPE tokenizer
  (`gpt-tokenizer`, devDependency) in tests.
- `src/cli.ts`: stdio entrypoint. Resolves vault path from arg or
  `OBSIDIAN_VAULT_PATH`, index db path from `OBSIDIAN_EVERYWHERE_DB` (default
  `<vault>/.obsidian-everywhere/index.db`), runs `VaultEngine.init()` +
  `.watch()`, connects `StdioServerTransport`, handles SIGINT/SIGTERM.
- Gate evidence — two independent verifications, both against real (not
  mocked) server code:

```
$ npm test  (src/mcp/server.test.ts, 13 tests, via InMemoryTransport)
✓ lists all 10 tools, each read-only
✓ vault_overview / search_notes / read_note (incl. heading-scoped read)
✓ get_backlinks / get_neighborhood
✓ get_context_bundle resolves via alias; respects token budget (checked
  with gpt-tokenizer, not the tool's own heuristic); grows with a larger budget
✓ list_tags / get_notes_by_tag / find_orphans / find_unresolved
Test Files  7 passed (7)   Tests  63 passed (63)

$ node scratch-smoke.mjs <fixture-vault> dist/cli.js   (real subprocess, real stdio transport)
tools/list: 10 tools -> vault_overview, search_notes, read_note, get_backlinks,
  get_neighborhood, get_context_bundle, list_tags, get_notes_by_tag, find_orphans, find_unresolved
vault_overview call succeeded: # Vault Overview
contains Hub Note reference: true
```

## 2026-07-15 21:26 — Phase 3 complete

- `src/http/app.ts`: Streamable HTTP transport (`StreamableHTTPServerTransport`
  from the SDK) mounted at `/mcp`, gated by a static bearer token middleware.
  One transport + one `McpServer` instance per session, keyed by
  `Mcp-Session-Id` (SDK's stateful-session pattern); session map cleans up
  on transport close. `/healthz` for basic liveness checks.
- `src/http-cli.ts`: HTTP entrypoint (`obsidian-everywhere-http` bin), reads
  `OBSIDIAN_VAULT_PATH`/`OBSIDIAN_EVERYWHERE_DB`/`OBSIDIAN_EVERYWHERE_TOKEN`/`PORT`.
  Refuses to start without a token configured.
- Gate evidence — real HTTP integration test suite (`src/http/app.test.ts`,
  actual `fetch()` against a real listening `http.Server`, no mocking) plus
  a literal `curl` sequence against the built HTTP CLI:

```
$ npm test  (src/http/app.test.ts, 4 tests)
✓ rejects requests with no bearer token (401)
✓ rejects requests with an invalid bearer token (401)
✓ initialize -> notifications/initialized -> tools/list -> tools/call ->
  DELETE session -> reuse of deleted session id (404)
✓ rejects a non-initialize request with no session id (400)

$ curl sequence against `node dist/http-cli.js <fixture-vault>` on :8934
1. no token                -> 401
2. wrong token              -> 401
3. initialize (real token)  -> 200, protocolVersion 2025-11-25, Mcp-Session-Id header present
4. notifications/initialized -> 202
5. tools/list                -> 200, includes vault_overview ... get_context_bundle ...
6. tools/call vault_overview  -> 200, "# Vault Overview ... Hub notes (by PageRank) ..."
```

Full suite after Phase 3: `Test Files 8 passed (8)  Tests 67 passed (67)`.

## 2026-07-16 00:20 — Phase 4: OAuth 2.1 done and e2e-verified; Docker gate blocked by host disk space

- `src/oauth/provider.ts`: `SingleUserOAuthProvider` implements the SDK's
  `OAuthServerProvider` (DCR clients store, PKCE code/token issuance,
  refresh, revoke, `verifyAccessToken`). `authorize()` renders a minimal
  HTML login form (one secret field); the actual OAuth code/token machinery
  is otherwise standard PKCE. See DECISIONS.md D11 for why this is
  deliberately not a real multi-tenant IdP.
- `src/oauth/http-app.ts` mounts the SDK's `mcpAuthRouter` (discovery,
  `/register`, `/token`, `/revoke`) plus our own `/login` route, and gates
  `/mcp` with `requireBearerAuth`. Reuses `mountMcpEndpoint` extracted from
  `src/http/app.ts` (Phase 3) so the session/transport bookkeeping isn't
  duplicated between the static-bearer and OAuth apps.
- `src/oauth-http-cli.ts`: third entrypoint (`obsidian-everywhere-oauth-http`).
- Deploy assets: `Dockerfile` (multi-stage, Debian-slim for prebuilt
  better-sqlite3 binaries), `docker-compose.yml` (two services — bearer for
  Tailscale, OAuth for the public tunnel), `.env.example`,
  `deploy/com.obsidian-everywhere.http.plist.template` +
  `scripts/install-launchagent.sh`/`uninstall-launchagent.sh`,
  `scripts/setup-cloudflare-tunnel.sh`, `docs/deploy.md`.

**Gate evidence — OAuth flow (fully verified, real HTTP, no mocking):**

```
$ npm test  (src/oauth/http-app.test.ts, 3 tests)
✓ publishes authorization-server and protected-resource discovery metadata
✓ returns 401 with a WWW-Authenticate discovery pointer for an unauthenticated /mcp request
✓ runs the full flow end to end:
    DCR /register → PKCE /authorize (renders login form) → wrong secret
    rejected (401, one-shot authzId burned) → fresh /authorize → correct
    secret → 302 redirect with code+state → /token exchange → Bearer
    access_token → authenticated initialize/tools/call against /mcp →
    invalid token still rejected (401)
```
Full suite: `Test Files 9 passed (9)  Tests 70 passed (70)`.

**Gate evidence — Docker (partial, host disk-space incident):**

Mid-Phase-4, `docker build` failed with `input/output error` from
buildkit; turned out the host disk was completely full (even `echo test`
in bash and `git status` failed with `ENOSPC`). This was a host
environment problem, not a defect in the Dockerfile — paused and asked the
user to free disk space rather than attempting any destructive cleanup
unattended. Space was freed (`df -h /` → 9.9Gi available afterward), but
Docker Desktop's own daemon did not come back up cleanly on this machine
across multiple restart attempts (`open -a Docker`, force-quit + relaunch,
~4 minutes of polling `docker info`). What *is* verified without the
daemon:

```
$ docker compose config   (with dummy env vars)
# renders both services correctly: build context, command, env vars,
# port mappings, and bind-mount volumes all as intended — see full
# output captured during the session. No YAML/schema errors.
```

The full `docker build && docker run` gate is left as a checklist item in
`HANDOFF.md` §1 — this is an environment-availability gap, not unfinished
project code. Per the spec's "don't burn the whole night on one problem"
rule, moving on to Phase 5 rather than continuing to poll the daemon.
(Retried the daemon again at the start of Phase 5 — still down. Leaving it
for the final fresh-clone gate; documented as-is otherwise.)

## 2026-07-16 00:24 — Phase 5: docs, CI, LICENSE, and two stretch tools

- `README.md` (English): project pitch, full tool table, quickstart for
  all three transports (Claude Code stdio, Claude Desktop config, remote
  Tailscale bearer-token, claude.ai OAuth connector), config table, dev
  commands.
- `docs/architecture.md`: walks the whole engine end to end (parser →
  resolver → SQLite → in-memory graph → watcher → orchestrator → MCP tool
  layer → transports), pointing at real file paths and referencing the
  DECISIONS.md entries that explain the non-obvious choices.
- `LICENSE` (MIT), `.github/workflows/ci.yml` (build+test on Node 20.x and
  22.x, push+PR).
- Stretch goals implemented (priorities 1–2 from spec §5; write tools and
  further context-bundle tuning left as follow-ups, noted in README):
  - `find_path`: shortest undirected path between two notes
    (`VaultGraph.shortestPath`, already built in Phase 1) + a one-line
    summary per hop.
  - `get_related`: Jaccard similarity over a combined {tags} ∪
    {1-hop neighbor ids} feature set, explicitly excluding notes that are
    already directly linked — see DECISIONS.md D13.
  - Both registered as read-only tools; server now exposes 12 tools total.

**Gate evidence:**

```
$ npm run build && npm test
✓ src/mcp/server.test.ts (16 tests)   — was 13, +3 for find_path/get_related
  incl. find_path 2-hop via Hub Note, disconnected-notes "no connection"
  case, get_related surfacing a tag-similar-but-unlinked note
Test Files  9 passed (9)   Tests  73 passed (73)
```

## 2026-07-16 00:27 — Final gate: fresh clone → install → build → test → stdio boot

Per spec §7's closing instruction, reproduced the whole pipeline from a
brand-new `git clone` (not the working tree) into `/tmp/oe-fresh-clone`,
following only what `README.md` tells a new user to do:

```
$ git clone <repo> /tmp/oe-fresh-clone && cd /tmp/oe-fresh-clone
$ npm install        # 251 packages, 0 vulnerabilities
$ npm run build       # tsc, 0 errors
$ npm test
Test Files  9 passed (9)   Tests  73 passed (73)

$ node scratch-smoke.mjs <fixture-vault> dist/cli.js   # real MCP client, real stdio subprocess
tools/list: 12 tools
vault_overview first line: # Vault Overview
contains Hub Note reference: true
```

One real flaky test was caught and fixed during this exact gate run (see
DECISIONS.md D14) — worth calling out precisely because this is what the
"reproduce it yourself" final gate is for; it caught something the earlier
phase-by-phase runs on the primary working tree hadn't hit.

**Outstanding items, tracked in `HANDOFF.md`, not silently dropped:**
- Docker daemon on this machine did not recover after the mid-Phase-4
  disk-space incident despite ~10 restart/poll attempts across the session
  (`docker compose config` — which needs no daemon — validates cleanly).
  `docker build && docker run` itself is unverified.
- Real Cloudflare Tunnel connection, real claude.ai connector registration,
  and a real `launchctl`-installed LaunchAgent are all genuinely
  unattended-environment-incompatible (need a browser, an Anthropic
  account, and/or persistent host-level state respectively) — checklists
  for a human are in `HANDOFF.md`.
- `create_note`/`append_to_note` write tools were not yet built as of this
  gate (spec §5 priority 3) — since promoted to shipped, see below.

## 2026-07-16 01:00 — Post-launch: write tools, real-vault validation, FOSS readiness

User feedback after the initial v0.1 handoff: write tools are important
(not optional), the project needs to be genuinely usable day-to-day (not
just fixture-tested), and it needs real FOSS repo hygiene for a GitHub
push. All addressed:

- **Real-vault validation.** Ran the full engine (`VaultEngine.init()`)
  and the MCP tool layer against a real personal vault (`~/jwhong`, 58
  markdown notes + 36 attachments, 56MB, Korean content, DSLab
  research notes) — not just the 31-note fixture vault. Indexed cleanly in
  70ms, graph consistency check passed, PageRank/search/context-bundle all
  produced sane output. Caught one real display bug this way: three
  distinct wikilinks to the same unresolved note (different block
  anchors) rendered as apparent duplicates in `find_unresolved` — fixed by
  including the heading/block fragment in the display (`db.ts`
  `findUnresolved` now selects `heading`/`block_id`; `tools.ts` renders
  them). This would not have been caught by the fixture vault, which
  didn't have a case of 3 links-to-different-blocks-of-one-unresolved-note
  on a single line.
- **`create_note` / `append_to_note`** (see DECISIONS.md D15): real write
  tools, not stubs. Path-traversal-safe (`toSafeVaultRelPath`/
  `resolveWithinVault`), synchronously reindexed
  (`VaultEngine.indexFileNow`) so the note is queryable by the *next* tool
  call without waiting on the watcher, fail-closed on a missing heading.
  Verified against both the isolated fixture-copy test suite (8 new tests
  in `write-tools.test.ts`) *and* a real round-trip against `~/jwhong`
  (create → verify on disk → append → verify → clean up, confirmed no
  artifacts left behind).
- **FOSS/GitHub readiness:**
  - `package.json`: added `repository`/`homepage`/`bugs`/`keywords`/`author`
    metadata (github.com/junnnnnw00/obsidian-everywhere), removed an
    unused `nanoid` dependency (D16) that had been added speculatively
    during Phase 0 scaffolding and never actually used.
  - ESLint (flat config) + Prettier added and wired into `npm run
    lint`/`format`/`format:check` and CI (D17). Ran once across the
    codebase: 1 auto-fixable ESLint warning, 17 files reformatted by
    Prettier (whitespace/line-wrap only) — confirmed 99/99 tests still
    pass after.
  - `.gitignore` hardened for a real GitHub push (IDE folders, `.env.*`
    variants, LaunchAgent log output) — scanned all tracked files for
    secret-shaped strings and `.env` files; none found.
  - Added `CONTRIBUTING.md` (dev setup, testing conventions — especially
    "no mocking the core engine," "write-tool tests never touch the
    committed fixture vault directly"), `CODE_OF_CONDUCT.md` (Contributor
    Covenant 2.1), `SECURITY.md` (vulnerability reporting + this project's
    trust model, since it does handle bearer tokens/OAuth secrets),
    `CHANGELOG.md` (v0.1.0 entry), GitHub issue templates
    (bug/feature) and a PR template, `.editorconfig`.
  - README: updated tool table/count (14, not 12), added CI + license
    badges, a Contributing section, fixed the `git clone <this-repo>`
    placeholder to the real URL.

**Gate evidence:**

```
$ npm run typecheck && npm run lint && npm run format:check && npm run build && npm test
tsc: 0 errors
eslint: 0 errors, 0 warnings
prettier --check: all files formatted
tsc build: 0 errors
Test Files  12 passed (12)   Tests  99 passed (99)
```

Reran the full fresh-clone gate (README-only reproduction, brand new
`git clone` into `/tmp`) one more time after this round of changes:
`npm install` → `typecheck` → `lint` → `format:check` → `build` → `test`
all clean (99/99), plus a real stdio boot confirming `tools/list` returns
14 tools including `create_note`/`append_to_note`.

Docker daemon on this machine: still unrecovered after the earlier
disk-space incident despite repeated checks across the session (`docker
compose config` continues to validate without the daemon). Unchanged from
the Phase 4 note — still tracked in `HANDOFF.md` §1, not silently dropped.

## 2026-07-16 01:40 — HANDOFF §1 resolved: Docker build/run verified for real

Diagnosed and fixed the Docker daemon: it wasn't a transient hiccup, it
was Docker Desktop stuck mid self-update (interrupted by the earlier
disk-full event) with corrupted orphaned image blobs left behind
(`docker system df` showed 242MB of untracked "Images" usage that
`docker images`/normal `prune` couldn't see or reclaim). Fixed by removing
the stale `~/Library/Application Support/com.docker.install/in_progress/`
staging directory and running `docker builder prune -af && docker system
prune -af --volumes` before rebuilding.

```
$ docker build -t obsidian-everywhere:test .
... (full multi-stage build, base image pull, npm ci x2, tsc build) ...
#14 exporting to image ... DONE

$ docker run -d --name oe-gate-test -p 3737:3737 \
    -e OBSIDIAN_EVERYWHERE_TOKEN=test-gate-token \
    -v "$(pwd)/fixtures/test-vault:/vault" obsidian-everywhere:test
$ docker logs oe-gate-test
obsidian-everywhere HTTP server listening on :3737 (vault: /vault)

$ curl http://localhost:3737/healthz
{"ok":true}
$ curl -X POST http://localhost:3737/mcp -H "Authorization: Bearer test-gate-token" ... initialize
event: message
data: {"result":{"protocolVersion":"2025-11-25", ...}}
$ curl ... tools/call vault_overview  (with Mcp-Session-Id from initialize)
data: {"result":{"content":[{"type":"text","text":"# Vault Overview\n\n- **Notes**: 31 markdown notes ..."}]}}
$ curl -X POST http://localhost:3737/mcp -H "Authorization: Bearer wrong" ...
401
```

Also verified `docker compose up -d obsidian-everywhere` (the actual
deployment path in `docker-compose.yml`, not just a raw `docker run`)
against the fixture vault with real env vars — `/healthz` and an
authenticated `initialize` both succeeded, then `docker compose down`
cleaned up (network + container removed, no leftover `.obsidian-everywhere/`
artifacts in the fixture vault directory afterward — verified with `git
status`).

No changes were needed to `Dockerfile`/`docker-compose.yml` — they were
correct all along; the blocker was entirely Docker Desktop's own local
state. HANDOFF.md §1 updated to reflect this is done.

## 2026-07-16 01:44 — HANDOFF §4 (LaunchAgent): 2 real bugs found and fixed via dry run

User asked to install the LaunchAgent for real, then changed their mind
(wants to install it themselves later) — ran a safe dry run instead
(`bash -n` syntax check, then a full functional run with a stubbed
`launchctl` on `PATH` so nothing was actually registered with launchd,
against the fixture vault; cleaned up the transiently-written plist file
and `logs/` dir afterward). This caught two real bugs that would have
hit the user the first time they actually ran the script:

1. `bash -n scripts/install-launchagent.sh` failed outright:
   `${OBSIDIAN_VAULT_PATH:?Set OBSIDIAN_VAULT_PATH to your vault's
   absolute path}"` — the apostrophe in "vault's" inside a `${VAR:?message}`
   default breaks bash's parser even though the whole thing is inside
   double quotes (a known bash gotcha: `${...}` expansion does its own
   quote-balancing pass that isn't the same as the enclosing string's).
   Reworded both `:?` messages in the file to avoid apostrophes.
2. `NODE_BIN="$(command -v node)"` under `set -e`: if `command -v node`
   ever fails (node not on PATH), the failed command substitution kills
   the script immediately, before the intended friendly "node not found on
   PATH" message can print. Changed to `command -v node || true` so the
   explicit `if [ -z "$NODE_BIN" ]` check actually gets to run.

After both fixes: `bash -n` passes on all three deployment scripts
(`install-launchagent.sh`, `uninstall-launchagent.sh`,
`setup-cloudflare-tunnel.sh`), and the stubbed-launchctl dry run completed
cleanly end to end (build → plist templating → `plutil -lint`-valid plist
→ fake bootstrap/enable calls), writing a correct plist (verified content:
absolute node path, absolute dist/http-cli.js path, vault path, token,
port, log paths all substituted correctly).

Full test suite re-verified after the fix: `Test Files 12 passed (12)
Tests 99 passed (99)`. HANDOFF.md §4 is otherwise unchanged — actually
running `launchctl bootstrap` for real is still left for the user, since
it registers a persistent background service on their machine and they
asked to do that step themselves.

## 2026-07-16 01:46 — Pushed to GitHub, CI verified green for real

`gh repo create junnnnnw00/obsidian-everywhere --private --source=. --remote=origin`
+ `git push -u origin main`. First real GitHub Actions run
(29433758327) passed on both Node 20.x/22.x matrix jobs (lint, format
check, build, test all green) — one annotation about `actions/checkout@v4`/
`actions/setup-node@v4` running on a deprecated Node 20 actions-runtime;
bumped both to `@v7` and pushed again (29433835857) — fully clean, zero
annotations. This is the real CI badge now shown in README.md.

Repo: https://github.com/junnnnnw00/obsidian-everywhere (private).
