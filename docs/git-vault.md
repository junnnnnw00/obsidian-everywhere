# Using a Git-backed vault

Obsidian Everywhere can inspect and checkpoint a vault that is already managed
with Git. The feature is deliberately narrower than a terminal: it exposes five
fixed MCP tools, adds capabilities one level at a time, and requires a reviewed
preview before either a commit or a push.

This guide covers the security model, setup, normal workflow, remote use, and
the cases that must still be handled with Git locally.

## What Vault Git does

| Tool | Purpose | Side effect |
|---|---|---|
| `git_status` | Show safe selected-repository-relative changes, branch, local upstream, and locally known ahead/behind counts | None; never fetches |
| `git_diff` | Return a bounded patch for safe tracked paths, or an explicitly named untracked path in `head` mode | None |
| `git_log` | Show recent local history, optionally for one safe path | None |
| `git_commit` | Preview, then create one unsigned commit from exact changed paths whose proposed entries are regular files, plus deletions | Updates the current local branch only after approval |
| `git_push` | Preview, then publish the approved current `HEAD` to its existing upstream | Contacts one operator-pinned HTTPS destination only after approval |

It does **not** initialize a repository, synchronize two vaults, download remote
changes, resolve conflicts, or replace a normal Git client. Pull, fetch,
checkout, switch, reset, restore, merge, rebase, cherry-pick, tag,
unconditional force-push, arbitrary refspecs, and remote configuration are
intentionally absent.

## Why there is no `git_exec`

A raw `git_exec(command, args)` tool would look convenient, but it would break
the security boundary of a remotely reachable vault service. Git is not just a
file-format utility:

- an alias may expand to `!` followed by a shell command;
- repository hooks execute programs during commit and push;
- external diff and textconv drivers execute configured helpers;
- clean filters, including Git LFS, execute programs while content is staged;
- SSH transports launch an SSH client and can inherit command configuration;
- credential helpers are executable programs;
- free-form refspecs can delete or replace remote refs.

Passing arbitrary Git arguments to an agent would therefore be a remote-code-
execution primitive, even if a wrapper attempted to reject a few obvious
subcommands. Obsidian Everywhere instead constructs a small set of fixed Git
commands, disables avoidable execution hooks, validates every caller-supplied
path, and never accepts a command, URL, refspec, hook, filter, or credential as
tool input.

Push necessarily uses the HTTPS credential path already configured for Git on
the vault machine. Enable push only if you trust that machine's system and
global Git configuration. The MCP tools disable interactive prompting, never
accept credentials as tool input, and display the exact credential-free HTTPS
destination during preview.

## Repository requirements

Install Git on the machine where Obsidian Everywhere runs. Vault Git selects one
repository directory through the operator-only
`OBSIDIAN_EVERYWHERE_GIT_REPO_PATH` startup setting. It defaults to `.` and must
be either `.` or a safe forward-slash, vault-relative directory path. An MCP
call cannot change it.

If the whole vault is one repository, verify it from a local terminal:

```bash
git --version
git -C "/absolute/path/to/vault" rev-parse --show-toplevel
git -C "/absolute/path/to/vault" status
```

If only one folder inside the vault is a repository, point the local checks and
the service at that folder instead. For example, keep the complete vault at
`/Volumes/SanDisk/jwhong` indexed while selecting its `DSLab` repository:

```bash
export OBSIDIAN_VAULT_PATH=/Volumes/SanDisk/jwhong
export OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=DSLab
git -C "/Volumes/SanDisk/jwhong/DSLab" rev-parse --show-toplevel
git -C "/Volumes/SanDisk/jwhong/DSLab" status
```

The path printed by `--show-toplevel` must be the configured repository path
itself. Every Git tool requires:

- a normal non-bare repository;
- a real `.git` directory immediately under the configured repository root;
- Git's canonical Git and common directories inside that `.git` directory;
- a non-symlinked `.git/objects` layout inside that metadata directory;
- no alternate object store;
- protected ref/log trees without symlinks or hard links, and regular internal
  `HEAD`, `config`, `index`, and `packed-refs` files when present.

