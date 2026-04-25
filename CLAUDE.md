# Project rules for Claude Code

## Context
- See `openspec/project.md` for stack, architecture rules, and conventions.
- Specs are in `openspec/specs/`. Active changes are in `openspec/changes/`.

## Workflow: OpenSpec drives planning, Superpowers drives coding

### For any non-trivial feature or change
1. Use `/opsx:propose <description>` to generate proposal.md + specs/ + design.md + tasks.md.
2. I (the human) will review the proposal. Wait for explicit approval before `/opsx:apply`.
3. During `/opsx:apply`, the rules in the "Coding discipline" section below are MANDATORY.
4. Before `/opsx:archive`: verify every task in `tasks.md` is checked off, the full test suite (not just new tests) passes, and the feature has been exercised against a running system. Archive in the worktree branch *before* merging. Never merge an unarchived change.

## UI/UX work (when the change involves visible interface)

- After `/opsx:propose` completes, if the change involves visible UI, invoke the `brainstorming` skill as a refinement step BEFORE `/opsx:apply`. Example: "Use the brainstorming skill to refine the visual direction in openspec/changes/<id>/design.md."
- Do NOT try to invoke "Visual Companion" directly — it is not a standalone skill. It is only offered from inside a `brainstorming` session when a question is visual.
- During brainstorming, offer the Visual Companion per the skill's protocol (its own message, not combined with other questions). Decide per-question whether to use the browser or the terminal.
- Before ending brainstorming, update the EXISTING `openspec/changes/<id>/design.md` with a `## Visual direction` section: aesthetic tone, type, color palette, spacing, motion, accessibility notes. Do NOT let brainstorming write to its default `docs/plans/...` location — the OpenSpec design.md is the single source of truth.
- Do NOT chain into `writing-plans` at the end of brainstorming for this workflow — OpenSpec's `tasks.md` already exists. If the visual direction changed what needs building, update `tasks.md` directly.
- For frontend code generation, rely on `frontend-design`. If it doesn't auto-trigger, invoke it explicitly. Avoid defaults: no Inter/Roboto/Arial for display type, no purple-gradient-on-white, no generic grid-of-cards layouts unless explicit.
- During `/opsx:apply`, any deviation from the approved visual direction in `design.md` requires going back to brainstorming, not forward.
- Accessibility is non-negotiable: semantic HTML, keyboard navigation, ARIA only when semantics aren't enough, color contrast at WCAG AA minimum. Flag any deviation in `design.md` before implementation.

## Coding discipline (enforced during /opsx:apply and all direct coding)

- YOU MUST use Superpowers' `test-driven-development` skill. Write a failing test first, watch it fail, then write the minimum code to make it pass. Code written before a failing test exists must be deleted and rewritten.
- YOU MUST use `using-git-worktrees` for every change that goes through `/opsx:apply`. No implementation on the main branch. Before creating the worktree, ASK me where to put it: (a) **in-place** — create the branch in the current checkout directory (simplest, but blocks the main checkout from other work), or (b) **sibling worktree** — in a directory next to the repo like `../<project>-<change-id>/` or a shared `../.worktrees/<change-id>/` (parallel-friendly, leaves the main checkout free). Default to the sibling worktree only if I don't answer.
- YOU MUST work through `tasks.md` using `subagent-driven-development` (one subagent per task with two-stage review). Use `executing-plans` instead only if I explicitly ask for human checkpoints between tasks.
- YOU MUST run Subagent tasks always with run_in_background: true. This applies to anything long-running — test suites, builds, Playwright, Docker, dev servers you'll query later. If you hit the runaway system-reminder bug (claude-code #11716), restart the session and run the command in the foreground with an explicit timeout (e.g. 300000) to override the 120s auto-background cutoff.
- YOU MUST use `requesting-code-review` between tasks. Critical issues block progress to the next task.
- YOU MUST use `systematic-debugging` for any failing test or unexpected behavior. No guess-and-check fixes.
- YOU MUST use `verification-before-completion` before claiming a task or change is done. Run the full test suite, typecheck, and lint.
- When all tasks are complete, use `finishing-a-development-branch` to handle merge/PR/cleanup.

## Context management

- After completing each task in `tasks.md` (checkbox flipped, code reviewed, verification passed), run `/compact` if the artifacts produced for that task — tool output, file dumps, debugging traces, intermediate reasoning — are not needed by any pending task in the same `tasks.md`. The durable record lives in the commit, the updated `tasks.md`, and `design.md`. The chat history of how you got there is not load-bearing once those files are written.
- Before compacting, verify the durable record exists: the task's commit is in git, `tasks.md` reflects the new state, and any decision worth keeping is captured in `design.md` or `proposal.md`. If something is only in chat, write it down first.
- Use `/clear` instead of `/compact` when the next task in `tasks.md` is independent of everything before it (no shared files, no shared decisions, no shared debugging context). For tasks that build on each other, `/compact` preserves the summary; for unrelated tasks, `/clear` is cleaner.
- Compact opportunistically when context utilization passes ~70% **and** the oldest material in context belongs to a completed task. Do not let auto-compact be the trigger — it fires at arbitrary points and may cut mid-debug.
- Do NOT compact mid-task, mid-debug, or while holding state (a failing test, an in-progress refactor, an unresolved review comment) that has not been written to a file.
- After any compaction (manual or auto), restate the current task from `tasks.md` and the active `design.md` constraints in one short message before resuming. This catches summary drift early.

## Hard rules
- Never commit directly to `main`.
- Never modify `openspec/specs/` directly — changes happen through the OpenSpec change lifecycle.
- Never add a dependency without justifying it in `design.md`.
- Never compact while a task is mid-flight or while unsaved decisions live only in chat.
