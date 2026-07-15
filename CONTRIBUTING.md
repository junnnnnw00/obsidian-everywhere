# Contributing to Obsidian Everywhere

Thanks for considering a contribution. This project is a graph-native MCP
server for Obsidian vaults — see [`docs/architecture.md`](docs/architecture.md)
for how it's built before diving into a change; it'll save you time
figuring out where something belongs.

## Dev setup

```bash
git clone https://github.com/junnnnnw00/obsidian-everywhere.git
cd obsidian-everywhere
npm install
npm run build
npm test
```

No API keys, external services, or account setup needed to develop or run
the test suite — everything runs against `fixtures/test-vault/`, a
fixture vault committed to the repo.

Useful scripts:

```bash
npm run dev:stdio        # tsx, runs src/cli.ts directly, no build step
npm run dev:http
npm run dev:oauth-http
npm test                 # vitest run
npm run test:watch       # vitest watch mode
npm run typecheck        # tsc --noEmit
npm run lint             # eslint src
npm run format           # prettier --write . (code only — see below)
npm run format:check     # what CI runs
```

## Before opening a PR

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

All four are required checks in CI (`.github/workflows/ci.yml`, Node
20.x and 22.x). `npm run format` only touches TypeScript/JS/JSON — markdown
docs are intentionally excluded from Prettier (see `.prettierignore`) so
hand-formatted prose and shell examples in docs aren't reflowed.

## Testing conventions

- **No mocks for the core engine.** Parser, index, and graph tests run
  against real files (`fixtures/test-vault/`) and a real (in-memory)
  SQLite database via `better-sqlite3`. Watcher tests use real filesystem
  events (`fs.writeFileSync`/`renameSync`/etc. against a temp directory),
  not simulated chokidar events. If you're testing new behavior in the
  graph engine, this is the bar to match — a test that mocks the thing
  it's supposed to verify isn't testing much.
- **Write-tool tests never touch `fixtures/test-vault/` directly.** They
  copy it to a temp directory first (see `src/mcp/write-tools.test.ts`).
  If you add a test that writes to disk, follow that pattern — the fixture
  vault is committed and shared by every other test file.
- **New parser/link-resolution edge cases go in the fixture vault**, not
  as inline strings only. If you're fixing a parsing bug, add a note (or
  extend an existing one) in `fixtures/test-vault/` that exercises it, so
  the fix is covered end to end (parser → SQL index → graph), not just at
  the unit level. Inline-string unit tests (see `src/parser/markdown.test.ts`)
  are still the right place for isolated regex-level cases.
- **MCP tool tests use a real client/server pair**, not a hand-rolled
  stub of the SDK. `src/mcp/server.test.ts` uses
  `InMemoryTransport.createLinkedPair()` from the SDK; `src/http/app.test.ts`
  and `src/oauth/http-app.test.ts` spin up a real listening HTTP server
  and hit it with real `fetch`/`http.request` calls.

## Code style

TypeScript, ESM (`NodeNext` module resolution — relative imports need
`.js` extensions in source, since that's what Node needs at runtime).
Enforced by `eslint.config.js` + `.prettierrc.json`; both run in CI. A few
conventions that aren't enforced by tooling but matter here:

- Comments explain *why*, not *what*. Well-named functions/variables
  already say what the code does; a comment earns its place by
  documenting a non-obvious constraint, a workaround, or a subtle
  invariant (see the existing code for examples — e.g. the comment on
  `syncOutlinksFromDb` in `src/graph/graph.ts`).
- Non-obvious design choices belong in [`DECISIONS.md`](DECISIONS.md) —
  decision, reason, alternatives considered. If your PR makes a call that
  isn't forced by the spec (a tie-break rule, a default value, a "why not
  library X instead"), add an entry. Future contributors (including you,
  in six months) will want the "why."
- New npm dependencies: keep the bar high. This project is deliberately
  light on dependencies (see D1–D2, D10 in DECISIONS.md for the reasoning
  behind the ones it does have). If you're adding one, say why in the PR
  description and in DECISIONS.md.

## Commit messages

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, ...) —
look at `git log` for the pattern this repo already follows. PR titles
should follow the same convention; they often become the squash-merge
commit message.

## Architecture orientation

If you're not sure where a change belongs:

- Parsing a new markdown construct → `src/parser/markdown.ts`
- Link resolution rules → `src/vault/resolve.ts`
- New SQL query for an existing table → `src/index/db.ts`
- Graph traversal (n-hop, shortest path, centrality) → `src/graph/graph.ts`
- A new MCP tool → implement the logic in `src/mcp/tools.ts`, register it
  in `src/mcp/server.ts`
- Something about how a transport authenticates or exposes `/mcp` →
  `src/http/app.ts` (shared) / `src/oauth/` (OAuth-specific)

`docs/architecture.md` walks all of this in more depth.

## Reporting bugs / requesting features

Use the GitHub issue templates (`.github/ISSUE_TEMPLATE/`). For security
vulnerabilities, see [`SECURITY.md`](SECURITY.md) instead of a public issue.
