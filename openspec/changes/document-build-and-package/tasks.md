## 1. Capture real command output for the README

- [ ] 1.1 Run `pnpm --filter @ft5/desktop run build:all` from the repo root on a clean checkout (no `apps/desktop/dist/` and no `apps/desktop/src/renderer/out/` present). Capture the final "built output" paths and the command duration. Record in the PR description so the README's "Local development build" subsection quotes real numbers, not estimates.
- [ ] 1.2 Run `pnpm --filter @ft5/desktop package:win` on the current Windows dev host (Developer Mode OFF). Capture: (a) the path and file size of `apps/desktop/release/win-unpacked/FT5 Cloude Sync.exe`, (b) the verbatim `winCodeSign` / symlink error from the NSIS step. Record both in the PR description so the README's Windows caveat quotes real text.

## 2. Edit README.md

- [ ] 2.1 Add a new top-level section "Build and package" **after** the existing "Native module rebuild recovery" section, containing three subsections:
  - **Local development build** — show `pnpm --filter @ft5/desktop run dev` as the iterative path (electron-vite dev server with HMR) and `pnpm --filter @ft5/desktop run build:all` as the one-shot production build. State the output paths: `apps/desktop/dist/` (main + preload) and `apps/desktop/src/renderer/out/` (Next.js static export).
  - **Packaging for the current OS** — document `pnpm package:current-os` as the root-level wrapper (with a one-line note that it is currently Windows-specific) and the per-platform explicit forms `pnpm --filter @ft5/desktop package:{mac,win,linux}`. State the output path `apps/desktop/release/` and the per-platform artifacts expected there (dmg, nsis/exe, AppImage + deb).
  - **Windows caveat: NSIS installer needs Developer Mode** — describe the split outcome on Windows without Developer Mode: `win-unpacked/FT5 Cloude Sync.exe` is produced and directly runnable, the `Setup.exe` NSIS installer is not. Quote the verbatim `winCodeSign` symlink-extraction error captured in task 1.2. List the three recovery paths: enable Windows Developer Mode, run the command from an elevated shell, or rely on the CI workflow (which doesn't have this constraint).
- [ ] 2.2 Leave the existing "Fresh clone" and "Native module rebuild recovery" subsections unchanged. Do not rewrite or reorder anything above the new section.

## 3. Verification before archive

- [ ] 3.1 Run `pnpm -w test` — confirm no test regressions from the README edit (expected: unchanged, since this is doc-only).
- [ ] 3.2 Read the new "Build and package" section top-to-bottom. Verify every command named appears in exactly one of `package.json` (root) or `apps/desktop/package.json`, and that every output path named matches what task 1.1 and 1.2 actually produced. If any command in the README does not exist or any path is wrong, fix the README rather than the scripts (scripts stay in the archived setup-project surface area).
- [ ] 3.3 Confirm `openspec/specs/app-shell/spec.md` is unchanged by this change (doc-only change has no spec delta), and no other spec files under `openspec/specs/` are modified.
