#!/usr/bin/env bash
# bin/dev.sh — start/stop the fs-sync service + desktop app in dev mode.
#
# Works around the Windows dev constraint: better-sqlite3 is shared between
# Electron (ABI 145) and Node (ABI 137), and pnpm's `verify-deps-before-run`
# keeps flipping the on-disk binary back to the Node prebuild whenever any
# pnpm command runs. This script (a) builds the service first, (b) flips
# the binary to Electron ABI last, (c) launches the service via Electron's
# bundled Node (ELECTRON_RUN_AS_NODE=1) so both sides want ABI 145 — no
# further flips needed. See README.md "Local development".
#
# Usage:
#   bin/dev.sh start    # build, flip, launch service + desktop in background
#   bin/dev.sh stop     # kill both process trees
#   bin/dev.sh restart  # stop + start
#   bin/dev.sh status   # show running PIDs
#   bin/dev.sh logs     # tail -F both logs (Ctrl+C to exit)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$REPO_ROOT/node_modules/.cache/ft5-dev"
SERVICE_PID_FILE="$RUN_DIR/service.pid"
DESKTOP_PID_FILE="$RUN_DIR/desktop.pid"
SERVICE_LOG="$RUN_DIR/service.log"
DESKTOP_LOG="$RUN_DIR/desktop.log"

mkdir -p "$RUN_DIR"

find_electron() {
  local match
  match=$(ls "$REPO_ROOT"/node_modules/.pnpm/electron@*/node_modules/electron/dist/electron.exe 2>/dev/null | head -1)
  if [ -z "$match" ]; then
    echo "ERROR: electron.exe not found under node_modules/.pnpm/electron@*" >&2
    echo "       run 'pnpm install' first" >&2
    return 1
  fi
  printf '%s\n' "$match"
}

