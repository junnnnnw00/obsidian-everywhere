#!/usr/bin/env bash
# Installs the static-bearer-token HTTP transport as a macOS LaunchAgent,
# so it starts at login and stays running (Host 1 in docs/architecture.md's
# topology). This is the single-user Remote Vault Bridge service for a
# private network or TLS-terminating tunnel, NOT the OAuth/claude.ai one —
# see docs/deploy.md and docs/ngrok-remote.md.
#
# Usage:
#   OBSIDIAN_VAULT_PATH=/path/to/vault \
#   OBSIDIAN_EVERYWHERE_TOKEN=$(openssl rand -hex 32) \
#   OBSIDIAN_EVERYWHERE_MOUNT_GUARD=true \
#   ./scripts/install-launchagent.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_LABEL="com.obsidian-everywhere.http"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

: "${OBSIDIAN_VAULT_PATH:?Set OBSIDIAN_VAULT_PATH to the absolute path of your vault}"
: "${OBSIDIAN_EVERYWHERE_TOKEN:?Set OBSIDIAN_EVERYWHERE_TOKEN to a secret bearer token, e.g. via openssl rand -hex 32}"

NODE_BIN="$(command -v node || true)"
PORT_VALUE="${PORT:-3737}"
READONLY="${OBSIDIAN_EVERYWHERE_READONLY:-false}"
MOUNT_GUARD="${OBSIDIAN_EVERYWHERE_MOUNT_GUARD:-false}"
MOUNT_SENTINEL="${OBSIDIAN_EVERYWHERE_MOUNT_SENTINEL:-.obsidian/app.json}"
GIT_MODE="${OBSIDIAN_EVERYWHERE_GIT_MODE:-off}"
GIT_REPO_PATH="${OBSIDIAN_EVERYWHERE_GIT_REPO_PATH-.}"
GIT_PUSH_REMOTES="${OBSIDIAN_EVERYWHERE_GIT_ALLOWED_PUSH_REMOTES:-}"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH. Install Node.js first." >&2
  exit 1
fi
if ! [[ "$PORT_VALUE" =~ ^[0-9]+$ ]] || [ "$PORT_VALUE" -lt 1 ] || [ "$PORT_VALUE" -gt 65535 ]; then
  echo "PORT must be an integer from 1 to 65535." >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
NPM_BIN="$NODE_DIR/npm"
if [ ! -x "$NPM_BIN" ]; then
  NPM_BIN="$(command -v npm || true)"
fi
if [ -z "$NPM_BIN" ]; then
  echo "npm not found on PATH. Install npm for the selected Node.js runtime." >&2
  exit 1
fi

echo "Rebuilding native dependencies for $("$NODE_BIN" --version)..."
cd "$INSTALL_DIR"
PATH="$NODE_DIR:$PATH" "$NPM_BIN" rebuild better-sqlite3
echo "Building project..."
PATH="$NODE_DIR:$PATH" "$NPM_BIN" run build
"$NODE_BIN" -e "require('better-sqlite3');"

mkdir -p "$INSTALL_DIR/logs"
mkdir -p "$(dirname "$PLIST_DEST")"

echo "Writing $PLIST_DEST"
export OE_LA_NODE_BIN="$NODE_BIN"
export OE_LA_INSTALL_DIR="$INSTALL_DIR"
export OE_LA_PORT="$PORT_VALUE"
export OE_LA_READONLY="$READONLY"
export OE_LA_MOUNT_GUARD="$MOUNT_GUARD"
export OE_LA_MOUNT_SENTINEL="$MOUNT_SENTINEL"
export OE_LA_GIT_MODE="$GIT_MODE"
export OE_LA_GIT_REPO_PATH="$GIT_REPO_PATH"
export OE_LA_GIT_PUSH_REMOTES="$GIT_PUSH_REMOTES"
"$NODE_BIN" --input-type=module - \
  "$SCRIPT_DIR/../deploy/com.obsidian-everywhere.http.plist.template" \
  "$PLIST_DEST" <<'NODE'
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

const [templatePath, destinationPath] = process.argv.slice(2);
if (!templatePath || !destinationPath) {
  throw new Error("LaunchAgent renderer requires template and destination paths.");
}

