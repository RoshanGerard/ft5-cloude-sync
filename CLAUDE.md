# Project rules for Claude Code

## Context

- `openspec/project.md` — stack, architecture, conventions.
- `openspec/specs/` — canonical specs. `openspec/changes/` — active changes; `openspec/changes/archive/` — completed.
- `advisor` tool = stronger reviewer with full transcript access. Use at the two checkpoints in Coding discipline > Advisor.

## Workflow

Forward changes (intent → propose → ship). For bug fixes / improvements / patches, see `## Reactive workflow` below.

1. **Entry point:**
  - **Brainstorm-first** — Stub or unresolved architectural ambiguity (a change in `openspec/changes/` whose `proposal.md` is incomplete — open questions, TBDs, missing `## What Changes` body, no spec delta yet, no `tasks.md`, OR open architectural questions in the request) → resolve via `superpowers:brainstorming` first, then `/opsx:propose`.
  - **Propose-direct** — Everything else → `/opsx:propose` directly. Visible-UI changes still get visual refinement via `superpowers:brainstorming` AFTER propose (step 4); that does not change the entry point.

2. **Brainstorming — architectural resolution (conditional).** Only when step 1 picked brainstorm-first. `superpowers:brainstorming` converges the architectural / conceptual / scope / error-vocabulary ambiguity into decisions (probing questions, approaches with tradeoffs, a recommendation), then runs `/opsx:propose`. Conceptual only — no Visual Companion yet (no artifacts to refine); that is step 4. Output flows per the handoff list in `## Brainstorming` below.

3. **`/opsx:propose <description>`** — generates `proposal.md`, `design.md`, `specs/<cap>/spec.md` deltas, `tasks.md`. Pass `<change-id>` (kebab-case) instead when the name is already settled — e.g. reactive back-fills.

4. **Brainstorming — visual refinement (conditional).** Run `superpowers:brainstorming` when the change involves visible UI — here its load-bearing contribution is the Visual Companion (browser mockups / layouts / comparisons). Runs AFTER `/opsx:propose`, before human review. Visual Companion engages inside the session per the skill protocol; decisions populate `design.md` `## Visual direction` (handoff list below). Non-UI changes skip this step entirely.

5. **Human review.** Wait for explicit approval before `/opsx:apply`.

6. **Pre-apply staleness check.** Spot-check `design.md` file paths, function names, architectural assumptions still match the codebase. If shifted, re-resolve via `superpowers:brainstorming` for parts needing it, OR edit `design.md` directly for purely-stale references.

7. **`/opsx:apply`.** "Coding discipline" rules below are MANDATORY.

8. **Pre-archive + archive.** Every `tasks.md` checkbox checked, full test suite passes, feature exercised against a running system, `openspec validate <change>` green. If validate fails: fix in the worktree branch and re-run — never skip validation, never edit `openspec/specs/` directly. Then archive via `/opsx:archive` in the worktree branch *before* merging.

9. **Finish the branch.** AFTER archive, hand off via `finishing-a-development-branch` — the mandatory entry point that re-verifies tests, runs the pre-handoff backstop over the whole branch (`git log <base>..HEAD`), then performs the merge/PR itself. Never merge-to-base or `gh pr create` outside it. `/opsx:archive` closes the OpenSpec lifecycle; it is NOT the branch finish line — this step is.

## Reactive workflow (bugs, fixes, improvements)

`## Workflow` above is for forward changes (intent → propose → ship). This section is for reactive work (issue → fix → audit → optional back-fill). The audit gate runs on the fix's *output*, not on whether `systematic-debugging` was invoked.

### Flow

1. **Investigate.** Use `superpowers:systematic-debugging` for any failing test, unexpected behavior, or non-trivial issue. Skip the skill only for mechanical fixes (typo, comment, one-line semantic-preserving). If investigation reveals a missing feature rather than a defect, fall back to `## Workflow` — reactive flow does not apply.
2. **Implement** the fix on a branch. Reactive TDD: write a failing test that reproduces the bug, then make it green. Skip TDD only for mechanical fixes.
3. **Audit gate (mandatory).** Classify into ONE of three outcomes below. Run the gate before declaring done, before committing, before handoff.
4. **Act:**
  - Outcome 1 → plain commit.
  - Outcome 2 → plain commit + spec citation in commit body (Hard rule).
  - Outcome 3 → back-fill chain (Pattern A / B / C).
