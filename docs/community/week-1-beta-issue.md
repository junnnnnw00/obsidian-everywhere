We are looking for **five people** to test Obsidian Everywhere v0.7.0 against a
real vault and a remote MCP client.

The main question is simple: can an agent running somewhere else reliably use
your local Obsidian vault as graph and semantic context — and, if you choose,
make a guarded edit — without turning the vault into a hosted copy?

## Good fit

You use Obsidian and have at least one of these setups:

- Claude Code, Codex, or another MCP client running on a remote server
- a vault on a removable drive
- a vault on a NAS or network share
- a vault mounted into a container

macOS, Linux, and Windows/WSL reports are all useful. A small test vault is
completely fine.

## What to test

1. Connect read-only through ngrok, Cloudflare Tunnel, Tailscale, or another
   HTTPS/private-network path.
2. Confirm `vault_status`, note counts, and vault identity from the remote
   client.
3. Ask a real question using `semantic_search` and `get_context_bundle`.
4. Optionally enable writes and append to a disposable test note.
5. If your vault is mounted, optionally enable Mount Guard (Beta), disconnect
   the mount, and confirm that the index is preserved and writes are blocked
   until reconciliation finishes.

The expected time is **20–30 minutes**. The
[ngrok Remote Vault Bridge tutorial](https://github.com/junnnnnw00/obsidian-everywhere/blob/main/docs/ngrok-remote.md)
includes the complete read-only-first setup.

## How to join

Comment with:

- operating system
- vault location (internal disk, removable drive, NAS, container, etc.)
- remote MCP client
- connection method
- whether you plan to test read-only access, writes, or Mount Guard

Please do **not** post note contents, access tokens, tunnel credentials, or
private hostnames. `obsidian-everywhere doctor --share` is designed to provide
privacy-safe diagnostics if something fails.

Questions and setup discussion are welcome in
[Discussion #19](https://github.com/junnnnnw00/obsidian-everywhere/discussions/19).

In return, you will get direct setup help and your environment will shape the
Beta exit criteria and documentation. Reproducible reports and documentation
corrections are just as valuable as code.

## Done when

This Beta round is complete when five distinct environments have reported:

- remote connection and vault identity
- graph or semantic context retrieval
- write behavior, if enabled
- mount-loss behavior, if applicable
- the first confusing or fragile step in the setup

Thank you for helping make remote, local-first vault access dependable beyond
the maintainer's own machine.
