# Week 2 outreach drafts

These are ready-to-edit drafts, not scheduled posts. Post only after v0.7.0 is
live and the video, npm package, and registry entry have been verified.

## 1. Obsidian Forum — Share & showcase / Workflows & Templates

The `Share & showcase` root is read-only. Post this headless companion workflow
under `Workflows & Templates`, keep future project updates in the same thread,
and retain the required disclaimer at the top.

**Title**

Obsidian Everywhere v0.7: graph + local semantic context for remote AI agents

**Body**

## Disclaimer

Is this project **open source**? Yes

Is this project completely **free**? Yes

Does this project use AI beyond the author's ability to comprehend how it works?
No

---

I built an open-source MCP server for a workflow I could not find elsewhere:
let an AI agent running on another machine use my local Obsidian vault as
structured context, without uploading the vault to a hosted knowledge service.
It is a headless companion utility rather than an Obsidian Community plugin, so
Obsidian does not need to stay open.

Obsidian Everywhere treats the vault as both a note graph and a semantic
knowledge base. An MCP client can search by meaning, inspect backlinks and
neighborhoods, find paths between notes, and build a token-budgeted context
bundle around one topic. The embedding model and SQLite index run locally.

v0.7 adds the Remote Vault Bridge as a first-class setup. Claude Code, Codex, or
another Streamable HTTP MCP client can connect through ngrok, Cloudflare Tunnel,
Tailscale, or another secure route while the Markdown files remain on the
machine you control. Read-only mode is available, and guarded write tools can be
enabled for creating, appending, moving, tagging, and bulk editing notes.

Here is a 44-second product-research example:

https://github.com/junnnnnw00/obsidian-everywhere#watch-the-remote-vault-bridge-in-44-seconds

The video shows a remote agent finding Project Lumen's onboarding evidence
through semantic and graph context, appending an interview finding, blocking a
write when the vault drive disappears, and reconciling when it returns.

You can also try the sample vault without touching your notes:

`npx -y obsidian-everywhere demo`

The mount-loss protection is still Beta. I am looking for five testers across
macOS, Linux, Windows/WSL, removable drives, NAS shares, and container mounts.
A small disposable vault is enough, and no note contents need to be shared.

Repository:
https://github.com/junnnnnw00/obsidian-everywhere

Join the five-environment Beta:
https://github.com/junnnnnw00/obsidian-everywhere/issues/18

Read-only-first ngrok tutorial:
https://github.com/junnnnnw00/obsidian-everywhere/blob/main/docs/ngrok-remote.md

I would especially value feedback on one question: what is the first step that
feels confusing or unsafe in your environment?

## 2. Obsidian Discord — short version

I just released Obsidian Everywhere v0.7, an open-source MCP server that turns a
local Obsidian vault into graph + semantic context for AI agents.

The new Remote Vault Bridge lets Claude Code, Codex, or another MCP client run
on a different machine while the vault stays local. It supports read-only
access, guarded edits, and Beta mount-loss protection for removable/NAS/
container vaults.

44-second demo:
https://github.com/junnnnnw00/obsidian-everywhere#watch-the-remote-vault-bridge-in-44-seconds

Repo + setup:
https://github.com/junnnnnw00/obsidian-everywhere

Join the Beta:
https://github.com/junnnnnw00/obsidian-everywhere/issues/18

I am looking for five real-world testers. A disposable vault is fine; no note
contents need to be shared. I would love to hear which setup step feels least
clear.

## 3. MCP community — technical version

Obsidian Everywhere v0.7 is now available on npm and the official MCP Registry.
It exposes an Obsidian vault through stdio, bearer-authenticated Streamable HTTP,
or OAuth HTTP.

The core retrieval path combines local multilingual embeddings with a parsed
wikilink/backlink/tag graph. `get_context_bundle` packs a center note and
prioritized neighbors to a caller-provided token budget. The same server
provides explicit partial writes, dry-run bulk changes, rollback snapshots, and
immediate reindexing.

v0.7's Remote Vault Bridge focuses on external clients: the MCP process stays
beside the local vault while Claude Code, Codex, or another client connects
through a private network or HTTPS tunnel. Bearer authentication uses
constant-time comparison and failed attempts are rate-limited.

Mount Guard is an opt-in Beta for removable, network, and container mounts. A
missing mount preserves the existing index, marks reads as stale, blocks writes,
and triggers full reconciliation before writes reopen.

Demo:
https://github.com/junnnnnw00/obsidian-everywhere#watch-the-remote-vault-bridge-in-44-seconds

Source:
https://github.com/junnnnnw00/obsidian-everywhere

Beta tracker:
https://github.com/junnnnnw00/obsidian-everywhere/issues/18

I am looking for five compatibility testers, particularly for:

- Streamable HTTP clients outside Claude Code and Codex
- Windows/WSL path and mount behavior
- NAS reconnects
- container volume replacement
- ngrok, Cloudflare Tunnel, and private-network deployments

If you test it, a report containing OS, runtime, transport, mount type, and the
first failed or confusing step is more useful than a generic success message.
No vault content or secrets are needed.

## Suggested sequence

1. Publish the GitHub release and verify npm plus the official MCP Registry.
2. Open the repository Discussion and update the Beta issue.
3. Post to the Obsidian Forum; stay available to answer setup questions that day.
4. Share the shorter Discord version after the Forum post has at least one
   concrete answer or documentation improvement to link back to.
5. Share the technical MCP version last, with any compatibility findings already
   incorporated.

Avoid cross-posting all three at once. The first useful reply should become a
documentation fix or a tracked compatibility result, so later posts demonstrate
an active feedback loop instead of repeating the same announcement.
