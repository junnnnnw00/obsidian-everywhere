# Five beta testers wanted: use your local Obsidian vault from a remote agent

Obsidian Everywhere v0.7.0 introduces the Remote Vault Bridge: Claude Code,
Codex, or another MCP client can run on a different machine while your Obsidian
vault remains on the computer you control.

The remote agent can search by meaning, follow the note graph, build a
token-budgeted context bundle, and — if you explicitly enable it — use guarded
write tools. Mount Guard is also available as an opt-in Beta for removable
drives, NAS shares, and container mounts.

[Watch the 44-second workflow](https://github.com/junnnnnw00/obsidian-everywhere/blob/main/assets/remote-vault-bridge-demo.mp4).

I am looking for **five people** who can spend about **20–30 minutes** testing a
real setup. A small disposable vault is welcome; no private note contents need
to be shared.

Useful environments include:

- a remote Claude Code, Codex, or other Streamable HTTP MCP client
- macOS, Linux, Windows, or WSL
- internal, removable, NAS, or container-mounted vaults
- ngrok, Cloudflare Tunnel, Tailscale, or another secure connection path

The recommended test starts read-only: connect, check `vault_status`, confirm
the vault identity and counts, then try `semantic_search` and
`get_context_bundle`. Writes and mount-loss testing are optional.

If you would like to help, reply with your OS, vault location, MCP client,
connection method, and the parts you want to test. Please never post access
tokens, tunnel credentials, private hostnames, or note contents.

Setup guide:
[Remote Vault Bridge with ngrok](https://github.com/junnnnnw00/obsidian-everywhere/blob/main/docs/ngrok-remote.md)

Thank you — the goal of this round is not a vanity user count. It is to find the
first real-world assumption that breaks outside the maintainer's machine.
