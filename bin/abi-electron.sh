#!/usr/bin/env bash
# Flip better-sqlite3 to the Electron ABI (NODE_MODULE_VERSION 145).
# Run this before `pnpm --filter @ft5/desktop run dev` or any packaging
# command if the last thing you ran was a Node-side test suite.
#
# The `-f` flag is load-bearing — without it @electron/rebuild treats the
# existing binary as up-to-date and is a silent no-op.

set -euo pipefail

REPO_ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$REPO_ROOT/apps/desktop"

echo "==> Rebuilding better-sqlite3 against Electron ABI (NODE_MODULE_VERSION 145)"
npx @electron/rebuild -f -w better-sqlite3
echo "==> Done. You can now run: pnpm --filter @ft5/desktop run dev"
