#!/usr/bin/env bash
# Removes the global symlink created by scripts/install.sh.
# Refuses to touch anything that is not a symlink, in case a user replaced
# it with a real directory.
#
# Usage:
#   bash scripts/uninstall.sh
set -euo pipefail

PLUGIN_NAME="headroom-context-compression"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
TARGET_DIR="$CONFIG_DIR/plugins/$PLUGIN_NAME"

if [ ! -e "$TARGET_DIR" ] && [ ! -L "$TARGET_DIR" ]; then
  echo "--> Nothing installed at ${TARGET_DIR}."
  exit 0
fi

if [ ! -L "$TARGET_DIR" ]; then
  echo "--> ${TARGET_DIR} exists but is not a symlink; leaving it alone. Remove it manually if needed."
  exit 1
fi

rm "$TARGET_DIR"
echo "--> Removed ${TARGET_DIR}"
echo "--> Restart the OpenCode server (e.g. 'opencode service restart') to unload the plugin."
