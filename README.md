# ft5-cloude-sync

Electron desktop app that syncs a local Claude Code workspace to remote backends.

## Native module rebuild recovery

`better-sqlite3` is a native module and must be compiled against the exact Node
/ Electron ABI used at runtime. If the app fails to load with an error similar
to `Error: The module '...better_sqlite3.node' was compiled against a different
Node.js version` (ABI mismatch), rebuild native modules against the current
Electron version:

```bash
pnpm rebuild
```

If the full rebuild is slow or you only need to fix the desktop app, use the
targeted form, which reruns the desktop workspace's `postinstall` hook
(`@electron/rebuild`):

```bash
pnpm --filter @ft5/desktop run postinstall
```

Typical triggers for this failure: upgrading Electron, upgrading Node, or
cloning the repo / moving to a new machine where the cached prebuilt binary
does not match.
