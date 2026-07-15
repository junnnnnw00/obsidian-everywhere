#!/usr/bin/env bash
set -euo pipefail

PLIST_LABEL="com.obsidian-everywhere.http"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/${UID_NUM}/${PLIST_LABEL}" >/dev/null 2>&1 || true
rm -f "$PLIST_DEST"
echo "Removed ${PLIST_DEST} and stopped the LaunchAgent."
