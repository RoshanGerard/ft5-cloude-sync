#!/usr/bin/env bash
# Deregisters the ft5-sync systemd --user unit (and/or XDG autostart entry).
# Idempotent.
set -euo pipefail

UNIT_FILE="$HOME/.config/systemd/user/ft5-sync.service"
AUTOSTART_FILE="$HOME/.config/autostart/ft5-sync.desktop"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now ft5-sync.service 2>/dev/null || true
fi
rm -f "$UNIT_FILE" "$AUTOSTART_FILE"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user daemon-reload 2>/dev/null || true
fi

echo "ft5-sync: systemd --user unit + XDG autostart deregistered (if present)"
