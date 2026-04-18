# document-build-and-package

## Summary

Doc-only change. Adds a "Build and package" section to `README.md` covering local development build, per-OS packaging commands, and the known Windows Developer Mode caveat (with the verbatim `winCodeSign` symlink error so readers can recognise it). Closes the documentation gap left by the archived `setup-project` change.

## Changes

- `README.md` — appended a new `## Build and package` H2 after the existing `## Native module rebuild recovery` section, with three H3 subsections ("Local development build", "Packaging for the current OS", "Windows caveat: NSIS installer needs Developer Mode").

No code changes, no dependency changes, no spec delta.

## Verification evidence (task 1)

### Task 1.1: clean `build:all`

```
$ rm -rf apps/desktop/dist apps/desktop/src/renderer/out
$ time pnpm --filter @ft5/desktop run build:all
...
  ✓ Generating static pages (3/3) in 250ms
  ...
  dist/main/index.js  2.72 kB
  ✓ built in 77ms
  dist/preload/index.js  0.17 kB
  ✓ built in 6ms

real    0m5.755s
```

Outputs verified:

- `apps/desktop/dist/main/index.js` (main bundle, 2.72 kB)
- `apps/desktop/dist/preload/index.js` (preload bundle, 0.17 kB)
- `apps/desktop/src/renderer/out/index.html` (+ `_next/`, `_not-found/`, etc.)

README quotes "~5 seconds" — anchored against the real 5.755 s measurement.

### Task 1.2: `package:win` on Windows without Developer Mode

Unpackaged exe produced:

```
-rwxr-xr-x 1 Roshan ... 222962176 Apr 19 00:59
  apps/desktop/release/win-unpacked/FT5 Cloude Sync.exe
```

NSIS step failed with the following error (repeated three times as electron-builder retried the extraction):

```
ERROR: Cannot create symbolic link : A required privilege is not held by the
client. : C:\Users\<user>\AppData\Local\electron-builder\Cache\winCodeSign
\<hash>\darwin\10.12\lib\libcrypto.dylib
ERROR: Cannot create symbolic link : A required privilege is not held by the
client. : C:\Users\<user>\AppData\Local\electron-builder\Cache\winCodeSign
\<hash>\darwin\10.12\lib\libssl.dylib

⨯ cannot execute  cause=exit status 2
```

The README quotes this error verbatim (with `<user>` and `<hash>` redacted) so a reader who hits it can match-and-recognise.

## Verification (task 3)

| Check | Result |
|---|---|
| `pnpm -w test` | 29/29 passed — zero regressions from doc-only change |
| Every command in the new README section exists | Verified: `package:current-os` in root `package.json`; `dev`, `build:all`, `package:{mac,win,linux}` in `apps/desktop/package.json` |
| Every output path in the new README section exists on disk | Verified: `dist/main/index.js`, `dist/preload/index.js`, `src/renderer/out/`, `release/win-unpacked/FT5 Cloude Sync.exe` |
| `openspec/specs/app-shell/spec.md` unchanged | Verified: `git diff --stat openspec/specs/` returned empty |