Commit and push additionally require:

- an attached local branch;
- no unmerged index entries anywhere in the repository;
- no merge, rebase, cherry-pick, revert, or bisect in progress;
- no shallow history, sparse checkout, per-worktree configuration, graft, or
  replacement ref.

A selected folder discovered only through a parent repository is refused
because a commit or push could otherwise include history outside the configured
boundary. The repository path itself must consist of real directories inside
the vault; symlink paths are refused. Linked worktrees, submodule roots, `.git`
files, and unsafe external or symlinked object/ref/log/core metadata layouts are
also refused. Use Git locally for those layouts.

Git tool paths are relative to the configured repository root. With
`OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=DSLab`, for example, `README.md` means
`/Volumes/SanDisk/jwhong/DSLab/README.md`, not a vault-root `README.md`.
Ordinary note, graph, search, and file tool paths remain relative to the full
vault root, and the full vault remains indexed.

Before using `git_commit`, configure the author identity locally. Obsidian
Everywhere never invents or accepts an author identity through MCP:

```bash
git -C "/absolute/path/to/configured/repository" config user.name "Your Name"
git -C "/absolute/path/to/configured/repository" config user.email "you@example.com"
```

## Capability modes

Git is off on every transport unless the operator explicitly enables it:

```text
OBSIDIAN_EVERYWHERE_GIT_MODE=off|read|commit|push
```

| Mode | Registered Git tools |
|---|---|
| `off` | none |
| `read` | `git_status`, `git_diff`, `git_log` |
| `commit` | read tools, plus `git_commit` when ordinary writes are enabled |
| `push` | read and commit tools, plus `git_push` when ordinary writes are enabled |

The default is `off`. An unknown value fails fast at startup rather than being
silently interpreted.

Repository selection is independent of capability selection:

```text
OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=.       # default: repository at vault root
OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=DSLab   # one repository folder in the vault
```

The setting is operator configuration, not MCP input. Absolute paths,
backslashes, empty segments, `.`/`..` traversal segments, nonexistent paths,
files, and symlinked path components fail closed at startup.

The normal write gate is a second, independent requirement:

- stdio and bearer HTTP register ordinary writes by default;
  `OBSIDIAN_EVERYWHERE_READONLY=true` removes `git_commit` and `git_push` too;
- OAuth is read-only by default, so commit or push requires both a sufficient
  Git mode and `OAUTH_ENABLE_WRITE_TOOLS=true`;
- the three Git read tools remain available in any mode above `off`, even when
  the normal write gate is disabled.

This prevents enabling ordinary note edits from accidentally enabling Git, and
prevents selecting a higher Git mode from bypassing a transport's read-only
policy.

Git tools and repository root are selected when the server starts, so restart
the process and reconnect the MCP client after changing a Git environment
variable.

At startup the service captures the canonical vault, selected repository, and
`.git` directory identities. It rechecks their real paths, directory type, and
filesystem identity before every Git subprocess. If a mount or selected
directory is replaced—or a symlink appears—Git tools fail closed until you
verify the path and restart the service.

The examples below use POSIX shell syntax. In PowerShell, the equivalent form
is:

```powershell
$env:OBSIDIAN_EVERYWHERE_GIT_MODE = "read"
$env:OBSIDIAN_EVERYWHERE_GIT_REPO_PATH = "DSLab"
npx -y obsidian-everywhere "C:\Users\you\Vault"
```

For a service manager, container, or MCP client configuration, set the same
variables in that process's environment rather than relying on an interactive
shell profile.

The supplied Docker Compose file intentionally gives its two services separate
host-side `.env` inputs and maps them to the generic process variables inside
each container:

| Compose service | Mode input | Repository-path input | Push-mapping input |
|---|---|---|---|
| Bearer HTTP (`obsidian-everywhere`) | `OBSIDIAN_EVERYWHERE_HTTP_GIT_MODE` | `OBSIDIAN_EVERYWHERE_HTTP_GIT_REPO_PATH` | `OBSIDIAN_EVERYWHERE_HTTP_GIT_ALLOWED_PUSH_REMOTES` |
| OAuth (`obsidian-everywhere-oauth`) | `OBSIDIAN_EVERYWHERE_OAUTH_GIT_MODE` | `OBSIDIAN_EVERYWHERE_OAUTH_GIT_REPO_PATH` | `OBSIDIAN_EVERYWHERE_OAUTH_GIT_ALLOWED_PUSH_REMOTES` |