5. **Pre-handoff backstop** — see end of section.

### Audit gate — three outcomes

- **Outcome 1 — No observable contract change.** Refactor, perf, doc, test, internal-only, or accessibility fix already inside WCAG AA. → Plain commit, no OpenSpec.
- **Outcome 2 — Code wrong, spec right.** Fix restores behavior the spec already documents — code defect against an existing requirement. → Plain commit citing the restored requirement (see Hard rules).
- **Outcome 3 — Contract changed.** Any trigger from the checklist below fires. → Back-fill required. Pick Pattern A / B / C.

### Trigger checklist (Outcome 3) — if ANY fires, contract changed

- New error code or coded response (any new value in a `code` / `error_code` field, e.g. `RATE_LIMITED`)
- New / changed HTTP status, response field, request field, or query param
- New default, clamp, or validation rule visible to a caller
- Scenario added / removed / renamed in the impacted capability
- Frontend↔backend vocabulary pin (enum keys, shared schema, label-to-code map)
- Previously-implicit invariant becoming load-bearing (a behavior previously assumed but never documented now becomes a hard rule, e.g. "list endpoint MUST include archived rows")
- Removal of previously-documented behavior

If you can't classify confidently, escalate to advisor before deciding.

### Back-fill patterns

**Pattern A — Pure back-fill** (impl already shipped; most common).
- `/opsx:propose <change-id>` with `tasks.md` pre-checked; `proposal.md` opens with "Implementation already shipped in commit `<sha>`."
- `design.md` captures the *as-shipped* contract — read the actual diff, never guess.
- Spec delta in `## ADDED Requirements` (or the `MODIFIED` / `REMOVED` / `RENAMED` variants). Multi-capability fixes bundle all deltas into ONE change.
- Chain: `propose → /opsx:sync → /opsx:archive` in one session. `openspec validate <change-id>` before sync; `openspec validate <capability> --type spec` after.
- **Advisor at TWO checkpoints (mandatory regardless of prior same-session calls):** (a) before drafting `design.md` — validate the as-shipped reading before baking it in; (b) before `/opsx:archive` — verify the back-fill matches shipped reality. Mirrors the two-checkpoint rule for forward changes (see Coding discipline > Advisor).
- `/opsx:apply` is bypassed (impl already shipped) but Coding discipline still applies: TDD + verification cover the fix commit (Reactive Step 2), code review runs between artifact drafts, audit gate covers spec coverage.
- Templates: review the most recent Pattern A back-fills under `openspec/changes/archive/` for the structure (proposal framing, pre-checked tasks, as-shipped `design.md`).

**Pattern B — Forward proposal** (interim partial fix shipped; full contract still being designed). Standard flow: `propose → human review → /opsx:apply → finish impl → sync → archive`.

**Pattern C — Deferred back-fill** (emergency hotfix / release-branch fix; full OpenSpec round-trip not feasible right now).
- Allowed ONLY if a tracking ticket (`<TICKET_PREFIX>-*`) is filed AND a deadline is set (default: before the next merge to `main`).
- Cap: at most ONE open deferred back-fill per branch. A second one blocks merge until the first is back-filled.
- Owner = author of the fix.

### Pre-handoff backstop (extends `finishing-a-development-branch`)

