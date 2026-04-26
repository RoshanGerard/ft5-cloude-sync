# Project rules for Claude Code

## Context

- `openspec/project.md` — stack, architecture, conventions.
- `openspec/specs/` — canonical specs. `openspec/changes/` — active changes.
- `advisor` tool = stronger reviewer with full transcript access. Use at architectural commits and before declaring done.

## Workflow

1. **Entry point:**
   - **Stub or unresolved architectural ambiguity** (`proposal.md` marked stub, `## Open questions`, `Status: Stub`, embedded TBDs, OR open architectural questions in the request) → brainstorming first.
   - **Clear requirements + visual decisions only** → `/opsx:propose` first, then brainstorming as refinement.
   - **Everything else** (clear requirements, no UI, no architectural ambiguity) → `/opsx:propose` directly.

2. **Brainstorming (conditional).** Run `superpowers:brainstorming` if step 1 picked brainstorm-first OR the change involves visible UI. Brainstorm-first: before step 3. Propose-first-with-UI: after step 3, before step 4. Visual Companion engages inside the session per the skill protocol. Output flows per the handoff list below.

3. **`/opsx:propose <description>`** — generates `proposal.md`, `design.md`, `specs/<cap>/spec.md` deltas, `tasks.md`.

4. **Human review.** Wait for explicit approval before `/opsx:apply`.

5. **Pre-apply staleness check.** Spot-check `design.md` file paths, function names, architectural assumptions still match the codebase. If shifted, invoke `brainstorming` for parts needing re-resolution OR edit `design.md` directly for purely-stale references.

6. **`/opsx:apply`.** "Coding discipline" rules below are MANDATORY.

7. **Pre-archive.** Every `tasks.md` checkbox checked, full test suite passes, feature exercised against a running system, `openspec validate <change>` green. If validate fails: fix in the worktree branch and re-run — never skip validation, never edit `openspec/specs/` directly. Archive in the worktree branch *before* merging.

## Brainstorming (architectural OR visual ambiguity)

Brainstorming covers any unresolved design question — architecture, error vocabulary, scope, AND visual direction.

- **MANDATORY visual-refinement trigger:** Visible UI (component, layout, color, motion, copy, accessibility-affecting markup) AND `/opsx:propose` ran first → MUST invoke `superpowers:brainstorming` before `/opsx:apply`. Brainstorm-first path: Visual Companion engages automatically per the skill's protocol. Both paths populate `## Visual direction` in `design.md`.
- Per question: terminal (conceptual / tradeoff / scope) vs Visual Companion browser (mockups / layouts / comparisons). Visual Companion offered ONCE as its own message; not standalone-invocable.
- **Output handoff** (always OpenSpec artifacts, never `docs/plans/...` or chat-only):
  - architectural decisions → `design.md` `## Decisions`
  - visual decisions → `design.md` `## Visual direction`
  - new / changed requirements → `specs/<cap>/spec.md` (delta)
  - capability list → `proposal.md` `## Capabilities`
  - what gets built → `tasks.md`
  - BREAKING markers → `proposal.md` `## What Changes` (prefix bullet with **BREAKING**)
  - removed requirements → `specs/<cap>/spec.md` `## REMOVED Requirements` (with **Reason** + **Migration**)
  - scope shifts → `design.md` `## Goals / Non-Goals`
  - new risks → `design.md` `## Risks / Trade-offs`
- Do NOT chain into `superpowers:writing-plans` — `tasks.md` is the deliverable.
- Do NOT proceed to `/opsx:apply` until every touched artifact is updated AND `openspec validate <change>` is green.
- During `/opsx:apply`, deviation from `design.md` decisions → back to brainstorming, not forward.

### Visual-specific

- Frontend code: use `frontend-design`. Avoid defaults: no Inter/Roboto/Arial display type, no purple-gradient-on-white, no generic grid-of-cards.
- Accessibility non-negotiable: semantic HTML, keyboard nav, ARIA only when semantics aren't enough, WCAG AA contrast minimum. Flag deviations in `design.md` before implementation.

## Coding discipline

- **TDD** (`test-driven-development`). Failing test → watch it fail → minimum code to pass. Production code without a prior failing test must be deleted and rewritten. Throwaway API-exploration code permitted (≤50 lines, never committed, deleted before TDD pass).
- **Worktree** (`using-git-worktrees`). Every `/opsx:apply`. ASK where: (a) **in-place** — current checkout, blocks main; (b) **sibling** at `../<project>-<change-id>/` or `../.worktrees/<change-id>/` — parallel-friendly. Default sibling.
- **Subagent per task** (`subagent-driven-development`), two-stage review. Use `executing-plans` only when I explicitly ask for human checkpoints.
- **Background subagents** — `run_in_background: true` for anything long-running (test suites, builds, Playwright, Docker, dev servers). On the runaway system-reminder bug (claude-code #11716 or successor): restart session, run foreground with explicit timeout (e.g. 300000) to override the 120s auto-background cutoff.
- **Advisor** at TWO checkpoints per change:
  1. Before locking architectural approach (post-exploration, pre-artifacts).
  2. Before declaring done — make deliverable durable BEFORE this call.

  Skip for: trivial mechanical edits (rename, typo, comment), one-line semantic-preserving fixes, or work where you already called advisor in the same session for a directly related task.
- **Code review** (`requesting-code-review`) between tasks. Critical issues block progress. **Critical** = security vulnerability, contract break (signature / envelope shape change not in `design.md`), test coverage regression, accessibility regression below WCAG AA, deviation from `design.md` decisions. Style nits / refactor suggestions are non-blocking. Defensible deviations (implementation surfaced a flaw in the original decision): update `design.md` `## Decisions` BEFORE continuing — never silently ship.
- **Debugging** (`systematic-debugging`) for any failing test or unexpected behavior. No guess-and-check.
- **Verification** (`verification-before-completion`) before claiming done. Full test suite + typecheck + lint.
- **Finishing** (`finishing-a-development-branch`) when all tasks complete.

## Context management

**Compact when** (whichever first):

- Every 3–5 completed tasks (checkbox flipped, code reviewed, verification passed)
- Claude re-reading the same file 3+ times
- A single task's tool output > 50 lines AND that output is in git / `tasks.md`
- Never wait for auto-compact (fires at arbitrary points, may cut mid-debug)

**Compact vs clear vs neither:**

- `/compact`: Task 5.4 modified `bootstrap.ts`, ran a unit test producing 80 lines. Task 5.5 runs the full suite. State is in git, outcome is the checked box — compact.
- `/clear`: Task 9 finished a renderer component. Task 10 starts dashboard banner work in a different folder, no shared identifiers — clear.
- **Neither**: mid-debug with a failing test not root-caused. Resolve first.

**Pre-compact durability check:** commit in git, `tasks.md` reflects new state, decisions worth keeping in `design.md` / `proposal.md`. If only in chat, write down first.

After any compaction, restate current task from `tasks.md` + active `design.md` constraints in one short message before resuming.

## Hard rules

- Never commit directly to `main`.
- Never modify `openspec/specs/` directly — only via OpenSpec lifecycle.
- Never add a dependency without justifying it in `design.md`.
- Never compact mid-task or while unsaved decisions live only in chat.
- Never skip advisor checkpoints — bypass only per the narrow exceptions in "Coding discipline".
- Never let brainstorming output land in `docs/plans/` or chat-only — every decision flows to OpenSpec artifacts before `/opsx:apply`.
