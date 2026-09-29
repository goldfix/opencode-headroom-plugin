#!/usr/bin/env bash
# Installs this plugin for auto-discovery by every OpenCode project on this
# machine, by symlinking it into OpenCode's global plugins directory.
# No opencode.json / opencode.jsonc edit is required (see docs/plugins.md
# "Discover": OpenCode loads immediate plugin package directories from
# ~/.config/opencode/plugins automatically).
#
# Usage:
#   bash scripts/install.sh [--force]
#
# Env overrides:
#   OPENCODE_CONFIG_DIR   Root config directory (default: ~/.config/opencode)
set -euo pipefail

PLUGIN_NAME="headroom-context-compression"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
TARGET_DIR="$CONFIG_DIR/plugins/$PLUGIN_NAME"
FORCE="${1:-}"

if [ ! -d "$REPO_ROOT/node_modules/@opencode/plugin" ]; then
  echo "--> @opencode/plugin is not installed here yet. Run 'npm install' in ${REPO_ROOT} first."
  exit 1
fi

mkdir -p "$CONFIG_DIR/plugins"

if [ -e "$TARGET_DIR" ] || [ -L "$TARGET_DIR" ]; then
  if [ "$FORCE" != "--force" ]; then
    echo "--> ${TARGET_DIR} already exists. Re-run with --force to replace it."
    exit 1
  fi
  rm -rf "$TARGET_DIR"
fi

ln -s "$REPO_ROOT" "$TARGET_DIR"

echo "--> Linked ${TARGET_DIR} -> ${REPO_ROOT}"
echo "--> Make sure 'headroom proxy' is running before starting OpenCode."
echo "--> Restart the OpenCode server (e.g. 'opencode service restart') to load the plugin."
