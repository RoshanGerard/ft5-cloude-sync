#!/usr/bin/env bash
# Flip better-sqlite3 to the Node ABI (NODE_MODULE_VERSION 137 on Node 24.x).
# Run this before `pnpm -w test --run`, `pnpm --filter @ft5/fs-sync-service test`,
# or `pnpm dev:sync-service` if the last thing you ran was the Electron app.
#
# The `--force` flag is load-bearing — without it prebuild-install refuses
# to overwrite the existing (Electron-compiled) binary.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# Discover the installed better-sqlite3 version (avoids hard-coding).
shopt -s nullglob
candidates=("$REPO_ROOT"/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3)
shopt -u nullglob

if [ ${#candidates[@]} -eq 0 ]; then
  echo "error: better-sqlite3 not found in pnpm store — run 'pnpm install' first" >&2
  exit 1
fi
if [ ${#candidates[@]} -gt 1 ]; then
  echo "warning: multiple better-sqlite3 versions installed; using: ${candidates[0]}" >&2
fi

cd "${candidates[0]}"

echo "==> Flipping better-sqlite3 to Node ABI for $(node -v)"
npx prebuild-install --runtime=node --target="$(node -v)" --force
echo "==> Done. You can now run: pnpm -w test --run"