const substitutions = {
  __NODE_BIN__: process.env.OE_LA_NODE_BIN,
  __INSTALL_DIR__: process.env.OE_LA_INSTALL_DIR,
  __VAULT_PATH__: process.env.OBSIDIAN_VAULT_PATH,
  __TOKEN__: process.env.OBSIDIAN_EVERYWHERE_TOKEN,
  __PORT__: process.env.OE_LA_PORT,
  __READONLY__: process.env.OE_LA_READONLY,
  __MOUNT_GUARD__: process.env.OE_LA_MOUNT_GUARD,
  __MOUNT_SENTINEL__: process.env.OE_LA_MOUNT_SENTINEL,
  __GIT_MODE__: process.env.OE_LA_GIT_MODE,
  __GIT_REPO_PATH__: process.env.OE_LA_GIT_REPO_PATH,
  __GIT_PUSH_REMOTES__: process.env.OE_LA_GIT_PUSH_REMOTES,
};

for (const [placeholder, value] of Object.entries(substitutions)) {
  if (value === undefined) throw new Error(`Missing value for ${placeholder}.`);
}

const escapeXml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const template = readFileSync(templatePath, "utf8");
const rendered = template.replace(
  /__(?:NODE_BIN|INSTALL_DIR|VAULT_PATH|TOKEN|PORT|READONLY|MOUNT_GUARD|MOUNT_SENTINEL|GIT_MODE|GIT_REPO_PATH|GIT_PUSH_REMOTES)__/g,
  (placeholder) => escapeXml(substitutions[placeholder]),
);

for (const placeholder of Object.keys(substitutions)) {
  if (!template.includes(placeholder)) {
    throw new Error(`LaunchAgent template is missing ${placeholder}.`);
  }
}

writeFileSync(destinationPath, rendered, { encoding: "utf8", mode: 0o600 });
chmodSync(destinationPath, 0o600);
NODE
unset OE_LA_NODE_BIN OE_LA_INSTALL_DIR OE_LA_PORT OE_LA_READONLY OE_LA_MOUNT_GUARD
unset OE_LA_MOUNT_SENTINEL OE_LA_GIT_MODE OE_LA_GIT_REPO_PATH OE_LA_GIT_PUSH_REMOTES

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/${PLIST_LABEL}" >/dev/null 2>&1 || true

# launchd can briefly return EIO when the same label is bootstrapped
# immediately after bootout. Retry a bounded number of times, and accept a
# concurrently completed registration only when launchctl can print this exact
# user-domain job.
BOOTSTRAPPED=false
for ATTEMPT in 1 2 3; do
  BOOTSTRAP_OUTPUT=""
  BOOTSTRAP_EXITED_CLEANLY=false
  if BOOTSTRAP_OUTPUT="$(launchctl bootstrap "gui/${UID_NUM}" "$PLIST_DEST" 2>&1)"; then
    BOOTSTRAP_EXITED_CLEANLY=true
  fi
  if launchctl print "gui/${UID_NUM}/${PLIST_LABEL}" >/dev/null 2>&1; then
    # A bootstrap immediately following bootout can briefly expose a ghost job
    # and still return EIO. Require the registration to survive a settle period
    # before accepting it.
    sleep 1
    if launchctl print "gui/${UID_NUM}/${PLIST_LABEL}" >/dev/null 2>&1; then
      if [ "$BOOTSTRAP_EXITED_CLEANLY" != true ]; then
        echo "launchctl registered ${PLIST_LABEL} despite a transient status; continuing."
      fi
      BOOTSTRAPPED=true
      break
    fi
  fi
  if [ -n "$BOOTSTRAP_OUTPUT" ]; then
    printf '%s\n' "$BOOTSTRAP_OUTPUT" >&2
  fi
  if [ "$ATTEMPT" -lt 3 ]; then
    echo "launchctl bootstrap did not settle; retrying (${ATTEMPT}/3)..." >&2
    sleep 1
  fi
done
if [ "$BOOTSTRAPPED" != true ]; then
  echo "Could not register ${PLIST_LABEL} after 3 attempts." >&2
  exit 1
fi
launchctl enable "gui/${UID_NUM}/${PLIST_LABEL}"
launchctl kickstart -k "gui/${UID_NUM}/${PLIST_LABEL}"
if ! launchctl print "gui/${UID_NUM}/${PLIST_LABEL}" >/dev/null 2>&1; then
  echo "launchctl registration disappeared after startup; run the installer again." >&2
  exit 1
fi

echo "Installed and started. Check status with:"
echo "  launchctl print gui/${UID_NUM}/${PLIST_LABEL}"
echo "Logs: $INSTALL_DIR/logs/http.out.log / http.err.log"
echo "Health check: curl http://127.0.0.1:${PORT_VALUE}/healthz"