Both Compose modes default independently to `off`, and both repository paths to
`.`. Use the generic names for a direct CLI/HTTP/OAuth process or LaunchAgent,
but use the service-specific names in the supplied Compose `.env`; setting only
the bearer inputs never changes the OAuth service's Git boundary.

For the `/Volumes/SanDisk/jwhong` and `DSLab` example, a bearer Compose `.env`
contains:

```dotenv
OBSIDIAN_VAULT_HOST_PATH=/Volumes/SanDisk/jwhong
OBSIDIAN_EVERYWHERE_HTTP_GIT_MODE=read
OBSIDIAN_EVERYWHERE_HTTP_GIT_REPO_PATH=DSLab
```

## Start with read-only Git inspection

Use `read` first, even if you ultimately want commit or push.

### Local stdio

Set the environment in the MCP server configuration or in the process that
starts it:

```bash
OBSIDIAN_EVERYWHERE_GIT_MODE=read \
  OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=. \
  npx -y obsidian-everywhere "/absolute/path/to/vault"
```

For a client configuration, add the environment variable using that client's
normal MCP environment field. Do not put credentials in the MCP arguments.

### Bearer HTTP / Remote Vault Bridge

The safest first remote run keeps ordinary writes disabled too:

```bash
export OBSIDIAN_VAULT_PATH="/absolute/path/to/vault"
export OBSIDIAN_EVERYWHERE_TOKEN="<random-bearer-token>"
export OBSIDIAN_EVERYWHERE_READONLY=true
export OBSIDIAN_EVERYWHERE_GIT_MODE=read
export OBSIDIAN_EVERYWHERE_GIT_REPO_PATH=.
export OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true
export OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=".obsidian/app.json"

npx -y --package obsidian-everywhere obsidian-everywhere-http
```

Follow the complete tunnel and authentication setup in
[Remote Vault Bridge with ngrok](ngrok-remote.md). A bearer token grants every
tool registered by that process, including Git reads, so rotate it if exposed.

### OAuth connector

Set `OBSIDIAN_EVERYWHERE_GIT_MODE=read` on the OAuth HTTP process. Do not set
`OAUTH_ENABLE_WRITE_TOOLS` during the initial check. After authentication, only
the three Git read tools are added.

### Verify the repository identity

Ask the connected client to call:

```text
git_status {}
git_log { "limit": 5 }
git_diff { "mode": "head", "contextLines": 3, "maxBytes": 65536 }
```

Confirm that:

- the branch and short `HEAD` match local Git;
- every displayed path is relative to the selected repository root;
- the local upstream name and ahead/behind counts look plausible;
- hidden, excluded, or sensitive changes are counted but never named;
- the diff is limited to the files and content you expected.

`git_status` and `git_log` never fetch. Ahead/behind information is based on the
existing local tracking reference and can be stale. With no explicit path,
`git_diff` omits untracked content. To review a new file, use `mode: "head"` and
name that exact untracked path explicitly; staged and unstaged modes do not
invent a baseline for it.

### Read-tool input reference

All Git tool paths are exact selected-repository-relative paths with forward
slashes. Globs, directories, absolute paths, traversal, pathspec magic, and
hidden or sensitive paths are rejected. This does not change the vault-relative
path convention used by ordinary note and file tools.

| Tool | Inputs |
|---|---|
| `git_status` | `includeUntracked` defaults to `true`; `limit` defaults to 100 and is capped at 500 safe changes |
| `git_diff` | `mode` is `head` (default), `staged`, or `unstaged`; `paths` is an optional list of at most 50 exact changed files; an explicit untracked path is readable only in `head` mode; `contextLines` is 0–20; `maxBytes` is 1–256 KiB and defaults to 64 KiB |
| `git_log` | `limit` defaults to 10 and is capped at 50; `path` optionally names one currently tracked safe file |

