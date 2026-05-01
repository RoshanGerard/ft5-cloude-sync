# Project rules for Claude Code

## Context

- `openspec/project.md` — stack, architecture, conventions.
- `openspec/specs/` — canonical specs. `openspec/changes/` — active changes; `openspec/changes/archive/` — completed.
- `advisor` tool = stronger reviewer with full transcript access. Use at the two checkpoints in Coding discipline > Advisor.

## Workflow

Forward changes (intent → propose → ship). For bug fixes / improvements / patches, see `## Reactive workflow` below.

1. **Entry point:**
   - **Brainstorm-first** — Stub or unresolved architectural ambiguity (a change in `openspec/changes/` whose `proposal.md` is incomplete — open questions, TBDs, missing `## What Changes` body, no spec delta yet, no `tasks.md`, OR open architectural questions in the request) → brainstorming first.
   - **Propose-first-with-UI** — Clear requirements; only visual decisions remain → `/opsx:propose` first, then brainstorming as refinement.
   - **Propose-direct** — Everything else (clear requirements, no UI, no architectural ambiguity) → `/opsx:propose` directly.

2. **Brainstorming (conditional).** Run `superpowers:brainstorming` if step 1 picked brainstorm-first OR the change involves visible UI. Brainstorm-first: before step 3. Propose-first-with-UI: after step 3, before step 4. Visual Companion engages inside the session per the skill protocol. Output flows per the handoff list below.

3. **`/opsx:propose <description>`** — generates `proposal.md`, `design.md`, `specs/<cap>/spec.md` deltas, `tasks.md`. Pass `<change-id>` (kebab-case) instead when the name is already settled — e.g. reactive back-fills.

4. **Human review.** Wait for explicit approval before `/opsx:apply`.

5. **Pre-apply staleness check.** Spot-check `design.md` file paths, function names, architectural assumptions still match the codebase. If shifted, invoke `brainstorming` for parts needing re-resolution OR edit `design.md` directly for purely-stale references.

6. **`/opsx:apply`.** "Coding discipline" rules below are MANDATORY.

7. **Pre-archive.** Every `tasks.md` checkbox checked, full test suite passes, feature exercised against a running system, `openspec validate <change>` green. If validate fails: fix in the worktree branch and re-run — never skip validation, never edit `openspec/specs/` directly. Archive in the worktree branch *before* merging.

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

PR opening is the user's call by default; Claude only runs `gh pr create` when explicitly asked. Either way, before declaring the branch PR-ready: run `git log <base>..HEAD --no-merges`, audit each commit against the trigger checklist, cross-check against `openspec/changes/` (active) and `openspec/changes/archive/` (recent on this branch). Any uncovered Outcome 3 commit blocks the handoff.

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

  Skip for: trivial mechanical edits (rename, typo, comment), one-line semantic-preserving fixes, or work where you already called advisor in the same session for a directly related task. **Pattern A exception:** BOTH advisor checkpoints (before drafting `design.md`, and before `/opsx:archive`) are always mandatory, regardless of prior same-session calls — back-fills drift from shipped reality more easily than forward proposals because nothing forces re-reading the actual diff.
- **Code review** (`requesting-code-review`) between tasks. Critical issues block progress. **Critical** = security vulnerability, contract break (signature / envelope shape change not in `design.md`), test coverage regression, accessibility regression below WCAG AA, deviation from `design.md` decisions. Style nits / refactor suggestions are non-blocking. Defensible deviations (implementation surfaced a flaw in the original decision): update `design.md` `## Decisions` BEFORE continuing — never silently ship.
- **Debugging** (`systematic-debugging`) for any failing test or unexpected behavior. No guess-and-check.
- **Verification** (`verification-before-completion`) before claiming done. Full test suite + typecheck + lint. For reactive work, the audit gate (see `## Reactive workflow`) runs in addition — verification covers code correctness, the audit gate covers spec coverage.
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
- Never modify `openspec/specs/` directly — only via OpenSpec lifecycle (forward change OR reactive back-fill).
- Never add a dependency without justifying it in `design.md`.
- Never compact mid-task or while unsaved decisions live only in chat.
- Never skip advisor checkpoints — bypass only per the narrow exceptions in "Coding discipline".
- Never let brainstorming output land in `docs/plans/` or chat-only — every decision flows to OpenSpec artifacts before `/opsx:apply`.
- Never skip the reactive audit gate, even for fixes that "feel trivial." The 30-second checklist is cheaper than a missed contract change.
- Never ship an Outcome 2 fix without citing the restored requirement in the commit body (e.g. `Restores: openspec/specs/<cap>/spec.md → Requirement: <name>`). Without the cite, the audit isn't auditable post-hoc.
- Never amend an archived change. A new back-fill is always a *new* change directory under `openspec/changes/`, even if the impacted requirement was originally added by an archived change.
- Never bundle the impl fix commit with back-fill commits — keep the fix as one commit and the OpenSpec proposal/sync/archive as its own commit chain.
