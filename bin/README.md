# bin/

Automation scripts for recurring development chores.

## ABI flip helpers

`better-sqlite3` is a native addon shared between `apps/desktop` (Electron,
NODE_MODULE_VERSION 145) and `services/fs-sync` (Node, NODE_MODULE_VERSION
137). pnpm's store keeps a single compiled `.node` per package version, so
whichever runtime most recently rebuilt it owns the binary — the other side
fails to load until flipped back.

| Script | When to run | What it does |
|---|---|---|
| `bin/abi-electron.sh` | Before `pnpm --filter @ft5/desktop run dev` / `package:*` | Rebuilds `better-sqlite3` for Electron via `@electron/rebuild -f` |
| `bin/abi-node.sh` | Before `pnpm -w test --run` / `pnpm dev:sync-service` | Fetches the Node prebuild via `prebuild-install --force` |

Both are idempotent and take ~5 seconds. They are also wired as pnpm
scripts for convenience:

```bash
pnpm abi:electron
pnpm abi:node
```

### When you'll see the ABI error

```
Error: The module '...better_sqlite3.node' was compiled against a
different Node.js version using NODE_MODULE_VERSION 137. This version of
Node.js requires NODE_MODULE_VERSION 145.
```

That's Electron complaining it got a Node-built binary. Run
`pnpm abi:electron` and try again. The reverse error on the Node side is
resolved by `pnpm abi:node`.
