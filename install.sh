#!/usr/bin/env bash
# Claude-Mem installer for the KalimeroMK fork (includes Kimi AI integration)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/KalimeroMK/claude-mem/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/KalimeroMK/claude-mem/main/install.sh | bash -s -- kimi
set -euo pipefail

REPO="https://github.com/KalimeroMK/claude-mem"
TMP_DIR="$(mktemp -d)"
IDE_ARG="${1:-}"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ── Check requirements ────────────────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  echo "❌  Node.js is required (18+). Install from https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌  Node.js 18+ required (found v$(node --version))"
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "📦  Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  # shellcheck disable=SC1090
  source "$HOME/.bun/env" 2>/dev/null || export PATH="$HOME/.bun/bin:$PATH"
fi

# ── Clone & run ───────────────────────────────────────────────────────────────

echo "📥  Fetching claude-mem (KalimeroMK fork)..."
git clone --depth=1 --quiet "$REPO" "$TMP_DIR/claude-mem"

if [ -n "$IDE_ARG" ]; then
  node "$TMP_DIR/claude-mem/dist/npx-cli/index.js" install "$IDE_ARG"
else
  node "$TMP_DIR/claude-mem/dist/npx-cli/index.js" install
fi
