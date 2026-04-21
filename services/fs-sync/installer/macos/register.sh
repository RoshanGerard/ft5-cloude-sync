#!/usr/bin/env bash
# Registers ft5-sync as a per-user LaunchAgent. RunAtLoad + KeepAlive so
# launchd re-spawns the service on user login.
# Invoked by electron-builder's `afterInstall` hook on macOS.
#
# Usage: register.sh <absolute path to fs-sync binary>
set -euo pipefail

SERVICE_PATH="${1:-}"
if [ -z "$SERVICE_PATH" ]; then
  echo "register.sh: missing SERVICE_PATH argument" >&2
  exit 2
fi

LABEL="tech.forti5.ft5-sync"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
mkdir -p "$(dirname "$PLIST")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${SERVICE_PATH}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME}/ft5/sync_app/service.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/ft5/sync_app/service.log</string>
</dict>
</plist>
EOF

# Unload any prior registration, then load the current plist. Idempotent.
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "ft5-sync: LaunchAgent registered and loaded (${LABEL})"
