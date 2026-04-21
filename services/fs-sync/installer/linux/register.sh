#!/usr/bin/env bash
# Registers ft5-sync as a per-user systemd service and enables linger so the
# service survives logout. Falls back to XDG autostart if systemd --user is
# unavailable on this host.
# Invoked by electron-builder's `afterInstall` hook on Linux.
#
# Usage: register.sh <absolute path to fs-sync binary>
set -euo pipefail

SERVICE_PATH="${1:-}"
if [ -z "$SERVICE_PATH" ]; then
  echo "register.sh: missing SERVICE_PATH argument" >&2
  exit 2
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/ft5-sync.service"
AUTOSTART_DIR="$HOME/.config/autostart"
AUTOSTART_FILE="$AUTOSTART_DIR/ft5-sync.desktop"

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=ft5-sync per-user sync daemon

[Service]
ExecStart=${SERVICE_PATH}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now ft5-sync.service
  # Keep the user bus alive across logouts so the service survives.
  # loginctl enable-linger may require polkit / pkttyagent; best-effort.
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$(id -un)" 2>/dev/null || true
  fi
  echo "ft5-sync: systemd --user unit enabled and started"
else
  # Fallback: XDG autostart entry.
  mkdir -p "$AUTOSTART_DIR"
  cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=ft5-sync
Exec=${SERVICE_PATH}
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
  echo "ft5-sync: systemd --user unavailable; XDG autostart registered (fallback)"
fi
