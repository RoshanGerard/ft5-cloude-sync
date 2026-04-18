## Why

The archived `setup-project` change landed the full packaging toolchain — `electron-vite` for `main`/`preload` bundles, Next.js static export for the renderer, `electron-builder` with macOS/Windows/Linux targets, and root-level `package:current-os` wrapper — but explicitly deferred user-facing documentation for how to build and package the app. The current `README.md` only covers dependency install and ABI-mismatch recovery. A developer who wants to produce a runnable `.exe` (or `.app` / `.AppImage` / `.deb`) has no entry point in the docs: they'd have to read `apps/desktop/package.json` or the archived change's `tasks.md` to learn that `pnpm --filter @ft5/desktop package:win` exists.

The gap has already surfaced once: a user followed the README, expected an `.exe` to appear, and didn't find one because the README never says to run a packaging command. Closing this gap prevents the same confusion on every future clone.

There is one platform-specific footgun worth naming explicitly. On Windows hosts **without Developer Mode enabled**, `electron-builder` successfully produces `apps/desktop/release/win-unpacked/FT5 Cloude Sync.exe` (a directly-runnable unpackaged executable) but fails to finalize the NSIS `Setup.exe` installer because the `winCodeSign` extraction step relies on symlinks that require Developer Mode or an elevated shell. This has been observed on the dev host, is not a code bug, and is the reason the archived setup-project task 8.2 recorded "NSIS installer deferred to signing-capable CI host." Documenting the caveat inline next to the command turns a silent failure into an expected, survivable one.

## What Changes

- Add a new top-level section to `README.md` titled "Build and package" (placed after "Native module rebuild recovery"), with three labeled subsections:
  - **Local development build** — `pnpm --filter @ft5/desktop run dev` (electron-vite dev server) for iterative work, and `pnpm --filter @ft5/desktop run build:all` to produce compiled `main`+`preload` bundles under `apps/desktop/dist/` and the renderer static export under `apps/desktop/src/renderer/out/`.
  - **Packaging for the current OS** — `pnpm package:current-os` (root wrapper, currently targets Windows) and the per-platform `pnpm --filter @ft5/desktop package:{win,mac,linux}` forms, with the expected output paths under `apps/desktop/release/`.
  - **Windows caveat: NSIS installer needs Developer Mode** — documents that without Developer Mode enabled, only `apps/desktop/release/win-unpacked/FT5 Cloude Sync.exe` is produced (runnable, sufficient for local smoke-testing), and the `Setup.exe` NSIS installer is only generated on hosts with Developer Mode or in CI. Explicitly calls out the `winCodeSign` error signature so a reader hitting it recognises the documented path.
- No code, scripts, or dependencies change. `package:current-os` and the per-platform scripts already exist in `package.json` — this change only documents them.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
<!-- None. This is a documentation-only change: it codifies existing packaging commands and a known-platform caveat, not a new behavioural requirement of any capability. No delta to `specs/app-shell/` is required; the runtime app behaviour is unchanged. -->

## Impact

- **Code**: none.
- **Docs**: `README.md` gains a "Build and package" section with three subsections. Roughly +50 lines, no deletions to existing content.
- **Dependencies / scripts / config**: none (the scripts being documented already exist in `apps/desktop/package.json` and root `package.json`).
- **CI**: none. CI's existing `package:<os>` steps are already exercising the commands this change describes.
- **Tests**: none. Doc-only changes are verified by a one-time manual packaging run on the dev host (recorded in the PR description), confirming that the commands and expected outputs the README describes match reality.
- **Out of scope** (deferred, still): code signing + notarization key provisioning, auto-update server wiring, macOS/Linux hands-on verification (the dev host is Windows; macOS/Linux commands are documented by parity with the setup-project scaffolding and will be exercised by CI).
