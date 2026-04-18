## Context

`apps/desktop/package.json` declares six scripts that together cover local-dev iteration and cross-platform packaging:

```
dev             electron-vite dev
build           electron-vite build                        # main + preload
build:renderer  pnpm --filter @ft5/renderer build          # Next.js static export
build:desktop   electron-vite build                        # alias of build
build:all       pnpm build:renderer && pnpm build:desktop
package:mac     pnpm build:all && electron-builder --mac
package:win     pnpm build:all && electron-builder --win
package:linux   pnpm build:all && electron-builder --linux
```

Root `package.json` wraps the current-OS target with:

```
package:current-os  pnpm --filter @ft5/desktop package:win
```

(Windows-only today because the project is being developed on a Windows host; the wrapper will be rewritten to pick the right `--{mac,win,linux}` per `process.platform` once a cross-platform developer actively needs it — out of scope for this change.)

On a Windows host without Developer Mode enabled, `electron-builder --win` consistently:

- Succeeds at producing `apps/desktop/release/win-unpacked/FT5 Cloude Sync.exe` (the app bundle — no installer, just the Electron binary + resources, directly runnable).
- Fails at the NSIS installer step with an error inside `winCodeSign` about extracting a symlinked archive entry. The archived `setup-project` task 8.2 captured this and noted the recovery path: run on a host with Developer Mode enabled, run an elevated shell, or rely on CI runners (which don't have this constraint).

The runnable `win-unpacked` artifact is enough for a local smoke test (launch it, verify the IPC ping round trip, exercise the UI). The signed `Setup.exe` installer is what we hand to end users; CI is where it's produced.

## Goals / Non-Goals

**Goals:**
- A developer who wants to try the packaged app can find the command in the README without reading source.
- A developer on Windows who hits the `winCodeSign` symlink error sees the exact symptom documented next to the command, with the three recovery paths (Developer Mode, elevated shell, CI) listed — so they don't think something is broken.
- The README reflects what the scripts actually do today; it doesn't describe hypothetical flows.

**Non-Goals:**
- Changing `apps/desktop/package.json` scripts or `electron-builder.yml`.
- Making `package:current-os` cross-platform (currently hardcoded to `package:win`). That's a separate change the day a non-Windows developer picks up the repo.
- Documenting code signing / notarization — both are deferred and gated on key provisioning, which is its own change.
- Adding a requirement that the README *tests* itself (e.g. a test that asserts the scripts named in the README exist in `package.json`). The current docs burden is low and a lint rule like that would outlive its usefulness; skip it.
- Adding scenarios to `openspec/specs/app-shell/spec.md`. Documentation is not runtime behaviour; the spec captures what the app does, not what the README says about how to build it.

## Decisions

### Decision 1: Place "Build and package" after "Native module rebuild recovery", not before

**Chosen:** Insert the new section below the existing "Native module rebuild recovery" section.

**Rationale:** A new contributor's first command is `pnpm install` (covered by the existing "Fresh clone" subsection). The next thing they're likely to hit is either an ABI error (covered by "Native module rebuild recovery") or wanting to run the app (covered by this new section). Putting rebuild-recovery first keeps the "something is broken, what do I do" flow uninterrupted at the top; build-and-package comes after as the "now that install works, here's how to run it" payoff.

**Alternatives considered:**
- *Put "Build and package" at the top, relegate rebuild recovery to a troubleshooting appendix.* Rejected: rebuild recovery is the single most-asked support question for any Electron project, and keeping it high-up pays off relative to a one-time "how do I build" question.
- *Split into two new H1 sections at the top ("Getting started" + "Packaging").* Rejected: the README is currently 27 lines. A two-section rewrite is a bigger change than this scope warrants.

### Decision 2: Document all three OS package commands in the README, not just Windows

**Chosen:** Document `package:mac`, `package:win`, and `package:linux` (plus the `package:current-os` wrapper) side-by-side.

**Rationale:** The scripts already exist and the archived `setup-project` change explicitly targeted cross-platform installers. A reader on macOS or Linux should not have to grep for `package:` to learn the command exists. The Windows-specific `winCodeSign` caveat is annotated only against the Windows command; the other two commands have no comparable footgun on the dev host's experience, so they're documented as a plain two-line command with expected output path.

**Alternatives considered:**
- *Document only `package:current-os` and let users explore the per-platform forms.* Rejected: `package:current-os` is a Windows-only wrapper today; pointing a macOS user at it would be actively wrong.
- *Document only the command that the dev host can verify.* Rejected: doc coverage shouldn't be gated on one developer's platform. CI already exercises all three.

### Decision 3: Name the winCodeSign error in the README verbatim

**Chosen:** Include a literal excerpt of the `winCodeSign` symlink-extraction error so a Windows-without-Developer-Mode user hitting it can match the text and recognise it as the documented path.

**Rationale:** Error-message matching is how developers triangulate. A paraphrased "may fail on Windows" doesn't help someone staring at a stack trace. The exact substring to match is stable across `electron-builder` 26.x versions.

**Alternatives considered:**
- *Describe the cause ("symlinks require Developer Mode") without quoting the error.* Rejected: if a reader's error text differs from ours, they'll assume the documented path doesn't apply to them. The exact quote lets them match and be confident.