`head` compares the combined index and working tree with `HEAD`; `staged`
compares the index with `HEAD`; `unstaged` compares the working tree with the
index. With no explicit `paths`, `git_diff` considers at most 200 safe tracked
changed paths and reports when more were omitted.

## Commit workflow

Restart the MCP server with commit mode. For stdio or bearer HTTP, make sure
`OBSIDIAN_EVERYWHERE_READONLY` is unset or false:

```bash
export OBSIDIAN_EVERYWHERE_GIT_MODE=commit
unset OBSIDIAN_EVERYWHERE_READONLY
```

For OAuth, also opt into ordinary writes:

```bash
export OBSIDIAN_EVERYWHERE_GIT_MODE=commit
export OAUTH_ENABLE_WRITE_TOOLS=true
```

Then follow this order:

1. Call `git_status`.
2. Call `git_diff` for the exact files you plan to include, using explicit
   `mode: "head"` paths for new files.
3. Ask for a commit preview with a single-line message and an explicit
   changed-file list.
4. Read the returned branch, `HEAD`, message, proposed tree OID, and selected
   paths.
5. Confirm the commit explicitly.
6. Execute with only the returned approval ID.

Example preview:

```json
{
  "action": "preview",
  "message": "docs: connect Atlas research notes",
  "paths": ["Projects/Atlas.md", "Research/Graph Retrieval.md"]
}
```

The message must be one line, no more than 4,000 characters, and passes the same
bounded secret-pattern review as selected content. The `git_commit` preview
returns the proposed tree and a UUID and states that no commit was created.
After explicit user confirmation, execute:

```json
{
  "action": "execute",
  "approvalId": "<UUID returned by preview>"
}
```

The approval ID:

- expires after five minutes;
- is deleted on its first execution attempt, whether that attempt succeeds or
  fails;
- is tied to the branch, `HEAD`, single-line message, selected and rename paths,
  selected content, and the exact proposed Git tree reviewed during preview;
- becomes invalid when that state changes;
- lives only in the current server/MCP session and does not survive a restart or
  a new MCP session.

The proposed tree is built with a temporary index so unrelated staged changes
are not included. Execution rebuilds that tree and refuses a mismatch before
creating the commit. New files, deletions, and renames are supported when their
exact safe status paths are selected. The operation updates the current branch
atomically against the reviewed old `HEAD`; it does not amend, sign, push, or
run hooks.

### Commit limits

Vault Git accepts 1–100 explicit changed paths whose proposed entries are regular
files, plus explicit deletions. It refuses:

- a multiline, over-4,000-character, or secret-looking commit message;
- any unresolved unmerged index entry, even outside the selected paths;
- a directory, symlink, duplicate path, path glob, pathspec
  magic, absolute path, or traversal segment;
- every hidden path segment, including `.obsidian`, `.git`, `.trash`, and
  `.obsidian-everywhere`;
- excluded directories such as `node_modules` and atomic temporary files;
- likely credential/key/token filenames and common private-key extensions;
- a selected file larger than 8 MiB or selected content over 32 MiB total;
- configured clean filters, including Git LFS;
- content matching the bounded built-in private-key, GitHub, npm, AWS, or Slack
  credential patterns.

The secret check is defense in depth, not a guarantee. It cannot recognize every
credential format or sensitive sentence in a note. Review the diff and repository
state yourself; use Git locally when the automatic review refuses a legitimate
large, filtered, hidden, or otherwise unsupported change.

## Prepare push safely

Push mode is for publishing commits that already exist on the current branch. It
does not create an upstream or accept a destination through MCP. Configure the
branch-to-upstream mapping locally first:

```bash
git -C "/absolute/path/to/configured/repository" remote -v
git -C "/absolute/path/to/configured/repository" branch -vv
git -C "/absolute/path/to/configured/repository" push --set-upstream origin main
```

The operator must then pin that upstream remote name to one exact push
destination. Each mapping entry has the form
`name=https://host/path/repository.git`. It must:

- name the current branch's existing upstream remote on the left of `=`;
- provide one literal `https://` URL on the right;
- exactly match that repository remote's sole resolved push URL;
- have no embedded username, password, query string, or fragment;
- authenticate non-interactively using the vault machine's existing trusted Git
  configuration.

Production rejects SSH, HTTP, `git://`, `file://`, local paths, custom remote
helpers, multiple push URLs, and credential-bearing mapped URLs. The ordinary
fetch URL may differ only when the remote's separately configured sole push URL
is the exact pinned HTTPS destination. Do not put a personal access token in the
mapping. Configure an operating-system credential manager or another
non-interactive HTTPS credential path locally before delegating a push preview
to an agent.

Repository-local credential helpers, URL rewrites, all `http.*` settings, and
the selected remote's proxy settings are rejected for both preview and execute.
URL-specific Git settings can otherwise outrank generic TLS and redirect
controls. Put any trusted HTTPS credentials, CA, or proxy policy in the vault
machine's user or system Git configuration, not in the repository.

Enable push and provide the exact comma-separated mappings:

```bash
export OBSIDIAN_EVERYWHERE_GIT_MODE=push
export OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES=origin=https://github.com/owner/repository.git
```

For more than one independently trusted destination:

```bash
export OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES=origin=https://github.com/owner/repository.git,backup=https://git.example.com/owner/repository.git
```

This does not let the caller choose between arbitrary destinations. The current
branch's existing upstream remote name selects its one operator-pinned mapping,
and the upstream's configured remote branch selects the destination ref.

## Push workflow

1. Call `git_status` and `git_log` to verify the current branch and `HEAD`.
2. Call `git_push` with `action: "preview"`.
3. Review the exact `HEAD`, remote/ref, credential-free HTTPS destination, and
   outgoing commit count.
4. Confirm the push explicitly.
5. Execute with only the returned approval ID.

Preview:

```json
{ "action": "preview" }
```

Execute:

```json
{
  "action": "execute",
  "approvalId": "<UUID returned by preview>"
}
```

The preview does not contact the network. Before issuing an approval it checks
the locally known upstream, requires the branch not to be behind that tracking
reference, and scans the outgoing history. The scan is bounded to 100 commits,
200 changed blobs, 8 MiB per blob, and 32 MiB total. Hidden/sensitive paths, Git
LFS pointer blobs, non-file objects, and recognized secret patterns block the
push. Outgoing commit messages and merge results are included in the review so a
secret hidden in a message or introduced by a merge cannot bypass the scan.
Each outgoing commit message is capped at 64 KiB for review; a larger one fails
closed and must be pushed locally after inspection.

Execution repeats the complete review and requires the branch, `HEAD`, exact
upstream remote branch, reviewed local-tracking OID, remote name, and literal
operator-pinned URL to match the preview. It pushes that exact commit to the
configured upstream branch—even when its name differs from the local branch—by
using the displayed URL directly.

Execution supplies an exact
`--force-with-lease=<upstream-ref>:<reviewed-local-tracking-oid>` compare-and-swap
guard. Despite Git's option name, this is not an arbitrary force-push: the local
branch must not be behind or divergent, and a deleted, advanced, or reset remote
ref fails the lease. Unconditional force, tags,
submodules, signing, hooks, follow-tags, automatic retry, and caller-provided
refspecs are unavailable. Fetch and reconcile locally after any rejection.

## Mount Guard and remote Git

Every Git tool reads the live repository rather than the persistent note index.
When Mount Guard reports the vault as unavailable or reconciling, Git status,
diff, log, commit, and push all fail closed. This prevents an auto-started remote
service from operating on an empty fallback mount point.

For removable drives, NAS shares, and bind mounts, enable:

```bash
export OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true
export OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL=.obsidian/app.json
```

Use another existing identity file if `.obsidian/app.json` is not present. The
sentinel may be hidden from Git tools and still serve its Mount Guard purpose.

## Git is not vault synchronization