is_alive() {
  local pid_file="$1"
  [ -f "$pid_file" ] || return 1
  local pid
  pid=$(cat "$pid_file" 2>/dev/null) || return 1
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

kill_tree() {
  # Kill a process and all its descendants. Windows needs taskkill /T to
  # walk the tree; plain `kill` only hits the immediate PID.
  local pid="$1"
  if command -v taskkill >/dev/null 2>&1; then
    taskkill //F //T //PID "$pid" >/dev/null 2>&1 || true
  else
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

kill_stray_repo_electron() {
  # Kill any electron.exe process whose executable path lives INSIDE this
  # repo (i.e. one launched from this repo's node_modules). Guards against
  # leftovers from previous manual starts that dev.sh never tracked.
  # Scoped by path so unrelated Electron apps (VS Code, Slack, etc. — and
  # other pnpm-electron projects on the same machine) are untouched.
  command -v powershell.exe >/dev/null 2>&1 || return 0
  local win_path
  win_path=$(cd "$REPO_ROOT" && pwd -W 2>/dev/null) || return 0
  # PowerShell's Process.Path uses backslashes — match prefix in both styles.
  local ps_prefix_fwd="$win_path"
  local ps_prefix_bak="${win_path//\//\\}"
  powershell.exe -NoProfile -Command "
    Get-Process electron -ErrorAction SilentlyContinue |
      Where-Object { \$_.Path -and (\$_.Path.StartsWith('$ps_prefix_fwd', 'OrdinalIgnoreCase') -or \$_.Path.StartsWith('$ps_prefix_bak', 'OrdinalIgnoreCase')) } |
      ForEach-Object {
        Write-Host ('    killing stray electron pid=' + \$_.Id)
        Stop-Process -Id \$_.Id -Force -ErrorAction SilentlyContinue
      }
  " >&2 2>/dev/null || true
}

do_start() {
  if is_alive "$SERVICE_PID_FILE" || is_alive "$DESKTOP_PID_FILE"; then
    echo "Already running. '$0 status' to check, '$0 restart' to cycle." >&2
    exit 1
  fi

  # Clean up any stale PID files AND any orphan processes from a previous
  # unclean stop (e.g. terminal closed without 'stop'). do_stop is
  # idempotent — safe to call when nothing is tracked.
  do_stop >/dev/null 2>&1 || true

  echo "==> Building fs-sync service"
  (cd "$REPO_ROOT" && pnpm --filter @ft5/fs-sync-service build)

  echo "==> Flipping better-sqlite3 to Electron ABI (145)"
  if ! (cd "$REPO_ROOT" && pnpm abi:electron); then
    cat >&2 <<'EPERM_HINT'

ABI rebuild failed. Most common cause on Windows: a leftover electron.exe
from a previous manual start is still holding better_sqlite3.node open.
Windows locks loaded .node files — the rebuild can't unlink them.

Check:  tasklist //FI "IMAGENAME eq electron.exe"
Kill:   taskkill //F //IM electron.exe
Retry:  ./bin/dev.sh start

If node.exe is also holding it and you're sure no unrelated Node work is
running: taskkill //F //IM node.exe
EPERM_HINT
    exit 1
  fi
  echo "    NOTE: do not run any 'pnpm' command against this repo until"
  echo "    services stop — it will flip the binary back to Node ABI."

  local electron_bin
  electron_bin=$(find_electron)
  echo "==> Using electron runtime: $electron_bin"

  : > "$SERVICE_LOG"
  : > "$DESKTOP_LOG"

  echo "==> Starting fs-sync service (ELECTRON_RUN_AS_NODE=1, ABI 145)"
  (
    cd "$REPO_ROOT"
    ELECTRON_RUN_AS_NODE=1 "$electron_bin" \
      --enable-source-maps \
      services/fs-sync/dist/main/index.js \
      --dev
  ) >"$SERVICE_LOG" 2>&1 &
  local service_pid=$!
  echo "$service_pid" > "$SERVICE_PID_FILE"
  echo "    service pid=$service_pid  log=$SERVICE_LOG"

  # Give the service a moment to bind its named pipe before the desktop's
  # supervisor tries to connect. 3s is empirical — bump if you see
  # "sync client not initialized" from the desktop on first upload.
  sleep 3

  if ! is_alive "$SERVICE_PID_FILE"; then
    echo "ERROR: service died during startup. Last 40 lines:" >&2
    tail -n 40 "$SERVICE_LOG" >&2 || true
    rm -f "$SERVICE_PID_FILE"
    exit 1
  fi

  echo "==> Starting desktop (electron-vite dev)"
  (
    cd "$REPO_ROOT"
    pnpm --filter @ft5/desktop run dev
  ) >"$DESKTOP_LOG" 2>&1 &
  local desktop_pid=$!
  echo "$desktop_pid" > "$DESKTOP_PID_FILE"
  echo "    desktop pid=$desktop_pid  log=$DESKTOP_LOG"

  echo ""
  echo "Both started. Useful commands:"
  echo "  $0 logs     # tail both logs"
  echo "  $0 status"
  echo "  $0 stop"
}

do_stop() {
  local any=0
  for label in desktop service; do
    local pf="$RUN_DIR/$label.pid"
    if [ -f "$pf" ]; then
      local pid
      pid=$(cat "$pf" 2>/dev/null || echo "")
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "==> Stopping $label (pid=$pid)"
        kill_tree "$pid"
        any=1
      else
        echo "==> $label: stale pid file, removing"
      fi
      rm -f "$pf"
    fi
  done

  # Sweep for untracked electron.exe processes launched from this repo —
  # covers orphans from manual starts before dev.sh existed or from a
  # crashed dev.sh run.
  kill_stray_repo_electron

  if [ "$any" -eq 0 ]; then
    echo "Nothing to stop."
  else
    echo "Stopped."
  fi
}

do_restart() {
  do_stop
  sleep 1
  do_start
}

do_status() {
  for label in service desktop; do
    local pf="$RUN_DIR/$label.pid"
    if is_alive "$pf"; then
      echo "$label: running (pid=$(cat "$pf"))"
    else
      echo "$label: not running"
    fi
  done
  echo ""
  echo "Logs: $SERVICE_LOG"
  echo "      $DESKTOP_LOG"
}

do_logs() {
  if ! command -v tail >/dev/null 2>&1; then
    echo "tail not available. Cat manually:" >&2
    echo "  $SERVICE_LOG" >&2
    echo "  $DESKTOP_LOG" >&2
    exit 1
  fi
  # --retry so we survive log-file recreation on restart.
  exec tail -F --retry "$SERVICE_LOG" "$DESKTOP_LOG"
}

case "${1:-}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 1
    ;;
esac
