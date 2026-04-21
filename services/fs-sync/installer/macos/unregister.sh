#!/usr/bin/env bash
# Deregisters the ft5-sync LaunchAgent. Idempotent.
set -euo pipefail

LABEL="tech.forti5.ft5-sync"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

echo "ft5-sync: LaunchAgent deregistered (if present)"