`git_commit` creates local history. `git_push` publishes only outgoing history.
Neither command pulls changes onto another machine, and neither resolves edits
made concurrently on two hosts. Continue using your existing, locally managed
pull/sync procedure. When changed files arrive on disk, Obsidian Everywhere's
watcher updates the index and graph; a process restart performs a full
mtime/hash-gated reconciliation.

Do not expose Git commit/push from two always-on hosts against the same working
copy or branch and assume that this makes the workflow conflict-free. Choose one
authoritative vault machine for remote Git writes.

## Troubleshooting

| Symptom | Explanation and safe next step |
|---|---|
| Git tools are absent | `OBSIDIAN_EVERYWHERE_GIT_MODE` is unset/`off`, or the server was not restarted after changing it |
| Only status/diff/log appear | The mode is `read`, or the transport's ordinary write gate is off |
| `push` mode fails during startup | `OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES` is empty or an entry is not a valid exact `name=https://host/path.git` mapping |
| “Git executable was not found” | Install Git in the host/container runtime and ensure the service process—not only your interactive shell—has it on `PATH` |
| Configured repository path is refused | `OBSIDIAN_EVERYWHERE_GIT_REPO_PATH` is absolute, traverses, does not exist, is not a directory, or contains a symlink; select one real vault-relative directory and restart |
| “missing .git directory” / root mismatch | The configured folder is not itself the exact repository root; parent discovery and linked worktrees are unsupported |
| Git metadata layout is refused | A protected `.git` path is external, symlinked, hard-linked, or too large to verify safely; inspect it locally and use normal Git rather than bypassing the check |
| Git reads are blocked during mount loss | Restore the intended mount and wait for `vault_status` to report a completed reconciliation |
| A path is omitted or blocked | It is hidden, excluded, sensitive-looking, non-regular, unmerged, or unsafe; inspect and handle it locally |
| Commit approval expired or changed | Run status/diff and preview again; approvals are intentionally one-use and state-bound |
| Commit is refused for LFS/filter content | Clean filters and hooks are executable; use your trusted local Git/LFS workflow |
| Push says the branch has no upstream | Configure and test the upstream locally; the MCP tool never creates one |
| Push remote is not mapped | Add an exact `upstream-name=credential-free-https-url` operator mapping and restart; the MCP caller cannot supply it |
| Push destination must use HTTPS | Replace the operator mapping with a credential-free HTTPS URL, or keep pushing locally |
| Branch is behind, divergent, or the exact lease fails | Fetch, inspect, merge/rebase, and resolve local or remote changes; then preview again |
| Outgoing review limit is exceeded | More than 100 commits, 200 changed blobs, an 8 MiB blob, or 32 MiB total requires a reviewed local push |
| Secret review blocks a legitimate file | Inspect the file locally and use local Git if you intentionally accept the risk; there is no remote bypass flag |

## Operational checklist

Before enabling `commit`:

- [ ] `OBSIDIAN_EVERYWHERE_GIT_REPO_PATH` selects the exact repository root (`.`
      for a whole-vault repository, or one real vault-relative folder).
- [ ] Git tool paths are understood to be repository-relative; ordinary tool
      paths remain vault-relative.
- [ ] Git author identity is configured locally.
- [ ] `git_status`, `git_diff`, and `git_log` match local Git.
- [ ] Mount Guard is enabled for a removable/network/container vault.
- [ ] You understand which hidden and filtered paths require local Git.

Before enabling `push`:

- [ ] One authoritative vault machine is responsible for remote pushes.
- [ ] The current branch already tracks the intended remote branch.
- [ ] Its upstream remote name has one exact credential-free HTTPS mapping.
- [ ] Non-interactive HTTPS credentials work locally.
- [ ] Preview displays the exact destination URL and upstream ref you expect.
- [ ] The MCP transport uses strong authentication and the bearer/OAuth secret is
      protected.
- [ ] You will read every preview before approving it.

Report any path-boundary, approval-bypass, destination-mapping bypass,
credential leak, or unexpected local-code-execution behavior through the
private process in
[`SECURITY.md`](../SECURITY.md), not a public issue.
