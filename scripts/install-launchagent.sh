#!/usr/bin/env bash
# Installs the static-bearer-token HTTP transport as a macOS LaunchAgent,
# so it starts at login and stays running (Host 1 in docs/architecture.md's
# topology). This is the "remote Claude Code over Tailscale" service, NOT
# the OAuth/claude.ai one — see docs/deploy.md.
#
# Usage:
#   OBSIDIAN_VAULT_PATH=/path/to/vault \
#   OBSIDIAN_EVERYWHERE_TOKEN=$(openssl rand -hex 32) \
#   ./scripts/install-launchagent.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_LABEL="com.obsidian-everywhere.http"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

: "${OBSIDIAN_VAULT_PATH:?Set OBSIDIAN_VAULT_PATH to your vault's absolute path}"
: "${OBSIDIAN_EVERYWHERE_TOKEN:?Set OBSIDIAN_EVERYWHERE_TOKEN to a secret bearer token (e.g. \$(openssl rand -hex 32))}"

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH. Install Node.js first." >&2
  exit 1
fi

echo "Building project..."
cd "$INSTALL_DIR"
npm run build

mkdir -p "$INSTALL_DIR/logs"

echo "Writing $PLIST_DEST"
sed \
  -e "s#__NODE_BIN__#${NODE_BIN}#g" \
  -e "s#__INSTALL_DIR__#${INSTALL_DIR}#g" \
  -e "s#__VAULT_PATH__#${OBSIDIAN_VAULT_PATH}#g" \
  -e "s#__TOKEN__#${OBSIDIAN_EVERYWHERE_TOKEN}#g" \
  "$SCRIPT_DIR/../deploy/com.obsidian-everywhere.http.plist.template" > "$PLIST_DEST"

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/${PLIST_LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST_DEST"
launchctl enable "gui/${UID_NUM}/${PLIST_LABEL}"

echo "Installed and started. Check status with:"
echo "  launchctl print gui/${UID_NUM}/${PLIST_LABEL}"
echo "Logs: $INSTALL_DIR/logs/http.out.log / http.err.log"
echo "Health check: curl http://127.0.0.1:3737/healthz"
