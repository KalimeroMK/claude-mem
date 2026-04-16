#!/usr/bin/env bash
# Sets up the claude-mem worker to auto-start on macOS login via LaunchAgent.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/KalimeroMK/claude-mem/main/autostart.sh | bash
#   bash autostart.sh          # install
#   bash autostart.sh remove   # uninstall
set -euo pipefail

LABEL="com.claude-mem.worker"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

# ── Remove mode ───────────────────────────────────────────────────────────────

if [ "${1:-}" = "remove" ]; then
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm "$PLIST"
    echo "✅  LaunchAgent removed — worker will no longer auto-start."
  else
    echo "ℹ️   No LaunchAgent found at $PLIST"
  fi
  exit 0
fi

# ── Detect bun ────────────────────────────────────────────────────────────────

BUN_PATH=""
for candidate in \
    "$HOME/.bun/bin/bun" \
    "/usr/local/bin/bun" \
    "/opt/homebrew/bin/bun" \
    "$(command -v bun 2>/dev/null || true)"; do
  if [ -x "$candidate" ]; then
    BUN_PATH="$candidate"
    break
  fi
done

if [ -z "$BUN_PATH" ]; then
  echo "❌  Bun not found. Install with: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

# ── Detect worker-service.cjs ─────────────────────────────────────────────────

WORKER_PATH="$HOME/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs"

if [ ! -f "$WORKER_PATH" ]; then
  echo "❌  Worker not found at $WORKER_PATH"
  echo "    Run the installer first: bunx github:KalimeroMK/claude-mem install"
  exit 1
fi

# ── Write plist ───────────────────────────────────────────────────────────────

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${BUN_PATH}</string>
        <string>${WORKER_PATH}</string>
        <string>start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${HOME}/.claude-mem/logs/worker-launchd.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/.claude-mem/logs/worker-launchd.log</string>
</dict>
</plist>
EOF

mkdir -p "$HOME/.claude-mem/logs"

# ── Load ──────────────────────────────────────────────────────────────────────

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✅  LaunchAgent installed — worker will start on every login."
echo "    Bun:    $BUN_PATH"
echo "    Worker: $WORKER_PATH"
echo "    Plist:  $PLIST"
echo ""
echo "    To remove:  bash autostart.sh remove"
echo "    Or:         curl -fsSL https://raw.githubusercontent.com/KalimeroMK/claude-mem/main/autostart.sh | bash -s -- remove"
