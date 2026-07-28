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
- **The SQLite index (`.obsidian-everywhere/index.db`) contains your
  vault's full text content** (for search) — treat it with the same
  sensitivity as the vault itself. It's excluded from git by default
  (`.gitignore`).

Legitimate reports we *do* want to hear about: path traversal that
escapes the vault despite the checks above, bearer/OAuth token validation
bypasses, PKCE/authorization-code handling bugs that let one client hijack
another's session, or anything that reads/writes outside what a given
transport's trust model promises.
