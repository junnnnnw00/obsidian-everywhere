# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, use [GitHub's private vulnerability reporting](https://github.com/junnnnnw00/obsidian-everywhere/security/advisories/new)
for this repository. If that's unavailable, contact a maintainer directly.

Please include:

- What transport is affected (stdio / bearer-token HTTP / OAuth HTTP)
- Steps to reproduce
- What you'd expect to happen vs. what actually happens
- Impact (e.g. "reads arbitrary files outside the vault," "bypasses bearer
  token check," "write tools can escape the vault directory")

We'll acknowledge reports as soon as we can and aim to have a fix or
mitigation plan within a reasonable timeframe given this is a small,
mostly single-maintainer project — please be patient.

## Scope and known trust model

This project is built for a **single user's personal vault**, not a
multi-tenant service. A few things worth understanding before you deploy
it, so you don't mistake intended scope for a vulnerability:

- **The OAuth provider (`src/oauth/provider.ts`) is deliberately minimal.**
  There is exactly one user, authenticated by one pre-shared secret
  (`OAUTH_LOGIN_SECRET`) — not a real multi-tenant identity system. See
  DECISIONS.md D11. If you need multi-user access control, this project
  isn't (yet) the right tool.
- **The bearer-token HTTP transport may sit behind a private network or a
  TLS-terminating public tunnel such as ngrok.** Never expose its plaintext
  local port directly. Bearer checks use constant-time digest comparison and
  failed authentication is rate-limited, but the token remains a long-lived
  single-user secret with the full tool permissions enabled for that process.
  Use at least 32 random bytes, start read-only, rotate on disclosure, and see
  `docs/ngrok-remote.md`.
- **Mount-guard is defense in depth, not a backup.** When enabled, indexed
  reads remain available but are marked stale during an outage and all writes
  are blocked until reconciliation. A sentinel greatly reduces false mount
  detection, but backups remain necessary for remote write access.
- **Write tools (`create_note`/`append_to_note`) can create/overwrite
  files anywhere under the vault root.** Path-traversal protection
  (`src/vault/paths.ts`, `toSafeVaultRelPath`/`resolveWithinVault`)
  prevents escaping the vault directory itself, but anything *inside* the
  vault is fair game by design — that's the feature. They're disabled by
  default on the public OAuth connector transport specifically because
  that's the widest-reach deployment target (see DECISIONS.md D15); if
  you enable them there, understand that a compromised OAuth token means
  vault write access.
- **The SQLite index contains your vault's full text content** (for search) —
  treat it with the same sensitivity as the vault itself. Direct processes
  normally use transport-specific files under
  `<vault>/.obsidian-everywhere/`; for a vault under macOS `/Volumes/`, they
  default to a vault-specific file under `~/.obsidian-everywhere/` instead.
  Compose explicitly places its indexes under
  `/vault/.obsidian-everywhere/`. Vault Git refuses hidden
  `.obsidian-everywhere` paths, but Obsidian Everywhere does not edit a user's
  vault `.gitignore`. If an index directory falls inside a repository you also
  use with ordinary Git, add `.obsidian-everywhere/` to that repository's own
  `.gitignore`.
- **Vault Git is a separate opt-in publication boundary.** It is off by
  default on every transport. `read` adds local status/diff/log only; `commit`
  and `push` additionally require the transport's ordinary write gate. Push
  also requires exact operator-pinned
  `remote-name=https://host/path.git` mappings and is restricted to the current
  branch's existing upstream ref. Mapped URLs must be HTTPS with no credentials,
  query, or fragment, and the local remote's sole resolved push URL must equal
  that destination. A compromised bearer/OAuth token can exercise every Git
  capability registered by that process, so do not expose `commit` or `push`
  merely because ordinary note writes are acceptable.

## Vault Git trust boundary

The operator selects one repository with
`OBSIDIAN_EVERYWHERE_GIT_REPO_PATH`, which defaults to `.` and must name a safe
vault-relative real directory. The Git tools operate only when that canonical
directory is also the canonical root of a normal repository with Git metadata
inside its own real `.git` directory. The selected path cannot be supplied by
an MCP caller. Parent repository discovery, linked worktrees, submodule roots,
symlinked repository path components, symlinked or external core metadata,
alternate object stores, and unsafe object/ref/log layouts are rejected by
every Git tool. Commit and push additionally reject shallow history, sparse
checkouts, per-worktree Git configuration, grafts/replacement refs, detached
write targets, and in-progress history operations. Every Git tool also fails
closed while Mount Guard reports the live vault unavailable or reconciling.
The canonical vault, selected repository, and `.git` directory identities are
captured at startup and rechecked before every Git subprocess. A swapped mount,
directory, metadata root, or new symlink is rejected until the operator verifies
the path and restarts the service.

Git tool path inputs and outputs are relative to the selected repository root;
ordinary note and file paths remain relative to the full vault root. Selecting
a subfolder does not narrow the vault content indexed by graph, search, or note
tools.

There is deliberately no raw `git_exec` or arbitrary argument passthrough. Such
a tool would be local code execution exposed over MCP: Git aliases can invoke a
shell; hooks, clean filters, external diff/textconv drivers, SSH configuration,
and credential helpers can execute programs; arbitrary refspecs can overwrite
or delete remote refs. Vault Git exposes fixed commands with fixed flags,
`shell: false`, literal repository-relative paths, bounded output/runtime, disabled
hooks/signing/external diff/textconv/submodules, and no caller-provided URL,
credential, branch, or refspec.

Commit and push are separate preview/execute flows. A preview returns a random
UUID bound to the reviewed branch and `HEAD`; commit additionally binds the
single-line message, selected paths/content, and exact proposed tree, while push
binds the upstream remote/ref, local-tracking OID, and operator-pinned literal
URL. It expires after five minutes, is removed on the first execution attempt,
and is invalidated by state changes. It does not prove that a person approved
the operation: MCP clients and agents must still obtain explicit user
confirmation, and transport authentication remains mandatory. A preview never
creates a commit or contacts a remote.

Commit is restricted to 1–100 exact changed paths whose proposed entries are
regular files, plus explicit deletions. Hidden, excluded, sensitive-looking,
unmerged, symlinked, filtered/LFS, and oversized inputs are blocked; a temporary
index prevents unrelated staged changes from entering the commit. Commit
messages must be one line and pass secret review. Push publishes one reviewed
`HEAD` to its existing upstream through the exact displayed URL.
It uses an exact-OID `--force-with-lease` only as a compare-and-swap guard: a
deleted, advanced, or reset remote ref fails, and unconditional force, tags,
hooks, signing, follow-tags, and submodules remain unavailable. The HTTPS
credential path already configured on the vault machine remains part of the
operator's trusted computing base; tool inputs never carry credentials and
interactive prompts are disabled. Repository-local credential helpers, URL
rewrites, `http.*` settings, and selected-remote proxy settings are refused so
they cannot override pinned TLS transport policy; place trusted requirements in
user or system Git configuration. The remote branch ref comes from Git's
existing upstream mapping rather than the local branch name or a caller-provided
target.

The built-in secret review rejects several common private-key, GitHub, npm, AWS,
and Slack credential patterns. Push review includes outgoing commit messages and
merge results and is capped at 8 MiB per file/blob, 32 MiB in aggregate, 100
outgoing commits, and 200 changed blobs across that history. It is defense in
depth, not a data-loss prevention guarantee: it cannot identify every secret or
every sensitive note. Read every preview and use trusted local Git whenever
Vault Git refuses a legitimate edge case. See
[`docs/git-vault.md`](docs/git-vault.md).

Legitimate reports we *do* want to hear about: path traversal that
escapes the vault despite the checks above, bearer/OAuth token validation
bypasses, PKCE/authorization-code handling bugs that let one client hijack
another's session, configured Git repository-root or hidden-path boundary bypasses,
approval reuse/state-binding failures, push mapping/protocol bypasses,
destination/lease bypasses, credential disclosure, unexpected local command
execution, or anything that reads/writes outside what a given transport's trust
model promises.
