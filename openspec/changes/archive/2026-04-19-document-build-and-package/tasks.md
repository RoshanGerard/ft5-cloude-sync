## 1. Capture real command output for the README

- [x] 1.1 Run `pnpm --filter @ft5/desktop run build:all` from the repo root on a clean checkout (no `apps/desktop/dist/` and no `apps/desktop/src/renderer/out/` present). Capture the final "built output" paths and the command duration. Record in the PR description so the README's "Local development build" subsection quotes real numbers, not estimates.
- [x] 1.2 Run `pnpm --filter @ft5/desktop package:win` on the current Windows dev host (Developer Mode OFF). Capture: (a) the path and file size of `apps/desktop/release/win-unpacked/FT5 Cloude Sync.exe`, (b) the verbatim `winCodeSign` / symlink error from the NSIS step. Record both in the PR description so the README's Windows caveat quotes real text.

## 2. Edit README.md

- [x] 2.1 Add a new top-level section "Build and package" **after** the existing "Native module rebuild recovery" section, containing three subsections: "Local development build", "Packaging for the current OS", and "Windows caveat: NSIS installer needs Developer Mode". Each subsection quotes real commands and real error text captured in tasks 1.1 / 1.2.
- [x] 2.2 Leave the existing "Fresh clone" and "Native module rebuild recovery" subsections unchanged. Do not rewrite or reorder anything above the new section.

## 3. Verification before archive

- [x] 3.1 Run `pnpm -w test` — confirm no test regressions from the README edit. (Result: 29/29 tests pass, identical to pre-change baseline.)
- [x] 3.2 Read the new "Build and package" section top-to-bottom. Verify every command named appears in exactly one of `package.json` (root) or `apps/desktop/package.json`, and that every output path named matches what task 1.1 and 1.2 actually produced. (Verified: `package:current-os` → root `package.json` line 16; `dev`, `build:all`, `package:{mac,win,linux}` → `apps/desktop/package.json` lines 8–15; `win-unpacked/FT5 Cloude Sync.exe` (222 MB) observed on disk at `apps/desktop/release/`.)
- [x] 3.3 Confirm `openspec/specs/app-shell/spec.md` is unchanged by this change (doc-only change has no spec delta), and no other spec files under `openspec/specs/` are modified. (`git diff --stat openspec/specs/` returned empty.)
