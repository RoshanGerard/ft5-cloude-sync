# Spike — resolving the plain-Node binary for detached service spawn

Status: design note for task 4.1 of `wire-fs-sync-service`. The real implementation
lands in task 4.3 (RED) / 4.4 (GREEN) as `node-binary-resolver.ts` colocated with
this file.

## 1. The problem

The supervisor (see `openspec/changes/wire-fs-sync-service/design.md:68-81`) must
spawn the service with `child_process.spawn(nodeBinary, [servicePath], {
detached: true, stdio: 'ignore' })`. Electron's `process.execPath` is the
Electron binary (`electron.exe` on Windows, `Electron.app/Contents/MacOS/Electron`
on macOS, `electron` on Linux). Invoking it with a script argument boots a
second Electron renderer process, not a headless Node runtime — the service
would crash on first `require('net')` expecting Electron context, and/or an empty
BrowserWindow would flash. The service's charter also forbids `electron`
imports (see `design.md:41` and project.md's framework-agnostic rule). We need a
plain Node runtime on every platform, in every mode.

## 2. Resolution strategy per platform

The resolver takes two inputs: `isPackaged` (from `app.isPackaged`) and
`appPath` (from `app.getAppPath()`). It returns an absolute path to a Node
executable. In dev it throws — the supervisor's dev branch does not spawn
(Decision 6, `design.md:136-144`); pnpm already started the service.

The packaged layout assumes electron-builder `extraResources` drops a Node
binary under `resources/node/`. electron-builder copies `extraResources`
next to the app's `resources/` directory; from `app.getAppPath()` (which points
into `resources/app.asar` or `resources/app`), the sibling directory
`../node/` is stable across platforms. See section 4 for the exact stanza.

### 2.1 Windows

- **Packaged**: `<resources>/node/win-<arch>/node.exe` where `<arch>` is `x64`
  or `arm64`. Resolved as `path.join(appPath, '..', 'node', `win-${arch}`, 'node.exe')`.
- **Dev**: throw. A dev-mode caller should not be spawning the service; pnpm
  owns it.

### 2.2 macOS

- **Packaged**: `<resources>/node/darwin-<arch>/bin/node`. The `bin/` subdir
  mirrors the layout inside the official Node tarball, which is the easiest
  source for the bundled binary. `<arch>` is `x64` or `arm64`.
- **Dev**: throw. Same reason.

Note: on macOS the service binary lives inside the `.app` bundle at
`YourApp.app/Contents/Resources/node/darwin-<arch>/bin/node`. `app.getAppPath()`
returns `…/Contents/Resources/app.asar`, so `path.join(appPath, '..', 'node', …)`
still lands in `…/Contents/Resources/node/…`. Code-signing and notarization
must include the bundled Node binary; electron-builder handles this for files
under `extraResources` automatically in recent versions — verify during task 13.

### 2.3 Linux

- **Packaged**: `<resources>/node/linux-<arch>/bin/node`. Same tarball layout
  rationale as macOS. `<arch>` is `x64` or `arm64`.
- **Dev**: throw.

## 3. Architecture / OS-arch mapping

Node ships per-OS-per-arch binaries. The resolver picks via `process.platform`
(`'win32' | 'darwin' | 'linux'`) and `process.arch` (`'x64' | 'arm64'`). No
other arches are supported in this change — if `process.arch` is anything else,
throw with a message that names the unsupported arch. Cross-compilation at
package time is out of scope; each release artifact bundles the Node binary
matching the release's target triple. Task 13 (packaging prep) must wire
`electron-builder` to pick the right Node tarball per target; task 4 does not.

## 4. electron-builder config gotchas

