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

## Coding discipline (enforced during /opsx:apply and all direct coding)

- YOU MUST use Superpowers' `test-driven-development` skill. Write a failing test first, watch it fail, then write the minimum code to make it pass. Code written before a failing test exists must be deleted and rewritten.
- YOU MUST use `using-git-worktrees` for every change that goes through `/opsx:apply`. No implementation on the main branch.
- YOU MUST work through `tasks.md` using `subagent-driven-development` (one subagent per task with two-stage review). Use `executing-plans` instead only if I explicitly ask for human checkpoints between tasks.
- YOU MUST use `requesting-code-review` between tasks. Critical issues block progress to the next task.
- YOU MUST use `systematic-debugging` for any failing test or unexpected behavior. No guess-and-check fixes.
- YOU MUST use `verification-before-completion` before claiming a task or change is done. Run the full test suite, typecheck, and lint.
- When all tasks are complete, use `finishing-a-development-branch` to handle merge/PR/cleanup.

## Hard rules
- Never commit directly to `main`.
- Never modify `openspec/specs/` directly — changes happen through the OpenSpec change lifecycle.
- Never add a dependency without justifying it in `design.md`.