PR opening is the user's call by default; Claude only runs `gh pr create` when explicitly asked — and when asked, it runs *inside* `finishing-a-development-branch` (which performs this backstop first), never as a bare command. The backstop covers the WHOLE branch, not just this session's commits: before any merge or PR, run `git log <base>..HEAD --no-merges` and audit EVERY commit in that range against the trigger checklist (the branch may carry sibling sub-task commits you didn't author this session — they ride into the PR too), cross-check against `openspec/changes/` (active) and `openspec/changes/archive/` (recent on this branch). Any uncovered Outcome 3 commit blocks the handoff.

## Brainstorming — the design-resolution skill

`superpowers:brainstorming` resolves any unresolved design question — architectural, conceptual, scope, error-vocabulary, AND visual. It converges: probing questions one at a time, approaches with tradeoffs, a recommendation. Used at up to two moments; decisions from either flow to OpenSpec artifacts (never `docs/plans/...` or chat-only).

- **Architectural resolution** — BEFORE `/opsx:propose` (Workflow step 2, brainstorm-first). Terminal / conceptual questions; no Visual Companion yet (no artifacts to refine).
- **Visual refinement** — AFTER `/opsx:propose` (Workflow step 4, visible UI). The Visual Companion (browser mockups / layouts / comparisons) populates `## Visual direction`.

- **MANDATORY visual-refinement trigger:** Visible UI (component, layout, color, motion, copy, accessibility-affecting markup) AND `/opsx:propose` ran first → MUST invoke `superpowers:brainstorming` before `/opsx:apply`. Visual Companion engages automatically per the skill's protocol and populates `## Visual direction` in `design.md`.
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
- During `/opsx:apply`, deviation from `design.md` decisions → back to `superpowers:brainstorming`, not forward.

### Visual-specific

- Frontend code: use `frontend-design`. Avoid defaults: no Inter/Roboto/Arial display type, no purple-gradient-on-white, no generic grid-of-cards.
- Accessibility non-negotiable: semantic HTML, keyboard nav, ARIA only when semantics aren't enough, WCAG AA contrast minimum. Flag deviations in `design.md` before implementation.

## Coding discipline

- **TDD** (`test-driven-development`). Failing test → watch it fail → minimum code to pass. Production code without a prior failing test must be deleted and rewritten. Throwaway API-exploration code permitted (≤50 lines, never committed, deleted before TDD pass).
- **Worktree** (`using-git-worktrees`). Every `/opsx:apply`. ASK where: (a) **in-place** — current checkout, blocks main; (b) **sibling** at `../<project>-<change-id>/` or `../.worktrees/<change-id>/` — parallel-friendly. Default sibling.
- **Subagent per task** (`subagent-driven-development`), two-stage review. Use `executing-plans` only when I explicitly ask for human checkpoints. **Subagents do NOT auto-load `CLAUDE.md` or project memory — they start from a fresh system prompt with only what you put in their dispatch prompt.** Every subagent dispatch (including `Task`/`Agent`/`general-purpose` invocations, `requesting-code-review` reviewers, `dispatching-parallel-agents` workers) MUST include this preamble verbatim or equivalent: `Read CLAUDE.md at the repository root before starting any work. Follow all "Hard rules" (commit format via /git-spec, exclusion list, OpenSpec lifecycle, never modify openspec/specs directly, never delete change directories — always archive via /opsx:archive, never use direct git/shell ops on openspec/changes/). Apply "Reactive workflow" §3 audit gate to any changes you produce. Use the right typed commit prefix (done/fix/refactor/cleanup/in-progress/pending) per the branch's commit convention.` Without that block, the subagent's output will silently violate conventions because the main session's auto-loaded rules don't propagate to dispatched agents.
- **Background subagents** — `run_in_background: true` for anything long-running (test suites, builds, Playwright, Docker, dev servers). On the runaway system-reminder bug (claude-code #11716 or successor): restart session, run foreground with explicit timeout (e.g. 300000) to override the 120s auto-background cutoff.
- **Advisor** at TWO checkpoints per change:
  1. Before locking architectural approach (post-exploration, pre-artifacts).
  2. Before declaring done — make deliverable durable BEFORE this call.

  Skip for: trivial mechanical edits (rename, typo, comment), one-line semantic-preserving fixes, or work where you already called advisor in the same session for a directly related task. **Pattern A exception:** BOTH advisor checkpoints (before drafting `design.md`, and before `/opsx:archive`) are always mandatory, regardless of prior same-session calls — back-fills drift from shipped reality more easily than forward proposals because nothing forces re-reading the actual diff.
- **Code review** (`requesting-code-review`) between tasks. Critical issues block progress. **Critical** = security vulnerability, contract break (signature / envelope shape change not in `design.md`), test coverage regression, accessibility regression below WCAG AA, deviation from `design.md` decisions. Style nits / refactor suggestions are non-blocking. Defensible deviations (implementation surfaced a flaw in the original decision): update `design.md` `## Decisions` BEFORE continuing — never silently ship.
- **Debugging** (`systematic-debugging`) for any failing test or unexpected behavior. No guess-and-check.
- **Verification** (`verification-before-completion`) before claiming done. Full test suite + typecheck + lint. For reactive work, the audit gate (see `## Reactive workflow`) runs in addition — verification covers code correctness, the audit gate covers spec coverage.
- **Finishing** (`finishing-a-development-branch`) — the MANDATORY entry point for EVERY branch handoff. Run it when all tasks complete, and ALWAYS before any merge-to-base or PR: the handoff goes *through* the skill (it re-verifies tests, runs the pre-handoff backstop over `git log <base>..HEAD`, then performs the push/PR itself). Never run a bare `gh pr create` or `git merge`-to-base outside it. Completing the OpenSpec lifecycle (`/opsx:archive`) is NOT the finish line — branch handoff is a separate, mandatory step. *"PR opening is the user's call"* governs **whether/when** to hand off, never **whether** to run this skill.

## Hard rules

- All git commits must follow the format defined in the `/git-spec` skill. Read the skill before running any git commit command.
- Never commit directly to `main`.
- Never run `gh pr create` or merge a branch into its base without first completing `finishing-a-development-branch` (test re-verification + pre-handoff backstop over `git log <base>..HEAD`) in the same session. *"PR opening is the user's call"* decides **whether/when** to hand off — never **whether** to run the skill. Completing `/opsx:archive` is not a substitute; it is not the branch finish line.
- Never modify `openspec/specs/` directly — only via OpenSpec lifecycle (forward change OR reactive back-fill).
- Never use direct git or shell operations (`git mv`, `git rm`, `git checkout`, `git restore`, `git reset --hard`, `mv`, `rm`, `cp`, `mkdir`, `rmdir`) on anything under `openspec/changes/`. All directory moves go through the OpenSpec lifecycle skills (`/opsx:propose`, `/opsx:apply`, `/opsx:sync`, `/opsx:archive`). Restoring a deleted change directory is itself a protocol question — pause and ask, don't reach for git or shell.
- Every completed change archives via `/opsx:archive`. "Delete the directory" is never an alternative, regardless of what a stub's `tasks.md §5.X` (or any other artifact) may say. If a stub's tasks.md specifies `DEFAULT: delete`, treat it as an authoring-time error — archive anyway and file a follow-up to fix the propose-time template that generated the bad default.
- Never add a dependency without justifying it in `design.md`.
- Never compact mid-task or while unsaved decisions live only in chat.
- Never skip advisor checkpoints — bypass only per the narrow exceptions in "Coding discipline".
- Never let `superpowers:brainstorming` output land in `docs/plans/` or chat-only — every decision flows to OpenSpec artifacts before `/opsx:apply`.
- Never skip the reactive audit gate, even for fixes that "feel trivial." The 30-second checklist is cheaper than a missed contract change.
- Never ship an Outcome 2 fix without citing the restored requirement in the commit body (e.g. `Restores: openspec/specs/<cap>/spec.md → Requirement: <name>`). Without the cite, the audit isn't auditable post-hoc.
- Never amend an archived change. A new back-fill is always a *new* change directory under `openspec/changes/`, even if the impacted requirement was originally added by an archived change.
- Never bundle the impl fix commit with back-fill commits — keep the fix as one commit and the OpenSpec proposal/sync/archive as its own commit chain.