The current `apps/desktop/electron-builder.yml` only lists the renderer under
`extraResources`. It needs a second entry for the service bundle and a third
for the Node binary. The stanza shape (DO NOT add this in task 4.1 — it is a
task-13 concern, documented here so 13's owner has a starting point):

```yaml
extraResources:
  - from: src/renderer/out
    to: renderer
    filter: ["**/*"]
  - from: ../../services/fs-sync/dist
    to: fs-sync
    filter: ["**/*"]
  - from: ../../vendor/node/${os}-${arch}
    to: node/${os}-${arch}
    filter: ["**/*"]
```

Gotchas:

1. **Executable bit on Unix.** The Node binary in the tarball has mode 0755.
   electron-builder preserves file modes when copying `extraResources`, but
   some intermediate tooling (e.g., zipping a checkout in CI) can strip it.
   Task 13 must verify the installed mode is executable; if not, fall back to
   `fs.chmodSync(resolved, 0o755)` once at first-run, or `spawn` will fail
   with `EACCES`.
2. **macOS Gatekeeper / notarization.** The bundled `node` binary must be
   signed under the same Developer ID as the app. electron-builder's default
   `afterSign` notarization step handles binaries under `Contents/Resources/`
   automatically, but only if `hardenedRuntime: true` is set. Confirm.
3. **Windows SmartScreen.** An unsigned `node.exe` inside a signed installer
   will trip SmartScreen warnings on first run only if the user tries to run
   it directly. `spawn` from our signed main process is fine. No action
   required, but worth noting in release notes.
4. **Binary size.** A plain Node binary is ~90MB on Linux, ~75MB on macOS,
   ~50MB on Windows. This roughly doubles our installer size. Alternative
   considered: use Electron's embedded Node via `process.execPath` with a
   special flag (`ELECTRON_RUN_AS_NODE=1`). Rejected because it couples the
   service lifetime to Electron's runtime version and complicates detached
   spawn semantics on macOS (the helper app path is non-trivial). Keep the
   plain Node binary.

## 5. Reference implementation

Approximate shape for task 4.4 (GREEN). 24 lines.

```ts
import path from 'node:path'

export function resolveServiceNodeBinary(opts: { isPackaged: boolean; appPath: string }): string {
  if (!opts.isPackaged) {
    throw new Error(
      'resolveServiceNodeBinary is production-only; in dev the service is started by `pnpm dev`.',
    )
  }
  const arch = process.arch
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported arch for bundled Node: ${arch}`)
  }
  const resourcesRoot = path.join(opts.appPath, '..', 'node')
  switch (process.platform) {
    case 'win32':
      return path.join(resourcesRoot, `win-${arch}`, 'node.exe')
    case 'darwin':
      return path.join(resourcesRoot, `darwin-${arch}`, 'bin', 'node')
    case 'linux':
      return path.join(resourcesRoot, `linux-${arch}`, 'bin', 'node')
    default:
      throw new Error(`Unsupported platform for bundled Node: ${process.platform}`)
  }
}
```

Design notes for the GREEN implementer:

- The function is synchronous and does not touch the filesystem. It returns a
  path without verifying existence. Callers (the supervisor) should `stat`
  the path and surface a clear error if missing — that keeps this function
  pure and trivially unit-testable by injecting `isPackaged` / `appPath`.
- `process.platform` and `process.arch` are intentionally read at call time,
  not parameters. They cannot change at runtime, and parameterising them
  complicates the supervisor's call site for no test benefit (tests can stub
  `process` if needed, or the function can be split into a pure inner
  function with injected `platform`/`arch` during task 4.3 RED).

## 6. Follow-up questions for task 4.3+

Unresolved by this spike; the first RED test in 4.3 should lock these:

1. **Vendor-directory layout.** Where does the Node tarball get extracted
   before electron-builder sees it? The stanza in section 4 assumes
   `<repo>/vendor/node/<os>-<arch>/`. A repo-level `vendor/` is cleaner than
   per-app vendoring but requires a `scripts/fetch-node-binary.mjs` step in
   CI. Punted to task 13.
2. **Whether to inject `platform`/`arch`.** The reference impl reads them
   from `process` directly. Tests may want to parameterise. 4.3 decides the
   signature; preferred shape for testability:
   `resolveServiceNodeBinary(opts & { platform?: NodeJS.Platform; arch?: NodeJS.Architecture }): string`
   with defaults from `process`.
3. **`app.asar` vs. `app` directory.** If `asar: true` (currently yes, per
   `electron-builder.yml:14`), `app.getAppPath()` returns the `.asar` path.
   The `path.join(appPath, '..', 'node', …)` trick works in both cases
   because `..` strips off `app.asar` or `app`. Verify with a spawned
   packaged build in task 13 before shipping.
4. **Fallback to `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.** Section
   4 rejects this. If the binary-size tradeoff becomes unacceptable, revisit
   — `ELECTRON_RUN_AS_NODE` gives us a Node runtime using the Electron binary
   and works across platforms, at the cost of coupling service and app Node
   versions and complicating the detached-spawn macOS story. Not this
   change.
5. **electron-builder config change.** `apps/desktop/electron-builder.yml`
   does not yet include the `fs-sync` or `node` extraResources entries
   documented in section 4. Task 13 owns adding them. Until then,
   `resolveServiceNodeBinary` will throw at runtime in packaged builds; the
   supervisor's spawn branch is therefore untested end-to-end until 13 lands.
   Flag in task 4.3's test plan.
6. **Executable-bit verification.** Section 4 gotcha 1 may need a one-shot
   `chmod` in the supervisor if electron-builder's mode preservation proves
   unreliable in CI. Decide after task 13's first packaged build on
   Linux/macOS.
