# Project rules for Claude Code (improved)

## Context
- See `openspec/project.md` for stack, architecture rules, and conventions.
- Specs are in `openspec/specs/`. Active changes are in `openspec/changes/`.

## Workflow: OpenSpec drives planning, Superpowers drives coding

### For any non-trivial feature or change

1. Decide the entry point based on how resolved the request is:
   - **Stub promotion** (a `proposal.md` already exists with `## Open questions`) OR **request has unresolved architectural ambiguity** → run `brainstorming` BEFORE `/opsx:propose` so the open questions are resolved first; the propose step then generates artifacts that are already coherent.
   - **Greenfield with clear requirements + only visual decisions to make** → run `/opsx:propose` first to land the OpenSpec spine; then run `brainstorming` as a refinement step that updates the existing `design.md`.
2. `/opsx:propose <description>` generates `proposal.md`, `specs/<cap>/spec.md` (delta), `design.md`, and `tasks.md` in that dependency order. Each artifact uses `openspec instructions <id>` to fetch its template + dependency context.
3. I (the human) review the proposal. Wait for explicit approval before `/opsx:apply`.
4. During `/opsx:apply`, the rules in "Coding discipline" below are MANDATORY.
5. Before `/opsx:archive`: verify every task in `tasks.md` is checked off, the full test suite (not just new tests) passes, the feature has been exercised against a running system, and `openspec validate <change>` is green. Archive in the worktree branch *before* merging. Never merge an unarchived change.

## Brainstorming (architectural OR visual ambiguity)

Brainstorming is for ANY non-trivial design question that is unresolved — not just visual ones. Examples that warrant brainstorming: error vocabulary choices, layering decisions, refactor scope, data flow trade-offs, component composition, state-management ownership, AND visual direction.

- Invoke the `superpowers:brainstorming` skill explicitly when the request has unresolved design questions; do not assume `/opsx:propose` will surface them.
- **MANDATORY visual-refinement trigger:** If a change involves visible UI (any new component, layout, color, motion, copy, or accessibility-affecting markup) AND `/opsx:propose` was run first (the propose-first path), Claude MUST invoke `superpowers:brainstorming` as a refinement step BEFORE `/opsx:apply`. This rule fires regardless of whether the user asks for it. The Visual Companion is offered inside that brainstorming session.
- During brainstorming, decide per-question whether to use the terminal (conceptual / tradeoff / scope questions) or the Visual Companion browser (mockups / layouts / side-by-side visual comparisons). Visual Companion is offered ONCE as its own message per the skill protocol; it is not a standalone skill.
- Output of brainstorming always lands in OpenSpec artifacts — never in `docs/plans/...` or chat-only notes:
  - architectural decisions → `design.md` `## Decisions` section
  - visual decisions → `design.md` `## Visual direction` section
  - new / changed requirements → `specs/<cap>/spec.md` (delta)
  - capability list changes → `proposal.md` `## Capabilities`
  - what gets built changes → `tasks.md`
- Do NOT chain into `superpowers:writing-plans` at the end of brainstorming for this workflow — OpenSpec's `tasks.md` is the deliverable.
- Do NOT proceed to `/opsx:apply` until every artifact the brainstorming touched is updated AND `openspec validate <change>` is green.
- During `/opsx:apply`, any deviation from the approved decisions in `design.md` requires going back to brainstorming, not forward.

### Visual-specific rules (when the change involves visible UI)

- For frontend code generation, rely on `frontend-design`. If it doesn't auto-trigger, invoke it explicitly. Avoid defaults: no Inter/Roboto/Arial for display type, no purple-gradient-on-white, no generic grid-of-cards layouts unless explicit.
- Accessibility is non-negotiable: semantic HTML, keyboard navigation, ARIA only when semantics aren't enough, color contrast at WCAG AA minimum. Flag any deviation in `design.md` before implementation.

## Coding discipline (enforced during /opsx:apply and all direct coding)

- YOU MUST use Superpowers' `test-driven-development` skill. Write a failing test first, watch it fail, then write the minimum code to make it pass. Code written before a failing test exists must be deleted and rewritten.
- YOU MUST use `using-git-worktrees` for every change that goes through `/opsx:apply`. No implementation on the main branch. Before creating the worktree, ASK me where to put it: (a) **in-place** — create the branch in the current checkout directory (simplest, but blocks the main checkout from other work), or (b) **sibling worktree** — in a directory next to the repo like `../<project>-<change-id>/` or a shared `../.worktrees/<change-id>/` (parallel-friendly, leaves the main checkout free). Default to the sibling worktree only if I don't answer.
- YOU MUST work through `tasks.md` using `subagent-driven-development` (one subagent per task with two-stage review). Use `executing-plans` instead only if I explicitly ask for human checkpoints between tasks.
- YOU MUST run Subagent tasks always with `run_in_background: true`. This applies to anything long-running — test suites, builds, Playwright, Docker, dev servers you'll query later. If you hit the runaway system-reminder bug (claude-code #11716 or its successor), restart the session and run the command in the foreground with an explicit timeout (e.g. 300000) to override the 120s auto-background cutoff.
- YOU MUST call the `advisor` tool at two checkpoints per change: (1) ONCE before locking in an architectural approach — after exploration, before writing artifacts; (2) ONCE before declaring a task or change done. Make the deliverable durable BEFORE the second call so a session-end mid-call doesn't lose work. Skip advisor only for trivially reversible one-line edits.
- YOU MUST use `requesting-code-review` between tasks. Critical issues block progress to the next task.
- YOU MUST use `systematic-debugging` for any failing test or unexpected behavior. No guess-and-check fixes.
- YOU MUST use `verification-before-completion` before claiming a task or change is done. Run the full test suite, typecheck, and lint.
- When all tasks are complete, use `finishing-a-development-branch` to handle merge/PR/cleanup.

## Context management

Compaction triggers (whichever fires first):

- After every 3–5 completed tasks (checkbox flipped, code reviewed, verification passed)
- When you notice Claude re-reading the same file 3+ times in one session
- When a single task's tool output exceeds ~50 lines AND that output is now in git / `tasks.md`
- Never wait for the auto-compact trigger — it fires at arbitrary points and may cut mid-debug

Choosing between `/compact` and `/clear`:

- **`/compact` example**: Task 5.4 modified `bootstrap.ts` and ran a unit test that produced 80 lines of output. Task 5.5 runs the full test suite. The `bootstrap.ts` state is in git, the test outcome is the checked box — compact preserves the summary, drops the noise.
- **`/clear` example**: Task 9 finished the renderer component. Task 10 starts dashboard banner work in a different feature folder with no shared identifiers — clear is cleaner than compact.
- **Neither**: Task 5.5 is mid-debug with a failing test you haven't root-caused yet. Do not compact or clear; resolve the failure first.

Pre-compaction durability check:

- The task's commit is in git
- `tasks.md` reflects the new state
- Any decision worth keeping is in `design.md` or `proposal.md`
- If something is only in chat, write it down first

After any compaction (manual or auto), Claude restates the current task from `tasks.md` and the active `design.md` constraints in one short message before resuming. This catches summary drift early.

## Hard rules

- Never commit directly to `main`.
- Never modify `openspec/specs/` directly — changes happen through the OpenSpec change lifecycle.
- Never add a dependency without justifying it in `design.md`.
- Never compact while a task is mid-flight or while unsaved decisions live only in chat.
- Never skip the advisor checkpoints in "Coding discipline" — bypass only for trivially reversible one-line edits.
- Never let brainstorming output land in `docs/plans/` or chat-only — every decision flows back into the OpenSpec artifacts before `/opsx:apply` starts.
